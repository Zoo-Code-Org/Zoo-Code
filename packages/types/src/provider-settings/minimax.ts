import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const minimaxProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.minimax,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		minimaxBaseUrl: z
			.union([z.literal("https://api.minimax.io/v1"), z.literal("https://api.minimaxi.com/v1")])
			.optional(),
		minimaxApiKey: z.string().optional(),
	},
})
