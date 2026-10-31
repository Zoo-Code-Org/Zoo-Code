import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	baseProviderSettingsShape,
	createModelIdAccessor,
	createProviderDefinition,
	NO_DEFAULT_MODEL_ID,
} from "./common.js"

// Ollama
// https://ollama.com/models
export const ollamaModelsMessageTypes = ["requestOllamaModels", "ollamaModels"] as const

export const ollamaModelsMessageTypeSchema = z.enum(ollamaModelsMessageTypes)

export const OllamaModelsMessageType = ollamaModelsMessageTypeSchema.enum

export type OllamaModelsMessageType = z.infer<typeof ollamaModelsMessageTypeSchema>

export const ollamaDefaultModelId = "devstral:24b"
export const ollamaDefaultModelInfo: ModelInfo = {
	maxTokens: 4096,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	outputPrice: 0,
	cacheWritesPrice: 0,
	cacheReadsPrice: 0,
	description: "Ollama hosted models",
}

export const OLLAMA_MODEL_ID_FIELD = "ollamaModelId"

export const ollamaProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.ollama,
	modelIdKey: OLLAMA_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OLLAMA_MODEL_ID_FIELD),
	// Ollama models are discovered from the local server, so there is no default.
	getDefaultModelId: () => NO_DEFAULT_MODEL_ID,
	schema: {
		...baseProviderSettingsShape,
		[OLLAMA_MODEL_ID_FIELD]: z.string().optional(),
		ollamaBaseUrl: z.string().optional(),
		ollamaApiKey: z.string().optional(),
		ollamaNumCtx: z.number().int().min(128).optional(),
	},
})
