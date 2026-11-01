import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

// Requesty
// https://requesty.ai/router-2
export const requestyDefaultModelId = "coding/claude-4-sonnet"

export const requestyDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description:
		"The best coding model, optimized by Requesty, and automatically routed to the fastest provider. Claude 4 Sonnet is an advanced large language model with improved reasoning, coding, and problem-solving capabilities.",
}

export const REQUESTY_MODEL_ID_FIELD = "requestyModelId"

export const requestyProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.requesty,
	modelIdKey: REQUESTY_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(REQUESTY_MODEL_ID_FIELD),
	getDefaultModelId: () => requestyDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		requestyBaseUrl: z.string().optional(),
		requestyApiKey: z.string().optional(),
		[REQUESTY_MODEL_ID_FIELD]: z.string().optional(),
	},
})
