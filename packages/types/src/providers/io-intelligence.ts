import type { ModelInfo } from "../model.js"

export const IO_INTELLIGENCE_BASE_URL = "https://api.intelligence.io.solutions/api/v1"

export const ioIntelligenceDefaultModelId = "meta-llama/Llama-3.3-70B-Instruct"

export const ioIntelligenceDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 128_000,
	supportsImages: false,
	supportsPromptCache: false,
	description: "IO Intelligence model. The full model catalog is resolved dynamically from the /models endpoint.",
}
