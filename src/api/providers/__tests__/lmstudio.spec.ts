// Mock OpenAI client - must come before other imports
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const mockCreate = vi.fn()
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (options) => {
							if (!options.stream) {
								return {
									id: "test-completion",
									choices: [
										{
											message: { role: "assistant", content: "Test response" },
											finish_reason: "stop",
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
									},
								}
							}

							return asyncStreamFrom([
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
							])
						}),
					},
				},
			}
		}),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"

import { LmStudioHandler } from "../lm-studio"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("LmStudioHandler", () => {
	let handler: LmStudioHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "local-model",
			lmStudioModelId: "local-model",
			lmStudioBaseUrl: "http://localhost:1234",
		}
		handler = new LmStudioHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(LmStudioHandler)
			expect(handler.getModel().id).toBe(mockOptions.lmStudioModelId)
		})

		it("should use default base URL if not provided", () => {
			const handlerWithoutUrl = new LmStudioHandler({
				apiModelId: "local-model",
				lmStudioModelId: "local-model",
			})
			expect(handlerWithoutUrl).toBeInstanceOf(LmStudioHandler)
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello!",
			},
		]

		it("should handle streaming responses", async () => {
			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should forward an abort signal to the client request", async () => {
			const controller = new AbortController()

			let releaseStream!: () => void
			const streamGate = new Promise<void>((resolve) => {
				releaseStream = resolve
			})
			mockCreate.mockImplementationOnce(async () => {
				await streamGate
				return asyncStreamFrom([{ choices: [{ delta: { content: "Test response" }, index: 0 }], usage: null }])
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task",
				abortSignal: controller.signal,
			})
			const collected = collectStream(stream).catch((error: unknown) => error)

			// The stream is still open, so the abort can only reach the request signal through
			// the bridge: the provider's finally block has not run yet.
			await new Promise((resolve) => setTimeout(resolve, 20))
			const options = mockCreate.mock.calls[0][1] as { signal?: AbortSignal }
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ stream: true }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
			expect(options.signal?.aborted).toBe(false)

			controller.abort()
			expect(options.signal?.aborted).toBe(true)

			releaseStream()
			await collected
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			// Regression: Qwen3 / DeepSeek-R1 style models served by LM Studio emit
			// thinking via reasoning_content, not <think> tags inside content.
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] },
					{ choices: [{ delta: { content: "answer" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
			expect(chunks).toContainEqual({ type: "text", text: "answer" })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			// When both reasoning_content and reasoning are set, only reasoning_content
			// should be emitted as a reasoning chunk (not both).
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
								index: 0,
							},
						],
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		it("still parses <think> tags embedded in content", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>tagged thought</think>visible" }, index: 0 }] },
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({ type: "reasoning", text: "tagged thought" })
			expect(chunks).toContainEqual({ type: "text", text: "visible" })
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage(systemPrompt, messages)

			await expect(collectStream(stream)).rejects.toThrow(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})

		it("should not issue the request when the caller aborts while input token counting is pending", async () => {
			const controller = new AbortController()
			let releaseCount!: () => void
			const countGate = new Promise<void>((resolve) => {
				releaseCount = resolve
			})
			const countSpy = vi.spyOn(handler, "countTokens").mockImplementation(async () => {
				await countGate
				return 10
			})

			const stream = handler.createMessage(systemPrompt, messages, {
				taskId: "test-task-id",
				abortSignal: controller.signal,
			})
			const pending = collectStream(stream).catch((error: unknown) => error)

			// Let the generator reach the token count, then abort while it is pending.
			const start = Date.now()
			while (countSpy.mock.calls.length === 0) {
				if (Date.now() - start > 5000) {
					throw new Error("timed out waiting for the token count")
				}
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
			controller.abort()

			try {
				// The count gate is still closed, so cancellation itself has to settle the
				// pending count. Releasing the gate first would let counting finish normally
				// and the later pre-request abort check would make this pass anyway.
				const raced = await Promise.race([
					pending,
					new Promise((resolve) => setTimeout(() => resolve(undefined), 300)),
				])
				expect(raced).toBeInstanceOf(Error)
				expect((raced as Error).name).toBe("AbortError")
				expect((raced as Error).message).toBe("The LM Studio request was aborted")
			} finally {
				releaseCount()
			}

			expect(mockCreate).not.toHaveBeenCalled()
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.lmStudioModelId,
					messages: [{ role: "user", content: "Test prompt" }],
					temperature: 0,
					stream: false,
				},
				undefined, // no abort signal or timeout: no request options reach the SDK
			)
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				"Please check the LM Studio developer logs to debug what went wrong. You may need to load the model with a larger context length to work with Zoo Code's prompts.",
			)
		})

		it("should handle empty response", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "" } }],
			})
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})
	})

	describe("getModel", () => {
		it("should return model info", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.id).toBe(mockOptions.lmStudioModelId)
			expect(modelInfo.info).toBeDefined()
			expect(modelInfo.info.maxTokens).toBe(-1)
			expect(modelInfo.info.contextWindow).toBe(128_000)
		})
	})
})
