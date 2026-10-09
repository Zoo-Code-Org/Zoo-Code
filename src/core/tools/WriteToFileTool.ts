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

	/**
	 * Whether this task's partial stream is still the live one. handlePartial() awaits provider
	 * state, a filesystem probe, task.ask() and the diff view's open() before it streams content;
	 * a cancellation during any of those awaits runs the TaskAborted teardown (or a direct
	 * clearTaskState), which deletes this entry. Continuing would re-ask and re-open a diff view
	 * for a task the user already cancelled, resurrecting the state the teardown released.
	 * Identity, not presence: an entry re-created under the same key belongs to a new stream,
	 * and this delta must not write into it.
	 */
	private isPartialStreamStillLive(task: Task, state: TaskPartialStreamState): boolean {
		return this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task)) === state
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
	 * is open. Failures are logged and reported through the return value: the caller
	 * must not treat the teardown as complete when this returns false, because the
	 * document may still hold the unapproved content, but the remaining cleanup (reset,
	 * per-task state teardown) still runs so the task is not left half-torn-down.
	 */
	private async revertDiffChangesBeforeReset(task: Task): Promise<boolean> {
		try {
			await task.diffViewProvider.revertChanges()
			return true
		} catch (revertError) {
			console.error("Error reverting write_to_file diff view changes:", revertError)
			return false
		}
	}

	private async finalizePartialToolAskAfterFailure(task: Task, text?: string): Promise<void> {
		await task.finalizePartialToolAsk(text).catch((finalizeError) => {
			console.error("Error finalizing write_to_file partial tool ask:", finalizeError)
		})
	}

	/**
	 * Surface a failed rollback to the user. The hazard has to be visible in the chat,
	 * not only in the console: the editor may still hold content the task never
	 * approved and a save of it would land an unauthorized write. A failing say must
	 * not abort the teardown - a retained streaming error still has to reach the user
	 * through handleError - so its failure is logged only, matching the other cleanup
	 * helpers in this file.
	 */
	private async reportRevertFailure(task: Task): Promise<void> {
		await task
			.say(
				"error",
				"write_to_file: the diff editor could not be restored after the failed tool call, so it may still show unapproved content. Do not save that editor.",
			)
			.catch((sayError) => {
				console.error("Error reporting write_to_file rollback failure:", sayError)
			})
	}

	/**
	 * Cleanup for a failed partial stream: restore the diff document, close the view,
	 * and - when the restore itself failed - tell the user the editor may still hold
	 * unapproved content, the same way the parse-failure teardown does. Without the
	 * report, a failed rollback here is invisible: the stream error that triggered the
	 * cleanup is a different failure and is reported elsewhere.
	 */
	private async cleanupFailedPartialStream(task: Task): Promise<void> {
		const reverted = await this.revertDiffChangesBeforeReset(task)
		await this.resetDiffViewAfterWrite(task)
		if (!reverted) {
			await this.reportRevertFailure(task)
		}
	}

	/**
	 * Teardown boundary for the handle() parse-failure path, where execute() never
	 * runs and therefore its finally (resetTaskPartialState) never runs either.
	 *
	 * Tears down the per-task stream state: otherwise the abort listener leaks for
	 * the task's lifetime, and when a streaming delta had failed, the streamFailed
	 * guard would suppress the diff preview of every later write_to_file in this
	 * task. Restores the diff document: streaming may have opened it with
	 * unapproved partial content, and execute()'s error cleanup (revert + reset)
	 * never fires on this path, so a user save could persist the content without
	 * the teardown here. When a streaming delta already hit a fatal filesystem
	 * error, that error is what the user can act on, so report it with the same
	 * "writing file" context execute()'s catch uses, and suppress the incidental
	 * parse error.
	 */
	override async onParameterParseFailure(task: Task, callbacks: ToolCallbacks, parseError: Error): Promise<boolean> {
		const state = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (!state) {
			return false
		}
		// Streaming may have opened the diff view with unapproved partial content.
		// execute() never runs on this path, so its error cleanup (revert + reset)
		// never fires: restore the document here so a user save cannot persist
		// content the write never completed (the same invariant the denial and
		// streaming-failure paths maintain). Both helpers no-op when no view is open.
		// The revert runs BEFORE the per-task state is torn down: when it fails, the
		// document can still hold that unapproved content, and the recovery state has
		// to exist while the outcome is decided and reported.
		const reverted = await this.revertDiffChangesBeforeReset(task)
		this.resetTaskPartialState(task)
		await this.resetDiffViewAfterWrite(task)
		if (!reverted) {
			// Do not report a completed teardown: the editor may still show content this
			// task never approved, and saving it would land a write the user never
			// authorized. The user has to be able to tell that from the UI.
			await this.reportRevertFailure(task)
		}
		if (!state.streamError) {
			return false
		}
		void parseError
		await callbacks.handleError("writing file", state.streamError)
		return true
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

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))

			// Returning here skips the cleanup below: release THIS task's stream state (and
			// only this task's) so the abort listener and any streamFailed guard do not outlive
			// the call.
			this.resetTaskPartialState(task)
			await task.diffViewProvider.reset()
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))

			// Returning here skips the cleanup below: release THIS task's stream state (and
			// only this task's) so the abort listener and any streamFailed guard do not outlive
			// the call.
			this.resetTaskPartialState(task)
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))

			// Returning here skips the cleanup below: release THIS task's stream state (and
			// only this task's) so the abort listener and any streamFailed guard do not outlive
			// the call.
			this.resetTaskPartialState(task)
			return
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		let fileExists: boolean
		const absolutePath = path.resolve(task.cwd, relPath)

		if (task.diffViewProvider.editType !== undefined) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
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

		// Tracks whether the user approved the write, so the error path only reverts the
		// diff document when the content was never approved (an approved edit is kept in
		// the editor so the user can save it manually after a late failure).
		let writeApproved = false

		try {
			// Create parent directories for new files inside the try block so filesystem
			// errors (EROFS, EACCES, etc.) route through handleError with proper cleanup
			// and consecutive-mistake counting, rather than escaping unhandled.
			if (!fileExists) {
				await createDirectoriesForFile(absolutePath)
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
					// The prevent-focus branch set editType/originalContent on the provider
					// before asking. Clear them on denial (no diff document was opened in
					// this branch, so reset() is sufficient; the non-prevent-focus denial
					// branch resets through revertChanges()), so a later write re-checks
					// the file system instead of reusing the stale editType.
					await this.resetDiffViewAfterWrite(task)
					return
				}

				writeApproved = true

				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				if (!task.diffViewProvider.isEditing) {
					const partialMessage = JSON.stringify(sharedMessageProps)
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

				writeApproved = true

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			pushToolResult(message)

			await this.resetDiffViewAfterWrite(task)

			task.processQueuedMessages()

			return
		} catch (error) {
			// Finalize any open partial tool message so the UI spinner doesn't get stuck.
			// The partial ask fired during streaming (handlePartial) or early in execute sets
			// partial: true on the webview message; without this, the spinner persists even
			// after the error bubble appears.
			await this.finalizePartialToolAskAfterFailure(task)
			// The diff cleanup runs in a finally around handleError: the production
			// handleError awaits Task.say(), which rejects when the task is aborted, and a
			// rejected handleError must not skip restoring the unapproved streamed content.
			try {
				await handleError("writing file", error as Error)
			} finally {
				// Before approval the diff document holds unapproved streamed content:
				// restore it so a user save cannot persist it. After approval the content
				// is the user's accepted edit -- keep it in the editor (dirty) so they can
				// save it manually.
				let reverted = true
				if (!writeApproved) {
					reverted = await this.revertDiffChangesBeforeReset(task)
				}
				await this.resetDiffViewAfterWrite(task)
				if (!reverted) {
					// The restore failed, so the editor still holds content this task never approved.
					// The error the user sees on this path is the write failure, not this one.
					await this.reportRevertFailure(task)
				}
			}
			return
		} finally {
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

		// Get (or create) this task's state; registers the TaskAborted teardown listener
		// once, so abandoned streams are torn down even if execute() never runs.
		const partialStreamState = this.getTaskPartialStreamState(task)

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilizedForTask(partialStreamState, relPath) || newContent === undefined) {
			return
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		// Cancelled while provider state was in flight: the teardown already released this
		// task's stream state, so this delta must not go on to ask or open a diff view.
		if (!this.isPartialStreamStillLive(task, partialStreamState)) {
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

		// Cancelled during the filesystem probe: stop before the partial ask and the diff view.
		// (The probe above is the only await in this branch.)
		if (!this.isPartialStreamStillLive(task, partialStreamState)) {
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

		const partialMessage = JSON.stringify(sharedMessageProps)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})

		// Cancelled while the partial ask was in flight: the teardown released this task's
		// state, so this delta must not touch the diff view.
		if (!this.isPartialStreamStillLive(task, partialStreamState)) {
			return
		}

		if (newContent) {
			try {
				if (!task.diffViewProvider.isEditing) {
					await task.diffViewProvider.open(relPath!)
				}

				// Cancelled while open() was in flight: do not stream partial content into a
				// cancelled task's view.
				if (!this.isPartialStreamStillLive(task, partialStreamState)) {
					return
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
				await this.finalizePartialToolAskAfterFailure(task, partialMessage)
				// The write was never approved: restore the document so a user save cannot
				// persist the failed streamed content (reset() alone leaves it dirty), and
				// surface the hazard if that restore itself failed. The stream error is
				// reported by the authoritative non-partial path in execute(); the rollback
				// hazard is a different failure and nothing else in this path says so.
				await this.cleanupFailedPartialStream(task)
			}
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
