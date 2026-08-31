import type { ModelInfo } from "../model.js"

// OrcaRouter's OpenAI-compatible API endpoint.
export const ORCA_ROUTER_BASE_URL = "https://api.orcarouter.ai/v1"

// OrcaRouter mirrors the OpenRouter model namespace (vendor/model), so the same
// model ID shape and defaults apply.
export const orcaRouterDefaultModelId = "orcarouter/fusion-mini"

export const orcaRouterDefaultModelInfo: ModelInfo = {
	maxTokens: 128_000,
	contextWindow: 1_000_000,
	supportsImages: true,
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
	description: "OrcaRouter model. Available models and metadata are resolved dynamically from the catalog.",
}
