import path from "path"
import delay from "delay"
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
	 * is open. Failures are logged and swallowed so the remaining cleanup (reset,
	 * per-task state teardown) always continues.
	 */
	private async revertDiffChangesBeforeReset(task: Task): Promise<void> {
		await task.diffViewProvider.revertChanges().catch((revertError) => {
			console.error("Error reverting write_to_file diff view changes:", revertError)
		})
	}

	private async finalizePartialToolAskAfterFailure(task: Task, text?: string): Promise<void> {
		await task.finalizePartialToolAsk(text).catch((finalizeError) => {
			console.error("Error finalizing write_to_file partial tool ask:", finalizeError)
		})
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
			await this.revertDiffChangesBeforeReset(task)
			await this.resetDiffViewAfterWrite(task)
			this.resetTaskPartialState(task)
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			await this.revertDiffChangesBeforeReset(task)
			await this.resetDiffViewAfterWrite(task)
			this.resetTaskPartialState(task)
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			// handlePartial() has no rooignore guard, so streaming deltas for this denied
			// path may already have created a partial `tool` ask (partial: true) and opened
			// the diff view before execute() reached the access check. Denying here without
			// cleanup would leave the UI spinner stuck (partial: true), the diff view open
			// with the denied content still dirty in the editor, and this task's per-task
			// stream state leaked. Perform the same cleanup the try/finally path does
			// before returning.
			await this.finalizePartialToolAskAfterFailure(task)
			// The write was denied before approval: restore the document so a user save
			// cannot persist the streamed content.
			await this.revertDiffChangesBeforeReset(task)
			await this.resetDiffViewAfterWrite(task)
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

				await delay(300)
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
			await handleError("writing file", error as Error)
			// Before approval the diff document holds unapproved streamed content: restore it
			// so a user save cannot persist it. After approval the content is the user's
			// accepted edit -- keep it in the editor (dirty) so they can save it manually.
			if (!writeApproved) {
				await this.revertDiffChangesBeforeReset(task)
			}
			await this.resetDiffViewAfterWrite(task)
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
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		if (isPreventFocusDisruptionEnabled) {
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
				// partial tool message each time.
				partialStreamState.streamFailed = true
				await this.finalizePartialToolAskAfterFailure(task, partialMessage)
				// The write was never approved: restore the document so a user save cannot
				// persist the failed streamed content (reset() alone leaves it dirty).
				await this.revertDiffChangesBeforeReset(task)
				await this.resetDiffViewAfterWrite(task)
			}
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
