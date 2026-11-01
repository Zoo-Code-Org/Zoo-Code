import { getModelId, type ProviderSettings } from "@roo-code/types"

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
	const modelId = getModelId(apiConfiguration)

	if (!provider || !modelId) {
		return DEFAULT_CONTEXT_WINDOW
	}

	const providerModels = routerModels[provider]
	const modelInfo = providerModels?.[modelId]

	return modelInfo?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

export { DEFAULT_CONTEXT_WINDOW }
