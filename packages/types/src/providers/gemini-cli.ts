import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { anthropicDefaultModelId } from "./anthropic.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const geminiCliProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.geminiCli,
	label: "Gemini CLI",
	// Retained for compatibility with persisted settings only; the provider was
	// removed from the settings UI and falls through to the Anthropic handler.
	hidden: true,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	// Gemini CLI has no catalog of its own; it keeps the Anthropic fallback default.
	getDefaultModelId: () => anthropicDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		geminiCliOAuthPath: z.string().optional(),
		geminiCliProjectId: z.string().optional(),
	},
})
