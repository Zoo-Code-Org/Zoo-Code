import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

const IO_INTELLIGENCE_MODEL_ID_FIELD = "ioIntelligenceModelId"

export const ioIntelligenceProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.ioIntelligence,
	modelIdKey: IO_INTELLIGENCE_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(IO_INTELLIGENCE_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		ioIntelligenceApiKey: z.string().optional(),
		[IO_INTELLIGENCE_MODEL_ID_FIELD]: z.string().optional(),
	},
})
