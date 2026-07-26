// npx vitest run api/providers/__tests__/friendli.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { friendliDefaultModelId, friendliModels } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { getModelMaxOutputTokens } from "../../../shared/api"
import { FriendliHandler } from "../friendli"

// Create mock functions
const mockCreate = vi.fn()

// Mock OpenAI module
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

describe("FriendliHandler", () => {
	let handler: FriendliHandler

	beforeEach(() => {
		vi.clearAllMocks()
		// Set up default mock implementation
		mockCreate.mockImplementation(async () => ({
			[Symbol.asyncIterator]: async function* () {
				yield {
					choices: [
						{
							delta: { content: "Test response" },
							index: 0,
						},
					],
					usage: null,
				}
				yield {
					choices: [
						{
							delta: {},
							index: 0,
						},
					],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
					},
				}
			},
		}))
		handler = new FriendliHandler({ friendliApiKey: "test-key" })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("should use the correct Friendli base URL", () => {
		new FriendliHandler({ friendliApiKey: "test-friendli-api-key" })
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.friendli.ai/serverless/v1" }),
		)
	})

	it("should use the provided API key", () => {
		const friendliApiKey = "test-friendli-api-key"
		new FriendliHandler({ friendliApiKey })
		expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: friendliApiKey }))
	})

	it("should throw error when API key is not provided", () => {
		expect(() => new FriendliHandler({})).toThrow("API key is required")
	})

	it("should return default model when no model is specified", () => {
		const model = handler.getModel()
		expect(model.id).toBe(friendliDefaultModelId)
		expect(model.info).toEqual(expect.objectContaining(friendliModels[friendliDefaultModelId]))
	})

	it("should return GLM-5.2 model with correct configuration", () => {
		const handlerWithModel = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-...ey",
		})
		const model = handlerWithModel.getModel()
		expect(model.id).toBe("zai-org/GLM-5.2")
		expect(model.info).toEqual(
			expect.objectContaining({
				maxTokens: 131_072,
				contextWindow: 1_000_000,
				supportsImages: false,
				supportsPromptCache: true,
				supportsMaxTokens: true,
				inputPrice: 1.4,
				outputPrice: 4.4,
				cacheWritesPrice: 0,
				cacheReadsPrice: 0.26,
			}),
		)
	})

	it.each([
		{
			modelId: "zai-org/GLM-5.1" as const,
			contextWindow: 200_000,
			maxTokens: 131_072,
			supportsMaxTokens: true,
			inputPrice: 1.4,
			outputPrice: 4.4,
			cacheWritesPrice: 0,
			cacheReadsPrice: 0.26,
		},
		{
			modelId: "deepseek-ai/DeepSeek-V3.2" as const,
			contextWindow: 163_840,
			maxTokens: 16384,
			supportsMaxTokens: undefined,
			inputPrice: 0.5,
			outputPrice: 1.5,
			cacheWritesPrice: 0,
			cacheReadsPrice: 0.25,
		},
		{
			modelId: "MiniMaxAI/MiniMax-M2.5" as const,
			contextWindow: 204_800,
			maxTokens: 4096,
			supportsMaxTokens: undefined,
			inputPrice: 0.3,
			outputPrice: 1.2,
			cacheWritesPrice: 0,
			cacheReadsPrice: 0.06,
		},
	])(
		"should expose newly added model $modelId",
		({
			modelId,
			contextWindow,
			maxTokens,
			supportsMaxTokens,
			inputPrice,
			outputPrice,
			cacheWritesPrice,
			cacheReadsPrice,
		}) => {
			expect(friendliModels[modelId]).toBeDefined()
			const info = friendliModels[modelId] as import("@roo-code/types").ModelInfo
			expect(info.maxTokens).toBe(maxTokens)
			expect(info.contextWindow).toBe(contextWindow)
			expect(info.supportsMaxTokens).toBe(supportsMaxTokens)
			expect(info.inputPrice).toBe(inputPrice)
			expect(info.outputPrice).toBe(outputPrice)
			expect(info.cacheWritesPrice).toBe(cacheWritesPrice)
			expect(info.cacheReadsPrice).toBe(cacheReadsPrice)
			expect(info.description).toBeTruthy()

			const handlerWithModel = new FriendliHandler({
				apiModelId: modelId,
				friendliApiKey: "test-friendli-api-key",
			})
			expect(handlerWithModel.getModel().id).toBe(modelId)
		},
	)

	it("completePrompt method should return text from Friendli API", async () => {
		const expectedResponse = "This is a test response from Friendli"
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: expectedResponse } }] })
		const result = await handler.completePrompt("test prompt")
		expect(result).toBe(expectedResponse)
	})

	it("should handle errors in completePrompt", async () => {
		const errorMessage = "Friendli API error"
		mockCreate.mockRejectedValueOnce(new Error(errorMessage))
		await expect(handler.completePrompt("test prompt")).rejects.toThrow(
			`Friendli completion error: ${errorMessage}`,
		)
	})

	it("createMessage should yield text content from stream", async () => {
		const testContent = "This is test content from Friendli stream"

		mockCreate.mockImplementationOnce(() => {
			return {
				[Symbol.asyncIterator]: () => ({
					next: vi
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: { choices: [{ delta: { content: testContent } }] },
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}
		})

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({ type: "text", text: testContent })
	})

	it("createMessage should yield usage data from stream", async () => {
		mockCreate.mockImplementationOnce(() => {
			return {
				[Symbol.asyncIterator]: () => ({
					next: vi
						.fn()
						.mockResolvedValueOnce({
							done: false,
							value: { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20 } },
						})
						.mockResolvedValueOnce({ done: true }),
				}),
			}
		})

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 20 })
	})

	it("createMessage should pass correct parameters to Friendli client", async () => {
		const modelId = "zai-org/GLM-5.2"
		const modelInfo = friendliModels[modelId]
		const handlerWithModel = new FriendliHandler({
			apiModelId: modelId,
			friendliApiKey: "test-friendli-api-key",
		})

		mockCreate.mockImplementationOnce(() => {
			return {
				[Symbol.asyncIterator]: () => ({
					async next() {
						return { done: true }
					},
				}),
			}
		})

		const systemPrompt = "Test system prompt for Friendli"
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message for Friendli" }]

		const messageGenerator = handlerWithModel.createMessage(systemPrompt, messages)
		await messageGenerator.next()

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: modelId,
				max_tokens: modelInfo.maxTokens,
				temperature: 0.6,
				messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
				stream: true,
				stream_options: { include_usage: true },
			}),
			undefined,
		)
	})

	it("should use user-specified temperature over provider default", async () => {
		const handlerWithModel = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-friendli-api-key",
			modelTemperature: 0.3,
		})

		mockCreate.mockImplementationOnce(() => ({
			[Symbol.asyncIterator]: () => ({
				async next() {
					return { done: true }
				},
			}),
		}))

		const messageGenerator = handlerWithModel.createMessage("system", [])
		await messageGenerator.next()

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				temperature: 0.3,
			}),
			undefined,
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
		mockCreate.mockImplementationOnce(async () => ({
			[Symbol.asyncIterator]: async function* () {
				yield {
					choices: [
						{
							delta: { content: "Hello" },
							index: 0,
						},
					],
					usage: null,
				}
				yield {
					choices: [
						{
							delta: { content: " world" },
							index: 0,
						},
					],
					usage: null,
				}
				yield {
					choices: [
						{
							delta: {},
							index: 0,
						},
					],
					usage: {
						prompt_tokens: 5,
						completion_tokens: 10,
						total_tokens: 15,
					},
				}
			},
		}))

		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

		const stream = handler.createMessage(systemPrompt, messages)
		const chunks = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		expect(chunks[0]).toEqual({ type: "text", text: "Hello" })
		expect(chunks[1]).toEqual({ type: "text", text: " world" })
		expect(chunks[2]).toMatchObject({ type: "usage", inputTokens: 5, outputTokens: 10 })
	})
})

