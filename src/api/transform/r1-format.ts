import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { sanitizeIdentifierSurrogates, sanitizeSurrogates, sanitizeSurrogatesDeep } from "./sanitize-surrogates"

type ContentPartText = OpenAI.Chat.ChatCompletionContentPartText
type ContentPartImage = OpenAI.Chat.ChatCompletionContentPartImage
type UserMessage = OpenAI.Chat.ChatCompletionUserMessageParam
type AssistantMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam
type ToolMessage = OpenAI.Chat.ChatCompletionToolMessageParam
type Message = OpenAI.Chat.ChatCompletionMessageParam
type AnthropicMessage = Anthropic.Messages.MessageParam

/**
 * Extended assistant message type to support DeepSeek's interleaved thinking.
 * DeepSeek's API returns reasoning_content alongside content and tool_calls,
 * and requires it to be passed back in subsequent requests within the same turn.
 */
export type DeepSeekAssistantMessage = AssistantMessage & {
	reasoning_content?: string
}

/**
 * Converts Anthropic messages to OpenAI format while merging consecutive messages with the same role.
 * This is required for DeepSeek Reasoner which does not support successive messages with the same role.
 *
 * For DeepSeek's interleaved thinking mode:
 * - Preserves reasoning_content on assistant messages for tool call continuations
 * - Tool result messages are converted to OpenAI tool messages
 * - reasoning_content from previous assistant messages is preserved until a new user turn
 * - Text content after tool_results (like environment_details) is merged into the last tool message
 *   to avoid creating user messages that would cause reasoning_content to be dropped
 *
 * @param messages Array of Anthropic messages
 * @param options Optional configuration for message conversion
 * @param options.mergeToolResultText If true, merge text content after tool_results into the last
 *                                     tool message instead of creating a separate user message.
 *                                     This is critical for DeepSeek's interleaved thinking mode.
 * @returns Array of OpenAI messages where consecutive messages with the same role are combined
 */
