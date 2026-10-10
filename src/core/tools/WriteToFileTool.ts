import path from "path"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS, RooCodeEventName } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath, createDirectoriesForFile } from "../../utils/fs"
import { stripLineNumbers, everyLineHasLineNumbers } from "../../integrations/misc/extract-text"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface WriteToFileParams {
	path: string
	content: string
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

	private getPartialStreamFailureKey(task: Task): string {
		return `${task.taskId}.${task.instanceId}`
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
	public clearTaskState(task: Task): void {
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
	 */
	protected override async releaseStreamStateOnParseFailure(task: Task, callbacks: ToolCallbacks): Promise<boolean> {
		const state = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (!state) {
			return false
		}

		this.resetTaskPartialState(task)
		// Only an edit in progress may be reverted. DiffViewProvider keeps relPath after a
		// completed write, so reverting against that stale target would roll back - and for a
		// new file permanently delete - a file this stream never opened.
		let rollbackError: Error | undefined
		if (task.diffViewProvider.isEditing) {
			rollbackError = await this.revertDiffChangesBeforeReset(task)
		}
		await this.resetDiffViewAfterWrite(task)

		// A failed rollback is the more actionable failure (debris is still on disk), so when a
		// streaming error was also captured it takes the report slot and the streaming error is
		// kept behind it as the cause. Without a captured streaming error there was no streaming
		// failure to describe: the rollback gets its own message and the parse error stays the
		// actionable report. These are two distinct failures, so reporting both does not break the
		// single-report rule.
		if (rollbackError) {
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
		const streamState = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (streamState?.rollbackFailure) {
			this.resetTaskPartialState(task)
			await handleError("writing file", streamState.rollbackFailure)
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

		if (newContent) {
			try {
				if (!task.diffViewProvider.isEditing) {
					await task.diffViewProvider.open(relPath!)
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
				}
				await this.resetDiffViewAfterWrite(task)
			}
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
