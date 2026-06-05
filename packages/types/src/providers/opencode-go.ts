import type { ModelInfo } from "../model.js"

// Opencode "Go" plan — OpenAI-compatible gateway.
// https://opencode.ai/docs/go/ · base URL: https://opencode.ai/zen/go/v1
//
// The full model list (and metadata) is fetched dynamically from
// `https://opencode.ai/zen/go/v1/models`, so models can be switched on the fly.
// The values below are only a fallback used before the live list resolves.
export const opencodeGoDefaultModelId = "glm-5.1"

export const opencodeGoDefaultModelInfo: ModelInfo = {
	maxTokens: 32_768,
	contextWindow: 200_000,
	supportsImages: false,
	supportsPromptCache: false,
	// Pricing is intentionally omitted: ModelInfoView renders a `0` field as "$0.00 / 1M tokens"
	// (implying the service is free), so we leave it unknown — consistent with the dynamically
	// fetched models, which also leave price fields absent. See PR #319 review.
	description: "Opencode Go plan model. Available models and metadata are resolved dynamically from /v1/models.",
}

export const OPENCODE_GO_DEFAULT_TEMPERATURE = 0
