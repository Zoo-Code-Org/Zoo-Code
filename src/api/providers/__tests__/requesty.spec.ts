// npx vitest run api/providers/__tests__/requesty.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { providerIdentifiers, requestyDefaultModelInfo } from "@roo-code/types"
import type { ModelRecord } from "@roo-code/types"

import { getModels } from "../fetchers/modelCache"
import { RequestyHandler } from "../requesty"
import { Package } from "../../../shared/package"
import { ApiHandlerCreateMessageMetadata } from "../../index"
import { makeApiHandlerOptions } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"
import { withSettleGuard } from "../../../test-utils/settle-guard"
import { flushMacrotasks } from "../../../test-utils/timers"

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
			"anthropic/claude-fable-5.1": {
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
				cacheReadsPrice: 0.25,
				description: "Claude Fable 5.1",
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
	refreshModels: vitest.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
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
					thinking: { type: "adaptive", display: "summarized" },
					temperature: undefined,
				}),
			)
		})

		it("uses adaptive thinking for Claude Fable 5.1 when reasoning is enabled", async () => {
			const handler = new RequestyHandler(
				makeApiHandlerOptions({
					requestyApiKey: "test-key",
					requestyModelId: "anthropic/claude-fable-5.1",
					enableReasoningEffort: true,
					modelMaxTokens: 32768,
				}),
			)

			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20 },
					},
				]),
			)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5.1",
					max_tokens: 32768,
					thinking: { type: "adaptive", display: "summarized" },
					temperature: undefined,
				}),
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
					thinking: { type: "adaptive", display: "summarized" },
					temperature: undefined,
				}),
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
					thinking: { type: "adaptive", display: "summarized" },
					temperature: undefined,
				}),
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
	})

	describe("completePrompt", () => {
		// The createMessage tests leave behind a persistent stream mock plus queued
		// one-shot implementations; reset so each completePrompt test starts from a clean
		// mock (its own mockSetup below is authoritative).
		beforeEach(() => {
			mockCreate.mockReset()
		})

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
		it.each([
			// Ceiled up: 1500.5 ms is a usable timeout and toSdkTimeoutMs rounds it to 1501.
			// Without the conversion the SDK would receive 1500.5 and the assertion below fails.
			{ input: 1500.5, expected: 1501 },
			// Clamped down: 3e9 exceeds the platform timer ceiling, so it is capped at MAX.
			// Without the conversion the SDK would receive 3e9 and the assertion below fails.
			{ input: 3e9, expected: 2147483647 },
		] as const)(
			"normalises a fractional or oversized timeoutMs to the SDK timeout value $input -> $expected",
			async ({ input, expected }) => {
				// The wiring under test is toSdkTimeoutMs at the createOptions construction: whole
				// numbers alone cannot tell the conversion from a pass-through, so both a value that
				// must be ceiled and a value that must be clamped are asserted on what the SDK is
				// actually handed.
				const handler = new RequestyHandler(mockOptions)
				mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })
				await handler.completePrompt("test prompt", { timeoutMs: input })
				const options = mockCreate.mock.calls.at(-1)?.[1] as { timeout?: number } | undefined
				expect(options?.timeout).toBe(expected)
			},
		)

		it.each([
			["an external signal", { abortSignal: new AbortController().signal }],
			["a per-request timeout", { timeoutMs: 5_000 }],
		])(
			"does not classify an ordinary SDK failure as an abort when %s is configured",
			async (_label, options: { abortSignal?: AbortSignal; timeoutMs?: number }) => {
				// The catch must key on the MERGED SIGNAL BEING ABORTED, not on the signal merely
				// being configured: a real API failure with a live signal is a provider error.
				const handler = new RequestyHandler(mockOptions)
				mockCreate.mockRejectedValue(new Error("API Error"))

				const error = await handler.completePrompt("test prompt", options).catch((e: unknown) => e)

				expect(error).toBeInstanceOf(Error)
				expect((error as Error).name).not.toBe("AbortError")
				// Assert the normalised message, not a substring: "API Error" is also the message of
				// the unwrapped SDK error, so a catch that skipped handleOpenAIError would pass a
				// contains-check while the provider contract was gone.
				expect((error as Error).message).toBe("Requesty completion error: API Error")
			},
		)

		it("should pass abort signal through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				requestSignal = options?.signal
				// Emulate the OpenAI SDK: the in-flight request settles through its signal.
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				return { choices: [{ message: { content: "response" } }] }
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			void promise.catch(() => {})
			await withSettleGuard(createStarted)

			expect(requestSignal).toBeDefined()
			// The SDK receives the bridged per-request signal rather than the caller's own: the SDK
			// leaves its abort listener attached after a completed request, so that listener has to
			// land on a signal that dies with the request. What the contract requires is that the
			// signal tracks the caller, which the mock above proves: it settles only through the
			// signal it was handed.
			expect(requestSignal).not.toBe(controller.signal)
			expect(requestSignal?.aborted).toBe(false)

			controller.abort()
			// The late response must be discarded, and the bridged signal must have aborted with the
			// caller's.
			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(requestSignal?.aborted).toBe(true)
		})

		it("should pass timeout through to client", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			// Capture the exact timeout signal instance the provider creates so the
			// test can assert identity, not just type, for the signal it forwards.
			const timeoutSignalSpy = vitest.spyOn(AbortSignal, "timeout")
			try {
				await handler.completePrompt("test prompt", { timeoutMs: 5000 })
				// Assert the factory argument and call count too: the identity check
				// below would also pass for a signal created with the wrong duration.
				expect(timeoutSignalSpy).toHaveBeenCalledTimes(1)
				expect(timeoutSignalSpy).toHaveBeenCalledWith(5000)
				expect(mockCreate).toHaveBeenCalledWith(
					expect.objectContaining({ model: expect.any(String) }),
					expect.objectContaining({ timeout: 5000 }),
				)
				// Without a caller signal the merged signal is exactly the
				// AbortSignal.timeout instance; the SDK relies on it to reject with a
				// DOM-standard AbortError when the timeout fires.
				const clientOptions = mockCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
				const expectedSignal = timeoutSignalSpy.mock.results[0]?.value
				expect(expectedSignal).toBeInstanceOf(AbortSignal)
				expect(clientOptions?.signal).toBe(expectedSignal)
			} finally {
				// Restore on every exit path: a failed assertion above must not leave
				// the static spy installed for the remaining tests in this file.
				timeoutSignalSpy.mockRestore()
			}
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
				message: "This operation was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
			// Pre-flight cancellation must skip model lookup entirely: the
			// getModels mock must remain uncalled, not just the SDK create call.
			const { getModels } = await import("../fetchers/modelCache")
			expect(vitest.mocked(getModels)).not.toHaveBeenCalled()
		})

		it("rejects with AbortError when the signal aborts during model lookup", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Model discovery is deferred and never settles: with rejectOnAbort racing the
			// lookup, the abort must end the request before the lookup resolves.
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			const deferredModelLookup = new Promise<ModelRecord>(() => {})
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return deferredModelLookup
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			await withSettleGuard(lookupStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("forwards the request signal to the model lookup", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			const { getModels } = await import("../fetchers/modelCache")
			let lookupSignal: AbortSignal | undefined
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			vitest.mocked(getModels).mockImplementationOnce((options) => {
				lookupSignal = options.signal
				notifyLookupStarted()
				return new Promise<ModelRecord>(() => {})
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			void promise.catch(() => {})
			await withSettleGuard(lookupStarted)
			expect(lookupSignal).toBeDefined()
			expect(lookupSignal?.aborted).toBe(false)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({ name: "AbortError" })
			expect(lookupSignal?.aborted).toBe(true)
		})

		it("does not leak an unhandled rejection when the lookup rejects after abort", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			const { getModels } = await import("../fetchers/modelCache")
			let notifyLookupStarted!: () => void
			const lookupStarted = new Promise<void>((resolve) => {
				notifyLookupStarted = resolve
			})
			let rejectLookup!: (error: Error) => void
			vitest.mocked(getModels).mockImplementationOnce(() => {
				notifyLookupStarted()
				return new Promise<ModelRecord>((_resolve, reject) => {
					rejectLookup = reject
				})
			})

			const unhandled: unknown[] = []
			const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
			process.on("unhandledRejection", onUnhandledRejection)
			try {
				const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
				void promise.catch(() => {})
				await withSettleGuard(lookupStarted)
				controller.abort()
				await expect(withSettleGuard(promise)).rejects.toMatchObject({
					name: "AbortError",
					message: "The Requesty request was aborted",
				})

				// The lookup fails after the request already settled as aborted.
				rejectLookup(new Error("late lookup failure"))
				// Node reports an unhandled rejection only after the queue drains, and a rejection
				// that ends up handled has no observable state to poll, so drain the queue through
				// the shared helper instead of sleeping.
				await flushMacrotasks()
				expect(unhandled).toHaveLength(0)
			} finally {
				process.off("unhandledRejection", onUnhandledRejection)
			}
		})

		it("applies timeoutMs to model lookup with no caller signal at all", async () => {
			// The comment above completePrompt claims timeoutMs covers model lookup too. With no
			// caller signal the only cancellation source is the timeout this method configures, so
			// the lookup race must be driven by that merged signal: a never-settling getModels has
			// to be ended by the 20ms deadline rather than hanging. Red if the lookup race is
			// driven by the bridged caller signal instead (undefined here), which leaves the
			// lookup awaited forever and the settle guard fires first.
			const handler = new RequestyHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => new Promise<ModelRecord>(() => {}))
			const promise = handler.completePrompt("test prompt", { timeoutMs: 20 })
			void promise.catch(() => {})
			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("applies timeoutMs to model lookup while a live caller signal stays untouched", async () => {
			// The case above proves the deadline can end a pending lookup with no caller in the picture.
			// This one proves it still does when a caller signal *is* present: the lookup must die on the
			// merged request signal, not on the caller's, and the caller's own signal must still read as
			// live afterwards. Red if the timeout is dropped whenever a caller signal exists (the lookup
			// then hangs and the settle guard fires), which no other case here distinguishes.
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			const { getModels } = await import("../fetchers/modelCache")
			vitest.mocked(getModels).mockImplementationOnce(() => new Promise<ModelRecord>(() => {}))
			const promise = handler.completePrompt("test prompt", {
				abortSignal: controller.signal,
				timeoutMs: 20,
			})
			void promise.catch(() => {})
			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			const lookupSignal = vitest.mocked(getModels).mock.calls.at(-1)?.[0].signal
			expect(lookupSignal).toBeInstanceOf(AbortSignal)
			expect(lookupSignal?.aborted, "the timeout must cancel the model lookup").toBe(true)
			expect(controller.signal.aborted, "the timeout must not surface through the caller signal").toBe(false)
			expect(mockCreate, "the lookup must not fall through into a completion").not.toHaveBeenCalled()
		})

		it("rethrows non-abort model lookup failures from completePrompt", async () => {
			const handler = new RequestyHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")
			const lookupError = new Error("lookup failed")
			vitest.mocked(getModels).mockImplementationOnce(() => {
				return Promise.reject(lookupError)
			})

			// The handler rethrows this exact object, and the fixture owns it: pin the identity rather
			// than the message text, which a rebuilt copy of the same failure would also satisfy.
			await expect(handler.completePrompt("test prompt")).rejects.toBe(lookupError)
		})

		it("normalizes raw AbortError lookup failures to the provider AbortError", async () => {
			const handler = new RequestyHandler(mockOptions)
			const { getModels } = await import("../fetchers/modelCache")
			const rawAbort = new Error("The user aborted a request")
			rawAbort.name = "AbortError"
			vitest.mocked(getModels).mockImplementationOnce(() => {
				return Promise.reject(rawAbort)
			})

			await expect(handler.completePrompt("test prompt")).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it("rejects with AbortError when aborted mid-flight", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Deterministic synchronization: the mock notifies the
			// test when the request actually starts, so the abort lands mid-flight (after model
			// lookup) instead of winning the race at model discovery on a slow runner.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
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
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort only once create() has actually started (after model lookup).
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
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
				// Pin the complete contract: the timeout must be normalized to the
				// provider abort message, not merely to a generic AbortError name.
				message: "The Requesty request was aborted",
			})
		})

		it("does not return a late result when the response resolves after abort", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			// Emulate the OpenAI SDK: the pending request resolves once the signal aborts,
			// i.e. after the caller has already cancelled.
			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve()
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true })
					}
				})
				return { choices: [{ message: { content: "late" } }] }
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort while the request is in flight; the resolved response is late and must
			// be discarded instead of returned.
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it("discards a completion that resolves in the same turn the caller aborts", async () => {
			// The race above settles at the abort, so the post-completion check is reached only when the
			// SDK wins the race outright: the response promise resolves, the abort lands before the
			// provider continues with the value, and the value must still be discarded. Aborting from a
			// handler on the response promise - queued one step ahead of the provider's race handler -
			// pins that interleaving without timing it.
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			mockCreate.mockImplementationOnce(() => {
				const response = Promise.resolve({ choices: [{ message: { content: "late" } }] })
				void response.then(() => {
					queueMicrotask(() => controller.abort())
				})
				return response
			})

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
		})

		it.each([
			["an empty message content", { choices: [{ message: { content: "" } }] }],
			["no choices at all", { choices: [] }],
		])("returns an empty string when the completion carries %s", async (_label: string, response: unknown) => {
			// The fallback is what makes completePrompt return "" rather than an empty value or a
			// TypeError, and callers render the result directly.
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce(response)

			await expect(handler.completePrompt("test prompt")).resolves.toBe("")
		})

		it("does not forward a non-positive timeout to the client", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {})
		})

		it("rejects with AbortError when both an abort signal and a timeout are provided", async () => {
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
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
			// Defensive: the fast-fail path may reject before the barrier below settles,
			// which would otherwise surface as an unhandled rejection.
			void promise.catch(() => {})
			// Abort only once create() has actually started (after model lookup).
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({ name: "AbortError" })
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

		it("lets the per-request timeout abort the request while the caller signal stays live", async () => {
			// The caller signal is live and never aborted here, so only the timer may end the request.
			// The combined-options test above aborts through the controller and cannot see a merged
			// signal that drops the timeout whenever a caller signal exists; this one hangs if it does.
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let requestSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				notifyCreateStarted()
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

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 25 })
			void promise.catch(() => {})
			await withSettleGuard(createStarted)

			await expect(withSettleGuard(promise)).rejects.toMatchObject({ name: "AbortError" })
			expect(controller.signal.aborted).toBe(false)
			expect(requestSignal).toBeDefined()
			expect(requestSignal).not.toBe(controller.signal)
			expect(requestSignal?.aborted).toBe(true)
		})

		it("settles on abort while the SDK is sleeping between retries instead of waiting for the completion", async () => {
			// openai@5.23.2 runs "await sleep(timeoutMillis)" inside retryRequest before issuing the
			// next attempt, and that sleep does not observe the request signal: awaiting the SDK call
			// alone keeps completePrompt pending for the rest of the backoff (a server-provided
			// retry-after-ms may stretch it to about a minute). The race against the cancellation
			// scope must settle the caller at the abort instead, exactly as the model lookup above
			// already does.
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()

			let notifyCreateStarted!: () => void
			const createStarted = new Promise<void>((resolve) => {
				notifyCreateStarted = resolve
			})
			let releaseBackoff!: () => void
			const backoffSleep = new Promise<void>((resolve) => {
				releaseBackoff = resolve
			})
			let completionSettled = false
			mockCreate.mockImplementationOnce(async () => {
				notifyCreateStarted()
				await backoffSleep
				completionSettled = true
				return { choices: [{ message: { content: "late" } }] }
			})

			const promise = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			// Defensive: the race may reject before the barrier below settles, which would otherwise
			// surface as an unhandled rejection.
			void promise.catch(() => {})
			await withSettleGuard(createStarted)
			controller.abort()

			await expect(withSettleGuard(promise)).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})
			// The caller settled while the SDK was still inside its retry sleep.
			expect(completionSettled).toBe(false)
			releaseBackoff()
		})

		it.each([
			{
				outcome: "completes",
				expectRejection: undefined as string | undefined,
				barrier: undefined as Promise<void> | undefined,
				start: (controller: AbortController) => {
					mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "response" } }] })
					return new RequestyHandler(mockOptions).completePrompt("test prompt", {
						abortSignal: controller.signal,
					})
				},
			},
			{
				outcome: "fails",
				expectRejection: "API Error",
				barrier: undefined as Promise<void> | undefined,
				start: (controller: AbortController) => {
					mockCreate.mockRejectedValueOnce(new Error("API Error"))
					return new RequestyHandler(mockOptions).completePrompt("test prompt", {
						abortSignal: controller.signal,
					})
				},
			},
			{
				// Aborting mid-flight is the third exit path through finally: the SDK-shaped mock
				// rejects once the signal aborts, so dispose() must detach on that path too.
				outcome: "aborts mid-flight",
				expectRejection: "The Requesty request was aborted",
				start: (controller: AbortController) => {
					let notifyStarted!: () => void
					const barrier = new Promise<void>((resolve) => {
						notifyStarted = resolve
					})
					mockCreate.mockImplementationOnce(async (_params: unknown, opts?: { signal?: AbortSignal }) => {
						notifyStarted()
						await new Promise<void>((resolve) =>
							opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
						)
						const abortError = new Error("The user aborted a request")
						abortError.name = "AbortError"
						throw abortError
					})
					return {
						pending: new RequestyHandler(mockOptions).completePrompt("test prompt", {
							abortSignal: controller.signal,
						}),
						barrier,
					}
				},
			},
		] as const)(
			"detaches the abort listener from the caller's signal when the completion $outcome",
			async (item) => {
				// The bridge registers its listener on the caller's long-lived signal, so every exit
				// path - resolve, provider error and abort - must detach it: otherwise one listener plus
				// one per-request controller is retained for every request on a reused signal. The
				// abort case adds nothing the two originals asserted about detaching; it pins that the
				// finally dispose also runs when the request ends by cancellation rather than by settling.
				const controller = new AbortController()
				const addSpy = vitest.spyOn(controller.signal, "addEventListener")
				const removeSpy = vitest.spyOn(controller.signal, "removeEventListener")
				const started = item.start(controller)
				const pending = "pending" in started ? started.pending : started
				const barrier = "pending" in started ? started.barrier : item.barrier
				void pending.catch(() => {})
				try {
					if (barrier) {
						await withSettleGuard(barrier)
						controller.abort()
					}
					if (item.expectRejection) {
						await expect(pending).rejects.toThrow(item.expectRejection)
					} else {
						await pending
					}
					const registered = addSpy.mock.calls.find(([type]) => type === "abort")?.[1]
					expect(registered).toBeDefined()
					expect(removeSpy).toHaveBeenCalledWith("abort", registered)
				} finally {
					addSpy.mockRestore()
					removeSpy.mockRestore()
				}
			},
		)

		it("does not leave the SDK's abort listener on the caller's signal after a completed request", async () => {
			// Emulate openai@5.23.2: its request path attaches an abort listener to the signal it is
			// handed and leaves it attached once the request completes. Reusing one caller signal
			// therefore retains that listener - and the per-request state it closes over - for every
			// completed request, unless the provider hands the SDK a signal that dies with the request.
			const handler = new RequestyHandler(mockOptions)
			const controller = new AbortController()
			let leakedListenerFired = false
			mockCreate.mockImplementationOnce(async (_params: unknown, options?: { signal?: AbortSignal }) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						leakedListenerFired = true
					},
					{ once: true },
				)
				return { choices: [{ message: { content: "response" } }] }
			})

			await handler.completePrompt("test prompt", { abortSignal: controller.signal })

			// Nothing the request created may still be listening on the caller's signal: aborting it
			// now must not reach the listener the SDK installed during the request.
			controller.abort()
			expect(leakedListenerFired).toBe(false)
		})
	})

	describe("model catalog", () => {
		it("reports its cache scope", () => {
			const handler = new RequestyHandler(mockOptions)
			expect(handler.getModelCacheScope()).toEqual({ urlScoped: true, keyScoped: true, authScoped: false })
		})

		it("populates this.models so getModel() stops returning the default info", async () => {
			const handler = new RequestyHandler(mockOptions)

			expect(handler.getModel().info.description).toBe(requestyDefaultModelInfo.description)

			await handler.ensureModelFetched()

			expect(handler.getModel().info.description).toBe("Claude 4 Sonnet")
			expect(handler.getModel().info.contextWindow).toBe(200000)
		})

		it("fetches the catalog with the configured API key", async () => {
			// Requesty enforces per-key model allowlists, so an unauthenticated fetch would
			// both miss the key's models and write a URL-only cache entry that another key
			// could then be served from.
			const handler = new RequestyHandler(mockOptions)

			await handler.ensureModelFetched()

			expect(getModels).toHaveBeenCalledWith(
				{
					provider: providerIdentifiers.requesty,
					apiKey: "test-key",
					baseUrl: "https://router.requesty.ai/v1",
				},
				handler,
			)
		})

		it("fetches the catalog with each handler's own API key", async () => {
			// Two handlers on the same server must resolve different key-scoped cache
			// entries, which is only possible if each passes its own key to getModels().
			const handlerA = new RequestyHandler(makeApiHandlerOptions({ requestyApiKey: "key-a" }))
			const handlerB = new RequestyHandler(makeApiHandlerOptions({ requestyApiKey: "key-b" }))

			await handlerA.ensureModelFetched()
			await handlerB.ensureModelFetched()

			const apiKeys = vitest.mocked(getModels).mock.calls.map(([options]) => options.apiKey)
			expect(apiKeys).toEqual(["key-a", "key-b"])
		})
	})
})
