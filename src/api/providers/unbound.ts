import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { APIConnectionTimeoutError, APIUserAbortError } from "openai"

import {
	type ModelInfo,
	type ModelRecord,
	providerIdentifiers,
	unboundDefaultModelId,
	unboundDefaultModelInfo,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { calculateApiCostOpenAI } from "../../shared/cost"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { OpenAiReasoningParams } from "../transform/reasoning"

import { DEFAULT_HEADERS, NOT_PROVIDED } from "./constants"
import { getModels } from "./fetchers/modelCache"
import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { handleOpenAIError } from "./utils/error-handler"
import { applyRouterToolPreferences } from "./utils/router-tool-preferences"
import { createAbortError } from "./utils/abort-signal"
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

	public async fetchModel() {
		this.models = await getModels({
			provider: providerIdentifiers.unbound,
			apiKey: this.options.unboundApiKey,
		})
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

		// Per-request controller so an external abort signal (e.g. task
		// cancellation) can interrupt the in-flight streaming request.
		// Bridge it to our controller using the Bedrock pattern:
		// - pre-aborted guard: check if already aborted before adding listener
		// - { once: true }: remove listener after first abort to avoid leaks
		// The listener is stored so it can be detached when the request ends:
		// { once: true } only removes it on abort, so a task-scoped signal
		// would otherwise accumulate one listener per request.
		const controller = new AbortController()
		const externalAbortSignal = metadata?.abortSignal
		const abortListener = () => controller.abort()
		if (externalAbortSignal) {
			if (externalAbortSignal.aborted) {
				controller.abort()
			} else {
				externalAbortSignal.addEventListener("abort", abortListener, { once: true })
			}
		}

		try {
			let stream
			try {
				stream = await this.client.chat.completions.create(completionParams, { signal: controller.signal })
			} catch (error) {
				// Preserve abort identity (series standard): a cancelled request
				// must surface as a DOM-standard AbortError, not a wrapped
				// completion error.
				if (
					controller.signal.aborted ||
					error instanceof APIUserAbortError ||
					(error instanceof Error && error.name === "AbortError")
				) {
					throw createAbortError("Unbound")
				}
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
		} finally {
			externalAbortSignal?.removeEventListener("abort", abortListener)
		}
	}

	async completePrompt(prompt: string, options?: CompletePromptOptions): Promise<string> {
		const { id: model, maxTokens: max_tokens, temperature } = await this.fetchModel()

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
		if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
			createOptions.timeout = options.timeoutMs
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
			if (
				options?.abortSignal?.aborted ||
				error instanceof APIUserAbortError ||
				error instanceof APIConnectionTimeoutError ||
				(error instanceof Error && error.name === "AbortError")
			) {
				throw createAbortError("Unbound")
			}
			throw handleOpenAIError(error, this.providerName)
		}
		return response.choices[0]?.message.content || ""
	}
}
