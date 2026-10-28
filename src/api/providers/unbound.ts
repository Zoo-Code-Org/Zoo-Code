import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError } from "openai"

import {
	type ModelInfo,
	type ModelRecord,
	providerIdentifiers,
	unboundDefaultModelId,
	unboundDefaultModelInfo,
} from "@roo-code/types"

import type { ApiHandlerOptions, GetModelsOptions } from "../../shared/api"
import { calculateApiCostOpenAI } from "../../shared/cost"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { OpenAiReasoningParams } from "../transform/reasoning"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"
import { getModels } from "./fetchers/modelCache"
import { getUnboundModels } from "./fetchers/unbound"
import { BaseProvider } from "./base-provider"
import type {
	SingleCompletionHandler,
	ApiHandlerCreateMessageMetadata,
	CompletePromptOptions,
	ModelCacheScope,
} from "../index"
import { handleOpenAIError } from "./utils/error-handler"
import { applyRouterToolPreferences } from "./utils/router-tool-preferences"
import {
	bridgeExternalAbortSignal,
	createAbortError,
	hasUsableTimeout,
	isRequestAborted,
	resolveModelWithAbort,
	toSdkTimeoutMs,
} from "./utils/abort-signal"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

// Unbound usage includes extra fields for Anthropic cache tokens.
interface UnboundUsage extends OpenAI.CompletionUsage {
	cache_creation_input_tokens?: number
	cache_read_input_tokens?: number
}

type UnboundChatCompletionParamsStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	unbound_metadata?: {
		originApp?: string
		taskId?: string
		mode?: string
	}
	thinking?: OpenAiReasoningParams
}

type UnboundChatCompletionParams = OpenAI.Chat.ChatCompletionCreateParams & {
	unbound_metadata?: {
		originApp?: string
		taskId?: string
		mode?: string
	}
	thinking?: OpenAiReasoningParams
}

