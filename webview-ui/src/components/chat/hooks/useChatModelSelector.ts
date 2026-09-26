import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"

import {
	type ProviderName,
	type ProviderSettings,
	type ModelInfo,
	type ModelRecord,
	type ExtensionMessage,
	type LanguageModelChatSelector,
	providerIdentifiers,
	openAiModelInfoSaneDefaults,
	anthropicDefaultModelId,
	bedrockDefaultModelId,
	deepSeekDefaultModelId,
	moonshotDefaultModelId,
	geminiDefaultModelId,
	mistralDefaultModelId,
	openAiNativeDefaultModelId,
	qwenCodeDefaultModelId,
	vertexDefaultModelId,
	xaiDefaultModelId,
	sambaNovaDefaultModelId,
	internationalZAiDefaultModelId,
	mainlandZAiDefaultModelId,
	fireworksDefaultModelId,
	friendliDefaultModelId,
	minimaxDefaultModelId,
	mimoDefaultModelId,
	basetenDefaultModelId,
	openRouterDefaultModelId,
	requestyDefaultModelId,
	unboundDefaultModelId,
	litellmDefaultModelId,
	vercelAiGatewayDefaultModelId,
	zooGatewayDefaultModelId,
	opencodeGoDefaultModelId,
	kenariDefaultModelId,
	nanoGptDefaultModelId,
	kimiCodeDefaultModelId,
	poeDefaultModelId,
	isRetiredProvider,
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

const STATIC_DEFAULT_MODEL_IDS: Partial<Record<ProviderName, string>> = {
	[providerIdentifiers.anthropic]: anthropicDefaultModelId,
	[providerIdentifiers.bedrock]: bedrockDefaultModelId,
	[providerIdentifiers.deepseek]: deepSeekDefaultModelId,
	[providerIdentifiers.moonshot]: moonshotDefaultModelId,
	[providerIdentifiers.gemini]: geminiDefaultModelId,
	[providerIdentifiers.mistral]: mistralDefaultModelId,
	[providerIdentifiers.openaiNative]: openAiNativeDefaultModelId,
	[providerIdentifiers.qwenCode]: qwenCodeDefaultModelId,
	[providerIdentifiers.vertex]: vertexDefaultModelId,
	[providerIdentifiers.xai]: xaiDefaultModelId,
	[providerIdentifiers.sambanova]: sambaNovaDefaultModelId,
	[providerIdentifiers.zai]: internationalZAiDefaultModelId,
	[providerIdentifiers.fireworks]: fireworksDefaultModelId,
	[providerIdentifiers.friendli]: friendliDefaultModelId,
	[providerIdentifiers.minimax]: minimaxDefaultModelId,
	[providerIdentifiers.mimo]: mimoDefaultModelId,
	[providerIdentifiers.baseten]: basetenDefaultModelId,
}

const ROUTER_DEFAULT_MODEL_IDS: Partial<Record<ProviderName, string>> = {
	[providerIdentifiers.openrouter]: openRouterDefaultModelId,
	[providerIdentifiers.requesty]: requestyDefaultModelId,
	[providerIdentifiers.unbound]: unboundDefaultModelId,
	[providerIdentifiers.litellm]: litellmDefaultModelId,
	[providerIdentifiers.vercelAiGateway]: vercelAiGatewayDefaultModelId,
	[providerIdentifiers.zooGateway]: zooGatewayDefaultModelId,
	[providerIdentifiers.opencodeGo]: opencodeGoDefaultModelId,
	[providerIdentifiers.kenari]: kenariDefaultModelId,
	[providerIdentifiers.nanogpt]: nanoGptDefaultModelId,
	[providerIdentifiers.kimiCode]: kimiCodeDefaultModelId,
	[providerIdentifiers.poe]: poeDefaultModelId,
}

// Providers whose model list is delivered through a dedicated message event
// (mirrors the settings page provider components).
const MESSAGE_BASED_PROVIDERS: ProviderName[] = [
	providerIdentifiers.openai,
	providerIdentifiers.ollama,
	providerIdentifiers.lmstudio,
	providerIdentifiers.vscodeLm,
]

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
 * - Router providers (openrouter, requesty, unbound, vercel-ai-gateway,
 *   zoo-gateway, opencode-go, kenari, nanogpt, kimi-code):
 *   react-query `useRouterModels` request.
 * - litellm / poe: backend-broadcast `routerModels` from extension state.
 * - openai (OpenAI compatible), ollama, lmstudio, vscode-lm: request on mount
 *   and listen for the corresponding `*Models` message event.
 * - Static providers: `getStaticModelsForProvider`.
 */
export const useChatModelSelector = (): ChatModelSelectorData => {
	const { apiConfiguration, routerModels: stateRouterModels } = useExtensionState()

	const provider = (apiConfiguration?.apiProvider || providerIdentifiers.openrouter) as ProviderName
	const activeProvider = isRetiredProvider(provider) ? undefined : provider

	// Router providers are fetched through react-query (mirrors ApiOptions).
	const routerModels = useRouterModels({
		provider: activeProvider,
		enabled: !!activeProvider && ROUTER_DEFAULT_MODEL_IDS[activeProvider] !== undefined,
	})

	// Message-based providers: request the models on mount and keep the
	// latest list delivered by the backend.
	const [openAiModels, setOpenAiModels] = useState<string[]>([])
	const [ollamaModels, setOllamaModels] = useState<ModelRecord>({})
	const [lmStudioModels, setLmStudioModels] = useState<ModelRecord>({})
	const [vsCodeLmModels, setVsCodeLmModels] = useState<LanguageModelChatSelector[]>([])

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data
		switch (message.type) {
			case "openAiModels":
				setOpenAiModels(message.openAiModels ?? [])
				break
			case "ollamaModels":
				setOllamaModels(message.ollamaModels ?? {})
				break
			case "lmStudioModels":
				setLmStudioModels(message.lmStudioModels ?? {})
				break
			case "vsCodeLmModels":
				setVsCodeLmModels(message.vsCodeLmModels ?? [])
				break
		}
	}, [])
	useEvent("message", onMessage)

	// Request models on mount when a message-based provider is active
	// (mirrors Ollama.tsx / LMStudio.tsx / OpenAICompatible.tsx behaviors).
	useEffect(() => {
		if (!activeProvider || !MESSAGE_BASED_PROVIDERS.includes(activeProvider)) {
			return
		}

		switch (activeProvider) {
			case providerIdentifiers.openai:
				if (apiConfiguration?.openAiBaseUrl && apiConfiguration?.openAiApiKey) {
					vscode.postMessage({
						type: "requestOpenAiModels",
						values: {
							baseUrl: apiConfiguration.openAiBaseUrl,
							apiKey: apiConfiguration.openAiApiKey,
							customHeaders: {},
							openAiHeaders: apiConfiguration.openAiHeaders ?? {},
						},
					})
				}
				break
			case providerIdentifiers.ollama:
				vscode.postMessage({ type: "requestOllamaModels" })
				break
			case providerIdentifiers.lmstudio:
				vscode.postMessage({ type: "requestLmStudioModels" })
				break
			case providerIdentifiers.vscodeLm:
				vscode.postMessage({ type: "requestVsCodeLmModels" })
				break
		}
	}, [
		activeProvider,
		apiConfiguration?.openAiBaseUrl,
		apiConfiguration?.openAiApiKey,
		apiConfiguration?.openAiHeaders,
	])

	// Map provider -> config field key + model list + default id.
	const result = useMemo<ChatModelSelectorData>(() => {
		if (!activeProvider) {
			return {
				provider: undefined,
				models: null,
				modelIdKey: undefined,
				defaultModelId: "",
				isLoading: false,
			}
		}

		const defaultModelId =
			(activeProvider === providerIdentifiers.zai && apiConfiguration?.zaiApiLine === "china_coding"
				? mainlandZAiDefaultModelId
				: (ROUTER_DEFAULT_MODEL_IDS[activeProvider] ?? STATIC_DEFAULT_MODEL_IDS[activeProvider] ?? "")) ?? ""

		let models: Record<string, ModelInfo> | null = null
		let modelIdKey: ModelIdKey | undefined = undefined
		let valueTransform: ((modelId: string) => unknown) | undefined
		let displayTransform: ((value: unknown) => string) | undefined
		let isLoading = false

		switch (activeProvider) {
			case providerIdentifiers.openrouter:
				models = routerModels.data?.openrouter ?? null
				modelIdKey = "openRouterModelId"
				break
			case providerIdentifiers.requesty:
				models = routerModels.data?.requesty ?? null
				modelIdKey = "requestyModelId"
				break
			case providerIdentifiers.unbound:
				models = routerModels.data?.unbound ?? null
				modelIdKey = "unboundModelId"
				break
			case providerIdentifiers.litellm:
				// The settings page reads litellm models from the backend
				// broadcast cache (stateRouterModels), not from react-query.
				models = stateRouterModels?.litellm ?? null
				modelIdKey = "litellmModelId"
				break
			case providerIdentifiers.vercelAiGateway:
				models = routerModels.data?.[providerIdentifiers.vercelAiGateway] ?? null
				modelIdKey = "vercelAiGatewayModelId"
				break
			case providerIdentifiers.zooGateway:
				models = routerModels.data?.[providerIdentifiers.zooGateway] ?? null
				modelIdKey = "zooGatewayModelId"
				break
			case providerIdentifiers.opencodeGo:
				models = routerModels.data?.[providerIdentifiers.opencodeGo] ?? null
				modelIdKey = "opencodeGoModelId"
				break
			case providerIdentifiers.kenari:
				models = routerModels.data?.[providerIdentifiers.kenari] ?? null
				modelIdKey = "kenariModelId"
				break
			case providerIdentifiers.nanogpt:
				models = routerModels.data?.[providerIdentifiers.nanogpt] ?? null
				modelIdKey = "nanoGptModelId"
				break
			case providerIdentifiers.kimiCode:
				// Kimi Code stores its model id in apiModelId (mirrors useSelectedModel).
				models = routerModels.data?.[providerIdentifiers.kimiCode] ?? null
				modelIdKey = "apiModelId"
				break
			case providerIdentifiers.poe:
				// Same as litellm: poe uses the backend broadcast cache.
				models = stateRouterModels?.poe ?? null
				modelIdKey = "apiModelId"
				break
			case providerIdentifiers.openai:
				// OpenAI Compatible: the list is fetched from the baseUrl via
				// `requestOpenAiModels` and delivered through `openAiModels`.
				models =
					Object.keys(openAiModels).length > 0
						? Object.fromEntries(openAiModels.map((item) => [item, openAiModelInfoSaneDefaults]))
						: null
				modelIdKey = "openAiModelId"
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
				models = MODELS_BY_PROVIDER[activeProvider] ? getStaticModelsForProvider(activeProvider) : null
				modelIdKey = "apiModelId"
		}

		isLoading =
			(ROUTER_DEFAULT_MODEL_IDS[activeProvider] !== undefined && routerModels.isLoading) ||
			(activeProvider === providerIdentifiers.openai &&
				!!apiConfiguration?.openAiBaseUrl &&
				!!apiConfiguration?.openAiApiKey &&
				openAiModels.length === 0)

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
		apiConfiguration,
		routerModels,
		stateRouterModels,
		openAiModels,
		ollamaModels,
		lmStudioModels,
		vsCodeLmModels,
	])

	return result
}
