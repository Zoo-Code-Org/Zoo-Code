import { providerIdentifiers, retiredProviderIdentifiers, type ProviderSettings } from "@roo-code/types"

import type { RouterModels } from "@/ui/store.js"

const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Looks up the context window size for the current model from routerModels.
 *
 * @param routerModels - The router models data containing model info per provider
 * @param apiConfiguration - The current API configuration with provider and model ID
 * @returns The context window size, or DEFAULT_CONTEXT_WINDOW (200K) if not found
 */
export function getContextWindow(routerModels: RouterModels | null, apiConfiguration: ProviderSettings | null): number {
	if (!routerModels || !apiConfiguration) {
		return DEFAULT_CONTEXT_WINDOW
	}

	const provider = apiConfiguration.apiProvider
	const modelId = getModelIdForProvider(apiConfiguration)

	if (!provider || !modelId) {
		return DEFAULT_CONTEXT_WINDOW
	}

	const providerModels = routerModels[provider]
	const modelInfo = providerModels?.[modelId]

	return modelInfo?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * Gets the model ID from the API configuration based on the provider type.
 *
 * Different providers store their model ID in different fields of ProviderSettings.
 */
function getModelIdForProvider(config: ProviderSettings): string | undefined {
	switch (config.apiProvider) {
		case providerIdentifiers.openrouter:
			return config.openRouterModelId
		case providerIdentifiers.ollama:
			return config.ollamaModelId
		case providerIdentifiers.lmstudio:
			return config.lmStudioModelId
		case providerIdentifiers.openai:
			return config.openAiModelId
		case providerIdentifiers.requesty:
			return config.requestyModelId
		case providerIdentifiers.unbound:
			return config.unboundModelId
		case providerIdentifiers.litellm:
			return config.litellmModelId
		case providerIdentifiers.vercelAiGateway:
			return config.vercelAiGatewayModelId
		case providerIdentifiers.opencodeGo:
			return config.opencodeGoModelId
		case providerIdentifiers.kenari:
			return config.kenariModelId
		case providerIdentifiers.zooGateway:
			return config.zooGatewayModelId
		case providerIdentifiers.anthropic:
		case providerIdentifiers.bedrock:
		case providerIdentifiers.baseten:
		case providerIdentifiers.deepseek:
		case providerIdentifiers.fireworks:
		case providerIdentifiers.friendli:
		case providerIdentifiers.gemini:
		case providerIdentifiers.geminiCli:
		case providerIdentifiers.mistral:
		case providerIdentifiers.moonshot:
		case providerIdentifiers.kimiCode:
		case providerIdentifiers.minimax:
		case providerIdentifiers.mimo:
		case providerIdentifiers.openaiCodex:
		case providerIdentifiers.openaiNative:
		case providerIdentifiers.poe:
		case providerIdentifiers.qwenCode:
		case providerIdentifiers.sambanova:
		case providerIdentifiers.vertex:
		case providerIdentifiers.xai:
		case providerIdentifiers.zai:
		case retiredProviderIdentifiers.cerebras:
		case retiredProviderIdentifiers.chutes:
		case retiredProviderIdentifiers.deepinfra:
		case retiredProviderIdentifiers.doubao:
		case retiredProviderIdentifiers.featherless:
		case retiredProviderIdentifiers.groq:
		case retiredProviderIdentifiers.huggingface:
		case retiredProviderIdentifiers.ioIntelligence:
		case retiredProviderIdentifiers.roo:
		case providerIdentifiers.vscodeLm:
		case providerIdentifiers.fakeAi:
		case undefined:
			return config.apiModelId
	}
}

export { DEFAULT_CONTEXT_WINDOW }
