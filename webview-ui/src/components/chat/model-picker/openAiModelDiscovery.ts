import type { ProviderSettings } from "@roo-code/types"
import { z } from "zod"

import { requestProviderInfo } from "@/components/ui/hooks/requestProviderInfo"

export type OpenAiDiscoverySettings = Pick<ProviderSettings, "openAiBaseUrl" | "openAiApiKey" | "openAiHeaders">

/** Credentials stay local to an independently abortable request, never a shared query cache. */
export function discoverOpenAiModels(settings: OpenAiDiscoverySettings, signal: AbortSignal): Promise<string[]> {
	const { openAiBaseUrl: baseUrl, openAiApiKey: apiKey, openAiHeaders: headers } = settings
	return requestProviderInfo("openAiModels", { baseUrl, apiKey, headers }, signal).then(z.array(z.string()).parse)
}
