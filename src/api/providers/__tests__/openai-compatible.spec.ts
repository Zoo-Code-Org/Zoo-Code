// npx vitest run api/providers/__tests__/openai-compatible.spec.ts

import { OpenAICompatibleHandler } from "../openai-compatible"
import { makeApiHandlerOptions } from "../../../test-utils/api"
import { collectStream } from "../../../test-utils/stream"

const mockGenerateText = vitest.fn()
const mockStreamText = vitest.fn()

// The factory must not touch the mock bindings at factory-execution time (vi.mock is
// hoisted above the consts), so forward lazily through wrapper functions.
vitest.mock("ai", () => ({
	generateText: (...args: unknown[]) => mockGenerateText(...(args as [])),
	streamText: (...args: unknown[]) => mockStreamText(...(args as [])),
}))

// Concrete test implementation of the abstract OpenAI-compatible base class
class TestOpenAICompatibleHandler extends OpenAICompatibleHandler {
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

describe("OpenAICompatibleHandler", () => {
	let handler: TestOpenAICompatibleHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new TestOpenAICompatibleHandler("test-api-key")
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
