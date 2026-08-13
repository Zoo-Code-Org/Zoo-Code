import type { ModelInfo } from "../model.js"
import type { NanoGptRoutingPreference } from "../provider-settings/nanogpt.js"

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

const ROUTING_SUFFIX_BY_PREFERENCE: Record<Exclude<NanoGptRoutingPreference, "auto">, string> = {
	fast: "fast",
	cheap: "cheap",
	latency: "latency",
	throughput: "throughput",
	tools: "tools",
	caching: "caching",
}

/** Applies one request-only NanoGPT routing suffix while preserving identity suffixes such as `:thinking`. */
export function applyNanoGptRoutingPreference(modelId: string, preference: NanoGptRoutingPreference = "auto"): string {
	const separatorIndex = modelId.lastIndexOf(":")
	const finalSuffix = separatorIndex >= 0 ? modelId.slice(separatorIndex + 1).toLowerCase() : ""
	const canonicalId = ROUTING_SUFFIXES.has(finalSuffix) ? modelId.slice(0, separatorIndex) : modelId

	return preference === "auto" ? canonicalId : `${canonicalId}:${ROUTING_SUFFIX_BY_PREFERENCE[preference]}`
}
