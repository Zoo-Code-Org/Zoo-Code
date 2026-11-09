import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	STANDARD_COMPUTE_BASE_URL,
	standardComputeDefaultModelId,
	standardComputeDefaultModelInfo,
	providerIdentifiers,
	type ModelRecord,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import type { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type {
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
	SingleCompletionHandler,
} from "../index"
import { RouterProvider } from "./router-provider"
import { getStandardComputeModels } from "./fetchers/standard-compute"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { hasUsableTimeout, toSdkTimeoutMs } from "./utils/abort-signal"

/**
 * Standard Compute provider.
 *
 * OpenAI-compatible Chat Completions endpoint:
 * https://api.stdcmpt.com/v1/chat/completions
 *
 * The default `StandardCompute` model is routed: the router picks a model from
 * the models that the user enabled, by the user's quality preference, and uses
 * cheaper models for simple steps. Image requests go to a vision model. Pinned
 * model ids are resolved dynamically from the public /models endpoint.
 * Supports text generation, reasoning content, tool calls, and non-streaming
 * prompt completion.
 */
export class StandardComputeHandler extends RouterProvider implements SingleCompletionHandler {
	/** Creates a new handler bound to the user's API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			// The endpoint is fixed, so the custom headers configured for the
			// OpenAI Compatible provider must not be sent to it.
			options: { ...options, openAiHeaders: undefined },
			name: providerIdentifiers.standardCompute,
			baseURL: STANDARD_COMPUTE_BASE_URL,
			apiKey: options.standardComputeApiKey,
			modelId: options.standardComputeModelId,
			defaultModelId: standardComputeDefaultModelId,
			defaultModelInfo: standardComputeDefaultModelInfo,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		// Public catalog. The key is forwarded, so the cache stays key-scoped.
		return { urlScoped: false, keyScoped: true, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getStandardComputeModels(options.apiKey, ...fetchOpts)
	}

	private createSafeError(operation: string, error: unknown): Error {
		const apiKey = this.options.standardComputeApiKey
		const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text)

		// handleProviderError logs the message, stack and the SDK's raw error
		// metadata before it applies the transformer, so the key has to be
		// scrubbed from the error itself first.
		if (error instanceof Error) {
			error.message = redact(error.message)
			if (error.stack) {
				error.stack = redact(error.stack)
			}
			// handleProviderError calls string methods on this field, so an
			// object-valued upstream body is serialized before it is redacted.
			const metadata = (error as { error?: { metadata?: { raw?: unknown } } }).error?.metadata
			if (metadata && metadata.raw !== undefined && metadata.raw !== null) {
				const raw = metadata.raw
				metadata.raw = redact(typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw)))
			}
		}
		const safeError = error instanceof Error ? error : redact(String(error))

		return handleProviderError(safeError, "Standard Compute", {
			messagePrefix: operation,
			// The transformer input can also come from `error.error.metadata.raw`.
			messageTransformer: (message) => `Standard Compute ${operation} error: ${redact(message)}`,
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

		if (
			this.options.modelTemperature !== undefined &&
			info.supportsTemperature !== false &&
			this.supportsTemperature(modelId)
		) {
			body.temperature = this.options.modelTemperature
		}

		try {
			const completion = await this.client.chat.completions.create(body, { signal: metadata?.abortSignal })

			for await (const chunk of completion) {
				const delta = chunk.choices[0]?.delta

				// Reasoning models stream reasoning via
				// reasoning_content with a `reasoning` field fallback.
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
						cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
					}
				}
			}
		} catch (error) {
			throw this.createSafeError("streaming", error)
		}
	}

	/**
	 * Performs a non-streaming chat completion and returns the full response text.
	 *
	 * @param prompt - The user prompt to send as a single user message.
	 * @returns The model's reply text, or an empty string if no content is returned.
	 * @throws Error with an Standard Compute prefix if the request fails.
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

			if (
				this.options.modelTemperature !== undefined &&
				info.supportsTemperature !== false &&
				this.supportsTemperature(modelId)
			) {
				requestOptions.temperature = this.options.modelTemperature
			}

			// The OpenAI SDK validates a present-but-undefined `timeout` key, so
			// request options are only forwarded when they carry a real value.
			const completionOptions: OpenAI.RequestOptions = {}
			if (options?.abortSignal !== undefined) {
				completionOptions.signal = options.abortSignal
			}
			const timeoutMs = options?.timeoutMs
			if (hasUsableTimeout(timeoutMs)) {
				completionOptions.timeout = toSdkTimeoutMs(timeoutMs)
			}
			const hasCompletionOptions =
				completionOptions.signal !== undefined || completionOptions.timeout !== undefined

			const response = await this.client.chat.completions.create(
				requestOptions,
				hasCompletionOptions ? completionOptions : undefined,
			)
			return response.choices[0]?.message.content || ""
		} catch (error) {
			throw this.createSafeError("completion", error)
		}
	}
}
