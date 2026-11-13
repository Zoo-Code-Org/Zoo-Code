import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	type ModelRecord,
	providerIdentifiers,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"
import { calculateApiCostOpenAI } from "../../shared/cost"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { AnthropicProviderReasoningParams, getAnthropicProviderReasoning } from "../transform/reasoning"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"
import { getModels } from "./fetchers/modelCache"
import { getRequestyModels } from "./fetchers/requesty"
import { BaseProvider } from "./base-provider"
import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { toRequestyServiceUrl } from "../../shared/utils/requesty"
import { handleOpenAIError } from "./utils/error-handler"
import {
	hasUsableTimeout,
	toSdkTimeoutMs,
	bridgeExternalAbortSignal,
	createAbortError,
	isRequestAborted,
	mergeAbortSignalAndTimeout,
	rejectOnAbort,
	throwIfAborted,
} from "./utils/abort-signal"
import { applyRouterToolPreferences } from "./utils/router-tool-preferences"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

// Requesty usage includes an extra field for Anthropic use cases.
// Safely cast the prompt token details section to the appropriate structure.
interface RequestyUsage extends OpenAI.CompletionUsage {
	prompt_tokens_details?: {
		caching_tokens?: number
		cached_tokens?: number
	}
	total_cost?: number
}

type RequestyChatCompletionParamsStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	requesty?: {
		trace_id?: string
		extra?: {
			mode?: string
		}
	}
	thinking?: AnthropicProviderReasoningParams
}

type RequestyChatCompletionParams = OpenAI.Chat.ChatCompletionCreateParams & {
	requesty?: {
		trace_id?: string
		extra?: {
			mode?: string
		}
	}
	thinking?: AnthropicProviderReasoningParams
}

