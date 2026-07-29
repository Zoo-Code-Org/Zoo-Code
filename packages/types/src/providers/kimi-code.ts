import type { ModelInfo } from "../model.js"

export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1"
export const kimiCodeDefaultModelId = "kimi-for-coding"

export const kimiCodeReasoningEfforts = ["low", "high", "max"] as const

export const kimiCodeDefaultModelInfo: ModelInfo = {
	contextWindow: 262_144,
	maxTokens: 32_768,
	supportsImages: false,
	supportsPromptCache: false,
	supportsReasoningEffort: [...kimiCodeReasoningEfforts],
	requiredReasoningEffort: true,
	reasoningEffort: "max",
	description: "Kimi Code's coding model for subscription and API-key access.",
}

export const kimiCodeModels = {
	[kimiCodeDefaultModelId]: kimiCodeDefaultModelInfo,
} as const satisfies Record<string, ModelInfo>

export type KimiCodeModelId = keyof typeof kimiCodeModels
