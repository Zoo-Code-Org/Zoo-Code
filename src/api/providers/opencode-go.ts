import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { opencodeGoDefaultModelId, opencodeGoDefaultModelInfo, OPENCODE_GO_DEFAULT_TEMPERATURE } from "@roo-code/types"

import { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { RouterProvider } from "./router-provider"

/**
 * API handler for the Opencode "Go" subscription plan.
 *
 * Routes requests through the OpenAI-compatible gateway at
 * `https://opencode.ai/zen/go/v1`, delegating model resolution and streaming
 * logic to the shared {@link RouterProvider} base class.
 *
 * Exposes the Go subscription's models as a first-class provider with a dynamic
 * model list (fetched from `/v1/models`) so users can switch models on the fly,
 * instead of configuring each one manually as a separate OpenAI-Compatible
 * provider (#172).
 *
 * Supports text generation, reasoning content (GLM/DeepSeek), tool calls,
 * and non-streaming prompt completion.
 */
export class OpencodeGoHandler extends RouterProvider implements SingleCompletionHandler {
	/** Creates a new handler bound to the user's Go API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: "opencode-go",
			baseURL: "https://opencode.ai/zen/go/v1",
			apiKey: options.opencodeGoApiKey,
			modelId: options.opencodeGoModelId,
			defaultModelId: opencodeGoDefaultModelId,
			defaultModelInfo: opencodeGoDefaultModelInfo,
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
				? (this.options.modelTemperature ?? OPENCODE_GO_DEFAULT_TEMPERATURE)
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

			// Several Go-plan models (GLM, DeepSeek) stream reasoning via this field.
			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield { type: "reasoning", text: (delta.reasoning_content as string | undefined) || "" }
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
	 * @throws Error with an Opencode Go-specific prefix if the request fails.
	 */
	async completePrompt(prompt: string): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? OPENCODE_GO_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens

			const response = await this.client.chat.completions.create(requestOptions)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Opencode Go completion error: ${error.message}`)
			}
			throw error
		}
	}
}
