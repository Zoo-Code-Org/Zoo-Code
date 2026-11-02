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
	label: "Fake AI",
	// Test-only provider: registered so tests and the extension API can select
	// it, but never offered in the settings UI.
	hidden: true,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	// Fake AI has no catalog of its own; it keeps the Anthropic fallback default.
	getDefaultModelId: () => anthropicDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		fakeAi: z.unknown().optional(),
	},
})
