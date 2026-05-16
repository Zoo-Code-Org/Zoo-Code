import type { ModelInfo } from "../model.js"

// https://platform.xiaomimimo.com/static/docs/pricing.md
// https://platform.xiaomimimo.com/static/docs/api/chat/openai-api.md
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-v2.5-pro"

export const mimoModels = {
	"mimo-v2.5-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false, // Pro series is text-only per official docs
		supportsPromptCache: true,
		preserveReasoning: true,
		// Overseas pricing (≤256K input) — https://platform.xiaomimimo.com/static/docs/pricing.md
		inputPrice: 1.0, // $1.00/1M tokens (cache miss)
		outputPrice: 3.0, // $3.00/1M tokens
		cacheReadsPrice: 0.2, // $0.20/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.5 Pro - Xiaomi's flagship reasoning model with 1M context, deep thinking, tool calling, and structured output.",
	},
	"mimo-v2.5": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		// Full-modal: supports image, audio, and video input
		// https://platform.xiaomimimo.com/static/docs/api/chat/openai-api.md
		// "Currently, only the mimo-v2.5 and mimo-v2-omni models support image, audio, or video input."
		supportsImages: true,
		supportsPromptCache: true,
		preserveReasoning: true,
		// Overseas pricing (≤256K input) — https://platform.xiaomimimo.com/static/docs/pricing.md
		inputPrice: 0.4, // $0.40/1M tokens (cache miss)
		outputPrice: 2.0, // $2.00/1M tokens
		cacheReadsPrice: 0.08, // $0.08/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		// "Full Modal Understanding Model" is the official category name from MiMo docs
		description:
			"MiMo V2.5 - Full-modal understanding model (text, image, audio, video) with 1M context, deep thinking, tool calling, and structured output.",
	},
} as const satisfies Record<string, ModelInfo>

export const mimoDefaultModelInfo: ModelInfo = mimoModels[mimoDefaultModelId]

export const MIMO_DEFAULT_TEMPERATURE = 1.0
