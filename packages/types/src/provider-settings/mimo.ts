import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const mimoProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.mimo,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		mimoBaseUrl: z
			.union([
				z.literal("https://api.xiaomimimo.com/v1"),
				z.literal("https://token-plan-cn.xiaomimimo.com/v1"),
				z.literal("https://token-plan-sgp.xiaomimimo.com/v1"),
				z.literal("https://token-plan-ams.xiaomimimo.com/v1"),
			])
			.optional(),
		mimoApiKey: z.string().optional(),
	},
})
