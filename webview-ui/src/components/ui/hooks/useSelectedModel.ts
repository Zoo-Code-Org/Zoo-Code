import {
	type ProviderName,
	type ProviderSettings,
	type ModelInfo,
	type ModelRecord,
	type RouterModels,
	anthropicModels,
	bedrockModels,
	deepSeekModels,
	moonshotModels,
	minimaxModels,
	mimoModels,
	geminiModels,
	mistralModels,
	openAiModelInfoSaneDefaults,
	openAiNativeModels,
	vertexModels,
	xaiModels,
	vscodeLlmModels,
	vscodeLlmDefaultModelId,
	openAiCodexModels,
	sambaNovaModels,
	getZAiModels,
	zaiApiLineConfigs,
	fireworksModels,
	friendliModels,
	basetenModels,
	qwenCodeModels,
	kimiCodeDefaultModelInfo,
	litellmDefaultModelInfo,
	lMStudioDefaultModelInfo,
	opencodeGoDefaultModelInfo,
	kenariDefaultModelInfo,
	nanoGptDefaultModelInfo,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	VERTEX_1M_CONTEXT_MODEL_IDS,
	isDynamicProvider,
	isRetiredProvider,
	getProviderDefaultModelId,
	providerIdentifiers,
} from "@roo-code/types"

import { useRouterModels } from "./useRouterModels"
import { useOpenRouterModelProviders } from "./useOpenRouterModelProviders"
import { useLmStudioModels } from "./useLmStudioModels"
import { useOllamaModels } from "./useOllamaModels"

/**
 * Helper to get a validated model ID for dynamic providers.
 * Returns the configured model ID if it exists in the available models, otherwise returns the default.
 */
function getValidatedModelId(
	configuredId: string | undefined,
	availableModels: ModelRecord | undefined,
	defaultModelId: string,
): string {
	return configuredId && availableModels?.[configuredId] ? configuredId : defaultModelId
}

export const useSelectedModel = (apiConfiguration?: ProviderSettings) => {
	const provider = apiConfiguration?.apiProvider || providerIdentifiers.openrouter
	const activeProvider: ProviderName | undefined = isRetiredProvider(provider) ? undefined : provider
	const dynamicProvider = activeProvider && isDynamicProvider(activeProvider) ? activeProvider : undefined
	const openRouterModelId =
		activeProvider === providerIdentifiers.openrouter ? apiConfiguration?.openRouterModelId : undefined
	const lmStudioModelId =
		activeProvider === providerIdentifiers.lmstudio ? apiConfiguration?.lmStudioModelId : undefined
	const ollamaModelId = activeProvider === providerIdentifiers.ollama ? apiConfiguration?.ollamaModelId : undefined

	// Only fetch router models for dynamic providers
	const shouldFetchRouterModels = !!dynamicProvider
	const routerModels = useRouterModels({
		provider: dynamicProvider,
		enabled: shouldFetchRouterModels,
	})

	const openRouterModelProviders = useOpenRouterModelProviders(openRouterModelId)
	const lmStudioModels = useLmStudioModels(lmStudioModelId)
	const ollamaModels = useOllamaModels(ollamaModelId)

	// Compute readiness only for the data actually needed for the selected provider
	const needRouterModels = shouldFetchRouterModels
	const needOpenRouterProviders = activeProvider === providerIdentifiers.openrouter
	const needLmStudio = typeof lmStudioModelId !== "undefined"
	const needOllama = typeof ollamaModelId !== "undefined"

	const hasValidRouterData =
		needRouterModels && dynamicProvider
			? routerModels.data &&
				routerModels.data[dynamicProvider] !== undefined &&
				typeof routerModels.data[dynamicProvider] === "object" &&
				!routerModels.isLoading
			: true

	const isReady =
		(!needLmStudio || typeof lmStudioModels.data !== "undefined") &&
		(!needOllama || typeof ollamaModels.data !== "undefined") &&
		hasValidRouterData &&
		(!needOpenRouterProviders || typeof openRouterModelProviders.data !== "undefined")

	const { id, info } =
		apiConfiguration && isReady && activeProvider
			? getSelectedModel({
					provider: activeProvider,
					apiConfiguration,
					routerModels: (routerModels.data || {}) as RouterModels,
					openRouterModelProviders: (openRouterModelProviders.data || {}) as Record<string, ModelInfo>,
					lmStudioModels: (lmStudioModels.data || undefined) as ModelRecord | undefined,
					ollamaModels: (ollamaModels.data || undefined) as ModelRecord | undefined,
				})
			: activeProvider === providerIdentifiers.kimiCode && apiConfiguration
				? {
						id: apiConfiguration.apiModelId || getProviderDefaultModelId(providerIdentifiers.kimiCode),
						info: kimiCodeDefaultModelInfo,
					}
				: { id: getProviderDefaultModelId(activeProvider ?? providerIdentifiers.openrouter), info: undefined }

	return {
		provider,
		id,
		info,
		isLoading:
			(needRouterModels && routerModels.isLoading) ||
			(needOpenRouterProviders && openRouterModelProviders.isLoading) ||
			(needLmStudio && lmStudioModels!.isLoading) ||
			(needOllama && ollamaModels!.isLoading),
		isError:
			(needRouterModels && routerModels.isError) ||
			(needOpenRouterProviders && openRouterModelProviders.isError) ||
			(needLmStudio && lmStudioModels!.isError) ||
			(needOllama && ollamaModels!.isError),
	}
}

