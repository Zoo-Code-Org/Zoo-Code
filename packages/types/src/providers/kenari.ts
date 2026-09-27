import type { ModelInfo } from "../model.js"

// Kenari: Indonesian OpenAI-compatible AI gateway billed in Rupiah (IDR).
// https://kenari.id/docs · base URL: https://kenari.id/v1
//
// The full model list (and metadata) is fetched dynamically from
// `https://kenari.id/v1/models`, so models can be switched on the fly.
// The values below are only a fallback used before the live list resolves.

// Single source of truth for the gateway base URL, shared by the handler and
// the model fetcher so the endpoint is defined in exactly one place.
export const KENARI_BASE_URL = "https://kenari.id/v1"

export const kenariDefaultModelId = "glm-5-2"

export const kenariDefaultModelInfo: ModelInfo = {
	maxTokens: 32_768,
	contextWindow: 1_048_576,
	supportsImages: false,
	supportsPromptCache: false,
	// Pricing is intentionally omitted: Kenari bills in IDR (micro-rupiah per 1M tokens),
	// which cannot be rendered in the USD price fields without a misleading conversion.
	description: "Kenari model. Available models and metadata are resolved dynamically from /v1/models.",
}

export const KENARI_DEFAULT_TEMPERATURE = 0
