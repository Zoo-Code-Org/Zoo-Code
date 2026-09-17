import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	IO_INTELLIGENCE_BASE_URL,
	ioIntelligenceDefaultModelId,
	ioIntelligenceDefaultModelInfo,
	providerIdentifiers,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type { ApiHandlerCreateMessageMetadata, CompletePromptOptions, SingleCompletionHandler } from "../index"
import { RouterProvider } from "./router-provider"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

/**
 * IO Intelligence (io.net) provider.
 *
 * OpenAI-compatible Chat Completions endpoint:
 * https://api.intelligence.io.solutions/api/v1/chat/completions
 *
 * Model ids are Hugging Face-style `org/name` identifiers and are resolved
 * dynamically from the public /models endpoint, with a static fallback
 * catalog. Supports text generation, reasoning content (DeepSeek/GLM style),
 * tool calls, and non-streaming prompt completion.
 */
export class IOIntelligenceHandler extends RouterProvider implements SingleCompletionHandler {
	/** Creates a new handler bound to the user's API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: providerIdentifiers.ioIntelligence,
			baseURL: IO_INTELLIGENCE_BASE_URL,
			apiKey: options.ioIntelligenceApiKey,
			modelId: options.ioIntelligenceModelId,
			defaultModelId: ioIntelligenceDefaultModelId,
			defaultModelInfo: ioIntelligenceDefaultModelInfo,
		})
	}

	private createSafeError(operation: string, error: unknown): Error {
		return handleProviderError(error, "IO Intelligence", {
			messagePrefix: operation,
			messageTransformer: (message) =>
				this.options.ioIntelligenceApiKey
					? `IO Intelligence ${operation} error: ${message.replaceAll(this.options.ioIntelligenceApiKey, "[REDACTED]")}`
					: `IO Intelligence ${operation} error: ${message}`,
		})
	}

	/**
	 * Streams a chat completion response, yielding typed chunks for text,
	 * reasoning, partial tool calls, and token usage.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info } = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const body: OpenAI.Chat.ChatCompletionCreateParams = {
			model: modelId,
			messages: openAiMessages,
			max_tokens: info.maxTokens,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		if (this.supportsTemperature(modelId)) {
			body.temperature = this.options.modelTemperature
		}

		let completion: Awaited<ReturnType<typeof this.client.chat.completions.create>>
		try {
			completion = await this.client.chat.completions.create(body, { signal: metadata?.abortSignal })
		} catch (error) {
			throw this.createSafeError("streaming", error)
		}

		for await (const chunk of completion) {
			const delta = chunk.choices[0]?.delta

			// Reasoning models (DeepSeek R1, GLM) stream reasoning via
			// reasoning_content with an OpenRouter-style `reasoning` fallback.
			const reasoningText = extractReasoningFromDelta(delta)
			if (reasoningText) {
				yield { type: "reasoning", text: reasoningText }
			}

			if (delta?.content) {
				yield { type: "text", text: delta.content }
			}

			// Emit raw tool call chunks - NativeToolCallParser handles state management.
			if (delta?.tool_calls) {
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
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || undefined,
				}
			}
		}
	}

	/**
	 * Performs a non-streaming chat completion and returns the full response text.
	 *
	 * @param prompt - The user prompt to send as a single user message.
	 * @returns The model's reply text, or an empty string if no content is returned.
	 * @throws Error with an IO Intelligence prefix if the request fails.
	 */
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				max_tokens: info.maxTokens,
				stream: false,
			}

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			throw this.createSafeError("completion", error)
		}
	}
}
