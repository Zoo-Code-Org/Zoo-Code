import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@roo-code/telemetry"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@roo-code/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate.
 * Used by Context Management to determine when to trigger condensation or (fallback) sliding window truncation.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Computes the percentage of the context budget consumed by the prior context.
 *
 * Default: divide by the full context window. Opt-in (vscode-lm) divides by available input
 * (window minus reserved output); an unknown/unlimited reserve (maxTokens -1) falls back to the
 * full window. Shared by `willManageContext` and `manageContext` so the two stay in lockstep.
 */
function computeContextPercent({
	prevContextTokens,
	contextWindow,
	maxTokens,
	useAvailableInputForContextPercent,
}: {
	prevContextTokens: number
	contextWindow: number
	maxTokens?: number | null
	useAvailableInputForContextPercent?: boolean
}): number {
	if (!useAvailableInputForContextPercent) {
		return (100 * prevContextTokens) / contextWindow
	}
	const reservedForOutput = maxTokens && maxTokens > 0 ? maxTokens : 0
	const availableInputTokens = contextWindow - reservedForOutput
	return availableInputTokens > 0 ? (100 * prevContextTokens) / availableInputTokens : 100
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)

	const truncationId = crypto.randomUUID()

	// Filter to only visible messages (those not already truncated)
	// We need to track original indices to correctly tag messages in the full array
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	// Calculate how many visible messages to truncate (excluding first visible message)
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	if (messagesToRemove <= 0) {
		// Nothing to truncate
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	// Get the indices of visible messages to truncate (skip first visible, take next N)
	const indicesToTruncate = new Set(visibleIndices.slice(1, messagesToRemove + 1))

	// Tag messages that are being "truncated" (hidden from API calls)
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Find the actual boundary - the index right after the last truncated message
	const lastTruncatedVisibleIndex = visibleIndices[messagesToRemove] // Last visible message being truncated
	// If all visible messages except the first are truncated, insert marker at the end
	const firstKeptVisibleIndex = visibleIndices[messagesToRemove + 1] ?? taggedMessages.length

	// Insert truncation marker at the actual boundary (between last truncated and first kept)
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	// Insert marker at the boundary position
	// Find where to insert: right before the first kept visible message
	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return {
		messages: result,
		truncationId,
		messagesRemoved: messagesToRemove,
	}
}

/**
 * Minimum characters retained when degrading a tool_result: below this the model can no
 * longer tell what the tool was operating on, so the block stops being eligible.
 */
const TOOL_RESULT_SHRINK_FLOOR_CHARS = 200

/**
 * A textual tool_result block eligible for degradation, located by index so the edit can
 * be applied without mutating the input history. `textIndex` is the position of the text
 * inside the tool_result's content array, or -1 when the content is a plain string.
 */
type ShrinkingToolResult = {
	messageIndex: number
	blockIndex: number
	textIndex: number
	text: string
	tokens: number
}

/**
 * Collects the textual tool_result blocks that can still be shrunk, with their token
 * estimates. Only blocks above the floor are returned; images and other non-textual
 * content are never touched.
 */
async function findShrinkableToolResults(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
): Promise<ShrinkingToolResult[]> {
	const results: ShrinkingToolResult[] = []
	for (const [messageIndex, message] of messages.entries()) {
		if (message.truncationParent || message.isTruncationMarker) continue
		if (!Array.isArray(message.content)) continue
		for (const [blockIndex, block] of message.content.entries()) {
			if (block.type !== "tool_result") continue
			const toolResult = block as Anthropic.ToolResultBlockParam
			const items =
				typeof toolResult.content === "string"
					? [{ textIndex: -1, text: toolResult.content }]
					: (toolResult.content ?? [])
							.map((item, textIndex) => ({ textIndex, item }))
							.filter(({ item }) => item.type === "text")
							.map(({ textIndex, item }) => ({
								textIndex,
								text: (item as Anthropic.TextBlockParam).text,
							}))
			for (const { textIndex, text } of items) {
				if (text.length <= TOOL_RESULT_SHRINK_FLOOR_CHARS) continue
				results.push({
					messageIndex,
					blockIndex,
					textIndex,
					text,
					tokens: await estimateTokenCount([{ type: "text", text }], apiHandler),
				})
			}
		}
	}
	return results
}

