// Fireworks AI: https://fireworks.ai
//
// There is intentionally no hardcoded model catalog here. The model list,
// capabilities and pricing are all fetched at runtime from the Fireworks API
// (see src/api/providers/fetchers/fireworks.ts).

import type { ModelInfo } from "../model.js"
import { openAiModelInfoSaneDefaults } from "./openai.js"

export const FIREWORKS_API_BASE_URL = "https://api.fireworks.ai"
export const FIREWORKS_INFERENCE_BASE_URL = `${FIREWORKS_API_BASE_URL}/inference/v1`

// Must stay a model Fireworks serves on serverless: the model picker writes this ID
// into new Fireworks profiles, so a retired model would fail the first chat request.
export const fireworksDefaultModelId = "accounts/fireworks/models/kimi-k3"

/**
 * Metadata for a model that is not (yet) in the fetched catalog. Pricing is left
 * undefined (no guessed rate), so no cost is attributed to the request. Shared by
 * the backend handler and the webview so both report the same limits.
 */
export const fireworksUnknownModelInfo: ModelInfo = {
	...openAiModelInfoSaneDefaults,
	supportsImages: false,
	inputPrice: undefined,
	outputPrice: undefined,
}
