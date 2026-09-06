import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const LM_STUDIO_MODEL_ID_FIELD = "lmStudioModelId"

export const lmStudioProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.lmstudio,
	modelIdKey: LM_STUDIO_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(LM_STUDIO_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		[LM_STUDIO_MODEL_ID_FIELD]: z.string().optional(),
		lmStudioBaseUrl: z.string().optional(),
		lmStudioApiKey: z.string().optional(),
		lmStudioDraftModelId: z.string().optional(),
		lmStudioSpeculativeDecodingEnabled: z.boolean().optional(),
	},
})
