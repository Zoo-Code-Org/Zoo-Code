import type { ModelInfo } from "../model.js"

export const UMANS_DEFAULT_BASE_URL = "https://api.code.umans.ai/v1"

// Umans
// https://api.code.umans.ai/v1/models/info
export const umansDefaultModelId = "umans-coder"

export const umansDefaultModelInfo: ModelInfo = {
	maxTokens: 32_768,
	contextWindow: 262_144,
	supportsImages: true,
	supportsPromptCache: false,
	supportsMaxTokens: true,
	inputPrice: 0.95,
	outputPrice: 4.0,
	description: "Umans Coder is Umans' recommended model for complex, coding-heavy workloads and coding agents.",
}
