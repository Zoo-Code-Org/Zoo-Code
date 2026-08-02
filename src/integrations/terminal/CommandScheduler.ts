/**
 * CommandScheduler — extension-scoped command serialization service.
 *
 * Provides:
 * - One global FIFO command lane (concurrency 1)
 * - One active command per task (concurrency 1 per task, implied by global)
 * - Duplicate executionId rejection
 * - Per-task cancellation of queued work
 * - Global terminal creation permit with 250ms cooldown
 *
 * See architect report Section 1.3 for the full specification.
 *
 * Lifecycle:
 * - {@link CommandScheduler.initialize} at extension activation beside
 *   TerminalRegistry.initialize().
 * - {@link CommandScheduler.cleanup} at extension deactivation beside
 *   TerminalRegistry.cleanup().
 * - {@link CommandScheduler.cancelTask} in Task.dispose() before releasing
 *   that task's terminals.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request for scheduling a command execution.
 *
 * Does NOT contain command text, CWD, output, or any sensitive data.
 */
export interface ScheduledCommandRequest {
	/** Unique identifier for this execution attempt. */
	readonly executionId: string
	/** The task that owns this command. */
	readonly taskId: string
	/** Timestamp when the request was created. */
	readonly requestedAt: number
	/**
	 * Optional abort signal. If aborted while queued, the request is
	 * cancelled and the enqueue promise rejects with CommandAbortedError.
	 * If aborted while active, the scheduler does not interrupt the command.
	 */
	readonly abortSignal?: AbortSignal
}

/**
 * Result returned by the function passed to
 * {@link CommandScheduler.withTerminalCreationPermit}.
 *
 * The caller must indicate whether a new VS Code terminal was created so
 * the scheduler can apply the 250ms cooldown.
 */
