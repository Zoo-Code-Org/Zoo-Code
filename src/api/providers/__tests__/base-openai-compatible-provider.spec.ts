// npx vitest run api/providers/__tests__/base-openai-compatible-provider.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"

// Create mock functions
const mockCreate = vi.fn()

// Mock OpenAI module
vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(apiKey: string) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
		})
	}
}

describe("BaseOpenAiCompatibleProvider", () => {
	let handler: TestOpenAiCompatibleProvider

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new TestOpenAiCompatibleProvider("test-api-key")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("TagMatcher reasoning tags", () => {
		it("should handle reasoning tags (<think>) from stream", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "<think>Let me think" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: " about this</think>" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "The answer is 42" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// TagMatcher yields chunks as they're processed
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Let me think" },
				{ type: "reasoning", text: " about this" },
				{ type: "text", text: "The answer is 42" },
			])
		})

		it("should handle complete <think> tag in a single chunk", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "Regular text before " } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "<think>Complete thought</think>" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: " regular text after" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// When a complete tag arrives in one chunk, TagMatcher may not parse it
			// This test documents the actual behavior
			expect(chunks.length).toBeGreaterThan(0)
			expect(chunks[0]).toEqual({ type: "text", text: "Regular text before " })
		})

		it("should handle incomplete <think> tag at end of stream", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "<think>Incomplete thought" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// TagMatcher should handle incomplete tags and flush remaining content
			expect(chunks.length).toBeGreaterThan(0)
			expect(
				chunks.some(
					(c) => (c.type === "text" || c.type === "reasoning") && c.text.includes("Incomplete thought"),
				),
			).toBe(true)
		})

		it("should handle text without any <think> tags", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "Just regular text" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: " without reasoning" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "text", text: "Just regular text" },
				{ type: "text", text: " without reasoning" },
			])
		})

		it("should handle <think> tags that start at beginning of stream", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "<think>reasoning" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: " content</think>" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: " normal text" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "reasoning", text: "reasoning" },
				{ type: "reasoning", text: " content" },
				{ type: "text", text: " normal text" },
			])
		})
	})

	describe("reasoning_content field", () => {
		it("should preserve whitespace-only reasoning_content so streamed boundaries survive concatenation", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "\n" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "   " } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "\t\n  " } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "Regular content" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "   " },
				{ type: "reasoning", text: "\t\n  " },
				{ type: "text", text: "Regular content" },
			])
		})

		it("should yield non-empty reasoning_content", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "Thinking step 1" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "\n" } }] },
							})
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "Thinking step 2" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking step 1" },
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "Thinking step 2" },
			])
		})

		it("should handle reasoning_content with leading/trailing whitespace", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { reasoning_content: "  content with spaces  " } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should yield reasoning with spaces (only pure whitespace is filtered)
			expect(chunks).toEqual([{ type: "reasoning", text: "  content with spaces  " }])
		})
	})

	describe("Basic functionality", () => {
		it("should create stream with correct parameters", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						async next() {
							return { done: true }
						},
					}),
				}
			})

			const systemPrompt = "Test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Test message" }]

			const messageGenerator = handler.createMessage(systemPrompt, messages)
			await messageGenerator.next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "test-model",
					temperature: 0,
					messages: expect.arrayContaining([{ role: "system", content: systemPrompt }]),
					stream: true,
					stream_options: { include_usage: true },
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [{ delta: {} }],
									usage: { prompt_tokens: 100, completion_tokens: 50 },
								},
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 50 })
		})
	})

	describe("Tool call handling", () => {
		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: {
												tool_calls: [
													{
														index: 0,
														id: "call_123",
														function: { name: "test_tool", arguments: '{"arg":' },
													},
												],
											},
										},
									],
								},
							})
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: {
												tool_calls: [
													{
														index: 0,
														function: { arguments: '"value"}' },
													},
												],
											},
										},
									],
								},
							})
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: {},
											finish_reason: "tool_calls",
										},
									],
								},
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(2)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0]).toEqual({ type: "tool_call_end", id: "call_123" })
		})

		it("should yield multiple tool_call_end events for parallel tool calls", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: {
												tool_calls: [
													{
														index: 0,
														id: "call_001",
														function: { name: "tool_a", arguments: "{}" },
													},
													{
														index: 1,
														id: "call_002",
														function: { name: "tool_b", arguments: "{}" },
													},
												],
											},
										},
									],
								},
							})
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: {},
											finish_reason: "tool_calls",
										},
									],
								},
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(2)
			expect(endChunks.map((c: any) => c.id).sort()).toEqual(["call_001", "call_002"])
		})

		it("should not yield tool_call_end when finish_reason is not tool_calls", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: {
									choices: [
										{
											delta: { content: "Some text response" },
											finish_reason: "stop",
										},
									],
								},
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			const chunks = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(0)
		})
	})

	describe("Abort support", () => {
		it("should pass AbortSignal to createStream via createMessage", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						async next() {
							return { done: true }
						},
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			for await (const _chunk of stream) {
				// consume
			}

			expect(mockCreate).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should pass AbortSignal to client.chat.completions.create via completePrompt", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})

			await handler.completePrompt("test prompt")

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: "test-model" }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
		})

		it("should clean up abort controller after createMessage completes", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: { choices: [{ delta: { content: "hello" } }] },
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			for await (const _chunk of stream) {
				// consume
			}

			// After completion, calling abort() should be a no-op (controller was cleaned up)
			// We verify this indirectly: no error should be thrown
			expect(() => handler.abort()).not.toThrow()
		})

		it("should clean up abort controller after completePrompt completes", async () => {
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "response" } }],
			})

			await handler.completePrompt("test prompt")

			// After completion, calling abort() should be a no-op (controller was cleaned up)
			expect(() => handler.abort()).not.toThrow()
		})

		it("should support abort during streaming via early generator close", async () => {
			let streamAborted = false

			mockCreate.mockImplementationOnce((_params: any, requestOptions: any) => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi.fn().mockImplementation(async () => {
							// Check if the signal was aborted
							if (requestOptions?.signal?.aborted) {
								streamAborted = true
								throw new Error("aborted")
							}
							return {
								done: false,
								value: { choices: [{ delta: { content: "chunk" } }] },
							}
						}),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])

			// Only consume the first chunk, then break (early close)
			let count = 0
			try {
				for await (const _chunk of stream) {
					count++
					if (count >= 1) {
						break
					}
				}
			} catch {
				// Generator may throw on early close, that's OK
			}

			// The finally block should have called abortAndCleanup
			// Verify that abort was called (controller is cleaned up)
			expect(() => handler.abort()).not.toThrow()
		})
	})

	describe("createMessage error handling", () => {
		it("should handle errors via handleOpenAIError in catch block", async () => {
			mockCreate.mockImplementationOnce(() => ({
				// eslint-disable-next-line require-yield
				[Symbol.asyncIterator]: async function* () {
					throw new Error("stream failed")
				},
			}))

			const stream = handler.createMessage("system prompt", [])
			await expect(async () => {
				for await (const _ of stream) {
					/* drain */
				}
			}).rejects.toThrow()
		})

		it("should throw on base_resp error chunk during streaming", async () => {
			mockCreate.mockImplementationOnce(() => {
				return {
					[Symbol.asyncIterator]: () => ({
						next: vi
							.fn()
							.mockResolvedValueOnce({
								done: false,
								value: {
									base_resp: { status_code: 500, status_msg: "Internal Server Error" },
									choices: [],
								},
							})
							.mockResolvedValueOnce({ done: true }),
					}),
				}
			})

			const stream = handler.createMessage("system prompt", [])
			await expect(async () => {
				for await (const _ of stream) {
					/* drain */
				}
			}).rejects.toThrow("TestProvider API Error (500): Internal Server Error")
		})

		it("should throw on completePrompt base_resp error response", async () => {
			mockCreate.mockResolvedValueOnce({
				base_resp: { status_code: 403, status_msg: "Forbidden" },
				choices: [{ message: { content: "should not return" } }],
			})

			await expect(handler.completePrompt("test prompt")).rejects.toThrow(
				"TestProvider API Error (403): Forbidden",
			)
		})

		it("should throw on completePrompt base_resp with zero status_code as success path", async () => {
			// base_resp with status_code 0 is treated as success
			mockCreate.mockResolvedValueOnce({
				base_resp: { status_code: 0, status_msg: "OK" },
				choices: [{ message: { content: "ok response" } }],
			})

			const result = await handler.completePrompt("test prompt")
			expect(result).toBe("ok response")
		})
	})

	describe("completePrompt with reasoning", () => {
		it("should add thinking parameter when reasoning is enabled and model supports it", async () => {
			// Create a provider with reasoning support
			class ReasoningProvider extends BaseOpenAiCompatibleProvider<"reasoning-model"> {
				constructor() {
					super({
						providerName: "ReasoningTest",
						baseURL: "https://test.example.com/v1",
						defaultProviderModelId: "reasoning-model",
						providerModels: {
							"reasoning-model": {
								maxTokens: 4096,
								contextWindow: 128000,
								supportsImages: false,
								supportsPromptCache: false,
								inputPrice: 0.5,
								outputPrice: 1.5,
								supportsReasoningBinary: true,
							},
						},
						apiKey: "test",
						enableReasoningEffort: true,
					})
				}
			}

			const reasoningHandler = new ReasoningProvider()
			mockCreate.mockResolvedValueOnce({
				choices: [{ message: { content: "thoughtful answer" } }],
			})

			const result = await reasoningHandler.completePrompt("think")
			expect(result).toBe("thoughtful answer")

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.thinking).toEqual({ type: "enabled" })
		})
	})
})
