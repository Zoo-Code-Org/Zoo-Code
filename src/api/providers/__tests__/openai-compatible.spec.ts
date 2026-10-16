// Use vi.hoisted to define mock functions that can be referenced in hoisted vi.mock() calls
const { mockStreamText, mockGenerateText } = vi.hoisted(() => ({
	mockStreamText: vi.fn(),
	mockGenerateText: vi.fn(),
}))

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return {
		...actual,
		streamText: mockStreamText,
		generateText: mockGenerateText,
	}
})

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(function () {
		// Return a function that returns a mock language model
		return vi.fn(() => ({
			modelId: "test-model",
			provider: "openai-compatible",
		}))
	}),
}))

import type { Anthropic } from "@anthropic-ai/sdk"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "../openai-compatible"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { APICallError, type LanguageModel } from "ai"
import { makeApiHandlerOptions } from "../../../test-utils/api"
import { collectStream } from "../../../test-utils/stream"

/** Error shape produced when the upstream API responds with a 4xx/5xx status. */
type StatusedError = Error & { status: number }

// Concrete implementation for testing
class TestOpenAICompatibleHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions, config: OpenAICompatibleConfig) {
		super(options, config)
	}

	override getModel() {
		return {
			id: this.config.modelId,
			info: this.config.modelInfo,
			maxTokens: this.config.modelMaxTokens,
			temperature: this.config.temperature,
		}
	}
}

