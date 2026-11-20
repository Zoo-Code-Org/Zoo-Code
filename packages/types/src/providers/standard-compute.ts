import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const STANDARD_COMPUTE_BASE_URL = "https://api.stdcmpt.com/v1"

/**
 * The routed model. The router picks a model from the models that the user
 * enabled, by the user's quality preference. It uses cheaper models for simple
 * steps and sends image requests to a vision model.
 */
export const standardComputeDefaultModelId = "StandardCompute"

export const standardComputeDefaultModelInfo: ModelInfo = {
	maxTokens: 32_768,
	contextWindow: 1_000_000,
	supportsImages: true,
	supportsPromptCache: false,
	description:
		"Standard Compute routed model. The router picks a model from your enabled models by your quality preference and uses cheaper models for simple steps. Image requests go to a vision model.",
}

const STANDARD_COMPUTE_MODEL_ID_FIELD = "standardComputeModelId"

export const standardComputeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.standardCompute,
	modelIdKey: STANDARD_COMPUTE_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(STANDARD_COMPUTE_MODEL_ID_FIELD),
	getDefaultModelId: () => standardComputeDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		standardComputeApiKey: z.string().optional(),
		[STANDARD_COMPUTE_MODEL_ID_FIELD]: z.string().optional(),
	},
})
