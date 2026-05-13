import type { ModelInfo } from "../model.js"

// https://platform.xiaomimimo.com/static/docs/pricing.md
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-v2.5-pro"

export const mimoModels = {
	"mimo-v2.5-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 1.0, // $1.00 per million tokens (cache miss, ≤256K)
		outputPrice: 3.0, // $3.00 per million tokens
		cacheReadsPrice: 0.2, // $0.20 per million tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.5 Pro - Xiaomi's flagship reasoning model with 1M context, interleaved thinking, tool calling, and structured output.",
	},
	"mimo-v2.5": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.4, // $0.40 per million tokens (cache miss, ≤256K)
		outputPrice: 2.0, // $2.00 per million tokens
		cacheReadsPrice: 0.08, // $0.08 per million tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.5 - Full modal understanding model with 1M context, deep thinking, tool calling, and structured output.",
	},
	"mimo-v2-flash": {
		maxTokens: 65_536,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.1, // $0.10 per million tokens (cache miss)
		outputPrice: 0.3, // $0.30 per million tokens
		description: "MiMo V2 Flash - Fast and cost-effective reasoning model with tool calling support.",
	},
} as const satisfies Record<string, ModelInfo>

export const mimoDefaultModelInfo: ModelInfo = mimoModels[mimoDefaultModelId]

export const MIMO_DEFAULT_TEMPERATURE = 1.0
