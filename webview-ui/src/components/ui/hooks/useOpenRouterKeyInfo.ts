import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import { requestProviderInfo } from "./requestProviderInfo"

export type OpenRouterKeyInfo = {
	label: string
	usage: number
	is_free_tier: boolean
	is_provisioning_key: boolean
	rate_limit: { requests: number; interval: string }
	limit: number | null
}

async function getOpenRouterKeyInfo(apiKey?: string, baseUrl?: string) {
	if (!apiKey) return null

	try {
		return await requestProviderInfo<OpenRouterKeyInfo | null>("openRouterKeyInfo", { apiKey, baseUrl })
	} catch (error) {
		console.error("Error fetching OpenRouter key info:", error)
		return null
	}
}

type UseOpenRouterKeyInfoOptions = Omit<UseQueryOptions<OpenRouterKeyInfo | null>, "queryKey" | "queryFn">
export const useOpenRouterKeyInfo = (apiKey?: string, baseUrl?: string, options?: UseOpenRouterKeyInfoOptions) => {
	return useQuery<OpenRouterKeyInfo | null>({
		queryKey: ["openrouter-key-info", apiKey, baseUrl],
		queryFn: () => getOpenRouterKeyInfo(apiKey, baseUrl),
		staleTime: 30 * 1000, // 30 seconds
		enabled: !!apiKey,
		...options,
	})
}
