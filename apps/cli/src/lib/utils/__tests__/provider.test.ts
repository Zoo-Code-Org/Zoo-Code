import { providerIdentifiers } from "@roo-code/types"

import { getApiKeyFromEnv, getEnvVarName, getProviderSettings } from "../provider.js"

describe("provider configuration", () => {
	it.each([
		[providerIdentifiers.anthropic, "ANTHROPIC_API_KEY"],
		[providerIdentifiers.openaiNative, "OPENAI_API_KEY"],
		[providerIdentifiers.gemini, "GOOGLE_API_KEY"],
		[providerIdentifiers.openrouter, "OPENROUTER_API_KEY"],
		[providerIdentifiers.vercelAiGateway, "VERCEL_AI_GATEWAY_API_KEY"],
	] as const)("maps canonical provider %s to %s", (provider, envVarName) => {
		expect(getEnvVarName(provider)).toBe(envVarName)
	})

	it.each([
		[
			providerIdentifiers.anthropic,
			{ apiProvider: providerIdentifiers.anthropic, apiKey: "key", apiModelId: "model" },
		],
		[
			providerIdentifiers.openaiNative,
			{ apiProvider: providerIdentifiers.openaiNative, openAiNativeApiKey: "key", apiModelId: "model" },
		],
		[
			providerIdentifiers.gemini,
			{ apiProvider: providerIdentifiers.gemini, geminiApiKey: "key", apiModelId: "model" },
		],
		[
			providerIdentifiers.openrouter,
			{ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "key", openRouterModelId: "model" },
		],
		[
			providerIdentifiers.vercelAiGateway,
			{
				apiProvider: providerIdentifiers.vercelAiGateway,
				vercelAiGatewayApiKey: "key",
				vercelAiGatewayModelId: "model",
			},
		],
	] as const)("builds settings for canonical provider %s", (provider, expected) => {
		expect(getProviderSettings(provider, "key", "model")).toEqual(expected)
	})
})

describe("getApiKeyFromEnv", () => {
	const originalEnv = process.env

	beforeEach(() => {
		// Reset process.env before each test.
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("should return API key from environment variable for anthropic", () => {
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
		expect(getApiKeyFromEnv("anthropic")).toBe("test-anthropic-key")
	})

	it("should return API key from environment variable for openrouter", () => {
		process.env.OPENROUTER_API_KEY = "test-openrouter-key"
		expect(getApiKeyFromEnv("openrouter")).toBe("test-openrouter-key")
	})

	it("should return API key from environment variable for openai", () => {
		process.env.OPENAI_API_KEY = "test-openai-key"
		expect(getApiKeyFromEnv("openai-native")).toBe("test-openai-key")
	})

	it("should return undefined when API key is not set", () => {
		delete process.env.ANTHROPIC_API_KEY
		expect(getApiKeyFromEnv("anthropic")).toBeUndefined()
	})
})
