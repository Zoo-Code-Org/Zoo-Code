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

		it("should pass timeoutMs through to generateText as a timeout abort signal", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 5000 })

			const { abortSignal } = mockGenerateText.mock.calls[0][0]
			expect(abortSignal).toBeInstanceOf(AbortSignal)
			expect(abortSignal.aborted).toBe(false)
		})

		it("should merge signal and timeout when both are provided", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const controller = new AbortController()
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 10000 })

			const mergedSignal = mockGenerateText.mock.calls[0][0].abortSignal as AbortSignal
			expect(mergedSignal).toBeInstanceOf(AbortSignal)

			// Aborting the external signal must abort the merged signal synchronously
			controller.abort()
			expect(mergedSignal.aborted).toBe(true)
		})

		it("should work without options (backward compatible)", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("response")
			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBeUndefined()
		})

		it("should treat timeoutMs <= 0 as disabled", async () => {
			mockGenerateText.mockResolvedValue({ text: "response" })

			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockGenerateText.mock.calls[0][0].abortSignal).toBeUndefined()

			await handler.completePrompt("test prompt", { timeoutMs: -1 })
			expect(mockGenerateText.mock.calls[1][0].abortSignal).toBeUndefined()
		})

		it("should reject with AbortError when abortSignal is already aborted before request", async () => {
			mockGenerateText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
				if (options.abortSignal?.aborted) {
					const error = new Error("This operation was aborted")
					error.name = "AbortError"
					return Promise.reject(error)
				}
				return Promise.resolve({ text: "response" })
			})

			const controller = new AbortController()
			controller.abort()

			await expect(
				handler.completePrompt("test prompt", { abortSignal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
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
