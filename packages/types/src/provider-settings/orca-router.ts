import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const ORCA_ROUTER_MODEL_ID_FIELD = "orcaRouterModelId"

export const orcaRouterProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.orcaRouter,
	modelIdKey: ORCA_ROUTER_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(ORCA_ROUTER_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		orcaRouterApiKey: z.string().optional(),
		[ORCA_ROUTER_MODEL_ID_FIELD]: z.string().optional(),
	},
})
