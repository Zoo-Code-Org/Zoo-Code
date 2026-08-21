import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const kimiCodeAuthMethodSchema = z.enum(["oauth", "api-key"])
export type KimiCodeAuthMethod = z.infer<typeof kimiCodeAuthMethodSchema>

export const kimiCodeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.kimiCode,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		kimiCodeAuthMethod: kimiCodeAuthMethodSchema.optional(),
		kimiCodeApiKey: z.string().optional(),
	},
})
