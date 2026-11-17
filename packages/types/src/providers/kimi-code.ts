import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1"
export const kimiCodeDefaultModelId = "kimi-for-coding"

export const kimiCodeReasoningEfforts = ["low", "high", "max"] as const

export const kimiCodeDefaultModelInfo: ModelInfo = {
	contextWindow: 262_144,
	maxTokens: 131_072,
	supportsImages: false,
	supportsPromptCache: false,
	supportsReasoningEffort: [...kimiCodeReasoningEfforts],
	requiredReasoningEffort: true,
	reasoningEffort: "max",
	description: "Kimi Code's coding model for subscription and API-key access.",
}

export const kimiCodeModelDefaults: Record<string, { maxTokens: number }> = {
	k3: { maxTokens: 131_072 },
	"k3-256k": { maxTokens: 131_072 },
	"kimi-for-coding": { maxTokens: 131_072 },
	"kimi-for-coding-highspeed": { maxTokens: 131_072 },
}

export const kimiCodeModels = {
	[kimiCodeDefaultModelId]: kimiCodeDefaultModelInfo,
} as const satisfies Record<string, ModelInfo>

export type KimiCodeModelId = keyof typeof kimiCodeModels

export const kimiCodeAuthMethodSchema = z.enum(["oauth", "api-key"])
export type KimiCodeAuthMethod = z.infer<typeof kimiCodeAuthMethodSchema>

export const kimiCodeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.kimiCode,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	getDefaultModelId: () => kimiCodeDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		kimiCodeAuthMethod: kimiCodeAuthMethodSchema.optional(),
		kimiCodeApiKey: z.string().optional(),
	},
})
