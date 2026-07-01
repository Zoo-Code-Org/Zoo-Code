// npx vitest run api/providers/__tests__/requesty.spec.ts

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const MOCK_TIMEOUT_MS = 300_000

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { RequestyHandler } from "../requesty"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { ApiHandlerCreateMessageMetadata } from "../../index"

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
		})
	}),
}))

describe("RequestyHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		requestyApiKey: "test-key",
		requestyModelId: "coding/claude-4-sonnet",
	}

	beforeEach(() => vitest.clearAllMocks())

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

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: mockOptions.requestyModelId,
						choices: [{ delta: { content: "test response" } }],
					}
					yield {
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
					}
				},
			}

			mockCreate.mockResolvedValue(mockStream)

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const generator = handler.createMessage(systemPrompt, messages)
			const chunks = []

			for await (const chunk of generator) {
				chunks.push(chunk)
			}

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
			const handler = new RequestyHandler({
				requestyApiKey: "test-key",
				requestyModelId: "anthropic/claude-fable-5",
				enableReasoningEffort: true,
				modelMaxTokens: 32768,
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20 },
					}
				},
			}

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-fable-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
					temperature: undefined,
				}),
			)
		})

		it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
			const handler = new RequestyHandler({
				requestyApiKey: "test-key",
				requestyModelId: "anthropic/claude-sonnet-5",
				enableReasoningEffort: true,
				modelMaxTokens: 32768,
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20 },
					}
				},
			}

			mockCreate.mockResolvedValue(mockStream)

			const generator = handler.createMessage("test system prompt", [{ role: "user" as const, content: "test" }])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "anthropic/claude-sonnet-5",
					max_tokens: 32768,
					thinking: { type: "adaptive" },
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
			mockCreate.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { id: "1", choices: [{ delta: { reasoning_content: "thinking..." } }] }
					yield { id: "1", choices: [{ delta: { content: "answer" } }] }
					yield {
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					}
				},
			})

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking..." })
		})

		it("falls back to delta.reasoning when reasoning_content is absent", async () => {
			const handler = new RequestyHandler(mockOptions)
			mockCreate.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { id: "1", choices: [{ delta: { reasoning: "router-style thought" } }] }
					yield {
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					}
				},
			})

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				chunks.push(chunk)
			}

			expect(chunks).toContainEqual({ type: "reasoning", text: "router-style thought" })
		})

		it("prefers delta.reasoning_content over delta.reasoning when both are present", async () => {
			const handler = new RequestyHandler(mockOptions)

			mockCreate.mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield {
						id: "1",
						choices: [
							{
								delta: {
									reasoning_content: "primary thought",
									reasoning: "fallback thought",
								},
							},
						],
					}
					yield {
						id: "1",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					}
				},
			})

			const chunks: any[] = []

			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				chunks.push(chunk)
			}

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
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield {
							id: "test-id",
							choices: [{ delta: { content: "test response" } }],
						}
					},
				}
				mockCreate.mockResolvedValue(mockStream)
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
				const mockStreamWithToolCalls = {
					async *[Symbol.asyncIterator]() {
						yield {
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
						}
						yield {
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
						}
						yield {
							id: "test-id",
							choices: [{ delta: {} }],
							usage: { prompt_tokens: 10, completion_tokens: 20 },
						}
					},
				}
				mockCreate.mockResolvedValue(mockStreamWithToolCalls)

				const metadata: ApiHandlerCreateMessageMetadata = {
					taskId: "test-task",
					tools: mockTools,
				}

				const handler = new RequestyHandler(mockOptions)
				const chunks = []
				for await (const chunk of handler.createMessage(systemPrompt, messages, metadata)) {
					chunks.push(chunk)
				}

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
		it("returns correct response", async () => {
			const handler = new RequestyHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			mockCreate.mockResolvedValue(mockResponse)

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith({
				model: mockOptions.requestyModelId,
				max_tokens: 8192,
				messages: [{ role: "system", content: "test prompt" }],
				temperature: 0,
			})
		})

		it("omits temperature for Claude Fable 5 in completePrompt", async () => {
			const handler = new RequestyHandler({
				requestyApiKey: "test-key",
				requestyModelId: "anthropic/claude-fable-5",
			})
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith({
				model: "anthropic/claude-fable-5",
				max_tokens: 8192,
				messages: [{ role: "system", content: "test prompt" }],
				temperature: undefined,
			})
		})

		it("omits temperature for Claude Sonnet 5 in completePrompt", async () => {
			const handler = new RequestyHandler({
				requestyApiKey: "test-key",
				requestyModelId: "anthropic/claude-sonnet-5",
			})
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "test completion" } }] })

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith({
				model: "anthropic/claude-sonnet-5",
				max_tokens: 8192,
				messages: [{ role: "system", content: "test prompt" }],
				temperature: undefined,
			})
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
	})
})
