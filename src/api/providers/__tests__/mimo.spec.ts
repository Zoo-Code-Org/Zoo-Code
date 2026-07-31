import type { ApiStreamChunk } from "../../transform/stream"
import type { DeepSeekAssistantMessage } from "../../transform/r1-format"
import type OpenAI from "openai"

const mockCreate = vi.fn()
vi.mock("openai", () => {
	return {
		__esModule: true,
		default: vi.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (_options: unknown) => {
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
			}
		}),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"
import { mimoDefaultModelId, mimoModels } from "@roo-code/types"
import type { ApiHandlerOptions } from "../../../shared/api"
import { MimoHandler } from "../mimo"
import { convertToR1Format } from "../../transform/r1-format"
import { sanitizeOpenAiCallId } from "../../../utils/tool-id"
import type { ApiHandlerCreateMessageMetadata } from "../../index"

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
			expect((h as unknown as { options: { openAiBaseUrl: string } }).options.openAiBaseUrl).toBe(
				"https://token-plan-sgp.xiaomimimo.com/v1",
			)
		})

		it("should use custom base URL when provided", () => {
			const customUrl = "https://api.xiaomimimo.com/v1"
			const h = new MimoHandler({ ...mockOptions, mimoBaseUrl: customUrl })
			expect((h as unknown as { options: { openAiBaseUrl: string } }).options.openAiBaseUrl).toBe(customUrl)
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

		it("should fallback to default model for unknown model ID", () => {
			const h = new MimoHandler({ ...mockOptions, apiModelId: "unknown-model" })
			const model = h.getModel()
			expect(model.id).toBe("unknown-model")
			expect(model.info).toBe(mimoModels["mimo-v2.5-pro"])
		})
	})

	describe("convertMessagesForMiMo (via convertToR1Format)", () => {
		const convert = (messages: Anthropic.Messages.MessageParam[]) =>
			convertToR1Format(messages, {
				mergeToolResultText: true,
				normalizeToolCallId: sanitizeOpenAiCallId,
			})

		it("should convert assistant message with reasoning and text", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{
							type: "reasoning" as const,
							text: "Let me think...",
						} as unknown as Anthropic.Messages.MessageParam["content"][number],
						{ type: "text" as const, text: "Here is the answer" },
					] as unknown as Anthropic.Messages.MessageParam["content"],
				},
			]
			const result = convert(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("assistant")
			expect(result[0].content).toBe("Here is the answer")
			expect((result[0] as DeepSeekAssistantMessage).reasoning_content).toBe("Let me think...")
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
			const result = convert(messages)
			expect(result).toHaveLength(1)
			const msg = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
			expect(msg.tool_calls).toHaveLength(1)
			expect(msg.tool_calls![0].id).toBe("call_123")
			expect((msg.tool_calls![0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function.name).toBe(
				"read_file",
			)
			expect((msg.tool_calls![0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function.arguments).toBe(
				'{"path":"README.md"}',
			)
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
			const result = convert(messages)
			const msg = result[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
			expect(msg.tool_calls).toHaveLength(1)
			expect((msg.tool_calls![0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function.name).toBe(
				"read_file",
			)
			expect(
				(msg.tool_calls![0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function.arguments,
			).toContain("test.ts")
		})

		it("should handle assistant message with string content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "assistant",
					content: "Simple text response",
				},
			]
			const result = convert(messages)
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
			] as unknown as Anthropic.Messages.MessageParam[]
			const result = convert(messages)
			expect(result).toHaveLength(1)
			expect((result[0] as DeepSeekAssistantMessage).reasoning_content).toBe("My reasoning")
		})

		it("should not add reasoning_content if empty string", () => {
			const messages = [
				{
					role: "assistant" as const,
					content: "Response",
					reasoning_content: "",
				},
			] as unknown as Anthropic.Messages.MessageParam[]
			const result = convert(messages)
			expect((result[0] as DeepSeekAssistantMessage).reasoning_content).toBeUndefined()
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
			const result = convert(messages)
			const msg = result[0] as OpenAI.Chat.ChatCompletionToolMessageParam
			expect(msg.role).toBe("tool")
			expect(msg.tool_call_id).toBe("call_123")
			expect(msg.content).toBe("File contents here")
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
			const result = convert(messages)
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
			const result = convert(messages)
			expect(result[0].content).toBe("")
		})

		it("should merge text into last tool message when both exist in same turn", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "call_1",
							content: "result",
						},
						{ type: "text" as const, text: "<environment_details>..." },
					],
				},
			]
			const result = convert(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("tool")
			expect(result[0].content).toContain("result")
			expect(result[0].content).toContain("<environment_details>...")
		})

		it("should keep text as separate user message when no tool_results present", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text" as const, text: "Hello" }],
				},
			]
			const result = convert(messages)
			expect(result).toHaveLength(1)
			expect(result[0].role).toBe("user")
			expect(result[0].content).toBe("Hello")
		})

		it("should handle user message with string content", () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: "Hello world",
				},
			]
			const result = convert(messages)
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
						{
							type: "reasoning" as const,
							text: "User wants to read a file",
						} as unknown as Anthropic.Messages.MessageParam["content"][number],
						{ type: "text" as const, text: "I'll read it" },
						{
							type: "tool_use" as const,
							id: "call_1",
							name: "read_file",
							input: { path: "README.md" },
						},
					] as unknown as Anthropic.Messages.MessageParam["content"],
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
			const result = convert(messages)

			// user message
			expect(result[0].role).toBe("user")
			// assistant with reasoning + tool_calls
			expect(result[1].role).toBe("assistant")
			expect((result[1] as DeepSeekAssistantMessage).reasoning_content).toBe("User wants to read a file")
			expect((result[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls).toHaveLength(1)
			// tool result
			expect(result[2].role).toBe("tool")
			expect((result[2] as OpenAI.Chat.ChatCompletionToolMessageParam).tool_call_id).toBe("call_1")
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

		it("should omit parallel_tool_calls when metadata.parallelToolCalls is undefined", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.parallel_tool_calls).toBeUndefined()
			expect(params.tool_choice).toBeUndefined()
		})

		it("should send parallel_tool_calls: false when metadata.parallelToolCalls is false", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages, {
				taskId: "test-task",
				parallelToolCalls: false,
			})
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.parallel_tool_calls).toBe(false)
		})

		it("should send parallel_tool_calls: true when metadata.parallelToolCalls is true", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages, {
				taskId: "test-task",
				parallelToolCalls: true,
			})
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.parallel_tool_calls).toBe(true)
		})

		it("should pass through tool_choice when provided in metadata", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages, {
				taskId: "test-task",
				tool_choice: "auto",
			})
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.tool_choice).toBe("auto")
		})

		it("should retry without parallel_tool_calls when endpoint rejects the field", async () => {
			// First call rejects with a 400 error mentioning parallel_tool_calls
			const rejectionError = Object.assign(
				new Error("400 - Unrecognized request parameter: parallel_tool_calls"),
				{
					status: 400,
				},
			)
			mockCreate.mockRejectedValueOnce(rejectionError)

			// Second call (retry) succeeds
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Retried" }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages, {
				taskId: "test-task",
				parallelToolCalls: false,
			})

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// First call should have had parallel_tool_calls
			const firstCallParams = mockCreate.mock.calls[0][0]
			expect(firstCallParams.parallel_tool_calls).toBe(false)

			// Second call (retry) should NOT have parallel_tool_calls
			const retryCallParams = mockCreate.mock.calls[1][0]
			expect(retryCallParams.parallel_tool_calls).toBeUndefined()

			// Stream should have produced text from the retry
			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks.length).toBeGreaterThan(0)
			expect(textChunks[0].text).toBe("Retried")
		})

		it("should send stream_options with include_usage", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.stream_options).toEqual({ include_usage: true })
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
						},
					},
				},
			]

			const stream = handler.createMessage("System prompt", messages, {
				tools,
			} as unknown as ApiHandlerCreateMessageMetadata)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.tools).toHaveLength(1)
			expect(params.tools[0].function.name).toBe("read_file")
		})

		it("should yield text chunks from stream", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
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

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0].inputTokens).toBe(10)
			expect(usageChunks[0].outputTokens).toBe(5)
		})

		it("streams reasoning chunks from delta.reasoning_content", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { reasoning_content: "thinking..." }, index: 0 }] }
					yield { choices: [{ delta: { content: "answer" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage("System prompt", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { reasoning: "router-style thought" }, index: 0 }] }
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage("System prompt", messages)) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
								index: 0,
							},
						],
					}
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage("System prompt", messages)) {
				chunks.push(chunk)
			}

			const reasoningChunks = chunks.filter((chunk) => chunk.type === "reasoning")
			expect(reasoningChunks).toEqual([{ type: "reasoning", text: "primary thought" }])
		})

		it("should yield tool_call_partial chunks from stream", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_abc",
											function: { name: "read_file", arguments: '{"path' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											function: { arguments: '":"test.ts"}' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Read test.ts" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolChunks = chunks.filter(
				(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
			)
			expect(toolChunks).toHaveLength(2)
			expect(toolChunks[0].id).toBe("call_abc")
			expect(toolChunks[0].name).toBe("read_file")
			expect(toolChunks[0].arguments).toBe('{"path')
			expect(toolChunks[1].arguments).toBe('":"test.ts"}')
		})

		it("should yield usage with cache tokens", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Hi" }, index: 0 }],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 20,
							total_tokens: 120,
							prompt_tokens_details: {
								cache_write_tokens: 50,
								cached_tokens: 30,
							},
						},
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter(
				(c): c is Extract<ApiStreamChunk, { type: "usage" }> => c.type === "usage",
			)
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0].inputTokens).toBe(100)
			expect(usageChunks[0].outputTokens).toBe(20)
			expect(usageChunks[0].cacheWriteTokens).toBe(50)
			expect(usageChunks[0].cacheReadTokens).toBe(30)
			expect(usageChunks[0].totalCost).toBeGreaterThan(0)
		})

		it("should handle API errors gracefully", async () => {
			mockCreate.mockRejectedValueOnce(new Error("400 Param Incorrect"))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			await expect(async () => {
				const stream = handler.createMessage("System prompt", messages)
				for await (const _chunk of stream) {
					// drain
				}
			}).rejects.toThrow()
		})

		it("should send converted Anthropic messages to API", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [{ type: "text", text: "Read the file" }],
				},
				{
					role: "assistant",
					content: [
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
							content: "# Hello",
						},
					],
				},
			]

			const stream = handler.createMessage("System prompt", messages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.messages).toHaveLength(4) // system + user + assistant + tool
			expect(params.messages[0].role).toBe("system")
			expect(params.messages[0].content).toBe("System prompt")
			expect(params.messages[1].role).toBe("user")
			expect(params.messages[2].role).toBe("assistant")
			expect(params.messages[2].reasoning_content).toBeUndefined()
			expect(params.messages[2].tool_calls).toHaveLength(1)
			expect(params.messages[3].role).toBe("tool")
			expect(params.messages[3].tool_call_id).toBe("call_1")
		})

		it("should not include tools param when no tools provided", async () => {
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("System prompt", messages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.tools).toBeUndefined()
		})

		it("should handle empty delta chunks without errors", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{}], usage: null }
					yield { choices: [{ delta: {} }], usage: null }
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System prompt", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks).toHaveLength(0)
		})

		it("should suppress parallel tool calls, keeping only the first", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
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
										{
											index: 1,
											id: "call_2",
											function: { name: "list_files", arguments: '{"path":' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 0, function: { arguments: '"a.txt"}' } },
										{ index: 1, function: { arguments: '"./"}' } },
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
					}
				},
			}))

			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: { name: "read_file", description: "Read", parameters: {} },
				},
				{
					type: "function",
					function: { name: "list_files", description: "List", parameters: {} },
				},
			]

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System", messages, { taskId: "test", tools })
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolChunks = chunks.filter(
				(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
			)
			const readChunks = toolChunks.filter((c) => c.name === "read_file")
			const listChunks = toolChunks.filter((c) => c.name === "list_files")
			expect(readChunks.length).toBeGreaterThan(0)
			expect(listChunks.length).toBe(0)
		})

		describe("parallel tool call suppression", () => {
			it("drops the second parallel tool call and keeps the first", async () => {
				mockCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
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
											{
												index: 1,
												id: "call_2",
												function: { name: "list_files", arguments: '{"path":' },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{ index: 0, function: { arguments: '"a.txt"}' } },
											{ index: 1, function: { arguments: '"./"}' } },
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
							usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
						}
					},
				}))

				const messages: Anthropic.Messages.MessageParam[] = [
					{ role: "user", content: [{ type: "text", text: "Hello" }] },
				]

				const chunks: ApiStreamChunk[] = []
				const stream = handler.createMessage("System", messages)
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				const toolChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
				)
				const listChunks = toolChunks.filter((c) => c.name === "list_files")
				expect(toolChunks.length).toBe(2)
				expect(listChunks.length).toBe(0)
				expect(toolChunks[0].id).toBe("call_1")
				expect(toolChunks[0].name).toBe("read_file")
			})

			it("drops parallel calls arriving in later chunks", async () => {
				mockCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_a",
												function: { name: "read_file", arguments: '{"path":' },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 1,
												id: "call_b",
												function: { name: "list_files", arguments: '{"path":' },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
							usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
						}
					},
				}))

				const messages: Anthropic.Messages.MessageParam[] = [
					{ role: "user", content: [{ type: "text", text: "Hello" }] },
				]

				const chunks: ApiStreamChunk[] = []
				const stream = handler.createMessage("System", messages)
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				const toolChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
				)
				const listChunks = toolChunks.filter((c) => c.name === "list_files")
				expect(toolChunks.length).toBe(2)
				expect(listChunks.length).toBe(0)
				expect(toolChunks[0].name).toBe("read_file")
			})

			it("passes a single tool call through unchanged", async () => {
				mockCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_abc",
												function: { name: "read_file", arguments: '{"path' },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '":"test.ts"}' } }],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
							usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
						}
					},
				}))

				const messages: Anthropic.Messages.MessageParam[] = [
					{ role: "user", content: [{ type: "text", text: "Read test.ts" }] },
				]

				const chunks: ApiStreamChunk[] = []
				const stream = handler.createMessage("System prompt", messages)
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				const toolChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
				)
				expect(toolChunks).toHaveLength(2)
				expect(toolChunks[0].id).toBe("call_abc")
				expect(toolChunks[0].name).toBe("read_file")
				expect(toolChunks[0].arguments).toBe('{"path')
				expect(toolChunks[1].arguments).toBe('":"test.ts"}')
			})

			it("emits exactly one tool_call_end for the surviving call", async () => {
				mockCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_x",
												function: { name: "read_file", arguments: "{}" },
											},
											{
												index: 1,
												id: "call_y",
												function: { name: "list_files", arguments: "{}" },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
							usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
						}
					},
				}))

				const messages: Anthropic.Messages.MessageParam[] = [
					{ role: "user", content: [{ type: "text", text: "Hello" }] },
				]

				const chunks: ApiStreamChunk[] = []
				const stream = handler.createMessage("System", messages)
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				const endChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_end" }> => c.type === "tool_call_end",
				)
				expect(endChunks).toHaveLength(1)
				expect(endChunks[0].id).toBe("call_x")
			})

			it("drops a disguised parallel call (second id at index 0)", async () => {
				mockCreate.mockImplementationOnce(async () => ({
					[Symbol.asyncIterator]: async function* () {
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_a",
												function: { name: "read_file", arguments: "{}" },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_b",
												function: { name: "list_files", arguments: "{}" },
											},
										],
									},
									index: 0,
								},
							],
							usage: null,
						}
						yield {
							choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }],
							usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
						}
					},
				}))

				const messages: Anthropic.Messages.MessageParam[] = [
					{ role: "user", content: [{ type: "text", text: "Hello" }] },
				]

				const chunks: ApiStreamChunk[] = []
				const stream = handler.createMessage("System", messages)
				for await (const chunk of stream) {
					chunks.push(chunk)
				}

				const toolChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
				)
				const readChunks = toolChunks.filter((c) => c.name === "read_file")
				const listChunks = toolChunks.filter((c) => c.name === "list_files")
				expect(readChunks.length).toBe(1)
				expect(listChunks.length).toBe(0)

				const endChunks = chunks.filter(
					(c): c is Extract<ApiStreamChunk, { type: "tool_call_end" }> => c.type === "tool_call_end",
				)
				expect(endChunks).toHaveLength(1)
				expect(endChunks[0].id).toBe("call_a")
			})
		})

		it("should handle stream interruption gracefully", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Partial " }, index: 0 }],
						usage: null,
					}
					// Stream ends without finish_reason (connection dropped)
				},
			}))

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System", messages)
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c): c is Extract<ApiStreamChunk, { type: "text" }> => c.type === "text")
			expect(textChunks).toHaveLength(1)
			expect(textChunks[0].text).toBe("Partial ")

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).toHaveLength(0)
		})

		it("should sanitize tool call IDs with invalid characters", async () => {
			mockCreate.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_with-special.chars@123",
											function: { name: "test_tool", arguments: "{}" },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					}
					yield {
						choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}
				},
			}))

			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: { name: "test_tool", description: "Test", parameters: {} },
				},
			]

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const chunks: ApiStreamChunk[] = []
			const stream = handler.createMessage("System", messages, { taskId: "test", tools })
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const toolChunks = chunks.filter(
				(c): c is Extract<ApiStreamChunk, { type: "tool_call_partial" }> => c.type === "tool_call_partial",
			)
			expect(toolChunks.length).toBeGreaterThan(0)
			expect(toolChunks[0].id).toBe(sanitizeOpenAiCallId("call_with-special.chars@123"))
			expect(toolChunks[0].id).not.toMatch(/[^a-zA-Z0-9_-]/)
		})

		it("should convert system prompt to system message for MiMo", async () => {
			const userMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
			]

			const stream = handler.createMessage("You are a helpful assistant", userMessages)
			for await (const _chunk of stream) {
				// drain
			}

			const params = mockCreate.mock.calls[0][0]
			expect(params.messages[0].role).toBe("system")
			expect(params.messages[0].content).toBe("You are a helpful assistant")
			expect(params.messages[1].role).toBe("user")
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "Test response" } }],
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("Test response")
		})

		it("should send correct parameters to the API", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "Response" } }],
			})

			await handler.completePrompt("What is 2+2?")

			const params = mockCreate.mock.calls[0][0]
			expect(params.model).toBe("mimo-v2.5-pro")
			expect(params.messages).toHaveLength(1)
			expect(params.messages[0].role).toBe("user")
			expect(params.messages[0].content).toBe("What is 2+2?")
		})

		it("should handle API errors with provider prefix", async () => {
			mockCreate.mockRejectedValueOnce(new Error("401 Unauthorized"))

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error:")
		})

		it("should return empty string when choices array is empty", async () => {
			mockCreate.mockResolvedValueOnce({ choices: [] })

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})

		it("should return empty string when message content is null", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: null } }],
			})

			const result = await handler.completePrompt("Test prompt")
			expect(result).toBe("")
		})

		it("should propagate network errors with provider prefix", async () => {
			mockCreate.mockRejectedValueOnce(new Error("ECONNREFUSED"))

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error:")
		})

		it("should propagate rate limit errors with provider prefix", async () => {
			mockCreate.mockRejectedValueOnce(new Error("429 Too Many Requests"))

			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("OpenAI completion error:")
		})

		it("should use correct model ID for mimo-v2.5 variant", async () => {
			const v25Handler = new MimoHandler({
				...mockOptions,
				apiModelId: "mimo-v2.5",
			})

			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "Response" } }],
			})

			await v25Handler.completePrompt("Test")

			const params = mockCreate.mock.calls[0][0]
			expect(params.model).toBe("mimo-v2.5")
		})
	})
})
