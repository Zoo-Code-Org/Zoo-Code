import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const geminiCliProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.geminiCli,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		geminiCliOAuthPath: z.string().optional(),
		geminiCliProjectId: z.string().optional(),
	},
})
