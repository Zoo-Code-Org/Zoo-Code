import type { ModelInfo } from "../model.js"

export type FriendliModelId =
	| "zai-org/GLM-5.2"
	| "zai-org/GLM-5.1"
	| "deepseek-ai/DeepSeek-V3.2"
	| "MiniMaxAI/MiniMax-M2.5"

export const friendliDefaultModelId: FriendliModelId = "zai-org/GLM-5.2"

// Pricing sourced from https://friendli.ai/api/public/model-apis (per 1M tokens).
export const friendliModels = {
	"zai-org/GLM-5.2": {
		maxTokens: 131_072,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.26,
		description:
			"GLM-5.2 is Zhipu's flagship model with a 1M context window and 128k max output, served via Friendli Model APIs. It delivers top-tier long-context reasoning, coding, and agentic performance for extended engineering sessions.",
	},
	"zai-org/GLM-5.1": {
		maxTokens: 131_072,
		contextWindow: 200_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.26,
		description:
			"GLM-5.1 is Zhipu's most capable model with a 200k context window and 128k max output, served via Friendli Model APIs. It delivers top-tier reasoning, coding, and agentic performance.",
	},
	"deepseek-ai/DeepSeek-V3.2": {
		maxTokens: 16384,
		contextWindow: 163_840,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.5,
		outputPrice: 1.5,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.25,
		description:
			"DeepSeek V3.2 is the latest iteration of the V3 model family with enhanced reasoning capabilities, improved code generation, and better instruction following, served via Friendli Model APIs.",
	},
	"MiniMaxAI/MiniMax-M2.5": {
		maxTokens: 4096,
		contextWindow: 204_800,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.06,
		description:
			"MiniMax M2.5 is a high-performance language model with a 204.8K context window, optimized for long-context understanding and generation tasks, served via Friendli Model APIs.",
	},
} as const satisfies Record<string, ModelInfo>
