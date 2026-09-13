import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import { checkpointSave } from "../checkpoints"
import { checkAutoApproval } from "../auto-approval"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange } from "./apply-patch"

interface ApplyPatchParams {
	patch: string
}

/**
 * B2: result of a single file operation within a patch. `succeeded` controls
 * the whole-patch success state (and therefore the per-patch checkpoint),
 * while `wrote` records whether the operation actually wrote a file — a no-op
 * update must not produce a change-journal entry for a file that was never
 * written.
 */
interface ApplyPatchFileOpResult {
	succeeded: boolean
	wrote: boolean
}

export class ApplyPatchTool extends BaseTool<"apply_patch"> {
	readonly name = "apply_patch" as const

	private static readonly FILE_HEADER_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const

	private extractFirstPathFromPatch(patch: string | undefined): string | undefined {
		if (!patch) {
			return undefined
		}

		const lines = patch.split("\n")
		const hasTrailingNewline = patch.endsWith("\n")
		const completeLines = hasTrailingNewline ? lines : lines.slice(0, -1)

		for (const rawLine of completeLines) {
			const line = rawLine.trim()

			for (const marker of ApplyPatchTool.FILE_HEADER_MARKERS) {
				if (!line.startsWith(marker)) {
					continue
				}

				const candidatePath = line.substring(marker.length).trim()
				if (candidatePath.length > 0) {
					return candidatePath
				}
			}
		}

		return undefined
	}

