import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const OPENCODE_GO_MODEL_ID_FIELD = "opencodeGoModelId"

export const opencodeGoProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.opencodeGo,
	modelIdKey: OPENCODE_GO_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(OPENCODE_GO_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		opencodeGoApiKey: z.string().optional(),
		[OPENCODE_GO_MODEL_ID_FIELD]: z.string().optional(),
	},
})