describe("OpenAICompatibleHandler", () => {
	let handler: TestOpenAICompatibleHandler
	let mockOptions: ApiHandlerOptions
	let mockConfig: OpenAICompatibleConfig

	const systemPrompt = "You are a helpful assistant."
	const messages: Anthropic.Messages.MessageParam[] = [
		{
			role: "user",
			content: [{ type: "text", text: "Hello!" }],
		},
	]

	beforeEach(() => {
		mockOptions = {
			apiModelId: "test-model",
			apiKey: "test-api-key",
		}
		mockConfig = {
			providerName: "TestProvider",
			baseURL: "https://api.test.com/v1",
			apiKey: "test-api-key",
			modelId: "test-model",
			modelInfo: {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: true,
			},
		}
		handler = new TestOpenAICompatibleHandler(mockOptions, mockConfig)
		vi.clearAllMocks()
	})

	describe("constructor", () => {
		it("should initialize with provided options and config", () => {
			expect(handler).toBeInstanceOf(TestOpenAICompatibleHandler)
			expect(handler.getModel().id).toBe(mockConfig.modelId)
		})
	})

	describe("createMessage", () => {
		it("should handle streaming responses", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 10,
				outputTokens: 5,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should map cache read and reasoning tokens from ai v7 usage details", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "ok" }
			}

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: Promise.resolve({
					inputTokens: 20,
					outputTokens: 10,
					inputTokenDetails: { cacheReadTokens: 7 },
					outputTokenDetails: { reasoningTokens: 4 },
					raw: {},
				}),
			})

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				chunks.push(chunk)
			}

			expect(chunks.find((chunk) => chunk.type === "usage")).toEqual({
				type: "usage",
				inputTokens: 20,
				outputTokens: 10,
				cacheReadTokens: 7,
				reasoningTokens: 4,
			})
		})

		it("should handle multiple stream parts and yield usage metrics", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "First part" }
				yield { type: "text-delta", text: "Second part" }
				yield { type: "tool-call", toolCallId: "123", toolName: "test_tool", input: "{}" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 20,
				outputTokens: 10,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(2)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("First part")
			expect(textChunks[1].text).toBe("Second part")

			const toolChunks = chunks.filter((chunk) => chunk.type === "tool_call")
			expect(toolChunks).toHaveLength(1)
			expect(toolChunks[0].id).toBe("123")
			expect(toolChunks[0].name).toBe("test_tool")
			expect(toolChunks[0].arguments).toBe("{}")

			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(1)
		})

		it("should handle stream without usage metrics", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Test response" }
			}

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: Promise.resolve(undefined),
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(0)
		})

		it("should handle tool-call events in stream", async () => {
			async function* mockFullStream() {
				yield { type: "text-delta", text: "Calling tool" }
				yield { type: "tool-input-start", id: "tc_1", toolName: "read_file" }
				yield { type: "tool-input-delta", id: "tc_1", delta: '{"path":"test.ts"}' }
				yield { type: "tool-input-end", id: "tc_1" }
			}

			const mockUsage = Promise.resolve({
				inputTokens: 15,
				outputTokens: 8,
				details: {},
				raw: {},
			})

			mockStreamText.mockReturnValue({
				fullStream: mockFullStream(),
				usage: mockUsage,
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolChunks = chunks.filter(
				(chunk) =>
					chunk.type === "tool_call_start" ||
					chunk.type === "tool_call_delta" ||
					chunk.type === "tool_call_end",
			)
			expect(toolChunks.map((chunk) => chunk.type)).toEqual([
				"tool_call_start",
				"tool_call_delta",
				"tool_call_end",
			])
			expect(toolChunks[0]).toMatchObject({ type: "tool_call_start", id: "tc_1", name: "read_file" })
			expect(toolChunks[1]).toMatchObject({ type: "tool_call_delta", id: "tc_1", delta: '{"path":"test.ts"}' })
			expect(toolChunks[2]).toMatchObject({ type: "tool_call_end", id: "tc_1" })
		})

		// Test 1: createMessage() with a real AI SDK APICallError 429 (the AI SDK
		// exposes the HTTP status as statusCode, not status) →verify the wrapped error
		// surfaces .status === 429 and the provider name in its message.
		it("should throw error with .status 429 when API returns 429", async () => {
			const rateLimitError = new APICallError({
				message: "Rate limited",
				statusCode: 429,
				url: "https://test.invalid/v1/chat/completions",
				requestBodyValues: {},
			})

			mockStreamText.mockReturnValue({
				// eslint-disable-next-line require-yield
				fullStream: (async function* () {
					throw rateLimitError
				})(),
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, details: {}, raw: {} }),
			})

			let thrownError: StatusedError | undefined
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					void chunk // Use void to satisfy no-unused-expressions rule
				}
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected createMessage to throw")
			}
			expect(thrownError.status).toBe(429)
			expect(thrownError.message).toContain("TestProvider")
		})

		// Test 2: createMessage() with mock 500 response →verify error is properly tagged
		it("should throw error with .status 500 and provider name when API returns 500", async () => {
			const serverError = Object.assign(new Error("Internal Server Error"), { status: 500 })

			mockStreamText.mockReturnValue({
				// eslint-disable-next-line require-yield
				fullStream: (async function* () {
					throw serverError
				})(),
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, details: {}, raw: {} }),
			})

			let thrownError: StatusedError | undefined
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					void chunk
				}
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected createMessage to throw")
			}
			expect(thrownError.status).toBe(500)
			expect(thrownError.message).toContain("TestProvider")
		})

		it("should surface a streamed error part through handleOpenAIError with status and provider name", async () => {
			const rateLimitError = Object.assign(new Error("Rate limited"), { status: 429 })

			mockStreamText.mockReturnValue({
				fullStream: (async function* () {
					yield { type: "text-delta", text: "partial" }
					yield { type: "error", error: rateLimitError }
				})(),
				usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, details: {}, raw: {} }),
			})

			const chunks: ApiStreamChunk[] = []
			let thrownError: StatusedError | undefined
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					chunks.push(chunk)
				}
			} catch (e) {
				thrownError = e as StatusedError
			}

			// The text delta before the error part is still yielded; the error part itself
			// must throw the wrapped error instead of being emitted as a chunk.
			expect(chunks).toEqual([{ type: "text", text: "partial" }])
			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected createMessage to throw")
			}
			expect(thrownError.status).toBe(429)
			// Single wrap: exactly one provider prefix, so a redundant re-wrap inside the
			// stream loop would duplicate it and fail this exact-message assertion.
			expect(thrownError.message).toBe("TestProvider completion error: Rate limited")
		})

		it("should wrap a synchronous streamText() failure with status and provider name", async () => {
			const rateLimitError = Object.assign(new Error("Rate limited"), { status: 429 })

			mockStreamText.mockImplementation(() => {
				throw rateLimitError
			})

			let thrownError: StatusedError | undefined
			try {
				// The generator body runs on the first next(): the synchronous streamText()
				// throw must surface here as a wrapped error with status and provider name.
				await handler.createMessage(systemPrompt, messages).next()
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected createMessage to throw")
			}
			expect(thrownError.status).toBe(429)
			expect(thrownError.message).toContain("TestProvider")
		})

		// The usage read happens after the stream drains: a rejection there must still be
		// wrapped once with status and provider name by the same catch path.
		it("should wrap a result.usage failure with status and provider name", async () => {
			const usageError = Object.assign(new Error("usage failed"), { status: 500 })

			mockStreamText.mockReturnValue({
				fullStream: (async function* () {
					yield { type: "text-delta", text: "done" }
				})(),
				usage: Promise.reject(usageError),
			})

			const chunks: ApiStreamChunk[] = []
			let thrownError: StatusedError | undefined
			try {
				for await (const chunk of handler.createMessage(systemPrompt, messages)) {
					chunks.push(chunk)
				}
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(chunks).toEqual([{ type: "text", text: "done" }])
			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected createMessage to throw")
			}
			expect(thrownError.status).toBe(500)
			expect(thrownError.message).toBe("TestProvider completion error: usage failed")
		})
	})

	describe("completePrompt", () => {
		it("should complete a prompt using generateText", async () => {
			mockGenerateText.mockResolvedValue({
				text: "Test completion",
			})

			const result = await handler.completePrompt("Test prompt")

			expect(result).toBe("Test completion")
			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: "Test prompt",
				}),
			)
		})

		// The configured temperature must reach generateText unchanged: the `?? 0` fallback must
		// not degrade to a boolean-and (which would hand generateText 0 or undefined instead of the
		// configured value).
		it("passes the configured temperature through to generateText", async () => {
			mockConfig.temperature = 0.7
			const handlerWithTemp = new TestOpenAICompatibleHandler(mockOptions, mockConfig)
			mockGenerateText.mockResolvedValue({ text: "ok" })

			await handlerWithTemp.completePrompt("Test prompt")

			expect(mockGenerateText).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: "Test prompt",
					temperature: 0.7,
				}),
			)
		})

		// Test 3: completePrompt() with mock 4xx/5xx →verify error carries .status and provider name
		it("should throw error with .status and provider name when generateText throws 400", async () => {
			const badRequestError = Object.assign(new Error("Bad Request"), { status: 400 })

			mockGenerateText.mockRejectedValue(badRequestError)

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("TestProvider")

			let thrownError: StatusedError | undefined
			try {
				await handler.completePrompt("Test prompt")
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected completePrompt to throw")
			}
			expect(thrownError.status).toBe(400)
			expect(thrownError.message).toContain("TestProvider")
		})

		it("should throw error with .status and provider name when generateText throws 500", async () => {
			const serverError = Object.assign(new Error("Internal Server Error"), { status: 500 })

			mockGenerateText.mockRejectedValue(serverError)

			let thrownError: StatusedError | undefined
			try {
				await handler.completePrompt("Test prompt")
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected completePrompt to throw")
			}
			expect(thrownError.status).toBe(500)
			expect(thrownError.message).toContain("TestProvider")
		})

		// The language-model lookup fails before generateText() is ever reached: the
		// completePrompt try block must wrap that failure with status and provider name.
		it("should wrap a getLanguageModel() failure with status and provider name", async () => {
			const modelError = Object.assign(new Error("model unavailable"), { status: 401 })

			class FailingModelHandler extends TestOpenAICompatibleHandler {
				override getLanguageModel(): LanguageModel {
					throw modelError
				}
			}
			const failingHandler = new FailingModelHandler(mockOptions, mockConfig)

			let thrownError: StatusedError | undefined
			try {
				await failingHandler.completePrompt("Test prompt")
			} catch (e) {
				thrownError = e as StatusedError
			}

			expect(thrownError).toBeInstanceOf(Error)
			if (!thrownError) {
				throw new Error("Expected completePrompt to throw")
			}
			expect(thrownError.status).toBe(401)
			expect(thrownError.message).toContain("TestProvider")
			expect(mockGenerateText).not.toHaveBeenCalled()
		})
	})
})

