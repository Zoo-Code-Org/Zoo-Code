import { z } from "zod"

import type { ModelInfo } from "../model.js"

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
