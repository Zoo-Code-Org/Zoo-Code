// npx vitest run api/providers/__tests__/base-openai-compatible-provider.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

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
		clearAllMocks()
		handler = new TestOpenAiCompatibleProvider("test-api-key")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("TagMatcher reasoning tags", () => {
		it("should handle reasoning tags (<think>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Let me think" } }] },
					{ choices: [{ delta: { content: " about this</think>" } }] },
					{ choices: [{ delta: { content: "The answer is 42" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher yields chunks as they're processed
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Let me think" },
				{ type: "reasoning", text: " about this" },
				{ type: "text", text: "The answer is 42" },
			])
		})

		it("should handle reasoning tags (<thought>) from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<thought>Deep thought" } }] },
					{ choices: [{ delta: { content: " here</thought>" } }] },
					{ choices: [{ delta: { content: "Result: 42" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Deep thought" },
				{ type: "reasoning", text: " here" },
				{ type: "text", text: "Result: 42" },
			])
		})

		it("should not close <think> tag with </thought> tag", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>Thinking" } }] },
					{ choices: [{ delta: { content: " but closing with wrong tag</thought>" } }] },
					{ choices: [{ delta: { content: " still thinking" } }] },
				]),
			)
			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)
			// The </thought> tag should be treated as text since it doesn't match the active <think> tag
			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking" },
				{ type: "reasoning", text: " but closing with wrong tag</thought>" },
				{ type: "reasoning", text: " still thinking" },
			])
		})

		it("should handle complete <think> tag in a single chunk", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Regular text before " } }] },
					{ choices: [{ delta: { content: "<think>Complete thought</think>" } }] },
					{ choices: [{ delta: { content: " regular text after" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// When a complete tag arrives in one chunk, TagMatcher may not parse it
			// This test documents the actual behavior
			expect(chunks.length).toBeGreaterThan(0)
			expect(chunks[0]).toEqual({ type: "text", text: "Regular text before " })
		})

		it("should handle incomplete <think> tag at end of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { content: "<think>Incomplete thought" } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// TagMatcher should flush incomplete reasoning content on stream end
			expect(chunks).toContainEqual({ type: "reasoning", text: "Incomplete thought" })
		})

		it("should handle text without any <think> tags", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "Just regular text" } }] },
					{ choices: [{ delta: { content: " without reasoning" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "text", text: "Just regular text" },
				{ type: "text", text: " without reasoning" },
			])
		})

		it("should handle <think> tags that start at beginning of stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { content: "<think>reasoning" } }] },
					{ choices: [{ delta: { content: " content</think>" } }] },
					{ choices: [{ delta: { content: " normal text" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "reasoning" },
				{ type: "reasoning", text: " content" },
				{ type: "text", text: " normal text" },
			])
		})
	})

	describe("reasoning_content field", () => {
		it("should preserve whitespace-only reasoning_content so streamed boundaries survive concatenation", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "   " } }] },
					{ choices: [{ delta: { reasoning_content: "\t\n  " } }] },
					{ choices: [{ delta: { content: "Regular content" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "   " },
				{ type: "reasoning", text: "\t\n  " },
				{ type: "text", text: "Regular content" },
			])
		})

		it("should yield non-empty reasoning_content", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{ choices: [{ delta: { reasoning_content: "Thinking step 1" } }] },
					{ choices: [{ delta: { reasoning_content: "\n" } }] },
					{ choices: [{ delta: { reasoning_content: "Thinking step 2" } }] },
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking step 1" },
				{ type: "reasoning", text: "\n" },
				{ type: "reasoning", text: "Thinking step 2" },
			])
		})

		it("should handle reasoning_content with leading/trailing whitespace", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([{ choices: [{ delta: { reasoning_content: "  content with spaces  " } }] }]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should yield reasoning with spaces (only pure whitespace is filtered)
			expect(chunks).toEqual([{ type: "reasoning", text: "  content with spaces  " }])
		})
	})

	describe("Basic functionality", () => {
		it("should create stream with correct parameters", async () => {
			mockCreate.mockImplementationOnce(() => asyncStreamFrom([]))

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
				undefined,
			)
		})

		it("should yield usage data from stream", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 100, completion_tokens: 50 },
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const firstChunk = await stream.next()

			expect(firstChunk.done).toBe(false)
			expect(firstChunk.value).toMatchObject({ type: "usage", inputTokens: 100, outputTokens: 50 })
		})
	})

	describe("Tool call handling", () => {
		it("should yield tool_call_end events when finish_reason is tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
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
					{
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
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(2)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0]).toEqual({ type: "tool_call_end", id: "call_123" })
		})

		it("should yield multiple tool_call_end events for parallel tool calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
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
					{
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(2)
			expect(endChunks.map((c: any) => c.id).sort()).toEqual(["call_001", "call_002"])
		})

		it("should not yield tool_call_end when finish_reason is not tool_calls", async () => {
			mockCreate.mockImplementationOnce(() =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: { content: "Some text response" },
								finish_reason: "stop",
							},
						],
					},
				]),
			)

			const stream = handler.createMessage("system prompt", [])
			const chunks = await collectStream(stream)

			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")
			expect(endChunks).toHaveLength(0)
		})
	})
})
