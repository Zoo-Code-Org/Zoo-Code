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

/**
 * Static fallback catalog. IO Intelligence serves an OpenAI-compatible
 * /models endpoint; these ids mirror the live catalog so that a sensible
 * set is available before the dynamic fetch completes.
 */
export const ioIntelligenceModels: Record<string, ModelInfo> = {
	"meta-llama/Llama-3.3-70B-Instruct": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "Meta: Llama 3.3 70B Instruct",
	},
	"meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
		maxTokens: 8192,
		contextWindow: 430_000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "Meta-Llama: Llama 4 Maverick 17B 128E Instruct FP8",
	},
	"deepseek-ai/DeepSeek-R1-0528": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "DeepSeek: R1 0528",
	},
	"Intel/Qwen3-Coder-480B-A35B-Instruct-int4-mixed-ar": {
		maxTokens: 8192,
		contextWindow: 106_000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "Intel: Qwen3 Coder 480B A35B Instruct INT4 Mixed AR",
	},
	"openai/gpt-oss-120b": {
		maxTokens: 8192,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		description: "OpenAI: gpt-oss-120b",
	},
	"zai-org/GLM-4.6": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: false,
		description: "Z.ai: GLM 4.6",
	},
}
