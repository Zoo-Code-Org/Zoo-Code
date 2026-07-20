import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	kenariDefaultModelId,
	kenariDefaultModelInfo,
	KENARI_DEFAULT_TEMPERATURE,
	KENARI_BASE_URL,
} from "@roo-code/types"

import { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { RouterProvider } from "./router-provider"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

/**
 * API handler for Kenari, an Indonesian OpenAI-compatible AI gateway billed
 * in Rupiah (IDR).
 *
 * Routes requests through the OpenAI-compatible gateway at
 * `https://kenari.id/v1`, delegating model resolution and streaming logic to
 * the shared {@link RouterProvider} base class.
 *
 * One kn- API key covers Claude, GPT, DeepSeek, GLM, Kimi and more, exposed
 * as a first-class provider with a dynamic model list (fetched from
 * `/v1/models`) so users can switch models on the fly.
 *
 * Supports text generation, reasoning content (GLM/DeepSeek), tool calls,
 * and non-streaming prompt completion.
 */
export class KenariHandler extends RouterProvider implements SingleCompletionHandler {
	/** Creates a new handler bound to the user's kn- API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: "kenari",
			baseURL: KENARI_BASE_URL,
			apiKey: options.kenariApiKey,
			modelId: options.kenariModelId,
			defaultModelId: kenariDefaultModelId,
			defaultModelInfo: kenariDefaultModelInfo,
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
			temperature: this.supportsTemperature(modelId)
				? (this.options.modelTemperature ?? KENARI_DEFAULT_TEMPERATURE)
				: undefined,
			max_completion_tokens: info.maxTokens,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		const completion = await this.client.chat.completions.create(body)

		for await (const chunk of completion) {
			const delta = chunk.choices[0]?.delta

			if (delta?.content) {
				yield { type: "text", text: delta.content }
			}

			// Several Kenari models (GLM, DeepSeek) stream reasoning via reasoning_content,
			// with an OpenRouter-style `reasoning` fallback; the shared helper handles both.
			const reasoningText = extractReasoningFromDelta(delta)
			if (reasoningText) {
				yield { type: "reasoning", text: reasoningText }
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
	 * @throws Error with a Kenari-specific prefix if the request fails.
	 */
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? KENARI_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Kenari completion error: ${error.message}`)
			}
			throw error
		}
	}
}
