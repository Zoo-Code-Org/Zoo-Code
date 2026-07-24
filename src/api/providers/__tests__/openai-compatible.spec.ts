// npx vitest run api/providers/__tests__/openai-compatible.spec.ts

import type { ModelInfo } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../shared/api"

// Mock @ai-sdk/openai-compatible
vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn().mockReturnValue(vi.fn()),
}))

// Mock ai
vi.mock("ai", () => ({
	streamText: vi.fn(),
	generateText: vi.fn(),
}))

vi.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vi.fn().mockReturnValue(300_000),
}))

import { OpenAICompatibleHandler } from "../openai-compatible"
import type { OpenAICompatibleConfig } from "../openai-compatible"

/**
 * Concrete subclass that exposes the protected processUsageMetrics for direct testing.
 */
class TestableOpenAICompatibleHandler extends OpenAICompatibleHandler {
	private _modelInfo: ModelInfo

	constructor(modelInfo: ModelInfo) {
		const options: ApiHandlerOptions = {
			openAiApiKey: "test-api-key",
		}
		const config: OpenAICompatibleConfig = {
			providerName: "test-provider",
			baseURL: "https://test.api.com/v1",
			apiKey: "test-api-key",
			modelId: "test-model",
			modelInfo,
		}
		super(options, config)
		this._modelInfo = modelInfo
	}

	override getModel() {
		return {
			id: this.config.modelId,
			info: this._modelInfo,
		}
	}

	/** Expose protected processUsageMetrics for testing. */
	public testProcessUsageMetrics(
		usage: Parameters<OpenAICompatibleHandler["processUsageMetrics"]>[0],
	) {
		return this.processUsageMetrics(usage)
	}

	// Stubs for abstract methods inherited from BaseProvider
	override async *createMessage() {
		yield { type: "text" as const, text: "" }
	}

	override async completePrompt() {
		return ""
	}
}

describe("OpenAICompatibleHandler", () => {
	describe("processUsageMetrics", () => {
		it("should return correct totalCost when modelInfo has pricing", () => {
			const modelInfo: ModelInfo = {
				contextWindow: 128_000,
				supportsPromptCache: false,
				inputPrice: 3.0,
				outputPrice: 15.0,
			}
			const handler = new TestableOpenAICompatibleHandler(modelInfo)

			const result = handler.testProcessUsageMetrics({
				inputTokens: 1000,
				outputTokens: 500,
			})

			expect(result.type).toBe("usage")
			expect(result.inputTokens).toBe(1000)
			expect(result.outputTokens).toBe(500)
			expect(typeof result.totalCost).toBe("number")
			expect(result.totalCost).toBeGreaterThan(0)
		})

		it("should return totalCost of 0 when modelInfo has no pricing", () => {
			const modelInfo: ModelInfo = {
				contextWindow: 128_000,
				supportsPromptCache: false,
			}
			const handler = new TestableOpenAICompatibleHandler(modelInfo)

			const result = handler.testProcessUsageMetrics({
				inputTokens: 1000,
				outputTokens: 500,
			})

			expect(result.type).toBe("usage")
			expect(result.totalCost).toBe(0)
		})

		it("should factor cachedInputTokens into cost calculation", () => {
			const modelInfo: ModelInfo = {
				contextWindow: 128_000,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheReadsPrice: 0.3,
			}
			const handler = new TestableOpenAICompatibleHandler(modelInfo)

			const result = handler.testProcessUsageMetrics({
				inputTokens: 1000,
				outputTokens: 500,
				details: {
					cachedInputTokens: 200,
				},
			})

			expect(result.type).toBe("usage")
			expect(result.cacheReadTokens).toBe(200)
			expect(typeof result.totalCost).toBe("number")
			expect(result.totalCost).toBeGreaterThan(0)
		})

		it("should include reasoningTokens when provided in usage details", () => {
			const modelInfo: ModelInfo = {
				contextWindow: 128_000,
				supportsPromptCache: false,
				inputPrice: 3.0,
				outputPrice: 15.0,
			}
			const handler = new TestableOpenAICompatibleHandler(modelInfo)

			const result = handler.testProcessUsageMetrics({
				inputTokens: 500,
				outputTokens: 300,
				details: {
					reasoningTokens: 100,
				},
			})

			expect(result.reasoningTokens).toBe(100)
			expect(result.inputTokens).toBe(500)
			expect(result.outputTokens).toBe(300)
		})

		it("should default to 0 for missing token counts", () => {
			const modelInfo: ModelInfo = {
				contextWindow: 128_000,
				supportsPromptCache: false,
				inputPrice: 3.0,
				outputPrice: 15.0,
			}
			const handler = new TestableOpenAICompatibleHandler(modelInfo)

			const result = handler.testProcessUsageMetrics({})

			expect(result.inputTokens).toBe(0)
			expect(result.outputTokens).toBe(0)
			expect(result.totalCost).toBe(0)
		})
	})
})
