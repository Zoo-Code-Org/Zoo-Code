import { RooCodeSettings } from "@roo-code/types"

import type { SupportedProvider } from "@/types/index.js"

const envVarMap: Record<SupportedProvider, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	bedrock: "AWS_BEDROCK_API_KEY",
	"openai-native": "OPENAI_API_KEY",
	gemini: "GOOGLE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "VERCEL_AI_GATEWAY_API_KEY",
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
		case "anthropic":
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "bedrock":
			config.awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
			if (model) {
				config.apiModelId = model
				// Auto-enable cross-region inference when model ID has a regional prefix
				// (e.g. "us.", "eu.", "apac.") — these are cross-region inference profiles
				// that require awsUseCrossRegionInference to be set.
				if (/^(us|eu|apac)\./.test(model)) {
					config.awsUseCrossRegionInference = true
				}
			}

			if (apiKey) {
				// Bearer token / API key mode (LiteLLM proxy, Bedrock gateway)
				config.awsUseApiKey = true
				config.awsApiKey = apiKey
			} else if (process.env.AWS_PROFILE) {
				// Profile-based auth
				config.awsUseProfile = true
				config.awsProfile = process.env.AWS_PROFILE
			} else if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
				// Direct credentials from env
				config.awsAccessKey = process.env.AWS_ACCESS_KEY_ID
				config.awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY
				if (process.env.AWS_SESSION_TOKEN) {
					config.awsSessionToken = process.env.AWS_SESSION_TOKEN
				}
			}
			// else: fall through to default credential chain (SDK handles IMDS, ECS task role, etc.)
			break
		case "openai-native":
			if (apiKey) config.openAiNativeApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "gemini":
			if (apiKey) config.geminiApiKey = apiKey
			if (model) config.apiModelId = model
			break
		case "openrouter":
			if (apiKey) config.openRouterApiKey = apiKey
			if (model) config.openRouterModelId = model
			break
		case "vercel-ai-gateway":
			if (apiKey) config.vercelAiGatewayApiKey = apiKey
			if (model) config.vercelAiGatewayModelId = model
			break
		default:
			if (apiKey) config.apiKey = apiKey
			if (model) config.apiModelId = model
	}

	return config
}