// mockGenerateText/mockStreamText: the hoisted module mocks declared at the top of this file.

// Concrete test implementation of the abstract OpenAI-compatible base class
class AbortWiringHandler extends OpenAICompatibleHandler {
	constructor(apiKey: string) {
		super(makeApiHandlerOptions({ apiModelId: "test-model" }), {
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			apiKey,
			modelId: "test-model",
			modelInfo: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		})
	}

	override getModel() {
		return { id: "test-model", info: this.config.modelInfo }
	}
}

function makeEmptyStreamResult() {
	return {
		fullStream: {
			[Symbol.asyncIterator]: async function* () {
				// Emit no parts
				yield* []
			},
		},
		usage: Promise.resolve(undefined),
	}
}

describe("OpenAICompatibleHandler abort wiring", () => {
	let handler: AbortWiringHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new AbortWiringHandler("test-api-key")
	})

	describe("completePrompt", () => {
		it("should return message content from successful response", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("response")
			expect(mockGenerateText).toHaveBeenCalledTimes(1)
			expect(mockGenerateText.mock.calls[0][0].prompt).toBe("test prompt")
		})

		it("should pass abortSignal through to generateText", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const controller = new AbortController()
			await handler.completePrompt("test prompt", { abortSignal: controller.signal })

			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBe(controller.signal)
		})

		it("should pass timeoutMs through to generateText as a working timeout abort signal", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 50 })

			const { abortSignal } = mockGenerateText.mock.calls[0][0]
			expect(abortSignal).toBeInstanceOf(AbortSignal)
			expect(abortSignal.aborted).toBe(false)

			// A never-expiring signal (or a pre-aborted one) would fail this check:
			// the signal must fire on its own ~50ms timeout without any external abort.
			let guardTimer: ReturnType<typeof setTimeout> | undefined
			const fired = await Promise.race([
				new Promise<boolean>((resolve) => {
					abortSignal.addEventListener("abort", () => resolve(true), { once: true })
				}),
				new Promise<boolean>((resolve) => {
					guardTimer = setTimeout(() => resolve(false), 1000)
				}),
			])
			try {
				expect(fired).toBe(true)
				expect(abortSignal.aborted).toBe(true)
			} finally {
				// Clear the guard timer so a winning abort event does not leave an
				// active timer behind that delays worker teardown.
				clearTimeout(guardTimer)
			}
		})

		it("should merge signal and timeout when both are provided", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const controller = new AbortController()
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 50 })

			const mergedSignal = mockGenerateText.mock.calls[0][0].abortSignal as AbortSignal
			expect(mergedSignal).toBeInstanceOf(AbortSignal)
			expect(mergedSignal.aborted).toBe(false)

			// Aborting the external signal must abort the merged signal synchronously
			controller.abort()
			expect(mergedSignal.aborted).toBe(true)
		})

		it("should reject with AbortError when the caller aborts while the request is pending", async () => {
			// Keep generateText pending and reject only when the signal aborts, so the
			// assertion covers the provider's in-flight cancellation path: a mock that
			// resolves immediately would settle completePrompt before any cancellation
			// is observable. This also pins the merged catch's abort guard - the raw
			// DOMException must survive without the provider error-wrap.
			mockGenerateText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
				return new Promise<{ text: string }>((resolve, reject) => {
					const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"))
					if (options.abortSignal?.aborted) {
						onAbort()
						return
					}
					options.abortSignal?.addEventListener("abort", onAbort, { once: true })
				})
			})

			const controller = new AbortController()
			const pending = handler.completePrompt("test prompt", { abortSignal: controller.signal })
			controller.abort()

			await expect(pending).rejects.toMatchObject({
				name: "AbortError",
				message: "The operation was aborted.",
			})
		})

		it("should let the timeout component of a merged signal fire without the caller signal", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			await handler.completePrompt("test prompt", { abortSignal: new AbortController().signal, timeoutMs: 50 })

			const mergedSignal = mockGenerateText.mock.calls[0][0].abortSignal as AbortSignal
			expect(mergedSignal).toBeInstanceOf(AbortSignal)
			expect(mergedSignal.aborted).toBe(false)

			// With the caller signal left untouched, only the timeout component can fire
			let guardTimer: ReturnType<typeof setTimeout> | undefined
			const fired = await Promise.race([
				new Promise<boolean>((resolve) => {
					mergedSignal.addEventListener("abort", () => resolve(true), { once: true })
				}),
				new Promise<boolean>((resolve) => {
					guardTimer = setTimeout(() => resolve(false), 1000)
				}),
			])
			try {
				expect(fired).toBe(true)
				expect(mergedSignal.aborted).toBe(true)
			} finally {
				// Clear the guard timer so a winning abort event does not leave an
				// active timer behind that delays worker teardown.
				clearTimeout(guardTimer)
			}
		})

		it("should work without options (backward compatible)", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("response")
			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBeUndefined()
			// The property must be absent entirely: an unconditional assignment would
			// leave it present with an undefined value, which `toBeUndefined` cannot see.
			expect("abortSignal" in mockGenerateText.mock.calls[0][0]).toBe(false)
		})

		it("should treat timeoutMs <= 0 as disabled", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBeUndefined()

			await handler.completePrompt("test prompt", { timeoutMs: -1 })
			expect(mockGenerateText.mock.calls[1][0].abortSignal).toBeUndefined()
		})

		it("should pass the caller signal unchanged when timeoutMs is 0", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const controller = new AbortController()
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 0 })

			// A disabled timeout must not drop the caller's cancellation signal
			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBe(controller.signal)
		})

		it("should pass the caller signal unchanged when timeoutMs is negative", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const controller = new AbortController()
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: -1 })

			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBe(controller.signal)
		})

		it("should reject with the real DOMException AbortError when the signal is pre-aborted", async () => {
			// Emulate the real AI SDK: a pre-aborted signal makes the request reject
			// with the fetch stack's DOMException abort error rather than a fabricated
			// Error, so this exercises the provider's pass-through of a real SDK
			// abort. openai-compatible.ts has no normalization layer, so the
			// DOMException must surface unchanged (name and message).
			mockGenerateText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
				if (options.abortSignal?.aborted) {
					return Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
				}
				return Promise.resolve({ text: "response" })
			})

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
				message: "The operation was aborted.",
			})
		})

		it("should throw handled error when API call fails", async () => {
			mockGenerateText.mockRejectedValue(new Error("Network error"))

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Network error")
		})
	})

	describe("createMessage", () => {
		it("should pass the external abortSignal to streamText", async () => {
			mockStreamText.mockReturnValue(makeEmptyStreamResult())

			const controller = new AbortController()
			const stream = handler.createMessage("You are helpful.", [], {
				taskId: "test",
				abortSignal: controller.signal,
			})
			await collectStream(stream)

			expect(mockStreamText).toHaveBeenCalledTimes(1)
			expect(mockStreamText.mock.calls[0][0].abortSignal).toBe(controller.signal)
		})

		it("should not set an abortSignal when metadata has none", async () => {
			mockStreamText.mockReturnValue(makeEmptyStreamResult())

			const stream = handler.createMessage("You are helpful.", [], { taskId: "test" })
			await collectStream(stream)

			expect(mockStreamText.mock.calls[0][0].abortSignal).toBeUndefined()
			// The property must be absent entirely (an unconditional assignment would
			// leave it present with an undefined value).
			expect("abortSignal" in mockStreamText.mock.calls[0][0]).toBe(false)
		})

		it("should complete without metadata and leave the abortSignal property unset", async () => {
			mockStreamText.mockReturnValue(makeEmptyStreamResult())

			const stream = handler.createMessage("You are helpful.", [])
			await collectStream(stream)

			expect(mockStreamText).toHaveBeenCalledTimes(1)
			// createMessage without metadata must not throw and must leave the
			// property absent: metadata?.abortSignal is undefined when metadata is absent.
			expect("abortSignal" in mockStreamText.mock.calls[0][0]).toBe(false)
		})

		it("should reject with AbortError when the external abortSignal is pre-aborted", async () => {
			mockStreamText.mockImplementation((options: { abortSignal?: AbortSignal }) => ({
				fullStream: {
					[Symbol.asyncIterator]: async function* () {
						if (options.abortSignal?.aborted) {
							const error = new Error("This operation was aborted")
							error.name = "AbortError"
							throw error
						}
						yield* []
					},
				},
				usage: Promise.resolve(undefined),
			}))

			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage("You are helpful.", [], {
				taskId: "test",
				abortSignal: controller.signal,
			})
			await expect(collectStream(stream)).rejects.toMatchObject({ name: "AbortError" })
		})

		it("should abort the stream when the external abortSignal is aborted mid-request", async () => {
			mockStreamText.mockImplementation((options: { abortSignal?: AbortSignal }) => ({
				fullStream: {
					[Symbol.asyncIterator]: async function* () {
						// Emulate a slow model response that ends when the request is aborted
						await new Promise<void>((resolve) => {
							options.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
						})
						yield* []
						const error = new Error("This operation was aborted")
						error.name = "AbortError"
						throw error
					},
				},
				usage: Promise.resolve(undefined),
			}))

			const controller = new AbortController()
			const stream = handler.createMessage("You are helpful.", [], {
				taskId: "test",
				abortSignal: controller.signal,
			})
			const collected = collectStream(stream)
			setTimeout(() => controller.abort(), 10)

			await expect(collected).rejects.toMatchObject({ name: "AbortError" })
		})
	})
})
