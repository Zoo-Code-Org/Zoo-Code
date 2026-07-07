import type { ModelInfo } from "../model.js"

// https://platform.moonshot.ai/
export type MoonshotModelId = keyof typeof moonshotModels

export const moonshotDefaultModelId: MoonshotModelId = "kimi-k2-0905-preview"

export const moonshotModels = {
	"kimi-k2-0711-preview": {
		maxTokens: 32_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 2.5, // $2.50 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.15, // $0.15 per million tokens (cache hit)
		description: `Kimi K2 is a state-of-the-art mixture-of-experts (MoE) language model with 32 billion activated parameters and 1 trillion total parameters.`,
	},
	"kimi-k2-0905-preview": {
		maxTokens: 16384,
		contextWindow: 262144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 2.5,
		cacheReadsPrice: 0.15,
		description:
			"Kimi K2 model gets a new version update: Agentic coding: more accurate, better generalization across scaffolds. Frontend coding: improved aesthetics and functionalities on web, 3d, and other tasks. Context length: extended from 128k to 256k, providing better long-horizon support.",
	},
	"kimi-k2-turbo-preview": {
		maxTokens: 32_000,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 2.4, // $2.40 per million tokens (cache miss)
		outputPrice: 10, // $10.00 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.6, // $0.60 per million tokens (cache hit)
		description: `Kimi K2 Turbo is a high-speed version of the state-of-the-art Kimi K2 mixture-of-experts (MoE) language model, with the same 32 billion activated parameters and 1 trillion total parameters, optimized for output speeds of up to 60 tokens per second, peaking at 100 tokens per second.`,
	},
	"kimi-k2-thinking": {
		maxTokens: 16_000, // Recommended ≥ 16,000
		contextWindow: 262_144, // 262,144 tokens
		supportsImages: false, // Text-only (no image/vision support)
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 2.5, // $2.50 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache miss)
		cacheReadsPrice: 0.15, // $0.15 per million tokens (cache hit)
		supportsTemperature: true, // Default temperature: 1.0
		preserveReasoning: true,
		defaultTemperature: 1.0,
		description: `The kimi-k2-thinking model is a general-purpose agentic reasoning model developed by Moonshot AI. Thanks to its strength in deep reasoning and multi-turn tool use, it can solve even the hardest problems.`,
	},
	"kimi-k2.5": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true, // Supports text, image, and video input
		supportsPromptCache: true,
		inputPrice: 0.6, // $0.60 per million tokens (cache miss)
		outputPrice: 3.0, // $3.00 per million tokens
		cacheReadsPrice: 0.1, // $0.10 per million tokens (cache hit)
		supportsTemperature: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2.5 supports text, image, and video input, thinking and non-thinking modes, and dialogue and agent tasks. Context length 256k.",
	},
	"kimi-k2.6": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true, // Native multimodal: text, image, video
		supportsPromptCache: true,
		inputPrice: 0.95, // $0.95 per million tokens (cache miss)
		outputPrice: 4.0, // $4.00 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache writes)
		cacheReadsPrice: 0.16, // $0.16 per million tokens (cache hit)
		description:
			"Kimi K2.6 is Kimi's latest and most intelligent model with stronger long-term code writing capabilities, improved instruction compliance, and self-correction. Native multimodal architecture supporting text, image, and video input. Context length 256k.",
	},
	"kimi-k2.7-code": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true, // Native multimodal: text, image, video
		supportsPromptCache: true,
		inputPrice: 0.95, // $0.95 per million tokens (cache miss)
		outputPrice: 4.0, // $4.00 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache writes)
		cacheReadsPrice: 0.19, // $0.19 per million tokens (cache hit)
		description:
			"Kimi K2.7 Code is Kimi's most intelligent Coding model for higher success rates in long context programming tasks. Native multimodal architecture supporting text, image, and video input. Context length 256k.",
	},
	"kimi-k2.7-code-highspeed": {
		maxTokens: 16_384,
		contextWindow: 262_144,
		supportsImages: true, // Native multimodal: text, image, video
		supportsPromptCache: true,
		inputPrice: 1.9, // $1.90 per million tokens (cache miss)
		outputPrice: 8.0, // $8.00 per million tokens
		cacheWritesPrice: 0, // $0 per million tokens (cache writes)
		cacheReadsPrice: 0.38, // $0.38 per million tokens (cache hit)
		description:
			"Kimi K2.7 Code HighSpeed is the high-speed version of Kimi K2.7 Code with output speed of approximately 180 Tokens/s (up to 260 Tokens/s in short context). Same model architecture, faster output. Context length 256k.",
	},
} as const satisfies Record<string, ModelInfo>

export const MOONSHOT_DEFAULT_TEMPERATURE = 0.6
