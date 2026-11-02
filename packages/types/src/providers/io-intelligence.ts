import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const IO_INTELLIGENCE_BASE_URL = "https://api.intelligence.io.solutions/api/v1"

export const ioIntelligenceDefaultModelId = "meta-llama/Llama-3.3-70B-Instruct"

export const ioIntelligenceDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 128_000,
	supportsImages: false,
	supportsPromptCache: false,
	description: "IO Intelligence model. The full model catalog is resolved dynamically from the /models endpoint.",
}

const IO_INTELLIGENCE_MODEL_ID_FIELD = "ioIntelligenceModelId"

export const ioIntelligenceProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.ioIntelligence,
	modelIdKey: IO_INTELLIGENCE_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(IO_INTELLIGENCE_MODEL_ID_FIELD),
	getDefaultModelId: () => ioIntelligenceDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		ioIntelligenceApiKey: z.string().optional(),
		[IO_INTELLIGENCE_MODEL_ID_FIELD]: z.string().optional(),
	},
})
