import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	type ModelRecord,
	umansDefaultModelId,
	umansDefaultModelInfo,
	UMANS_DEFAULT_BASE_URL,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { calculateApiCostOpenAI } from "../../shared/cost"

import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { DEFAULT_HEADERS } from "./constants"
import { getModels } from "./fetchers/modelCache"
import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { applyRouterToolPreferences } from "./utils/router-tool-preferences"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

type UmansUsage = OpenAI.CompletionUsage & {
	prompt_tokens_details?: {
		cache_write_tokens?: number
		caching_tokens?: number
		cached_tokens?: number
	}
}

export class UmansHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	protected models: ModelRecord = {}
	private client: OpenAI
	private readonly providerName = "Umans"

	constructor(options: ApiHandlerOptions) {
		super()

		this.options = options

		const apiKey = this.options.umansApiKey ?? "not-provided"

		this.client = new OpenAI({
			baseURL: UMANS_DEFAULT_BASE_URL,
			apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: this.timeoutMs,
		})
	}

	public async fetchModel() {
		this.models = await getModels({ provider: "umans" })
		return this.getModel()
	}

	override getModel() {
		const id = this.options.umansModelId ?? umansDefaultModelId
		const cachedInfo = this.models[id] ?? umansDefaultModelInfo
		let info: ModelInfo = cachedInfo

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
		const umansUsage = usage as UmansUsage
		const inputTokens = umansUsage?.prompt_tokens || 0
		const outputTokens = umansUsage?.completion_tokens || 0
		const cacheWriteTokens =
			umansUsage?.prompt_tokens_details?.cache_write_tokens ||
			umansUsage?.prompt_tokens_details?.caching_tokens ||
			0
		const cacheReadTokens = umansUsage?.prompt_tokens_details?.cached_tokens || 0
		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			totalCost,
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: model, info, maxTokens: max_tokens, temperature, reasoning } = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const completionParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			messages: openAiMessages,
			model,
			max_tokens,
			temperature,
			...(reasoning ?? {}),
			stream: true,
			stream_options: { include_usage: true },
			tools: this.convertToolsForOpenAI(metadata?.tools),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		let stream
		try {
			stream = await this.client.chat.completions.create(completionParams)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
		let lastUsage: any = undefined

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta

			if (delta?.content) {
				yield { type: "text", text: delta.content }
			}

			const reasoningText = extractReasoningFromDelta(delta)
			if (reasoningText) {
				yield { type: "reasoning", text: reasoningText }
			}

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

	async completePrompt(prompt: string): Promise<string> {
		const { id: model, maxTokens: max_tokens, temperature, reasoning } = await this.fetchModel()

		const completionParams: OpenAI.Chat.ChatCompletionCreateParams = {
			model,
			max_tokens,
			messages: [{ role: "system", content: prompt }],
			temperature,
			...(reasoning ?? {}),
		}

		let response: OpenAI.Chat.ChatCompletion
		try {
			response = await this.client.chat.completions.create(completionParams)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}

		return response.choices[0]?.message.content || ""
	}
}
