import type { ProviderName, ModelInfo, ProviderSettings } from "@roo-code/types"
import {
	anthropicDefaultModelId,
	bedrockDefaultModelId,
	deepSeekDefaultModelId,
	moonshotDefaultModelId,
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
	minimaxDefaultModelId,
	basetenDefaultModelId,
	mimoDefaultModelId,
	poeDefaultModelId,
	requestyDefaultModelId,
	unboundDefaultModelId,
	litellmDefaultModelId,
	vercelAiGatewayDefaultModelId,
	opencodeGoDefaultModelId,
	zooGatewayDefaultModelId,
} from "@roo-code/types"

import { MODELS_BY_PROVIDER } from "../constants"

export interface ProviderServiceConfig {
	serviceName: string
	serviceUrl: string
}

export const PROVIDER_SERVICE_CONFIG: Partial<Record<ProviderName, ProviderServiceConfig>> = {
	anthropic: { serviceName: "Anthropic", serviceUrl: "https://console.anthropic.com" },
	bedrock: { serviceName: "Amazon Bedrock", serviceUrl: "https://aws.amazon.com/bedrock" },
	deepseek: { serviceName: "DeepSeek", serviceUrl: "https://platform.deepseek.com" },
	moonshot: { serviceName: "Moonshot", serviceUrl: "https://platform.moonshot.cn" },
	gemini: { serviceName: "Google Gemini", serviceUrl: "https://ai.google.dev" },
	mistral: { serviceName: "Mistral", serviceUrl: "https://console.mistral.ai" },
	"openai-native": { serviceName: "OpenAI", serviceUrl: "https://platform.openai.com" },
	"qwen-code": { serviceName: "Qwen Code", serviceUrl: "https://dashscope.console.aliyun.com" },
	vertex: { serviceName: "GCP Vertex AI", serviceUrl: "https://console.cloud.google.com/vertex-ai" },
	xai: { serviceName: "xAI", serviceUrl: "https://x.ai" },
	sambanova: { serviceName: "SambaNova", serviceUrl: "https://sambanova.ai" },
	zai: { serviceName: "Z.ai", serviceUrl: "https://z.ai" },
	fireworks: { serviceName: "Fireworks AI", serviceUrl: "https://fireworks.ai" },
	minimax: { serviceName: "MiniMax", serviceUrl: "https://minimax.chat" },
	mimo: { serviceName: "Xiaomi MiMo", serviceUrl: "https://platform.xiaomimimo.com" },
	baseten: { serviceName: "Baseten", serviceUrl: "https://baseten.co" },
	ollama: { serviceName: "Ollama", serviceUrl: "https://ollama.ai" },
	lmstudio: { serviceName: "LM Studio", serviceUrl: "https://lmstudio.ai/docs" },
	"vscode-lm": {
		serviceName: "VS Code LM",
		serviceUrl: "https://code.visualstudio.com/api/extension-guides/language-model",
	},
}

export const PROVIDER_DEFAULT_MODEL_IDS: Partial<Record<ProviderName, string>> = {
	anthropic: anthropicDefaultModelId,
	bedrock: bedrockDefaultModelId,
	deepseek: deepSeekDefaultModelId,
	moonshot: moonshotDefaultModelId,
	gemini: geminiDefaultModelId,
	mistral: mistralDefaultModelId,
	"openai-native": openAiNativeDefaultModelId,
	"qwen-code": qwenCodeDefaultModelId,
	vertex: vertexDefaultModelId,
	xai: xaiDefaultModelId,
	sambanova: sambaNovaDefaultModelId,
	zai: internationalZAiDefaultModelId,
	fireworks: fireworksDefaultModelId,
	minimax: minimaxDefaultModelId,
	mimo: mimoDefaultModelId,
	baseten: basetenDefaultModelId,
}

export const getProviderServiceConfig = (provider: ProviderName): ProviderServiceConfig => {
	return PROVIDER_SERVICE_CONFIG[provider] ?? { serviceName: provider, serviceUrl: "" }
}

