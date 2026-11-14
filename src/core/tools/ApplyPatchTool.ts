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
		// Committed-mutation tracker: a handler can commit a workspace write and then
		// reject during later bookkeeping, so the outer catch must still persist the
		// partial-state checkpoint. The flag is therefore owned here, outside the
		// handler-return boundary.
		const mutation = { committed: false }

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
						mutation,
					)
					handoffPending = handoffPending || result.mutated
					patchSucceeded = result.ok && patchSucceeded
				} else if (change.type === "delete") {
					// Delete file
					const result = await this.handleDeleteFile(
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						mutation,
					)
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
						mutation,
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
			if (handoffPending || mutation.committed) {
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
			if (handoffPending || mutation.committed) {
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
		mutation: { committed: boolean },
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

		// The write lands inside the save call below, which can still reject afterwards
		// (opening the document, collecting diagnostics) once the new file is on disk. The
		// mutation is therefore recorded at the write boundary: this handler never returns in
		// that case, and without the flag the retained file would hand off the queued turn
		// with no partial-state checkpoint (see the catch and finally in execute()).
		mutated = true
		mutation.committed = true
		try {
			if (isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.saveDirectly(relPath, newContent, true, diagnosticsEnabled, writeDelayMs)
			} else {
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}
		} catch (error) {
			// A save that failed before writing any bytes left no file behind, so the add did
			// not mutate the workspace after all and must not be checkpointed as a retained
			// write. Untrack it and let the outer error path report the failure.
			if (!(await fileExistsAtPath(absolutePath))) {
				mutated = false
				mutation.committed = false
			}
			throw error
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
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
		mutation: { committed: boolean },
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
		mutation.committed = true
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
		mutation: { committed: boolean },
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

			// Both refusals below report the way the destination checks above do: a counted mistake, a
			// recorded tool error, the message to the user and a diff-view reset. Hoisted so that a
			// link which fails inspection is refused exactly like a path that fails the workspace edge.
			const reportMoveRefusal = async (message: string): Promise<void> => {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				await task.say("error", message)
				pushToolResult(formatResponse.toolError(message))
				await task.diffViewProvider.reset()
			}

			// Resolve the destination through any symlink before anything is read, written or renamed.
			// The renames below move paths, so a destination symlink would be carried to the backup
			// name and replaced by a regular file at the requested path while its own target kept the
			// old bytes. The target is where the moved content has to land, and it is also the path
			// the access, protection and workspace checks have to see: a link is not a way to move
			// content past .rooignore, a write-protected path or the workspace edge.
			// A chain of links is walked to its last entry, so 8 hops stands for the longest
			// chain this move will follow. An entry that is still a link when the walk runs out of
			// hops is refused rather than written onto, because writing onto a link replaces it.
			const linkFollowLimit = 8
			let linkTargetPath: string | undefined
			try {
				const destinationShape = await fs.lstat(moveAbsolutePath)
				if (destinationShape.isSymbolicLink()) {
					// A link target is spelled relative to the directory holding the link. The chain is
					// walked to its last entry rather than read one hop, because the rename below acts
					// on the entry it is given: the entry whose spelling the write acts on is the entry
					// the decision has to be made about, and a chain whose last hop is a plain file
					// must not be decided from the first link while the checks below read a spelling
					// that resolves two steps further. A dangling final target leaves the last spelled
					// entry in place, which is what one hop leaves today.
					let linkEntry = moveAbsolutePath
					// Tracks whether the walk stopped because it reached a plain entry or because it
					// ran out of hops while the entry it stopped on is still a link.
					let chainEndsOnLink = true
					for (let hop = 0; hop < linkFollowLimit; hop++) {
						const rawTarget = await fs.readlink(linkEntry)
						const nextEntry = path.resolve(path.dirname(linkEntry), rawTarget)
						linkTargetPath = nextEntry
						const nextShape = await fs.lstat(nextEntry)
						if (!nextShape.isSymbolicLink()) {
							chainEndsOnLink = false
							break
						}
						linkEntry = nextEntry
					}
					if (chainEndsOnLink) {
						// Out of hops on an entry that is itself a link. The rename below would
						// replace that link with a regular file, which is the loss this walk exists to
						// prevent, only deeper in: the links beyond it would go on pointing at an
						// entry that no longer exists as a link. The move is refused with nothing
						// written and no path moved.
						await reportMoveRefusal(
							"Cannot move file to '" +
								change.movePath +
								"': the destination is a link " +
								"chain longer than " +
								String(linkFollowLimit) +
								" links, and its last link " +
								"would have been replaced by a regular file.",
						)
						return { ok: false, mutated }
					}
				}
			} catch (error) {
				// ENOENT, there is no destination at all. ENOTDIR, a parent is a file rather than a
				// directory. Neither has a link to preserve, so the destination keeps its requested
				// spelling and the checks above already covered it. Any other failure is a state this
				// move cannot describe, so it is refused the way the destination read below is refused.
				const shapeError = error as NodeJS.ErrnoException
				if (shapeError.code !== "ENOENT" && shapeError.code !== "ENOTDIR") {
					await reportMoveRefusal(
						"Failed to inspect move destination " + change.movePath + ": " + shapeError.message,
					)
					return { ok: false, mutated }
				}
			}
			// Where the moved bytes land: the link target when the destination is a link, and the
			// requested path otherwise. realpath gives one spelling for the checks and the writes to
			// agree on even when the target is itself reached through further links, and a missing
			// target, the dangling-link case, keeps the spelled path because there is nothing to
			// resolve yet.
			const destinationWritePath = linkTargetPath ?? moveAbsolutePath
			let resolvedWritePath = destinationWritePath
			try {
				resolvedWritePath = await fs.realpath(destinationWritePath)
			} catch (error) {
				const resolvedError = error as NodeJS.ErrnoException
				if (resolvedError.code !== "ENOENT" && resolvedError.code !== "ENOTDIR") {
					await reportMoveRefusal(
						"Failed to resolve move destination " + change.movePath + ": " + resolvedError.message,
					)
					return { ok: false, mutated }
				}
			}
			// The requested spelling and the spelling that receives the bytes can differ, and when
			// they do the three checks above covered only the requested one. A link whose target
			// sits under .rooignore, behind write protection or outside the workspace is refused
			// exactly as the requested path would be.
			const targetDiffersFromRequested = path.resolve(resolvedWritePath) !== path.resolve(moveAbsolutePath)
			if (targetDiffersFromRequested) {
				const resolvedRelative = path.relative(task.cwd, resolvedWritePath)
				if (task.rooIgnoreController && !task.rooIgnoreController.validateAccess(resolvedRelative)) {
					await task.say("rooignore_error", resolvedRelative)
					pushToolResult(formatResponse.rooIgnoreError(resolvedRelative))
					await task.diffViewProvider.reset()
					return { ok: false, mutated }
				}
				if (task.rooProtectedController?.isWriteProtected(resolvedRelative) || false) {
					await reportMoveRefusal("Cannot move file to write-protected target " + resolvedRelative + ".")
					return { ok: false, mutated }
				}
				if (isPathOutsideWorkspace(resolvedWritePath)) {
					await reportMoveRefusal(
						"Cannot move file to a path outside the workspace: " +
							change.movePath +
							" resolves to " +
							getReadablePath(task.cwd, resolvedWritePath) +
							".",
					)
					return { ok: false, mutated }
				}
			}

			// A patch whose "Move to" resolves back onto its own source path is a rewrite of
			// that path, not a relocation: once the staged content is renamed onto the destination
			// there is no second file left, and unlinking the source would delete the content that
			// was just committed. Computed from resolved paths because case-insensitive and
			// normalized spellings can name the same file differently.
			// A destination link that resolves onto the source is the same rewrite the comment below
			// describes: the staged bytes land on the source path through the link, so unlinking the
			// source afterwards would delete the content the patch just committed.
			const isMoveOntoSource =
				path.resolve(moveAbsolutePath) === path.resolve(absolutePath) ||
				path.resolve(resolvedWritePath) === path.resolve(absolutePath)

			// Capture the destination state before either supported write path: a
			// failed move must restore an existing destination instead of deleting
			// whatever lived there. A read error other than ENOENT means the
			// destination cannot be inspected, so the move is refused before any
			// write rather than risking an unrecoverable clobber.
			let destinationBackup: Buffer | undefined
			try {
				destinationBackup = await fs.readFile(destinationWritePath)
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
				destinationMode = await fs.stat(destinationWritePath).then(
					(stat) => stat.mode,
					() => undefined,
				)
			}

			// Stage the move so it is all-or-nothing: the pre-move destination bytes
			// stay on disk under a backup name, the new content is written to a
			// staging file and renamed into place atomically, and only then is the
			// source unlinked. Any failure renames the backup back, so the workspace
			// never shows a half-applied move.
			const moveDir = path.dirname(destinationWritePath)
			const moveBase = path.basename(destinationWritePath)
			// The stamp is the only thing separating two staging entries, and it comes from the
			// pid and a millisecond clock, so a name left behind by an interrupted run can come
			// back around. A name that is already there belongs to another run, and it must not
			// be truncated into the staging file of this one. The write below therefore creates
			// the entry exclusively and, on a collision, re-stamps and tries again.
			const stagingWriteAttempts = 3
			let moveStamp = `${process.pid}.${Date.now()}`
			let stagingPath = path.join(moveDir, `.${moveBase}.${moveStamp}.staging`)
			let backupPath = path.join(moveDir, `.${moveBase}.${moveStamp}.backup`)
			await fs.mkdir(moveDir, { recursive: true })

			// Whether the destination bytes actually landed under the backup name. The
			// restore and the report below may only claim that location once it is true.
			let backupLanded = false
			let destinationCommitted = false
			try {
				for (let stagingAttempt = 0; ; stagingAttempt++) {
					try {
						// Owner-only from creation, and created exclusively: the staged content must
						// never be readable by others, even between the write and the rename, and an
						// entry that already exists, from another run or from one that was interrupted,
						// must not be truncated into this staging file. The "wx" flag answers with
						// EEXIST for any existing entry, whether link, socket or plain file.
						await fs.writeFile(stagingPath, newContent, { encoding: "utf8", flag: "wx", mode: 0o600 })
						break
					} catch (error) {
						const writeError = error as NodeJS.ErrnoException
						if (writeError.code !== "EEXIST" || stagingAttempt >= stagingWriteAttempts - 1) {
							throw error
						}
						// A collision means the stamp was reused. The backup name is derived from
						// the same stamp, so it is re-stamped with it rather than left behind.
						moveStamp = `${process.pid}.${Date.now()}.${stagingAttempt}`
						stagingPath = path.join(moveDir, `.${moveBase}.${moveStamp}.staging`)
						backupPath = path.join(moveDir, `.${moveBase}.${moveStamp}.backup`)
					}
				}
				if (destinationMode !== undefined) {
					await fs.chmod(stagingPath, destinationMode)
				}
				if (destinationBackup !== undefined) {
					// Preserve the pre-move bytes on disk (atomic rename): the in-memory
					// copy alone cannot restore the destination after a crash.
					await fs.rename(destinationWritePath, backupPath)
					backupLanded = true
				}
				await fs.rename(stagingPath, destinationWritePath)
				destinationCommitted = true
				// The destination content changed: even a later failed source unlink (which
				// rolls the destination back) is a workspace mutation the checkpoint must see.
				mutated = true
				mutation.committed = true
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
					await fs.rm(destinationWritePath, { force: true }).catch(() => {})
				}
				let destinationMissing = false
				if (destinationBackup !== undefined && backupLanded) {
					// Put the captured destination bytes back with one rename. If that rename
					// fails as well, the destination is missing and its content survives only
					// under the backup name, so the report has to say where it is.
					await fs.rename(backupPath, destinationWritePath).catch(() => {
						destinationMissing = true
					})
				}
				if (destinationMissing) {
					// A missing destination is a workspace mutation: record it so the
					// partial-state checkpoint runs before the queued-message handoff, exactly
					// as the failed source deletion below does.
					mutated = true
					mutation.committed = true
				}
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const writeErrorMessage =
					`Failed to write move destination '${change.movePath}': ${writeError instanceof Error ? writeError.message : String(writeError)}` +
					(destinationMissing && backupLanded
						? ` The original content is preserved at '${getReadablePath(task.cwd, path.relative(task.cwd, backupPath))}'.`
						: "")
				await task.say("error", writeErrorMessage)
				pushToolResult(formatResponse.toolError(writeErrorMessage))
				await task.diffViewProvider.reset()
				return { ok: false, mutated }
			}

			// Delete the original file, unless the move renamed its own path: there is no
			// second copy to remove in that case, and this is the step that would erase the
			// freshly written content.
			try {
				if (!isMoveOntoSource) {
					await fs.unlink(absolutePath)
				}
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
						await fs.rename(backupPath, destinationWritePath)
					} else {
						await fs.rm(destinationWritePath, { force: true })
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
							// Same owner-only creation as the staging write above, and O_EXCL rather than
							// truncation: a recovery copy holds private content, and silently overwriting
							// whatever already stands at that name would destroy a file instead of preserving one.
							await fs.writeFile(recoveryCandidate, newContent, {
								encoding: "utf8",
								mode: 0o600,
								flag: "wx",
							})
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
			mutation.committed = true
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
