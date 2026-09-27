import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OLLAMA_MODEL_ID_FIELD = "ollamaModelId"

export const ollamaProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.ollama,
	modelIdKey: OLLAMA_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OLLAMA_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		[OLLAMA_MODEL_ID_FIELD]: z.string().optional(),
		ollamaBaseUrl: z.string().optional(),
		ollamaApiKey: z.string().optional(),
		ollamaNumCtx: z.number().int().min(128).optional(),
	},
})
