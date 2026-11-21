import { z } from "zod"

import { serviceTierSchema } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"
import { openAiNativeDefaultModelId } from "./openai.js"

export const openAiNativeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openaiNative,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	getDefaultModelId: () => openAiNativeDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		openAiNativeApiKey: z.string().optional(),
		openAiNativeBaseUrl: z.string().optional(),
		// OpenAI Responses API service tier for openai-native provider only.
		// UI should only expose this when the selected model supports flex/priority.
		openAiNativeServiceTier: serviceTierSchema.optional(),
	},
})
