import path from "path"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS, RooCodeEventName } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath, createDirectoriesForFile } from "../../utils/fs"
import { stripLineNumbers, everyLineHasLineNumbers } from "../../integrations/misc/extract-text"
import { arePathsEqual, getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"
import type { RollbackRecoveryContext } from "../../integrations/editor/DiffViewProvider"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface WriteToFileParams {
	path: string
	content: string
}
/**
 * A retained rollback refusal and the edit context its recovery needs.
 *
 * The error alone was enough to refuse a retry and not enough to finish one: the retry runs
 * revertChanges(), which returns early once reset() has cleared the provider, so a marker that named no
 * target could never be cleared by a successful recovery and the refusal outlived its own meaning. The
 * context is what makes the refusal both narrower and recoverable - it names the path the dirty buffer
 * belongs to, and it is what attemptRollbackRecovery() needs to roll that edit back after the reset.
 * Absent only when the rollback was refused while the provider had no live edit to snapshot, in which
 * case nothing can name the target and the refusal stays task-wide.
 */
interface TaskRollbackFailure {
	error: Error
	context: RollbackRecoveryContext | undefined
}

/**
 * Per-task partial-streaming state tracked by WriteToFileTool.
 */
interface TaskPartialStreamState {
	/** Last path seen during streaming; undefined until the first delta. */
	lastSeenPartialPath: string | undefined
	/** True once a streaming delta hit a fatal filesystem error. */
	streamFailed: boolean
	/** The original filesystem error of the failed streaming delta, reported once
	 * by onParameterParseFailure() when the final block fails to parse (so
	 * execute() never runs and would never report it). */
	streamError: Error | undefined
	/** Set when the rollback after a streaming failure was itself refused: the dirty
	 * streamed buffer survives reset(), so the next execute() must fail closed - open()
	 * would save that unapproved buffer before approval. Reported once by execute() (or by
	 * onParameterParseFailure() when the final block never parses). */
	rollbackFailure: Error | undefined
	/** The task that owns this state; target for abort-listener deregistration. */
	task: Task
	/** TaskAborted listener that tears this state down; registered once per task. */
	abortCleanup: () => void
}

export class WriteToFileTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const

	/**
	 * Per-task partial-streaming state, keyed by task id (taskId + instanceId).
	 *
	 * All per-task fields live in one object per task so that resetTaskPartialState() /
	 * resetPartialState() cannot clear a subset of them and leak the rest (abort
	 * listener, failure mark, path-stabilization entry) for an abandoned stream.
	 *
	 * This deliberately diverges from the sibling streaming tools (ApplyDiffTool,
	 * EditFileTool, SearchReplaceTool, EditTool), which rely on BaseTool's singleton
	 * lastSeenPartialPath / resetPartialState and keep no failure state. The divergence is
	 * intentional, for two reasons:
	 *
	 * 1. Only this tool's handlePartial performs failure-prone streaming work
	 *    (diffViewProvider.open/update, which can throw EACCES/EROFS); the siblings only
	 *    send a task.ask preview. Without per-task failure tracking, every later delta for
	 *    a failed path would re-attempt the failing operation and re-spawn a partial tool
	 *    message.
	 *
	 * 2. The tool instance is a module-level singleton shared by every task, including
	 *    tasks from different ClineProvider instances (e.g. sidebar and tab-panel
	 *    providers, which activate independently). A single provider streams at most one
	 *    task at a time — TaskScheduler gates task.run() at maxConcurrency=1 and
	 *    delegation disposes the parent before the child starts — so per-task keying is
	 *    reachable specifically across providers, where two providers can stream
	 *    write_to_file concurrently through this same singleton.
	 *
	 * Lifting this per-task keying into BaseTool for all streaming tools is a follow-up
	 * (separate PR); it is deliberately not done here.
	 */
	private taskPartialStreamState = new Map<string, TaskPartialStreamState>()

	/**
	 * Refused-rollback markers per task, one record per affected path. These outlive
	 * resetTaskPartialState()/clearTaskState() because Task clears the per-stream state at the start
	 * of EVERY API request: if the dirty streamed buffer survived a refused rollback, the retry
	 * request must still fail closed instead of letting open() save that buffer before approval.
	 * Cleared once execute() reports the failure, or when the task is torn down.
	 *
	 * The value is a list rather than a single record because the gate is path-scoped. With one slot
	 * per task, a refused rollback on path B replaced the record for path A, so path A lost the only
	 * thing that was keeping its dirty, unapproved buffer from being saved by a later open() - the
	 * gate spoke about "this path", while the storage could remember only one path at a time. The
	 * same rule applies inside the list: a record that cannot name a path outranks the
	 * path-scoped ones while it stands, and that is not licence to delete them. A task-wide
	 * refusal can be lifted by one retried rollback, and the refusals it deleted with it
	 * were earned by rollbacks that are still unresolved.
	 */

	private taskRollbackFailures = new Map<string, TaskRollbackFailure[]>()
	private reportedRollbackFailures = new WeakSet<Error>()

	private getPartialStreamFailureKey(task: Task): string {
		return `${task.taskId}.${task.instanceId}`
	}

	/**
	 * Record a refused rollback against the path its dirty buffer belongs to.
	 *
	 * A record captured with a live edit names its target, so a later refusal for a different target
	 * is added beside it rather than replacing it; a refusal for the SAME target replaces the older
	 * record, because it describes the same buffer and the recovery context that matters is the newest
	 * one. A record whose capture found no live edit cannot name a target: it keeps the task-wide
	 * reach it shipped with - it answers for every path that has no refusal of its own - and
	 * only another refusal that likewise cannot name one replaces it. It outranks the
	 * path-scoped records for the paths they do not speak for; it does not delete them,
	 * because lifting the task-wide refusal must not silently lift a path whose own
	 * rollback is still refused.
	 */
	private recordRollbackFailure(task: Task, failure: TaskRollbackFailure): void {
		const key = this.getPartialStreamFailureKey(task)
		const existing = this.taskRollbackFailures.get(key) ?? []
		const target = failure.context?.absolutePath
		const kept = target
			? existing.filter((record) => record.context?.absolutePath !== target)
			: existing.filter((record) => record.context)
		this.taskRollbackFailures.set(key, [...kept, failure])
	}

	/**
	 * The recorded refusal that applies to this write target, if any.
	 *
	 * Scoped by the rule the callers used to apply by hand on the single record: a record with a
	 * captured context blocks only its own path, and a record without one blocks the whole task,
	 * because nothing about it says which buffer it belongs to.
	 */
	private refusalForPath(task: Task, relPath: string | undefined): TaskRollbackFailure | undefined {
		const records = this.taskRollbackFailures.get(this.getPartialStreamFailureKey(task))
		return records?.find((record) => this.refusalBlocksPath(task, record, relPath))
	}

	/**
	 * Drop one recorded refusal once its own buffer is confirmed restored, leaving every other
	 * refusal in place: lifting A's block must not silently lift B's, and lifting a
	 * task-wide refusal must not silently lift a path that earned its own.
	 */
	private forgetRollbackFailure(task: Task, failure: TaskRollbackFailure): void {
		const key = this.getPartialStreamFailureKey(task)
		const records = this.taskRollbackFailures.get(key)
		if (!records) {
			return
		}
		const remaining = records.filter((record) => record !== failure)
		if (remaining.length === 0) {
			this.taskRollbackFailures.delete(key)
		} else {
			this.taskRollbackFailures.set(key, remaining)
		}
	}

	/**
	 * Get this task's partial stream state, creating it on first use and registering the
	 * TaskAborted teardown listener exactly once per task.
	 */
	private getTaskPartialStreamState(task: Task): TaskPartialStreamState {
		const key = this.getPartialStreamFailureKey(task)
		const existing = this.taskPartialStreamState.get(key)
		if (existing) {
			return existing
		}

		const state: TaskPartialStreamState = {
			lastSeenPartialPath: undefined,
			streamFailed: false,
			streamError: undefined,
			rollbackFailure: undefined,
			task,
			abortCleanup: () => this.resetTaskPartialState(task),
		}
		this.taskPartialStreamState.set(key, state)
		task.once(RooCodeEventName.TaskAborted, state.abortCleanup)
		return state
	}

	private hasPathStabilizedForTask(state: TaskPartialStreamState, partialPath: string | undefined): boolean {
		// Stryker disable next-line ConditionalExpression: the `!== undefined` clause is redundant: when
		// lastSeenPartialPath is undefined, the second clause only matches an undefined partialPath, which
		// the `!!partialPath` in the return value rejects either way -- no test can distinguish the two.
		const pathHasStabilized = state.lastSeenPartialPath !== undefined && state.lastSeenPartialPath === partialPath
		state.lastSeenPartialPath = partialPath
		return pathHasStabilized && !!partialPath
	}

	/**
	 * Clear a task's partial-stream state from a disposal path that does not abort first.
	 * Task.dispose() removes every listener, so a task disposed directly (for example
	 * ClineProvider.cleanupFailedHistoryTask()) never fires the TaskAborted cleanup and
	 * this singleton would keep the disposed task and its diff-view provider.
	 */
	/**
	 * Does this refusal apply to the path this write is about to touch?
	 *
	 * The hazard is a dirty buffer in one document, so the refusal belongs to that document target and
	 * not to every write the task will attempt: an unrelated path cannot save a buffer it never opened.
	 * A refusal with no captured context cannot name its target, and for that case the refusal keeps
	 * its original task-wide reach rather than guessing at a path.
	 */
	private refusalBlocksPath(
		task: Task,
		refusal: TaskRollbackFailure | undefined,
		relPath: string | undefined,
	): boolean {
		if (!refusal) {
			return false
		}
		if (!refusal.context || relPath === undefined) {
			return true
		}
		return arePathsEqual(path.resolve(task.cwd, relPath), refusal.context.absolutePath)
	}

	/** Release the refused-rollback marker for a task that is being torn down. */
	public releaseTaskRollbackFailure(task: Task): void {
		this.taskRollbackFailures.delete(this.getPartialStreamFailureKey(task))
	}

	public clearTaskState(task: Task): void {
		// The per-stream state is per request, but a refused rollback left the dirty buffer in
		// place: taskRollbackFailures is intentionally NOT cleared here so the retry request
		// still fails closed. It is released by execute() once reported, or by resetPartialState().
		this.resetTaskPartialState(task)
	}

	private resetTaskPartialState(task: Task): void {
		const key = this.getPartialStreamFailureKey(task)
		const state = this.taskPartialStreamState.get(key)
		if (!state) {
			return
		}
		state.task.off(RooCodeEventName.TaskAborted, state.abortCleanup)
		this.taskPartialStreamState.delete(key)
	}

	private async resetDiffViewAfterWrite(task: Task): Promise<void> {
		await task.diffViewProvider.reset().catch((resetError) => {
			console.error("Error resetting write_to_file diff view:", resetError)
		})
	}

	/**
	 * Restore the diff editor document to its pre-streaming state and close the view.
	 *
	 * reset() clears the provider's state but leaves the diff document dirty with the
	 * streamed content; a user save would then persist a write the task never completed
	 * (denied or failed before approval). Must run BEFORE resetDiffViewAfterWrite(),
	 * since reset() clears the state revertChanges() relies on. No-op when no diff view
	 * is open. A revert failure is RETURNED rather than dropped: the caller records it as the
	 * failure this stream produced, so debris left on disk is reported instead of being
	 * silently continued past.
	 */
	private async revertDiffChangesBeforeReset(task: Task): Promise<Error | undefined> {
		try {
			await task.diffViewProvider.revertChanges()
		} catch (revertError) {
			console.error("Error reverting write_to_file diff view changes:", revertError)
			return revertError instanceof Error ? revertError : new Error(String(revertError))
		}
		return undefined
	}

	/**
	 * Whether this task can still act on a partial delta. Mirrors the guard Task uses to bail
	 * out of its own loops, so a delta never does work for a task that has already stopped.
	 */
	private isStreamCancelled(task: Task): boolean {
		return task.abort === true || task.abandoned === true
	}

	private async finalizePartialToolAskAfterFailure(task: Task, text?: string): Promise<void> {
		await task.finalizePartialToolAsk(text).catch((finalizeError) => {
			console.error("Error finalizing write_to_file partial tool ask:", finalizeError)
		})
	}

	/**
	 * Teardown for the handle() parse-failure path, where execute() never runs and its
	 * cleanup never runs either.
	 *
	 * Releases the per-task stream state: otherwise the abort listener leaks for the task's
	 * lifetime, and a failed streaming delta leaves the streamFailed guard suppressing the
	 * diff preview of every later write_to_file in this task. Restores the diff document:
	 * streaming may have opened it with unapproved partial content, and execute()'s error
	 * cleanup (revert + reset) never fires here, so a user save could persist it. When a
	 * streaming delta already hit a fatal filesystem error, THAT is the failure the user can
	 * act on, so it is reported with the same "writing file" context execute()'s catch uses,
	 * and true is returned to suppress the incidental parse error - the failure surfaces
	 * exactly once.
	 *
	 * Also reached from presentAssistantMessage's missing-nativeArgs guard: that guard
	 * emits its own tool_result and returns before handle() runs, so this teardown is
	 * the only thing that can release the entry a stream left behind. Skip it and the
	 * per-task entry plus its TaskAborted listener outlive the call, the retained
	 * streamFailed mark suppresses this task's later diff previews, and a diff document
	 * the stream opened keeps content the user never approved. That guard passes a
	 * handleError that feeds the failure into the single tool_result it owns.
	 */
	override async releaseStreamStateOnParseFailure(
		task: Task,
		callbacks: Pick<ToolCallbacks, "handleError">,
	): Promise<boolean> {
		const state = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (!state) {
			return false
		}

		this.resetTaskPartialState(task)
		// Only an edit in progress may be reverted. DiffViewProvider keeps relPath after a
		// completed write, so reverting against that stale target would roll back - and for a
		// new file permanently delete - a file this stream never opened.
		let rollbackError: Error | undefined
		let recoveryContext: RollbackRecoveryContext | undefined
		if (task.diffViewProvider.isEditing) {
			// Snapshot before the attempt, not after it: a rollback that succeeds ends with reset(), which
			// clears exactly the fields a later recovery would need, and a refused one leaves them set only
			// until the reset this teardown runs right after.
			recoveryContext = task.diffViewProvider.captureRollbackRecoveryContext()
			rollbackError = await this.revertDiffChangesBeforeReset(task)
		}
		if (rollbackError) {
			// The dirty buffer is still on disk after the refused rollback: keep the fail-closed
			// marker on the TASK, not the per-stream state this teardown is about to delete.
			this.recordRollbackFailure(task, { error: rollbackError, context: recoveryContext })
		}
		await this.resetDiffViewAfterWrite(task)

		// A failed rollback is the more actionable failure (debris is still on disk), so when a
		// streaming error was also captured it takes the report slot and the streaming error is
		// kept behind it as the cause. Without a captured streaming error there was no streaming
		// failure to describe: the rollback gets its own message and the parse error stays the
		// actionable report. These are two distinct failures, so reporting both does not break the
		// single-report rule.
		if (rollbackError) {
			this.reportedRollbackFailures.add(rollbackError)
			if (state.streamError) {
				await callbacks.handleError(
					"writing file",
					new Error(`write_to_file rollback failed after a streaming error: ${rollbackError.message}`, {
						cause: state.streamError,
					}),
				)
				return true
			}
			await callbacks.handleError(
				"writing file",
				new Error(`write_to_file rollback failed: ${rollbackError.message}`, { cause: rollbackError }),
			)
			return false
		}

		if (state.streamError) {
			await callbacks.handleError("writing file", state.streamError)
			return true
		}

		return false
	}

	override resetPartialState(): void {
		super.resetPartialState()
		this.taskRollbackFailures.clear()
		for (const state of this.taskPartialStreamState.values()) {
			state.task.off(RooCodeEventName.TaskAborted, state.abortCleanup)
		}
		this.taskPartialStreamState.clear()
	}

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const relPath = params.path
		let newContent = params.content
		// Set when this execute() opens its own partial tool ask (diff-view branch), so
		// the catch below can finalize it. Undefined on the saveDirectly branch.
		let pendingPartialAsk: string | undefined

		// Fail closed on a refused streaming rollback: the dirty streamed buffer survived
		// reset(), and open() saves a dirty existing document BEFORE approval - retrying the
		// write here would persist content the user never approved. Report the recorded failure
		// once and touch no write path (no open/update/save, no directory creation). The state
		// is released here, so the parse-failure path - which only runs when execute() never
		// did - can never report the same failure a second time.
		const refusal = this.refusalForPath(task, relPath)
		// Scoped to the target the dirty buffer belongs to: a write to another path cannot save a
		// buffer it never opened, and blocking it was both wider than the hazard and impossible to
		// lift. The per-stream state is not consulted here - this teardown releases it, so a refusal
		// that outlives the release lives only in the marker.
		if (refusal && this.refusalBlocksPath(task, refusal, relPath)) {
			const reported = refusal.error
			this.resetTaskPartialState(task)
			// Keep the marker until the dirty buffer is actually restored: a later write to the
			// same path would otherwise call open() and save the unapproved content. revertChanges()
			// reports whether it performed a rollback - it resolves without touching anything when
			// this provider no longer has an edit in progress, which is the state reset() leaves
			// behind after a refused restore. Only a confirmed rollback clears the marker; a
			// rejection and a no-op both keep the fail-closed refusal.
			let restored = false
			try {
				// With a captured context the provider can roll back an edit its own reset() already forgot.
				// Without one there is nothing to hand back, so the attempt is the provider own revert, which
				// reports false when it has no edit in progress: the same contract, an attempt that cannot
				// manufacture an edit nobody recorded.
				restored = refusal.context
					? await task.diffViewProvider.attemptRollbackRecovery(refusal.context)
					: await task.diffViewProvider.revertChanges()
			} catch (rollbackError) {
				console.error("Error restoring the refused write_to_file rollback:", rollbackError)
			}
			// Cleared only on a recovery that reports it actually rolled the edit back. A recovery that
			// rejects, or that reports it had nothing to restore, keeps the refusal: the dirty buffer is
			// still there and the next open() would save content the user never approved.
			if (restored) {
				this.forgetRollbackFailure(task, refusal)
			}
			// The parse-failure teardown may already have reported this exact failure: keep the
			// fail-closed refusal but do not report the same Error twice.
			if (!(reported && this.reportedRollbackFailures.has(reported))) {
				await handleError("writing file", reported!)
			}
			return
		}

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			// No execute() cleanup on this early return: release THIS task's stream state
			// (and only this task's) so the abort listener and the streamFailed guard do not
			// outlive the call.
			this.resetTaskPartialState(task)
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))
			await task.diffViewProvider.reset()
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			// No execute() cleanup on this early return: release THIS task's stream state
			// (and only this task's) so the abort listener and the streamFailed guard do not
			// outlive the call.
			this.resetTaskPartialState(task)
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			try {
				await task.say("rooignore_error", relPath)
			} finally {
				// The release belongs in a finally: task.say() can reject when the task is cancelled
				// or disposed mid-ask, and a rejection that skips it leaks this task's stream state and
				// its TaskAborted listener. finally keeps this branch the same shape as the sibling
				// units, which run their own cleanup before releasing.
				this.resetTaskPartialState(task)
			}
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		try {
			// The preflight filesystem work sits inside the guarded scope on purpose: a throw from
			// fileExistsAtPath / createDirectoriesForFile must be reported like any other write
			// failure, and the per-task stream state must still be released.

			let fileExists: boolean
			const absolutePath = path.resolve(task.cwd, relPath)

			if (task.diffViewProvider.editType !== undefined) {
				fileExists = task.diffViewProvider.editType === "modify"
			} else {
				fileExists = await fileExistsAtPath(absolutePath)
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
			}

			// Create parent directories early for new files to prevent ENOENT errors
			// in subsequent operations (e.g., diffViewProvider.open, fs.readFile)
			if (!fileExists) {
				await createDirectoriesForFile(absolutePath)
			}

			if (newContent.startsWith("```")) {
				newContent = newContent.split("\n").slice(1).join("\n")
			}

			if (newContent.endsWith("```")) {
				newContent = newContent.split("\n").slice(0, -1).join("\n")
			}

			if (!task.api.getModel().id.includes("claude")) {
				newContent = unescapeHtmlEntities(newContent)
			}

			const fullPath = relPath ? path.resolve(task.cwd, relPath) : ""
			const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

			const sharedMessageProps: ClineSayTool = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(task.cwd, relPath),
				content: newContent,
				isOutsideWorkspace,
				isProtected: isWriteProtected,
			}

			task.consecutiveMistakeCount = 0

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			if (isPreventFocusDisruptionEnabled) {
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
				if (fileExists) {
					const absolutePath = path.resolve(task.cwd, relPath)
					task.diffViewProvider.originalContent = await fs.readFile(absolutePath, "utf-8")
				} else {
					task.diffViewProvider.originalContent = ""
				}

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					return
				}

				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				if (!task.diffViewProvider.isEditing) {
					const partialMessage = JSON.stringify(sharedMessageProps)
					pendingPartialAsk = partialMessage
					await task.ask("tool", partialMessage, true).catch(() => {})
					await task.diffViewProvider.open(relPath)
				}

				await task.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					true,
				)

				task.diffViewProvider.scrollToFirstDiff()

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					return
				}

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			pushToolResult(message)

			await task.diffViewProvider.reset()
			// BaseTool's reset only clears this instance's lastSeenPartialPath; the
			// stream state added here is keyed per task. Clearing the whole map from
			// BaseTool's reset only clears this instance's lastSeenPartialState; the per-task
			// entry is released by the finally below (clearing the whole map from one task's
			// execute() would drop another task's streamFailed/streamError while it is still
			// streaming).

			task.processQueuedMessages()

			return
		} catch (error) {
			// The diff-view branch above may have opened a fresh partial ask for this
			// (retried) write. Finalize it before tearing down, or the spinner and
			// Save/Reject buttons stay live for a tool call that has already failed.
			if (pendingPartialAsk !== undefined) {
				await this.finalizePartialToolAskAfterFailure(task, pendingPartialAsk)
			}
			await handleError("writing file", error as Error)
			await task.diffViewProvider.reset()
			super.resetPartialState()
			return
		} finally {
			// One teardown covers every exit of the guarded scope: success, both approval denials,
			// the catch, and any throw from the preflight filesystem work. Idempotent, so the
			// explicit releases on the early returns above stay correct.
			this.resetTaskPartialState(task)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const newContent: string | undefined = block.params.content

		const partialStreamFailureKey = this.getPartialStreamFailureKey(task)

		// A prior streaming delta for this task already hit a fatal filesystem error.
		// Skip further streaming work so we don't create a new partial tool message on every
		// subsequent delta. execute() will report the error once when the block completes.
		if (this.taskPartialStreamState.get(partialStreamFailureKey)?.streamFailed) {
			return
		}

		// A task that was aborted or abandoned can no longer reach execute()'s teardown, so this
		// delta must not register per-task state at all: the abort listener would outlive a stream
		// that never produces another delta, and the entry's failure mark would suppress the diff
		// preview of a later write in a task that already moved on. Same two flags Task itself
		// bails on, and the same cancellation-aware shape #1929 established for the streamFailed
		// guard: check before acquiring state, then re-check after every await before the next
		// observable effect.
		if (this.isStreamCancelled(task)) {
			return
		}

		// Get (or create) this task's state; registers the TaskAborted teardown listener
		// once, so abandoned streams are torn down even if execute() never runs.
		const partialStreamState = this.getTaskPartialStreamState(task)

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilizedForTask(partialStreamState, relPath) || newContent === undefined) {
			return
		}

		// Hoisted above the guarded setup: the diff-view catch below finalizes the same partial
		// ask, so the message has to stay in scope once the try block ends.
		let partialMessage: string | undefined

		try {
			// Everything from here up to the diff view is setup that can fail before
			// execute() ever runs; the catch below owns the teardown for that window.
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			// First await since the state was registered: a cancellation during getState() would
			// otherwise continue into the partial ask below.
			if (this.isStreamCancelled(task)) {
				this.resetTaskPartialState(task)
				return
			}
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			if (isPreventFocusDisruptionEnabled) {
				// The preview is suppressed for this stream: release the entry registered above so the
				// abort listener and any failure mark do not outlive a delta that never shows a diff
				// view and never reaches execute()'s teardown.
				super.resetPartialState()
				this.resetTaskPartialState(task)
				return
			}

			// relPath is guaranteed non-null after hasPathStabilized
			let fileExists: boolean
			const absolutePath = path.resolve(task.cwd, relPath!)

			if (task.diffViewProvider.editType !== undefined) {
				fileExists = task.diffViewProvider.editType === "modify"
			} else {
				fileExists = await fileExistsAtPath(absolutePath)
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
			}
			// The filesystem probe is another await boundary, and the ask below is the first thing
			// the user can see: a task that stopped must not produce it.
			if (this.isStreamCancelled(task)) {
				this.resetTaskPartialState(task)
				return
			}

			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath!) || false
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ClineSayTool = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(task.cwd, relPath!),
				content: newContent || "",
				isOutsideWorkspace,
				isProtected: isWriteProtected,
			}

			partialMessage = JSON.stringify(sharedMessageProps)
			await task.ask("tool", partialMessage, block.partial).catch(() => {})
		} catch (error) {
			// Unexpected failure in the pre-streaming setup (provider state, the filesystem probe,
			// policy checks, message construction): this delta never reaches the diff view or
			// execute(), so nothing else releases what the registration acquired. Drop this task's
			// entry and its TaskAborted listener, then rethrow - BaseTool.handle() still reports the
			// error once, and the diff-view failure path above keeps its own single-report handling.
			this.resetTaskPartialState(task)
			throw error
		}

		// Last await before the diff view: the ask above can be answered (or the task aborted)
		// while it is in flight, and opening a preview for a task that already stopped would
		// leave a diff view nobody owns.
		if (this.isStreamCancelled(task)) {
			this.resetTaskPartialState(task)
			return
		}

		// A refused rollback left the streamed document dirty: opening a preview here would save
		// that unapproved buffer before approval, so this delta stops and execute() owns the refusal
		// report. The check sits outside the content guard on purpose: a delta that streamed an
		// empty document still has its ask on screen, and that one has to be finalized too.
		// Path-scoped like the execute() gate: a delta for another path is not the delta that left a
		// dirty buffer behind, and suppressing its preview made an unrelated write look broken.
		const streamRefusal = this.refusalForPath(task, relPath)
		if (streamRefusal) {
			// The ask above is already on screen and this return is the last thing the delta does:
			// finalize it, or the spinner and Save/Reject buttons stay live for a preview that will
			// never be opened. execute() owns the refusal report.
			await this.finalizePartialToolAskAfterFailure(task, partialMessage)
			this.resetTaskPartialState(task)
			return
		}

		if (newContent) {
			try {
				if (!task.diffViewProvider.isEditing) {
					await task.diffViewProvider.open(relPath!)
					// open() is an await boundary of its own, and the preview it installs is shared state.
					// A task that stopped while open() was in flight has no delta left that can approve what
					// would be streamed into it, so update() here would write content nobody owns and leave
					// the preview dirty for a later save. Undo what open() brought up and release the entry,
					// the same teardown the catch below runs for a diff-view failure; both helpers report
					// their own failure, and an abandoned stream has no execute() left to report through.
					if (this.isStreamCancelled(task)) {
						await this.revertDiffChangesBeforeReset(task)
						await this.resetDiffViewAfterWrite(task)
						this.resetTaskPartialState(task)
						return
					}
				}

				await task.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					false,
				)
			} catch (error) {
				// Opening or updating the diff view can throw on filesystem errors
				// (EACCES/EROFS on read-only paths). Finalize the partial tool message
				// so the UI spinner doesn't get stuck and reset the diff view. Do NOT
				// rethrow: the same filesystem operation is retried in execute() once the
				// block completes, and that authoritative non-partial path reports the
				// error to the user. Surfacing it here too would show the same error twice.
				// Swallowing it here is safe because the agent loop advances naturally when
				// the non-partial block arrives (it does not depend on this throw).
				console.error(`Error streaming write_to_file diff view:`, error)
				// Mark the stream as failed so later deltas don't re-attempt and spawn a new
				// partial tool message each time. Retain the original error: if the final
				// block later fails to parse, execute() never runs and only
				// onParameterParseFailure() can report this failure to the user.
				partialStreamState.streamFailed = true
				partialStreamState.streamError = error instanceof Error ? error : new Error(String(error))
				// The ask only exists once the setup above assigned its message; before that there
				// is nothing to finalize.
				if (partialMessage !== undefined) {
					await this.finalizePartialToolAskAfterFailure(task, partialMessage)
				}
				// The write was never approved: restore the document so a user save cannot
				// persist the failed streamed content (reset() alone leaves it dirty).
				// Snapshot before the attempt, as in the teardown above: a refused rollback is only
				// retryable if something kept the edit context the rollback needs, and the reset below
				// is about to clear it.
				const recoveryContext = task.diffViewProvider.captureRollbackRecoveryContext()
				const rollbackError = await this.revertDiffChangesBeforeReset(task)
				if (rollbackError) {
					// The rollback did not finish: the placeholder and any created directories are still
					// on disk, and the next execute() would treat that debris as an existing file. A
					// logged-only revert failure hides exactly that, so the rollback failure becomes the
					// failure this stream reports - the original streaming error stays reachable as the
					// cause, and the report still happens exactly once (on the parse-failure path).
					const rollbackFailure = new Error(
						`write_to_file rollback failed after a streaming error: ${rollbackError.message}`,
						{ cause: partialStreamState.streamError },
					)
					partialStreamState.streamError = rollbackFailure
					// Fail closed for the next execute(): reset() cannot close the dirty diff tab the
					// refused restore left behind, so a retry would re-open the view and save the
					// unapproved streamed content before approval. Record the failure on this task's
					// state; execute() reports it once and touches no write path.
					partialStreamState.rollbackFailure = rollbackFailure
					this.recordRollbackFailure(task, { error: rollbackFailure, context: recoveryContext })
				}
				await this.resetDiffViewAfterWrite(task)
			}
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
