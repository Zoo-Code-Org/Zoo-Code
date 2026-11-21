import { z } from "zod"

import { type ModelInfo } from "../model.js"
import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1"

export const nanoGptDefaultModelId = "openai/gpt-5.6-sol"

export const nanoGptDefaultModelInfo: ModelInfo = {
	maxTokens: 128_000,
	contextWindow: 1_050_000,
	supportsImages: true,
	supportsPromptCache: false,
	inputPrice: 5,
	outputPrice: 30,
	description: "NanoGPT model. Available models and metadata are resolved dynamically from the detailed catalog.",
}

const ROUTING_SUFFIXES = new Set([
	"speed",
	"fast",
	"throughput",
	"latency",
	"price",
	"cheap",
	"floor",
	"tools",
	"caching",
	"cache",
	"cached",
])

const ROUTING_SUFFIX_BY_PREFERENCE: Record<Exclude<NanoGptRoutingPreference, "auto" | "caching">, string> = {
	fast: "fast",
	cheap: "cheap",
	latency: "latency",
	throughput: "throughput",
	tools: "tools",
}

/** Applies one request-only NanoGPT routing suffix while preserving identity suffixes such as `:thinking`. */
export function applyNanoGptRoutingPreference(modelId: string, preference: NanoGptRoutingPreference = "auto"): string {
	let canonicalId = modelId
	let separatorIndex = canonicalId.lastIndexOf(":")
	let finalSuffix = separatorIndex >= 0 ? canonicalId.slice(separatorIndex + 1).toLowerCase() : ""

	// Normalize every trailing routing alias. This protects request identity when a
	// previously-routed ID is routed again and prevents multiple active suffixes.
	while (separatorIndex >= 0 && ROUTING_SUFFIXES.has(finalSuffix)) {
		canonicalId = canonicalId.slice(0, separatorIndex)
		separatorIndex = canonicalId.lastIndexOf(":")
		finalSuffix = separatorIndex >= 0 ? canonicalId.slice(separatorIndex + 1).toLowerCase() : ""
	}

	return preference === "auto" || preference === "caching"
		? canonicalId
		: `${canonicalId}:${ROUTING_SUFFIX_BY_PREFERENCE[preference]}`
}

const NANOGPT_MODEL_ID_FIELD = "nanoGptModelId"

export const nanoGptRoutingPreferences = ["auto", "fast", "cheap", "latency", "throughput", "tools", "caching"] as const

export const nanoGptRoutingPreferenceSchema = z.enum(nanoGptRoutingPreferences)
export type NanoGptRoutingPreference = z.infer<typeof nanoGptRoutingPreferenceSchema>
export const nanoGptDefaultRoutingPreference: NanoGptRoutingPreference = "auto"

export const nanoGptProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.nanogpt,
	modelIdKey: NANOGPT_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(NANOGPT_MODEL_ID_FIELD),
	getDefaultModelId: () => nanoGptDefaultModelId,
	schema: {
		...baseProviderSettingsShape,
		nanoGptApiKey: z.string().optional(),
		[NANOGPT_MODEL_ID_FIELD]: z.string().optional(),
		nanoGptRoutingPreference: nanoGptRoutingPreferenceSchema.optional(),
	},
})
