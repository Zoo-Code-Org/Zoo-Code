import type { ModelInfo } from "../model.js"

export type FriendliModelId = "zai-org/GLM-5.2"

export const friendliDefaultModelId: FriendliModelId = "zai-org/GLM-5.2"

// Static fallback for the Friendli provider. Used as a fallback when dynamic
// models cannot be fetched (cold start, network errors, API lag), in tests,
// and in the webview's MODELS_BY_PROVIDER fallback. The provider itself fetches
// the live list from https://api.friendli.ai/serverless/v1/models at runtime.
// Only the default model is seeded statically — all other models come from the
// live /v1/models response. Pricing sourced from the live API response.
export const friendliModels: Record<string, ModelInfo> = {
	"zai-org/GLM-5.2": {
		maxTokens: 1_048_576,
		contextWindow: 1_048_576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsMaxTokens: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0.26,
		supportsReasoningEffort: ["high", "max"],
		reasoningEffort: "high",
		description: "Open flagship GLM for long-horizon coding agents and million-token context work",
	},
}
