// npx vitest run src/api/providers/__tests__/zai.spec.ts

import OpenAI, { APIUserAbortError } from "openai"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	type InternationalZAiModelId,
	type MainlandZAiModelId,
	internationalZAiDefaultModelId,
	mainlandZAiDefaultModelId,
	internationalZAiModels,
	mainlandZAiModels,
	ZAI_DEFAULT_TEMPERATURE,
	getZAiModels,
} from "@roo-code/types"

import { ZAiHandler } from "../zai"
import { asyncStreamFrom } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { captureError } from "../../../test-utils/errors"

vitest.mock("openai", () => {
	const createMock = vitest.fn()
	return {
		// Named export consumed by the provider for abort-error normalization
		APIUserAbortError: class extends Error {},
		default: vitest.fn(function () {
			return { chat: { completions: { create: createMock } } }
		}),
	}
})

describe("ZAiHandler", () => {
	let handler: ZAiHandler
	let mockCreate: any

	beforeEach(() => {
		clearAllMocks()
		mockCreate = (OpenAI as unknown as any)().chat.completions.create
	})

	describe("International Z AI", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_coding" })
		})

		it("should use the correct international Z AI base URL", () => {
			new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_coding" })
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.z.ai/api/coding/paas/v4",
				}),
			)
		})

		it("should use the provided API key for international", () => {
			const zaiApiKey = "test-zai-api-key"
			new ZAiHandler({ zaiApiKey, zaiApiLine: "international_coding" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: zaiApiKey }))
		})

		it("should return international default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(internationalZAiDefaultModelId)
			expect(model.info).toEqual(internationalZAiModels[internationalZAiDefaultModelId])
		})

		it("should return specified international model when valid model is provided", () => {
			const testModelId: InternationalZAiModelId = "glm-4.5-air"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
		})

		it("should return GLM-4.6 international model with correct configuration", () => {
			const testModelId: InternationalZAiModelId = "glm-4.6"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(200_000)
		})

		it("should return GLM-4.7 international model with thinking support", () => {
			const testModelId: InternationalZAiModelId = "glm-4.7"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(200_000)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
		})

		it("should return GLM-5.1 international model with thinking support and 128k max output", () => {
			const testModelId: InternationalZAiModelId = "glm-5.1"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(200_000)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
			expect(model.info.supportsImages).toBe(false)
		})

		it("should return GLM-5.2 international model with High/Max effort tiers and 1M context", () => {
			const testModelId: InternationalZAiModelId = "glm-5.2"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(1_000_000)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "high", "max"])
			expect(model.info.reasoningEffort).toBe("high")
			expect(model.info.preserveReasoning).toBe(true)
			expect(model.info.supportsMaxTokens).toBe(true)
			expect(model.info.inputPrice).toBe(1.4)
			expect(model.info.outputPrice).toBe(4.4)
			expect(model.info.cacheReadsPrice).toBe(0.26)
		})

		it("should expose GLM-5.3 for the international Coding Plan with official pricing", () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe("glm-5.3")
			expect(model.info).toMatchObject({
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				supportsImages: false,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				supportsReasoningEffort: ["low", "high", "max"],
				requiredReasoningEffort: true,
				reasoningEffort: "max",
				preserveReasoning: true,
				defaultTemperature: 1,
			})
			expect(model.info.inputPrice).toBe(1.4)
			expect(model.info.outputPrice).toBe(4.4)
			expect(model.info.cacheReadsPrice).toBe(0.26)
		})

		it("should expose multimodal GLM-5.3-Flash for the international Coding Plan", () => {
			const model = new ZAiHandler({
				apiModelId: "glm-5.3-flash",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			}).getModel()

			expect(model.id).toBe("glm-5.3-flash")
			expect(model.info).toMatchObject({
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				supportsImages: true,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				supportsReasoningEffort: ["low", "high", "max"],
				requiredReasoningEffort: true,
				reasoningEffort: "max",
				preserveReasoning: true,
				defaultTemperature: 1,
				inputPrice: 0.15,
				outputPrice: 0.5,
				cacheReadsPrice: 0.03,
			})
		})

		it("should return GLM-5-Turbo international model with thinking support", () => {
			const testModelId: InternationalZAiModelId = "glm-5-turbo"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(202_752)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
		})

		it("should return GLM-4.5v international model with vision support", () => {
			const testModelId: InternationalZAiModelId = "glm-4.5v"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.maxTokens).toBe(16_384)
			expect(model.info.contextWindow).toBe(131_072)
		})
	})

	describe("China Z AI", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "china_coding" })
		})

		it("should use the correct China Z AI base URL", () => {
			new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "china_coding" })
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({ baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" }),
			)
		})

		it("should use the provided API key for China", () => {
			const zaiApiKey = "test-zai-api-key"
			new ZAiHandler({ zaiApiKey, zaiApiLine: "china_coding" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: zaiApiKey }))
		})

		it("should return China default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mainlandZAiDefaultModelId)
			expect(model.info).toEqual(mainlandZAiModels[mainlandZAiDefaultModelId])
		})

		it("should return specified China model when valid model is provided", () => {
			const testModelId: MainlandZAiModelId = "glm-4.5-air"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
		})

		it("should return GLM-4.6 China model with correct configuration", () => {
			const testModelId: MainlandZAiModelId = "glm-4.6"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
		})

		it("should return GLM-4.5v China model with vision support", () => {
			const testModelId: MainlandZAiModelId = "glm-4.5v"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.maxTokens).toBe(16_384)
			expect(model.info.contextWindow).toBe(131_072)
		})

		it("should return GLM-5.1 China model with thinking support and 128k max output", () => {
			const testModelId: MainlandZAiModelId = "glm-5.1"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
			expect(model.info.supportsImages).toBe(false)
		})

		it("should return GLM-5.2 China model with High/Max effort tiers and 1M context", () => {
			const testModelId: MainlandZAiModelId = "glm-5.2"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(1_000_000)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "high", "max"])
			expect(model.info.reasoningEffort).toBe("high")
			expect(model.info.preserveReasoning).toBe(true)
			expect(model.info.supportsMaxTokens).toBe(true)
			expect(model.info.inputPrice).toBe(0.68)
			expect(model.info.outputPrice).toBe(2.28)
			expect(model.info.cacheReadsPrice).toBe(0.13)
		})

		it("should expose GLM-5.3 for the China Coding Plan", () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe("glm-5.3")
			expect(model.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(model.info.requiredReasoningEffort).toBe(true)
			expect(model.info.reasoningEffort).toBe("max")
			expect(model.info.inputPrice).toBe(0.68)
			expect(model.info.outputPrice).toBe(2.28)
			expect(model.info.cacheReadsPrice).toBe(0.13)
		})

		it("should expose GLM-5.3-Flash for the China Coding Plan", () => {
			const model = new ZAiHandler({
				apiModelId: "glm-5.3-flash",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			}).getModel()

			expect(model.id).toBe("glm-5.3-flash")
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.supportsReasoningEffort).toEqual(["low", "high", "max"])
			expect(model.info.requiredReasoningEffort).toBe(true)
			expect(model.info.inputPrice).toBe(0.075)
			expect(model.info.outputPrice).toBe(0.25)
			expect(model.info.cacheReadsPrice).toBe(0.015)
		})

		it("should return GLM-4.7 China model with thinking support", () => {
			const testModelId: MainlandZAiModelId = "glm-4.7"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(204_800)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
		})

		it("should return GLM-5-Turbo China model with thinking support", () => {
			const testModelId: MainlandZAiModelId = "glm-5-turbo"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_coding",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
			expect(model.info.contextWindow).toBe(202_752)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.supportsReasoningEffort).toEqual(["disable", "medium"])
			expect(model.info.reasoningEffort).toBe("medium")
			expect(model.info.preserveReasoning).toBe(true)
		})
	})

	describe("International API", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_api" })
		})

		it("should use the correct international API base URL", () => {
			new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_api" })
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.z.ai/api/paas/v4",
				}),
			)
		})

		it("should use the provided API key for international API", () => {
			const zaiApiKey = "test-zai-api-key"
			new ZAiHandler({ zaiApiKey, zaiApiLine: "international_api" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: zaiApiKey }))
		})

		it("should return international default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(internationalZAiDefaultModelId)
			expect(model.info).toEqual(internationalZAiModels[internationalZAiDefaultModelId])
		})

		it("should return specified international model when valid model is provided", () => {
			const testModelId: InternationalZAiModelId = "glm-4.5-air"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_api",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(internationalZAiModels[testModelId])
		})

		it("should expose GLM-5.3 on the international API", () => {
			expect(getZAiModels("international_api")).toHaveProperty("glm-5.3")
			expect(getZAiModels("international_api")).toHaveProperty("glm-5.3-flash")
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_api",
			})
			expect(handlerWithModel.getModel().id).toBe("glm-5.3")
		})
	})

	describe("China API", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "china_api" })
		})

		it("should use the correct China API base URL", () => {
			new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "china_api" })
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://open.bigmodel.cn/api/paas/v4",
				}),
			)
		})

		it("should use the provided API key for China API", () => {
			const zaiApiKey = "test-zai-api-key"
			new ZAiHandler({ zaiApiKey, zaiApiLine: "china_api" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: zaiApiKey }))
		})

		it("should return China default model when no model is specified", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mainlandZAiDefaultModelId)
			expect(model.info).toEqual(mainlandZAiModels[mainlandZAiDefaultModelId])
		})

		it("should return specified China model when valid model is provided", () => {
			const testModelId: MainlandZAiModelId = "glm-4.5-air"
			const handlerWithModel = new ZAiHandler({
				apiModelId: testModelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "china_api",
			})
			const model = handlerWithModel.getModel()
			expect(model.id).toBe(testModelId)
			expect(model.info).toEqual(mainlandZAiModels[testModelId])
		})

		it("should not expose Coding Plan-only models", () => {
			expect(getZAiModels("china_api")).not.toHaveProperty("glm-5.3")
			expect(getZAiModels("china_api")).not.toHaveProperty("glm-5.3-flash")
		})
	})

	describe("Default behavior", () => {
		it("should default to international when no zaiApiLine is specified", () => {
			const handlerDefault = new ZAiHandler({ zaiApiKey: "test-zai-api-key" })
			expect(OpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					baseURL: "https://api.z.ai/api/coding/paas/v4",
				}),
			)

			const model = handlerDefault.getModel()
			expect(model.id).toBe(internationalZAiDefaultModelId)
			expect(model.info).toEqual(internationalZAiModels[internationalZAiDefaultModelId])
		})

		it("should use 'not-provided' as default API key when none is specified", () => {
			new ZAiHandler({ zaiApiLine: "international_coding" })
			expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "not-provided" }))
		})
	})

	describe("API Methods", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_coding" })
		})

		it("completePrompt method should return text from Z AI API", async () => {
			const expectedResponse = "This is a test response from Z AI"
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: expectedResponse } }] })
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe(expectedResponse)
		})

		it("should handle errors in completePrompt", async () => {
			const errorMessage = "Z AI API error"
			mockCreate.mockRejectedValueOnce(new Error(errorMessage))
			await expect(handler.completePrompt("test prompt")).rejects.toThrow(
				`Z.ai completion error: ${errorMessage}`,
			)
		})

		it("createMessage should yield text content from stream", async () => {
			const testContent = "This is test content from Z AI stream"

			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: testContent } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toEqual({ type: "text", text: testContent })
		})

		it("createMessage should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20 },
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 20 })
		})

		it("createMessage should pass correct parameters to Z AI client", async () => {
			const modelId: InternationalZAiModelId = "glm-4.5"
			const modelInfo = internationalZAiModels[modelId]
			const handlerWithModel = new ZAiHandler({
				apiModelId: modelId,
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const systemPrompt = "Test system prompt for Z AI"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message for Z AI" }]

			const messageGenerator = handlerWithModel.createMessage(systemPrompt, messages)
			await messageGenerator.next()

			// Centralized 20% cap should apply to OpenAI-compatible providers like Z AI
			const expectedMaxTokens = Math.min(modelInfo.maxTokens, Math.ceil(modelInfo.contextWindow * 0.2))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: modelId,
					max_tokens: expectedMaxTokens,
					temperature: ZAI_DEFAULT_TEMPERATURE,
					messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
					stream: true,
					stream_options: { include_usage: true },
				}),
				undefined,
			)
		})
	})

	describe("abort signal wiring", () => {
		beforeEach(() => {
			handler = new ZAiHandler({ zaiApiKey: "test-zai-api-key", zaiApiLine: "international_coding" })
		})

		it("createMessage should pass the abort signal on the GLM thinking path", async () => {
			const thinkingHandler = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const gen = thinkingHandler.createMessage("system prompt", [], {
				taskId: "test-task",
				abortSignal: controller.signal,
			})
			await gen.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "glm-4.7", thinking: { type: "enabled" } }),
				{ signal: controller.signal },
			)
		})

		it("createMessage should pass the abort signal for non-thinking models via the base path", async () => {
			const plainHandler = new ZAiHandler({
				apiModelId: "glm-4.6",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const gen = plainHandler.createMessage("system prompt", [], {
				taskId: "test-task",
				abortSignal: controller.signal,
			})
			await gen.next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "glm-4.6" }), {
				signal: controller.signal,
			})
		})

		it("createMessage should reject before any request when the abort signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(async () => {
				for await (const _ of handler.createMessage("system prompt", [], {
					taskId: "test-task",
					abortSignal: controller.signal,
				})) {
					// consume
				}
			}).rejects.toMatchObject({ name: "AbortError", message: "This operation was aborted" })
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("createMessage should normalize the SDK APIUserAbortError on the thinking path", async () => {
			const thinkingHandler = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			mockCreate.mockImplementationOnce(() => {
				throw new APIUserAbortError()
			})

			const result = await captureError(
				(async () => {
					for await (const _ of thinkingHandler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("Z.ai request aborted")
			expect(result.message.endsWith("aborted")).toBe(true)
		})

		it("createMessage should normalize an abort error raised during stream iteration on the thinking path", async () => {
			const thinkingHandler = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			mockCreate.mockImplementationOnce(() =>
				(async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw new APIUserAbortError()
				})(),
			)

			const result = await captureError(
				(async () => {
					for await (const _ of thinkingHandler.createMessage("system prompt", [])) {
						// consume
					}
				})(),
			)

			// The thinking path inherits stream iteration from the base provider; a
			// mid-stream abort must normalize to the Task.ts contract shape.
			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("Z.ai request aborted")
			expect(result.message.endsWith("aborted")).toBe(true)
		})

		it("completePrompt should pass the abort signal through to the client", async () => {
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const result = await handler.completePrompt("test prompt", { abortSignal: controller.signal })

			expect(result).toBe("response")
			expect(mockCreate).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
		})

		it("completePrompt should reject before any request when the signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "This operation was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("completePrompt should normalize the SDK APIUserAbortError", async () => {
			mockCreate.mockImplementationOnce(() => {
				throw new APIUserAbortError()
			})

			const result = await captureError(handler.completePrompt("test prompt"))

			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("Z.ai request aborted")
		})

		it("glm-5.3 completePrompt should merge the abort signal and timeoutMs on the thinking path", async () => {
			const h53 = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const result = await h53.completePrompt("prompt", { abortSignal: controller.signal, timeoutMs: 5000 })

			expect(result).toBe("response")
			const requestCall = mockCreate.mock.calls.at(-1)
			expect(requestCall?.[0]).toEqual(
				expect.objectContaining({ model: "glm-5.3", thinking: { type: "enabled", clear_thinking: false } }),
			)
			const requestOptions = requestCall?.[1]
			expect(requestOptions?.signal).toBeInstanceOf(AbortSignal)
			expect(requestOptions?.signal.aborted).toBe(false)
			// A positive timeoutMs must be forwarded as the per-request SDK timeout.
			expect(requestOptions?.timeout).toBe(5000)
			// A timeout-only merged signal would still pass the assertions above;
			// aborting the caller's controller proves caller cancellation survives.
			controller.abort()
			expect(requestOptions?.signal.aborted).toBe(true)
		})

		it("glm-5.3 completePrompt should normalize the SDK APIUserAbortError", async () => {
			const h53 = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})
			mockCreate.mockImplementationOnce(() => {
				throw new APIUserAbortError()
			})

			const result = await captureError(h53.completePrompt("prompt"))

			expect(result.name).toBe("AbortError")
			expect(result.message).toBe("Z.ai request aborted")
		})
	})

	describe("GLM-4.7 Thinking Mode", () => {
		it("should cap GLM-5.1 max_tokens to 20% of context window by default", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.1",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					max_tokens: 40_000,
				}),
				undefined,
			)
		})

		it("should advertise supportsMaxTokens for configurable GLM models", () => {
			expect(internationalZAiModels["glm-5.1"].supportsMaxTokens).toBe(true)
			expect(internationalZAiModels["glm-5-turbo"].supportsMaxTokens).toBe(true)
			expect(mainlandZAiModels["glm-5.1"].supportsMaxTokens).toBe(true)
			expect(mainlandZAiModels["glm-5-turbo"].supportsMaxTokens).toBe(true)
			// Models without a configurable output budget should not advertise the flag.
			expect((internationalZAiModels["glm-4.7"] as { supportsMaxTokens?: boolean }).supportsMaxTokens).toBe(
				undefined,
			)
		})

		it("should honor an explicit modelMaxTokens override instead of the 20% clamp", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.1",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				modelMaxTokens: 100_000,
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.1",
					max_tokens: 100_000,
				}),
				undefined,
			)
		})

		it("should enable thinking by default for GLM-4.7 (default reasoningEffort is medium)", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				// No reasoningEffort setting - should use model default (medium)
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			// For GLM-4.7 with default reasoning (medium), thinking should be enabled
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-4.7",
					thinking: { type: "enabled" },
				}),
				undefined,
			)
		})

		it("should send reasoning_effort:high by default for GLM-5.2 (model default)", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.2",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				// No reasoningEffort setting - should use model default (high)
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.2",
					thinking: { type: "enabled" },
					reasoning_effort: "high",
				}),
				undefined,
			)
		})

		it("should send reasoning_effort:max for GLM-5.2 when reasoningEffort is set to max", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.2",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				reasoningEffort: "max",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.2",
					thinking: { type: "enabled" },
					reasoning_effort: "max",
				}),
				undefined,
			)
		})

		it("should use the official GLM-5.3 thinking and sampling defaults", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				reasoningEffort: "disable",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.3",
					thinking: { type: "enabled", clear_thinking: false },
					reasoning_effort: "max",
					temperature: 1,
				}),
				undefined,
			)
		})

		it("should use the official GLM-5.3-Flash thinking and sampling defaults", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3-flash",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				reasoningEffort: "disable",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.3-flash",
					thinking: { type: "enabled", clear_thinking: false },
					reasoning_effort: "max",
					temperature: 1,
				}),
				undefined,
			)
		})

		it("should keep GLM-5.3 reasoning enabled when the master reasoning setting is disabled", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				enableReasoningEffort: false,
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.3",
					thinking: { type: "enabled", clear_thinking: false },
					reasoning_effort: "max",
				}),
				undefined,
			)
		})

		it("should use the official GLM-5.3 parameters for completePrompt", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_api",
				reasoningEffort: "low",
			})

			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await expect(handlerWithModel.completePrompt("prompt")).resolves.toBe("response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "glm-5.3",
					messages: [{ role: "user", content: "prompt" }],
					temperature: 1,
					thinking: { type: "enabled", clear_thinking: false },
					reasoning_effort: "low",
				},
				undefined,
			)
		})

		it("should use the official GLM-5.3-Flash parameters for completePrompt", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.3-flash",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_api",
				reasoningEffort: "low",
			})

			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await expect(handlerWithModel.completePrompt("prompt")).resolves.toBe("response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "glm-5.3-flash",
					messages: [{ role: "user", content: "prompt" }],
					temperature: 1,
					thinking: { type: "enabled", clear_thinking: false },
					reasoning_effort: "low",
				},
				undefined,
			)
		})

		it("should omit reasoning_effort for GLM-5.2 when reasoningEffort is set to disable", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.2",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				reasoningEffort: "disable",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.thinking).toEqual({ type: "disabled" })
			expect(callArgs.reasoning_effort).toBeUndefined()
		})

		it("should fall back to the model default effort when a persisted value is unsupported", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5.2",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				reasoningEffort: "medium",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.2",
					thinking: { type: "enabled" },
					reasoning_effort: "high",
				}),
				undefined,
			)
		})

		it("should disable thinking for GLM-4.7 when reasoningEffort is set to disable", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				enableReasoningEffort: true,
				reasoningEffort: "disable",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			// For GLM-4.7 with reasoning disabled, thinking should be disabled
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-4.7",
					thinking: { type: "disabled" },
				}),
				undefined,
			)
		})

		it("should enable thinking for GLM-4.7 when reasoningEffort is set to medium", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-4.7",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				enableReasoningEffort: true,
				reasoningEffort: "medium",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			// For GLM-4.7 with reasoning set to medium, thinking should be enabled
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-4.7",
					thinking: { type: "enabled" },
				}),
				undefined,
			)
		})

		it("should NOT add thinking parameter for non-thinking models like GLM-4.6", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-4.6",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			// For GLM-4.6 (no thinking support), thinking parameter should not be present
			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.thinking).toBeUndefined()
		})

		it("should enable thinking by default for GLM-5-Turbo", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5-turbo",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-turbo",
					thinking: { type: "enabled" },
				}),
				undefined,
			)
		})

		it("should disable thinking for GLM-5-Turbo when reasoningEffort is set to disable", async () => {
			const handlerWithModel = new ZAiHandler({
				apiModelId: "glm-5-turbo",
				zaiApiKey: "test-zai-api-key",
				zaiApiLine: "international_coding",
				enableReasoningEffort: true,
				reasoningEffort: "disable",
			})

			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

			const messageGenerator = handlerWithModel.createMessage("system prompt", [])
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5-turbo",
					thinking: { type: "disabled" },
				}),
				undefined,
			)
		})
	})
})