describe("buildApiHandler friendli wiring", () => {
	it("returns a FriendliHandler for apiProvider='friendli'", () => {
		const handler = buildApiHandler({ apiProvider: "friendli", friendliApiKey: "test-key" })
		expect(handler).toBeInstanceOf(FriendliHandler)
	})
})

describe("Friendli model max output tokens (clamping behavior)", () => {
	it("GLM-5.2: maxTokens (131072) is under 20% of 1M context window — clamp is no-op", () => {
		const model = friendliModels["zai-org/GLM-5.2"]
		const result = getModelMaxOutputTokens({
			modelId: "zai-org/GLM-5.2",
			model,
			settings: { apiProvider: "friendli" },
			format: "openai",
		})
		// 1_000_000 * 0.2 = 200_000 > 131_072 → no clamping
		expect(result).toBe(131_072)
	})

	it("GLM-5.1: maxTokens (131072) exceeds 20% of 200k context window — clamp binds to 40000", () => {
		const model = friendliModels["zai-org/GLM-5.1"]
		const result = getModelMaxOutputTokens({
			modelId: "zai-org/GLM-5.1",
			model,
			settings: { apiProvider: "friendli" },
			format: "openai",
		})
		// 200_000 * 0.2 = 40_000 < 131_072 → clamped to 40_000
		expect(result).toBe(40_000)
	})

	it("GLM-5.1 with user modelMaxTokens override: honors override capped at model maxTokens", () => {
		const model = friendliModels["zai-org/GLM-5.1"]
		const result = getModelMaxOutputTokens({
			modelId: "zai-org/GLM-5.1",
			model,
			settings: { apiProvider: "friendli", modelMaxTokens: 80_000 },
			format: "openai",
		})
		// supportsMaxTokens=true, user set 80k, model ceiling 131072 → min(80000, 131072) = 80000
		expect(result).toBe(80_000)
	})
})
