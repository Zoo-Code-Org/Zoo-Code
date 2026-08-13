import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const qwenCodeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.qwenCode,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		qwenCodeOauthPath: z.string().optional(),
	},
})
