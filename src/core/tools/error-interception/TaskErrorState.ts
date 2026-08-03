/**
 * Task-scoped error state.
 *
 * One instance per Task, keyed via a module-level WeakMap so the state is
 * released when the owning Task is garbage-collected. Occurrence counters,
 * sanitized failure fingerprints, and per-category circuit status persist
 * across multiple tool blocks within the same Task. This corrects the
 * previous behavior where a new interceptor was constructed per tool block
 * and all counters reset between turns.
 *
 * State machine per category:
 *   occurrence 1 -> guided correction (closed)
 *   occurrence 2 -> strengthened guidance (closed)
 *   occurrence 3 -> circuit open (MODEL_STUCK_LOOP outcome)
 *
 * Reset policy: a successful tool result, a user-authored message, or an
 * explicit fingerprint change resets only the affected category.
 */

/** Default threshold at which the per-category circuit opens. */
export const STUCK_LOOP_THRESHOLD = 3

/**
 * Internal per-category record. The fingerprint is sanitized: it contains
 * only structural identifiers (category, variant, tool name, parameter,
 * structural reason) and never raw argument values or absolute paths.
 */
interface CategoryState {
	occurrence: number
	fingerprint: string | undefined
	isOpen: boolean
}

export class TaskErrorState {
	private readonly perCategory = new Map<string, CategoryState>()

	/**
	 * Pending XML_NATIVE_DUAL_PROTOCOL guidance queued by the text-block
	 * handler. Consumed (read + cleared) by every path that emits a
	 * tool_result for the turn so it cannot leak into later turns.
	 */
	private pendingGuide: string | undefined

	private getOrCreate(category: string): CategoryState {
		let state = this.perCategory.get(category)
		if (!state) {
			state = { occurrence: 0, fingerprint: undefined, isOpen: false }
			this.perCategory.set(category, state)
		}
		return state
	}

	/**
	 * Returns the current occurrence count for a category without mutating
	 * state. Returns 0 when the category has never been recorded.
	 */
	public getOccurrence(category: string): number {
		return this.perCategory.get(category)?.occurrence ?? 0
	}

	/**
	 * Increments and returns the occurrence count for a category. Once the
	 * count reaches STUCK_LOOP_THRESHOLD, the circuit for that category
	 * opens and remains open until reset().
	 */
	public incrementOccurrence(category: string): number {
		const state = this.getOrCreate(category)
		state.occurrence += 1
		if (state.occurrence >= STUCK_LOOP_THRESHOLD) {
			state.isOpen = true
		}
		return state.occurrence
	}

	/**
	 * Returns true when the circuit is open for the category (occurrence has
	 * reached STUCK_LOOP_THRESHOLD and reset() has not been called since).
	 */
	public isOpen(category: string): boolean {
		return this.perCategory.get(category)?.isOpen ?? false
	}

	/**
	 * Returns the sanitized fingerprint last associated with the category,
	 * or undefined when none has been recorded.
	 */
	public getFingerprint(category: string): string | undefined {
		return this.perCategory.get(category)?.fingerprint
	}

	/**
	 * Records the sanitized fingerprint for the category without touching
	 * the occurrence counter or circuit flag. Fingerprints must be built
	 * from structural identifiers only; never pass raw values.
	 */
	public setFingerprint(category: string, fingerprint: string): void {
		const state = this.getOrCreate(category)
		state.fingerprint = fingerprint
	}

	/**
	 * Resets a single category, or all categories when the argument is
	 * omitted. Closes the circuit and clears the fingerprint and counter.
	 */
	public reset(category?: string): void {
		if (category !== undefined) {
			this.perCategory.delete(category)
			return
		}
		this.perCategory.clear()
	}

	/** Returns the pending native protocol guide without clearing it. */
	public getPendingNativeProtocolGuide(): string | undefined {
		return this.pendingGuide
	}

	/** Queues a native protocol guide to be merged into the next tool_result. */
	public setPendingNativeProtocolGuide(guide: string): void {
		this.pendingGuide = guide
	}

	/** Clears any pending native protocol guide. */
	public clearPendingNativeProtocolGuide(): void {
		this.pendingGuide = undefined
	}

	/**
	 * Atomically reads and clears the pending native protocol guide.
	 * Returns undefined when no guide is queued.
	 */
	public consumePendingNativeProtocolGuide(): string | undefined {
		const guide = this.pendingGuide
		this.pendingGuide = undefined
		return guide
	}
}

/**
 * Module-level WeakMap keyed by the Task object. Using WeakMap keeps state
 * lifetime bound to the Task: when the Task is garbage-collected, its error
 * state is dropped with no explicit teardown.
 */
const taskStates = new WeakMap<object, TaskErrorState>()

/**
 * Returns true when the argument can be used as a WeakMap key. Primitives
 * (including string taskIds, an easy mistake) and null/undefined cannot.
 */
function isWeakMapKey(task: object): boolean {
	return !!task && (typeof task === "object" || typeof task === "function")
}

/**
 * Returns the persistent TaskErrorState for the given Task, creating it on
 * first access. The Task argument is typed as object to keep this module
 * decoupled from the concrete Task class.
 *
 * Non-object keys (null/undefined/primitives) fail open with an ephemeral
 * instance instead of throwing TypeError from WeakMap.set(); ephemeral
 * instances are never stored, so counters do not persist across calls for
 * invalid keys.
 */
export function getTaskErrorState(task: object): TaskErrorState {
	if (!isWeakMapKey(task)) {
		return new TaskErrorState()
	}
	let state = taskStates.get(task)
	if (!state) {
		state = new TaskErrorState()
		taskStates.set(task, state)
	}
	return state
}

/**
 * Returns true when a TaskErrorState already exists for the given Task,
 * without materializing a new instance. Use this to guard reset paths that
 * must not create empty state as a side effect. Returns false for keys that
 * cannot be stored in the WeakMap.
 */
export function hasTaskErrorState(task: object): boolean {
	if (!isWeakMapKey(task)) {
		return false
	}
	return taskStates.has(task)
}
