// npx vitest run api/providers/__tests__/fireworks.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type ModelInfo, fireworksDefaultModelId, providerIdentifiers } from "@roo-code/types"

import { FireworksHandler } from "../fireworks"
import { getModels, getModelsFromCache } from "../fetchers/modelCache"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

const mockCreate = vi.fn()

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn(async () => ({})),
	getModelsFromCache: vi.fn(() => undefined),
}))

const GLM_ID = "accounts/fireworks/models/glm-5p3"

const pricedGlm: ModelInfo = {
	maxTokens: 16384,
	contextWindow: 1_048_576,
	supportsImages: false,
	supportsPromptCache: true,
	inputPrice: 1.4,
	outputPrice: 4.4,
	cacheReadsPrice: 0.26,
}

const unpricedModel: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 8192,
	supportsImages: true,
	supportsPromptCache: false,
}

const usageStream = (usage: Record<string, unknown>) =>
	asyncStreamFrom([
		{ choices: [{ delta: { content: "hi" }, index: 0 }], usage: null },
		{ choices: [{ delta: {}, index: 0 }], usage },
	])

describe("FireworksHandler", () => {
	let handler: FireworksHandler

	beforeEach(() => {
		clearAllMocks()
		vi.mocked(getModelsFromCache).mockReturnValue(undefined)
		vi.mocked(getModels).mockResolvedValue({})
		mockCreate.mockImplementation(async () =>
			usageStream({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
		)
		handler = new FireworksHandler({ fireworksApiKey: "test-key" })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("should use the correct Fireworks base URL", () => {
		new FireworksHandler({ fireworksApiKey: "test-fireworks-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.fireworks.ai/inference/v1" }),
		)
	})

	it("should use the provided API key", () => {
		const fireworksApiKey = "test-fireworks-api-key"
		new FireworksHandler({ fireworksApiKey })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: fireworksApiKey }))
	})

	it("should throw error when API key is not provided", () => {
		expect(() => new FireworksHandler({})).toThrow("API key is required")
	})

	it("should read model info from the key-scoped model cache", () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ [GLM_ID]: pricedGlm })

		const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "fw-key" })
		const model = handlerWithModel.getModel()

		expect(getModelsFromCache).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.fireworks, apiKey: "fw-key" },
			handlerWithModel,
		)
		expect(model).toEqual({ id: GLM_ID, info: pricedGlm })
	})

	it("should use the default model id when none is configured", () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ [fireworksDefaultModelId]: pricedGlm })

		const model = handler.getModel()

		expect(model.id).toBe(fireworksDefaultModelId)
		expect(model.info).toEqual(pricedGlm)
	})

	describe("ensureModelFetched", () => {
		it("loads the keyed catalog when the cache does not describe the selection", async () => {
			vi.mocked(getModels).mockResolvedValue({ [GLM_ID]: pricedGlm })
			const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "fw-key" })

			await handlerWithModel.ensureModelFetched()

			expect(getModels).toHaveBeenCalledWith(
				{ provider: providerIdentifiers.fireworks, apiKey: "fw-key" },
				handlerWithModel,
			)
		})

		it("skips the network when the cache already describes the selection", async () => {
			vi.mocked(getModelsFromCache).mockReturnValue({ [GLM_ID]: pricedGlm })
			const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "fw-key" })

			await handlerWithModel.ensureModelFetched()

			expect(getModels).not.toHaveBeenCalled()
		})

		it("rejects with the caller's abort reason when already aborted", async () => {
			const controller = new AbortController()
			controller.abort(new Error("caller canceled"))

			await expect(handler.ensureModelFetched(controller.signal)).rejects.toThrow("caller canceled")
			expect(getModels).not.toHaveBeenCalled()
		})

		it("detaches the waiter when the signal aborts during the fetch", async () => {
			vi.mocked(getModels).mockReturnValue(new Promise(() => {}))
			const controller = new AbortController()

			const pending = handler.ensureModelFetched(controller.signal)
			controller.abort()

			await expect(pending).rejects.toThrow("The Fireworks request was aborted")
		})
	})

	it("should keep the configured id with unpriced defaults when the model is not cached", () => {
		const model = new FireworksHandler({
			apiModelId: "accounts/fireworks/models/not-cached",
			fireworksApiKey: "k",
		}).getModel()

		expect(model.id).toBe("accounts/fireworks/models/not-cached")
		expect(model.info.maxTokens).toBeUndefined()
		expect(model.info.supportsImages).toBe(false)
		expect(model.info.inputPrice).toBeUndefined()
		expect(model.info.outputPrice).toBeUndefined()
	})

	it("should omit max_tokens for an uncached model because Fireworks rejects -1", async () => {
		const handlerWithCustomModel = new FireworksHandler({
			apiModelId: "accounts/fireworks/models/deepseek-v4p1-flash",
			fireworksApiKey: "test-fireworks-api-key",
		})

		await collectStream(handlerWithCustomModel.createMessage("system prompt", []))

		expect(mockCreate.mock.calls[0][0].model).toBe("accounts/fireworks/models/deepseek-v4p1-flash")
		expect(mockCreate.mock.calls[0][0].max_tokens).toBeUndefined()
	})

	it("should pass the model, capped max_tokens and default temperature for a cached model", async () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ [GLM_ID]: pricedGlm })
		const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "k" })

		const systemPrompt = "Test system prompt for Fireworks"
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message for Fireworks" }]
		await collectStream(handlerWithModel.createMessage(systemPrompt, messages))

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: GLM_ID,
				max_tokens: 16384,
				temperature: 0.5,
				messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
				stream: true,
				stream_options: { include_usage: true },
			}),
			undefined,
		)
	})

	it("should use user-specified temperature over the provider default", async () => {
		const handlerWithTemp = new FireworksHandler({ fireworksApiKey: "k", modelTemperature: 0.7 })

		await collectStream(handlerWithTemp.createMessage("system", []))

		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }), undefined)
	})

	it("should compute cost from API pricing, including cached input", async () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ [GLM_ID]: pricedGlm })
		mockCreate.mockImplementationOnce(async () =>
			usageStream({
				prompt_tokens: 1_000_000,
				completion_tokens: 1_000_000,
				prompt_tokens_details: { cached_tokens: 500_000 },
			}),
		)
		const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "k" })

		const chunks = await collectStream(handlerWithModel.createMessage("system", []))
		const usage = chunks.find((chunk) => chunk.type === "usage")

		// 500k uncached @ $1.40 + 500k cached @ $0.26 + 1M output @ $4.40
		expect(usage).toMatchObject({ type: "usage", cacheReadTokens: 500_000 })
		expect(usage?.type === "usage" && usage.totalCost).toBeCloseTo(0.7 + 0.13 + 4.4, 6)
	})

	it("should not attribute a cost to models without API pricing", async () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ [GLM_ID]: unpricedModel })
		const handlerWithModel = new FireworksHandler({ apiModelId: GLM_ID, fireworksApiKey: "k" })

		const chunks = await collectStream(handlerWithModel.createMessage("system", []))
		const usage = chunks.find((chunk) => chunk.type === "usage")

		expect(usage).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 })
	})

	it("completePrompt method should return text from Fireworks API", async () => {
		const expectedResponse = "This is a test response from Fireworks"
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: expectedResponse } }] })
		const result = await handler.completePrompt("test prompt")
		expect(result).toBe(expectedResponse)
	})

	it("should handle errors in completePrompt", async () => {
		const errorMessage = "Fireworks API error"
		mockCreate.mockRejectedValueOnce(new Error(errorMessage))
		await expect(handler.completePrompt("test prompt")).rejects.toThrow(
			`Fireworks completion error: ${errorMessage}`,
		)
	})

	it("should handle empty response in completePrompt", async () => {
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
		const result = await handler.completePrompt("test prompt")
		expect(result).toBe("")
	})

	it("should handle missing choices in completePrompt", async () => {
		mockCreate.mockResolvedValueOnce({ choices: [] })
		const result = await handler.completePrompt("test prompt")
		expect(result).toBe("")
	})

	it("createMessage should handle stream with multiple chunks", async () => {
		mockCreate.mockImplementationOnce(async () =>
			asyncStreamFrom([
				{ choices: [{ delta: { content: "Hello" }, index: 0 }], usage: null },
				{ choices: [{ delta: { content: " world" }, index: 0 }], usage: null },
				{
					choices: [{ delta: {}, index: 0 }],
					usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
				},
			]),
		)

		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
		const chunks = await collectStream(handler.createMessage("You are a helpful assistant.", messages))

		expect(chunks[0]).toEqual({ type: "text", text: "Hello" })
		expect(chunks[1]).toEqual({ type: "text", text: " world" })
		expect(chunks[2]).toMatchObject({ type: "usage", inputTokens: 5, outputTokens: 10 })
	})
})
