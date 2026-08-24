// npx vitest run api/providers/__tests__/f7-declared-reasoning-effort.spec.ts
//
// F7: handler-level coverage for the user-declared reasoning effort fill-in
// (withDeclaredReasoningEffort) at the sites where OpenAI-compatible ModelInfo
// reaches consumers via getModel().

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"
import { LiteLLMHandler } from "../lite-llm"
import { LmStudioHandler } from "../lm-studio"
import { getOllamaModels } from "../fetchers/ollama"
import { NativeOllamaHandler } from "../native-ollama"
import { OpenAiHandler } from "../openai"
import { makeApiHandlerOptions } from "../../../test-utils/api"

vitest.mock("openai", () => ({
	__esModule: true,
	default: vitest.fn().mockImplementation(function () {
		return {
			chat: {
				completions: {
					create: vitest.fn(),
				},
			},
		}
	}),
	AzureOpenAI: vitest.fn(),
}))

vi.mock("../fetchers/ollama", () => ({
	getOllamaModels: vi.fn(),
}))

// Concrete test implementation of the abstract base class (same pattern as
// base-openai-compatible-provider.spec.ts).
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(options: Record<string, unknown>) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128_000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey: "test-api-key",
			...options,
		})
	}
}

const DECLARED: NonNullable<ProviderSettings["supportedReasoningEfforts"]> = ["low", "high", "max"]

describe("F7 declared reasoning effort fill-in at handler construction sites", () => {
	describe("OpenAiHandler (custom OpenAI endpoint)", () => {
		it("fills in declared levels for the sane-default model info", () => {
			const handler = new OpenAiHandler(
				makeApiHandlerOptions({
					openAiApiKey: "test-api-key",
					openAiModelId: "qwen3-32b",
					supportedReasoningEfforts: DECLARED,
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(DECLARED)
		})

		it("fills in declared levels for custom model info without a capability", () => {
			const customInfo: ModelInfo = {
				contextWindow: 32_768,
				maxTokens: 8_192,
				supportsPromptCache: false,
			}
			const handler = new OpenAiHandler(
				makeApiHandlerOptions({
					openAiApiKey: "test-api-key",
					openAiModelId: "local-model",
					openAiCustomModelInfo: customInfo,
					supportedReasoningEfforts: DECLARED,
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(DECLARED)
			// The input object is not mutated.
			expect(customInfo.supportsReasoningEffort).toBeUndefined()
		})

		it("keeps the model's own capability (registry wins)", () => {
			const customInfo: ModelInfo = {
				contextWindow: 32_768,
				maxTokens: 8_192,
				supportsPromptCache: false,
				supportsReasoningEffort: ["disable", "low", "high"],
			}
			const handler = new OpenAiHandler(
				makeApiHandlerOptions({
					openAiApiKey: "test-api-key",
					openAiModelId: "local-model",
					openAiCustomModelInfo: customInfo,
					supportedReasoningEfforts: DECLARED,
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(["disable", "low", "high"])
		})

		it("leaves the capability absent without a declaration", () => {
			const handler = new OpenAiHandler(
				makeApiHandlerOptions({
					openAiApiKey: "test-api-key",
					openAiModelId: "qwen3-32b",
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toBeUndefined()
		})
	})

	describe("LmStudioHandler", () => {
		it("fills in declared levels when the model falls back to sane defaults", () => {
			const handler = new LmStudioHandler(
				makeApiHandlerOptions({
					lmStudioBaseUrl: "http://localhost:1234",
					lmStudioModelId: "qwen3-32b",
					supportedReasoningEfforts: DECLARED,
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(DECLARED)
		})
	})

	describe("NativeOllamaHandler", () => {
		it("fills in declared levels for fetched models without a capability", async () => {
			const handler = new NativeOllamaHandler(
				makeApiHandlerOptions({
					ollamaModelId: "qwen3:32b",
					supportedReasoningEfforts: DECLARED,
				}),
			)
			vi.mocked(getOllamaModels).mockResolvedValueOnce({
				"qwen3:32b": {
					maxTokens: 8_192,
					contextWindow: 32_768,
					supportsImages: false,
					supportsPromptCache: false,
					inputPrice: 0,
					outputPrice: 0,
				},
			})
			const result = await handler.fetchModel()
			expect(result.info.supportsReasoningEffort).toEqual(DECLARED)
		})

		it("keeps the model's own capability (registry wins)", async () => {
			const handler = new NativeOllamaHandler(
				makeApiHandlerOptions({
					ollamaModelId: "qwen3:32b",
					supportedReasoningEfforts: DECLARED,
				}),
			)
			vi.mocked(getOllamaModels).mockResolvedValueOnce({
				"qwen3:32b": {
					maxTokens: 8_192,
					contextWindow: 32_768,
					supportsImages: false,
					supportsPromptCache: false,
					supportsReasoningEffort: true,
				},
			})
			const result = await handler.fetchModel()
			expect(result.info.supportsReasoningEffort).toBe(true)
		})
	})

	describe("BaseOpenAiCompatibleProvider subclasses", () => {
		it("fills in declared levels where the model record has no capability", () => {
			const handler = new TestOpenAiCompatibleProvider({ supportedReasoningEfforts: DECLARED })
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(DECLARED)
		})

		it("leaves the capability absent without a declaration", () => {
			const handler = new TestOpenAiCompatibleProvider({})
			expect(handler.getModel().info.supportsReasoningEffort).toBeUndefined()
		})
	})

	describe("RouterProvider subclasses (LiteLLM)", () => {
		it("fills in declared levels for the default model fallback", () => {
			const handler = new LiteLLMHandler(
				makeApiHandlerOptions({
					litellmBaseUrl: "http://localhost:4000",
					litellmModelId: "custom/model",
					supportedReasoningEfforts: DECLARED,
				}),
			)
			// No catalog fetched yet: getModel() falls back to defaultModelInfo.
			expect(handler.getModel().info.supportsReasoningEffort).toEqual(DECLARED)
		})

		it("leaves the capability absent without a declaration", () => {
			const handler = new LiteLLMHandler(
				makeApiHandlerOptions({
					litellmBaseUrl: "http://localhost:4000",
					litellmModelId: "custom/model",
				}),
			)
			expect(handler.getModel().info.supportsReasoningEffort).toBeUndefined()
		})
	})
})
