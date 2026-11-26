// npx vitest run api/providers/__tests__/base-openai-compatible-provider-timeout.spec.ts

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock OpenAI and capture constructor calls
const mockOpenAIConstructor = vitest.fn()
const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(function (config) {
			mockOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: mockCreate,
					},
				},
			}
		}),
	}
})

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(apiKey: string) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
		})
	}
}

describe("BaseOpenAiCompatibleProvider Timeout Configuration", () => {
	it("passes the caller-owned deadline and cancellation signal through to the SDK", async () => {
		const provider = new TestOpenAiCompatibleProvider("test-key")
		const controller = new AbortController()
		await provider["createStream"]("system", [], {
			taskId: "task",
			timeoutMs: 86_400_000,
			abortSignal: controller.signal,
		})
		expect(mockCreate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ timeout: 86_400_000, signal: controller.signal }),
		)
	})

	beforeEach(() => {
		clearAllMocks()
	})

	it("should call getApiRequestTimeout when creating the provider", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(getApiRequestTimeout).toHaveBeenCalled()
	})

	it("should pass the default timeout to the OpenAI client constructor", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000) // 600 seconds in ms

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://test.example.com/v1",
				apiKey: "test-api-key",
				timeout: 600000,
			}),
		)
	})

	it("should use custom timeout value from getApiRequestTimeout", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1800000) // 30 minutes in ms

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 1800000,
			}),
		)
	})

	it("should handle zero timeout (no timeout)", () => {
		;(getApiRequestTimeout as any).mockReturnValue(0)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 0,
			}),
		)
	})

	it("should pass DEFAULT_HEADERS to the OpenAI client constructor", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultHeaders: expect.any(Object),
			}),
		)
	})
})
