import {
	isRetiredProvider,
	providerIdentifiers,
	type ModelRecord,
	type ProviderName,
	type ProviderSettings,
} from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import {
	getProviderModelConfig,
	getStaticModelsForProvider,
	isStaticModelProvider,
} from "@/components/settings/utils/providerModelConfig"

import { useOpenAiModelCatalog } from "./useOpenAiModelCatalog"

export const MODEL_CATALOG_SETTINGS_FALLBACK = "Choose this provider's model in Settings."

export interface ProfileModelCatalog {
	provider: ProviderName | undefined
	field: keyof ProviderSettings | undefined
	models: ModelRecord | null
	isLoading: boolean
	isError: boolean
	isUnsupported: boolean
	/** Present for settings-only providers or discovery failures/missing configuration. */
	fallbackMessage: string | undefined
	refetch: () => void
}

/** Raw catalog only: consumers MUST apply filterModels(models, provider, organizationAllowList)
 * before presenting choices. Also hide Bedrock's custom-arn pseudo-choice unless an ARN exists.
 * Requires the app's QueryClientProvider; never writes or optimistically replaces a profile.
 */
export function useProfileModelCatalog(apiConfiguration: ProviderSettings): ProfileModelCatalog {
	const rawProvider = apiConfiguration.apiProvider ?? providerIdentifiers.openrouter
	const provider = isRetiredProvider(rawProvider) ? undefined : rawProvider
	const field = provider ? getProviderModelConfig(provider, apiConfiguration)?.field : undefined
	const isUnsupported =
		!provider ||
		!field ||
		provider === providerIdentifiers.ollama ||
		provider === providerIdentifiers.lmstudio ||
		provider === providerIdentifiers.vscodeLm
	const isOpenAi = provider === providerIdentifiers.openai && !isUnsupported
	const isStatic = !!provider && isStaticModelProvider(provider)
	const fetchRouter = !isUnsupported && !isOpenAi && (!isStatic || provider === providerIdentifiers.friendli)
	const router = useRouterModels({ provider, enabled: fetchRouter })
	const openAi = useOpenAiModelCatalog(apiConfiguration, isOpenAi)
	const isError = !isUnsupported && (isOpenAi ? openAi.isError : fetchRouter && router.isError)
	const models =
		isUnsupported || !provider
			? null
			: isOpenAi
				? openAi.models
				: isStatic
					? getStaticModelsForProvider(provider, undefined, apiConfiguration, router.data)
					: ((router.data as Partial<Record<ProviderName, ModelRecord>> | undefined)?.[provider] ?? null)

	return {
		provider,
		field: isUnsupported ? undefined : field,
		models,
		isLoading: !isUnsupported && (isOpenAi ? openAi.isLoading : !isStatic && router.isLoading),
		isError,
		isUnsupported,
		fallbackMessage: isUnsupported || isError ? MODEL_CATALOG_SETTINGS_FALLBACK : undefined,
		refetch: () => {
			if (isOpenAi) openAi.refetch()
			else if (fetchRouter) void router.refetch()
		},
	}
}
