import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

import { poeDefaultModelId } from "ai-sdk-provider-poe/code"

export { poeDefaultModelId, POE_DEFAULT_BASE_URL, getPoeDefaultModelInfo } from "ai-sdk-provider-poe/code"
export type { PoeDefaultModelInfo } from "ai-sdk-provider-poe/code"

export const poeProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.poe,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	getDefaultModelId: () => poeDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		poeApiKey: z.string().optional(),
		poeBaseUrl: z.string().optional(),
	},
})
