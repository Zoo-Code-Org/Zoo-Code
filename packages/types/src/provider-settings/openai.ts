import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { modelInfoSchema } from "../model.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OPEN_AI_MODEL_ID_FIELD = "openAiModelId"

export const openAiProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openai,
	modelIdKey: OPEN_AI_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OPEN_AI_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		openAiBaseUrl: z.string().optional(),
		openAiApiKey: z.string().optional(),
		openAiR1FormatEnabled: z.boolean().optional(),
		[OPEN_AI_MODEL_ID_FIELD]: z.string().optional(),
		openAiCustomModelInfo: modelInfoSchema.nullish(),
		openAiUseAzure: z.boolean().optional(),
		azureApiVersion: z.string().optional(),
		openAiStreamingEnabled: z.boolean().optional(),
		openAiHostHeader: z.string().optional(), // Keep temporarily for backward compatibility during migration.
		openAiHeaders: z.record(z.string(), z.string()).optional(),
	},
})