export interface TerminalCreationPermitResult<T> {
	/** The value returned by the permit operation. */
	readonly value: T
	/** Whether a new VS Code terminal was created (triggers 250ms cooldown). */
	readonly createdNewTerminal: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a duplicate executionId is enqueued. */
export class DuplicateExecutionIdError extends Error {
	readonly executionId: string
	constructor(executionId: string) {
		super(`CommandScheduler/enqueue/001: duplicate executionId "${executionId}"`)
		this.name = "DuplicateExecutionIdError"
		this.executionId = executionId
	}
}

/** Thrown when enqueue is called after dispose. */
export class SchedulerDisposedError extends Error {
	constructor() {
		super("CommandScheduler/enqueue/002: scheduler has been disposed")
		this.name = "SchedulerDisposedError"
	}
}

/** Thrown when an abort signal fires while a command is queued. */
export class CommandAbortedError extends Error {
	readonly executionId: string
	constructor(executionId: string) {
		super(`CommandScheduler/enqueue/003: command "${executionId}" was aborted while queued`)
		this.name = "CommandAbortedError"
		this.executionId = executionId
	}
}

/** Thrown when a queued command is cancelled via cancelTask. */
export class TaskCancelledError extends Error {
	readonly taskId: string
	constructor(taskId: string) {
		super(`CommandScheduler/cancelTask/001: queued command for task "${taskId}" was cancelled`)
		this.name = "TaskCancelledError"
		this.taskId = taskId
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

/** Internal queue entry holding the request and its promise callbacks. */
interface QueueEntry {
	readonly request: ScheduledCommandRequest
	readonly resolve: () => void
	readonly reject: (error: Error) => void
	/** Listener registered on the abort signal, or undefined if none. */
	abortListener?: () => void
}

/** Internal waiter for the terminal creation permit. */
interface CreationPermitWaiter {
	readonly resolve: () => void
	readonly reject: (error: Error) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Cooldown (ms) after a new VS Code terminal is created. */
export const CREATION_COOLDOWN_MS = 250

// ─────────────────────────────────────────────────────────────────────────────
// CommandScheduler
// ─────────────────────────────────────────────────────────────────────────────

export class CommandScheduler {
	private static instance: CommandScheduler | undefined

	/** Global FIFO command queue (waiting entries only). */
	private queue: QueueEntry[] = []

	/** Currently active command entry, or undefined when idle. */
	private activeEntry: QueueEntry | undefined

	/**
	 * All known executionIds (active + queued) for duplicate detection.
	 * An id is added on enqueue and removed on release/cancel/dispose.
	 */
	private knownExecutionIds = new Set<string>()

	/** Whether the terminal creation permit is currently held. */
	private creationPermitInUse = false

	/** Waiters for the terminal creation permit. */
	private creationPermitWaiters: CreationPermitWaiter[] = []

	/** Pending cooldown timer after new terminal creation, or undefined. */
	private creationCooldownTimer: ReturnType<typeof setTimeout> | undefined

	/** Whether the scheduler has been disposed. */
	private disposed = false

	// ─────────────────────────────────────────────────────────────────────────
	// Singleton lifecycle
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initializes the singleton instance. Called at extension activation
	 * beside TerminalRegistry.initialize().
	 *
	 * @throws {Error} if called more than once without cleanup.
	 */
	public static initialize(): void {
		if (CommandScheduler.instance) {
			throw new Error("CommandScheduler.initialize() should only be called once")
		}
		CommandScheduler.instance = new CommandScheduler()
	}

	/**
	 * Gets the singleton instance.
	 *
	 * @throws {Error} if not initialized.
	 */
	public static getInstance(): CommandScheduler {
		if (!CommandScheduler.instance) {
			throw new Error("CommandScheduler.getInstance() called before initialize()")
		}
		return CommandScheduler.instance
	}

	/**
	 * Disposes the singleton: rejects all queued waiters and clears timers.
	 * Called at extension deactivation beside TerminalRegistry.cleanup().
	 */
	public static cleanup(): void {
		if (CommandScheduler.instance) {
			CommandScheduler.instance.dispose()
			CommandScheduler.instance = undefined
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Command lane
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Enqueues a command request. Returns a promise that resolves when the
	 * command's turn arrives (i.e., the lease is granted).
	 *
	 * The caller MUST call {@link release} when the command execution
	 * (including same-terminal recovery and provider fallback) is complete.
	 *
	 * @throws {SchedulerDisposedError} if the scheduler has been disposed.
	 * @throws {DuplicateExecutionIdError} if the executionId is already known.
	 * @throws {TaskCancelledError} if the task is cancelled while queued.
	 * @throws {CommandAbortedError} if the abort signal fires while queued.
	 */
	public enqueue(request: ScheduledCommandRequest): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new SchedulerDisposedError())
		}

		if (this.knownExecutionIds.has(request.executionId)) {
			return Promise.reject(new DuplicateExecutionIdError(request.executionId))
		}

		return new Promise<void>((resolve, reject) => {
			const entry: QueueEntry = {
				request,
				resolve,
				reject,
			}

			// Handle already-aborted signal before adding to any internal state.
			if (request.abortSignal) {
				if (request.abortSignal.aborted) {
					reject(new CommandAbortedError(request.executionId))
					return
				}

				// Register abort listener for queued state.
				// Once the command becomes active, the listener is removed
				// so the abort signal does not interfere with the active command.
				const abortListener = () => {
					// Only cancel if still queued (not active).
					if (this.activeEntry?.request.executionId !== request.executionId) {
						this.removeFromQueue(request.executionId, new CommandAbortedError(request.executionId))
					}
				}
				entry.abortListener = abortListener
				request.abortSignal.addEventListener("abort", abortListener, { once: true })
			}

			this.knownExecutionIds.add(request.executionId)
			this.queue.push(entry)
			this.processQueue()
		})
	}

	/**
	 * Releases the lease for the given executionId. Must be called exactly
	 * once after the command execution (including recovery and fallback)
	 * is complete.
	 *
	 * If the executionId is unknown (already released or never enqueued),
	 * this is a no-op.
	 */
	public release(executionId: string): void {
		if (this.activeEntry?.request.executionId === executionId) {
			this.activeEntry = undefined
			this.knownExecutionIds.delete(executionId)
			this.processQueue()
		} else {
			// Unknown or already released — clean up just in case.
			this.knownExecutionIds.delete(executionId)
		}
	}

	/**
	 * Cancels all queued (not active) entries for the given task.
	 * Does not interrupt the currently active command.
	 *
	 * @returns The number of entries that were cancelled.
	 */
	public cancelTask(taskId: string): number {
		const toCancel = this.queue.filter((e) => e.request.taskId === taskId)
		if (toCancel.length === 0) {
			return 0
		}

		// Remove cancelled entries from the queue.
		this.queue = this.queue.filter((e) => e.request.taskId !== taskId)

		// Reject each cancelled entry.
		for (const entry of toCancel) {
			this.cleanupEntry(entry)
			entry.reject(new TaskCancelledError(taskId))
		}

		return toCancel.length
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Terminal creation permit
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Executes a function under the global terminal creation permit
	 * (concurrency 1). If the function creates a new VS Code terminal,
	 * a 250ms cooldown is applied before the next creation is permitted.
	 *
	 * This permit is independent of the command lane — it does not acquire
	 * a command lease and can be used safely inside an active command.
	 *
	 * @param fn A function that returns a {@link TerminalCreationPermitResult}
	 *           indicating whether a new terminal was created.
	 * @throws {SchedulerDisposedError} if the scheduler is disposed while
	 *         waiting for or holding the permit.
	 */
	public async withTerminalCreationPermit<T>(fn: () => Promise<TerminalCreationPermitResult<T>>): Promise<T> {
		await this.acquireCreationPermit()

		if (this.disposed) {
			this.releaseCreationPermit(false)
			throw new SchedulerDisposedError()
		}

		let createdNewTerminal = false
		try {
			const result = await fn()
			createdNewTerminal = result.createdNewTerminal
			return result.value
		} finally {
			this.releaseCreationPermit(createdNewTerminal)
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Dispose
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Disposes the scheduler: rejects all queued waiters and clears timers.
	 * Does not interrupt the currently active command — the caller is
	 * responsible for releasing it.
	 */
	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true

		// Reject all queued entries.
		const queued = this.queue
		this.queue = []
		for (const entry of queued) {
			this.cleanupEntry(entry)
			entry.reject(new SchedulerDisposedError())
		}

		// Reject all creation permit waiters.
		for (const waiter of this.creationPermitWaiters) {
			waiter.reject(new SchedulerDisposedError())
		}
		this.creationPermitWaiters = []

		// Clear cooldown timer.
		if (this.creationCooldownTimer !== undefined) {
			clearTimeout(this.creationCooldownTimer)
			this.creationCooldownTimer = undefined
		}

		// Clear active entry reference. The caller is still responsible for
		// completing their work; we just prevent new queue processing.
		this.activeEntry = undefined
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Internal: command queue processing
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Processes the queue: if nothing is active and the queue is non-empty,
	 * activates the next entry in FIFO order.
	 */
	private processQueue(): void {
		if (this.disposed) {
			return
		}
		if (this.activeEntry !== undefined) {
			return // Something is already active.
		}

		const next = this.queue.shift()
		if (!next) {
			return // Queue is empty.
		}

		this.activeEntry = next
		// Remove the abort listener before activating — once active,
		// the abort signal must not trigger queue removal.
		this.removeAbortListener(next)
		next.resolve()
	}

	/**
	 * Removes an entry from the queue by executionId and rejects it.
	 * Used by abort signal handling. No-op if the entry is not in the
	 * queue (may have been cancelled or already activated).
	 */
	private removeFromQueue(executionId: string, error: Error): void {
		const index = this.queue.findIndex((e) => e.request.executionId === executionId)
		if (index === -1) {
			return
		}

		const [entry] = this.queue.splice(index, 1)
		this.cleanupEntry(entry)
		entry.reject(error)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Internal: entry cleanup helpers
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Removes the abort listener from an entry (if present).
	 * Does NOT remove the executionId from the known set.
	 */
	private removeAbortListener(entry: QueueEntry): void {
		if (entry.abortListener && entry.request.abortSignal) {
			entry.request.abortSignal.removeEventListener("abort", entry.abortListener)
			entry.abortListener = undefined
		}
	}

	/**
	 * Full cleanup of an entry: removes abort listener and deletes the
	 * executionId from the known set.
	 */
	private cleanupEntry(entry: QueueEntry): void {
		this.removeAbortListener(entry)
		this.knownExecutionIds.delete(entry.request.executionId)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Internal: creation permit
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Acquires the creation permit. Returns immediately if free,
	 * otherwise waits for the current holder to release.
	 *
	 * @throws {SchedulerDisposedError} if the scheduler is disposed while
	 *         waiting.
	 */
	private acquireCreationPermit(): Promise<void> {
		if (!this.creationPermitInUse) {
			this.creationPermitInUse = true
			return Promise.resolve()
		}

		return new Promise<void>((resolve, reject) => {
			this.creationPermitWaiters.push({ resolve, reject })
		})
	}

	/**
	 * Releases the creation permit. If a new terminal was created,
	 * applies a 250ms cooldown before waking the next waiter.
	 * If no new terminal was created, the next waiter is woken immediately.
	 */
	private releaseCreationPermit(createdNewTerminal: boolean): void {
		if (this.disposed) {
			this.creationPermitInUse = false
			return
		}

		if (!createdNewTerminal) {
			// No cooldown needed — release immediately.
			this.creationPermitInUse = false
			this.wakeNextCreationWaiter()
			return
		}

		// Apply 250ms cooldown after new terminal creation.
		// During the cooldown, creationPermitInUse remains true so new
		// callers queue up as waiters. The cooldown is applied regardless
		// of whether waiters currently exist, because a new waiter may
		// arrive during the cooldown period.
		this.creationCooldownTimer = setTimeout(() => {
			this.creationCooldownTimer = undefined
			this.creationPermitInUse = false
			this.wakeNextCreationWaiter()
		}, CREATION_COOLDOWN_MS)
	}

	/**
	 * Wakes the next creation permit waiter if any, or releases the permit.
	 */
	private wakeNextCreationWaiter(): void {
		if (this.creationPermitWaiters.length > 0) {
			const next = this.creationPermitWaiters.shift()!
			this.creationPermitInUse = true
			next.resolve()
		} else {
			this.creationPermitInUse = false
		}
	}
}
