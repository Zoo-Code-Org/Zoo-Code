import { z } from "zod"

import type { ModelInfo } from "../model.js"

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
