import { getApiKeyFromEnv, getProviderSettings } from "../provider.js"

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

describe("getProviderSettings", () => {
	it("should set openRouterBaseUrl for openrouter provider when baseUrl is provided", () => {
		const settings = getProviderSettings("openrouter", "test-key", "test-model", "https://custom.api")
		expect(settings.openRouterBaseUrl).toBe("https://custom.api")
		expect(settings.openRouterApiKey).toBe("test-key")
		expect(settings.openRouterModelId).toBe("test-model")
		expect(settings.apiProvider).toBe("openrouter")
	})

	it("should not set openRouterBaseUrl when baseUrl is not provided", () => {
		const settings = getProviderSettings("openrouter", "test-key", "test-model")
		expect(settings.openRouterBaseUrl).toBeUndefined()
		expect(settings.openRouterApiKey).toBe("test-key")
		expect(settings.openRouterModelId).toBe("test-model")
	})

	it("should configure anthropic provider correctly", () => {
		const settings = getProviderSettings("anthropic", "anthropic-key", "claude-3-opus")
		expect(settings.apiProvider).toBe("anthropic")
		expect(settings.apiKey).toBe("anthropic-key")
		expect(settings.apiModelId).toBe("claude-3-opus")
	})

	it("should configure openai-native provider correctly", () => {
		const settings = getProviderSettings("openai-native", "openai-key", "gpt-4")
		expect(settings.apiProvider).toBe("openai-native")
		expect(settings.openAiNativeApiKey).toBe("openai-key")
		expect(settings.apiModelId).toBe("gpt-4")
	})

	it("should configure gemini provider correctly", () => {
		const settings = getProviderSettings("gemini", "gemini-key", "gemini-pro")
		expect(settings.apiProvider).toBe("gemini")
		expect(settings.geminiApiKey).toBe("gemini-key")
		expect(settings.apiModelId).toBe("gemini-pro")
	})

	it("should handle missing optional parameters", () => {
		const settings = getProviderSettings("anthropic", undefined, undefined)
		expect(settings.apiProvider).toBe("anthropic")
		expect(settings.apiKey).toBeUndefined()
		expect(settings.apiModelId).toBeUndefined()
	})
})
