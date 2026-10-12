import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { openAiCodexServiceTierSchema } from "../model.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const DEFAULT_OPEN_AI_CODEX_USE_WEBSOCKET = false

export const OPEN_AI_CODEX_SERVICE_TIER_KEY = "openAiCodexServiceTier"

export const openAiCodexProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.openaiCodex,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		openAiCodexUseWebSocket: z.boolean().optional(),
		// Codex "Fast" mode maps to the Responses API priority service tier.
		[OPEN_AI_CODEX_SERVICE_TIER_KEY]: openAiCodexServiceTierSchema.optional(),
	},
})
