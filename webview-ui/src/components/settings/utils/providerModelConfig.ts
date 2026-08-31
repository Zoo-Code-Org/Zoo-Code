import type { ProviderName, ModelInfo, ProviderSettings } from "@roo-code/types"
import {
	providerIdentifiers,
	anthropicDefaultModelId,
	bedrockDefaultModelId,
	deepSeekDefaultModelId,
	moonshotDefaultModelId,
	kimiCodeDefaultModelId,
	geminiDefaultModelId,
	mistralDefaultModelId,
	openRouterDefaultModelId,
	openAiNativeDefaultModelId,
	openAiCodexDefaultModelId,
	qwenCodeDefaultModelId,
	vertexDefaultModelId,
	xaiDefaultModelId,
	sambaNovaDefaultModelId,
	internationalZAiDefaultModelId,
	mainlandZAiDefaultModelId,
	fireworksDefaultModelId,
	friendliDefaultModelId,
	minimaxDefaultModelId,
	basetenDefaultModelId,
	mimoDefaultModelId,
	poeDefaultModelId,
	requestyDefaultModelId,
	unboundDefaultModelId,
	litellmDefaultModelId,
	vercelAiGatewayDefaultModelId,
	opencodeGoDefaultModelId,
	kenariDefaultModelId,
	nanoGptDefaultModelId,
	zooGatewayDefaultModelId,
	zaiApiLineConfigs,
	getZAiModels,
} from "@roo-code/types"

import { MODELS_BY_PROVIDER } from "../constants"

export interface ProviderServiceConfig {
	serviceName: string
	serviceUrl: string
}

export const PROVIDER_SERVICE_CONFIG: Partial<Record<ProviderName, ProviderServiceConfig>> = {
	[providerIdentifiers.anthropic]: { serviceName: "Anthropic", serviceUrl: "https://console.anthropic.com" },
	[providerIdentifiers.bedrock]: { serviceName: "Amazon Bedrock", serviceUrl: "https://aws.amazon.com/bedrock" },
	[providerIdentifiers.deepseek]: { serviceName: "DeepSeek", serviceUrl: "https://platform.deepseek.com" },
	[providerIdentifiers.moonshot]: { serviceName: "Moonshot", serviceUrl: "https://platform.moonshot.cn" },
	[providerIdentifiers.kimiCode]: { serviceName: "Kimi Code", serviceUrl: "https://www.kimi.com/code" },
	[providerIdentifiers.gemini]: { serviceName: "Google Gemini", serviceUrl: "https://ai.google.dev" },
	[providerIdentifiers.mistral]: { serviceName: "Mistral", serviceUrl: "https://console.mistral.ai" },
	[providerIdentifiers.openaiNative]: { serviceName: "OpenAI", serviceUrl: "https://platform.openai.com" },
	[providerIdentifiers.qwenCode]: { serviceName: "Qwen Code", serviceUrl: "https://dashscope.console.aliyun.com" },
	[providerIdentifiers.vertex]: {
		serviceName: "GCP Vertex AI",
		serviceUrl: "https://console.cloud.google.com/vertex-ai",
	},
	[providerIdentifiers.xai]: { serviceName: "xAI", serviceUrl: "https://x.ai" },
	[providerIdentifiers.sambanova]: { serviceName: "SambaNova", serviceUrl: "https://sambanova.ai" },
	[providerIdentifiers.zai]: { serviceName: "Z.ai", serviceUrl: "https://z.ai" },
	[providerIdentifiers.fireworks]: { serviceName: "Fireworks AI", serviceUrl: "https://fireworks.ai" },
	[providerIdentifiers.friendli]: { serviceName: "Friendli", serviceUrl: "https://friendli.ai" },
	[providerIdentifiers.minimax]: { serviceName: "MiniMax", serviceUrl: "https://minimax.chat" },
	[providerIdentifiers.mimo]: { serviceName: "Xiaomi MiMo", serviceUrl: "https://platform.xiaomimimo.com" },
	[providerIdentifiers.baseten]: { serviceName: "Baseten", serviceUrl: "https://baseten.co" },
	[providerIdentifiers.ollama]: { serviceName: "Ollama", serviceUrl: "https://ollama.ai" },
	[providerIdentifiers.lmstudio]: { serviceName: "LM Studio", serviceUrl: "https://lmstudio.ai/docs" },
	[providerIdentifiers.vscodeLm]: {
		serviceName: "VS Code LM",
		serviceUrl: "https://code.visualstudio.com/api/extension-guides/language-model",
	},
}

