/**
 * Shared contract for the sub-subtasks feature (design §6): parallel,
 * read-only background child tasks spawned through the `parallel_subtasks`
 * tool.
 *
 * Background children run outside the lifecycle reducer: the singular
 * `awaitingChildId` invariant is preserved, so a parent can await one
 * delegated child while any number of background children run beside it.
 * Only two things cross into persistence: `childIds` registration on the
 * parent (via `addBackgroundChild`, design D10) and the
 * `backgroundParentTaskId` stamp on the child's HistoryItem (design D10/D11).
 *
 * Phase 2 Units B and C code against this module; keep the shapes stable.
 */

/** One requested read-only investigation, as passed to the parallel_subtasks tool. */
export interface BackgroundSubtaskSpec {
	/** Short sibling-unique label used for the report filename and the UI row. */
	label: string
	/** Mode slug the child runs in (must exist in the user's custom modes). */
	mode: string
	/** The investigation prompt. */
	message: string
}

/** Live state of one spawned background child. */
export type BackgroundChildStatus = "queued" | "running" | "completed" | "failed" | "aborted"

export interface BackgroundChildEntry {
	taskId: string
	label: string
	mode: string
	status: BackgroundChildStatus
	/** Markdown the child reported through attempt_completion, once completed. */
	result?: string
	/** Why the child failed or was aborted, for the parent's summary. */
	error?: string
	startedAt: number
	finishedAt?: number
}

/** A handle the spawning tool holds so it can await or abort the fan-out. */
export interface BackgroundChildHandle {
	taskId: string
	label: string
	mode: string
	/** Resolves when the child reaches a terminal state; never rejects. */
	done: Promise<BackgroundChildEntry>
}

export interface SpawnBackgroundChildrenResult {
	children: BackgroundChildHandle[]
	/** True when at least one child was queued (i.e. the fan-out is live). */
	started: boolean
}

/**
 * The subset of `ClineProvider` a background child needs at completion time.
 * Declared here so `AttemptCompletionTool` can resolve a child without
 * importing the provider (which would create a cycle).
 */
export interface BackgroundSubtaskHost {
	/** Resolve a completed background child and settle its parent's promise. */
	resolveBackgroundChild(childTaskId: string, result: string): void
	/** Record a failed/aborted background child and settle its parent's promise. */
	failBackgroundChild(childTaskId: string, error: string): void
}