	async execute(params: ApplyPatchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { patch } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!patch) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_patch", "patch"))
				return
			}

			// Parse the patch
			let parsedPatch
			try {
				parsedPatch = parsePatch(patch)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage =
					error instanceof ParseError
						? `Invalid patch format: ${error.message}`
						: `Failed to parse patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			if (parsedPatch.hunks.length === 0) {
				pushToolResult("No file operations found in patch.")
				return
			}

			// Process each hunk
			const readFile = async (filePath: string): Promise<string> => {
				const absolutePath = path.resolve(task.cwd, filePath)
				return await fs.readFile(absolutePath, "utf8")
			}

			let changes: ApplyPatchFileChange[]
			try {
				changes = await processAllHunks(parsedPatch.hunks, readFile)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Failed to process patch: ${error instanceof Error ? error.message : String(error)}`
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			// Process each file change. The handlers report whether their file
			// operation succeeded (which controls the whole-patch checkpoint) and
			// whether it actually wrote a file (which controls the change journal
			// — a no-op update must not be journaled). A rejected approval or a
			// failed local write never gets checkpointed as a success.
			let patchSucceeded = true
			const successfulChanges: ApplyPatchFileChange[] = []
			for (const change of changes) {
				const relPath = change.path
				const absolutePath = path.resolve(task.cwd, relPath)

				// Check access permissions
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					pushToolResult(formatResponse.rooIgnoreError(relPath))
					// B2 partial flush: break, not return - an earlier hunk may have
					// already written a file, and those writes must still receive the
					// checkpoint, journal entry, and change card. Failing the patch
					// also keeps the consecutive-mistake counter from resetting.
					patchSucceeded = false
					break
				}

				// Check if file is write-protected
				const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

				if (change.type === "add") {
					// Create new file
					const addResult = await this.handleAddFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
					patchSucceeded = addResult.succeeded && patchSucceeded
					if (addResult.wrote) {
						successfulChanges.push(change)
					}
				} else if (change.type === "delete") {
					// Delete file
					const deleteResult = await this.handleDeleteFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
					patchSucceeded = deleteResult.succeeded && patchSucceeded
					if (deleteResult.wrote) {
						successfulChanges.push(change)
					}
				} else if (change.type === "update") {
					// Update file (a no-op update succeeds without writing)
					const updateResult = await this.handleUpdateFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
					patchSucceeded = updateResult.succeeded && patchSucceeded
					if (updateResult.wrote) {
						successfulChanges.push(change)
					}
				}
			}

			// Reset the consecutive-mistake counter only after a fully successful
			// patch: a failed operation (missing file, rejected move, ...) increments
			// the counter, and the count must survive a partially written patch so
			// the auto-approval safety net still engages across consecutive failed
			// patches.
			if (patchSucceeded) {
				task.consecutiveMistakeCount = 0
			}

			// B1: one checkpoint for the whole patch (not per file). Live
			// setting with default-on semantics: skip only when explicitly false.
			// B3a partial flush: the checkpoint and journal are also taken when at
			// least one file operation wrote, even if a later hunk of the same
			// patch failed - the journal then documents exactly the subset that
			// was written, and the failed operation was already reported through
			// pushToolResult. A fully failed patch (nothing written) leaves no
			// checkpoint behind.
			if (patchSucceeded || successfulChanges.length > 0) {
				const perWriteCheckpoints = (await task.providerRef?.deref()?.getState())?.perWriteCheckpoints
				if (perWriteCheckpoints !== false) {
					// B2: one journal entry per file that was actually written by
					// the patch (the simplest correct design for multi-file patches),
					// all referencing the single checkpoint above. A no-op update
					// contributes no entry because nothing was written. `movePath`,
					// when present, is the file's final location. B3a: the per-file
					// approval diff/stats and auto-approval state, retained by the
					// handlers, feed the per-step change card.
					// Awaited: a later write must not interleave with this patch's
					// staging/commit/journal/change-card work. checkpointSave never
					// rejects (service call wrapped in try/catch upstream).
					await checkpointSave(
						task,
						false,
						true,
						successfulChanges.map((change) => ({
							path: change.movePath ?? change.path,
							operation: change.type === "add" ? "create" : change.type,
							...(change.diffStats
								? {
										diffStats: {
											additions: change.diffStats.added,
											deletions: change.diffStats.removed,
										},
									}
								: {}),
							...(change.diff ? { diff: change.diff } : {}),
							...(change.autoApproved ? { autoApproved: true } : {}),
						})),
					)
				}
			}
		} catch (error) {
			await handleError("apply patch", error as Error)
			await task.diffViewProvider.reset()
		}
	}

	private async handleAddFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchFileOpResult> {
		const { askApproval, pushToolResult } = callbacks

		// Check if file already exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File already exists: ${relPath}. Use Update File instead.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { succeeded: false, wrote: false }
		}

		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		// Initialize diff view for new file
		task.diffViewProvider.editType = "create"
		task.diffViewProvider.originalContent = undefined

		const diff = formatResponse.createPrettyPatch(relPath, "", newContent)

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const sanitizedDiff = sanitizeUnifiedDiff(diff || "")
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: sanitizedDiff,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: sanitizedDiff,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// B3a: retain the approval diff/stats and auto-approval state so the
		// post-loop checkpoint hook can build the per-step change card.
		change.diff = sanitizedDiff
		change.diffStats = diffStats
		change.autoApproved =
			(
				await checkAutoApproval({
					state,
					cwd: task.cwd,
					ask: "tool",
					text: completeMessage,
					isProtected: isWriteProtected,
				})
			).decision === "approve"

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			pushToolResult("Changes were rejected by the user.")
			await task.diffViewProvider.reset()
			return { succeeded: false, wrote: false }
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.saveDirectly(relPath, newContent, true, diagnosticsEnabled, writeDelayMs)
		} else {
			await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
		return { succeeded: true, wrote: true }
	}

	private async handleDeleteFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchFileOpResult> {
		const { askApproval, pushToolResult } = callbacks

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot delete a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { succeeded: false, wrote: false }
		}

		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: `File will be deleted: ${relPath}`,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: `Delete file: ${relPath}`,
			isProtected: isWriteProtected,
		} satisfies ClineSayTool)

		// B3a: auto-approval state feeds the per-step change card (deletes have
		// no diff to thread).
		change.autoApproved =
			(
				await checkAutoApproval({
					state: await task.providerRef.deref()?.getState(),
					cwd: task.cwd,
					ask: "tool",
					text: completeMessage,
					isProtected: isWriteProtected,
				})
			).decision === "approve"

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			pushToolResult("Delete operation was rejected by the user.")
			return { succeeded: false, wrote: false }
		}

		// Delete the file
		try {
			await fs.unlink(absolutePath)
		} catch (error) {
			const errorMessage = `Failed to delete file '${relPath}': ${error instanceof Error ? error.message : String(error)}`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { succeeded: false, wrote: false }
		}

		task.didEditFile = true
		pushToolResult(`Successfully deleted ${relPath}`)
		task.processQueuedMessages()
		return { succeeded: true, wrote: true }
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<ApplyPatchFileOpResult> {
		const { askApproval, pushToolResult } = callbacks

		// A move reports failure when the original file cannot be deleted
		// after the copy (both paths would remain on disk).
		let moveSucceeded = true

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot update a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { succeeded: false, wrote: false }
		}

		const originalContent = change.originalContent || ""
		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		// Initialize diff view
		task.diffViewProvider.editType = "modify"
		task.diffViewProvider.originalContent = originalContent

		// Generate and validate diff
		const diff = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
		if (!diff) {
			// A no-op change is not a failure: the patch processed cleanly and
			// nothing was written, so the whole-patch success state is kept —
			// but `wrote` stays false so the change journal does not document a
			// write that never happened.
			pushToolResult(`No changes needed for '${relPath}'`)
			await task.diffViewProvider.reset()
			return { succeeded: true, wrote: false }
		}

		// Check experiment settings
		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
		const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		const sanitizedDiff = sanitizeUnifiedDiff(diff)
		const diffStats = computeDiffStats(sanitizedDiff) || undefined

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: sanitizedDiff,
			originalContent,
			isOutsideWorkspace,
		}

		const completeMessage = JSON.stringify({
			...sharedMessageProps,
			content: sanitizedDiff,
			isProtected: isWriteProtected,
			diffStats,
		} satisfies ClineSayTool)

		// B3a: retain the approval diff/stats and auto-approval state so the
		// post-loop checkpoint hook can build the per-step change card.
		change.diff = sanitizedDiff
		change.diffStats = diffStats
		change.autoApproved =
			(
				await checkAutoApproval({
					state,
					cwd: task.cwd,
					ask: "tool",
					text: completeMessage,
					isProtected: isWriteProtected,
				})
			).decision === "approve"

		// Show diff view if focus disruption prevention is disabled
		if (!isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.open(relPath)
			await task.diffViewProvider.update(newContent, true)
			task.diffViewProvider.scrollToFirstDiff()
		}

		const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

		if (!didApprove) {
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.revertChanges()
			}
			pushToolResult("Changes were rejected by the user.")
			await task.diffViewProvider.reset()
			return { succeeded: false, wrote: false }
		}

		// Handle file move if specified
		if (change.movePath) {
			const moveAbsolutePath = path.resolve(task.cwd, change.movePath)

			// Validate destination path access permissions
			const moveAccessAllowed = task.rooIgnoreController?.validateAccess(change.movePath)
			if (!moveAccessAllowed) {
				await task.say("rooignore_error", change.movePath)
				pushToolResult(formatResponse.rooIgnoreError(change.movePath))
				await task.diffViewProvider.reset()
				return { succeeded: false, wrote: false }
			}

			// Check if destination path is write-protected
			const isMovePathWriteProtected = task.rooProtectedController?.isWriteProtected(change.movePath) || false
			if (isMovePathWriteProtected) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to write-protected path: ${change.movePath}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return { succeeded: false, wrote: false }
			}

			// Check if destination path is outside workspace
			const isMoveOutsideWorkspace = isPathOutsideWorkspace(moveAbsolutePath)
			if (isMoveOutsideWorkspace) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to path outside workspace: ${change.movePath}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return { succeeded: false, wrote: false }
			}

			// Save new content to the new path
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(
					change.movePath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				// Write to new path and delete old file
				const parentDir = path.dirname(moveAbsolutePath)
				await fs.mkdir(parentDir, { recursive: true })
				await fs.writeFile(moveAbsolutePath, newContent, "utf8")
			}

			// Delete the original file. A failed deletion leaves both paths on
			// disk, so the move must be reported as a failure rather than
			// checkpointed and journaled as a completed move.
			try {
				await fs.unlink(absolutePath)
			} catch (error) {
				moveSucceeded = false
				console.error(`Failed to delete original file after move: ${error}`)
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Move of '${relPath}' to '${change.movePath}' failed: could not delete the original file.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
			}

			await task.fileContextTracker.trackFileContext(change.movePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
		if (!moveSucceeded) {
			// The destination file was written on disk before the source
			// deletion failed, so the write must still be checkpointed and
			// journaled; the move itself is reported as failed.
			return { succeeded: false, wrote: true }
		}
		return { succeeded: true, wrote: true }
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_patch">): Promise<void> {
		const patch: string | undefined = block.params.patch
		const candidateRelPath = this.extractFirstPathFromPatch(patch)
		const fallbackDisplayPath = path.basename(task.cwd) || "workspace"
		const resolvedRelPath = candidateRelPath ?? ""
		const absolutePath = path.resolve(task.cwd, resolvedRelPath)
		const displayPath = candidateRelPath ? getReadablePath(task.cwd, candidateRelPath) : fallbackDisplayPath

		let patchPreview: string | undefined
		if (patch) {
			// Show first few lines of the patch
			const lines = patch.split("\n").slice(0, 5)
			patchPreview = lines.join("\n") + (patch.split("\n").length > 5 ? "\n..." : "")
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: displayPath || path.basename(task.cwd) || "workspace",
			diff: patchPreview || "Parsing patch...",
			isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const applyPatchTool = new ApplyPatchTool()
