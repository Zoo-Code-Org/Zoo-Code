// npx vitest run src/shared/__tests__/checkExistApiConfig.spec.ts

import type { ProviderSettings } from "@roo-code/types"

import { checkExistKey } from "../checkExistApiConfig"

describe("checkExistKey", () => {
	it("should return false for undefined config", () => {
		expect(checkExistKey(undefined)).toBe(false)
	})

	it("should return false for empty config", () => {
		const config: ProviderSettings = {}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true when one key is defined", () => {
		const config: ProviderSettings = {
			apiKey: "test-key",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true when multiple keys are defined", () => {
		const config: ProviderSettings = {
			apiKey: "test-key",
			openRouterApiKey: "openrouter-key",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true when only non-key fields are undefined", () => {
		const config: ProviderSettings = {
			apiKey: "test-key",
			apiProvider: undefined,
			anthropicBaseUrl: undefined,
			modelMaxThinkingTokens: undefined,
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return false when all key fields are undefined", () => {
		const config: ProviderSettings = {
			apiKey: undefined,
			openRouterApiKey: undefined,
			awsRegion: undefined,
			vertexProjectId: undefined,
			openAiApiKey: undefined,
			ollamaModelId: undefined,
			lmStudioModelId: undefined,
			geminiApiKey: undefined,
			openAiNativeApiKey: undefined,
			deepSeekApiKey: undefined,
			moonshotApiKey: undefined,
			mistralApiKey: undefined,
			vsCodeLmModelSelector: undefined,
			requestyApiKey: undefined,
		}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true for fake-ai provider without API key", () => {
		const config: ProviderSettings = {
			apiProvider: "fake-ai",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true for openai-codex provider without API key", () => {
		const config: ProviderSettings = {
			apiProvider: "openai-codex",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true for qwen-code provider without API key", () => {
		const config: ProviderSettings = {
			apiProvider: "qwen-code",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return false for roo provider without API key", () => {
		const config: ProviderSettings = {
			apiProvider: "roo",
		}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return true for kimi-code provider with OAuth auth method", () => {
		const config: ProviderSettings = {
			apiProvider: "kimi-code",
			kimiCodeAuthMethod: "oauth",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true for kimi-code provider without auth method (defaults to OAuth)", () => {
		const config: ProviderSettings = {
			apiProvider: "kimi-code",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true for kimi-code provider with api-key auth and key present", () => {
		const config: ProviderSettings = {
			apiProvider: "kimi-code",
			kimiCodeAuthMethod: "api-key",
			kimiCodeApiKey: "test-key",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return false for kimi-code provider with api-key auth but no key", () => {
		const config: ProviderSettings = {
			apiProvider: "kimi-code",
			kimiCodeAuthMethod: "api-key",
		}
		expect(checkExistKey(config)).toBe(false)
	})

	it("should return false for zoo-gateway without session token or auth", () => {
		const config: ProviderSettings = {
			apiProvider: "zoo-gateway",
			zooGatewayModelId: "alibaba/qwen-3.6-max-preview",
		}
		expect(checkExistKey(config)).toBe(false)
		expect(checkExistKey(config, false)).toBe(false)
	})

	it("should return true for zoo-gateway when profile has zooSessionToken", () => {
		const config: ProviderSettings = {
			apiProvider: "zoo-gateway",
			zooSessionToken: "zoo_ext_test_token",
		}
		expect(checkExistKey(config)).toBe(true)
	})

	it("should return true for zoo-gateway when Zoo Code session auth is active", () => {
		const config: ProviderSettings = {
			apiProvider: "zoo-gateway",
			zooGatewayModelId: "alibaba/qwen-3.6-max-preview",
		}
		expect(checkExistKey(config, true)).toBe(true)
	})

	it("should ignore zooCodeIsAuthenticated for non-zoo-gateway providers", () => {
		const config: ProviderSettings = {
			apiProvider: "openrouter",
		}
		expect(checkExistKey(config, true)).toBe(false)
	})
})
