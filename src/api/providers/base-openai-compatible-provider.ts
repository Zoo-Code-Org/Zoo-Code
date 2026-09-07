import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "../../shared/api"
import { TagMatcher } from "../../utils/tag-matcher"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import { handleOpenAIError, handleOpenAIRequestError } from "./utils/error-handler"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"
import { RequestConfigBuilder } from "./config-builder/request-config-builder"
import { mergeAbortSignalAndTimeout, throwIfAborted } from "./utils/abort-signal"

type BaseOpenAiCompatibleProviderOptions<ModelName extends string> = ApiHandlerOptions & {
	providerName: string
	baseURL: string
	defaultProviderModelId: ModelName
	providerModels: Record<ModelName, ModelInfo>
	defaultTemperature?: number
}

/** Subset of OpenAI.RequestOptions built per request for the abort-signal wiring. */
type OpenAiRequestConfig = {
	signal?: AbortSignal
	/** Per-request SDK timeout (ms); overrides the client-level default when set. */
	timeout?: number
}

export abstract class BaseOpenAiCompatibleProvider<ModelName extends string>
	extends BaseProvider
	implements SingleCompletionHandler
{
	protected readonly providerName: string
	protected readonly baseURL: string
	protected readonly defaultTemperature: number
	protected readonly defaultProviderModelId: ModelName
	protected readonly providerModels: Record<ModelName, ModelInfo>

	protected readonly options: ApiHandlerOptions

	protected client: OpenAI

	constructor({
		providerName,
		baseURL,
		defaultProviderModelId,
		providerModels,
		defaultTemperature,
		...options
	}: BaseOpenAiCompatibleProviderOptions<ModelName>) {
		super()

		this.providerName = providerName
		this.baseURL = baseURL
		this.defaultProviderModelId = defaultProviderModelId
		this.providerModels = providerModels
		this.defaultTemperature = defaultTemperature ?? 0

		this.options = options

		if (!this.options.apiKey) {
			throw new Error("API key is required")
		}

		this.client = new OpenAI({
			baseURL,
			apiKey: this.options.apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: this.timeoutMs,
		})
	}

	protected async createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const { id: model, info } = this.getModel()

		// Centralized cap: clamp to 20% of the context window (unless provider-specific exceptions apply)
		const max_tokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature = this.options.modelTemperature ?? info.defaultTemperature ?? this.defaultTemperature

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model,
			max_tokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && info.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		try {
			return await this.client.chat.completions.create(params, requestOptions)
		} catch (error) {
			throw handleOpenAIRequestError(error, this.providerName, metadata?.abortSignal)
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		throwIfAborted(metadata?.abortSignal)

		// Per-request abort wiring (RequestConfigBuilder adoption): subclasses inherit
		// it by receiving the built config as createStream's requestOptions.
		const requestConfig = new RequestConfigBuilder<OpenAiRequestConfig>().setAbortSignal(metadata).build()
		const stream = await this.createStream(systemPrompt, messages, metadata, requestConfig)

		const matcher = new TagMatcher(
			["think", "thought"],
			(chunk) =>
				({
					type: chunk.matched ? "reasoning" : "text",
					text: chunk.data,
				}) as const,
		)

		let lastUsage: OpenAI.CompletionUsage | undefined
		const activeToolCallIds = new Set<string>()

		try {
			for await (const chunk of stream) {
				// Check for provider-specific error responses (e.g., MiniMax base_resp).
				// ChatCompletionChunk has no base_resp member, so read it through an
				// unknown guard instead of casting the whole chunk.
				const chunkUnknown: unknown = chunk
				const baseResp: unknown =
					typeof chunkUnknown === "object" && chunkUnknown !== null && "base_resp" in chunkUnknown
						? (chunkUnknown as { base_resp?: unknown }).base_resp
						: undefined
				const baseRespFields =
					// Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent for all JSON-reachable baseResp values: null/undefined/primitive yield undefined through the optional-chained status reads and object values behave identically under every guard variant
					baseResp !== null && typeof baseResp === "object"
						? (baseResp as Record<string, unknown>)
						: undefined
				const baseRespStatusCode = baseRespFields?.["status_code"]
				const baseRespStatusMsg = baseRespFields?.["status_msg"]
				if (
					baseRespStatusCode &&
					// Stryker disable next-line ConditionalExpression: a truthy baseRespStatusCode is necessarily !== 0 and the trailing typeof gate reproduces the original result for falsy values
					baseRespStatusCode !== 0 &&
					(typeof baseRespStatusCode === "number" || typeof baseRespStatusCode === "string")
				) {
					throw new Error(
						`${this.providerName} API Error (${baseRespStatusCode}): ${
							typeof baseRespStatusMsg === "string" ? baseRespStatusMsg : "Unknown error"
						}`,
					)
				}

				const delta = chunk.choices?.[0]?.delta
				const finishReason = chunk.choices?.[0]?.finish_reason

				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				if (delta?.content) {
					for (const processedChunk of matcher.update(delta.content)) {
						yield processedChunk
					}
				}

				// Emit raw tool call chunks - NativeToolCallParser handles state management
				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						if (toolCall.id) {
							activeToolCallIds.add(toolCall.id)
						}
						yield {
							type: "tool_call_partial",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				// Emit tool_call_end events when finish_reason is "tool_calls"
				// This ensures tool calls are finalized even if the stream doesn't properly close
				// Stryker disable next-line ConditionalExpression,EqualityOperator: with an empty activeToolCallIds the guarded loop yields nothing and clear() is a no-op, so the size guard is unobservable
				if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
					for (const id of activeToolCallIds) {
						yield { type: "tool_call_end", id }
					}
					activeToolCallIds.clear()
				}

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}
		} catch (error) {
			// The creation-site catch does not cover errors raised by the async
			// iterator itself (e.g. a mid-stream abort); normalize them the same way.
			throw handleOpenAIRequestError(error, this.providerName, metadata?.abortSignal)
		}

		if (lastUsage) {
			yield this.processUsageMetrics(lastUsage, this.getModel().info)
		}

		// Process any remaining content
		for (const processedChunk of matcher.final()) {
			yield processedChunk
		}
	}

	protected processUsageMetrics(usage: any, modelInfo?: any): ApiStreamUsageChunk {
		const inputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0

		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens: cacheWriteTokens || undefined,
			cacheReadTokens: cacheReadTokens || undefined,
			totalCost,
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		throwIfAborted(options?.abortSignal)

		const { id: modelId, info: modelInfo } = this.getModel()

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && modelInfo.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		// CompletePromptOptions is not ApiHandlerCreateMessageMetadata (required taskId),
		// so the abort/timeout merge goes through setOption; the helper treats
		// timeoutMs <= 0 as "no explicit timeout". The per-request timeout is
		// forwarded as well: without it the SDK falls back to the client-level
		// default, which can still expire before a larger per-request timeoutMs.
		const requestTimeout =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : undefined
		const requestConfig = new RequestConfigBuilder<OpenAiRequestConfig>()
			.setOption("signal", mergeAbortSignalAndTimeout(options?.abortSignal, options?.timeoutMs))
			.setOption("timeout", requestTimeout)
			.build()

		try {
			const response = await this.client.chat.completions.create(params, requestConfig)

			// Check for provider-specific error responses (e.g., MiniMax base_resp)
			const responseAny = response as any
			if (responseAny.base_resp?.status_code && responseAny.base_resp.status_code !== 0) {
				throw new Error(
					`${this.providerName} API Error (${responseAny.base_resp.status_code}): ${responseAny.base_resp.status_msg || "Unknown error"}`,
				)
			}

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIRequestError(error, this.providerName, options?.abortSignal)
		}
	}

	override getModel() {
		const id =
			this.options.apiModelId && this.options.apiModelId in this.providerModels
				? (this.options.apiModelId as ModelName)
				: this.defaultProviderModelId

		return { id, info: this.providerModels[id] }
	}
}
