import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

const KENARI_MODEL_ID_FIELD = "kenariModelId"

export const kenariProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.kenari,
	modelIdKey: KENARI_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(KENARI_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		kenariApiKey: z.string().optional(),
		[KENARI_MODEL_ID_FIELD]: z.string().optional(),
	},
})
