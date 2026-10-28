import path from "path"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { getReadablePath } from "../../utils/path"
import { versionTokenOfStat } from "../../utils/versionToken"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { DiffResult, ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ApplyDiffParams {
	path: string
	diff: string
}

const DETAILED_APPLY_DIFF_FAILURES = 5
const MAX_DETAILED_FAILURE_CHARACTERS = 4000
const MAX_SUMMARY_FAILURE_CHARACTERS = 200
const MAX_ABBREVIATED_FAILURES = 50

export class ApplyDiffTool extends BaseTool<"apply_diff"> {
	readonly name = "apply_diff" as const

	async execute(params: ApplyDiffParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		let { path: relPath, diff: diffContent } = params

		if (diffContent && !task.api.getModel().id.includes("claude")) {
			diffContent = unescapeHtmlEntities(diffContent)
		}

		// Identity of a partial observation this call created (undefined when the model had
		// already observed the file): only this exact observation may be removed on a failure
		// exit, so a replaced or published observation is never discarded here. Declared outside
		// the try so the catch exit can use it too.
		let partialObservation: { path: string; version: string } | undefined
		const forgetPartialObservationIfCurrent = () => {
			if (
				partialObservation &&
				task.observationRegistry.get(partialObservation.path)?.version === partialObservation.version
			) {
				task.observationRegistry.forget(partialObservation.path)
			}
		}

		try {
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "path"))
				return
			}

			if (!diffContent) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "diff"))
				return
			}

			const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}

			const absolutePath = path.resolve(task.cwd, relPath)
			const fileExists = await fileExistsAtPath(absolutePath)

			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			// The diff below is built from this exact read, so the save that follows must be
			// authorized against the version captured here - not against whatever version the
			// preview happens to stat afterwards. Same contract as ApplyPatchTool's hunk read:
			// stat around the read and observe only when the file did not change underneath it.
			const preReadStats = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined)
			const originalContent: string = await fs.readFile(absolutePath, "utf-8")
			const postReadStats = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined)
			if (preReadStats && postReadStats) {
				const preReadToken = versionTokenOfStat(preReadStats)
				if (preReadToken === versionTokenOfStat(postReadStats)) {
					// A tool read is not a model read. With no prior observation this stays a
					// partial observation of the version the diff was computed against - the only
					// authorization the save can have, since apply_diff computes its hunks from
					// this read. When the model already observed the file, keep the completeness it
					// earned, but only on the version it was earned on: refreshing an OLDER
					// observation to the current version would let content the model built from a
					// stale read pass the compare-and-swap, so an out-of-date observation is left
					// alone and the save fails with the re-read remediation.
					const prior = task.observationRegistry.get(absolutePath)
					if (prior === undefined) {
						task.observationRegistry.observe(absolutePath, preReadToken, false)
						partialObservation = { path: absolutePath, version: preReadToken }
					} else if (prior.version === preReadToken) {
						task.observationRegistry.observe(absolutePath, preReadToken, prior.complete === true)
					}
				}
			}

			// Apply the diff to the original content
			const diffResult = (await task.diffStrategy?.applyDiff(
				originalContent,
				diffContent,
				parseInt(params.diff.match(/:start_line:(\d+)/)?.[1] ?? ""),
			)) ?? {
				success: false,
				error: "No diff strategy available",
			}

			if (!diffResult.success) {
				task.consecutiveMistakeCount++
				const currentCount = (task.consecutiveMistakeCountForApplyDiff.get(relPath) || 0) + 1
				task.consecutiveMistakeCountForApplyDiff.set(relPath, currentCount)
				let formattedError = ""
				TelemetryService.instance.captureDiffApplicationError(task.taskId, currentCount)

				if (diffResult.failParts && diffResult.failParts.length > 0) {
					const failedParts = diffResult.failParts.filter((part) => !part.success)
					const summary =
						failedParts.length > 1
							? `${failedParts.length} diff blocks failed to apply. Fix the failures below before retrying.\n\n`
							: ""

					formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${summary}${this.formatFailedParts(failedParts)}\n</error_details>`
				} else {
					// `details` may carry search/best-match file text, so it is never forwarded.
					formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${this.truncate(
						diffResult.error ?? "Unknown apply_diff failure",
						MAX_DETAILED_FAILURE_CHARACTERS,
					)}\n</error_details>`
				}

				if (currentCount >= 2) {
					await task.say("diff_error", formattedError)
				}

				task.recordToolError("apply_diff", formattedError)

				pushToolResult(formattedError)
				forgetPartialObservationIfCurrent()
				return
			}

			task.consecutiveMistakeCount = 0
			task.consecutiveMistakeCountForApplyDiff.delete(relPath)

			// Generate backend-unified diff for display in chat/webview
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, diffResult.content)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			const diffStats = computeDiffStats(unifiedPatch) || undefined

			// Check if preventFocusDisruption experiment is enabled
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			// Check if file is write-protected
			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

			const sharedMessageProps: ClineSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: diffContent,
			}

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					forgetPartialObservationIfCurrent()
					return
				}

				// Save directly without showing diff view or opening the file. The diff is
				// applied to an existing file, so edit-guard semantics require a prior read.
				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(
					relPath,
					diffResult.content,
					false,
					diagnosticsEnabled,
					writeDelayMs,
					"edit",
				)
			} else {
				// Original behavior with diff view
				// Show diff view before asking for approval
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(diffResult.content, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					forgetPartialObservationIfCurrent()
					task.processQueuedMessages()
					return
				}

				// Call saveChanges to update the DiffViewProvider properties
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs, "edit")
			}

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			// Used to determine if we should wait for busy terminal to update before sending api request
			task.didEditFile = true

			// Prefer the parser's count: truncation repair can split inline markers into extra blocks.
			const searchBlocks =
				diffResult.blockCount ?? (diffContent.match(/^<<<<<<< SEARCH>?[^\S\r\n]*\r?$/gm) || []).length
			const unappliedParts = diffResult.failParts?.filter((part) => !part.success) ?? []
			let partFailHint = ""

			if (unappliedParts.length > 0) {
				const appliedBlocks = Math.max(0, searchBlocks - unappliedParts.length)
				partFailHint =
					`Applied ${appliedBlocks} of ${searchBlocks} diff blocks to ${absolutePath}. ` +
					`The other ${unappliedParts.length} did NOT apply. ` +
					`Inspect the saved file before retrying, since an earlier block may already contain the intended change. ` +
					`Then resend ONLY the failed blocks that are still needed; the blocks that already applied will no longer match.\n\n` +
					`<error_details>\n${this.formatFailedParts(unappliedParts)}\n</error_details>\n\n`
			}

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			// Check for single SEARCH/REPLACE block warning
			const singleBlockNotice =
				searchBlocks === 1
					? "\n<notice>Making multiple related changes in a single apply_diff is more efficient. If other changes are needed in this file, please include them as additional SEARCH/REPLACE blocks.</notice>"
					: ""

			if (partFailHint) {
				pushToolResult(partFailHint + message + singleBlockNotice)
			} else {
				pushToolResult(message + singleBlockNotice)
			}

			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("applying diff", error as Error)
			forgetPartialObservationIfCurrent()
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
			return
		}
	}

	/** Strategy errors are file-content-free diagnostics; `details` may hold file text and is never rendered. */
	private formatFailedParts(failedParts: Extract<DiffResult, { success: false }>[]): string {
		const renderedCount = Math.min(failedParts.length, MAX_ABBREVIATED_FAILURES)
		const sections = failedParts.slice(0, renderedCount).map((failPart, index) => {
			const label = failedParts.length > 1 ? `--- Failure ${index + 1} of ${failedParts.length} ---\n` : ""
			const error = failPart.error ?? "Unknown apply_diff failure"

			if (index >= DETAILED_APPLY_DIFF_FAILURES) {
				const summaryLine = error.split("\n")[0]
				return `${label}${this.truncate(summaryLine, MAX_SUMMARY_FAILURE_CHARACTERS)}`
			}

			return this.truncate(`${label}${error}`, MAX_DETAILED_FAILURE_CHARACTERS)
		})

		const trailers: string[] = []
		const abbreviatedRangeStart = DETAILED_APPLY_DIFF_FAILURES + 1

		if (renderedCount > DETAILED_APPLY_DIFF_FAILURES) {
			trailers.push(
				`(Failures ${abbreviatedRangeStart}-${renderedCount} are shown as a single summary line each; retry those blocks individually for full detail.)`,
			)
		}

		const omitted = failedParts.length - renderedCount

		if (omitted > 0) {
			trailers.push(`(+${omitted} more failures not shown; retry those blocks individually for full detail.)`)
		}

		return [sections.join("\n\n"), ...trailers].join("\n\n")
	}

	private truncate(text: string, maxCharacters: number): string {
		if (text.length <= maxCharacters) {
			return text
		}

		const omitted = text.length - maxCharacters

		return `${text.slice(0, maxCharacters)}\n... [truncated; ${omitted} characters omitted — retry this block alone for full detail]`
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_diff">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const diffContent: string | undefined = block.params.diff

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: diffContent,
		}

		let toolProgressStatus

		if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
			toolProgressStatus = task.diffStrategy.getProgressStatus(block)
		}

		if (toolProgressStatus && Object.keys(toolProgressStatus).length === 0) {
			return
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial, toolProgressStatus).catch(() => {})
	}
}

export const applyDiffTool = new ApplyDiffTool()
