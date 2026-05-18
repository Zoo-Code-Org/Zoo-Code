import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { mimoModels, mimoDefaultModelId, MIMO_DEFAULT_TEMPERATURE, type ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { getModelParams } from "../transform/model-params"
import { calculateApiCostOpenAI } from "../../shared/cost"

import { OpenAiHandler } from "./openai"
import type { ApiHandlerCreateMessageMetadata } from "../index"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"

/**
 * MiMoHandler extends OpenAiHandler with MiMo-specific adaptations.
 *
 * CRITICAL: Per MiMo's official docs, reasoning_content MUST be passed back
 * in multi-turn conversations with tool calls. Without it, the API returns 400.
 *
 * Reference: https://platform.xiaomimimo.com/#/docs/usage-guide/passing-back-reasoning_content
 */
export class MimoHandler extends OpenAiHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			openAiApiKey: options.mimoApiKey ?? "not-provided",
			openAiModelId: options.apiModelId ?? mimoDefaultModelId,
			openAiBaseUrl: options.mimoBaseUrl || "https://token-plan-sgp.xiaomimimo.com/v1",
			openAiStreamingEnabled: true,
			includeMaxTokens: false,
		})
	}

	/**
	 * Maps the configured model ID to its MiMo model info and parameters.
	 * Falls back to the default model (mimo-v2.5-pro) if the stored ID
	 * doesn't match any known model — this can happen when users manually
	 * type a model name in settings.
	 */
	override getModel() {
		const id = this.options.apiModelId ?? mimoDefaultModelId
		const info: ModelInfo = mimoModels[id as keyof typeof mimoModels] || mimoModels[mimoDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: MIMO_DEFAULT_TEMPERATURE,
		})
		return { id, info, ...params }
	}

	/**
	 * Strip OpenAI-specific extensions that MiMo's proxy rejects:
	 * - strict: true on tools
	 * - additionalProperties: false on schemas
	 */
	protected override convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			return {
				type: "function",
				function: {
					name: tool.function.name,
					description: tool.function.description,
					parameters: this.stripOpenAiExtensions(tool.function.parameters),
				},
			}
		})
	}

	/**
	 * Recursively walks a JSON Schema object and removes OpenAI-specific
	 * fields (additionalProperties, strict) that MiMo's proxy doesn't
	 * recognize. Without this, every tool call would 400.
	 */
	private stripOpenAiExtensions(schema: any): any {
		if (!schema || typeof schema !== "object") {
			return schema
		}

		const { additionalProperties, ...rest } = schema

		if (rest.properties) {
			const newProps: Record<string, any> = {}
			for (const [key, prop] of Object.entries(rest.properties)) {
				newProps[key] = this.stripOpenAiExtensions(prop)
			}
			rest.properties = newProps
		}

		if (rest.items && typeof rest.items === "object") {
			rest.items = this.stripOpenAiExtensions(rest.items)
		}

		return rest
	}

	/**
	 * Convert Anthropic messages to MiMo-compatible OpenAI format.
	 *
	 * CRITICAL: Extracts `type: "reasoning"` content blocks from Anthropic
	 * messages and converts them to `reasoning_content` field in OpenAI
	 * assistant messages. MiMo REQUIRES this for multi-turn tool calling.
	 */
	private convertMessagesForMiMo(
		anthropicMessages: Anthropic.Messages.MessageParam[],
	): OpenAI.Chat.ChatCompletionMessageParam[] {
		const converted: OpenAI.Chat.ChatCompletionMessageParam[] = []

		for (const msg of anthropicMessages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				// Extract reasoning content from Anthropic content blocks
				const reasoningParts: string[] = []
				const textParts: string[] = []
				const toolUseParts: Anthropic.ToolUseBlockParam[] = []

				for (const block of msg.content) {
					if ((block as any).type === "reasoning") {
						reasoningParts.push((block as any).text || "")
					} else if (block.type === "text") {
						textParts.push(block.text)
					} else if (block.type === "tool_use") {
						toolUseParts.push(block)
					}
				}

				// Build OpenAI assistant message with reasoning_content
				const assistantMsg: any = {
					role: "assistant",
					content: textParts.join("\n") || "",
				}

				// CRITICAL: Add reasoning_content if present
				if (reasoningParts.length > 0) {
					assistantMsg.reasoning_content = reasoningParts.join("\n")
				}

				// Add tool_calls if present
				if (toolUseParts.length > 0) {
					assistantMsg.tool_calls = toolUseParts.map((block) => ({
						id: sanitizeOpenAiCallId(block.id),
						type: "function" as const,
						function: {
							name: block.name,
							arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
						},
					}))
				}

				converted.push(assistantMsg)
			} else if (msg.role === "assistant" && typeof msg.content === "string") {
				const assistantMsg: any = {
					role: "assistant",
					content: msg.content,
				}
				const reasoningContent = (msg as any).reasoning_content
				if (typeof reasoningContent === "string" && reasoningContent.trim()) {
					assistantMsg.reasoning_content = reasoningContent
				}
				converted.push(assistantMsg)
			} else if (msg.role === "user" && Array.isArray(msg.content)) {
				// Process user messages: separate tool_results, text, and media
				const toolResults: Anthropic.ToolResultBlockParam[] = []
				const textBlocks: string[] = []
				const mediaParts: any[] = []

				for (const block of msg.content) {
					if (block.type === "tool_result") {
						toolResults.push(block)
					} else if (block.type === "text") {
						textBlocks.push(block.text)
					} else if (block.type === "image") {
						// Convert Anthropic image block to OpenAI image_url format
						const src = (block as any).source
						if (src?.type === "base64" && src?.media_type) {
							mediaParts.push({
								type: "image_url",
								image_url: { url: `data:${src.media_type};base64,${src.data}` },
							})
						} else if (src?.type === "url") {
							mediaParts.push({
								type: "image_url",
								image_url: { url: src.url },
							})
						}
					}
					// audio/video blocks are not supported in OpenAI chat format — skip silently
				}

				// Add tool results as role:"tool" messages (MiMo supports this)
				for (const tr of toolResults) {
					let content: string
					if (typeof tr.content === "string") {
						content = tr.content
					} else if (Array.isArray(tr.content)) {
						content = tr.content.map((p: any) => (p.type === "text" ? p.text : "")).join("\n")
					} else {
						content = ""
					}

					converted.push({
						role: "tool",
						tool_call_id: sanitizeOpenAiCallId(tr.tool_use_id),
						content: content || "(empty)",
					})
				}

				// Build user message content — plain string or multimodal array
				if (mediaParts.length > 0) {
					const content: any[] = []
					if (textBlocks.length > 0) {
						content.push({ type: "text", text: textBlocks.join("\n") })
					}
					content.push(...mediaParts)
					converted.push({ role: "user", content })
				} else if (textBlocks.length > 0) {
					converted.push({ role: "user", content: textBlocks.join("\n") })
				}
			} else if (msg.role === "user" && typeof msg.content === "string") {
				converted.push({
					role: "user",
					content: msg.content,
				})
			}
		}

		return converted
	}

	/**
	 * Streams a chat completion from MiMo's OpenAI-compatible API.
	 *
	 * Key differences from the base OpenAiHandler:
	 * - Uses convertMessagesForMiMo instead of convertToOpenAiMessages to
	 *   preserve reasoning_content in the conversation history.
	 * - Enables thinking mode via extra_body.thinking.
	 * - Includes stream_options.include_usage for cost tracking.
	 * - Strips OpenAI-specific fields from tool definitions.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info: modelInfo, temperature } = this.getModel()

		// Use custom conversion that preserves reasoning_content
		const convertedMessages = this.convertMessagesForMiMo(messages)

		const tools = this.convertToolsForOpenAI(metadata?.tools)

		// Build request per MiMo's OpenAI-compatible API
		// https://developer.puter.com/ai/xiaomi/mimo-v2.5-pro/
		const params: Record<string, any> = {
			model: modelId,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertedMessages],
			stream: true,
			stream_options: { include_usage: true },
			// MiMo requires thinking to be enabled via extra_body
			extra_body: { thinking: { type: "enabled" } },
		}

		if (tools && tools.length > 0) {
			params.tools = tools
		}

		let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
		try {
			stream = (await this.client.chat.completions.create(params as any)) as any
		} catch (error) {
			const { handleProviderError } = await import("./utils/error-handler")
			throw handleProviderError(error, "MiMo")
		}

		let lastUsage: OpenAI.CompletionUsage | undefined

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta ?? {}

			if (delta.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if ("reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					text: (delta.reasoning_content as string) || "",
				}
			}

			if (delta.tool_calls) {
				for (const toolCall of delta.tool_calls) {
					yield {
						type: "tool_call_partial",
						index: toolCall.index,
						id: toolCall.id,
						name: toolCall.function?.name,
						arguments: toolCall.function?.arguments,
					}
				}
			}

			if (chunk.usage) {
				lastUsage = chunk.usage
			}
		}

		if (lastUsage) {
			const inputTokens = lastUsage?.prompt_tokens || 0
			const outputTokens = lastUsage?.completion_tokens || 0
			const cacheWriteTokens = (lastUsage?.prompt_tokens_details as any)?.cache_write_tokens || 0
			const cacheReadTokens = lastUsage?.prompt_tokens_details?.cached_tokens || 0

			const { totalCost } = calculateApiCostOpenAI(
				modelInfo,
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
			)

			yield {
				type: "usage",
				inputTokens,
				outputTokens,
				cacheWriteTokens: cacheWriteTokens || undefined,
				cacheReadTokens: cacheReadTokens || undefined,
				totalCost,
			}
		}
	}
}
