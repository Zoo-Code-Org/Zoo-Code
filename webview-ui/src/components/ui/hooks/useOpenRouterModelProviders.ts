import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import type { ProviderInfoResultMap } from "@roo-code/types"

import { requestProviderInfo } from "./requestProviderInfo"

export const OPENROUTER_DEFAULT_PROVIDER_NAME = "[default]"

type OpenRouterModelProvider = ProviderInfoResultMap["openRouterModelProviders"][string]

async function getOpenRouterProvidersForModel(modelId: string, baseUrl?: string) {
	try {
		return await requestProviderInfo("openRouterModelProviders", {
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