/**
 * Applies tool_result shrink edits functionally: the input history is never mutated, so
 * the caller's reference comparison (`messages !== apiConversationHistory`) keeps working.
 */
function applyToolResultEdits(
	messages: ApiMessage[],
	edits: Array<{ messageIndex: number; blockIndex: number; textIndex: number; newText: string }>,
): ApiMessage[] {
	const result = [...messages]
	const byMessage = new Map<number, typeof edits>()
	for (const edit of edits) {
		const group = byMessage.get(edit.messageIndex) ?? []
		group.push(edit)
		byMessage.set(edit.messageIndex, group)
	}
	for (const [messageIndex, messageEdits] of byMessage) {
		const message = result[messageIndex]
		if (!Array.isArray(message.content)) continue
		const content = [...message.content]
		const byBlock = new Map<number, typeof messageEdits>()
		for (const edit of messageEdits) {
			const group = byBlock.get(edit.blockIndex) ?? []
			group.push(edit)
			byBlock.set(edit.blockIndex, group)
		}
		for (const [blockIndex, blockEdits] of byBlock) {
			const block = content[blockIndex] as Anthropic.ToolResultBlockParam
			if (typeof block.content === "string") {
				content[blockIndex] = { ...block, content: blockEdits[0]!.newText }
			} else {
				const blockContent = [...(block.content ?? [])]
				for (const edit of blockEdits) {
					blockContent[edit.textIndex] = {
						...(blockContent[edit.textIndex] as Anthropic.TextBlockParam),
						text: edit.newText,
					}
				}
				content[blockIndex] = { ...block, content: blockContent }
			}
		}
		result[messageIndex] = { ...message, content }
	}
	return result
}

/**
 * Frees context budget by shrinking the largest textual tool_result blocks in place: the
 * tool_use_id and block shape are preserved, so the tool_use/tool_result pair is never
 * orphaned. Returns the updated messages, or null when nothing eligible can shrink.
 *
 * Used when message-level truncation removes zero messages (short histories such as an
 * assistant tool_use followed by one oversized user tool_result): without this, the only
 * remaining recovery is reporting a successful truncation that removed nothing.
 */
