import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const UNBOUND_MODEL_ID_FIELD = "unboundModelId"

export const unboundProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.unbound,
	modelIdKey: UNBOUND_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(UNBOUND_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		unboundApiKey: z.string().optional(),
		[UNBOUND_MODEL_ID_FIELD]: z.string().optional(),
	},
})
