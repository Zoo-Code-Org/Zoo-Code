import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const zaiApiLineSchema = z.enum(["international_coding", "china_coding", "international_api", "china_api"])
export type ZaiApiLine = z.infer<typeof zaiApiLineSchema>

export const zaiProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.zai,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		zaiApiKey: z.string().optional(),
		zaiApiLine: zaiApiLineSchema.optional(),
	},
})
