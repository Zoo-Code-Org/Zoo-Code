import { providerIdentifiers, type RooCodeSettings } from "@roo-code/types"

import type { SupportedProvider } from "@/types/index.js"

const envVarMap: Record<SupportedProvider, string> = {
	[providerIdentifiers.anthropic]: "ANTHROPIC_API_KEY",
	[providerIdentifiers.openaiNative]: "OPENAI_API_KEY",
	[providerIdentifiers.gemini]: "GOOGLE_API_KEY",
	[providerIdentifiers.openrouter]: "OPENROUTER_API_KEY",
	[providerIdentifiers.vercelAiGateway]: "VERCEL_AI_GATEWAY_API_KEY",
}

export function getEnvVarName(provider: SupportedProvider): string {
	return envVarMap[provider]
}

export function getApiKeyFromEnv(provider: SupportedProvider): string | undefined {
	const envVar = getEnvVarName(provider)
	return process.env[envVar]
}

export function getProviderSettings(
	provider: SupportedProvider,
	apiKey: string | undefined,
	model: string | undefined,
): RooCodeSettings {
	const config: RooCodeSettings = { apiProvider: provider }

	switch (provider) {
		case providerIdentifiers.anthropic:
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
			break
		case providerIdentifiers.openaiNative:
			if (apiKey) config.openAiNativeApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case providerIdentifiers.gemini:
			if (apiKey) config.geminiApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case providerIdentifiers.openrouter:
			if (apiKey) config.openRouterApiKey = apiKey
			if (model) config.openRouterModelId = model
			break
		case providerIdentifiers.vercelAiGateway:
			if (apiKey) config.vercelAiGatewayApiKey = apiKey
			if (model) config.vercelAiGatewayModelId = model
			break
		default:
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
	}

	return config
}