function getSelectedModel({
	provider,
	apiConfiguration,
	routerModels,
	openRouterModelProviders,
	lmStudioModels,
	ollamaModels,
}: {
	provider: ProviderName
	apiConfiguration: ProviderSettings
	routerModels: RouterModels
	openRouterModelProviders: Record<string, ModelInfo>
	lmStudioModels: ModelRecord | undefined
	ollamaModels: ModelRecord | undefined
}): { id: string; info: ModelInfo | undefined } {
	// the `undefined` case are used to show the invalid selection to prevent
	// users from seeing the default model if their selection is invalid
	// this gives a better UX than showing the default model
	const defaultModelId = getProviderDefaultModelId(provider)
	switch (provider) {
		case providerIdentifiers.openrouter: {
			const id = getValidatedModelId(
				apiConfiguration.openRouterModelId,
				routerModels[providerIdentifiers.openrouter],
				defaultModelId,
			)
			let info = routerModels[providerIdentifiers.openrouter]?.[id]
			const specificProvider = apiConfiguration.openRouterSpecificProvider

			if (specificProvider && openRouterModelProviders[specificProvider]) {
				// Overwrite the info with the specific provider info. Some
				// fields are missing the model info for `openRouterModelProviders`
				// so we need to merge the two.
				info = info
					? { ...info, ...openRouterModelProviders[specificProvider] }
					: openRouterModelProviders[specificProvider]
			}

			return { id, info }
		}
		case providerIdentifiers.requesty: {
			const id = getValidatedModelId(
				apiConfiguration.requestyModelId,
				routerModels[providerIdentifiers.requesty],
				defaultModelId,
			)
			const routerInfo = routerModels[providerIdentifiers.requesty]?.[id]
			return { id, info: routerInfo }
		}
		case providerIdentifiers.unbound: {
			const id = getValidatedModelId(
				apiConfiguration.unboundModelId,
				routerModels[providerIdentifiers.unbound],
				defaultModelId,
			)
			const routerInfo = routerModels[providerIdentifiers.unbound]?.[id]
			return { id, info: routerInfo }
		}
		case providerIdentifiers.litellm: {
			// When the model list is empty (not yet loaded or still loading),
			// preserve the configured model ID. LiteLLM is a proxy with no inherent
			// default model, so we never substitute a hardcoded default here -- when
			// nothing is configured we return an empty ID so the picker shows "no
			// selection" rather than a phantom model that does not exist on the server.
			const hasModels =
				routerModels[providerIdentifiers.litellm] &&
				Object.keys(routerModels[providerIdentifiers.litellm]).length > 0
			const id = hasModels
				? getValidatedModelId(
						apiConfiguration.litellmModelId,
						routerModels[providerIdentifiers.litellm],
						defaultModelId,
					)
				: (apiConfiguration.litellmModelId ?? "")
			const routerInfo = routerModels[providerIdentifiers.litellm]?.[id]
			return { id, info: routerInfo ?? litellmDefaultModelInfo }
		}
		case providerIdentifiers.xai: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = xaiModels[id as keyof typeof xaiModels]
			return info ? { id, info } : { id, info: undefined }
		}
		case providerIdentifiers.baseten: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = basetenModels[id as keyof typeof basetenModels]
			return { id, info }
		}
		case providerIdentifiers.bedrock: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = bedrockModels[id as keyof typeof bedrockModels]

			// Special case for custom ARN.
			if (id === "custom-arn") {
				return {
					id,
					info: { maxTokens: 5000, contextWindow: 128_000, supportsPromptCache: true, supportsImages: true },
				}
			}

			// Apply 1M context for supported Claude 4 models when enabled
			if (BEDROCK_1M_CONTEXT_MODEL_IDS.includes(id as any) && apiConfiguration.awsBedrock1MContext && baseInfo) {
				// Create a new ModelInfo object with updated context window
				const info: ModelInfo = {
					...baseInfo,
					contextWindow: 1_000_000,
				}
				return { id, info }
			}

			return { id, info: baseInfo }
		}
		case providerIdentifiers.vertex: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = vertexModels[id as keyof typeof vertexModels]

			// Apply 1M context for supported Claude 4 models when enabled
			if (VERTEX_1M_CONTEXT_MODEL_IDS.includes(id as any) && apiConfiguration.vertex1MContext && baseInfo) {
				const modelInfo: ModelInfo = baseInfo
				const tier = modelInfo.tiers?.[0]
				if (tier) {
					const info: ModelInfo = {
						...modelInfo,
						contextWindow: tier.contextWindow,
						inputPrice: tier.inputPrice,
						outputPrice: tier.outputPrice,
						cacheWritesPrice: tier.cacheWritesPrice,
						cacheReadsPrice: tier.cacheReadsPrice,
					}
					return { id, info }
				}
			}

			return { id, info: baseInfo }
		}
		case providerIdentifiers.gemini: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = geminiModels[id as keyof typeof geminiModels]
			return { id, info }
		}
		case providerIdentifiers.deepseek: {
			const availableModels = routerModels[providerIdentifiers.deepseek]
				? { ...deepSeekModels, ...routerModels[providerIdentifiers.deepseek] }
				: deepSeekModels
			const id = getValidatedModelId(apiConfiguration.apiModelId, availableModels, defaultModelId)
			const routerInfo = routerModels[providerIdentifiers.deepseek]?.[id]
			const staticInfo = deepSeekModels[id as keyof typeof deepSeekModels]
			return { id, info: routerInfo ?? staticInfo }
		}
		case providerIdentifiers.moonshot: {
			const availableModels = routerModels[providerIdentifiers.moonshot]
				? { ...moonshotModels, ...routerModels[providerIdentifiers.moonshot] }
				: moonshotModels
			const id = getValidatedModelId(apiConfiguration.apiModelId, availableModels, defaultModelId)
			const routerInfo = routerModels[providerIdentifiers.moonshot]?.[id]
			const staticInfo = moonshotModels[id as keyof typeof moonshotModels]
			return { id, info: routerInfo ?? staticInfo }
		}
		case providerIdentifiers.kimiCode: {
			const configuredId = apiConfiguration.apiModelId
			const availableModels = routerModels[providerIdentifiers.kimiCode]
			const id = configuredId || defaultModelId
			return { id, info: availableModels?.[id] ?? kimiCodeDefaultModelInfo }
		}
		case providerIdentifiers.minimax: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = minimaxModels[id as keyof typeof minimaxModels]
			return { id, info }
		}
		case providerIdentifiers.mimo: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = mimoModels[id as keyof typeof mimoModels] ?? mimoModels["mimo-v2.5-pro"]
			return { id, info }
		}
		case providerIdentifiers.zai: {
			const apiLine = apiConfiguration.zaiApiLine ?? "international_coding"
			const isChina = zaiApiLineConfigs[apiLine].isChina
			const models = getZAiModels(apiLine)
			const defaultModelId = getProviderDefaultModelId(provider, { isChina })
			const id = getValidatedModelId(apiConfiguration.apiModelId, models, defaultModelId)
			const info = models[id]
			return { id, info }
		}
		case providerIdentifiers.openaiNative: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = openAiNativeModels[id as keyof typeof openAiNativeModels]
			return { id, info }
		}
		case providerIdentifiers.mistral: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = mistralModels[id as keyof typeof mistralModels]
			return { id, info }
		}
		case providerIdentifiers.openai: {
			const id = apiConfiguration.openAiModelId ?? ""
			const customInfo = apiConfiguration?.openAiCustomModelInfo
			const info = customInfo ?? openAiModelInfoSaneDefaults
			return { id, info }
		}
		case providerIdentifiers.ollama: {
			const id = apiConfiguration.ollamaModelId ?? ""
			const info = ollamaModels && ollamaModels[apiConfiguration.ollamaModelId!]

			const adjustedInfo =
				info?.contextWindow &&
				apiConfiguration?.ollamaNumCtx &&
				apiConfiguration.ollamaNumCtx < info.contextWindow
					? { ...info, contextWindow: apiConfiguration.ollamaNumCtx }
					: info

			return {
				id,
				info: adjustedInfo || undefined,
			}
		}
		case providerIdentifiers.lmstudio: {
			const id = apiConfiguration.lmStudioModelId ?? ""
			const modelInfo = lmStudioModels && lmStudioModels[apiConfiguration.lmStudioModelId!]
			return {
				id,
				info: modelInfo ? { ...lMStudioDefaultModelInfo, ...modelInfo } : undefined,
			}
		}
		case providerIdentifiers.vscodeLm: {
			const id = apiConfiguration?.vsCodeLmModelSelector
				? `${apiConfiguration.vsCodeLmModelSelector.vendor}/${apiConfiguration.vsCodeLmModelSelector.family}`
				: vscodeLlmDefaultModelId
			const modelFamily = apiConfiguration?.vsCodeLmModelSelector?.family ?? vscodeLlmDefaultModelId
			// On a family miss, fall back to the default model entry, not openAiModelInfoSaneDefaults
			// (whose 128K contextWindow would diverge from the gate and skew the bar).
			const listedModel =
				vscodeLlmModels[modelFamily as keyof typeof vscodeLlmModels] ?? vscodeLlmModels[vscodeLlmDefaultModelId]
			// Set contextWindow = maxInputTokens so the UI bar shares one source of truth with the gate,
			// whose primary window is getCondenseContextWindow() (static-table maxInputTokens); this
			// info.contextWindow is only the gate's fallback.
			const info: ModelInfo = {
				...openAiModelInfoSaneDefaults,
				...listedModel,
				contextWindow: listedModel.maxInputTokens,
				supportsImages: false, // VSCode LM API currently doesn't support images.
			}
			return { id, info }
		}
		case providerIdentifiers.sambanova: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = sambaNovaModels[id as keyof typeof sambaNovaModels]
			return { id, info }
		}
		case providerIdentifiers.fireworks: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = fireworksModels[id as keyof typeof fireworksModels]
			return { id, info }
		}
		case providerIdentifiers.friendli: {
			// When the Friendli router data is absent or empty (loading or fetch
			// failed), fall back to the static seed. Preserve the saved model
			// selection if it exists in the static seed rather than substituting
			// the default, so the user's selection survives the loading window.
			const hasFriendliRouter = routerModels.friendli && Object.keys(routerModels.friendli).length > 0

			if (!hasFriendliRouter) {
				const savedId = apiConfiguration.apiModelId
				const staticInfo = savedId ? friendliModels[savedId as keyof typeof friendliModels] : undefined
				if (savedId && staticInfo) {
					return { id: savedId, info: staticInfo }
				}
				// Saved id is dynamic-only (not in the static seed) and the
				// router hasn't loaded yet — keep the requested id instead of
				// substituting the default, mirroring FriendliHandler.getModel()
				// on the extension host side during the same load window.
				if (savedId) {
					return { id: savedId, info: undefined }
				}
				return { id: defaultModelId, info: friendliModels[defaultModelId as keyof typeof friendliModels] }
			}

			const availableModels = { ...friendliModels, ...routerModels.friendli! }
			const id = getValidatedModelId(apiConfiguration.apiModelId, availableModels, defaultModelId)
			const routerInfo = routerModels.friendli?.[id]
			const staticInfo = friendliModels[id as keyof typeof friendliModels]
			return { id, info: routerInfo ?? staticInfo }
		}
		case providerIdentifiers.poe: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = routerModels[providerIdentifiers.poe]?.[id]
			return { id, info }
		}
		case providerIdentifiers.qwenCode: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = qwenCodeModels[id as keyof typeof qwenCodeModels]
			return { id, info }
		}
		case providerIdentifiers.openaiCodex: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const info = openAiCodexModels[id as keyof typeof openAiCodexModels]
			return { id, info }
		}
		case providerIdentifiers.vercelAiGateway: {
			const id = getValidatedModelId(
				apiConfiguration.vercelAiGatewayModelId,
				routerModels[providerIdentifiers.vercelAiGateway],
				defaultModelId,
			)
			const info = routerModels[providerIdentifiers.vercelAiGateway]?.[id]
			return { id, info }
		}
		case providerIdentifiers.opencodeGo: {
			const id = getValidatedModelId(
				apiConfiguration.opencodeGoModelId,
				routerModels[providerIdentifiers.opencodeGo],
				defaultModelId,
			)
			// Fall back to the provider's default ModelInfo so capability-driven UI
			// keeps working when the /models list is empty or unavailable.
			const info = routerModels[providerIdentifiers.opencodeGo]?.[id] ?? opencodeGoDefaultModelInfo
			return { id, info }
		}
		case providerIdentifiers.kenari: {
			const id = getValidatedModelId(
				apiConfiguration.kenariModelId,
				routerModels[providerIdentifiers.kenari],
				defaultModelId,
			)
			// Fall back to the provider's default ModelInfo so capability-driven UI
			// keeps working when the /models list is empty or unavailable.
			const info = routerModels[providerIdentifiers.kenari]?.[id] ?? kenariDefaultModelInfo
			return { id, info }
		}
		case providerIdentifiers.nanogpt: {
			const id = getValidatedModelId(
				apiConfiguration.nanoGptModelId,
				routerModels[providerIdentifiers.nanogpt],
				defaultModelId,
			)
			const info = routerModels[providerIdentifiers.nanogpt]?.[id] ?? nanoGptDefaultModelInfo
			return { id, info }
		}
		case providerIdentifiers.zooGateway: {
			const id = getValidatedModelId(
				apiConfiguration.zooGatewayModelId,
				routerModels[providerIdentifiers.zooGateway],
				defaultModelId,
			)
			const info = routerModels[providerIdentifiers.zooGateway]?.[id]
			return { id, info }
		}
		case providerIdentifiers.anthropic:
		case providerIdentifiers.geminiCli:
		case providerIdentifiers.fakeAi: {
			const id = apiConfiguration.apiModelId ?? defaultModelId
			const baseInfo = anthropicModels[id as keyof typeof anthropicModels]

			// Apply 1M context beta tier pricing for supported Claude 4 models
			if (
				provider === providerIdentifiers.anthropic &&
				(id === "claude-sonnet-4-20250514" ||
					id === "claude-sonnet-4-5" ||
					id === "claude-sonnet-4-6" ||
					id === "claude-opus-4-6") &&
				apiConfiguration.anthropicBeta1MContext &&
				baseInfo
			) {
				// Type assertion since supported Claude 4 models include 1M context pricing tiers.
				const modelWithTiers = baseInfo as typeof baseInfo & {
					tiers?: Array<{
						contextWindow: number
						inputPrice?: number
						outputPrice?: number
						cacheWritesPrice?: number
						cacheReadsPrice?: number
					}>
				}
				const tier = modelWithTiers.tiers?.[0]
				if (tier) {
					// Create a new ModelInfo object with updated values
					const info: ModelInfo = {
						...baseInfo,
						contextWindow: tier.contextWindow,
						inputPrice: tier.inputPrice ?? baseInfo.inputPrice,
						outputPrice: tier.outputPrice ?? baseInfo.outputPrice,
						cacheWritesPrice: tier.cacheWritesPrice ?? baseInfo.cacheWritesPrice,
						cacheReadsPrice: tier.cacheReadsPrice ?? baseInfo.cacheReadsPrice,
					}
					return { id, info }
				}
			}

			return { id, info: baseInfo }
		}
		default: {
			provider satisfies never
			throw new Error(`Unsupported provider: ${provider}`)
		}
	}
}
