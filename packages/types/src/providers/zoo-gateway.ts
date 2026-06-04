import type { ModelInfo } from "../model.js"

// Zoo Gateway uses the same model ID format as Vercel AI Gateway (provider/model-name)
export const zooGatewayDefaultModelId = "anthropic/claude-sonnet-4"

// Zoo Gateway serves the same models as Vercel AI Gateway, so prompt caching support is identical
// We reuse VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS from vercel-ai-gateway.ts
// Instead of duplicating, we just export a reference to indicate they're the same
export { VERCEL_AI_GATEWAY_PROMPT_CACHING_MODELS as ZOO_GATEWAY_PROMPT_CACHING_MODELS } from "./vercel-ai-gateway.js"

export const zooGatewayDefaultModelInfo: ModelInfo = {
	maxTokens: 64000,
	contextWindow: 200000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3,
	outputPrice: 15,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description:
		"Claude Sonnet 4 significantly improves on Sonnet 3.7's industry-leading capabilities, excelling in coding with a state-of-the-art 72.7% on SWE-bench. The model balances performance and efficiency for internal and external use cases, with enhanced steerability for greater control over implementations.",
}

export const ZOO_GATEWAY_DEFAULT_TEMPERATURE = 0.7
