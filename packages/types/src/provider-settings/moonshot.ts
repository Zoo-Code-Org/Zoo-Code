import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const moonshotProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.moonshot,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		moonshotBaseUrl: z
			.union([z.literal("https://api.moonshot.ai/v1"), z.literal("https://api.moonshot.cn/v1")])
			.optional(),
		moonshotApiKey: z.string().optional(),
	},
})

export const kimiCodeAuthMethodSchema = z.enum(["oauth", "api-key"])
export type KimiCodeAuthMethod = z.infer<typeof kimiCodeAuthMethodSchema>
