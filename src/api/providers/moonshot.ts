import OpenAI from "openai"

import { moonshotModels, moonshotDefaultModelId, type ModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAiHandler } from "./openai"

export class MoonshotHandler extends OpenAiHandler {
	constructor(options: ApiHandlerOptions) {
		// Map Moonshot-specific options to the OpenAI-compatible options that
		// OpenAiHandler expects. This makes Moonshot use the same battle-tested
		// OpenAI Node SDK path as the generic "OpenAI Compatible" provider.
		super({
			...options,
			openAiApiKey: options.moonshotApiKey ?? "not-provided",
			openAiModelId: options.apiModelId ?? moonshotDefaultModelId,
			openAiBaseUrl: options.moonshotBaseUrl || "https://api.moonshot.ai/v1",
		})
	}

	/**
	 * Resolve the ModelInfo for a given Moonshot model ID.
	 * Unknown IDs (e.g. dynamically fetched future models) keep the configured ID
	 * but fall back to the default model's structural metadata with pricing stripped
	 * so cost reporting shows "unknown" instead of charging the default model's rates.
	 */
	private static resolveModelInfo(modelId: string): ModelInfo {
		const knownInfo = moonshotModels[modelId as keyof typeof moonshotModels]
		if (knownInfo) {
			return knownInfo
		}

		const defaultInfo = moonshotModels[moonshotDefaultModelId]
		return {
			...defaultInfo,
			maxTokens: undefined,
			inputPrice: undefined,
			outputPrice: undefined,
			cacheReadsPrice: undefined,
			cacheWritesPrice: undefined,
		}
	}

	override getModel() {
		const id = this.options.openAiModelId ?? moonshotDefaultModelId
		const info = MoonshotHandler.resolveModelInfo(id)
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})
		return { id, info, ...params }
	}

	/**
	 * Override to handle Moonshot's usage metrics, including caching.
	 * Moonshot returns cached_tokens in a different location than standard OpenAI.
	 */
	protected override processUsageMetrics(usage: any, _modelInfo?: ModelInfo): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens: 0,
			cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens,
		}
	}

	/**
	 * Override to always include max_tokens for Moonshot (not max_completion_tokens).
	 * Moonshot requires max_tokens parameter to be sent.
	 */
	protected override addMaxTokensIfNeeded(
		requestOptions:
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
			| OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
		modelInfo: ModelInfo,
	): void {
		// Moonshot always requires max_tokens (not max_completion_tokens)
		requestOptions.max_tokens = this.options.modelMaxTokens || modelInfo.maxTokens || undefined
	}
}
