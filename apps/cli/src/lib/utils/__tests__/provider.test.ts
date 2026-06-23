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

	it("should return API key from environment variable for novita", () => {
		process.env.NOVITA_API_KEY = "test-novita-key"
		expect(getApiKeyFromEnv("novita")).toBe("test-novita-key")
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
	it("should map Novita key and model into provider settings", () => {
		expect(getProviderSettings("novita", "test-novita-key", "moonshotai/kimi-k2.7-code")).toEqual({
			apiProvider: "novita",
			novitaApiKey: "test-novita-key",
			apiModelId: "moonshotai/kimi-k2.7-code",
		})
	})
})
