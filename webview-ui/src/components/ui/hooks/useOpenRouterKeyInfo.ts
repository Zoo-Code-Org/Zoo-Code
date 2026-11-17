import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import type { ProviderInfoResultMap } from "@roo-code/types"

import { requestProviderInfo } from "./requestProviderInfo"

type OpenRouterKeyInfo = ProviderInfoResultMap["openRouterKeyInfo"]

async function getOpenRouterKeyInfo(apiKey?: string, baseUrl?: string) {
	if (!apiKey) return null

	try {
		return await requestProviderInfo("openRouterKeyInfo", { apiKey, baseUrl })
	} catch (error) {
		console.error("Error fetching OpenRouter key info:", error)
		return null
	}
}

type UseOpenRouterKeyInfoOptions = Omit<UseQueryOptions<OpenRouterKeyInfo>, "queryKey" | "queryFn">
export const useOpenRouterKeyInfo = (apiKey?: string, baseUrl?: string, options?: UseOpenRouterKeyInfoOptions) => {
	return useQuery<OpenRouterKeyInfo>({
		queryKey: ["openrouter-key-info", apiKey, baseUrl],
		queryFn: () => getOpenRouterKeyInfo(apiKey, baseUrl),
		staleTime: 30 * 1000, // 30 seconds
		enabled: !!apiKey,
		...options,
	})
}
