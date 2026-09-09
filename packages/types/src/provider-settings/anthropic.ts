import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const anthropicProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.anthropic,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		apiKey: z.string().optional(),
		anthropicBaseUrl: z.string().optional(),
		anthropicUseAuthToken: z.boolean().optional(),
		anthropicBeta1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
	},
})
