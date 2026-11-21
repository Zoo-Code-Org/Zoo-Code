import { useQuery, UseQueryOptions } from "@tanstack/react-query"

import type { ProviderInfoResultMap } from "@roo-code/types"

import { requestProviderInfo } from "./requestProviderInfo"

type RequestyKeyInfo = ProviderInfoResultMap["requestyKeyInfo"]

async function getRequestyKeyInfo(baseUrl?: string, apiKey?: string) {
	if (!apiKey) return null

	try {
		return await requestProviderInfo("requestyKeyInfo", { apiKey, baseUrl })
	} catch (error) {
		console.error("Error fetching Requesty key info:", error)
		return null
	}
}

type UseRequestyKeyInfoOptions = Omit<UseQueryOptions<RequestyKeyInfo>, "queryKey" | "queryFn">
export const useRequestyKeyInfo = (baseUrl?: string, apiKey?: string, options?: UseRequestyKeyInfoOptions) => {
	return useQuery<RequestyKeyInfo>({
		queryKey: ["requesty-key-info", baseUrl, apiKey],
		queryFn: () => getRequestyKeyInfo(baseUrl, apiKey),
		staleTime: 30 * 1000, // 30 seconds
		enabled: !!apiKey,
		...options,
	})
}
