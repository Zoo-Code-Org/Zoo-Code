import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import { checkpointSave } from "../checkpoints"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats, type DiffStats } from "../diff/stats"
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
 * written. `diffStats` carries the approval-diff statistics of a written file
 * so the journal entry can report the size of the change.
 */
interface ApplyPatchFileOpResult {
	succeeded: boolean
	wrote: boolean
	diffStats?: DiffStats
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
		const { handleError, pushToolResult } = callbacks

		// Set once the success-path flush actually proceeds to checkpointSave, so
		// the catch below does not persist the same writes twice while a
		// settings-read rejection before that decision leaves the catch flush
		// armed with default-on semantics.
		let writeMetadataFlushed = false
		// Cached perWriteCheckpoints lookup shared by the success-path flush and
		// the catch flush: the catch must not call getState() again, because a
		// rejecting settings read must not skip persisting writes already on disk.
		let perWriteCheckpoints: boolean | undefined
		const successfulChanges: { change: ApplyPatchFileChange; diffStats?: DiffStats }[] = []
		// Journal payload builder shared by the success-path flush and the
		// catch-path flush for writes recorded before an unexpected throw.
		const journalEntries = () =>
			successfulChanges.flatMap(({ change, diffStats }) => {
				const written = {
					path: change.movePath ?? change.path,
					operation: change.type === "add" ? ("create" as const) : change.type,
					diffStats: diffStats ? { additions: diffStats.added, deletions: diffStats.removed } : undefined,
				}
				// A completed move also DELETES its source: journal that deletion
				// after the destination write so a step rollback restores the
				// removed file from its pre-step state. A move whose source unlink
				// failed left the source on disk and gets no deletion entry.
				if (change.movePath && change.moveSourceDeleted) {
					return [written, { path: change.path, operation: "delete" as const, diffStats: undefined }]
				}
				return [written]
			})

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
			// operation succeeded (which controls the whole-patch checkpoint); each
			// write is recorded through the onWrote callback at the moment it lands
			// on disk, so a throw from post-write bookkeeping cannot lose the
			// journal entry for a completed write (a no-op update never calls the
			// callback). A rejected approval or a failed local write never gets
			// checkpointed as a success.
			let patchSucceeded = true
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
						(diffStats) => successfulChanges.push({ change, diffStats }),
					)
					patchSucceeded = addResult.succeeded && patchSucceeded
				} else if (change.type === "delete") {
					// Delete file
					const deleteResult = await this.handleDeleteFile(
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						() => successfulChanges.push({ change }),
					)
					patchSucceeded = deleteResult.succeeded && patchSucceeded
				} else if (change.type === "update") {
					// Update file (a no-op update succeeds without writing)
					const updateResult = await this.handleUpdateFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						(diffStats) => successfulChanges.push({ change, diffStats }),
					)
					patchSucceeded = updateResult.succeeded && patchSucceeded
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
				perWriteCheckpoints = (await task.providerRef?.deref()?.getState())?.perWriteCheckpoints
				if (perWriteCheckpoints !== false) {
					writeMetadataFlushed = true
					// B2: one journal entry per file that was actually written by
					// the patch (the simplest correct design for multi-file patches),
					// all referencing the single checkpoint above. A no-op update
					// contributes no entry because nothing was written. `movePath`,
					// when present, is the file's final location, and a completed move
					// additionally journals its source deletion. Each entry carries the
					// approval-diff statistics the handler computed.
					// Await so the checkpoint (staging + commit + journal)
					// completes before queued messages are processed below;
					// otherwise a queued write's own checkpoint could interleave
					// with this commit.
					await checkpointSave(task, false, true, journalEntries()).catch(() => {})
				}
			}

			// B2: deferred from the per-file handlers — a queued write must not
			// start until the post-patch checkpoint above has persisted. The
			// handlers used to process queued messages right after each
			// successful write; a write happened if and only if
			// `successfulChanges` is non-empty, so one call here preserves that.
			if (successfulChanges.length > 0) {
				task.processQueuedMessages()
			}
		} catch (error) {
			// A handler that throws after recording its write (post-write
			// bookkeeping such as trackFileContext) skips the success-path flush
			// above. Persist the accumulated write metadata here, awaited, before
			// the generic error handling: the writes are on disk and the journal
			// must document them. A flush that already ran (or was skipped by the
			// setting) is not attempted twice.
			let reportedError: unknown = error
			if (!writeMetadataFlushed && successfulChanges.length > 0) {
				if (perWriteCheckpoints !== false) {
					let flushError: unknown
					await checkpointSave(task, false, true, journalEntries()).catch((flushFailure) => {
						flushError = flushFailure
					})
					if (flushError !== undefined) {
						// The completed write lacks rollback metadata: report the
						// persistence failure alongside the bookkeeping error without
						// replacing it as the reported failure.
						const flushMessage = flushError instanceof Error ? flushError.message : String(flushError)
						const baseMessage = error instanceof Error ? error.message : String(error)
						console.error("[ApplyPatchTool] catch-path checkpoint flush failed:", flushError)
						reportedError = new Error(`${baseMessage} (checkpoint flush also failed: ${flushMessage})`, {
							cause: error,
						})
					}
				}
			}
			await handleError("apply patch", reportedError as Error)
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
		onWrote?: (diffStats?: DiffStats) => void,
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

		// Record the completed write before post-write bookkeeping can fail:
		// a throw from trackFileContext must not lose the journal entry for
		// a file that is already on disk.
		onWrote?.(diffStats)

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		// B2: processQueuedMessages is deferred to execute()'s post-patch hook
		// so it runs only after the post-patch checkpoint has completed.
		return { succeeded: true, wrote: true, diffStats }
	}

	private async handleDeleteFile(
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		onWrote?: () => void,
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

		// The deletion is complete; record it before the result handoff can fail.
		onWrote?.()

		task.didEditFile = true
		pushToolResult(`Successfully deleted ${relPath}`)
		// B2: processQueuedMessages is deferred to execute()'s post-patch hook
		// so it runs only after the post-patch checkpoint has completed.
		return { succeeded: true, wrote: true }
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		onWrote?: (diffStats?: DiffStats) => void,
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
				change.moveSourceDeleted = true
			} catch (error) {
				moveSucceeded = false
				console.error(`Failed to delete original file after move: ${error}`)
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Move of '${relPath}' to '${change.movePath}' failed: could not delete the original file.`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
			}

			// The destination write is on disk whether or not the source unlink
			// succeeded; record it before bookkeeping can fail.
			onWrote?.(diffStats)

			await task.fileContextTracker.trackFileContext(change.movePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Record the completed write before post-write bookkeeping can fail.
			onWrote?.(diffStats)

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		// B2: processQueuedMessages is deferred to execute()'s post-patch hook
		// so it runs only after the post-patch checkpoint has completed.
		if (!moveSucceeded) {
			// The destination file was written on disk before the source
			// deletion failed, so the write must still be checkpointed and
			// journaled; the move itself is reported as failed.
			return { succeeded: false, wrote: true, diffStats }
		}
		return { succeeded: true, wrote: true, diffStats }
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
