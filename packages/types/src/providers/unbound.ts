import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

// Unbound
// https://gateway.getunbound.ai
export const unboundDefaultModelId = "anthropic/claude-sonnet-4-5"

export const unboundDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
}

export const UNBOUND_MODEL_ID_FIELD = "unboundModelId"

export const unboundProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.unbound,
	modelIdKey: UNBOUND_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(UNBOUND_MODEL_ID_FIELD),
	getDefaultModelId: () => unboundDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		unboundApiKey: z.string().optional(),
		[UNBOUND_MODEL_ID_FIELD]: z.string().optional(),
	},
})
