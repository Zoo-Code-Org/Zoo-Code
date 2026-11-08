import fs from "fs/promises"
import type { BigIntStats } from "fs"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import type { FileObservation } from "../task/observationRegistry"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import { versionTokenOfStat } from "../../utils/versionToken"
import { canonicalizeForApproval, GuardRejectedError, errorCode } from "./guardedWrite"
import { CommittedWriteBufferConflictError } from "../../integrations/editor/committedWriteBufferConflictError"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { ApplyPatchError, parsePatch, ParseError, processAllHunks } from "./apply-patch"
import type { ApplyPatchFileChange, PatchReadIntent } from "./apply-patch"

interface ApplyPatchParams {
	patch: string
}

/**
 * Whether two stats name one file, judged the way the compares around this handler judge it: as
 * bigints, because on NTFS and ReFS a file identity can exceed Number.MAX_SAFE_INTEGER and a
 * rounded value makes two files look alike or two spellings of one file look different. Both sides
 * have to actually carry a bigint identity - a stat that does not is a double that was never asked
 * to answer identity, and reading it as "the same file" would refuse ordinary moves for a shape no
 * real filesystem produces.
 */
function _sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return (
		typeof left.ino === "bigint" &&
		typeof right.ino === "bigint" &&
		typeof left.dev === "bigint" &&
		typeof right.dev === "bigint" &&
		left.ino === right.ino &&
		left.dev === right.dev
	)
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

		// Every observation this call creates is tracked here by path -> the exact entry the
		// registry stored. A hunk read is the tool read, not a model read: an exit that does
		// not publish must withdraw what this call recorded, otherwise a later edit,
		// search_replace, edit_file or apply_diff finds the leftover partial entry, the
		// compare-and-swap matches, and the file publishes without the model ever reading it.
		// Withdrawal is keyed to the stored entry, so an entry a publish re-earned or one a
		// concurrent read replaced is never discarded here. Declared outside the try because
		// the finally exit needs it. ApplyDiffTool enforces the same contract for its single
		// read with forgetPartialObservationIfCurrent; apply_patch reads several files per
		// call, so this side keeps one entry per path.
		const toolObservations = new Map<string, FileObservation>()
		const forgetToolObservationsIfCurrent = (): void => {
			for (const [observedPath, entry] of toolObservations) {
				if (task.observationRegistry.get(observedPath) === entry) {
					task.observationRegistry.forget(observedPath)
				}
			}
			toolObservations.clear()
		}
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

			// Process each hunk. The read doubles as the S2 observation for the
			// guarded publish (ReadFileTool contract: stat before and after the
			// read, observe only when the on-disk version is unchanged between the
			// two stats). Without it, the in-place modify publish is an unobserved
			// write and the composed chat-diff default rejects it ("File already
			// exists ... and was not read before this write") even though this tool
			// just read the exact content the patch was applied to.
			const readFile = async (filePath: string, intent: PatchReadIntent): Promise<string> => {
				const absolutePath = path.resolve(task.cwd, filePath)
				const preReadStats = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined)
				// Read the bytes, not a string: readFile with "utf8" has already substituted
				// the sequences a strict decoder would refuse on, so the check below could not
				// tell a file that contains a real replacement character from one whose bytes
				// were replaced on the way in.
				const raw = await fs.readFile(absolutePath)
				let content: string
				try {
					content = new TextDecoder("utf-8", { fatal: true }).decode(raw)
				} catch {
					if (intent !== "publish") {
						// Nothing is republished from this reading - a delete publishes by unlinking -
						// so a file whose bytes nobody can name may still be deleted. The snapshot
						// stays the lossy reading it always was.
						content = raw.toString("utf8")
					} else {
						// Refuse before any observation is recorded: the version observed here is the
						// version a later full-file write would be allowed to publish, and publishing
						// it means rewriting the bytes this read could not name.
						// The lossy reading substitutes from exactly the byte the strict decoder
						// refused on, so re-encoding the text before its first replacement lands on
						// the offending sequence.
						const lossy = raw.toString("utf8")
						const firstSubstitution = lossy.indexOf("\uFFFD")
						const offset =
							firstSubstitution < 0
								? raw.length
								: Buffer.byteLength(lossy.slice(0, firstSubstitution), "utf8")
						throw new ApplyPatchError(
							`Cannot apply patch to ${filePath}: the file is not valid UTF-8 (byte ${offset} cannot be decoded). apply_patch refuses rather than rewriting bytes the patch never touched.`,
						)
					}
				}
				const postReadStats = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined)
				if (preReadStats && postReadStats) {
					const preReadToken = versionTokenOfStat(preReadStats)
					if (preReadToken === versionTokenOfStat(postReadStats)) {
						// The tool's own hunk read, not a model read. When the model already observed the
						// file, keep the completeness it earned and only on the version it was earned on; a
						// partial view stays partial. With no prior observation the model has seen only the
						// patch's hunks, so this read stays incomplete: it must not become authority for a
						// later full-file replacement.
						const prior = task.observationRegistry.get(absolutePath)
						// With no prior observation there is nothing to carry, and the read stays
						// incomplete. Carry completeness only when a prior observation exists and still
						// describes the version that was read.
						const complete =
							prior === undefined ? false : prior.complete === true && prior.version === preReadToken
						task.observationRegistry.observe(absolutePath, preReadToken, complete)
						// Keep the stored entry so a non-publishing exit can withdraw exactly this
						// observation later.
						const storedObservation = task.observationRegistry.get(absolutePath)
						if (storedObservation) {
							toolObservations.set(absolutePath, storedObservation)
						}
					}
				}
				return content
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

			// Process each file change
			for (const change of changes) {
				const relPath = change.path
				const absolutePath = path.resolve(task.cwd, relPath)

				// Check access permissions
				const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					pushToolResult(formatResponse.rooIgnoreError(relPath))
					return
				}

				// Check if file is write-protected
				const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

				if (change.type === "add") {
					// Create new file
					await this.handleAddFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						toolObservations,
					)
				} else if (change.type === "delete") {
					// Delete file
					await this.handleDeleteFile(
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						toolObservations,
					)
				} else if (change.type === "update") {
					// Update file
					await this.handleUpdateFile(
						change,
						absolutePath,
						relPath,
						task,
						callbacks,
						isWriteProtected,
						toolObservations,
					)
				}
			}

			task.consecutiveMistakeCount = 0
		} catch (error) {
			await handleError("apply patch", error as Error)
			await task.diffViewProvider.reset()
		} finally {
			// Every exit that did not publish passes through here: processAllHunks throwing (the
			// files read before the failure stay observed), a refused approval, a rooignore or
			// outside-workspace refusal, and the outer catch. Paths that published were removed
			// from the tracker at the publish site, so this withdraws only what no publish earned.
			forgetToolObservationsIfCurrent()
		}
	}

	private async handleAddFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		toolObservations: Map<string, FileObservation>,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		// Check if file already exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File already exists: ${relPath}. Use Update File instead.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
		// Captured before the approval is asked: guardedWrite binds the publish to this
		// identity, so a name repointed between the approval and the publish is refused
		// instead of publishing to whatever the name points at by then.
		const approvedCanonicalTarget = isOutsideWorkspace
			? await canonicalizeForApproval(absolutePath, relPath)
			: undefined

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
			return
		}

		// Save the changes
		if (isPreventFocusDisruptionEnabled) {
			// Guarded publish: the patch supplies the complete new content, so create-guard
			// semantics apply (an unobserved existing target is rejected, not overwritten).
			await task.diffViewProvider.saveDirectly(
				relPath,
				newContent,
				true,
				diagnosticsEnabled,
				writeDelayMs,
				"create",
				// Seventh parameter is completeOverride (this call claims no completeness of its
				// own); the eighth is the approval flag for a target outside every workspace root.
				undefined,
				isOutsideWorkspace,
				approvedCanonicalTarget,
			)
		} else {
			// The add path publishes a whole new file, so create-guard semantics
			// apply here as well.
			await task.diffViewProvider.saveChanges(
				diagnosticsEnabled,
				writeDelayMs,
				"create",
				isOutsideWorkspace,
				approvedCanonicalTarget,
			)
		}

		// Track file edit operation
		await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
		// This call published the path, so the observation it carries is earned: the sweep in
		// the finally block leaves it alone.
		toolObservations.delete(absolutePath)
		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
	}

	private async handleDeleteFile(
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		toolObservations: Map<string, FileObservation>,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot delete a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
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
			return
		}

		// Delete the file
		try {
			await fs.unlink(absolutePath)
		} catch (error) {
			const errorMessage = `Failed to delete file '${relPath}': ${error instanceof Error ? error.message : String(error)}`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		// The delete consumed the observation: the version the hunk read recorded is no longer
		// reachable at this path, so there is nothing here for the sweep to withdraw.
		toolObservations.delete(absolutePath)

		task.didEditFile = true
		pushToolResult(`Successfully deleted ${relPath}`)
		task.processQueuedMessages()
	}

	private async handleUpdateFile(
		change: ApplyPatchFileChange,
		absolutePath: string,
		relPath: string,
		task: Task,
		callbacks: ToolCallbacks,
		isWriteProtected: boolean,
		toolObservations: Map<string, FileObservation>,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		// Check if file exists
		const fileExists = await fileExistsAtPath(absolutePath)
		if (!fileExists) {
			task.consecutiveMistakeCount++
			task.recordToolError("apply_patch")
			const errorMessage = `File not found: ${relPath}. Cannot update a non-existent file.`
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const originalContent = change.originalContent || ""
		const newContent = change.newContent || ""
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
		// Captured before the approval is asked: guardedWrite binds the publish to this
		// identity, so a name repointed between the approval and the publish is refused
		// instead of publishing to whatever the name points at by then.
		const approvedCanonicalTarget = isOutsideWorkspace
			? await canonicalizeForApproval(absolutePath, relPath)
			: undefined

		// Initialize diff view
		task.diffViewProvider.editType = "modify"
		task.diffViewProvider.originalContent = originalContent

		// Generate and validate diff
		const diff = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
		if (!diff) {
			pushToolResult(`No changes needed for '${relPath}'`)
			await task.diffViewProvider.reset()
			return
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
			return
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
				return
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
				return
			}

			// Check if destination path is outside workspace
			const isMoveOutsideWorkspace = isPathOutsideWorkspace(moveAbsolutePath)
			// A destination outside every workspace root is refused right here, so the publish at the
			// end of this branch is always an inside-workspace one: it needs neither the approval flag
			// nor a canonical identity. Capturing the identity here instead - as this did - ran
			// canonicalizeForApproval for a destination that was about to be refused, so a destination
			// whose name could not be resolved surfaced an exception where the user should get the tool
			// error below.
			if (isMoveOutsideWorkspace) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move file to path outside workspace: ${change.movePath}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return
			}

			// A move whose destination names the same file as its source publishes onto that file and
			// then unlinks it: the write lands, the unlink at the end of this branch removes what was
			// just written, and the bookkeeping below counts both paths as published. No reading of a
			// move patch makes deleting the file you just wrote a correct outcome, so the pair is refused
			// here - before the save, before the unlink, before the tracker call - which leaves every file
			// exactly as it was found.
			//
			// Sameness is asked of the filesystem rather than of the two strings. Under an alias two
			// spellings name one file, and across an alias one spelling names two files, so a string
			// compare is wrong in both directions: it would refuse the alias-spelled move that ought to
			// happen and allow the two-names-one-file move that ought not. The identity is read as bigints
			// for the reason the compare beside it gives (safeWriteText.ts:247-:265): on NTFS and ReFS a
			// file identity can exceed Number.MAX_SAFE_INTEGER, and a rounded value makes two files look
			// alike or one file look like two.
			//
			// Both stats are taken on the spellings the patch named, resolved against the workspace and
			// deliberately not canonicalized: canonicalizing first would fold an alias's two spellings
			// into one string here and leave the identity question unasked.
			//
			// A refusal to answer is not read as "different files". Neither stat is allowed to throw
			// through this handler: an exception here would replace the tool error the user should get,
			// which is the mistake the note above the outside-workspace refusal records for canonicalising
			// a destination that was about to be refused. Absence is read as what it means - a destination
			// that is not there is not the same file as the source - and a refusal refuses the move.
			const identityOf = async (target: string): Promise<BigIntStats | "absent" | "refused"> => {
				try {
					return await fs.stat(target, { bigint: true })
				} catch (error: unknown) {
					return errorCode(error) === "ENOENT" ? "absent" : "refused"
				}
			}
			const sourceIdentity = await identityOf(absolutePath)
			const destinationIdentity = await identityOf(moveAbsolutePath)
			const moveRefusal =
				sourceIdentity === "refused" || destinationIdentity === "refused"
					? "the filesystem would not say what either path refers to, so the tool cannot tell whether the two names are one file"
					: sourceIdentity !== "absent" &&
						  destinationIdentity !== "absent" &&
						  _sameFileIdentity(sourceIdentity, destinationIdentity)
						? `the two paths name the same file (dev ${String(sourceIdentity.dev)}, ino ${String(sourceIdentity.ino)}), so the move would publish onto it and then unlink what it just published`
						: undefined
			if (moveRefusal !== undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_patch")
				const errorMessage = `Cannot move ${change.path} onto ${change.movePath}: ${moveRefusal}`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				await task.diffViewProvider.reset()
				return
			}

			// Save new content to the new path
			if (isPreventFocusDisruptionEnabled) {
				// The destination content is the source file plus one targeted hunk, so it can
				// only be as complete as the view the model had of the source. Carry that
				// completeness to the destination BEFORE the guarded publish: the guard decides
				// completeness at publish time, so a partial view must already be recorded when
				// the per-path chain runs. Downgrading only after saveDirectly leaves a window
				// in which a concurrent writer sees the destination as complete for content the
				// model never fully read.
				const sourceObs = task.observationRegistry.get(absolutePath)
				const sourceComplete = sourceObs !== undefined && sourceObs.complete === true
				if (!sourceComplete) {
					// Only carry completeness the model already had for the destination. An
					// unobserved destination stays unobserved so the guard's "read before a
					// full-file write" rule still applies; recording a partial observation here
					// would hand the model authority to edit a file it never read.
					const destObs = task.observationRegistry.get(moveAbsolutePath)
					if (destObs !== undefined) {
						let destAbsent = false
						try {
							await fs.access(moveAbsolutePath)
						} catch (error: unknown) {
							// Only an access error that means "not there" is an absence verdict. An
							// ELOOP or EACCES is a real I/O failure: reading it as absent would mark
							// the destination partial and let the publish run against a path the tool
							// never actually observed.
							if (errorCode(error) !== "ENOENT") throw error
							destAbsent = true
						}
						if (!destAbsent) {
							// Replacing an existing destination with content built from a partial
							// source view must be re-authorized by reading the source in full. Reject
							// before any state changes and name the source: a remediation that names
							// only the destination sends the model to re-read the wrong file, and a
							// downgrade that survives a rejected publish loses a full destination read.
							throw new GuardRejectedError(
								`Cannot move a partially read file onto ${change.movePath}: re-read the whole source (${change.path}) first, then retry.`,
								change.movePath,
							)
						}
						// The destination was read and then deleted: the create guard permits the
						// publish, and the content is still only as complete as the view the model
						// had of the source, so carry the source's completeness instead of the
						// destination's stale one.
						task.observationRegistry.observe(moveAbsolutePath, destObs.version, false)
						// Tracked like a hunk read: if the move does not publish, this partial entry must
						// not survive as authority for a destination the model never read.
						const storedDestObservation = task.observationRegistry.get(moveAbsolutePath)
						if (storedDestObservation) {
							toolObservations.set(moveAbsolutePath, storedDestObservation)
						}
					}
				}
				try {
					await task.diffViewProvider.saveDirectly(
						change.movePath,
						newContent,
						false,
						diagnosticsEnabled,
						writeDelayMs,
						"create",
						sourceComplete,
						// Guaranteed by the refusal above: this destination is inside a workspace root,
						// so the guard's own containment check is what applies and no approval is claimed.
						false,
						undefined,
					)
				} catch (error) {
					if (error instanceof CommittedWriteBufferConflictError) {
						// The destination committed and the source unlink below never runs, so the move is
						// half-applied: the content is at the new path and the source is still on disk. A model
						// that re-applies the patch duplicates the change at the destination while a third path
						// still holds the pre-move bytes, so both paths are named and the shared error keeps its
						// no-retry guidance.
						throw new CommittedWriteBufferConflictError(
							moveAbsolutePath,
							`apply_patch move: ${change.movePath} committed but ${change.path} was not removed, so the move ` +
								"is incomplete: read both paths before continuing.",
						)
					}
					throw error
				}
			} else {
				// Write to new path and delete old file
				const parentDir = path.dirname(moveAbsolutePath)
				await fs.mkdir(parentDir, { recursive: true })
				await fs.writeFile(moveAbsolutePath, newContent, "utf8")
			}

			// Delete the original file. A failure here is logged and tolerated: the destination
			// has already published, but the source is still sitting on disk with the bytes it
			// had before the move, so nothing was published at that path.
			let sourceRemoved = true
			try {
				await fs.unlink(absolutePath)
			} catch (error) {
				sourceRemoved = false
				console.error(`Failed to delete original file after move: ${error}`)
			}

			await task.fileContextTracker.trackFileContext(change.movePath, "roo_edited" as RecordSource)
			// The destination published through the save above, so its entry leaves the sweep.
			// The source only counts as published once its own unlink succeeded: otherwise the
			// partial observation this call recorded for it is withdrawn in the finally block,
			// instead of authorizing a later edit on a file the model never read in full.
			toolObservations.delete(moveAbsolutePath)
			if (sourceRemoved) {
				toolObservations.delete(absolutePath)
			}
		} else {
			// Save changes to the same file
			if (isPreventFocusDisruptionEnabled) {
				// Guarded publish: an update hunk is a targeted change, so it is guarded
				// as an edit -- a partial observation authorizes it and stays partial. A
				// stale observed version is still rejected with the re-read hint.
				await task.diffViewProvider.saveDirectly(
					relPath,
					newContent,
					false,
					diagnosticsEnabled,
					writeDelayMs,
					"edit",
					// Seventh parameter is completeOverride (this call claims no completeness of its
					// own); the eighth is the approval flag for a target outside every workspace root.
					undefined,
					isOutsideWorkspace,
					approvedCanonicalTarget,
				)
			} else {
				// The diff-view save is the same targeted hunk as the guarded save above:
				// it must select the same edit guard, otherwise a partial read is
				// rejected and the approved patch is thrown away.
				await task.diffViewProvider.saveChanges(
					diagnosticsEnabled,
					writeDelayMs,
					"edit",
					isOutsideWorkspace,
					approvedCanonicalTarget,
				)
			}

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			// The publish owns this path now, so the sweep in the finally block leaves its
			// observation alone.
			toolObservations.delete(absolutePath)
		}

		task.didEditFile = true

		const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
		pushToolResult(message)
		await task.diffViewProvider.reset()
		task.processQueuedMessages()
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
