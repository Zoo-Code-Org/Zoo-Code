import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const vertexProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.vertex,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		vertexKeyFile: z.string().optional(),
		vertexJsonCredentials: z.string().optional(),
		vertexProjectId: z.string().optional(),
		vertexRegion: z.string().optional(),
		vertex1MContext: z.boolean().optional(), // Enable 'context-1m-2025-08-07' beta for 1M context window.
	},
})
