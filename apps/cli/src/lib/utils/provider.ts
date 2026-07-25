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

/**
 * Whether a provider requires an explicit API key before a task can run.
 *
 * Every provider except Bedrock authenticates solely via an API key
 * (`--api-key` or its provider-specific environment variable). Bedrock is the
 * exception: in addition to a bearer token / API key, it can authenticate via
 * an AWS profile, direct AWS access/secret keys, OR the AWS SDK default
 * credential chain (IMDS / EC2 instance profile, ECS task role, IRSA /
 * web-identity, SSO, shared-config default). Those chain-based sources set none
 * of our recognised environment variables, so Bedrock must never be hard-failed
 * for a "missing" API key — the downstream `AwsBedrockHandler` resolves the
 * credentials and surfaces a real error only if resolution actually fails.
 */
export function providerRequiresApiKey(provider: SupportedProvider): boolean {
	return provider !== "bedrock"
}

/**
 * Build the provider-specific `RooCodeSettings` used to configure the extension
 * host for a CLI run.
 *
 * The Bedrock case supports four authentication modes, resolved in priority
 * order:
 *   1. Bearer token / API key — `--api-key` or `AWS_BEDROCK_API_KEY`
 *      (`awsUseApiKey` + `awsApiKey`).
 *   2. AWS profile — `AWS_PROFILE` (`awsUseProfile` + `awsProfile`).
 *   3. Direct credentials — `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
 *      (+ optional `AWS_SESSION_TOKEN`).
 *   4. Default credential chain — none of the above set; the AWS SDK resolves
 *      credentials (IMDS, ECS task role, IRSA, SSO, shared-config default).
 * The region is resolved from `AWS_REGION` / `AWS_DEFAULT_REGION` (defaulting to
 * `us-east-1`), and cross-region inference is auto-enabled for model IDs that
 * carry a regional prefix (`us.` / `eu.` / `apac.`).
 */
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