export class RequestyHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected models: ModelRecord = {}
	private client: OpenAI
	private baseURL: string
	private readonly providerName = "Requesty"

	constructor(options: ApiHandlerOptions) {
		super()

		this.options = options
		this.baseURL = toRequestyServiceUrl(options.requestyBaseUrl)

		const apiKey = this.options.requestyApiKey ?? NOT_PROVIDED

		this.client = new OpenAI({
			baseURL: this.baseURL,
			apiKey: apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: this.timeoutMs,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: true, keyScoped: true, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getRequestyModels(options.baseUrl, options.apiKey, ...fetchOpts)
	}

	public async fetchModel(signal?: AbortSignal) {
		// Pass the API key so the catalog request is authenticated and the cache entry is
		// key-scoped. Requesty enforces per-key model allowlists, so a keyless (URL-only)
		// entry would let one key's catalog be served to another key on the same server.
		this.models = await getModels(
			{
				provider: providerIdentifiers.requesty,
				apiKey: this.options.requestyApiKey,
				baseUrl: this.baseURL,
				// Per-waiter: modelCache detaches this caller and aborts the shared fetch only
				// when the last waiter leaves.
				...(signal && { signal }),
			},
			this,
		)
		return this.getModel()
	}

	async ensureModelFetched(signal?: AbortSignal): Promise<void> {
		await this.ensureCatalogLoaded(async () => {
			// The caller's signal is deliberately not threaded into fetchModel(): this load
			// is shared by every waiter on the handler, so binding it to one caller's signal
			// would cancel the fetch for the others. The signal still detaches this caller's
			// own wait (see ensureCatalogLoaded), and the shared fetch stays bounded by
			// modelCache's single-flight timeout.
			await this.fetchModel()
			// fetchModel() returns model info, not the catalog, so report emptiness
			// from the catalog it assigned: an empty response must stay retryable.
			return Object.keys(this.models).length > 0
		}, signal)
	}

	override getModel() {
		const id = this.options.requestyModelId ?? requestyDefaultModelId
		const cachedInfo = this.models[id] ?? requestyDefaultModelInfo
		let info: ModelInfo = cachedInfo

		// Apply tool preferences for models accessed through routers (OpenAI, Gemini)
		info = applyRouterToolPreferences(id, info)

		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		const reasoning = getAnthropicProviderReasoning({
			model: info,
			reasoningBudget: params.reasoningBudget,
			settings: this.options,
		})

		return { id, info, ...params, reasoning }
	}

	protected processUsageMetrics(usage: any, modelInfo?: ModelInfo): ApiStreamUsageChunk {
		const requestyUsage = usage as RequestyUsage
		const inputTokens = requestyUsage?.prompt_tokens || 0
		const outputTokens = requestyUsage?.completion_tokens || 0
		const cacheWriteTokens = requestyUsage?.prompt_tokens_details?.caching_tokens || 0
		const cacheReadTokens = requestyUsage?.prompt_tokens_details?.cached_tokens || 0
		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens: inputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const {
			id: model,
			info,
			maxTokens: max_tokens,
			temperature,
			reasoningEffort: reasoning_effort,
			reasoning: thinking,
		} = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Map extended efforts to OpenAI Chat Completions-accepted values (omit unsupported)
		const allowedEffort = (["low", "medium", "high"] as const).includes(reasoning_effort as any)
			? (reasoning_effort as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming["reasoning_effort"])
			: undefined

		const completionParams: RequestyChatCompletionParamsStreaming = {
			messages: openAiMessages,
			model,
			max_tokens,
			temperature,
			...(allowedEffort && { reasoning_effort: allowedEffort }),
			...(thinking && { thinking }),
			stream: true,
			stream_options: { include_usage: true },
			requesty: { trace_id: metadata?.taskId, extra: { mode: metadata?.mode } },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
		}

		let stream
		try {
			// With streaming params type, SDK returns an async iterable stream
			stream = await this.client.chat.completions.create(completionParams)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
		let lastUsage: any = undefined

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta

			const reasoningText = extractReasoningFromDelta(delta)
			if (reasoningText) {
				yield { type: "reasoning", text: reasoningText }
			}

			if (delta?.content) {
				yield { type: "text", text: delta.content }
			}

			// Handle native tool calls
			if (delta && "tool_calls" in delta && Array.isArray(delta.tool_calls)) {
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
			yield this.processUsageMetrics(lastUsage, info)
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Bridge the caller's signal before anything else: the OpenAI SDK attaches its abort
		// listener to whichever signal it receives and leaves it attached once the request
		// completes, and with no usable timeout `mergeAbortSignalAndTimeout` would hand it the
		// caller's own long-lived signal - one retained listener and controller per completed
		// request. The bridge gives the SDK a per-request signal and returns the handle that
		// detaches it, which the `finally` below must run on every exit path.
		//
		// Establishing the cancellation scope here also covers model lookup: a pre-aborted call,
		// or one aborted while model metadata is loading, must reject promptly instead of waiting
		// for the lookup to settle. The configured timeoutMs covers the lookup as well.
		const { signal: bridgedCallerSignal, dispose: removeExternalAbortListener } = bridgeExternalAbortSignal(
			options?.abortSignal,
		)
		const requestAbortSignal = mergeAbortSignalAndTimeout(bridgedCallerSignal, options?.timeoutMs)

		try {
			throwIfAborted(requestAbortSignal)

			let modelData: Awaited<ReturnType<RequestyHandler["fetchModel"]>>
			try {
				modelData = requestAbortSignal
					? await rejectOnAbort(this.fetchModel(requestAbortSignal), requestAbortSignal, this.providerName)
					: await this.fetchModel()
			} catch (error) {
				if (isRequestAborted(error, requestAbortSignal)) {
					throw createAbortError(this.providerName)
				}
				throw error
			}
			const { id: model, maxTokens: max_tokens, temperature } = modelData

			const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: prompt }]

			const completionParams: RequestyChatCompletionParams = {
				model,
				max_tokens,
				messages: openAiMessages,
				temperature: temperature,
			}

			// The merged abort signal (established before model lookup, above) is forwarded to the
			// SDK so both abort and timeout reject with a DOM-standard AbortError in the catch
			// below. The client-level timeout remains the default safety net; 0 is never passed
			// to the SDK timeout.
			const createOptions: OpenAI.RequestOptions = {
				...(requestAbortSignal && { signal: requestAbortSignal }),
				...(hasUsableTimeout(options?.timeoutMs) && { timeout: toSdkTimeoutMs(options.timeoutMs) }),
			}

			let response: OpenAI.Chat.ChatCompletion
			try {
				const pendingCompletion = this.client.chat.completions.create(completionParams, createOptions)
				// Race the completion against the cancellation scope as the model lookup above does:
				// openai@5.23.2 does not observe the signal inside `retryRequest`, which sleeps for
				// the backoff (or a server-provided `retry-after-ms`, up to about a minute) before
				// issuing the next attempt. Awaiting the SDK call alone can therefore hold
				// completePrompt open long after the caller cancelled; the race settles at once and a
				// rejection the SDK wins first is still normalized by the catch below.
				response = requestAbortSignal
					? await rejectOnAbort(pendingCompletion, requestAbortSignal, this.providerName)
					: await pendingCompletion
			} catch (error) {
				// Aborted requests are user-initiated: surface them as AbortError (this also covers
				// timeouts, which abort the same signal) instead of a completion error.
				if (requestAbortSignal?.aborted) {
					throw createAbortError(this.providerName)
				}
				throw handleOpenAIError(error, this.providerName)
			}

			if (requestAbortSignal?.aborted) {
				// The response resolved after the request was aborted: do not return the late result.
				throw createAbortError(this.providerName)
			}
			return response.choices[0]?.message.content || ""
		} finally {
			// Detach on every exit path - completion, failure, abort, or a late result. The listener
			// sits on the caller's long-lived signal and would outlive this request otherwise.
			removeExternalAbortListener()
		}
	}
}
