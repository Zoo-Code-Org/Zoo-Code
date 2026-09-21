import type { ModelInfo } from "../model.js"

// https://mimo.mi.com/docs/en-US/quick-start/model-hyperparameters
// https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking
// https://mimo.mi.com/docs/en-US/price/pay-as-you-go
//
// mimo-v2.5-pro and mimo-v2.5 are deprecated on 2026-10-21 10:00 (GMT+8) and
// their model names will stop working. They stay in the catalog as a fallback
// until the EOL date passes; mimo-v2.6-* entries carry the V2.6 series.
//
// NOTE: mimo-v2-flash is not included here. Its thinking mode defaults to
// disabled and it doesn't reliably handle reasoning_content passthrough
// during multi-turn tool calling, which causes 400 errors from the proxy.
// If flash support is needed later, it should be validated against the API
// first — the tool-calling + thinking flow is what makes MiMo useful as
// an agentic provider, and flash just can't do that yet.
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-v2.6-pro"

export const mimoModels = {
	"mimo-v2.6-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // V2.6 series is full-modality (text, image, audio, video)
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.435, // $0.435/1M tokens (cache miss)
		outputPrice: 0.87, // $0.87/1M tokens
		cacheReadsPrice: 0.0036, // $0.0036/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Pro - Xiaomi's flagship omni-modal reasoning model with 1M context, deep thinking, tool calling, and structured output.",
	},
	"mimo-v2.6-flash": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // Full-modality: text, image, audio, video input
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.14, // $0.14/1M tokens (cache miss)
		outputPrice: 0.28, // $0.28/1M tokens
		cacheReadsPrice: 0.0028, // $0.0028/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Flash - Full-modality, low-cost reasoning model for high-frequency calls and large-scale tasks.",
	},
	"mimo-v2.6-pro-ultraspeed": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // Full-modality like the rest of the V2.6 series
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 4.35, // $4.35/1M tokens (cache miss)
		outputPrice: 8.7, // $8.70/1M tokens
		cacheReadsPrice: 0.036, // $0.036/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Pro Ultraspeed - V2.6-Pro performance at up to 20x speed for real-time, latency-sensitive workloads.",
	},
	"mimo-v2.5-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false, // Pro series is text-only
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.435, // $0.435/1M tokens (cache miss)
		outputPrice: 0.87, // $0.87/1M tokens
		cacheReadsPrice: 0.0036, // $0.0036/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.5 Pro - Deprecated on 2026-10-21. Xiaomi's flagship reasoning model with 1M context, deep thinking, tool calling, and structured output.",
	},
	"mimo-v2.5": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // Full-modal: text, image, audio, video input
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.14, // $0.14/1M tokens (cache miss)
		outputPrice: 0.28, // $0.28/1M tokens
		cacheReadsPrice: 0.0028, // $0.0028/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.5 - Deprecated on 2026-10-21. Full-modal understanding model (text, image, audio, video) with 1M context, deep thinking, tool calling, and structured output.",
	},
} as const satisfies Record<string, ModelInfo>

export const mimoDefaultModelInfo: ModelInfo = mimoModels[mimoDefaultModelId]

export const MIMO_DEFAULT_TEMPERATURE = 1.0
