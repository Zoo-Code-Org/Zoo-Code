import {
	providerIdentifiers,
	type OrganizationAllowList,
	type ProviderSettings,
	type RouterModels,
} from "@roo-code/types"
import type { TFunction } from "i18next"

import { getModelValidationError, validateApiConfigurationExcludingModelErrors, validateBedrockArn } from "../validate"

// `TFunction` is branded; this double only answers a key plus its interpolation values, which is
// what these cases assert on: the key a provider earns and the values handed to the translator.
const t = ((key: string, options?: Record<string, string>) => {
	if (options) {
		return Object.entries(options).reduce((acc, [k, v]) => `${acc} ${k}=${v}`, key)
	}
	return key
}) as unknown as TFunction

const routerModels: RouterModels = {
	openrouter: {
		"valid-model": {
			maxTokens: 8192,
			contextWindow: 200000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 3,
			outputPrice: 15,
		},
		"another-valid-model": {
			maxTokens: 4096,
			contextWindow: 100000,
			supportsImages: false,
			supportsPromptCache: false,
			inputPrice: 1,
			outputPrice: 5,
		},
	},
	requesty: {},
	unbound: {},
	litellm: {},
	"io-intelligence": {},
	ollama: {},
	lmstudio: {},
	"vercel-ai-gateway": {},
	poe: {},
	deepseek: {},
	"opencode-go": {},
	kenari: {},
	nanogpt: {},
	"zoo-gateway": {},
	"kimi-code": {},
	friendli: {},
	moonshot: {},
}

const restrictiveOrganization: OrganizationAllowList = { allowAll: false, providers: {} }

describe("validateApiConfigurationExcludingModelErrors - the credential each provider asks for", () => {
	const cases: { name: string; config: ProviderSettings; expected: string }[] = [
		{
			name: "requesty without its key",
			config: { apiProvider: providerIdentifiers.requesty },
			expected: "settings:validation.apiKey",
		},
		{
			name: "unbound without its key",
			config: { apiProvider: providerIdentifiers.unbound },
			expected: "settings:validation.apiKey",
		},
		{
			name: "litellm without its key",
			config: { apiProvider: providerIdentifiers.litellm },
			expected: "settings:validation.apiKey",
		},
		{
			name: "gemini without its key",
			config: { apiProvider: providerIdentifiers.gemini },
			expected: "settings:validation.apiKey",
		},
		{
			name: "openai-native without its key",
			config: { apiProvider: providerIdentifiers.openaiNative },
			expected: "settings:validation.apiKey",
		},
		{
			name: "mistral without its key",
			config: { apiProvider: providerIdentifiers.mistral },
			expected: "settings:validation.apiKey",
		},
		{
			name: "fireworks without its key",
			config: { apiProvider: providerIdentifiers.fireworks },
			expected: "settings:validation.apiKey",
		},
		{
			name: "vercel-ai-gateway without its key",
			config: { apiProvider: providerIdentifiers.vercelAiGateway },
			expected: "settings:validation.apiKey",
		},
		{
			name: "baseten without its key",
			config: { apiProvider: providerIdentifiers.baseten },
			expected: "settings:validation.apiKey",
		},
		{
			name: "bedrock without a region",
			config: { apiProvider: providerIdentifiers.bedrock },
			expected: "settings:validation.awsRegion",
		},
		{
			name: "vertex with a project but no region",
			config: { apiProvider: providerIdentifiers.vertex, vertexProjectId: "mock-project" },
			expected: "settings:validation.googleCloud",
		},
		{
			name: "ollama without a model id",
			config: { apiProvider: providerIdentifiers.ollama },
			expected: "settings:validation.modelId",
		},
		{
			name: "lmstudio without a model id",
			config: { apiProvider: providerIdentifiers.lmstudio },
			expected: "settings:validation.modelId",
		},
		{
			name: "vscode-lm without a model selector",
			config: { apiProvider: providerIdentifiers.vscodeLm },
			expected: "settings:validation.modelSelector",
		},
		{
			name: "qwen-code without an oauth path",
			config: { apiProvider: providerIdentifiers.qwenCode },
			expected: "settings:validation.qwenCodeOauthPath",
		},
	]

	cases.forEach(({ name, config, expected }) => {
		it(`returns ${expected} for ${name}`, () => {
			expect(validateApiConfigurationExcludingModelErrors(config, t)).toBe(expected)
		})
	})

	it("names the provider the organization allow-list refused", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: "mock-key",
			openRouterModelId: "valid-model",
		}

		expect(validateApiConfigurationExcludingModelErrors(config, t, undefined, restrictiveOrganization)).toBe(
			`settings:validation.providerNotAllowed provider=${providerIdentifiers.openrouter}`,
		)
	})
})

describe("validateBedrockArn - the pair a region mismatch reports", () => {
	it("reports both the ARN region and the configured region", () => {
		const arn =
			"arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-7-sonnet-20250219-v1:0"

		const result = validateBedrockArn(arn, t, "us-east-1")

		expect(result.isValid).toBe(true)
		expect(result.arnRegion).toBe("eu-west-1")
		expect(result.errorMessage).toBe("settings:validation.arn.regionMismatch arnRegion=eu-west-1 region=us-east-1")
	})
})

describe("getModelValidationError - the model a dynamic provider rejected", () => {
	it("names the model id that is not in the fetched list", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: "mock-key",
			openRouterModelId: "not-in-the-list",
		}

		expect(getModelValidationError(config, t, routerModels)).toBe(
			"settings:validation.modelAvailability modelId=not-in-the-list",
		)
	})
	it("accepts the model that is in the fetched list", () => {
		const config: ProviderSettings = {
			apiProvider: providerIdentifiers.openrouter,
			openRouterApiKey: "mock-key",
			openRouterModelId: "valid-model",
		}

		expect(getModelValidationError(config, t, routerModels)).toBeUndefined()
	})
})