export const getDefaultModelIdForProvider = (provider: ProviderName, apiConfiguration?: ProviderSettings): string => {
	// Handle Z.ai's China/International entrypoint distinction
	if (provider === "zai" && apiConfiguration) {
		return apiConfiguration.zaiApiLine === "china_coding"
			? mainlandZAiDefaultModelId
			: internationalZAiDefaultModelId
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
	openrouter: { field: "openRouterModelId", default: openRouterDefaultModelId },
	requesty: { field: "requestyModelId", default: requestyDefaultModelId },
	unbound: { field: "unboundModelId", default: unboundDefaultModelId },
	litellm: { field: "litellmModelId", default: litellmDefaultModelId },
	anthropic: { field: "apiModelId", default: anthropicDefaultModelId },
	"openai-codex": { field: "apiModelId", default: openAiCodexDefaultModelId },
	"qwen-code": { field: "apiModelId", default: qwenCodeDefaultModelId },
	"openai-native": { field: "apiModelId", default: openAiNativeDefaultModelId },
	gemini: { field: "apiModelId", default: geminiDefaultModelId },
	deepseek: { field: "apiModelId", default: deepSeekDefaultModelId },
	moonshot: { field: "apiModelId", default: moonshotDefaultModelId },
	minimax: { field: "apiModelId", default: minimaxDefaultModelId },
	mimo: { field: "apiModelId", default: mimoDefaultModelId },
	mistral: { field: "apiModelId", default: mistralDefaultModelId },
	xai: { field: "apiModelId", default: xaiDefaultModelId },
	baseten: { field: "apiModelId", default: basetenDefaultModelId },
	bedrock: { field: "apiModelId", default: bedrockDefaultModelId },
	vertex: { field: "apiModelId", default: vertexDefaultModelId },
	sambanova: { field: "apiModelId", default: sambaNovaDefaultModelId },
	zai: { field: "apiModelId" },
	fireworks: { field: "apiModelId", default: fireworksDefaultModelId },
	poe: { field: "apiModelId", default: poeDefaultModelId },
	"vercel-ai-gateway": { field: "vercelAiGatewayModelId", default: vercelAiGatewayDefaultModelId },
	"opencode-go": { field: "opencodeGoModelId", default: opencodeGoDefaultModelId },
	"zoo-gateway": { field: "zooGatewayModelId", default: zooGatewayDefaultModelId },
	openai: { field: "openAiModelId" },
	ollama: { field: "ollamaModelId" },
	lmstudio: { field: "lmStudioModelId" },
}

export function getProviderModelConfig(provider: string, apiConfiguration?: ProviderSettings) {
	const config = PROVIDER_MODEL_CONFIG[provider as ProviderName]
	if (!config) return undefined

	if (provider === "zai") {
		return {
			...config,
			default: getDefaultModelIdForProvider(provider as ProviderName, apiConfiguration),
		}
	}

	return config
}

// Custom mapping for doc URL slugs. Default is provider key.
const PROVIDER_DOCS_SLUGS: Partial<Record<ProviderName, string>> = {
	"openai-native": "openai",
	openai: "openai-compatible",
}

export function getProviderDocsSlug(provider: string) {
	return PROVIDER_DOCS_SLUGS[provider as ProviderName] ?? provider
}

export const getStaticModelsForProvider = (
	provider: ProviderName,
	customArnLabel?: string,
): Record<string, ModelInfo> => {
	const models = MODELS_BY_PROVIDER[provider] ?? {}

	// Add custom-arn option for Bedrock
	if (provider === "bedrock") {
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
	"openrouter",
	"requesty",
	"unbound",
	"openai", // OpenAI Compatible
	"openai-codex", // OpenAI Codex has custom UI with auth and rate limits
	"litellm",
	"vercel-ai-gateway",
	"ollama",
	"lmstudio",
	"vscode-lm",
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
	if (provider === "bedrock" && modelId !== "custom-arn") {
		setApiConfigurationField("awsCustomArn" as K, "" as ProviderSettings[K])
	}

	// All providers: Clear reasoning settings when switching models to allow
	// the new model's defaults to take effect. Different models within the
	// same provider can have different reasoning defaults/options.
	setApiConfigurationField("reasoningEffort" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxTokens" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxThinkingTokens" as K, undefined as ProviderSettings[K])
}
