import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

// https://docs.mistral.ai/getting-started/models/models_overview/
export type MistralModelId = keyof typeof mistralModels

// Mistral bills cached prompt tokens at 10% of the standard input price
// (https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching),
// so every entry below carries `cacheReadsPrice` at one tenth of its own
// `inputPrice`. Reporting cache reads without this price would bill them at $0
// instead of 0.1x.
export const mistralDefaultModelId: MistralModelId = "codestral-latest"

export const mistralModels = {
	"magistral-medium-latest": {
		maxTokens: 8192,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 2.0,
		outputPrice: 5.0,
		cacheReadsPrice: 0.2,
	},
	"devstral-medium-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
		cacheReadsPrice: 0.04,
	},
	"mistral-medium-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
		cacheReadsPrice: 0.04,
	},
	"codestral-latest": {
		maxTokens: 8192,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.9,
		cacheReadsPrice: 0.03,
	},
	"mistral-large-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 2.0,
		outputPrice: 6.0,
		cacheReadsPrice: 0.2,
	},
	"ministral-8b-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.1,
		cacheReadsPrice: 0.01,
	},
	"ministral-3b-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.04,
		outputPrice: 0.04,
		cacheReadsPrice: 0.004,
	},
	"mistral-small-latest": {
		maxTokens: 8192,
		contextWindow: 32_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.6,
		cacheReadsPrice: 0.02,
	},
	"pixtral-large-latest": {
		maxTokens: 8192,
		contextWindow: 131_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 2.0,
		outputPrice: 6.0,
		cacheReadsPrice: 0.2,
	},
} as const satisfies Record<string, ModelInfo>

export const MISTRAL_DEFAULT_TEMPERATURE = 1

export const mistralProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.mistral,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	getDefaultModelId: () => mistralDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		mistralApiKey: z.string().optional(),
		mistralCodestralUrl: z.string().optional(),
	},
})
