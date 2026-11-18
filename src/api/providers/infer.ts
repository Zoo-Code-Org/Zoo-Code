import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	INFER_BASE_URL,
	inferDefaultModelId,
	inferDefaultModelInfo,
	providerIdentifiers,
	type ModelInfo,
	type ModelRecord,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import type { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"
import type {
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
	SingleCompletionHandler,
} from "../index"
import { RouterProvider } from "./router-provider"
import { getInferModels } from "./fetchers/infer"
import { handleProviderError } from "./utils/error-handler"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { hasUsableTimeout, toSdkTimeoutMs } from "./utils/abort-signal"

/** Infer reports cache writes next to cache reads. */
type InferUsage = OpenAI.CompletionUsage & {
	prompt_tokens_details?: OpenAI.CompletionUsage["prompt_tokens_details"] & { cache_write_tokens?: number }
}

/** The final chunks also carry `relay`, with the charge that Infer settled for the request. */
type InferChunk = OpenAI.Chat.ChatCompletionChunk & { relay?: { customer_cost_usd?: number } }

function mapInferUsage(usage: InferUsage, customerCost: number | undefined): ApiStreamUsageChunk {
	return {
		type: "usage",
		// prompt_tokens includes the cache read and cache write tokens.
		inputTokens: usage.prompt_tokens || 0,
		outputTokens: usage.completion_tokens || 0,
		cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
		cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? undefined,
		...(typeof customerCost === "number" && Number.isFinite(customerCost) ? { totalCost: customerCost } : {}),
	}
}

/**
 * Infer provider.
 *
 * OpenAI-compatible Chat Completions endpoint:
 * https://infer.flow7.org/v1/chat/completions
 *
 * A model id selects a model and a route (`infer/<model>:<route>`). The routes are
 * listed in the public catalog, which is fetched dynamically. Supports text
 * generation, reasoning content, tool calls, and non-streaming prompt completion.
 */
export class InferHandler extends RouterProvider implements SingleCompletionHandler {
	/** Creates a new handler bound to the user's API key and selected model. */
	constructor(options: ApiHandlerOptions) {
		super({
			// The endpoint is fixed, so the custom headers configured for the
			// OpenAI Compatible provider must not be sent to it.
			options: { ...options, openAiHeaders: undefined },
			name: providerIdentifiers.infer,
			baseURL: INFER_BASE_URL,
			apiKey: options.inferApiKey,
			modelId: options.inferModelId,
			defaultModelId: inferDefaultModelId,
			defaultModelInfo: inferDefaultModelInfo,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		// The public catalog is the same for every account and needs no key.
		return { urlScoped: false, keyScoped: false, authScoped: false }
	}

	async fetchModels(_options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getInferModels(...fetchOpts)
	}

	private createSafeError(operation: string, error: unknown): Error {
		const apiKey = this.options.inferApiKey
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

		return handleProviderError(safeError, "Infer", {
			messagePrefix: operation,
			// The transformer input can also come from `error.error.metadata.raw`.
			messageTransformer: (message) => `Infer ${operation} error: ${redact(message)}`,
		})
	}

	/** A cleared temperature setting is stored as null, so only a number is sent. */
	private getTemperature(modelId: string, info: ModelInfo): number | undefined {
		const temperature = this.options.modelTemperature
		return typeof temperature === "number" &&
			info.supportsTemperature !== false &&
			this.supportsTemperature(modelId)
			? temperature
			: undefined
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

		// max_tokens is not sent. Infer holds the cost of the output cap from the wallet
		// before a request starts. Without a cap, Infer sets one from the route's output
		// room (32,768 tokens at most), so the full output limit of a large model is not held.
		const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
			model: modelId,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		const temperature = this.getTemperature(modelId, info)
		if (temperature !== undefined) {
			body.temperature = temperature
		}

		try {
			const completion = await this.client.chat.completions.create(body, {
				signal: metadata?.abortSignal,
				// Infer keeps the requests of one session on the same route while it is
				// healthy. This helps later requests in a task reuse the prompt cache of the route.
				...(metadata?.taskId ? { headers: { "X-Session-Affinity": metadata.taskId } } : {}),
			})

			for await (const chunk of completion) {
				const delta = chunk.choices[0]?.delta

				// Infer streams reasoning text in `delta.reasoning`.
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
					yield mapInferUsage(chunk.usage, (chunk as InferChunk).relay?.customer_cost_usd)
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
	 * @throws Error with an Infer prefix if the request fails.
	 */
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			// max_tokens is not sent, for the same reason as in createMessage.
			const requestOptions: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			const temperature = this.getTemperature(modelId, info)
			if (temperature !== undefined) {
				requestOptions.temperature = temperature
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
