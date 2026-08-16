import { TaskSemaphore } from "../../utils/TaskSemaphore"
import { type Task } from "./Task"

/**
 * Semaphore-based concurrency gate for task execution.
 *
 * Ships at maxConcurrency=1, which is structurally identical to the current
 * serial behavior. Raising maxConcurrency later enables Story 3.2b fan-out
 * without touching the gate logic here.
 */
export class TaskScheduler {
	private readonly sem: TaskSemaphore
	readonly maxConcurrency: number

	constructor(maxConcurrency = 1) {
		if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
			throw new Error(`maxConcurrency must be a positive integer, got ${maxConcurrency}`)
		}
		this.maxConcurrency = maxConcurrency
		this.sem = new TaskSemaphore(maxConcurrency)
	}

	get waiting(): number {
		return this.sem.waiting
	}

	/** Number of permits not currently held by a running task. */
	get available(): number {
		return this.sem.available
	}

	/**
	 * Reserve a permit only if one is immediately free, without queueing.
	 * Returns a release function on success, or `undefined` if none was free.
	 *
	 * Use this (not `available > 0` followed later by `schedule()`) when a
	 * caller needs to make an irreversible decision — e.g. keeping a parent
	 * task alive for fan-out — based on whether a child can actually run
	 * concurrently. Checking `available` and then `await`-ing other work
	 * before calling `schedule()` leaves a window where another caller can
	 * consume the last permit; reserving it immediately closes that window.
	 */
	async tryReserve(): Promise<(() => void) | undefined> {
		return this.sem.tryAcquire()
	}

	/**
	 * Acquire a permit for `task`, call `run()`, and release on completion.
	 *
	 * The returned promise resolves/rejects with the same value as `run()`.
	 * Release is guaranteed via try/finally even if `run()` throws.
	 *
	 * If the task was aborted or abandoned while waiting for a permit (e.g. the
	 * user cancelled it before it started), the permit is released immediately
	 * without calling `run()`.
	 */
	async schedule(task: Task, run: () => Promise<void>): Promise<void> {
		return this.runWithRelease(await this.sem.acquire(), task, run)
	}

	/**
	 * Run `task` using a permit already obtained via `tryReserve()`, instead of
	 * acquiring a new one. Same abort/abandon and release-on-completion
	 * semantics as `schedule()`.
	 */
	async runWithReservation(release: () => void, task: Task, run: () => Promise<void>): Promise<void> {
		return this.runWithRelease(release, task, run)
	}

	private async runWithRelease(release: () => void, task: Task, run: () => Promise<void>): Promise<void> {
		if (task.abort || task.abandoned) {
			release()
			return
		}
		try {
			await run()
		} finally {
			release()
		}
	}

	/**
	 * Cancel all queued (waiting) tasks. Tasks that already acquired a permit
	 * are not affected — they continue to run to completion.
	 */
	cancelQueued(): void {
		this.sem.cancel()
	}
}
