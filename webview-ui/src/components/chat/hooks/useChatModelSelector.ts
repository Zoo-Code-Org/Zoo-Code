import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"

import {
	type ModelInfo,
	type ModelRecord,
	type ExtensionMessage,
	type LanguageModelChatSelector,
	type ProviderName,
	type ProviderSettings,
	getProviderDefaultModelId,
	isRetiredProvider,
	openAiModelInfoSaneDefaults,
	providerIdentifiers,
} from "@roo-code/types"

import { useRouterModels } from "@/components/ui/hooks/useRouterModels"
import { getStaticModelsForProvider } from "@/components/settings/utils/providerModelConfig"
import { MODELS_BY_PROVIDER } from "@/components/settings/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

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

// Router providers: model list comes from `useRouterModels` (or the backend
// broadcast cache for litellm/poe). The map holds the config field each one
// stores its selection under, so the switch below never re-declares them.
// Mirrors the router set used by `getProviderDefaultModelId`.
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

// Providers whose model list is delivered through a dedicated message event
// (mirrors the settings page provider components).
const MESSAGE_BASED_PROVIDERS = new Set<ProviderName>([
	providerIdentifiers.openai,
	providerIdentifiers.ollama,
	providerIdentifiers.lmstudio,
	providerIdentifiers.vscodeLm,
])

export interface ChatModelSelectorData {
	/** The provider key used to determine model source (undefined for retired providers). */
	provider: ProviderName | undefined
	/** Record of available models for the current provider (null until loaded or when N/A). */
	models: Record<string, ModelInfo> | null
	/** The configuration field key that stores the selected model for this provider. */
	modelIdKey: ModelIdKey | undefined
	/** The default model id for this provider. */
	defaultModelId: string
	/** Whether the model list is still loading. */
	isLoading: boolean
	/** Transform a selected model id into the stored configuration value (e.g. VSCode LM selector object). */
	valueTransform?: (modelId: string) => unknown
	/** Transform the stored configuration value back to a display string (e.g. VSCode LM selector). */
	displayTransform?: (value: unknown) => string
}

/**
 * Resolves the model list, storage key and defaults for the currently active
 * provider so the chat input bar can render a compact model picker.
 *
 * The data sources mirror the settings page (`ApiOptions` and the provider
 * components) so the chat selector shows the exact same models:
 * - Router providers (see `ROUTER_PROVIDERS`): react-query `useRouterModels`
 *   request, except litellm/poe which read the backend-broadcast cache.
 * - openai (OpenAI compatible), ollama, lmstudio, vscode-lm: request on mount
 *   and listen for the corresponding `*Models` message event.
 * - Static providers: `getStaticModelsForProvider`.
 *
 * Default model ids come from the shared `getProviderDefaultModelId` helper so
 * this hook never re-declares the provider matrix.
 */
