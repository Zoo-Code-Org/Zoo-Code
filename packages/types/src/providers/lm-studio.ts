import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	baseProviderSettingsShape,
	createModelIdAccessor,
	createProviderDefinition,
	NO_DEFAULT_MODEL_ID,
} from "./common.js"

export const lmStudioModelsMessageTypes = ["requestLmStudioModels", "lmStudioModels"] as const

export const lmStudioModelsMessageTypeSchema = z.enum(lmStudioModelsMessageTypes)

export const LmStudioModelsMessageType = lmStudioModelsMessageTypeSchema.enum

export type LmStudioModelsMessageType = z.infer<typeof lmStudioModelsMessageTypeSchema>

export const LMSTUDIO_DEFAULT_TEMPERATURE = 0

// LM Studio
// https://lmstudio.ai/docs/cli/ls
export const lMStudioDefaultModelId = "mistralai/devstral-small-2505"
export const lMStudioDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	outputPrice: 0,
	cacheWritesPrice: 0,
	cacheReadsPrice: 0,
	description: "LM Studio hosted models",
}

export const LM_STUDIO_MODEL_ID_FIELD = "lmStudioModelId"

export const lmStudioProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.lmstudio,
	modelIdKey: LM_STUDIO_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(LM_STUDIO_MODEL_ID_FIELD),
	// LM Studio models are discovered from the local server, so there is no default.
	getDefaultModelId: () => NO_DEFAULT_MODEL_ID,
	schema: {
		...baseProviderSettingsShape,
		[LM_STUDIO_MODEL_ID_FIELD]: z.string().optional(),
		lmStudioBaseUrl: z.string().optional(),
		lmStudioDraftModelId: z.string().optional(),
		lmStudioSpeculativeDecodingEnabled: z.boolean().optional(),
	},
})
