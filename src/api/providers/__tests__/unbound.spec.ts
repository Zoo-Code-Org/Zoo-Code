import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { UnboundHandler } from "../unbound"

vi.mock("openai", () => {
	const createMock = vi.fn()
	return {
		default: vi.fn(function () {
			return {
				chat: {
					completions: {
						create: createMock,
					},
				},
			}
		}),
	}
})

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({
		"openai/gpt-4o": {
			maxTokens: 4096,
			contextWindow: 128000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 2.5,
			outputPrice: 10,
			description: "GPT-4o",
		},
	}),
}))

describe("UnboundHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("identifies itself as Zoo Code in the Unbound request headers", () => {
		new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultHeaders: expect.objectContaining({
					"X-Unbound-Metadata": JSON.stringify({ labels: [{ key: "app", value: "zoo-code" }] }),
				}),
			}),
		)
	})

	it("streams reasoning chunks from delta.reasoning_content", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { choices: [{ delta: { reasoning_content: "thinking..." } }] }
				yield { choices: [{ delta: { content: "answer" } }] }
				yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
			},
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], {
			taskId: "t",
			tools: [],
		})) {
			chunks.push(chunk)
		}

		expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
	})

	it("falls back to delta.reasoning when reasoning_content is absent", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { choices: [{ delta: { reasoning: "router-style thought" } }] }
				yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
			},
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], {
			taskId: "t",
			tools: [],
		})) {
			chunks.push(chunk)
		}

		expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
	})

	it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create

		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					choices: [
						{
							delta: {
								reasoning_content: "primary thought",
								reasoning: "fallback thought",
							},
						},
					],
				}
				yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
			},
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const chunks: any[] = []

		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], {
			taskId: "t",
			tools: [],
		})) {
			chunks.push(chunk)
		}

		const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")

		expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
	})

	it("identifies itself as Zoo Code in per-request Unbound metadata", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					choices: [{ delta: { content: "ok" } }],
				}
				yield {
					choices: [{ delta: {} }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}
			},
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "hello" }]
		const stream = handler.createMessage("system", messages, {
			taskId: "task-123",
			mode: "architect",
			tools: [],
		})

		for await (const _chunk of stream) {
			// drain stream
		}

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				unbound_metadata: {
					originApp: "zoo-code",
					taskId: "task-123",
					mode: "architect",
				},
			}),
			undefined,
		)
	})

	it("completePrompt returns the response text", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "completed text" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const result = await handler.completePrompt("Write a haiku")
		expect(result).toBe("completed text")
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [{ role: "system", content: "Write a haiku" }],
			}),
		)
	})

	describe("abort signal", () => {
		it("should handle abort signal triggered during request", async () => {
			const controller = new AbortController()
			const mockCreateLocal = vi.fn().mockImplementation(async (options: unknown) => {
				return {
					async *[Symbol.asyncIterator]() {
						while (!controller.signal.aborted) {
							yield { choices: [{ delta: { content: "response" } }], usage: null }
							await new Promise((resolve) => setTimeout(resolve, 10))
						}
						throw new Error("AbortError: The operation was aborted")
					},
				}
			})

			vi.mocked(OpenAI).mockImplementation(
				() =>
					({
						chat: { completions: { create: mockCreateLocal } as any } as any,
					}) as any,
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
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
			const mockCreateLocal = vi.fn().mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "Hello" } }], usage: null }
					yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
				},
			})

			vi.mocked(OpenAI).mockImplementation(
				() =>
					({
						chat: { completions: { create: mockCreateLocal } as any } as any,
					}) as any,
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
			})

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

			const mockCreateLocal = vi.fn().mockImplementation(async (options: unknown) => {
				return {
					async *[Symbol.asyncIterator]() {
						if (controller.signal.aborted) {
							throw new Error("AbortError: The operation was aborted")
						}
						yield { choices: [{ delta: { content: "response" } }], usage: null }
					},
				}
			})

			vi.mocked(OpenAI).mockImplementation(
				() =>
					({
						chat: { completions: { create: mockCreateLocal } as any } as any,
					}) as any,
			)

			const handler = new UnboundHandler({
				unboundApiKey: "test-key",
				unboundModelId: "openai/gpt-4o",
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
})