export const useChatModelSelector = (): ChatModelSelectorData => {
	const { apiConfiguration, routerModels: stateRouterModels } = useExtensionState()

	const provider = (apiConfiguration?.apiProvider || providerIdentifiers.openrouter) as ProviderName
	const activeProvider = isRetiredProvider(provider) ? undefined : provider
	const routerConfig = activeProvider ? ROUTER_PROVIDERS[activeProvider] : undefined

	const routerModels = useRouterModels({ provider: activeProvider, enabled: !!routerConfig })

	// Message-based providers: request the models on mount and keep the
	// latest list delivered by the backend. Each request carries a unique
	// `requestId` and a response is only applied when it matches the most
	// recent request, so stale/out-of-order responses (for a previous provider
	// or an earlier base URL) cannot clobber the current list.
	const [openAiModels, setOpenAiModels] = useState<string[]>([])
	const [ollamaModels, setOllamaModels] = useState<ModelRecord>({})
	const [lmStudioModels, setLmStudioModels] = useState<ModelRecord>({})
	const [vsCodeLmModels, setVsCodeLmModels] = useState<LanguageModelChatSelector[]>([])
	// Track request completion explicitly. `openAiModels.length === 0` is a valid
	// successful result (an endpoint with no models), so it alone must not keep
	// the picker in a permanent loading state.
	const [openAiModelsReceived, setOpenAiModelsReceived] = useState(false)
	// Only one message-based provider is active at a time, so a single latest
	// request id is sufficient to reject stale responses.
	const latestRequestId = useRef<string | undefined>(undefined)

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		// Responses without a requestId are broadcast/legacy payloads and are
		// accepted; responses with a mismatching id are stale and ignored.
		const isStale = (): boolean => message.requestId !== undefined && message.requestId !== latestRequestId.current
		switch (message.type) {
			case "openAiModels":
				if (isStale()) break
				setOpenAiModels(message.openAiModels ?? [])
				setOpenAiModelsReceived(true)
				break
			case "ollamaModels":
				if (isStale()) break
				setOllamaModels(message.ollamaModels ?? {})
				break
			case "lmStudioModels":
				if (isStale()) break
				setLmStudioModels(message.lmStudioModels ?? {})
				break
			case "vsCodeLmModels":
				if (isStale()) break
				setVsCodeLmModels(message.vsCodeLmModels ?? [])
				break
		}
	}, [])
	useEvent("message", onMessage)

	useEffect(() => {
		setOpenAiModels([])
		setOllamaModels({})
		setLmStudioModels({})
		setVsCodeLmModels([])
		setOpenAiModelsReceived(false)
		latestRequestId.current = undefined
	}, [activeProvider])

	const serializedOpenAiHeaders = JSON.stringify(apiConfiguration?.openAiHeaders ?? {})

	// Request models on mount when a message-based provider is active
	// (mirrors Ollama.tsx / LMStudio.tsx / OpenAICompatible.tsx behaviors).
	useEffect(() => {
		if (!activeProvider || !MESSAGE_BASED_PROVIDERS.has(activeProvider)) {
			return
		}

		const requestId = `${activeProvider}-${Date.now()}-${Math.random().toString(36).slice(2)}`
		latestRequestId.current = requestId

		switch (activeProvider) {
			case providerIdentifiers.openai:
				if (apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey) {
					vscode.postMessage({
						type: "requestOpenAiModels",
						requestId,
						values: {
							baseUrl: apiConfiguration.openAiBaseUrl,
							apiKey: apiConfiguration.openAiApiKey,
							customHeaders: {},
							openAiHeaders: JSON.parse(serializedOpenAiHeaders),
						},
					})
				}
				break
			case providerIdentifiers.ollama:
				vscode.postMessage({ type: "requestOllamaModels", requestId })
				break
			case providerIdentifiers.lmstudio:
				vscode.postMessage({ type: "requestLmStudioModels", requestId })
				break
			case providerIdentifiers.vscodeLm:
				vscode.postMessage({ type: "requestVsCodeLmModels", requestId })
				break
		}
		return () => {
			latestRequestId.current = undefined
			vscode.postMessage({ type: "cancelModelRequest", requestId })
		}
	}, [activeProvider, apiConfiguration?.openAiBaseUrl, apiConfiguration?.openAiApiKey, serializedOpenAiHeaders])

	// Resolve the model list + storage key + transforms for the active provider.
	// The default id comes from the shared provider registry.
	return useMemo<ChatModelSelectorData>(() => {
		if (!activeProvider) {
			return {
				provider: undefined,
				models: null,
				modelIdKey: undefined,
				defaultModelId: "",
				isLoading: false,
			}
		}

		const defaultModelId = getProviderDefaultModelId(activeProvider, {
			isChina: activeProvider === providerIdentifiers.zai && apiConfiguration?.zaiApiLine === "china_coding",
		})

		if (routerConfig) {
			// RouterModels is keyed by dynamic/local providers only, so a narrow
			// structural cast is needed to index it by the active provider name.
			const source = (routerConfig.fromState ? stateRouterModels : routerModels.data) as
				| Partial<Record<ProviderName, ModelRecord>>
				| undefined
			return {
				provider: activeProvider,
				models: source?.[activeProvider] ?? null,
				modelIdKey: routerConfig.modelIdKey,
				defaultModelId,
				isLoading: routerModels.isLoading,
			}
		}

		let models: Record<string, ModelInfo> | null = null
		let modelIdKey: ModelIdKey | undefined = undefined
		let valueTransform: ((modelId: string) => unknown) | undefined
		let displayTransform: ((value: unknown) => string) | undefined
		let isLoading = false

		switch (activeProvider) {
			case providerIdentifiers.openai:
				// OpenAI Compatible: the list is fetched from the baseUrl via
				// `requestOpenAiModels` and delivered through `openAiModels`.
				models =
					Object.keys(openAiModels).length > 0
						? Object.fromEntries(openAiModels.map((item) => [item, openAiModelInfoSaneDefaults]))
						: null
				modelIdKey = "openAiModelId"
				isLoading =
					!!apiConfiguration?.openAiBaseUrl && !!apiConfiguration?.openAiApiKey && !openAiModelsReceived
				break
			case providerIdentifiers.ollama:
				models = Object.keys(ollamaModels).length > 0 ? ollamaModels : null
				modelIdKey = "ollamaModelId"
				break
			case providerIdentifiers.lmstudio:
				models = Object.keys(lmStudioModels).length > 0 ? lmStudioModels : null
				modelIdKey = "lmStudioModelId"
				break
			case providerIdentifiers.vscodeLm:
				models = vsCodeLmModels.reduce(
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
				modelIdKey = "vsCodeLmModelSelector"
				valueTransform = (modelId) => {
					const [vendor, family] = modelId.split("/")
					return { vendor, family }
				}
				displayTransform = (value) => {
					if (!value) return ""
					const selector = value as { vendor?: string; family?: string }
					return selector.vendor && selector.family ? `${selector.vendor}/${selector.family}` : ""
				}
				break
			default:
				// Static models providers (anthropic, bedrock, gemini, etc.).
				models = MODELS_BY_PROVIDER[activeProvider]
					? getStaticModelsForProvider(activeProvider, undefined, apiConfiguration)
					: null
				modelIdKey = "apiModelId"
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
		openAiModels,
		openAiModelsReceived,
		ollamaModels,
		lmStudioModels,
		vsCodeLmModels,
	])
}
