import { useMemo } from "react"

import {
	type ModelInfo,
	type ModelRecord,
	type ProviderName,
	type ProviderSettings,
	getProviderDefaultModelId,
	isRetiredProvider,
	providerIdentifiers,
} from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { useOllamaModels } from "@/components/ui/hooks/useOllamaModels"
import { useLmStudioModels } from "@/components/ui/hooks/useLmStudioModels"
import { useVsCodeLmModels } from "@/components/ui/hooks/useVsCodeLmModels"
import { getStaticModelsForProvider } from "@/components/settings/utils/providerModelConfig"
import { MODELS_BY_PROVIDER } from "@/components/settings/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"

type ModelIdKey = keyof Pick<
	ProviderSettings,
	| "openRouterModelId"
	| "requestyModelId"
	| "unboundModelId"
	| "openAiModelId"
	| "litellmModelId"
	| "vercelAiGatewayModelId"
	| "zooGatewayModelId"
	| "opencodeGoModelId"
	| "kenariModelId"
	| "nanoGptModelId"
	| "apiModelId"
	| "ollamaModelId"
	| "lmStudioModelId"
	| "vsCodeLmModelSelector"
>

// Router providers resolve their list through `useRouterModels` (or the
// backend-broadcast cache for litellm/poe). The map holds the config field each
// provider stores its selection under.
const ROUTER_PROVIDERS: Partial<Record<ProviderName, { modelIdKey: ModelIdKey; fromState?: boolean }>> = {
	[providerIdentifiers.openrouter]: { modelIdKey: "openRouterModelId" },
	[providerIdentifiers.requesty]: { modelIdKey: "requestyModelId" },
	[providerIdentifiers.unbound]: { modelIdKey: "unboundModelId" },
	[providerIdentifiers.litellm]: { modelIdKey: "litellmModelId", fromState: true },
	[providerIdentifiers.vercelAiGateway]: { modelIdKey: "vercelAiGatewayModelId" },
	[providerIdentifiers.zooGateway]: { modelIdKey: "zooGatewayModelId" },
	[providerIdentifiers.opencodeGo]: { modelIdKey: "opencodeGoModelId" },
	[providerIdentifiers.kenari]: { modelIdKey: "kenariModelId" },
	[providerIdentifiers.nanogpt]: { modelIdKey: "nanoGptModelId" },
	[providerIdentifiers.kimiCode]: { modelIdKey: "apiModelId" },
	[providerIdentifiers.poe]: { modelIdKey: "apiModelId", fromState: true },
}

export interface ChatModelSelectorData {
	provider: ProviderName | undefined
	models: Record<string, ModelInfo> | null
	modelIdKey: ModelIdKey | undefined
	defaultModelId: string
	isLoading: boolean
	valueTransform?: (modelId: string) => unknown
	displayTransform?: (value: unknown) => string
}

/**
 * Resolves the model list, storage key and transforms for the active provider
 * so the chat input bar can render a compact model picker that mirrors the
 * settings page sources.
 *
 * It composes the same webview data hooks the settings providers use (router
 * models, Ollama, LM Studio) and the shared static provider tables, so it needs
 * no chat-specific backend protocol.
 */
export const useChatModelSelector = (): ChatModelSelectorData => {
	const { apiConfiguration, routerModels: stateRouterModels } = useExtensionState()

	const provider = (apiConfiguration?.apiProvider || providerIdentifiers.openrouter) as ProviderName
	const activeProvider = isRetiredProvider(provider) ? undefined : provider
	const routerConfig = activeProvider ? ROUTER_PROVIDERS[activeProvider] : undefined

	const routerModels = useRouterModels({
		provider: routerConfig && !routerConfig.fromState ? activeProvider : undefined,
		enabled: !!routerConfig && !routerConfig.fromState,
	})

	// The list hooks only fire when a model id is provided; pass a sentinel so
	// the picker can populate its options before a model is configured.
	const ollamaModels = useOllamaModels(
		activeProvider === providerIdentifiers.ollama ? apiConfiguration?.ollamaModelId || "ollama" : undefined,
	)
	const lmStudioModels = useLmStudioModels(
		activeProvider === providerIdentifiers.lmstudio ? apiConfiguration?.lmStudioModelId || "lmstudio" : undefined,
	)
	const vsCodeLmModels = useVsCodeLmModels(activeProvider === providerIdentifiers.vscodeLm)

	return useMemo<ChatModelSelectorData>(() => {
		let models: Record<string, ModelInfo> | null = null
		let modelIdKey: ModelIdKey | undefined = undefined
		let valueTransform: ((modelId: string) => unknown) | undefined
		let displayTransform: ((value: unknown) => string) | undefined
		let isLoading = false

		const defaultModelId = activeProvider
			? getProviderDefaultModelId(activeProvider, {
					isChina:
						activeProvider === providerIdentifiers.zai && apiConfiguration?.zaiApiLine === "china_coding",
				})
			: ""

		if (activeProvider) {
			if (routerConfig) {
				const source = (routerConfig.fromState ? stateRouterModels : routerModels.data) as
					| Partial<Record<ProviderName, ModelRecord>>
					| undefined
				models = source?.[activeProvider] ?? null
				modelIdKey = routerConfig.modelIdKey
				isLoading = !routerConfig.fromState && routerModels.isLoading
			} else if (activeProvider === providerIdentifiers.ollama) {
				models = ollamaModels.data ?? null
				modelIdKey = "ollamaModelId"
				isLoading = ollamaModels.isLoading
			} else if (activeProvider === providerIdentifiers.lmstudio) {
				models = lmStudioModels.data ?? null
				modelIdKey = "lmStudioModelId"
				isLoading = lmStudioModels.isLoading
			} else if (activeProvider === providerIdentifiers.vscodeLm) {
				// VSCode LM exposes compound `{ vendor, family }` selections. Key the
				// options as `vendor/family` (mirrors the settings provider) so they
				// stay selectable even when free-form model ids are restricted.
				modelIdKey = "vsCodeLmModelSelector"
				models = (vsCodeLmModels.data ?? []).reduce(
					(acc, model) => {
						const modelId = `${model.vendor}/${model.family}`
						acc[modelId] = {
							maxTokens: 0,
							contextWindow: 0,
							supportsPromptCache: false,
							description: `${model.vendor} - ${model.family}`,
						}
						return acc
					},
					{} as Record<string, ModelInfo>,
				)
				isLoading = vsCodeLmModels.isLoading
				valueTransform = (modelId) => {
					const [vendor, family] = modelId.split("/")
					return { vendor, family }
				}
				displayTransform = (value) => {
					if (!value) return ""
					const selector = value as { vendor?: string; family?: string }
					return selector.vendor && selector.family ? `${selector.vendor}/${selector.family}` : ""
				}
			} else {
				models = MODELS_BY_PROVIDER[activeProvider]
					? getStaticModelsForProvider(activeProvider, undefined, apiConfiguration)
					: null
				modelIdKey = "apiModelId"
			}
		}

		return {
			provider: activeProvider,
			models,
			modelIdKey,
			defaultModelId,
			isLoading,
			valueTransform,
			displayTransform,
		}
	}, [
		activeProvider,
		routerConfig,
		apiConfiguration,
		routerModels,
		stateRouterModels,
		ollamaModels,
		lmStudioModels,
		vsCodeLmModels,
	])
}