export class UnboundHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected models: ModelRecord = {}
	private client: OpenAI
	private readonly providerName = "Unbound"

	constructor(options: ApiHandlerOptions) {
		super()

		this.options = options

		const apiKey = this.options.unboundApiKey ?? NOT_PROVIDED

		this.client = new OpenAI({
			baseURL: "https://api.getunbound.ai/v1",
			apiKey: apiKey,
			defaultHeaders: {
				...DEFAULT_HEADERS,
				"X-Unbound-Metadata": JSON.stringify({ labels: [{ key: "app", value: "zoo-code" }] }),
			},
			timeout: this.timeoutMs,
		})
	}

	override getModelCacheScope(): ModelCacheScope {
		return { urlScoped: false, keyScoped: false, authScoped: false }
	}

	async fetchModels(options: GetModelsOptions, signal?: AbortSignal): Promise<ModelRecord> {
		const fetchOpts: [] | [{ signal: AbortSignal }] = signal ? [{ signal }] : []
		return getUnboundModels(options.apiKey, ...fetchOpts)
	}

	public async fetchModel() {
		this.models = await getModels(
			{
				provider: providerIdentifiers.unbound,
				apiKey: this.options.unboundApiKey,
			},
			this,
		)
		return this.getModel()
	}

	override getModel() {
		const id = this.options.unboundModelId ?? unboundDefaultModelId
		const cachedInfo = this.models[id] ?? unboundDefaultModelInfo
		let info: ModelInfo = cachedInfo

		// Apply tool preferences for models accessed through routers (OpenAI, Gemini)
		info = applyRouterToolPreferences(id, info)

		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, ...params }
	}

	protected processUsageMetrics(usage: any, modelInfo?: ModelInfo): ApiStreamUsageChunk {
		const unboundUsage = usage as UnboundUsage
		const inputTokens = unboundUsage?.prompt_tokens || 0
		const outputTokens = unboundUsage?.completion_tokens || 0
		const cacheWriteTokens = unboundUsage?.cache_creation_input_tokens || 0
		const cacheReadTokens = unboundUsage?.cache_read_input_tokens || 0
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
		// Establish the cancellation scope around model resolution: a
		// pre-aborted signal rejects before the lookup starts, and a signal
		// that fires while model metadata is loading settles on the
		// standardized AbortError; any other resolution failure propagates
		// unchanged.
		const externalAbortSignal = metadata?.abortSignal
		const resolved = await resolveModelWithAbort(() => this.fetchModel(), externalAbortSignal, "Unbound")
		const {
			id: model,
			info,
			maxTokens: max_tokens,
			temperature,
			reasoningEffort: reasoning_effort,
			reasoning: thinking,
		} = resolved

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// Map extended efforts to OpenAI Chat Completions-accepted values (omit unsupported)
		const allowedEffort = (["low", "medium", "high"] as const).includes(reasoning_effort as any)
			? (reasoning_effort as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming["reasoning_effort"])
			: undefined

		const completionParams: UnboundChatCompletionParamsStreaming = {
			messages: openAiMessages,
			model,
			max_tokens,
			temperature,
			...(allowedEffort && { reasoning_effort: allowedEffort }),
			...(thinking && { thinking }),
			stream: true,
			stream_options: { include_usage: true },
			unbound_metadata: { originApp: "zoo-code", taskId: metadata?.taskId, mode: metadata?.mode },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
		}

		// Per-request signal bridged from the caller's abort signal via the shared helper
		// (pre-aborted guard, once-only listener, retained cleanup). The never-aborting
		// fallback preserves the previous always-signal behaviour when the caller has no
		// external signal, and dispose() detaches the listener when the request ends.
		const { signal: bridgedSignal, dispose: detachExternalAbortSignal } =
			bridgeExternalAbortSignal(externalAbortSignal)
		const requestSignal = bridgedSignal ?? new AbortController().signal

		try {
			let stream
			try {
				stream = await this.client.chat.completions.create(completionParams, { signal: requestSignal })
			} catch (error) {
				// Preserve abort identity (series standard): a cancelled request
				// must surface as a DOM-standard AbortError, not a wrapped
				// completion error.
				if (isRequestAborted(error, externalAbortSignal)) {
					throw createAbortError("Unbound")
				}
				throw handleOpenAIError(error, this.providerName)
			}
			let lastUsage: any = undefined

			try {
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
			} catch (error) {
				// Preserve abort identity (series standard): a cancellation that
				// surfaces after the stream has started must also normalize to
				// the standardized AbortError, not the raw SDK rejection.
				if (isRequestAborted(error, externalAbortSignal)) {
					throw createAbortError("Unbound")
				}
				throw error
			}
		} finally {
			detachExternalAbortSignal()
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		// Model resolution must honour the caller's cancellation scope the same
		// way createMessage does: a signal that fires during the lookup settles on
		// the standardized AbortError instead of waiting for the catalog to finish.
		const {
			id: model,
			maxTokens: max_tokens,
			temperature,
		} = await resolveModelWithAbort(() => this.fetchModel(), options?.abortSignal, "Unbound")

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: prompt }]

		const completionParams: UnboundChatCompletionParams = {
			model,
			max_tokens,
			messages: openAiMessages,
			temperature: temperature,
		}
		// Build request options with abortSignal and/or timeout.
		// timeoutMs <= 0 means "no explicit timeout": omit the SDK timeout
		// option entirely — the OpenAI SDK treats timeout: 0 as an immediate
		// abort, which would cancel the request right away.
		const createOptions: OpenAI.RequestOptions = {}
		if (options?.abortSignal) {
			createOptions.signal = options.abortSignal
		}
		const timeoutMs = options?.timeoutMs
		if (hasUsableTimeout(timeoutMs)) {
			createOptions.timeout = toSdkTimeoutMs(timeoutMs)
		}

		let response: OpenAI.Chat.ChatCompletion
		try {
			response = await this.client.chat.completions.create(completionParams, createOptions)
		} catch (error) {
			// Preserve abort identity (series standard): caller-initiated
			// cancellations and request timeouts must surface as a
			// DOM-standard AbortError, not a wrapped completion error. The
			// OpenAI SDK reports both with messages ending in a period
			// ("Request was aborted.", "Request timed out."), which would not
			// match task-level abort detection (message ending in "aborted").
			// SDK request timeouts are not aborts, but the series standard maps
			// them to the same AbortError identity as caller cancellations.
			if (isRequestAborted(error, options?.abortSignal) || error instanceof APIConnectionTimeoutError) {
				throw createAbortError("Unbound")
			}
			throw handleOpenAIError(error, this.providerName)
		}
		return response.choices[0]?.message.content || ""
	}
}
