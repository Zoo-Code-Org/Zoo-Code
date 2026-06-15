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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
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

	it("yields tool_call_partial chunks when delta contains tool_calls", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										function: { name: "read_file", arguments: '{"path":' },
									},
								],
							},
						},
					],
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
		const stream = handler.createMessage("system", messages, { taskId: "task-1", mode: "code", tools: [] })

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const toolPartials = chunks.filter((c) => c.type === "tool_call_partial")
		expect(toolPartials.length).toBeGreaterThanOrEqual(1)
		expect(toolPartials[0].name).toBe("read_file")
	})

	it("completePrompt returns response content", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "completion result" } }],
		})

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const result = await handler.completePrompt("do this")
		expect(result).toBe("completion result")
	})

	it("completePrompt throws on API error", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockRejectedValue(new Error("api down"))

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		await expect(handler.completePrompt("do this")).rejects.toThrow()
	})

	it("createMessage throws on API error", async () => {
		const mockCreate = (OpenAI as unknown as any)().chat.completions.create
		mockCreate.mockRejectedValue(new Error("api down"))

		const handler = new UnboundHandler({
			unboundApiKey: "test-key",
			unboundModelId: "openai/gpt-4o",
		})

		const stream = handler.createMessage("system", [{ role: "user", content: "hi" }])
		await expect(async () => {
			for await (const _chunk of stream) {
				// should throw
			}
		}).rejects.toThrow()
	})
})
