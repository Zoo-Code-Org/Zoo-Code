import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import type { ModelInfo } from "@roo-code/types"

import { requestProviderInfo } from "./requestProviderInfo"

export const OPENROUTER_DEFAULT_PROVIDER_NAME = "[default]"

type OpenRouterModelProvider = ModelInfo & {
	label: string
}

async function getOpenRouterProvidersForModel(modelId: string, baseUrl?: string) {
	try {
		return await requestProviderInfo<Record<string, OpenRouterModelProvider>>("openRouterModelProviders", {
			modelId,
			baseUrl,
		})
	} catch (error) {
		console.error(`Error fetching OpenRouter providers:`, error)
		return {}
	}
}

type UseOpenRouterModelProvidersOptions = Omit<
	UseQueryOptions<Record<string, OpenRouterModelProvider>>,
	"queryKey" | "queryFn"
>

export const useOpenRouterModelProviders = (
	modelId?: string,
	baseUrl?: string,
	options?: UseOpenRouterModelProvidersOptions,
) =>
	useQuery<Record<string, OpenRouterModelProvider>>({
		queryKey: ["openrouter-model-providers", modelId, baseUrl],
		queryFn: () => (modelId ? getOpenRouterProvidersForModel(modelId, baseUrl) : {}),
		...options,
	})
