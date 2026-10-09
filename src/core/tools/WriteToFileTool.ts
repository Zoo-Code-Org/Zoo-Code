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
	 * Release everything the current tool call owns of the partial-stream bookkeeping:
	 * BaseTool's last-seen path plus THIS task's per-task entry (and its TaskAborted
	 * listener). Every exit of execute() and every handlePartial() return that skips the
	 * success-path teardown has to call this. Without it a rejected approval leaves the
	 * entry attached for the rest of the task's life: the listener is only ever removed
	 * by a teardown, and a retained streamFailed keeps suppressing this task's later
	 * diff previews. Task-scoped by design: BaseTool's resetPartialState() only owns the
	 * singleton last-seen path, and a global teardown would clobber another task that is
	 * still streaming through this singleton.
	 */
	private releasePartialStreamBookkeeping(task: Task): void {
		super.resetPartialState()
		this.resetTaskPartialState(task)
	}

	/**
	 * Whether this task's partial stream is still the live one. handlePartial() awaits
	 * provider state, a filesystem probe and task.ask() before it touches the diff view; a
	 * cancellation during any of those awaits runs the TaskAborted teardown (or a direct
	 * clearTaskState), which deletes this entry. Continuing would re-open a diff view and
	 * re-ask for a task the user already cancelled, resurrecting the state the teardown
	 * released. Identity, not presence: a re-created entry for the same key belongs to a new
	 * stream, and this one must not write into it.
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

	private async finalizePartialToolAskAfterFailure(task: Task, text?: string): Promise<void> {
		await task.finalizePartialToolAsk(text).catch((finalizeError) => {
			console.error("Error finalizing write_to_file partial tool ask:", finalizeError)
		})
	}

	/**
	 * Override of BaseTool's teardown boundary for the handle() parse-failure path, where
	 * execute() never runs and therefore none of execute()'s teardown runs either.
	 *
	 * Releases THIS task's stream state: otherwise the abort listener leaks for the task's
	 * lifetime, and when a streaming delta had failed, the streamFailed guard would suppress
	 * the diff preview of every later write_to_file in this task. Restores the diff document:
	 * streaming may have opened it with unapproved partial content, and execute()'s error
	 * cleanup (revert + reset) never fires on this path, so a user save could persist the
	 * content without the teardown here. When a streaming delta already hit a fatal filesystem
	 * error, that error is what the user can act on, so report it with the same "writing file"
	 * context execute()'s catch uses, and return true to suppress the incidental parse error -
	 * the failure then surfaces exactly once.
	 */
	protected override async releaseStreamStateOnParseFailure(
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<boolean> {
		const state = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (!state) {
			return false
		}

		this.resetTaskPartialState(task)
		const rollbackError = await this.revertDiffChangesBeforeReset(task)
		await this.resetDiffViewAfterWrite(task)

		// A failed rollback is the more actionable failure (debris is still on disk), so it takes
		// the report slot when present; the streaming error is kept behind it as the cause.
		if (rollbackError) {
			await callbacks.handleError(
				"writing file",
				new Error(`write_to_file rollback failed after a streaming error: ${rollbackError.message}`, {
					cause: state.streamError ?? rollbackError,
				}),
			)
			return true
		}

		if (state.streamError) {
			await callbacks.handleError("writing file", state.streamError)
			return true
		}

		return false
	}

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const relPath = params.path
		let newContent = params.content
		// Set when this execute() opens its own partial tool ask (diff-view branch), so
		// the catch below can finalize it. Undefined on the saveDirectly branch.
		let pendingPartialAsk: string | undefined

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))

			// Returning here skips the try/catch teardown below: release THIS task's stream
			// state (and only this task's) so the abort listener and any streamFailed guard do
			// not outlive the call.
			this.releasePartialStreamBookkeeping(task)
			await task.diffViewProvider.reset()
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))

			// Returning here skips the try/catch teardown below: release THIS task's stream
			// state (and only this task's) so the abort listener and any streamFailed guard do
			// not outlive the call.
			this.releasePartialStreamBookkeeping(task)
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))

			// Returning here skips the try/catch teardown below: release THIS task's stream
			// state (and only this task's) so the abort listener and any streamFailed guard do
			// not outlive the call.
			this.releasePartialStreamBookkeeping(task)
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

		try {
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
					this.releasePartialStreamBookkeeping(task)
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
					this.releasePartialStreamBookkeeping(task)
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
			// Tear down only this task's entry; clearing the whole map would drop another
			// task's streamFailed/streamError while it is still streaming.
			this.releasePartialStreamBookkeeping(task)

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
			this.releasePartialStreamBookkeeping(task)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const newContent: string | undefined = block.params.content


		// Get (or create) this task's state; registers the TaskAborted teardown listener
		// once, so abandoned streams are torn down even if execute() never runs.
		const partialStreamState = this.getTaskPartialStreamState(task)

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilizedForTask(partialStreamState, relPath) || newContent === undefined) {
			return
		}

		try {
			// Everything from here up to the diff view is setup that can fail before
				// execute() ever runs; the catch below owns the teardown for that window.
			const provider = task.providerRef.deref()
			const state = await provider?.getState()

			// Cancelled while provider state was in flight: the teardown already
			// released this task's stream state.
			if (!this.isPartialStreamStillLive(task, partialStreamState)) {
				return
			}
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			if (isPreventFocusDisruptionEnabled) {
				// The preview is suppressed for this stream: release the entry registered above so
				// the abort listener and any failure mark do not outlive a delta that never shows
				// a diff view and never reaches execute()'s teardown.
				this.releasePartialStreamBookkeeping(task)
				return
			}

			// relPath is guaranteed non-null after hasPathStabilized
			let fileExists: boolean
			const absolutePath = path.resolve(task.cwd, relPath!)

			if (task.diffViewProvider.editType !== undefined) {
				fileExists = task.diffViewProvider.editType === "modify"
			} else {
				fileExists = await fileExistsAtPath(absolutePath)
				if (!this.isPartialStreamStillLive(task, partialStreamState)) {
					return
				}
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
			}

			// Create parent directories early for new files to prevent ENOENT errors
			// in subsequent operations (e.g., diffViewProvider.open)
			if (!fileExists) {
				await createDirectoriesForFile(absolutePath)
			}
			// Abandonment can land while the directory creation is in flight: its teardown has
			// already released this task's stream state, and asking or streaming now would show a
			// partial tool call for a task that no longer exists.
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

			if (!this.isPartialStreamStillLive(task, partialStreamState)) {
			return
		}

		} catch (error) {
			// Unexpected failure in the pre-streaming setup (provider state, the filesystem probe,
			// directory creation, the partial ask): this delta never reaches execute(), so nothing
			// else releases what the registration acquired - and a diff view may already be open with
			// unapproved content. Tear this task's entry and its TaskAborted listener down, close the
			// view if one is open, then rethrow so BaseTool.handle() still reports the error once.
			this.releasePartialStreamBookkeeping(task)
			if (task.diffViewProvider.isEditing) {
				await this.revertDiffChangesBeforeReset(task)
				await this.resetDiffViewAfterWrite(task)
			}
			throw error
		}

		if (newContent) {
			if (!task.diffViewProvider.isEditing) {
				await task.diffViewProvider.open(relPath!)
			}

			// Cancellation may land while open() is in flight: its abort handler has
			// already torn the stream down (and may have reverted or closed this very
			// diff view), so streaming the partial content into it now would resurrect a
			// view for a task that no longer exists.
			if (!this.isPartialStreamStillLive(task, partialStreamState)) {
				return
			}

			await task.diffViewProvider.update(
				everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
				false,
			)
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
