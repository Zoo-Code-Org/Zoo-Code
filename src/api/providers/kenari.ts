import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	kenariDefaultModelId,
	kenariDefaultModelInfo,
	KENARI_DEFAULT_TEMPERATURE,
	KENARI_BASE_URL,
	providerIdentifiers,
	type ModelRecord,
} from "@roo-code/types"

import { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { RouterProvider } from "./router-provider"
import { getKenariModels } from "./fetchers/kenari"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	rejectOnAbort,
	resolveModelWithAbort,
	toSdkTimeoutMs,
} from "./utils/abort-signal"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

const KENARI_PROVIDER_NAME = "Kenari"

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
			name: providerIdentifiers.kenari,
			baseURL: KENARI_BASE_URL,
			apiKey: options.kenariApiKey,
			modelId: options.kenariModelId,
			defaultModelId: kenariDefaultModelId,
			defaultModelInfo: kenariDefaultModelInfo,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: false, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getKenariModels(options.apiKey, ...fetchOpts)
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
		const callerSignal = metadata?.abortSignal
		// The SDK adds an abort listener to whatever signal it is handed and never removes it, so this
		// generator bridges the caller signal and detaches the bridge in its finally, as completePrompt does.
		const { signal: bridgedCallerSignal, dispose: removeCallerAbortListener } =
			bridgeExternalAbortSignal(callerSignal)
		const { id: modelId, info } = await resolveModelWithAbort(
			() => this.fetchModel(),
			bridgedCallerSignal,
			KENARI_PROVIDER_NAME,
		).catch((error: unknown) => {
			removeCallerAbortListener()
			throw error
		})

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

		const streamRequestOptions: [] | [OpenAI.RequestOptions] = bridgedCallerSignal
			? [{ signal: bridgedCallerSignal }]
			: []

		try {
			const pendingCompletion = this.client.chat.completions.create(body, ...streamRequestOptions)
			const completion = bridgedCallerSignal
				? await rejectOnAbort(pendingCompletion, bridgedCallerSignal, KENARI_PROVIDER_NAME)
				: await pendingCompletion

			for await (const chunk of completion) {
				if (callerSignal?.aborted) break // the tail check turns this into the contract AbortError
				const delta = chunk.choices[0]?.delta

				// Several Kenari models (GLM, DeepSeek) stream reasoning via reasoning_content,
				// with an OpenRouter-style `reasoning` fallback; the shared helper handles both.
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
						if (callerSignal?.aborted) throw createAbortError(KENARI_PROVIDER_NAME) // a cancel must not emit the rest of this chunk
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
		} catch (error) {
			if (isRequestAborted(error, callerSignal)) {
				throw createAbortError(KENARI_PROVIDER_NAME)
			}
			throw error
		} finally {
			removeCallerAbortListener()
		}
		if (callerSignal?.aborted) throw createAbortError(KENARI_PROVIDER_NAME) // a stream that ended because the caller cancelled
	}

	/**
	 * Performs a non-streaming chat completion and returns the full response text.
	 *
	 * Cancellation follows the shared abort-signal contract (see zoo-gateway.ts and
	 * requesty.ts): the caller signal is bridged to a per-request signal, the timeout joins
	 * that same signal, and `finally` detaches the bridge on every exit path.
	 * @param prompt - The user prompt to send as a single user message.
	 * @param options - Caller cancellation and request timeout, per `CompletePromptOptions`.
	 * @returns The model's reply text, or an empty string if no content is returned.
	 * @throws Error with a Kenari-specific prefix if the request fails.
	 */
	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { signal: bridgedCallerSignal, dispose: removeExternalAbortListener } = bridgeExternalAbortSignal(
			options?.abortSignal,
		)
		const requestAbortSignal = mergeAbortSignalAndTimeout(bridgedCallerSignal, options?.timeoutMs)

		try {
			const { id: modelId, info } = await resolveModelWithAbort(
				() => this.fetchModel(),
				requestAbortSignal,
				KENARI_PROVIDER_NAME,
			)

			const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}

			if (this.supportsTemperature(modelId)) {
				requestOptions.temperature = this.options.modelTemperature ?? KENARI_DEFAULT_TEMPERATURE
			}

			requestOptions.max_completion_tokens = info.maxTokens

			const createOptions: OpenAI.RequestOptions = {
				...(requestAbortSignal && { signal: requestAbortSignal }),
				...(hasUsableTimeout(options?.timeoutMs) && { timeout: toSdkTimeoutMs(options.timeoutMs) }),
			}
			const requestOptionsTail: [] | [OpenAI.RequestOptions] = requestAbortSignal ? [createOptions] : []

			try {
				const pendingCompletion = this.client.chat.completions.create(requestOptions, ...requestOptionsTail)
				// Race the completion too: the SDK ignores the signal while it retries.
				const response = requestAbortSignal
					? await rejectOnAbort(pendingCompletion, requestAbortSignal, KENARI_PROVIDER_NAME)
					: await pendingCompletion
				if (requestAbortSignal?.aborted) throw createAbortError(KENARI_PROVIDER_NAME) // a completion that lands after the cancel is dropped
				return response.choices[0]?.message.content || ""
			} catch (error) {
				if (isRequestAborted(error, requestAbortSignal)) throw createAbortError(KENARI_PROVIDER_NAME)
				if (error instanceof Error) {
					throw new Error(`Kenari completion error: ${error.message}`)
				}
				throw error
			}
		} finally {
			removeExternalAbortListener()
		}
	}
}
