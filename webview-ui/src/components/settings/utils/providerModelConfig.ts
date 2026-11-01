import {
	type ProviderName,
	type ModelInfo,
	type ProviderSettings,
	providerIdentifiers,
	getZAiModels,
	getProviderModels,
} from "@roo-code/types"

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

	const models = getProviderModels(provider)

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
 * Checks if a provider ships a static model catalog in its provider definition.
 */
export const isStaticModelProvider = (provider: ProviderName): boolean => {
	return Object.keys(getProviderModels(provider)).length > 0
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
	providerIdentifiers.githubCopilot,
	providerIdentifiers.moonshot, // Moonshot has custom ModelPicker inside Moonshot.tsx
]

/**
 * Checks if a provider should use the generic ModelPicker
 */
export const shouldUseGenericModelPicker = (provider: ProviderName): boolean => {
	return isStaticModelProvider(provider) && !PROVIDERS_WITH_CUSTOM_MODEL_UI.includes(provider)
}

const isArn = (modelId: string): boolean => modelId.trim().startsWith("arn:")

/**
 * Maps a Bedrock model picker selection to the stored model ID.
 * A pasted ARN selects the "custom-arn" pseudo-model; the ARN itself goes to awsCustomArn.
 */
export const toBedrockModelId = (modelId: string): string => (isArn(modelId) ? "custom-arn" : modelId)

/**
 * Handles provider-specific side effects when a model is changed.
 * Centralizes provider-specific logic to keep it out of the ApiOptions template.
 */
export const handleModelChangeSideEffects = <K extends keyof ProviderSettings>(
	provider: ProviderName,
	modelId: string,
	setApiConfigurationField: (field: K, value: ProviderSettings[K]) => void,
): void => {
	if (provider === providerIdentifiers.bedrock) {
		// The base model and context window belong to a specific ARN (the provider applies the context
		// window to every Bedrock model), so reset them whenever the ARN is replaced or cleared.
		if (modelId !== "custom-arn") {
			setApiConfigurationField("awsCustomArn" as K, (isArn(modelId) ? modelId.trim() : "") as ProviderSettings[K])
			setApiConfigurationField("awsCustomArnBaseModelId" as K, "" as ProviderSettings[K])
			setApiConfigurationField("awsModelContextWindow" as K, undefined as ProviderSettings[K])
		}
	}

	// All providers: Clear reasoning settings when switching models to allow
	// the new model's defaults to take effect. Different models within the
	// same provider can have different reasoning defaults/options.
	setApiConfigurationField("reasoningEffort" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxTokens" as K, undefined as ProviderSettings[K])
	setApiConfigurationField("modelMaxThinkingTokens" as K, undefined as ProviderSettings[K])
}
