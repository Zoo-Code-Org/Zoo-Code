// npx vitest run api/providers/__tests__/friendli.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { friendliDefaultModelId, friendliModels, openAiModelInfoSaneDefaults } from "@roo-code/types"

import { buildApiHandler } from "../../index"
import { getModelMaxOutputTokens } from "../../../shared/api"
import { FriendliHandler } from "../friendli"
import { NOT_PROVIDED } from "../constants"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Create mock functions
const mockCreate = vi.fn()
const { mockGetModels, mockGetFriendliModels } = vi.hoisted(() => ({
	mockGetModels: vi.fn(async () => ({})),
	mockGetFriendliModels: vi.fn(),
}))

vi.mock("../fetchers/modelCache", () => ({ getModels: mockGetModels }))
vi.mock("../fetchers/friendli", () => ({ getFriendliModels: mockGetFriendliModels }))

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

	it("should construct without an API key and without fetching the catalog", () => {
		expect(() => new FriendliHandler({})).not.toThrow()
		expect(mockGetModels).not.toHaveBeenCalled()
	})

	it.each([
		{ entry: "createMessage", run: (h: FriendliHandler) => h.createMessage("system", []).next() },
		{ entry: "completePrompt", run: (h: FriendliHandler) => h.completePrompt("a") },
	])("keyless $entry sends the placeholder key and surfaces a 401 to the caller", async ({ run }) => {
		const unauthorized = Object.assign(new Error("Incorrect API key provided"), { status: 401 })
		mockCreate.mockRejectedValueOnce(unauthorized)
		const keyless = new FriendliHandler({})

		await expect(run(keyless)).rejects.toMatchObject({ status: 401 })
		expect(vi.mocked(OpenAI).mock.lastCall?.[0]).toEqual(expect.objectContaining({ apiKey: NOT_PROVIDED }))
	})

	it("should load the catalog once before building requests for fetched-only models", async () => {
		const info = { maxTokens: 8192, contextWindow: 100_000, supportsPromptCache: false }
		mockGetModels.mockResolvedValueOnce({ "vendor/new-model": info })
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
		const handlerWithModel = new FriendliHandler({ apiModelId: "vendor/new-model", friendliApiKey: "test-key" })

		await handlerWithModel.completePrompt("a")
		await handlerWithModel.completePrompt("b")

		expect(mockGetModels).toHaveBeenCalledTimes(1)
		expect(handlerWithModel.getModel()).toEqual(expect.objectContaining({ id: "vendor/new-model", info }))
	})

	it("should wait for the catalog before streaming", async () => {
		const info = { maxTokens: 8192, contextWindow: 100_000, supportsPromptCache: false }
		mockGetModels.mockResolvedValueOnce({ "vendor/new-model": info })
		const handlerWithModel = new FriendliHandler({ apiModelId: "vendor/new-model", friendliApiKey: "test-key" })

		await handlerWithModel.createMessage("system", []).next()

		expect(mockCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ max_tokens: 8192 }))
	})

	it("should not start a chat request when cancelled during catalog loading", async () => {
		mockGetModels.mockReturnValueOnce(new Promise(() => {}))
		const controller = new AbortController()
		const pending = handler.createMessage("system", [], { taskId: "t", abortSignal: controller.signal }).next()

		controller.abort()

		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it("ensureModelFetched should expose the fetched context window before any request", async () => {
		const info = { maxTokens: 8192, contextWindow: 100_000, supportsPromptCache: false }
		mockGetModels.mockResolvedValueOnce({ "vendor/new-model": info })
		const handlerWithModel = new FriendliHandler({ apiModelId: "vendor/new-model", friendliApiKey: "k" })

		await handlerWithModel.ensureModelFetched()
		expect(handlerWithModel.getModel().info.contextWindow).toBe(100_000)

		await handlerWithModel.completePrompt("a")
		expect(mockGetModels).toHaveBeenCalledTimes(1)
	})

	it("completePrompt should not start a chat request when cancelled during catalog loading", async () => {
		mockGetModels.mockReturnValueOnce(new Promise(() => {}))
		const controller = new AbortController()
		const pending = handler.completePrompt("a", { abortSignal: controller.signal })

		controller.abort()

		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it.each([
		{
			entry: "createMessage",
			run: (h: FriendliHandler, signal: AbortSignal) =>
				h.createMessage("system", [], { taskId: "t", abortSignal: signal }).next(),
		},
		{
			entry: "completePrompt",
			run: (h: FriendliHandler, signal: AbortSignal) => h.completePrompt("a", { abortSignal: signal }),
		},
	])("$entry should not start a chat request when cancelled as the catalog settles", async ({ run }) => {
		const controller = new AbortController()
		mockGetModels.mockImplementationOnce(async () => {
			controller.abort()
			return { "vendor/new-model": { contextWindow: 100_000, supportsPromptCache: false } }
		})

		await expect(run(handler, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it("createMessage should forward a per-request signal and normalize a mid-stream abort", async () => {
		const controller = new AbortController()
		mockCreate.mockImplementationOnce(async function* () {
			yield { choices: [{ delta: { content: "partial" }, index: 0 }] }
			controller.abort()
			throw new Error("Request was aborted.")
		})

		const stream = handler.createMessage("system", [], { taskId: "t", abortSignal: controller.signal })

		await expect(collectStream(stream)).rejects.toMatchObject({
			name: "AbortError",
			message: "The Friendli request was aborted",
		})
		const forwarded = (mockCreate.mock.calls[0][1] as { signal: AbortSignal }).signal
		expect(forwarded).not.toBe(controller.signal)
		expect(forwarded.aborted).toBe(true)
	})

	describe("caller signal listener cleanup", () => {
		// Mirrors openai@5 client.js: an anonymous abort listener that is never removed.
		const leakyCreate = (body: () => AsyncGenerator<unknown>) =>
			mockCreate.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
				opts?.signal?.addEventListener("abort", () => {})
				return body()
			})
		const trackListeners = (signal: AbortSignal) => {
			const live = new Set<unknown>()
			const add = signal.addEventListener.bind(signal)
			const remove = signal.removeEventListener.bind(signal)
			vi.spyOn(signal, "addEventListener").mockImplementation((type, fn, opts) => {
				live.add(fn)
				add(type, fn, opts)
			})
			vi.spyOn(signal, "removeEventListener").mockImplementation((type, fn, opts) => {
				live.delete(fn)
				remove(type, fn, opts)
			})
			return live
		}
		const chunk = { choices: [{ delta: { content: "x" }, index: 0 }] }

		it("detaches from a signal reused across completed streams", async () => {
			leakyCreate(() => asyncStreamFrom([chunk]))
			const { signal } = new AbortController()
			const live = trackListeners(signal)

			for (let i = 0; i < 3; i++) {
				await collectStream(handler.createMessage("system", [], { taskId: "t", abortSignal: signal }))
			}

			expect(mockCreate).toHaveBeenCalledTimes(3)
			expect(live.size).toBe(0)
		})

		it.each([
			{
				exit: "a failed stream",
				body: async function* () {
					yield chunk
					throw new Error("boom")
				},
				consume: (s: AsyncGenerator<unknown>) => expect(collectStream(s)).rejects.toThrow("boom"),
			},
			{
				exit: "an early generator exit",
				body: async function* () {
					yield chunk
					yield chunk
				},
				consume: async (s: AsyncGenerator<unknown>) => {
					await s.next()
					await s.return(undefined)
				},
			},
		])("detaches after $exit", async ({ body, consume }) => {
			leakyCreate(body)
			const { signal } = new AbortController()
			const live = trackListeners(signal)

			await consume(handler.createMessage("system", [], { taskId: "t", abortSignal: signal }))

			expect(live.size).toBe(0)
		})

		it("completePrompt detaches from a signal reused across keyless calls that succeed and fail", async () => {
			const keyless = new FriendliHandler({})
			let calls = 0
			mockCreate.mockImplementation(async (_params: unknown, opts?: { signal?: AbortSignal }) => {
				opts?.signal?.addEventListener("abort", () => {})
				if (++calls === 3) throw new Error("boom")
				if (calls === 4) {
					// In flight until the forwarded signal aborts.
					await new Promise((resolve) => opts?.signal?.addEventListener("abort", resolve))
					throw new Error("Request was aborted.")
				}
				return { choices: [{ message: { content: "ok" } }] }
			})
			const controller = new AbortController()
			const live = trackListeners(controller.signal)

			await keyless.completePrompt("a", { abortSignal: controller.signal })
			await keyless.completePrompt("b", { abortSignal: controller.signal })
			await expect(keyless.completePrompt("c", { abortSignal: controller.signal })).rejects.toThrow("boom")

			expect(mockCreate).toHaveBeenCalledTimes(3)
			expect(live.size).toBe(0)
			// The bridge still follows the caller after earlier calls detached.
			const pending = keyless.completePrompt("d", { abortSignal: controller.signal })
			await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(4))
			controller.abort()
			await expect(pending).rejects.toThrow()
			expect((mockCreate.mock.lastCall?.[1] as { signal: AbortSignal }).signal.aborted).toBe(true)
		})
	})

	it("should retry an empty catalog and keep the next nonempty one", async () => {
		const info = { maxTokens: 8192, contextWindow: 100_000, supportsPromptCache: false }
		mockGetModels.mockResolvedValueOnce({}).mockResolvedValueOnce({ "vendor/new-model": info })
		const handlerWithModel = new FriendliHandler({ apiModelId: "vendor/new-model", friendliApiKey: "k" })

		await handlerWithModel.ensureModelFetched()
		expect(handlerWithModel.getModel().info).toEqual(openAiModelInfoSaneDefaults)

		await handlerWithModel.ensureModelFetched()
		expect(handlerWithModel.getModel().info).toBe(info)

		await handlerWithModel.ensureModelFetched()
		expect(mockGetModels).toHaveBeenCalledTimes(2)
		expect(handlerWithModel.getModel().info).toBe(info)
	})

	it("completePrompt should give the completion only the time left after the catalog wait", async () => {
		let now = 1_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		mockGetModels.mockImplementationOnce(async () => {
			now += 1_000
			return {}
		})
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })

		await handler.completePrompt("a", { timeoutMs: 3000 })

		expect(mockCreate).toHaveBeenLastCalledWith(expect.anything(), { timeout: 2000 })
	})

	it("completePrompt should time out without a chat request when a resolved catalog wait spends the deadline", async () => {
		let now = 1_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		mockGetModels.mockImplementationOnce(async () => {
			now += 3_000
			return {}
		})

		await expect(handler.completePrompt("a", { timeoutMs: 3000 })).rejects.toMatchObject({ name: "TimeoutError" })
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it("completePrompt should time out without a chat request when the catalog wait uses the deadline", async () => {
		mockGetModels.mockReturnValueOnce(new Promise(() => {}))

		await expect(handler.completePrompt("a", { timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" })
		expect(mockCreate).not.toHaveBeenCalled()
	})

	it("should fall back to static models when the catalog is empty", async () => {
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
		await handler.completePrompt("a")

		expect(handler.getModel().info).toEqual(friendliModels[friendliDefaultModelId])
	})

	it("should keep an unknown model id with default metadata when the catalog fails", async () => {
		mockGetModels.mockRejectedValueOnce(new Error("Network error"))
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
		const handlerWithModel = new FriendliHandler({ apiModelId: "vendor/unknown", friendliApiKey: "test-key" })

		await handlerWithModel.completePrompt("a")

		expect(handlerWithModel.getModel()).toEqual(
			expect.objectContaining({ id: "vendor/unknown", info: openAiModelInfoSaneDefaults }),
		)
	})

	it("fetchModels should load the public /v1/models catalog", async () => {
		const fetched = { "vendor/new-model": { contextWindow: 100_000, supportsPromptCache: false } }
		mockGetFriendliModels.mockResolvedValueOnce(fetched)
		const signal = new AbortController().signal

		expect(await handler.fetchModels({ provider: providerIdentifiers.friendli }, signal)).toBe(fetched)
		expect(mockGetFriendliModels).toHaveBeenCalledWith({ signal })
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

	it("completePrompt should forward a per-request signal instead of the caller's", async () => {
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
		const controller = new AbortController()
		await handler.completePrompt("test prompt", { abortSignal: controller.signal })
		const forwarded = (mockCreate.mock.lastCall?.[1] as { signal: AbortSignal }).signal
		expect(forwarded).not.toBe(controller.signal)
		expect(forwarded.aborted).toBe(false)
	})

	it.each([
		{ label: "a whole-number", input: 3000, forwarded: 3000 },
		{ label: "a fractional", input: 12.5, forwarded: 13 },
		{ label: "an over-cap", input: 2_147_483_648, forwarded: 2_147_483_647 },
	])("completePrompt should forward $label timeoutMs as $forwarded", async ({ input, forwarded }) => {
		vi.spyOn(Date, "now").mockReturnValue(1_000) // no time passes during the catalog wait
		mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
		await handler.completePrompt("test prompt", { timeoutMs: input })
		expect(mockCreate).toHaveBeenLastCalledWith(expect.anything(), { timeout: forwarded })
	})

	it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
		"completePrompt should not forward an unusable timeoutMs (%s)",
		async (timeoutMs) => {
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
			await handler.completePrompt("test prompt", { timeoutMs })
			expect(mockCreate).toHaveBeenLastCalledWith(expect.anything(), undefined)
		},
	)

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
		const handler = buildApiHandler({ apiProvider: providerIdentifiers.friendli, friendliApiKey: "test-key" })
		expect(handler).toBeInstanceOf(FriendliHandler)
	})
})

describe("Friendli model max output tokens (clamping behavior)", () => {
	it("GLM-5.2: maxTokens (131072) is under 20% of 1M context window — clamp is no-op", () => {
		const model = friendliModels["zai-org/GLM-5.2"]
		const result = getModelMaxOutputTokens({
			modelId: "zai-org/GLM-5.2",
			model,
			settings: { apiProvider: providerIdentifiers.friendli },
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
			settings: { apiProvider: providerIdentifiers.friendli },
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
			settings: { apiProvider: providerIdentifiers.friendli, modelMaxTokens: 80_000 },
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

	describe("toggle-only models (supportsReasoningBinary)", () => {
		const toggleOnly = { contextWindow: 202_752, supportsPromptCache: false, supportsReasoningBinary: true }

		const requestFor = async (settings: { enableReasoningEffort?: boolean; reasoningEffort?: "high" }) => {
			mockGetModels.mockResolvedValueOnce({ "zai-org/GLM-5.1": toggleOnly })
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))
			const handler = new FriendliHandler({ apiModelId: "zai-org/GLM-5.1", ...settings })
			await handler.createMessage("system", []).next()
			return mockCreate.mock.calls[0][0] as Record<string, unknown>
		}

		it("sends enable_thinking: true with reasoning parsing when enabled, without an effort", async () => {
			// A stale effort from a previous model must not leak into a toggle-only request.
			const callArgs = await requestFor({ enableReasoningEffort: true, reasoningEffort: "high" })

			expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: true })
			expect(callArgs.parse_reasoning).toBe(true)
			expect(callArgs.include_reasoning).toBe(true)
			expect(callArgs).not.toHaveProperty("reasoning_effort")
		})

		it.each([{ enableReasoningEffort: false }, {}])(
			"sends enable_thinking: false when the toggle is off or unset (%o)",
			async (settings) => {
				const callArgs = await requestFor(settings)

				expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: false })
				expect(callArgs).not.toHaveProperty("parse_reasoning")
				expect(callArgs).not.toHaveProperty("include_reasoning")
				expect(callArgs).not.toHaveProperty("reasoning_effort")
			},
		)

		it("completePrompt sends the same toggle params", async () => {
			mockGetModels.mockResolvedValueOnce({ "zai-org/GLM-5.1": toggleOnly })
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] })
			const handler = new FriendliHandler({ apiModelId: "zai-org/GLM-5.1", enableReasoningEffort: true })

			await handler.completePrompt("test")

			const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>
			expect(callArgs.chat_template_kwargs).toEqual({ enable_thinking: true })
			expect(callArgs).not.toHaveProperty("reasoning_effort")
		})
	})
})

describe("FriendliHandler — reserved model IDs", () => {
	beforeEach(() => {
		clearAllMocks()
		mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })
	})

	it.each(["toString", "constructor", "__proto__"])(
		"does not resolve inherited members for %s (catalog as a plain object)",
		async (id) => {
			mockGetModels.mockResolvedValueOnce({})
			const handler = new FriendliHandler({ apiModelId: id })

			await handler.completePrompt("a")

			expect(handler.getModel()).toEqual(expect.objectContaining({ id, info: openAiModelInfoSaneDefaults }))
		},
	)

	it("resolves a fetched model whose upstream ID is __proto__", async () => {
		const info = { contextWindow: 1000, supportsPromptCache: false }
		const catalog: Record<string, typeof info> = Object.create(null)
		catalog["__proto__"] = info
		mockGetModels.mockResolvedValueOnce(catalog)
		const handler = new FriendliHandler({ apiModelId: "__proto__" })

		await handler.completePrompt("a")

		expect(handler.getModel().info).toBe(info)
	})
})
