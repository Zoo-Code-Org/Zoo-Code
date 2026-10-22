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
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange } from "./apply-patch"

interface ApplyPatchParams {
	patch: string
}

/** Result of one file operation: `mutated` is true when the workspace changed even if the operation eventually failed. */
type PatchFileResult = { ok: boolean; mutated: boolean }

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

		// The queued-message handoff is deferred to the finally block below, after
		// the whole-patch checkpoint attempt: a handler that hands off early lets a
		// queued turn start while the checkpoint is still staging or committing.

		let handoffPending = false

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
			// operation succeeded, so a rejected approval or a failed local write
			// does not get checkpointed as if the patch had succeeded.
			let patchSucceeded = true
			for (const change of changes) {
				const relPath = change.path
				const absolutePath = path.resolve(task.cwd, relPath)

				// Check access permissions
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					pushToolResult(formatResponse.rooIgnoreError(relPath))
					// Partial failure: earlier successful writes are retained; break so the
					// explicit partial-state checkpoint below persists them before the
					// queued-message handoff in the finally block.
					patchSucceeded = false
					break
				}

				// Check if file is write-protected
				const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

				if (change.type === "add") {
					// Create new file
					const result = await this.handleAddFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
					handoffPending = handoffPending || result.mutated
					patchSucceeded = result.ok && patchSucceeded
				} else if (change.type === "delete") {
					// Delete file
					const result = await this.handleDeleteFile(absolutePath, relPath, task, callbacks, isWriteProtected)
					handoffPending = handoffPending || result.mutated
					patchSucceeded = result.ok && patchSucceeded
				} else if (change.type === "update") {
					// Update file
					const result = await this.handleUpdateFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
					)
					handoffPending = handoffPending || result.mutated
					patchSucceeded = result.ok && patchSucceeded
				}
			}

			task.consecutiveMistakeCount = 0

			// B1: one checkpoint for the whole patch (not per file), and only when
			// every file operation succeeded. Live setting with default-on
			// semantics: skip only when explicitly false.
			if (patchSucceeded) {
				const perWriteCheckpoints = (await task.providerRef?.deref()?.getState())?.perWriteCheckpoints
				if (perWriteCheckpoints !== false) {
					// Await so the whole-patch checkpoint persists before the tool
					// completes; an unawaited save lets queued work interleave its own
					// checkpoint and lets shutdown lose the commit. Called only after
					// every filesystem operation succeeded.
					await checkpointSave(task, false, true).catch(() => {})
				}
			} else if (handoffPending) {
				// Partial failure: the earlier successful operations keep their writes
				// in the workspace. Persist an explicit partial-state checkpoint before
				// the queued-message handoff (the finally block below) so those retained
				// writes have rollback metadata instead of being carried forward
				// unpersisted; the failed operation already reported itself.
				const perWriteCheckpoints = (await task.providerRef?.deref()?.getState())?.perWriteCheckpoints
				if (perWriteCheckpoints !== false) {
					await checkpointSave(task, false, true).catch(() => {})
				}
			}
		} catch (error) {
			// A later file operation can reject outright (e.g. the approval
			// stream dies) after earlier handlers succeeded. This catch skips
			// both checkpoint branches above, but the finally block still
			// hands off queued messages, so persist an explicit partial-state
			// checkpoint here (same default-on semantics as the branches
			// above) instead of letting the queued turn start with the
			// retained writes carried forward without rollback metadata.
			if (handoffPending) {
				const perWriteCheckpoints = (await task.providerRef?.deref()?.getState())?.perWriteCheckpoints
				if (perWriteCheckpoints !== false) {
					await checkpointSave(task, false, true).catch(() => {})
				}
			}
			await handleError("apply patch", error as Error)
			await task.diffViewProvider.reset()
		} finally {
			// One handoff per successful patch, after the checkpoint attempt and
			// independent of the checkpoint setting or outcome: a queued turn can
			// never start while the patch checkpoint is still staging or
			// committing, and no path (disabled checkpoints, failed save, early
			// return, error) strands the queued messages.
			if (handoffPending) {
				task.processQueuedMessages()
			}
		}
	}

	private async handleAddFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<PatchFileResult> {
		const { askApproval, pushToolResult } = callbacks
		let mutated = false

		// Check if file already exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File already exists: ${relPath}. Use Update File instead.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { ok: false, mutated }
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
			return { ok: false, mutated }
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			await task.diffViewProvider.saveDirectly(relPath, newContent, true, diagnosticsEnabled, writeDelayMs)
		} else {
			await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		mutated = true
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		return { ok: true, mutated }
	}

	private async handleDeleteFile(
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<PatchFileResult> {
		const { askApproval, pushToolResult } = callbacks
		let mutated = false

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot delete a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { ok: false, mutated }
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
			return { ok: false, mutated }
		}

		// Delete the file
		try {
			await fs.unlink(absolutePath)
		} catch (error) {
			const errorMessage = `Failed to delete file '${relPath}': ${error instanceof Error ? error.message : String(error)}`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { ok: false, mutated }
		}

		mutated = true
		task.didEditFile = true
		pushToolResult(`Successfully deleted ${relPath}`)
		return { ok: true, mutated }
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
	): Promise<PatchFileResult> {
		const { askApproval, pushToolResult } = callbacks
		let mutated = false

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot update a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return { ok: false, mutated }
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
			// nothing was written, so the whole-patch success state is kept.
			pushToolResult(`No changes needed for '${relPath}'`)
			await task.diffViewProvider.reset()
			return { ok: true, mutated }
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
			return { ok: false, mutated }
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
				return { ok: false, mutated }
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
				return { ok: false, mutated }
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
				return { ok: false, mutated }
			}

			// Capture the destination state before either supported write path: a
			// failed move must restore an existing destination instead of deleting
			// whatever lived there. A read error other than ENOENT means the
			// destination cannot be inspected, so the move is refused before any
			// write rather than risking an unrecoverable clobber.
			let destinationBackup: Buffer | undefined
			try {
				destinationBackup = await fs.readFile(moveAbsolutePath)
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code !== "ENOENT") {
					task.consecutiveMistakeCount++
					task.recordToolError("apply_patch")
					const inspectErrorMessage = `Cannot inspect move destination '${change.movePath}': ${error instanceof Error ? error.message : String(error)}`
					await task.say("error", inspectErrorMessage)
					pushToolResult(formatResponse.toolError(inspectErrorMessage))
					await task.diffViewProvider.reset()
					return { ok: false, mutated }
				}
			}

			// Capture the destination mode before replacing it: the atomic staging write
			// would otherwise install the process-default permissions and widen a 0600
			// or executable destination.
			let destinationMode: number | undefined
			if (destinationBackup !== undefined) {
				destinationMode = await fs.stat(moveAbsolutePath).then(
					(stat) => stat.mode,
					() => undefined,
				)
			}

			// Stage the move so it is all-or-nothing: the pre-move destination bytes
			// stay on disk under a backup name, the new content is written to a
			// staging file and renamed into place atomically, and only then is the
			// source unlinked. Any failure renames the backup back, so the workspace
			// never shows a half-applied move.
			const moveStamp = `${process.pid}.${Date.now()}`
			const moveDir = path.dirname(moveAbsolutePath)
			const moveBase = path.basename(moveAbsolutePath)
			const stagingPath = path.join(moveDir, `.${moveBase}.${moveStamp}.staging`)
			const backupPath = path.join(moveDir, `.${moveBase}.${moveStamp}.backup`)
			await fs.mkdir(moveDir, { recursive: true })

			let destinationCommitted = false
			try {
				// Owner-only from creation: the staged content must never be readable by
				// others, even between the write and the rename.
				await fs.writeFile(stagingPath, newContent, { encoding: "utf8", mode: 0o600 })
				if (destinationMode !== undefined) {
					await fs.chmod(stagingPath, destinationMode)
				}
				if (destinationBackup !== undefined) {
					// Preserve the pre-move bytes on disk (atomic rename): the in-memory
					// copy alone cannot restore the destination after a crash.
					await fs.rename(moveAbsolutePath, backupPath)
				}
				await fs.rename(stagingPath, moveAbsolutePath)
				destinationCommitted = true
				// The destination content changed: even a later failed source unlink (which
				// rolls the destination back) is a workspace mutation the checkpoint must see.
				mutated = true
				if (isPreventFocusDisruptionEnabled) {
					// Diagnostics/bookkeeping only: the bytes were committed above, and
					// saveDirectly writes the same content through the same atomic write.
					await task.diffViewProvider.saveDirectly(
						change.movePath,
						newContent,
						false,
						diagnosticsEnabled,
						writeDelayMs,
					)
				}
			} catch (writeError) {
				await fs.rm(stagingPath, { force: true }).catch(() => {})
				if (destinationCommitted) {
					await fs.rm(moveAbsolutePath, { force: true }).catch(() => {})
				}
				if (destinationBackup !== undefined) {
					await fs.rename(backupPath, moveAbsolutePath).catch(() => {})
				}
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const writeErrorMessage = `Failed to write move destination '${change.movePath}': ${writeError instanceof Error ? writeError.message : String(writeError)}`
				await task.say("error", writeErrorMessage)
				pushToolResult(formatResponse.toolError(writeErrorMessage))
				await task.diffViewProvider.reset()
				return { ok: false, mutated }
			}

			// Delete the original file
			try {
				await fs.unlink(absolutePath)
			} catch (error) {
				// The source is still present (locked or protected): undo the destination
				// so the file does not live in two places, and report the move as
				// failed. Returning true here would let the whole-patch checkpoint persist
				// a duplicated file as if the move had succeeded.
				let restoreFailure: unknown
				let recoveryPath: string | undefined
				try {
					if (destinationBackup !== undefined) {
						// Atomic restore of the captured destination bytes: the rename
						// replaces the clobbered destination in one step, so there is no
						// window where the file is missing.
						await fs.rename(backupPath, moveAbsolutePath)
					} else {
						await fs.rm(moveAbsolutePath, { force: true })
					}
				} catch (restoreError) {
					restoreFailure = restoreError
				}
				if (restoreFailure !== undefined) {
					if (destinationBackup !== undefined) {
						// The original destination bytes are still on disk under the backup
						// name: keep them as the recovery artifact and report where they are.
						// Writing a copy of the approved new content here would hide the
						// original content that this branch is supposed to preserve.
						console.error(
							`Failed to restore pre-move state: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}; the original content is preserved at ${backupPath}`,
						)
					} else {
						// There was no pre-existing destination, so the approved content is
						// the only thing that could be lost: persist it under a recovery name.
						const recoveryCandidate = path.join(moveDir, `${moveBase}.zoo-recovery-${moveStamp}`)
						try {
							await fs.writeFile(recoveryCandidate, newContent, "utf8")
							recoveryPath = recoveryCandidate
							console.error(
								`Failed to restore pre-move state: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}; kept the approved content at ${recoveryCandidate}`,
							)
						} catch (recoveryError) {
							console.error(`Failed to persist a move recovery copy: ${recoveryError}`)
						}
					}
				}
				// Best-effort cleanup of the staging file; the backup is gone once the
				// restore rename committed (or is the only copy left on failure).
				await fs.rm(stagingPath, { force: true }).catch(() => {})
				const restoreSuffix =
					restoreFailure === undefined
						? ""
						: ` The destination could not be restored and may still contain the new content: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}`
				const recoverySuffix =
					destinationBackup !== undefined && restoreFailure !== undefined && recoveryPath === undefined
						? ` The original content is preserved at '${getReadablePath(task.cwd, path.relative(task.cwd, backupPath))}'.`
						: recoveryPath === undefined
							? ""
							: ` The approved new content was kept at '${getReadablePath(task.cwd, path.relative(task.cwd, recoveryPath))}'.`
				const moveErrorMessage = `Failed to delete original file after move '${relPath}': ${error instanceof Error ? error.message : String(error)}${restoreSuffix}${recoverySuffix}`
				await task.say("error", moveErrorMessage)
				pushToolResult(formatResponse.toolError(moveErrorMessage))
				await task.diffViewProvider.reset()
				return { ok: false, mutated }
			}

			// The move committed: drop the destination backup.
			await fs.rm(backupPath, { force: true }).catch(() => {})

			await task.fileContextTracker.trackFileContext(change.movePath, "roo_edited" as RecordSource)
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			mutated = true
			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		return { ok: true, mutated }
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
