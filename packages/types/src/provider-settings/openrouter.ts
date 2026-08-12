import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OPEN_ROUTER_MODEL_ID_FIELD = "openRouterModelId"

export const openRouterProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openrouter,
	modelIdKey: OPEN_ROUTER_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OPEN_ROUTER_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		openRouterApiKey: z.string().optional(),
		[OPEN_ROUTER_MODEL_ID_FIELD]: z.string().optional(),
		openRouterBaseUrl: z.string().optional(),
		openRouterSpecificProvider: z.string().optional(),
	},
})
