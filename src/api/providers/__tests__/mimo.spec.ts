const mockCreate = vi.fn()
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(() => ({
			chat: {
				completions: {
					create: mockCreate.mockImplementation(async (options) => {
						return {
							[Symbol.asyncIterator]: async function* () {
								yield {
									choices: [{ delta: { content: "Test response" }, index: 0 }],
									usage: null,
								}
								yield {
									choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 5,
										total_tokens: 15,
										prompt_tokens_details: { cached_tokens: 2 },
									},
								}
							},
						}
					}),
				},
			},
		})),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"
import { mimoDefaultModelId, mimoModels } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../shared/api"
import { MimoHandler } from "../mimo"

describe("MimoHandler", () => {
	let handler: MimoHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			mimoApiKey: "test-api-key",
			apiModelId: "mimo-v2.5-pro",
			mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		}
		handler = new MimoHandler(mockOptions)
		vi.clearAllMocks()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(MimoHandler)
			expect(handler.getModel().id).toBe("mimo-v2.5-pro")
		})

		it("should use default model ID if not provided", () => {
			const handlerWithoutModel = new MimoHandler({
				...mockOptions,
				apiModelId: undefined,
			})
			expect(handlerWithoutModel.getModel().id).toBe(mimoDefaultModelId)
		})

		it("should use Singapore base URL if not provided", () => {
			const h = new MimoHandler({ ...mockOptions, mimoBaseUrl: undefined })
			expect(h).toBeInstanceOf(MimoHandler)
		})

		it("should use custom base URL when provided", () => {
			const h = new MimoHandler({ ...mockOptions, mimoBaseUrl: "https://api.xiaomimimo.com/v1" })
			expect(h).toBeInstanceOf(MimoHandler)
		})
	})

	describe("getModel", () => {
		it("should return correct model info for mimo-v2.5-pro", () => {
			const model = handler.getModel()
			expect(model.id).toBe("mimo-v2.5-pro")
			expect(model.info.contextWindow).toBe(1_048_576)
			expect(model.info.maxTokens).toBe(131_072)
			expect(model.info.inputPrice).toBe(1.0)
			expect(model.info.outputPrice).toBe(3.0)
		})

		it("should return correct model info for mimo-v2.5", () => {
			const h = new MimoHandler({ ...mockOptions, apiModelId: "mimo-v2.5" })
			const model = h.getModel()
			expect(model.id).toBe("mimo-v2.5")
			expect(model.info.inputPrice).toBe(0.4)
			expect(model.info.outputPrice).toBe(2.0)
		})

		it("should return correct model info for mimo-v2-flash", () => {
			const h = new MimoHandler({ ...mockOptions, apiModelId: "mimo-v2-flash" })
			const model = h.getModel()
			expect(model.id).toBe("mimo-v2-flash")
			expect(model.info.contextWindow).toBe(262_144)
			expect(model.info.maxTokens).toBe(65_536)
		})

		it("should fallback to default model for unknown model ID", () => {
			const h = new MimoHandler({ ...mockOptions, apiModelId: "unknown-model" })
			const model = h.getModel()
			expect(model.id).toBe("unknown-model")
			expect(model.info).toBe(mimoModels["mimo-v2.5-pro"])
		})
	})

	describe("convertToolsForOpenAI", () => {
		it("should return undefined for undefined tools", () => {
			const result = (handler as any).convertToolsForOpenAI(undefined)
			expect(result).toBeUndefined()
		})

		it("should strip strict: true from function tools", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
							required: ["path"],
						},
						strict: true,
					},
				},
			]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0].function.strict).toBeUndefined()
		})

		it("should strip additionalProperties: false from schemas", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							additionalProperties: false,
							properties: { path: { type: "string" } },
						},
					},
				},
			]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0].function.parameters.additionalProperties).toBeUndefined()
		})

		it("should recursively strip additionalProperties from nested objects", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "test",
						parameters: {
							type: "object",
							additionalProperties: false,
							properties: {
								nested: {
									type: "object",
									additionalProperties: false,
									properties: {
										deep: { type: "string" },
									},
								},
							},
						},
					},
				},
			]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0].function.parameters.additionalProperties).toBeUndefined()
			expect(result[0].function.parameters.properties.nested.additionalProperties).toBeUndefined()
		})

		it("should strip additionalProperties from array items", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "test",
						parameters: {
							type: "object",
							properties: {
								tags: {
									type: "array",
									items: {
										type: "object",
										additionalProperties: false,
										properties: { name: { type: "string" } },
									},
								},
							},
						},
					},
				},
			]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0].function.parameters.properties.tags.items.additionalProperties).toBeUndefined()
		})

		it("should preserve non-function tools unchanged", () => {
			const tools = [{ type: "web_search", web_search: {} }]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0]).toEqual({ type: "web_search", web_search: {} })
		})

		it("should preserve tool name and description", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "my_tool",
						description: "My tool description",
						parameters: { type: "object", properties: {} },
					},
				},
			]
			const result = (handler as any).convertToolsForOpenAI(tools)
			expect(result[0].function.name).toBe("my_tool")
			expect(result[0].function.description).toBe("My tool description")
		})
	})

	describe("convertMessagesForMiMo", () => {
		it("should convert assistant message with reasoning and text", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning" as const, text: "Let me think..." } as any,
						{ type: "text" as const, text: "Here is the answer" },
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("assistant")
			expect(result[0].content).toBe("Here is the answer")
			expect((result[0] as any).reasoning_content).toBe("Let me think...")
		})

		it("should convert assistant message with tool_use blocks", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "text" as const, text: "I'll read the file" },
						{
							type: "tool_use" as const,
							id: "call_123",
							name: "read_file",
							input: { path: "README.md" },
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect(result[0].tool_calls).toHaveLength(1)
			expect(result[0].tool_calls[0].id).toBe("call_123")
			expect(result[0].tool_calls[0].function.name).toBe("read_file")
			expect(result[0].tool_calls[0].function.arguments).toBe('{"path":"README.md"}')
		})

		it("should handle string-input tool_use (JSON string)", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use" as const,
							id: "call_456",
							name: "read_file",
							input: '{"path":"test.ts"}',
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result[0].tool_calls[0].function.arguments).toBe('{"path":"test.ts"}')
		})

		it("should handle assistant message with string content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: "Simple text response",
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("assistant")
			expect(result[0].content).toBe("Simple text response")
		})

		it("should handle assistant string content with reasoning_content", () => {
			const messages = [
				{
					role: "assistant" as const,
					content: "Response after thinking",
					reasoning_content: "My reasoning",
				},
			] as any[]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect((result[0] as any).reasoning_content).toBe("My reasoning")
		})

		it("should not add reasoning_content if empty string", () => {
			const messages = [
				{
					role: "assistant" as const,
					content: "Response",
					reasoning_content: "",
				},
			] as any[]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect((result[0] as any).reasoning_content).toBeUndefined()
		})

		it("should convert user messages with tool_result blocks", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_123",
							content: "File contents here",
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("tool")
			expect(result[0].tool_call_id).toBe("call_123")
			expect(result[0].content).toBe("File contents here")
		})

		it("should handle tool_result with array content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_789",
							content: [
								{ type: "text" as const, text: "Part 1" },
								{ type: "text" as const, text: "Part 2" },
							],
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result[0].content).toBe("Part 1\nPart 2")
		})

		it("should handle empty tool_result content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_empty",
							content: "",
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result[0].content).toBe("(empty)")
		})

		it("should separate tool_results from text in user messages", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_1",
							content: "result",
						},
						{ type: "text" as const, text: "Here are the results" },
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(2)
			expect(result[0].role).toBe("tool")
			expect(result[1].role).toBe("user")
			expect(result[1].content).toBe("Here are the results")
		})

		it("should handle user message with string content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello world",
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("user")
			expect(result[0].content).toBe("Hello world")
		})

		it("should handle full multi-turn conversation with reasoning", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text" as const, text: "Read README.md" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "reasoning" as const, text: "User wants to read a file" } as any,
						{ type: "text" as const, text: "I'll read it" },
						{
							type: "tool_use" as const,
							id: "call_1",
							name: "read_file",
							input: { path: "README.md" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_1",
							content: "# README\nHello world",
						},
					],
				},
			]
			const result = (handler as any).convertMessagesForMiMo(messages)

			// user message
			expect(result[0].role).toBe("user")
			// assistant with reasoning + tool_calls
			expect(result[1].role).toBe("assistant")
			expect((result[1] as any).reasoning_content).toBe("User wants to read a file")
			expect(result[1].tool_calls).toHaveLength(1)
			// tool result
			expect(result[2].role).toBe("tool")
			expect(result[2].tool_call_id).toBe("call_1")
		})
	})

	describe("createMessage", () => {
		it("should send request with thinking enabled in extra_body", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages)
			// Consume the stream
			for await (const _chunk of stream) {
				// drain
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					extra_body: { thinking: { type: "enabled" } },
				}),
			)
		})

		it("should not send parallel_tool_calls or stream_options", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.parallel_tool_calls).toBeUndefined()
			expect(params.stream_options).toBeUndefined()
			expect(params.tool_choice).toBeUndefined()
		})

		it("should include tools when provided", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]
			const tools = [
				{
					type: "function" as const,
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
							required: ["path"],
							additionalProperties: false,
						},
						strict: true,
					},
				},
			]

			const stream = handler.createMessage("System prompt", messages, { tools } as any)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.tools).toHaveLength(1)
			expect(params.tools[0].function.parameters.additionalProperties).toBeUndefined()
		})

		it("should yield text chunks from stream", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: any[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks.length).toBeGreaterThan(0)
			expect(textChunks[0].text).toBe("Test response")
		})

		it("should yield usage chunk at the end", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: any[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0].inputTokens).toBe(10)
			expect(usageChunks[0].outputTokens).toBe(5)
		})

		it("should handle reasoning_content in stream", async () => {
			// Override mock to return reasoning_content
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { reasoning_content: "Thinking..." }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: { content: "Done" }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: any[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
			expect(reasoningChunks).toHaveLength(1)
			expect(reasoningChunks[0].text).toBe("Thinking...")
		})
	})
})
