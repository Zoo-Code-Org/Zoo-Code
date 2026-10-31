import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

// https://mimo.mi.com/docs/en-US/quick-start/model-hyperparameters
// https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking
// https://mimo.mi.com/docs/en-US/price/pay-as-you-go
//
// mimo-v2.5-pro and mimo-v2.5 were retired on 2026-10-21 10:00 (GMT+8) and their
// model names stopped working, so they are gone from this catalog: keeping them
// would leave dead IDs selectable. The V2.6 series below replaces them. A saved
// selection that still names a retired ID keeps working through the documented
// runtime fallback -- getMimoModelInfo(id) ?? mimoDefaultModelInfo in
// src/api/providers/mimo.ts -- which prices and limits the request as the
// default model while sending the stored ID through unchanged.
//
// NOTE: mimo-v2-flash is not included here. Its thinking mode defaults to
// disabled and it doesn't reliably handle reasoning_content passthrough
// during multi-turn tool calling, which causes 400 errors from the proxy.
// If flash support is needed later, it should be validated against the API
// first — the tool-calling + thinking flow is what makes MiMo useful as
// an agentic provider, and flash just can't do that yet.
export type MimoModelId = keyof typeof mimoModels

export const mimoDefaultModelId: MimoModelId = "mimo-v2.6-pro"

export const mimoModels = {
	"mimo-v2.6-pro": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // V2.6 series is full-modality (text, image, audio, video)
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.435, // $0.435/1M tokens (cache miss)
		outputPrice: 0.87, // $0.87/1M tokens
		cacheReadsPrice: 0.0036, // $0.0036/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Pro - Xiaomi's flagship omni-modal reasoning model with 1M context, deep thinking, tool calling, and structured output.",
	},
	"mimo-v2.6-flash": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // Full-modality: text, image, audio, video input
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 0.14, // $0.14/1M tokens (cache miss)
		outputPrice: 0.28, // $0.28/1M tokens
		cacheReadsPrice: 0.0028, // $0.0028/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Flash - Full-modality, low-cost reasoning model for high-frequency calls and large-scale tasks.",
	},
	"mimo-v2.6-pro-ultraspeed": {
		maxTokens: 131_072,
		contextWindow: 1_048_576,
		supportsImages: true, // Full-modality like the rest of the V2.6 series
		supportsPromptCache: false,
		preserveReasoning: true,
		inputPrice: 4.35, // $4.35/1M tokens (cache miss)
		outputPrice: 8.7, // $8.70/1M tokens
		cacheReadsPrice: 0.036, // $0.036/1M tokens (cache hit)
		cacheWritesPrice: 0, // Free for limited time
		description:
			"MiMo V2.6 Pro Ultraspeed - V2.6-Pro performance at up to 20x speed for real-time, latency-sensitive workloads.",
	},
} as const satisfies Record<string, ModelInfo>

export const mimoDefaultModelInfo: ModelInfo = mimoModels[mimoDefaultModelId]

/**
 * Looks up a curated spec by model ID, or `undefined` when the ID is not in the
 * catalog. A plain `mimoModels[id]` read is not safe for untrusted IDs: the
 * dynamic catalog feeds IDs straight from the provider's `/models` response, so
 * an ID like `constructor` or `toString` resolves to an inherited
 * `Object.prototype` member instead of a spec, and spreading it yields `{}` --
 * a model with no metadata at all. Callers fall back to family defaults on
 * `undefined`.
 */
export function getMimoModelInfo(modelId: string): ModelInfo | undefined {
	return Object.hasOwn(mimoModels, modelId) ? mimoModels[modelId as MimoModelId] : undefined
}

export const MIMO_DEFAULT_TEMPERATURE = 1.0

export const mimoProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.mimo,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	getDefaultModelId: () => mimoDefaultModelId,
	schema: {
		...apiModelIdProviderModelShape,
		// The four allowed Xiaomi MiMo endpoints. Runtime paths that read this
		// value BEFORE schema validation can apply — unsaved webview values, the
		// fail-open ContextProxy path, the chat-completion client — all enforce
		// the same set via ALLOWED_BASE_URLS in
		// src/api/providers/fetchers/mimo.ts; keep these literals in sync with
		// that set (fetcher tests cross-check both directions of the mapping).
		mimoBaseUrl: z
			.union([
				z.literal("https://api.xiaomimimo.com/v1"),
				z.literal("https://token-plan-cn.xiaomimimo.com/v1"),
				z.literal("https://token-plan-sgp.xiaomimimo.com/v1"),
				z.literal("https://token-plan-ams.xiaomimimo.com/v1"),
			])
			.optional(),
		mimoApiKey: z.string().optional(),
	},
})
