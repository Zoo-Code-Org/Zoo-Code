import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

// Infer: OpenAI-compatible gateway to OpenAI, Anthropic, Google and xAI models.
// https://infer.flow7.org/docs · base URL: https://infer.flow7.org/v1
//
// A model id selects a model and a route, for example `infer/claude-opus-5-5:low-cost`.
// The routes are Low cost, Balanced, Stable and Official, at different prices.
// The public catalog lists each route with its prices and limits, so the model list
// is fetched at runtime. The values below are only a fallback for the time before
// the catalog resolves.

export const INFER_BASE_URL = "https://infer.flow7.org/v1"

export const INFER_CATALOG_URL = "https://infer.flow7.org/api/public/catalog"

export const inferDefaultModelId = "infer/claude-opus-5-5:low-cost"

export const inferDefaultModelInfo: ModelInfo = {
	maxTokens: 128_000,
	contextWindow: 1_000_000,
	supportsImages: false,
	supportsPromptCache: false,
	// Prices are intentionally omitted: they come only from the live catalog, so a
	// fallback never shows a stale price.
	description: "Infer model. Routes, prices and limits are resolved dynamically from the public catalog.",
}

const INFER_MODEL_ID_FIELD = "inferModelId"

export const inferProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.infer,
	modelIdKey: INFER_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(INFER_MODEL_ID_FIELD),
	getDefaultModelId: () => inferDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		inferApiKey: z.string().optional(),
		[INFER_MODEL_ID_FIELD]: z.string().optional(),
	},
})
