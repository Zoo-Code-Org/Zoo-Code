// Mock OpenAI client - must come before other imports
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

							return {
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
							}
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
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))

			const stream = handler.createMessage(systemPrompt, messages)

			await expect(async () => {
				for await (const _chunk of stream) {
					// Should not reach here
				}
			}).rejects.toThrow("Please check the LM Studio developer logs to debug what went wrong")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
			expect(mockCreate).toHaveBeenCalledWith({
				model: mockOptions.lmStudioModelId,
				messages: [{ role: "user", content: "Test prompt" }],
				temperature: 0,
				stream: false,
			})
		})

		it("should handle API errors", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow(
				"Please check the LM Studio developer logs to debug what went wrong",
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

	describe("abort signal", () => {
		it("should handle abort signal triggered during request", async () => {
			const controller = new AbortController()

			mockCreate.mockImplementation(async (options: unknown) => {
				return {
					async *[Symbol.asyncIterator]() {
						while (!controller.signal.aborted) {
							await new Promise((resolve) => setTimeout(resolve, 10))
							if (controller.signal.aborted) {
								throw new DOMException("The operation was aborted.", "AbortError")
							}
							yield {
								choices: [{ delta: { content: "response" }, index: 0 }],
								usage: null,
							}
						}
					},
				}
			})

			const stream = handler.createMessage("system", [{ role: "user", content: "Hello" }] as any, {
				taskId: "test",
				tools: [],
				abortSignal: controller.signal,
			})

			setTimeout(() => controller.abort(), 50)

			await expect(async () => {
				for await (const _chunk of stream) {
					// consume stream
				}
			}).rejects.toThrow(/abort/i)
		})

		it("should work normally without abortSignal", async () => {
			const stream = handler.createMessage("system", [{ role: "user", content: "Hello" }] as any)

			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
		})

		it("should abort immediately if signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			mockCreate.mockImplementation(async (options: unknown) => {
				return {
					async *[Symbol.asyncIterator]() {
						if (controller.signal.aborted) {
							throw new DOMException("The operation was aborted.", "AbortError")
						}
						yield {
							choices: [{ delta: { content: "response" }, index: 0 }],
							usage: null,
						}
					},
				}
			})

			const stream = handler.createMessage("system", [{ role: "user", content: "Hello" }] as any, {
				taskId: "test",
				tools: [],
				abortSignal: controller.signal,
			})

			await expect(async () => {
				for await (const _chunk of stream) {
					// consume stream
				}
			}).rejects.toThrow(/abort/i)
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