export function convertToR1Format(
	messages: AnthropicMessage[],
	options?: {
		mergeToolResultText?: boolean
		normalizeToolCallId?: (id: string) => string
	},
): Message[] {
	const result: Message[] = []

	// Compose any caller-provided id normalization with injective surrogate sanitization:
	// a lone UTF-16 surrogate anywhere in the JSON body makes DeepSeek reject the whole
	// request ("lone leading surrogate in hex escape"), and the injective variant keeps a
	// tool_use id paired with its tool_result. See #461.
	const normalizeId = (id: string) =>
		sanitizeIdentifierSurrogates(options?.normalizeToolCallId ? options.normalizeToolCallId(id) : id)

	for (const message of messages) {
		// Check if the message has reasoning_content (for DeepSeek interleaved thinking)
		const messageWithReasoning = message as AnthropicMessage & { reasoning_content?: string }
		const reasoningContent = messageWithReasoning.reasoning_content
			? sanitizeSurrogates(messageWithReasoning.reasoning_content)
			: messageWithReasoning.reasoning_content

		if (message.role === "user") {
			// Handle user messages - may contain tool_result blocks
			if (Array.isArray(message.content)) {
				const textParts: string[] = []
				const imageParts: ContentPartImage[] = []
				const toolResults: { tool_use_id: string; content: string }[] = []

				for (const part of message.content) {
					if (part.type === "text") {
						textParts.push(sanitizeSurrogates(part.text))
					} else if (part.type === "image") {
						if (part.source.type === "base64") {
							imageParts.push({
								type: "image_url",
								image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
							})
						}
					} else if (part.type === "tool_result") {
						// Convert tool_result to OpenAI tool message format
						let content: string
						if (typeof part.content === "string") {
							content = sanitizeSurrogates(part.content)
						} else if (Array.isArray(part.content)) {
							content =
								part.content
									?.map((c) => {
										if (c.type === "text") return sanitizeSurrogates(c.text)
										if (c.type === "image") return "(image)"
										return ""
									})
									.join("\n") ?? ""
						} else {
							content = ""
						}
						toolResults.push({
							tool_use_id: part.tool_use_id,
							content,
						})
					}
				}

				// Add tool messages first (they must follow assistant tool_use)
				for (const toolResult of toolResults) {
					const toolMessage: ToolMessage = {
						role: "tool",
						tool_call_id: normalizeId(toolResult.tool_use_id),
						content: toolResult.content,
					}
					result.push(toolMessage)
				}

				// Handle text/image content after tool results
				if (textParts.length > 0 || imageParts.length > 0) {
					// For DeepSeek interleaved thinking: when mergeToolResultText is enabled and we have
					// tool results followed by text, merge the text into the last tool message to avoid
					// creating a user message that would cause reasoning_content to be dropped.
					// This is critical because DeepSeek drops all reasoning_content when it sees a user message.
					const shouldMergeIntoToolMessage =
						options?.mergeToolResultText && toolResults.length > 0 && imageParts.length === 0

					if (shouldMergeIntoToolMessage) {
						// Merge text content into the last tool message
						const lastToolMessage = result[result.length - 1] as ToolMessage
						if (lastToolMessage?.role === "tool") {
							const additionalText = textParts.join("\n")
							lastToolMessage.content = `${lastToolMessage.content}\n\n${additionalText}`
						}
					} else {
						// Standard behavior: add user message with text/image content
						let content: UserMessage["content"]
						if (imageParts.length > 0) {
							const parts: (ContentPartText | ContentPartImage)[] = []
							if (textParts.length > 0) {
								parts.push({ type: "text", text: textParts.join("\n") })
							}
							parts.push(...imageParts)
							content = parts
						} else {
							content = textParts.join("\n")
						}

						// Check if we can merge with the last message
						const lastMessage = result[result.length - 1]
						if (lastMessage?.role === "user") {
							// Merge with existing user message
							if (typeof lastMessage.content === "string" && typeof content === "string") {
								lastMessage.content += `\n${content}`
							} else {
								const lastContent = Array.isArray(lastMessage.content)
									? lastMessage.content
									: [{ type: "text" as const, text: lastMessage.content || "" }]
								const newContent = Array.isArray(content)
									? content
									: [{ type: "text" as const, text: content }]
								lastMessage.content = [...lastContent, ...newContent] as UserMessage["content"]
							}
						} else {
							result.push({ role: "user", content })
						}
					}
				}
			} else {
				// Simple string content
				const safeContent = sanitizeSurrogates(message.content)
				const lastMessage = result[result.length - 1]
				if (lastMessage?.role === "user") {
					if (typeof lastMessage.content === "string") {
						lastMessage.content += `\n${safeContent}`
					} else {
						;(lastMessage.content as (ContentPartText | ContentPartImage)[]).push({
							type: "text",
							text: safeContent,
						})
					}
				} else {
					result.push({ role: "user", content: safeContent })
				}
			}
		} else if (message.role === "assistant") {
			// Handle assistant messages - may contain tool_use blocks and reasoning blocks
			if (Array.isArray(message.content)) {
				const textParts: string[] = []
				const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
				let extractedReasoning: string | undefined

				for (const part of message.content) {
					if (part.type === "text") {
						textParts.push(sanitizeSurrogates(part.text))
					} else if (part.type === "tool_use") {
						toolCalls.push({
							id: normalizeId(part.id),
							type: "function",
							function: {
								name: sanitizeSurrogates(part.name),
								// Deep-sanitized: a lone surrogate anywhere in the payload makes
								// DeepSeek reject the whole request. See #461.
								arguments: JSON.stringify(sanitizeSurrogatesDeep(part.input)),
							},
						})
					} else if ((part as any).type === "reasoning" && (part as any).text) {
						// Extract reasoning from content blocks (Task stores it this way)
						extractedReasoning = sanitizeSurrogates((part as any).text)
					}
				}

				// Use reasoning from content blocks if not provided at top level
				const finalReasoning = reasoningContent || extractedReasoning

				const assistantMessage: DeepSeekAssistantMessage = {
					role: "assistant",
					content: textParts.length > 0 ? textParts.join("\n") : null,
					...(toolCalls.length > 0 && { tool_calls: toolCalls }),
					// Preserve reasoning_content for DeepSeek interleaved thinking
					...(finalReasoning && { reasoning_content: finalReasoning }),
				}

				// Check if we can merge with the last message (only if no tool calls)
				const lastMessage = result[result.length - 1]
				if (lastMessage?.role === "assistant" && !toolCalls.length && !(lastMessage as any).tool_calls) {
					// Merge text content
					if (typeof lastMessage.content === "string" && typeof assistantMessage.content === "string") {
						lastMessage.content += `\n${assistantMessage.content}`
					} else if (assistantMessage.content) {
						const lastContent = lastMessage.content || ""
						lastMessage.content = `${lastContent}\n${assistantMessage.content}`
					}
					// Preserve reasoning_content from the new message if present
					if (finalReasoning) {
						;(lastMessage as DeepSeekAssistantMessage).reasoning_content = finalReasoning
					}
				} else {
					result.push(assistantMessage)
				}
			} else {
				// Simple string content
				const safeContent = sanitizeSurrogates(message.content)
				const lastMessage = result[result.length - 1]
				if (lastMessage?.role === "assistant" && !(lastMessage as any).tool_calls) {
					if (typeof lastMessage.content === "string") {
						lastMessage.content += `\n${safeContent}`
					} else {
						lastMessage.content = safeContent
					}
					// Preserve reasoning_content from the new message if present
					if (reasoningContent) {
						;(lastMessage as DeepSeekAssistantMessage).reasoning_content = reasoningContent
					}
				} else {
					const assistantMessage: DeepSeekAssistantMessage = {
						role: "assistant",
						content: safeContent,
						...(reasoningContent && { reasoning_content: reasoningContent }),
					}
					result.push(assistantMessage)
				}
			}
		}
	}

	return result
}
