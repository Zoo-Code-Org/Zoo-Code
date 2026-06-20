import { Anthropic } from "@anthropic-ai/sdk"
import { CacheControlEphemeral } from "@anthropic-ai/sdk/resources"
import OpenAI from "openai"

import {
	type ModelInfo,
	opencodeGoDefaultModelId,
	opencodeGoDefaultModelInfo,
	OPENCODE_GO_DEFAULT_TEMPERATURE,
	isOpencodeGoAnthropicFormatModel,
} from "@roo-code/types"

import { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { filterNonAnthropicBlocks } from "../transform/anthropic-filter"
import { getModelParams } from "../transform/model-params"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { RouterProvider } from "./router-provider"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { DEFAULT_HEADERS } from "./constants"
import { calculateApiCostAnthropic } from "../../shared/cost"
import {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../core/prompts/tools/native-tools/converters"

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
 * Model metadata (context window, max tokens, capability flags, and pricing)
 * is sourced from the native registry in `@roo-code/types` and merged with the
 * live `/models` payload, so each curated model keeps its correct native
 * configuration — including `supportsReasoningEffort`, `preserveReasoning`,
 * `supportsMaxTokens`, and prompt-cache support — instead of falling back to a
 * single generic default.
 *
 * ## Wire-format routing
 *
 * The Go gateway exposes two wire formats and maps every model to exactly one
 * of them (see https://opencode.ai/docs/go):
 *
 *   - OpenAI-compatible chat completions (`/v1/chat/completions`, "oa-compat")
 *     — used by GLM, Kimi, DeepSeek, and MiMo models.
 *   - Anthropic Messages (`/v1/messages`) — used by Qwen (qwen3.7-max,
 *     qwen3.7-plus, qwen3.6-plus) and MiniMax (minimax-m3, minimax-m2.7,
 *     minimax-m2.5) models.
 *
 * Sending an Anthropic-format model to the chat completions endpoint is
 * rejected with `401 Model <id> is not supported for format oa-compat`, so this
 * handler inspects {@link isOpencodeGoAnthropicFormatModel} and routes those
 * models through a dedicated Anthropic SDK client against `/v1/messages`.
 *
 * Supports text generation, reasoning content (GLM/DeepSeek), tool calls,
 * and non-streaming prompt completion.
 */
export class OpencodeGoHandler extends RouterProvider implements SingleCompletionHandler {
	/**
	 * Anthropic SDK client used for Go models that only accept the Anthropic
	 * Messages wire format (`/v1/messages`).
	 *
	 * The SDK appends `/v1/messages` to `baseURL`, so this is set to the Go
	 * gateway root (`https://opencode.ai/zen/go`) — NOT the `/v1` root used by
	 * the OpenAI client — to avoid a doubled `/v1` path segment.
	 */
	private readonly anthropicClient: Anthropic

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

		this.anthropicClient = new Anthropic({
			baseURL: "https://opencode.ai/zen/go",
			apiKey: options.opencodeGoApiKey,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				...(options.openAiHeaders || {}),
			},
		})
	}

	/**
	 * Resolves the configured model and computes model parameters
	 * (max tokens, temperature, reasoning effort) from the merged model info.
	 *
	 * The wire format is derived from the model ID via
	 * {@link isOpencodeGoAnthropicFormatModel}: Anthropic-format models compute
	 * parameters with the `anthropic` format so reasoning is mapped to the
	 * Anthropic-style controls; everything else uses the `openai` format.
	 *
	 * Fetches the live model list first so the merged native + `/models`
	 * metadata (context window, capability flags, pricing) is available before
	 * parameter computation — mirroring the original `fetchModel()` flow.
	 */
	private async resolveModel() {
		const { id, info } = await this.fetchModel()
		const isAnthropic = isOpencodeGoAnthropicFormatModel(id)
		// getModelParams is overloaded on a literal `format`, so branch the call
		// rather than passing a union — this keeps the returned params typed as a
		// single concrete shape per branch.
		const params = isAnthropic
			? getModelParams({
					format: "anthropic",
					modelId: id,
					model: info,
					settings: this.options,
					defaultTemperature: OPENCODE_GO_DEFAULT_TEMPERATURE,
				})
			: getModelParams({
					format: "openai",
					modelId: id,
					model: info,
					settings: this.options,
					defaultTemperature: OPENCODE_GO_DEFAULT_TEMPERATURE,
				})
		return {
			id,
			info,
			format: isAnthropic ? ("anthropic" as const) : ("openai" as const),
			maxTokens: params.maxTokens,
			temperature: params.temperature,
			reasoningEffort: params.reasoningEffort,
		}
	}

	/**
	 * Streams a chat completion response, yielding typed chunks for text,
	 * reasoning, partial tool calls, and token usage.
	 *
	 * Anthropic-format models (Qwen/MiniMax) are streamed via
	 * {@link streamAnthropicMessage} against `/v1/messages`; all other models
	 * use the OpenAI-compatible chat completions endpoint.
	 *
	 * For OpenAI-format models that require reasoning_content to be passed back
	 * during multi-turn tool calls (`preserveReasoning`), messages are
	 * converted with `convertToR1Format` so interleaved thinking is preserved
	 * across tool-call continuations. Reasoning effort is forwarded when the
	 * model advertises `supportsReasoningEffort`.
	 */
	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info, format, temperature, reasoningEffort, maxTokens } = await this.resolveModel()

		if (format === "anthropic") {
			yield* this.streamAnthropicMessage(modelId, info, temperature, maxTokens, systemPrompt, messages, metadata)
			return
		}

		// preserveReasoning models (GLM/DeepSeek/MiMo/MiniMax/Qwen) require
		// reasoning_content to be carried across tool-call continuations.
		const preserveReasoning = info.preserveReasoning === true
		const convertedMessages = preserveReasoning
			? convertToR1Format(messages, { mergeToolResultText: true })
			: convertToOpenAiMessages(messages)

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertedMessages,
		]

		const body: OpenAI.Chat.ChatCompletionCreateParams = {
			model: modelId,
			messages: openAiMessages,
			temperature: this.supportsTemperature(modelId) ? temperature : undefined,
			max_completion_tokens:
				this.options.includeMaxTokens === true ? this.options.modelMaxTokens || maxTokens : maxTokens,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
			...(reasoningEffort && {
				reasoning_effort: reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
			}),
		}

		const completion = await this.client.chat.completions.create(body)

		for await (const chunk of completion) {
			const delta = chunk.choices[0]?.delta

			if (delta?.content) {
				yield { type: "text", text: delta.content }
			}

			// Several Go-plan models (GLM, DeepSeek) stream reasoning via this field.
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
	 * Streams an Anthropic Messages-format completion for Go models that only
	 * accept the `/v1/messages` endpoint (Qwen/MiniMax).
	 *
	 * Mirrors the Anthropic streaming protocol handled by the dedicated
	 * MiniMax handler: `message_start`/`message_delta` carry usage, content
	 * blocks carry text/thinking/tool_use, and a final cost chunk is emitted
	 * from the accumulated token counts. Prompt-cache breakpoints are applied
	 * to the system prompt and last two user messages when the model advertises
	 * `supportsPromptCache`, since the Go gateway honours server-side caching
	 * and reports cache tokens in usage.
	 */
	private async *streamAnthropicMessage(
		modelId: string,
		info: ModelInfo,
		temperature: number | undefined,
		maxTokens: number | undefined,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const cacheControl: CacheControlEphemeral = { type: "ephemeral" }
		const supportsPromptCache = info.supportsPromptCache ?? false

		// Strip non-Anthropic blocks (reasoning, thoughtSignature, etc.) before
		// sending — the gateway rejects unknown content block types.
		const sanitizedMessages = filterNonAnthropicBlocks(messages)

		const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
			supportsPromptCache
				? { text: systemPrompt, type: "text", cache_control: cacheControl }
				: { text: systemPrompt, type: "text" },
		]

		// Only attach tools/tool_choice when the caller actually provides
		// tools — sending an empty tool list (or a tool_choice derived from an
		// empty set) forces some Anthropic-compatible gateways into a
		// tool-use-only mode and is wasteful for plain text turns.
		const tools = metadata?.tools && metadata.tools.length > 0 ? metadata.tools : undefined

		const requestParams: Anthropic.Messages.MessageCreateParams = {
			model: modelId,
			max_tokens:
				this.options.includeMaxTokens === true
					? this.options.modelMaxTokens || maxTokens || 16_384
					: (maxTokens ?? 16_384),
			temperature: this.supportsTemperature(modelId) ? (temperature ?? 1.0) : undefined,
			system: systemBlocks,
			messages: supportsPromptCache
				? this.addAnthropicCacheControl(sanitizedMessages, cacheControl)
				: sanitizedMessages,
			stream: true,
			...(tools
				? {
						tools: convertOpenAIToolsToAnthropic(tools),
						tool_choice: convertOpenAIToolChoiceToAnthropic(
							metadata?.tool_choice,
							metadata?.parallelToolCalls,
						),
					}
				: {}),
		}

		// Wrap pre-stream errors (401, 429, network) with the same
		// "Opencode Go completion error:" prefix used by completePrompt so the
		// Anthropic-format path surfaces failures consistently. Mid-stream
		// errors propagate unchanged, matching the OpenAI streaming path.
		let stream
		try {
			stream = await this.anthropicClient.messages.create(requestParams)
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Opencode Go completion error: ${error.message}`)
			}
			throw error
		}

		let inputTokens = 0
		let outputTokens = 0
		let cacheWriteTokens = 0
		let cacheReadTokens = 0

		for await (const chunk of stream) {
			switch (chunk.type) {
				case "message_start": {
					// Tells us cache reads/writes/input/output.
					const {
						input_tokens = 0,
						output_tokens = 0,
						cache_creation_input_tokens,
						cache_read_input_tokens,
					} = chunk.message.usage

					yield {
						type: "usage",
						inputTokens: input_tokens,
						outputTokens: output_tokens,
						cacheWriteTokens: cache_creation_input_tokens || undefined,
						cacheReadTokens: cache_read_input_tokens || undefined,
					}

					inputTokens += input_tokens
					outputTokens += output_tokens
					cacheWriteTokens += cache_creation_input_tokens || 0
					cacheReadTokens += cache_read_input_tokens || 0

					break
				}
				case "message_delta":
					// Tells us stop_reason, stop_sequence, and output tokens.
					// Anthropic streams the cumulative output token count in each
					// message_delta (the final event carries the total), so
					// accumulate it into the running total used for cost
					// calculation — otherwise the final cost only reflects the
					// (typically zero) message_start output tokens.
					outputTokens += chunk.usage.output_tokens || 0
					yield {
						type: "usage",
						inputTokens: 0,
						outputTokens: chunk.usage.output_tokens || 0,
					}

					break
				case "message_stop":
					// No usage data, just an indicator that the message is done.
					break
				case "content_block_start":
					switch (chunk.content_block.type) {
						case "thinking":
							// Yield thinking/reasoning content
							if (chunk.index > 0) {
								yield { type: "reasoning", text: "\n" }
							}

							yield { type: "reasoning", text: chunk.content_block.thinking }
							break
						case "text":
							// We may receive multiple text blocks
							if (chunk.index > 0) {
								yield { type: "text", text: "\n" }
							}

							yield { type: "text", text: chunk.content_block.text }
							break
						case "tool_use": {
							// Emit initial tool call partial with id and name
							yield {
								type: "tool_call_partial",
								index: chunk.index,
								id: chunk.content_block.id,
								name: chunk.content_block.name,
								arguments: undefined,
							}
							break
						}
					}
					break
				case "content_block_delta":
					switch (chunk.delta.type) {
						case "thinking_delta":
							yield { type: "reasoning", text: chunk.delta.thinking }
							break
						case "text_delta":
							yield { type: "text", text: chunk.delta.text }
							break
						case "input_json_delta": {
							// Emit tool call partial chunks as arguments stream in
							yield {
								type: "tool_call_partial",
								index: chunk.index,
								id: undefined,
								name: undefined,
								arguments: chunk.delta.partial_json,
							}
							break
						}
					}

					break
				case "content_block_stop":
					// Block is complete - no action needed, NativeToolCallParser handles completion
					break
			}
		}

		// Calculate and yield final cost
		if (inputTokens > 0 || outputTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0) {
			const { totalCost } = calculateApiCostAnthropic(
				info,
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
			)

			yield {
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				totalCost,
			}
		}
	}

	/**
	 * Adds ephemeral cache-control breakpoints to the last two user messages
	 * so the gateway can cache the system prompt + most recent turns
	 * server-side. Only applied when the model advertises prompt-cache support.
	 */
	private addAnthropicCacheControl(
		messages: Anthropic.Messages.MessageParam[],
		cacheControl: CacheControlEphemeral,
	): Anthropic.Messages.MessageParam[] {
		const userMsgIndices = messages.reduce(
			(acc, msg, index) => (msg.role === "user" ? [...acc, index] : acc),
			[] as number[],
		)

		const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
		const secondLastUserMsgIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

		return messages.map((message, index) => {
			if (index === lastUserMsgIndex || index === secondLastUserMsgIndex) {
				return {
					...message,
					content:
						typeof message.content === "string"
							? [{ type: "text", text: message.content, cache_control: cacheControl }]
							: message.content.map((content, contentIndex) =>
									contentIndex === message.content.length - 1
										? { ...content, cache_control: cacheControl }
										: content,
								),
				}
			}
			return message
		})
	}

	/**
	 * Performs a non-streaming chat completion and returns the full response text.
	 *
	 * Anthropic-format models are completed via the `/v1/messages` endpoint;
	 * all other models use the OpenAI-compatible chat completions endpoint.
	 *
	 * @param prompt - The user prompt to send as a single user message.
	 * @returns The model's reply text, or an empty string if no content is returned.
	 * @throws Error with an Opencode Go-specific prefix if the request fails.
	 */
	async completePrompt(prompt: string): Promise<string> {
		const { id: modelId, format, temperature, reasoningEffort, maxTokens } = await this.resolveModel()

		if (format === "anthropic") {
			try {
				const message = await this.anthropicClient.messages.create({
					model: modelId,
					// Honour the same includeMaxTokens/modelMaxTokens override
					// logic as the streaming path so non-streaming completions
					// respect the user's max-output slider instead of always
					// falling back to the model default.
					max_tokens:
						this.options.includeMaxTokens === true
							? this.options.modelMaxTokens || maxTokens || 16_384
							: (maxTokens ?? 16_384),
					temperature: this.supportsTemperature(modelId) ? (temperature ?? 1.0) : undefined,
					messages: [{ role: "user", content: prompt }],
					stream: false,
				})

				const content = message.content.find(({ type }) => type === "text")
				return content?.type === "text" ? content.text : ""
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`Opencode Go completion error: ${error.message}`)
				}
				throw error
			}
		}

		try {
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = temperature
			}

			requestOptions.max_completion_tokens =
				this.options.includeMaxTokens === true ? this.options.modelMaxTokens || maxTokens : maxTokens

			if (reasoningEffort) {
				requestOptions.reasoning_effort =
					reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"]
			}

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
