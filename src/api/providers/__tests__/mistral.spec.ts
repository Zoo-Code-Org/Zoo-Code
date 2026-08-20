// Mock TelemetryService - must come before other imports
const mockCaptureException = vi.hoisted(() => vi.fn())
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: mockCaptureException,
		},
	},
}))

// Mock Mistral client - must come before other imports
const mockCreate = vi.fn()
const mockComplete = vi.fn()
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
vi.mock("@mistralai/mistralai", () => {
	return {
		Mistral: vi.fn().mockImplementation(function () {
			return {
				chat: {
					stream: mockCreate.mockImplementation(async (_options) =>
						asyncStreamFrom([
							{
								data: {
									choices: [
										{
											delta: { content: "Test response" },
											index: 0,
										},
									],
								},
							},
						]),
					),
					complete: mockComplete.mockImplementation(async (_options) => {
						return {
							choices: [
								{
									message: {
										content: "Test response",
									},
								},
							],
						}
					}),
				},
			}
		}),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import { MistralHandler } from "../mistral"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiStreamTextChunk, ApiStreamReasoningChunk, ApiStreamToolCallPartialChunk } from "../../transform/stream"
import { makeCreateMessageMetadata } from "../../../test-utils/api"

describe("MistralHandler", () => {
	let handler: MistralHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "codestral-latest", // Update to match the actual model ID
			mistralApiKey: "test-api-key",
			includeMaxTokens: true,
			modelTemperature: 0,
		}
		handler = new MistralHandler(mockOptions)
		mockCreate.mockClear()
		mockComplete.mockClear()
		mockCaptureException.mockClear()
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(MistralHandler)
			expect(handler.getModel().id).toBe(mockOptions.apiModelId)
		})

		it("should throw error if API key is missing", () => {
			expect(() => {
				new MistralHandler({
					...mockOptions,
					mistralApiKey: undefined,
				})
			}).toThrow("Mistral API key is required")
		})

		it("should use custom base URL if provided", () => {
			const customBaseUrl = "https://custom.mistral.ai/v1"
			const handlerWithCustomUrl = new MistralHandler({
				...mockOptions,
				mistralCodestralUrl: customBaseUrl,
			})
			expect(handlerWithCustomUrl).toBeInstanceOf(MistralHandler)
		})
	})

	describe("getModel", () => {
		it("should return correct model info", () => {
			const model = handler.getModel()
			expect(model.id).toBe(mockOptions.apiModelId)
			expect(model.info).toBeDefined()
			expect(model.info.supportsPromptCache).toBe(false)
		})
	})

	describe("createMessage", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello!" }],
			},
		]

		it("should create message successfully", async () => {
			const iterator = handler.createMessage(systemPrompt, messages)
			const result = await iterator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.apiModelId,
					messages: expect.any(Array),
					maxTokens: expect.any(Number),
					temperature: 0,
					// Tools are now always present (minimum 6 from ALWAYS_AVAILABLE_TOOLS)
					tools: expect.any(Array),
					toolChoice: "any",
				}),
			)

			expect(result.value).toBeDefined()
			expect(result.done).toBe(false)
		})

		it("should handle streaming response correctly", async () => {
			const iterator = handler.createMessage(systemPrompt, messages)
			const results: ApiStreamTextChunk[] = []

			for await (const chunk of iterator) {
				if ("text" in chunk) {
					results.push(chunk as ApiStreamTextChunk)
				}
			}

			expect(results.length).toBeGreaterThan(0)
			expect(results[0].text).toBe("Test response")
		})

		it("should handle errors gracefully", async () => {
			mockCreate.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.createMessage(systemPrompt, messages).next()).rejects.toThrow("API Error")
		})

		it("should handle thinking content as reasoning chunks", async () => {
			// Mock stream with thinking content matching new SDK structure
			mockCreate.mockImplementationOnce(async (_options) =>
				asyncStreamFrom([
					{
						data: {
							choices: [
								{
									delta: {
										content: [
											{
												type: "thinking",
												thinking: [{ type: "text", text: "Let me think about this..." }],
											},
											{ type: "text", text: "Here's the answer" },
										],
									},
									index: 0,
								},
							],
						},
					},
				]),
			)

			const iterator = handler.createMessage(systemPrompt, messages)
			const results: (ApiStreamTextChunk | ApiStreamReasoningChunk)[] = []

			for await (const chunk of iterator) {
				if ("text" in chunk) {
					results.push(chunk as ApiStreamTextChunk | ApiStreamReasoningChunk)
				}
			}

			expect(results).toHaveLength(2)
			expect(results[0]).toEqual({ type: "reasoning", text: "Let me think about this..." })
			expect(results[1]).toEqual({ type: "text", text: "Here's the answer" })
		})

		it("should handle mixed content arrays correctly", async () => {
			// Mock stream with mixed content matching new SDK structure
			mockCreate.mockImplementationOnce(async (_options) =>
				asyncStreamFrom([
					{
						data: {
							choices: [
								{
									delta: {
										content: [
											{ type: "text", text: "First text" },
											{
												type: "thinking",
												thinking: [{ type: "text", text: "Some reasoning" }],
											},
											{ type: "text", text: "Second text" },
										],
									},
									index: 0,
								},
							],
						},
					},
				]),
			)

			const iterator = handler.createMessage(systemPrompt, messages)
			const results: (ApiStreamTextChunk | ApiStreamReasoningChunk)[] = []

			for await (const chunk of iterator) {
				if ("text" in chunk) {
					results.push(chunk as ApiStreamTextChunk | ApiStreamReasoningChunk)
				}
			}

			expect(results).toHaveLength(3)
			expect(results[0]).toEqual({ type: "text", text: "First text" })
			expect(results[1]).toEqual({ type: "reasoning", text: "Some reasoning" })
			expect(results[2]).toEqual({ type: "text", text: "Second text" })
		})
	})

	describe("native tool calling", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text", text: "What's the weather?" }],
			},
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

		it("should include tools in request by default (native is default)", async () => {
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				tools: mockTools,
			}

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
								parameters: expect.any(Object),
							}),
						}),
					]),
					toolChoice: "any",
				}),
			)
		})

		it("should always include tools in request (tools are always present after PR #10841)", async () => {
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
			}

			const iterator = handler.createMessage(systemPrompt, messages, metadata)
			await iterator.next()

			// Tools are now always present (minimum 6 from ALWAYS_AVAILABLE_TOOLS)
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: expect.any(Array),
					toolChoice: "any",
				}),
			)
		})

		it("should handle tool calls in streaming response", async () => {
			// Mock stream with tool calls
			mockCreate.mockImplementationOnce(async (_options) =>
				asyncStreamFrom([
					{
						data: {
							choices: [
								{
									delta: {
										toolCalls: [
											{
												id: "call_123",
												type: "function",
												function: {
													name: "get_weather",
													arguments: '{"location":"New York"}',
												},
											},
										],
									},
									index: 0,
								},
							],
						},
					},
				]),
			)

			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				tools: mockTools,
			}

			const iterator = handler.createMessage(systemPrompt, messages, metadata)
			const results: ApiStreamToolCallPartialChunk[] = []

			for await (const chunk of iterator) {
				if (chunk.type === "tool_call_partial") {
					results.push(chunk)
				}
			}

			expect(results).toHaveLength(1)
			expect(results[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_123",
				name: "get_weather",
				arguments: '{"location":"New York"}',
			})
		})

		it("should handle multiple tool calls in a single response", async () => {
			// Mock stream with multiple tool calls
			mockCreate.mockImplementationOnce(async (_options) =>
				asyncStreamFrom([
					{
						data: {
							choices: [
								{
									delta: {
										toolCalls: [
											{
												id: "call_1",
												type: "function",
												function: {
													name: "get_weather",
													arguments: '{"location":"NYC"}',
												},
											},
											{
												id: "call_2",
												type: "function",
												function: {
													name: "get_weather",
													arguments: '{"location":"LA"}',
												},
											},
										],
									},
									index: 0,
								},
							],
						},
					},
				]),
			)

			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				tools: mockTools,
			}

			const iterator = handler.createMessage(systemPrompt, messages, metadata)
			const results: ApiStreamToolCallPartialChunk[] = []

			for await (const chunk of iterator) {
				if (chunk.type === "tool_call_partial") {
					results.push(chunk)
				}
			}

			expect(results).toHaveLength(2)
			expect(results[0]).toEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "get_weather",
				arguments: '{"location":"NYC"}',
			})
			expect(results[1]).toEqual({
				type: "tool_call_partial",
				index: 1,
				id: "call_2",
				name: "get_weather",
				arguments: '{"location":"LA"}',
			})
		})

		it("should always set toolChoice to 'any' when tools are provided", async () => {
			// Even if tool_choice is provided in metadata, we override it to "any"
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				tools: mockTools,
				tool_choice: "auto", // This should be ignored
			}

			const iterator = handler.createMessage(systemPrompt, messages, metadata)
			await iterator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					toolChoice: "any",
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("should complete prompt successfully", async () => {
			const prompt = "Test prompt"
			const result = await handler.completePrompt(prompt)

			expect(mockComplete).toHaveBeenCalledWith(
				{
					model: mockOptions.apiModelId,
					messages: [{ role: "user", content: prompt }],
					temperature: 0,
				},
				undefined,
			)

			expect(result).toBe("Test response")
		})

		it("should filter out thinking content in completePrompt", async () => {
			mockComplete.mockImplementationOnce(async (_options) => {
				return {
					choices: [
						{
							message: {
								content: [
									{ type: "thinking", text: "Let me think..." },
									{ type: "text", text: "Answer part 1" },
									{ type: "text", text: "Answer part 2" },
								],
							},
						},
					],
				}
			})

			const prompt = "Test prompt"
			const result = await handler.completePrompt(prompt)

			expect(result).toBe("Answer part 1Answer part 2")
		})

		it("should handle errors in completePrompt", async () => {
			mockComplete.mockRejectedValueOnce(new Error("API Error"))
			await expect(handler.completePrompt("Test prompt")).rejects.toThrow("Mistral completion error: API Error")
		})

		it("should pass abort signal through to client", async () => {
			const controller = new AbortController()
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { abortSignal: controller.signal })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				fetchOptions: { signal: controller.signal },
			})
		})

		it("should work without options (backward compatible)", async () => {
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("response")
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), undefined)
		})

		it("should pass timeout through to client", async () => {
			const controller = new AbortController()
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { abortSignal: controller.signal, timeoutMs: 5000 })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				fetchOptions: { signal: controller.signal },
				timeoutMs: 5000,
			})
		})

		it("should pass only timeoutMs when no signal provided", async () => {
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { timeoutMs: 3000 })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				timeoutMs: 3000,
			})
		})

		it("should still forward timeoutMs=0 (uses !== undefined check, not truthy check)", async () => {
			mockComplete.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})
			await handler.completePrompt("test prompt", { timeoutMs: 0 })
			expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), {
				timeoutMs: 0,
			})
		})
	})

	describe("createMessage abort signal bridging", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Hello!" }],
			},
		]

		it("should reject immediately with AbortError when the external signal is pre-aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			const stream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const error = await collectStream(stream).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).name).toBe("AbortError")
			expect(mockCreate).not.toHaveBeenCalled()
		})

		it("should abort the in-flight stream when the external signal is triggered", async () => {
			const controller = new AbortController()
			let capturedSignal: AbortSignal | undefined
			mockCreate.mockImplementationOnce(
				async (_options: unknown, requestOptions?: { fetchOptions?: { signal?: AbortSignal } }) => {
					capturedSignal = requestOptions?.fetchOptions?.signal
					return asyncStreamFrom([
						{
							data: {
								choices: [
									{
										delta: { content: "partial" },
										index: 0,
									},
								],
							},
						},
						new Promise<never>((_resolve, reject) => {
							const onAbort = () => reject(new DOMException("aborted", "AbortError"))
							if (capturedSignal?.aborted) {
								onAbort()
								return
							}
							capturedSignal?.addEventListener("abort", onAbort, { once: true })
						}),
					])
				},
			)

			const stream = handler.createMessage(
				systemPrompt,
				messages,
				makeCreateMessageMetadata({ abortSignal: controller.signal }),
			)

			const collector = collectStream(stream).catch((e: unknown) => e)
			await new Promise((resolve) => setTimeout(resolve, 10))
			controller.abort()

			const error = await collector
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).name).toBe("AbortError")
			expect(capturedSignal).toBeDefined()
			expect(capturedSignal?.aborted).toBe(true)
		})

		it("should not pass a signal to the stream call when no external signal is provided", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			await collectStream(stream)
			const streamOptions = mockCreate.mock.calls[0][1]
			expect(streamOptions).toBeUndefined()
		})
	})
})
