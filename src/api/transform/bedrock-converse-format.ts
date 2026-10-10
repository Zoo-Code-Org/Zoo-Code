import { Anthropic } from "@anthropic-ai/sdk"
import { ConversationRole, Message, ContentBlock } from "@aws-sdk/client-bedrock-runtime"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"

interface BedrockMessageContent {
	type: "text" | "image" | "video" | "tool_use" | "tool_result" | "reasoning" | "thinking"
	text?: string
	thinking?: string
	source?: {
		type: "base64"
		data: string | Uint8Array // string for Anthropic, Uint8Array for Bedrock
		media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
	}
	// Video specific fields
	format?: string
	s3Location?: {
		uri: string
		bucketOwner?: string
	}
	// Tool use and result fields
	toolUseId?: string
	name?: string
	input?: any
	output?: any // Used for tool_result type
}

/**
 * Convert Anthropic messages to Bedrock Converse format
 * @param anthropicMessages Messages in Anthropic format
 * @param options.preserveReasoning Replay reasoning/thinking blocks as `reasoningContent`.
 *   Otherwise they are dropped, matching Task's stripping for models without `preserveReasoning`.
 */
export function convertToBedrockConverseMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	{ preserveReasoning = false }: { preserveReasoning?: boolean } = {},
): Message[] {
	return anthropicMessages.map((anthropicMessage) => {
		// Map Anthropic roles to Bedrock roles
		const role: ConversationRole = anthropicMessage.role === "assistant" ? "assistant" : "user"

		if (typeof anthropicMessage.content === "string") {
			return {
				role,
				content: [
					{
						text: anthropicMessage.content,
					},
				] as ContentBlock[],
			}
		}

		// Signed thinking blocks (e.g. from MiniMax) bypass Task's reasoning filter, so they can reach
		// any Bedrock model after a provider switch. Unsigned reasoning is only safe for models that
		// opt in; Claude would receive thinking it cannot verify.
		const blocks = preserveReasoning
			? anthropicMessage.content
			: anthropicMessage.content.filter((block) => {
					const type = (block as { type: string }).type
					return type !== "reasoning" && type !== "thinking"
				})

		// Process complex content types
		const content = blocks.map((block) => {
			const messageBlock = block as BedrockMessageContent & {
				id?: string
				tool_use_id?: string
				content?: string | Array<{ type: string; text: string }>
				output?: string | Array<{ type: string; text: string }>
			}

			if (messageBlock.type === "text") {
				return {
					text: messageBlock.text || "",
				} as ContentBlock
			}

			if (messageBlock.type === "reasoning" && typeof messageBlock.text === "string") {
				return {
					reasoningContent: {
						reasoningText: { text: messageBlock.text },
					},
				} as ContentBlock
			}

			if (messageBlock.type === "thinking" && typeof messageBlock.thinking === "string") {
				// Bedrock does not capture its own signatures, so any stored signature was issued by
				// another provider (e.g. MiniMax) and would fail Bedrock's verification. Unsigned
				// reasoning is accepted (`signature` is optional), so replay the text only.
				return {
					reasoningContent: {
						reasoningText: { text: messageBlock.thinking },
					},
				} as ContentBlock
			}

			if (messageBlock.type === "image" && messageBlock.source) {
				// Convert base64 string to byte array if needed
				let byteArray: Uint8Array
				if (typeof messageBlock.source.data === "string") {
					const binaryString = atob(messageBlock.source.data)
					byteArray = new Uint8Array(binaryString.length)
					for (let i = 0; i < binaryString.length; i++) {
						byteArray[i] = binaryString.charCodeAt(i)
					}
				} else {
					byteArray = messageBlock.source.data
				}

				// Extract format from media_type (e.g., "image/jpeg" -> "jpeg")
				const format = messageBlock.source.media_type.split("/")[1]
				if (!["png", "jpeg", "gif", "webp"].includes(format)) {
					throw new Error(`Unsupported image format: ${format}`)
				}

				return {
					image: {
						format: format as "png" | "jpeg" | "gif" | "webp",
						source: {
							bytes: byteArray,
						},
					},
				} as ContentBlock
			}

			if (messageBlock.type === "tool_use") {
				// Native-only: keep input as JSON object for Bedrock's toolUse format
				return {
					toolUse: {
						toolUseId: sanitizeOpenAiCallId(messageBlock.id || ""),
						name: messageBlock.name || "",
						input: messageBlock.input || {},
					},
				} as ContentBlock
			}

			if (messageBlock.type === "tool_result") {
				// Handle content field - can be string or array (native tool format)
				if (messageBlock.content) {
					// Content is a string
					if (typeof messageBlock.content === "string") {
						return {
							toolResult: {
								toolUseId: sanitizeOpenAiCallId(messageBlock.tool_use_id || ""),
								content: [
									{
										text: messageBlock.content,
									},
								],
								status: "success",
							},
						} as ContentBlock
					}
					// Content is an array of content blocks
					if (Array.isArray(messageBlock.content)) {
						return {
							toolResult: {
								toolUseId: sanitizeOpenAiCallId(messageBlock.tool_use_id || ""),
								content: messageBlock.content.map((item) => ({
									text: typeof item === "string" ? item : item.text || String(item),
								})),
								status: "success",
							},
						} as ContentBlock
					}
				}

				// Fall back to output handling if content is not available
				if (messageBlock.output && typeof messageBlock.output === "string") {
					return {
						toolResult: {
							toolUseId: sanitizeOpenAiCallId(messageBlock.tool_use_id || ""),
							content: [
								{
									text: messageBlock.output,
								},
							],
							status: "success",
						},
					} as ContentBlock
				}
				// Handle array of content blocks if output is an array
				if (Array.isArray(messageBlock.output)) {
					return {
						toolResult: {
							toolUseId: sanitizeOpenAiCallId(messageBlock.tool_use_id || ""),
							content: messageBlock.output.map((part) => {
								if (typeof part === "object" && "text" in part) {
									return { text: part.text }
								}
								// Skip images in tool results as they're handled separately
								if (typeof part === "object" && "type" in part && part.type === "image") {
									return { text: "(see following message for image)" }
								}
								return { text: String(part) }
							}),
							status: "success",
						},
					} as ContentBlock
				}

				// Default case
				return {
					toolResult: {
						toolUseId: sanitizeOpenAiCallId(messageBlock.tool_use_id || ""),
						content: [
							{
								text: String(messageBlock.output || ""),
							},
						],
						status: "success",
					},
				} as ContentBlock
			}

			if (messageBlock.type === "video") {
				const videoContent = messageBlock.s3Location
					? {
							s3Location: {
								uri: messageBlock.s3Location.uri,
								bucketOwner: messageBlock.s3Location.bucketOwner,
							},
						}
					: messageBlock.source

				return {
					video: {
						format: "mp4", // Default to mp4, adjust based on actual format if needed
						source: videoContent,
					},
				} as ContentBlock
			}

			// Default case for unknown block types
			return {
				text: "[Unknown Block Type]",
			} as ContentBlock
		})

		return {
			role,
			// Bedrock rejects an empty content array; a reasoning-only turn becomes empty text.
			content:
				content.length === 0 && anthropicMessage.content.length > 0
					? ([{ text: "" }] as ContentBlock[])
					: content,
		}
	})
}
