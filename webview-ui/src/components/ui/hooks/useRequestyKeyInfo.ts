import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import { requestProviderInfo } from "./requestProviderInfo"

export type RequestyKeyInfo = {
	name: string
	monthly_limit: string
	monthly_spend: string
	org_balance: string
	config: { aliases?: Record<string, unknown> }
}

async function getRequestyKeyInfo(baseUrl?: string, apiKey?: string) {
	if (!apiKey) return null

	try {
		return await requestProviderInfo<RequestyKeyInfo | null>("requestyKeyInfo", { apiKey, baseUrl })
	} catch (error) {
		console.error("Error fetching Requesty key info:", error)
		return null
	}
}

type UseRequestyKeyInfoOptions = Omit<UseQueryOptions<RequestyKeyInfo | null>, "queryKey" | "queryFn">
export const useRequestyKeyInfo = (baseUrl?: string, apiKey?: string, options?: UseRequestyKeyInfoOptions) => {
	return useQuery<RequestyKeyInfo | null>({
		queryKey: ["requesty-key-info", baseUrl, apiKey],
		queryFn: () => getRequestyKeyInfo(baseUrl, apiKey),
		staleTime: 30 * 1000, // 30 seconds
		enabled: !!apiKey,
		...options,
	})
}
