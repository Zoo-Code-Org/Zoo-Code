import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { anthropicDefaultModelId } from "./anthropic.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const fakeAiProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.fakeAi,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	// Fake AI has no catalog of its own; it keeps the Anthropic fallback default.
	getDefaultModelId: () => anthropicDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		fakeAi: z.unknown().optional(),
	},
})
