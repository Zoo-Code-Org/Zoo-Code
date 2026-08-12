// npx vitest run api/providers/__tests__/friendli.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { friendliDefaultModelId, friendliModels } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { getModelMaxOutputTokens } from "../../../shared/api"
import { FriendliHandler } from "../friendli"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

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
		clearAllMocks()
		// Set up default mock implementation
		mockCreate.mockImplementation(async () =>
			asyncStreamFrom([
				{
					choices: [
						{
							delta: { content: "Test response" },
							index: 0,
						},
					],
					usage: null,
				},
				{
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
				},
			]),
		)
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

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([{ choices: [{ delta: { content: testContent } }] }]))

		const stream = handler.createMessage("system prompt", [])
		const firstChunk = await stream.next()

		expect(firstChunk.done).toBe(false)
		expect(firstChunk.value).toEqual({ type: "text", text: testContent })
	})

	it("createMessage should yield usage data from stream", async () => {
		mockCreate.mockImplementationOnce(() =>
			asyncStreamFrom([{ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20 } }]),
		)

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

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

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

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

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
		mockCreate.mockImplementationOnce(async () =>
			asyncStreamFrom([
				{
					choices: [
						{
							delta: { content: "Hello" },
							index: 0,
						},
					],
					usage: null,
				},
				{
					choices: [
						{
							delta: { content: " world" },
							index: 0,
						},
					],
					usage: null,
				},
				{
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
				},
			]),
		)

		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

		const stream = handler.createMessage(systemPrompt, messages)
		const chunks = await collectStream(stream)

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

describe("FriendliHandler — Friendli-specific reasoning params", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("should include reasoning_effort, chat_template_kwargs, parse_reasoning for GLM-5.2 with reasoning enabled", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-key",
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "zai-org/GLM-5.2",
				reasoning_effort: "high",
				chat_template_kwargs: { enable_thinking: true },
				parse_reasoning: true,
				include_reasoning: true,
			}),
			undefined,
		)
	})

	it("should send enable_thinking: false when enableReasoningEffort is false on controllable model", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-...ey",
			enableReasoningEffort: false,
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBeUndefined()
		expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(callArgs.parse_reasoning).toBeUndefined()
		expect(callArgs.include_reasoning).toBeUndefined()
	})

	it("should send enable_thinking: false when reasoningEffort is none on controllable model", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-...ey",
			enableReasoningEffort: true,
			reasoningEffort: "none",
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBeUndefined()
		expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(callArgs.parse_reasoning).toBeUndefined()
		expect(callArgs.include_reasoning).toBeUndefined()
	})

	it("should send enable_thinking: false when reasoningEffort is disable on controllable model", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-...ey",
			enableReasoningEffort: true,
			reasoningEffort: "disable",
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBeUndefined()
		expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: false })
		expect(callArgs.parse_reasoning).toBeUndefined()
		expect(callArgs.include_reasoning).toBeUndefined()
	})

	it("should use model default reasoningEffort when no explicit settings are provided", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-...ey",
			// No enableReasoningEffort or reasoningEffort — model default "high" kicks in
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBe("high")
		expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: true })
		expect(callArgs.parse_reasoning).toBe(true)
		expect(callArgs.include_reasoning).toBe(true)
	})

	it("should not include any reasoning params for non-reasoning DeepSeek-V3.2", async () => {
		const handler = new FriendliHandler({
			apiModelId: "deepseek-ai/DeepSeek-V3.2",
			friendliApiKey: "test-key",
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})

		mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

		await handler.createMessage("system", []).next()

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBeUndefined()
		expect(callArgs.chat_template_kwargs).toBeUndefined()
		expect(callArgs.parse_reasoning).toBeUndefined()
	})

	it("should handle delta.reasoning_content from parse_reasoning=true stream", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-key",
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})

		mockCreate.mockImplementationOnce(async () =>
			asyncStreamFrom([
				{
					choices: [{ delta: { reasoning_content: "Let me think..." } }],
					usage: null,
				},
				{
					choices: [{ delta: { content: "The answer is 42" } }],
					usage: null,
				},
				{
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
				},
			]),
		)

		const stream = handler.createMessage("system", [])
		const chunks = await collectStream(stream)

		expect(chunks).toContainEqual({ type: "reasoning", text: "Let me think..." })
		expect(chunks).toContainEqual({ type: "text", text: "The answer is 42" })
	})

	it("completePrompt should include reasoning params when enabled", async () => {
		const handler = new FriendliHandler({
			apiModelId: "zai-org/GLM-5.2",
			friendliApiKey: "test-key",
			enableReasoningEffort: true,
			reasoningEffort: "medium",
		})

		mockCreate.mockResolvedValueOnce({
			choices: [{ message: { content: "test result" } }],
		})

		await handler.completePrompt("test")

		const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
		expect(callArgs.reasoning_effort).toBe("medium")
		expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: true })
		expect(callArgs.parse_reasoning).toBe(true)
		expect(callArgs.include_reasoning).toBe(true)
	})
})
