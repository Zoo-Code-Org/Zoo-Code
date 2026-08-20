// npx vitest run api/providers/__tests__/requesty.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { RequestyHandler } from "../requesty"
import { Package } from "../../../shared/package"
import { ApiHandlerCreateMessageMetadata } from "../../index"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	return {
		default: vitest.fn().mockImplementation(function () {
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

vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(function () {
		return Promise.resolve({
			"coding/claude-4-sonnet": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 4 Sonnet",
			},
			"anthropic/claude-fable-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
				supportsTemperature: false,
				inputPrice: 10,
				outputPrice: 50,
				cacheWritesPrice: 12.5,
				cacheReadsPrice: 1,
				description: "Claude Fable 5",
			},
			"anthropic/claude-sonnet-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
				supportsTemperature: false,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude Sonnet 5",
			},
			"anthropic/claude-opus-5": {
				maxTokens: 128000,
				contextWindow: 1000000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoningBudget: true,
				supportsReasoningBinary: true,
				supportsTemperature: false,
				inputPrice: 5,
				outputPrice: 25,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
				description: "Claude Opus 5",
			},
		})
	}),
}))

describe("RequestyHandler", () => {
	const mockOptions = makeApiHandlerOptions({
		requestyApiKey: "test-key",
		requestyModelId: "coding/claude-4-sonnet",
	})

	beforeEach(() => clearAllMocks())

	it("initializes with correct options", () => {
		const handler = new RequestyHandler(mockOptions)
		expect(handler).toBeInstanceOf(RequestyHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://router.requesty.ai/v1",
			apiKey: mockOptions.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	it("can use a base URL instead of the default", () => {
		const handler = new RequestyHandler({ ...mockOptions, requestyBaseUrl: "https://custom.requesty.ai/v1" })
		expect(handler).toBeInstanceOf(RequestyHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://custom.requesty.ai/v1",
			apiKey: mockOptions.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/Zoo-Code-Org/Zoo-Code",
				"X-Title": "Zoo Code",
				"User-Agent": `ZooCode/${Package.version}`,
			},
			timeout: MOCK_TIMEOUT_MS,
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new RequestyHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.requestyModelId,
				info: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
					cacheWritesPrice: 3.75,
					cacheReadsPrice: 0.3,
					description: "Claude 4 Sonnet",
				},
			})
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new RequestyHandler({})
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.requestyModelId,
				info: {
					maxTokens: 8192,
					contextWindow: 200000,
					supportsImages: true,
					supportsPromptCache: true,
					inputPrice: 3,
					outputPrice: 15,
					cacheWritesPrice: 3.75,
					cacheReadsPrice: 0.3,
					description: "Claude 4 Sonnet",
				},
			})
		})
	})

	describe("createMessage", () => {
		it("generates correct stream chunks", async () => {
			const handler = new RequestyHandler(mockOptions)

			const mockStream = asyncStreamFrom([
				{
					id: mockOptions.requestyModelId,
					choices: [{ delta: { content: "test response" } }],
				},
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 20,
						prompt_tokens_details: {
							caching_tokens: 5,
							cached_tokens: 2,
						},
					},
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 20,
				cacheWriteTokens: 5,
				cacheReadTokens: 2,
				totalCost: expect.any(Number),
			})

			// Verify OpenAI client was called with correct parameters
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_tokens: 8192,
					messages: [
						{
							role: "system",
							content: "test system prompt",
						},
						{
							role: "user",
							content: "test message",
						},
					],
					model: "coding/claude-4-sonnet",
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Fable 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-sonnet-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("uses adaptive thinking for Claude Opus 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-opus-5",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			const mockStream = asyncStreamFrom([
				{
					id: "test-id",
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				},
			])

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-opus-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("handles API errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockError = new Error("API Error")
			mockCreate.mockRejectedValue(mockError)

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("API Error")
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning_content: "thinking..." } }] },
					{ id: "1", choices: [{ delta: { content: "answer" } }] },
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{ id: "1", choices: [{ delta: { reasoning: "router-style thought" } }] },
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			const handler = new RequestyHandler(mockOptions)

			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "1",
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
							},
						],
					},
					{
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		describe("native tool support", () => {
			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user" as const, content: "What's the weather?" },
			]

			const mockTools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: {
						name: "get_weather",
						description: "Get the current weather",
						parameters: {
							type: "object",
							properties: {
								location: { type: "string" },
							},
							required: ["location"],
						},
					},
				},
			]

			beforeEach(() => {
				mockCreate.mockResolvedValue(
					asyncStreamFrom([
						{
							id: "test-id",
							choices: [{ delta: { content: "test response" } }],
						},
					]),
				)
			})

			it("should include tools in request when tools are provided", async () => {
				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "test-task",
					tools: mockTools,
					tool_choice: "auto",
				}

				const handler = new RequestyHandler(mockOptions)
				const iterator = handler.createMessage(systemPrompt, messages, metadata)
				await iterator.next()

				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({
						tools: expect.arrayContaining([
							expect.objectContaining({
								type: "function",
								function: expect.objectContaining({
									name: "get_weather",
									description: "Get the current weather",
								}),
							}),
						]),
						tool_choice: "auto",
					}),
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				)
			})

			it("should handle tool_call_partial chunks in streaming response", async () => {
				mockCreate.mockResolvedValue(
					asyncStreamFrom([
						{
							id: "test-id",
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_123",
												function: {
													name: "get_weather",
													arguments: '{"location":',
												},
											},
										],
									},
								},
							],
						},
						{
							id: "test-id",
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												function: {
													arguments: '"New York"}',
												},
											},
										],
									},
								},
							],
						},
						{
							id: "test-id",
							choices: [{ delta: {} }],
							usage: { prompt_tokens: 10, completion_tokens: 20 },
						},
					]),
				)

				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "test-task",
					tools: mockTools,
				}

				const handler = new RequestyHandler(mockOptions)
				const chunks = await collectStream(handler.createMessage(systemPrompt, messages, metadata))

				// Expect two tool_call_partial chunks and one usage chunk
				expect(chunks).toHaveLength(3)
				expect(chunks[0]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "get_weather",
					arguments: '{"location":',
				})
				expect(chunks[1]).toEqual({
					type: "tool_call_partial",
					index: 0,
					id: undefined,
					name: undefined,
					arguments: '"New York"}',
				})
				expect(chunks[2]).toMatchObject({
					type: "usage",
					inputTokens: 10,
					outputTokens: 20,
				})
			})
		})
		it("rejects with AbortError when the external signal is pre-aborted", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue(asyncStreamFrom([{ id: "1", choices: [{ delta: { content: "response" } }] }]))

			const controller = new AbortController()
			controller.abort()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			await expect(
				handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata).next(),
			).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("aborts the in-flight stream and rejects with AbortError when the external signal aborts", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				requestSignal = options?.signal
				// Emulate the OpenAI SDK: the first chunk arrives, then the in-flight
				// response body rejects once the request signal aborts.
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "first" } }] }
					await new Promise<void>((resolve) => {
						if (requestSignal?.aborted) {
							resolve()
						} else {
							requestSignal?.addEventListener("abort", () => resolve(), { once: true })
						}
					})
					const abortError = new Error("The user aborted a request")
					abortError.name = "AbortError"
					throw abortError
				})()
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const chunks: unknown[] = []
			const iteration = (async () => {
				for await (const chunk of generator) {
					chunks.push(chunk)
					if (chunk.type === "text") {
						// Abort while the stream is still in flight.
						controller.abort()
					}
				}
			})()

			await expect(iteration).rejects.toMatchObject({ name: "AbortError" })
			expect(chunks).toContainEqual({ type: "text", text: "first" })
		})
		it("rejects with AbortError when the external signal aborts during request creation", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Synchronize on request startup (instead of a fixed sleep) so the abort
			// deterministically lands while the request is in flight.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				// Emulate the OpenAI SDK: the pending request rejects when the signal aborts.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }], metadata)

			const nextPromise = generator.next()
			await createStarted
			controller.abort()

			await expect(nextPromise).rejects.toMatchObject({ name: "AbortError" })
		})

		it("rethrows non-abort stream errors from createMessage", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockImplementationOnce(async () => {
				return (async function* () {
					yield { id: "1", choices: [{ delta: { content: "first" } }] }
					throw new Error("stream broke")
				})()
			})

			const generator = handler.createMessage("sys", [{ role: "user", content: "hi" }])

			await expect(collectStream(generator)).rejects.toThrow("stream broke")
		})
	})

	describe("completePrompt", () => {
		it("returns correct response", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			mockCreate.mockResolvedValue(mockResponse)

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.requestyModelId,
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: 0,
				},
				{},
			)
		})

		it("omits temperature for Claude Fable 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-fable-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("omits temperature for Claude Sonnet 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-sonnet-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-sonnet-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("omits temperature for Claude Opus 5 in completePrompt", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-opus-5",
				}),
			)
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "anthropic/claude-opus-5",
					max_tokens: 8192,
					messages: [{ role: "system", content: "test prompt" }],
					temperature: undefined,
				},
				{},
			)
		})

		it("handles API errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockError = new Error("API Error")
			mockCreate.mockRejectedValue(mockError)

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("API Error")
		})

		it("handles unexpected errors", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockRejectedValue(new Error("Unexpected error"))

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")
		})
		it("should pass abort signal through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				signal: controller.signal,
			})
		})

		it("should pass timeout through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({
					timeout: 5000,
				}),
			)
		})

		it("should work without options (backward compatible)", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
		})

		it("rejects with AbortError when the signal is pre-aborted", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("rejects with AbortError when aborted mid-flight", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				// Emulate the OpenAI SDK: the in-flight request rejects when the signal aborts.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			controller.abort()

			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
		})
		it("rejects with AbortError when only a timeout is provided and it elapses", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				// Emulate the OpenAI SDK: the in-flight request rejects when the signal times out.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const timeoutError = new Error("TimeoutError: Request timed out.")
				timeoutError.name = "TimeoutError"
				throw timeoutError
			})

			await expect(handler.completePrompt("test prompt", { timeoutMs: 50 })).rejects.toMatchObject({
				name: "AbortError",
			})
		})

		it("rejects with AbortError when both an abort signal and a timeout are provided", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				requestSignal = options?.signal
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				const abortError = new Error("The user aborted a request")
				abortError.name = "AbortError"
				throw abortError
			})

			const promise = handler.completePrompt("test prompt", {
				abortSignal: controller.signal,
				timeoutMs: 100_000,
			})
			controller.abort()

			await expect(promise).rejects.toMatchObject({ name: "AbortError" })
			// The SDK received a merged signal (not the caller's signal) plus the timeout.
			expect(requestSignal).toBeDefined()
			expect(requestSignal).not.toBe(controller.signal)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: expect.any(String) }),
				expect.objectContaining({
					timeout: 100_000,
				}),
			)
		})
	})
})
