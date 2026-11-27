import Anthropic from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"
import type { ResponseReasoningItem } from "openai/resources/responses/responses"

import type { ApiMessage } from "../task-persistence"

export type ReasoningItemForRequest = {
	type: "reasoning"
	encrypted_content: string
	id?: string
	summary?: ResponseReasoningItem.Summary[]
}

/** An embedded reasoning block as stored inside assistant message content. */
type ReasoningContentBlock = {
	type: "reasoning"
	text?: string
	encrypted_content?: string
	summary?: ResponseReasoningItem.Summary[]
	id?: string
}

/**
 * The stored block union carries no "reasoning" member; reasoning blocks are
 * an OpenAI Native stored shape that reaches this projection from history.
 * Returns the block as a ReasoningContentBlock when its stored shape matches,
 * undefined otherwise.
 */
function asStoredReasoningBlock(
	block: Anthropic.Messages.ContentBlockParam | undefined,
): ReasoningContentBlock | undefined {
	if (block === undefined || (block as { type?: string }).type !== "reasoning") {
		return undefined
	}
	return block as unknown as ReasoningContentBlock
}

/** An assistant message carrying OpenRouter reasoning_details (Gemini 3 etc.). */
export type AssistantMessageWithReasoningDetails = Anthropic.Messages.MessageParam & {
	reasoning_details: NonNullable<ApiMessage["reasoning_details"]>
}

export type CleanConversationHistoryItem =
	Anthropic.Messages.MessageParam | ReasoningItemForRequest | AssistantMessageWithReasoningDetails

/**
 * Projects stored API history into the exact item sequence a normal task
 * request sends.
 *
 * Standalone reasoning messages become request reasoning items (encrypted
 * content is sent, plain text is skipped), assistant messages carrying an
 * embedded reasoning first block are split so the reasoning rides as its own
 * item, and OpenRouter reasoning_details are carried on the assistant
 * message. The task loop and the condense request both use this projection so
 * both send the same wire prefix (issue 2453).
 */
export function buildCleanConversationHistory(
	messages: ApiMessage[],
	requestModelInfo: ModelInfo,
): CleanConversationHistoryItem[] {
	const cleanConversationHistory: CleanConversationHistoryItem[] = []

	for (const msg of messages) {
		// Standalone reasoning: send encrypted, skip plain text
		if (msg.type === "reasoning") {
			if (msg.encrypted_content) {
				cleanConversationHistory.push({
					type: "reasoning",
					summary: msg.summary,
					encrypted_content: msg.encrypted_content!,
					...(msg.id ? { id: msg.id } : {}),
				})
			}
			continue
		}

		// Preferred path: assistant message with embedded reasoning as first content block
		if (msg.role === "assistant") {
			const rawContent = msg.content

			const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
				? (rawContent as Anthropic.Messages.ContentBlockParam[])
				: rawContent !== undefined
					? ([
							{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
						] as Anthropic.Messages.ContentBlockParam[])
					: []

			const [first, ...rest] = contentArray

			// Check if this message has reasoning_details (OpenRouter format for Gemini 3, etc.)
			const msgWithDetails = msg
			if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
				// Build the assistant message with reasoning_details
				let assistantContent: Anthropic.Messages.MessageParam["content"]

				if (contentArray.length === 0) {
					assistantContent = ""
				} else if (contentArray.length === 1 && contentArray[0].type === "text") {
					assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
				} else {
					assistantContent = contentArray
				}

				// Create message with reasoning_details property
				const messageWithDetails: AssistantMessageWithReasoningDetails = {
					role: "assistant",
					content: assistantContent,
					reasoning_details: msgWithDetails.reasoning_details,
				}
				cleanConversationHistory.push(messageWithDetails)

				continue
			}

			// Embedded reasoning: encrypted (send) or plain text (skip)
			const reasoningFirst = asStoredReasoningBlock(first)
			const encryptedContent = reasoningFirst !== undefined ? reasoningFirst.encrypted_content : undefined
			const hasPlainTextReasoning = reasoningFirst !== undefined && typeof reasoningFirst.text === "string"

			if (typeof encryptedContent === "string" && reasoningFirst !== undefined) {
				const reasoningBlock = reasoningFirst

				// Send as separate reasoning item (OpenAI Native)
				cleanConversationHistory.push({
					type: "reasoning",
					summary: reasoningBlock.summary ?? [],
					encrypted_content: encryptedContent,
					...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
				})

				// Send assistant message without reasoning
				let assistantContent: Anthropic.Messages.MessageParam["content"]

				if (rest.length === 0) {
					assistantContent = ""
				} else if (rest.length === 1 && rest[0].type === "text") {
					assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
				} else {
					assistantContent = rest
				}

				cleanConversationHistory.push({
					role: "assistant",
					content: assistantContent,
				} satisfies Anthropic.Messages.MessageParam)

				continue
			} else if (hasPlainTextReasoning) {
				// Check if the model's preserveReasoning flag is set, resolved from
				// the request's threaded model snapshot (same per-request source as
				// the prompt and tool arrays) rather than a fresh getModel() re-read,
				// so a mid-request metadata refresh cannot change what this request sends.
				// If true, include the reasoning block in API requests
				// If false/undefined, strip it out (stored for history only, not sent back to API)
				const shouldPreserveForApi = requestModelInfo.preserveReasoning === true
				let assistantContent: Anthropic.Messages.MessageParam["content"]

				if (shouldPreserveForApi) {
					// Include reasoning block in the content sent to API
					assistantContent = contentArray
				} else {
					// Strip reasoning out - stored for history only, not sent back to API
					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}
				}

				cleanConversationHistory.push({
					role: "assistant",
					content: assistantContent,
				} satisfies Anthropic.Messages.MessageParam)

				continue
			}
		}

		// Default path for regular messages (no embedded reasoning)
		if (msg.role) {
			cleanConversationHistory.push({
				role: msg.role,
				content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
			})
		}
	}

	return cleanConversationHistory
}
