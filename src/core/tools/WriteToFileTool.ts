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

	/**
	 * Release what a streamed write left behind when the presenter rejects the COMPLETED
	 * block before the tool ever runs.
	 *
	 * Streaming is not gated by the checks that guard execution: a partial delta registers
	 * this task's entry (and its TaskAborted listener) and may open a preview, then
	 * validateToolUse() throws for the completed block - a mode restriction, a disabled
	 * tool - or the repetition guard refuses it, and the loop breaks before
	 * writeToFileTool.handle() is reached. None of execute()'s teardown, the parse-failure
	 * hook, or clearTaskState() runs on that path, so the task would keep the listener, the
	 * map entry, a preview holding content nobody was asked to approve, and the directories
	 * that preview created; a retained streamFailed also suppresses this task's later
	 * previews.
	 *
	 * Resources only: the validation error is the tool result the model sees, so nothing is
	 * reported here beyond a failed rollback, which is a hazard the user - not the model -
	 * has to know about. A no-op for every task that never streamed.
	 */
	async releaseStreamAfterValidationRejection(task: Task): Promise<void> {
		if (!this.taskPartialStreamState.has(this.getPartialStreamFailureKey(task))) {
			return
		}

		this.releasePartialStreamBookkeeping(task)
		const rollbackError = await this.discardUnapprovedStreamBeforeReset(task)
		await this.resetDiffViewAfterWrite(task)
		if (rollbackError) {
			await task
				.say(
					"error",
					"write_to_file: the diff editor could not be restored after the tool call was rejected, so it may still show unapproved content. Do not save that editor.",
				)
				.catch((sayError) => {
					console.error("Error reporting write_to_file rollback failure:", sayError)
				})
		}
	}

	/**
	 * Drop the directories a delta created before the diff view took ownership.
	 *
	 * Only for a call that never reached open(): once a session is editing, the provider owns
	 * those directories and its own discard or revert removes them, so this must not reach
	 * past the delta that adopted them.
	 */
	private async releaseEarlyDirectories(task: Task): Promise<void> {
		if (task.diffViewProvider.isEditing) {
			return
		}
		await task.diffViewProvider.removeAdoptedDirectories()
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
	 * Release a diff view that holds content the user was never asked to approve, and close
	 * it.
	 *
	 * reset() clears the provider's state but leaves the diff document dirty with the streamed
	 * content; a user save would then persist a write the task never completed (denied or
	 * failed before approval). Must run BEFORE resetDiffViewAfterWrite(), since reset() clears
	 * the state the discard relies on. No-op when no diff view is open.
	 *
	 * Deliberately NOT revertChanges(): that path SAVES. For a new-file preview it writes the
	 * partial model output into the placeholder before deleting it, and for a modify it writes
	 * the restored original back to a file this stream never changed - so a failed save, or a
	 * failed delete after it, leaves bytes the user never approved on disk. The discard empties
	 * or restores the buffer in memory only.
	 *
	 * A discard failure is RETURNED rather than dropped: the caller records it as the failure
	 * this stream produced, so debris left on disk is reported instead of being silently
	 * continued past.
	 */
	private async discardUnapprovedStreamBeforeReset(task: Task): Promise<Error | undefined> {
		try {
			await task.diffViewProvider.discardUnapprovedStream()
		} catch (discardError) {
			console.error("Error discarding the unapproved write_to_file diff view:", discardError)
			return discardError instanceof Error ? discardError : new Error(String(discardError))
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
	protected override async releaseStreamStateOnParseFailure(task: Task, callbacks: ToolCallbacks): Promise<boolean> {
		const state = this.taskPartialStreamState.get(this.getPartialStreamFailureKey(task))
		if (!state) {
			return false
		}

		this.resetTaskPartialState(task)
		const rollbackError = await this.discardUnapprovedStreamBeforeReset(task)
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

		// Declared outside the setup boundary below: the write body's try block reads it after the
		// setup succeeded, and a block-scoped declaration would not be visible there.
		let fileExists: boolean
		let sharedMessageProps: ClineSayTool

		// The setup below awaits before the write's own try/catch begins. A rejection there (an
		// EACCES/EROFS from createDirectoriesForFile, a failing filesystem probe) would otherwise
		// escape execute() with this task's stream entry and its TaskAborted listener still
		// registered, so the map would keep the task alive and a later write could reuse a stale
		// stream state. Release and rethrow: BaseTool.handle() still reports the error exactly
		// once, and no diff view is open yet, so there is no preview to discard.
		try {
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

			sharedMessageProps = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(task.cwd, relPath),
				content: newContent,
				isOutsideWorkspace,
				isProtected: isWriteProtected,
			}
		} catch (error) {
			this.releasePartialStreamBookkeeping(task)
			throw error
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
			// A preview that never got its approved write to disk holds unapproved content: discard
			// it before reset() drops the state the discard depends on. This is also the teardown for
			// a saveChanges() that rejected mid-write - the placeholder is still owned by this edit,
			// because saveChanges() releases ownership only once the save lands - so the discard is
			// what removes the empty or half-written new file.
			if (task.diffViewProvider.isEditing) {
				const discardError = await this.discardUnapprovedStreamBeforeReset(task)
				if (discardError) {
					// The report must not own the teardown: Task.say() throws once the task is
					// aborted, and a rejection here would skip the reset() and the bookkeeping
					// release below - leaking exactly what this block exists to clean up.
					await task
						.say(
							"error",
							`write_to_file could not discard the unapproved preview after the failed write: ${discardError.message}`,
						)
						.catch((sayError) => {
							console.error("Error reporting write_to_file discard failure:", sayError)
						})
				}
			}
			// Guarded: a reset() that rejects must not skip the release below, and it must
			// not turn a reported write failure into a teardown failure the caller cannot act
			// on - the per-task entry and its TaskAborted listener are still ours to drop.
			await this.resetDiffViewAfterWrite(task)
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

		// A delta of THIS call already failed at the diff view. Retrying on every later delta
		// would re-open a diff editor that just failed and re-spawn a partial tool message for a
		// call that has already reported its error, so the rest of the stream is suppressed until
		// whichever teardown ends the call releases the entry.
		if (partialStreamState.streamFailed) {
			return
		}

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilizedForTask(partialStreamState, relPath) || newContent === undefined) {
			return
		}

		// Which failure window this delta is in, read by the catch below: false while the
		// pre-streaming setup runs, true from the moment the diff view is the thing at risk. Declared
		// outside the try because a try block's own scope is not visible to its catch.
		let diffViewStarted = false

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
				// Handed to the diff view's cleanup state at once, not at open(): open() records
				// only the directories it creates itself, which is none after this call, and every
				// teardown removes what that list holds.
				task.diffViewProvider.adoptCreatedDirectories(await createDirectoriesForFile(absolutePath))
			}
			// Abandonment can land while the directory creation is in flight: its teardown has
			// already released this task's stream state, and asking or streaming now would show a
			// partial tool call for a task that no longer exists.
			if (!this.isPartialStreamStillLive(task, partialStreamState)) {
				await this.releaseEarlyDirectories(task)
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
				await this.releaseEarlyDirectories(task)
				return
			}

			// From here the diff view is what can fail, and its failure has to be owned by this
			// boundary rather than escaping to BaseTool's generic catch, which reports the error but
			// releases nothing: the entry and its TaskAborted listener would stay attached and the
			// next delta would retry the operation that just failed.
			diffViewStarted = true

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
		} catch (error) {
			// Two windows, two owners of the teardown.
			//
			// * Pre-streaming setup (provider state, the filesystem probe, directory creation, the
			//   partial ask): nothing was shown and nothing of ours is on disk, so this call's entry
			//   is released - a later delta may legitimately retry a transient setup failure.
			// * The diff view (open()/update()): the preview itself is broken for this call. Releasing
			//   here would let the next delta re-register and re-open the view that just failed, which
			//   is the retry this boundary exists to stop, so the entry is kept and marked failed
			//   instead: the guard at the top of handlePartial suppresses the rest of the stream, and
			//   whichever teardown ends the call - the parse-failure boundary, which reports the
			//   recorded error, execute(), or a cancellation - releases it and its listener.
			//
			// Either way the unapproved preview is discarded and the view reset before the error is
			// rethrown, so BaseTool.handle() still reports it exactly once.
			if (diffViewStarted) {
				partialStreamState.streamFailed = true
				partialStreamState.streamError = error instanceof Error ? error : new Error(String(error))
			} else {
				this.releasePartialStreamBookkeeping(task)
				// The setup window owns whatever the diff view never took over, including the
				// directories this delta created a few lines above.
				await this.releaseEarlyDirectories(task)
			}
			if (task.diffViewProvider.isEditing) {
				const discardError = await this.discardUnapprovedStreamBeforeReset(task)
				await this.resetDiffViewAfterWrite(task)
				if (discardError) {
					// Two failures, two channels. The exception this delta produced stays the primary one:
					// BaseTool.handle() reports it unchanged, so wrapping it here would change the failure
					// the caller sees. The discard failure is a separate, actionable condition - the
					// placeholder or the created directories are still on disk and the buffer may still hold
					// unapproved content - so it gets its own report instead of only a console line.
					// A rejected report must not swallow the exception this delta produced: the
					// throw below is the caller's contract.
					await task
						.say(
							"error",
							`write_to_file could not discard the unapproved preview after the failed stream: ${discardError.message}`,
						)
						.catch((sayError) => {
							console.error("Error reporting write_to_file discard failure:", sayError)
						})
				}
			}
			throw error
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
