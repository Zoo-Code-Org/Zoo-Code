import type { ModelInfo } from "../model.js"

// https://novita.ai/model-api/product/llm-api
export type NovitaModelId = keyof typeof novitaModels

export const novitaDefaultModelId: NovitaModelId = "moonshotai/kimi-k2.7-code"

export const novitaModels = {
	"moonshotai/kimi-k2.7-code": {
		maxTokens: 262_144,
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.95,
		outputPrice: 4.0,
		cacheReadsPrice: 0.19,
		supportsTemperature: true,
		defaultTemperature: 1.0,
		description:
			"Kimi K2.7 Code via Novita AI. A coding-focused Moonshot model exposed through Novita's OpenAI-compatible API.",
	},
	"deepseek/deepseek-v4-pro": {
		maxTokens: 393_216,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1.6,
		outputPrice: 3.2,
		cacheReadsPrice: 0.135,
		description:
			"DeepSeek V4 Pro via Novita AI. A long-context model for coding, reasoning, and general assistant workflows.",
	},
	"minimax/minimax-m3": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheReadsPrice: 0.06,
		description:
			"MiniMax M3 via Novita AI. A long-context language model for coding, agentic tasks, and general chat.",
	},
	"zai-org/glm-5.2": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheReadsPrice: 0.26,
		description:
			"GLM 5.2 via Novita AI. A long-context model for coding, reasoning, and multilingual assistant workflows.",
	},
} as const satisfies Record<string, ModelInfo>

export const novitaDefaultModelInfo: ModelInfo = novitaModels[novitaDefaultModelId]
