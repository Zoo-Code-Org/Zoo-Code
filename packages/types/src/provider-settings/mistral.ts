import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const mistralProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.mistral,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		mistralApiKey: z.string().optional(),
		mistralCodestralUrl: z.string().optional(),
	},
})