export const PROVIDER_DEFAULT_MODEL_IDS: Partial<Record<ProviderName, string>> = {
	[providerIdentifiers.anthropic]: anthropicDefaultModelId,
	[providerIdentifiers.bedrock]: bedrockDefaultModelId,
	[providerIdentifiers.deepseek]: deepSeekDefaultModelId,
	[providerIdentifiers.moonshot]: moonshotDefaultModelId,
	[providerIdentifiers.kimiCode]: kimiCodeDefaultModelId,
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

export const getProviderServiceConfig = (provider: ProviderName): ProviderServiceConfig => {
	return PROVIDER_SERVICE_CONFIG[provider] ?? { serviceName: provider, serviceUrl: "" }
}

export const getDefaultModelIdForProvider = (provider: ProviderName, apiConfiguration?: ProviderSettings): string => {
	// Handle Z.ai's China/International entrypoint distinction
	if (provider === providerIdentifiers.zai && apiConfiguration) {
		const apiLine = apiConfiguration.zaiApiLine ?? "international_coding"
		return zaiApiLineConfigs[apiLine].isChina ? mainlandZAiDefaultModelId : internationalZAiDefaultModelId
	}

	return PROVIDER_DEFAULT_MODEL_IDS[provider] ?? ""
}

export type ProviderModelConfig = {
	field: keyof ProviderSettings
	default?: string
}

// Minimal per-provider config used by ApiOptions for model-id field wiring.
// Kept in this file to keep ApiOptions.tsx from growing a second registry.
const PROVIDER_MODEL_CONFIG: Partial<Record<ProviderName, ProviderModelConfig>> = {
	[providerIdentifiers.openrouter]: { field: "openRouterModelId", default: openRouterDefaultModelId },
	[providerIdentifiers.requesty]: { field: "requestyModelId", default: requestyDefaultModelId },
	[providerIdentifiers.unbound]: { field: "unboundModelId", default: unboundDefaultModelId },
	[providerIdentifiers.litellm]: { field: "litellmModelId", default: litellmDefaultModelId },
	[providerIdentifiers.anthropic]: { field: "apiModelId", default: anthropicDefaultModelId },
	[providerIdentifiers.openaiCodex]: { field: "apiModelId", default: openAiCodexDefaultModelId },
	[providerIdentifiers.qwenCode]: { field: "apiModelId", default: qwenCodeDefaultModelId },
	[providerIdentifiers.openaiNative]: { field: "apiModelId", default: openAiNativeDefaultModelId },
	[providerIdentifiers.gemini]: { field: "apiModelId", default: geminiDefaultModelId },
	[providerIdentifiers.deepseek]: { field: "apiModelId", default: deepSeekDefaultModelId },
	[providerIdentifiers.moonshot]: { field: "apiModelId", default: moonshotDefaultModelId },
	[providerIdentifiers.kimiCode]: { field: "apiModelId", default: kimiCodeDefaultModelId },
	[providerIdentifiers.minimax]: { field: "apiModelId", default: minimaxDefaultModelId },
	[providerIdentifiers.mimo]: { field: "apiModelId", default: mimoDefaultModelId },
	[providerIdentifiers.mistral]: { field: "apiModelId", default: mistralDefaultModelId },
	[providerIdentifiers.xai]: { field: "apiModelId", default: xaiDefaultModelId },
	[providerIdentifiers.baseten]: { field: "apiModelId", default: basetenDefaultModelId },
	[providerIdentifiers.bedrock]: { field: "apiModelId", default: bedrockDefaultModelId },
	[providerIdentifiers.vertex]: { field: "apiModelId", default: vertexDefaultModelId },
	[providerIdentifiers.sambanova]: { field: "apiModelId", default: sambaNovaDefaultModelId },
	[providerIdentifiers.zai]: { field: "apiModelId" },
	[providerIdentifiers.fireworks]: { field: "apiModelId", default: fireworksDefaultModelId },
	[providerIdentifiers.friendli]: { field: "apiModelId", default: friendliDefaultModelId },
	[providerIdentifiers.poe]: { field: "apiModelId", default: poeDefaultModelId },
	[providerIdentifiers.vercelAiGateway]: {
		field: "vercelAiGatewayModelId",
		default: vercelAiGatewayDefaultModelId,
	},
	[providerIdentifiers.opencodeGo]: { field: "opencodeGoModelId", default: opencodeGoDefaultModelId },
	[providerIdentifiers.kenari]: { field: "kenariModelId", default: kenariDefaultModelId },
	[providerIdentifiers.nanogpt]: { field: "nanoGptModelId", default: nanoGptDefaultModelId },
	[providerIdentifiers.zooGateway]: { field: "zooGatewayModelId", default: zooGatewayDefaultModelId },
	[providerIdentifiers.openai]: { field: "openAiModelId" },
	[providerIdentifiers.ollama]: { field: "ollamaModelId" },
	[providerIdentifiers.lmstudio]: { field: "lmStudioModelId" },
}

export function getProviderModelConfig(provider: string, apiConfiguration?: ProviderSettings) {
	const config = PROVIDER_MODEL_CONFIG[provider as ProviderName]
	if (!config) return undefined

	if (provider === providerIdentifiers.zai) {
		return {
			...config,
			default: getDefaultModelIdForProvider(provider as ProviderName, apiConfiguration),
		}
	}

	return config
}

// Custom mapping for doc URL slugs. Default is provider key.
const PROVIDER_DOCS_SLUGS: Partial<Record<ProviderName, string>> = {
	[providerIdentifiers.openaiNative]: "openai",
	[providerIdentifiers.openai]: "openai-compatible",
}

export function getProviderDocsSlug(provider: string) {
	return PROVIDER_DOCS_SLUGS[provider as ProviderName] ?? provider
}

export const getStaticModelsForProvider = (
	provider: ProviderName,
	customArnLabel?: string,
	apiConfiguration?: ProviderSettings,
): Record<string, ModelInfo> => {
	if (provider === providerIdentifiers.zai) {
		return getZAiModels(apiConfiguration?.zaiApiLine)
	}

	const models = MODELS_BY_PROVIDER[provider] ?? {}

	// Add custom-arn option for Bedrock
	if (provider === providerIdentifiers.bedrock) {
		return {
			...models,
			"custom-arn": {
				maxTokens: 0,
				contextWindow: 0,
				supportsPromptCache: false,
				description: customArnLabel ?? "Use Custom ARN",
			},
		}
	}

	return models
}

/**
 * Checks if a provider uses static models from MODELS_BY_PROVIDER
 */
export const isStaticModelProvider = (provider: ProviderName): boolean => {
	return provider in MODELS_BY_PROVIDER
}

/**
 * List of providers that have their own custom model selection UI
 * and should not use the generic ModelPicker in ApiOptions
 */
export const PROVIDERS_WITH_CUSTOM_MODEL_UI: ProviderName[] = [
	providerIdentifiers.openrouter,
	providerIdentifiers.requesty,
	providerIdentifiers.unbound,
	providerIdentifiers.openai, // OpenAI Compatible
	providerIdentifiers.openaiCodex, // OpenAI Codex has custom UI with auth and rate limits
	providerIdentifiers.kimiCode,
	providerIdentifiers.litellm,
	providerIdentifiers.vercelAiGateway,
	providerIdentifiers.ollama,
	providerIdentifiers.lmstudio,
	providerIdentifiers.vscodeLm,
	providerIdentifiers.moonshot, // Moonshot has custom ModelPicker inside Moonshot.tsx
	providerIdentifiers.friendli,
]

/**
 * Checks if a provider should use the generic ModelPicker
 */
export const shouldUseGenericModelPicker = (provider: ProviderName): boolean => {
	return isStaticModelProvider(provider) && !PROVIDERS_WITH_CUSTOM_MODEL_UI.includes(provider)
}

/**
 * Handles provider-specific side effects when a model is changed.
 * Centralizes provider-specific logic to keep it out of the ApiOptions template.
 */
export const handleModelChangeSideEffects = <K extends keyof ProviderSettings>(
	provider: ProviderName,
	modelId: string,
	setApiConfigurationField: (field: K, value: ProviderSettings[K]) => void,
): void => {
	// Bedrock: Clear custom ARN if not using custom ARN option
	if (provider === providerIdentifiers.bedrock && modelId !== "custom-arn") {
		setApiConfigurationField("awsCustomArn" as K, "" as ProviderSettings[K])
	}

	// All providers: Clear reasoning settings when switching models to allow
	// the new model's defaults to take effect. Different models within the
	// same provider can have different reasoning defaults/options.
	setApiConfigurationField("reasoningEffort" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxTokens" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxThinkingTokens" as K, undefined as ProviderSettings[K])
}
