// npx vitest run api/providers/__tests__/client-deadline-wiring.spec.ts

// Every OpenAI-compatible client construction site must receive the request
// deadline dispatcher so the transport's idle deadlines follow
// apiRequestTimeout (issue #1407).

import type { ModelInfo } from "@roo-code/types"

import { OpenAiHandler } from "../openai"
import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"
import type { ApiHandlerOptions } from "../../../shared/api"

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

vitest.mock("../../../utils/networkProxy", () => ({
	isProxyEnabled: vitest.fn(),
}))

vitest.mock("undici", () => ({
	Agent: vitest.fn().mockImplementation(function () {
		return { __mockDispatcher: true }
	}),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"
import { isProxyEnabled } from "../../../utils/networkProxy"
import { clearAllMocks } from "../../../test-utils/reset"

const mockOpenAIConstructor = vitest.fn()
const mockAzureOpenAIConstructor = vitest.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(function (config: unknown) {
			mockOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
		}),
		AzureOpenAI: vitest.fn().mockImplementation(function (config: unknown) {
			mockAzureOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
		}),
	}
})

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

function lastConstructorConfig(mock: ReturnType<typeof vitest.fn>): Record<string, unknown> | undefined {
	return mock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
}

describe("client construction receives the request deadline dispatcher", () => {
	beforeEach(() => {
		clearAllMocks()
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)
		vitest.mocked(isProxyEnabled).mockReturnValue(false)
	})

	it("wires the dispatcher into the plain OpenAI client", () => {
		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "http://localhost:8080/v1",
			openAiApiKey: "test-key",
		}

		new OpenAiHandler(options)

		const config = lastConstructorConfig(mockOpenAIConstructor)
		expect(config?.timeout).toBe(600000)
		expect(config?.fetchOptions).toBeDefined()
	})

	it("wires the dispatcher into the Azure OpenAI client", () => {
		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://myresource.openai.azure.com",
			openAiApiKey: "test-key",
			openAiUseAzure: true,
		}

		new OpenAiHandler(options)

		const config = lastConstructorConfig(mockAzureOpenAIConstructor)
		expect(config?.timeout).toBe(600000)
		expect(config?.fetchOptions).toBeDefined()
	})

	it("wires the dispatcher into OpenAI-compatible base providers", () => {
		new TestOpenAiCompatibleProvider("test-api-key")

		const config = lastConstructorConfig(mockOpenAIConstructor)
		expect(config?.timeout).toBe(600000)
		expect(config?.fetchOptions).toBeDefined()
	})

	it("wires no dispatcher while the debug proxy is active", () => {
		vitest.mocked(isProxyEnabled).mockReturnValue(true)

		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "http://localhost:8080/v1",
			openAiApiKey: "test-key",
		}

		new OpenAiHandler(options)

		const config = lastConstructorConfig(mockOpenAIConstructor)
		expect(config?.timeout).toBe(600000)
		expect(config?.fetchOptions).toBeUndefined()
	})
})
