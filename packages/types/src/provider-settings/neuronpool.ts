import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const neuronpoolProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.neuronpool,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		neuronpoolApiKey: z.string().optional(),
		neuronpoolBaseUrl: z.string().optional(),
	},
})
