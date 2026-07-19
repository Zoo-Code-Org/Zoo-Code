import { MoonshotModelId, moonshotModels } from "@roo-code/types"
import { ModelInfo } from "@roo-code/types"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { ApiStreamUsageChunk } from "../transform/stream"
import { OpenAiCompatibleHandler, OpenAiCompatibleHandlerOptions } from "./openai-compatible"

export class MoonshotHandler extends OpenAiCompatibleHandler {
	constructor(options: OpenAiCompatibleHandlerOptions) {
		super({
			...options,
			providerName: "Moonshot",
			baseURL: "https://api.moonshot.cn/v1",
			getApiKey: (opts) => opts.moonshotApiKey,
			defaultModelId: "kimi-k2-0711-preview",
			models: moonshotModels,
			modelId: options.moonshotModelId,
			modelInfo: options.moonshotModelInfo,
		})
	}

	/**
	 * Override to handle Moonshot's usage metrics, including caching.
	 * Moonshot returns cached_tokens in a different location than standard OpenAI.
	 */
	protected override processUsageMetrics(usage: {
		inputTokens?: number
		outputTokens?: number
		details?: {
			cachedInputTokens?: number
			reasoningTokens?: number
		}
		raw?: Record<string, unknown>
	}): ApiStreamUsageChunk {
		// Moonshot uses cached_tokens at the top level of raw usage data
		const rawUsage = usage.raw as
			| { cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
			| undefined

		const inputTokens = usage.inputTokens || 0
		const outputTokens = usage.outputTokens || 0
		const cacheReadTokens =
			rawUsage?.cached_tokens ??
			rawUsage?.prompt_tokens_details?.cached_tokens ??
			usage.details?.cachedInputTokens ??
			0

		const modelInfo = this.getModel().info
		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, 0, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens: 0,
			cacheReadTokens: cacheReadTokens || undefined,
			totalCost,
		}
	}

	/**
	 * Override to always include max_tokens for Moonshot (not max_completion_tokens).
	 * Moonshot requires max_tokens parameter to be sent.
	 */
	protected override get maxTokens(): number | undefined {
		const model = this.getModel()
		return model.maxTokens ?? model.info.maxTokens ?? undefined
	}
}