async function shrinkOversizedToolResults({
	messages,
	tokensToFree,
	apiHandler,
}: {
	messages: ApiMessage[]
	tokensToFree: number
	apiHandler: ApiHandler
}): Promise<ApiMessage[] | null> {
	if (tokensToFree <= 0) return null
	const candidates = await findShrinkableToolResults(messages, apiHandler)
	if (candidates.length === 0) return null

	// Largest first: the biggest result frees the most tokens while losing the least
	// information, and smaller results stay available to a later recovery round.
	candidates.sort((a, b) => b.tokens - a.tokens)

	const edits: Array<{ messageIndex: number; blockIndex: number; textIndex: number; newText: string }> = []
	let remaining = tokensToFree
	for (const candidate of candidates) {
		if (remaining <= 0) break
		// Chars-per-token measured on the block itself, so the shrink target lands close
		// to the intended token reduction whatever the content's tokenizer density is.
		const charsPerToken = candidate.text.length / Math.max(candidate.tokens, 1)
		const keepTokens = Math.max(candidate.tokens - remaining, 1)
		const keepChars = Math.max(TOOL_RESULT_SHRINK_FLOOR_CHARS, Math.floor(keepTokens * charsPerToken))
		if (keepChars >= candidate.text.length) continue
		const removed = candidate.text.length - keepChars
		edits.push({
			messageIndex: candidate.messageIndex,
			blockIndex: candidate.blockIndex,
			textIndex: candidate.textIndex,
			newText: `${candidate.text.slice(0, keepChars)}\n[Tool result truncated: ${removed} characters removed to fit the context budget]`,
		})
		remaining -= Math.floor(removed / charsPerToken)
	}
	if (edits.length === 0) return null
	return applyToolResultEdits(messages, edits)
}

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
	/**
	 * Opt-in (vscode-lm): measure the condense percentage against available input space
	 * (contextWindow - reserved output) instead of the full window. Others leave it undefined.
	 */
	useAvailableInputForContextPercent?: boolean
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
	useAvailableInputForContextPercent,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
		const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
		return prevContextTokens > allowedTokens
	}

	// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
	const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = computeContextPercent({
		prevContextTokens,
		contextWindow,
		maxTokens,
		useAvailableInputForContextPercent,
	})
	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Roo during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
	/**
	 * Opt-in (vscode-lm): measure the condense percentage against available input space
	 * (contextWindow - reserved output) instead of the full window. Others leave it undefined.
	 */
	useAvailableInputForContextPercent?: boolean
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
	useAvailableInputForContextPercent,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	// Calculate the maximum tokens reserved for response
	// vscode-lm reports maxTokens: -1 (unlimited); a negative reserve must not distort the window math.
	const reservedTokens = maxTokens && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage.content
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold
		} else {
			// Invalid threshold value, fall back to global setting
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	if (autoCondenseContext) {
		const contextPercent = computeContextPercent({
			prevContextTokens,
			contextWindow,
			maxTokens,
			useAvailableInputForContextPercent,
		})
		if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the context
			const result = await summarizeConversation({
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd,
				rooIgnoreController,
			})
			if (result.error) {
				error = result.error
				errorDetails = result.errorDetails
				cost = result.cost
			} else {
				return { ...result, prevContextTokens }
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		// Model-facing token count: the system prompt plus every message that is not hidden
		// by a truncation marker. Shared by the truncation and degradation paths below so
		// both report against the same accounting.
		const countModelFacingTokens = async (msgs: ApiMessage[]): Promise<number> => {
			let total = await estimateTokenCount([{ type: "text", text: systemPrompt }], apiHandler)
			for (const msg of msgs) {
				if (msg.truncationParent || msg.isTruncationMarker) continue
				const content = msg.content
				if (Array.isArray(content)) {
					total += await estimateTokenCount(content, apiHandler)
				} else if (typeof content === "string") {
					total += await estimateTokenCount([{ type: "text", text: content }], apiHandler)
				}
			}
			return total
		}

		const truncationResult = truncateConversation(messages, 0.5, taskId)
		const newContextTokensAfterTruncation = await countModelFacingTokens(truncationResult.messages)

		// Recovery only counts as successful when the recalculated context actually decreased:
		// for short histories the fraction-based message calculation can round down to zero
		// removable messages, and reporting that as a successful truncation retriggers the same
		// over-budget request forever.
		if (truncationResult.messagesRemoved > 0 && newContextTokensAfterTruncation < prevContextTokens) {
			// Include system prompt tokens so this value matches what we send to the API.
			// Note: `prevContextTokens` is computed locally here (totalTokens + lastMessageTokens).
			return {
				messages: truncationResult.messages,
				prevContextTokens,
				summary: "",
				cost,
				error,
				errorDetails,
				truncationId: truncationResult.truncationId,
				messagesRemoved: truncationResult.messagesRemoved,
				newContextTokensAfterTruncation,
			}
		}

		// Zero message-level progress: the history is too short to remove a valid
		// turn/tool pair (e.g. an assistant tool_use followed by one oversized user
		// tool_result). Degrade in place instead — shrink the largest textual tool_result
		// blocks, keeping their tool_use_id and result shape so the pair stays intact.
		const degradedMessages = await shrinkOversizedToolResults({
			messages,
			tokensToFree: prevContextTokens - allowedTokens,
			apiHandler,
		})

		if (degradedMessages) {
			const newContextTokensAfterDegradation = await countModelFacingTokens(degradedMessages)
			if (newContextTokensAfterDegradation < prevContextTokens) {
				return {
					messages: degradedMessages,
					prevContextTokens,
					summary: "",
					cost,
					error,
					errorDetails,
					truncationId: truncationResult.truncationId,
					messagesRemoved: 0,
					newContextTokensAfterTruncation: newContextTokensAfterDegradation,
				}
			}
		}

		// Protected content leaves nothing to remove or shrink: report a controlled failure
		// instead of emitting a successful truncation event that removed zero messages.
		return {
			messages,
			summary: "",
			cost,
			prevContextTokens,
			error: `Context window recovery failed: the conversation (${Math.round(prevContextTokens)} tokens) exceeds the available budget (${Math.round(allowedTokens)} tokens) and no messages can be removed or tool results shrunk further. Reduce the size of individual tool outputs or start a new task.`,
			errorDetails: `Fallback truncation removed 0 messages and no eligible textual tool_result could be shrunk below its floor.`,
		}
	}
	// No truncation or condensation needed
	return { messages, summary: "", cost, prevContextTokens, error, errorDetails }
}
