// npx vitest run api/providers/__tests__/openai-usage-tracking.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { ApiHandlerOptions } from "../../../shared/api"
import { OpenAiHandler } from "../openai"
import { makeApiHandlerOptions } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const mockCreate = vitest.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(function () {
			return {
				chat: {
					completions: {
						create: mockCreate.mockImplementation(async (options) => {
							if (!options.stream) {
								return {
									id: "test-completion",
									choices: [
										{
											message: { role: "assistant", content: "Test response", refusal: null },
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

							// Return a stream with multiple chunks that include usage metrics
							return asyncStreamFrom([
								{
									choices: [
										{
											delta: { content: "Test " },
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 2,
										total_tokens: 12,
									},
								},
								{
									choices: [
										{
											delta: { content: "response" },
											index: 0,
										},
									],
									usage: {
										prompt_tokens: 10,
										completion_tokens: 4,
										total_tokens: 14,
									},
								},
								{
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
								},
							])
						}),
					},
				},
			}
		}),
	}
})

describe("OpenAiHandler with usage tracking fix", () => {
	let handler: OpenAiHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = makeApiHandlerOptions({
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://api.openai.com/v1",
		})
		handler = new OpenAiHandler(mockOptions)
		mockCreate.mockClear()
	})

	describe("usage metrics with streaming", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: "Hello!",
					},
				],
			},
		]

		it("should only yield usage metrics once at the end of the stream", async () => {
			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			// Check we have text chunks
			const textChunks = chunks.filter((chunk) => chunk.type === "text")
			expect(textChunks).toHaveLength(2)
			expect(textChunks[0].text).toBe("Test ")
			expect(textChunks[1].text).toBe("response")

			// Check we only have one usage chunk and it's the last one
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0]).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
			})

			// Check the usage chunk is the last one reported from the API
			const lastChunk = chunks[chunks.length - 1]
			expect(lastChunk).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 5 })
		})

		it("should handle case where usage is only in the final chunk", async () => {
			// Override the mock for this specific test
			mockCreate.mockImplementationOnce(async (options) => {
				if (!options.stream) {
					return {
						id: "test-completion",
						choices: [{ message: { role: "assistant", content: "Test response" } }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					}
				}

				return asyncStreamFrom([
					{
						choices: [{ delta: { content: "Test " }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: { content: "response" }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					},
				])
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			// Check usage metrics
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(1)
			expect(usageChunks[0]).toEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
			})
		})

		it("should report OpenAI-compatible cached prompt tokens", async () => {
			mockCreate.mockImplementationOnce(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Cached response" }, index: 0 }],
						usage: {
							prompt_tokens: 5_053,
							completion_tokens: 16,
							total_tokens: 5_069,
							prompt_tokens_details: { cached_tokens: 4_864 },
						},
					},
				]),
			)

			const chunks = await collectStream(handler.createMessage(systemPrompt, messages))

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 5_053,
				outputTokens: 16,
				cacheReadTokens: 4_864,
			})
		})

		it("should handle case where no usage is provided", async () => {
			// Override the mock for this specific test
			mockCreate.mockImplementationOnce(async (options) => {
				if (!options.stream) {
					return {
						id: "test-completion",
						choices: [{ message: { role: "assistant", content: "Test response" } }],
						usage: null,
					}
				}

				return asyncStreamFrom([
					{
						choices: [{ delta: { content: "Test response" }, index: 0 }],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: null,
					},
				])
			})

			const stream = handler.createMessage(systemPrompt, messages)
			const chunks = await collectStream(stream)

			// Check we don't have any usage chunks
			const usageChunks = chunks.filter((chunk) => chunk.type === "usage")
			expect(usageChunks).toHaveLength(0)
		})
	})

	it("should report cached prompt tokens from a non-streaming response", async () => {
		const nonStreamingHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
		mockCreate.mockImplementationOnce(async () => ({
			id: "test-completion",
			choices: [{ message: { role: "assistant", content: "Cached response" } }],
			usage: {
				prompt_tokens: 4_621,
				completion_tokens: 16,
				total_tokens: 4_637,
				prompt_tokens_details: { cached_tokens: 4_608 },
			},
		}))

		const chunks = await collectStream(nonStreamingHandler.createMessage("system prompt", []))

		expect(chunks).toContainEqual({
			type: "usage",
			inputTokens: 4_621,
			outputTokens: 16,
			cacheReadTokens: 4_608,
		})
	})

	it("reports cached prompt tokens for a streaming O3 response", async () => {
		const o3Handler = new OpenAiHandler({ ...mockOptions, openAiModelId: "o3-mini" })
		mockCreate.mockImplementationOnce(async () =>
			asyncStreamFrom([
				{
					choices: [{ delta: { content: "Cached response" }, index: 0 }],
					usage: {
						prompt_tokens: 5_053,
						completion_tokens: 16,
						total_tokens: 5_069,
						prompt_tokens_details: { cached_tokens: 4_864 },
					},
				},
			]),
		)

		const chunks = await collectStream(o3Handler.createMessage("system prompt", []))

		expect(chunks).toContainEqual({
			type: "usage",
			inputTokens: 5_053,
			outputTokens: 16,
			cacheReadTokens: 4_864,
		})
	})

	it.each([
		["string", "10"],
		["object", { tokens: 10 }],
		["negative", -1],
		["non-finite", Number.POSITIVE_INFINITY],
		["greater than prompt tokens", 101],
	])("ignores invalid %s cached prompt tokens in streaming responses", async (_name, cachedTokens) => {
		mockCreate.mockImplementationOnce(async () =>
			asyncStreamFrom([
				{
					choices: [{ delta: { content: "Response" }, index: 0 }],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 5,
						prompt_tokens_details: { cached_tokens: cachedTokens },
					},
				},
			]),
		)

		const chunks = await collectStream(handler.createMessage("system prompt", []))

		expect(chunks).toContainEqual({ type: "usage", inputTokens: 100, outputTokens: 5 })
	})

	it.each([
		["string", "10"],
		["object", { tokens: 10 }],
		["negative", -1],
		["non-finite", Number.POSITIVE_INFINITY],
		["greater than prompt tokens", 101],
	])("ignores invalid %s cached prompt tokens in non-streaming responses", async (_name, cachedTokens) => {
		const nonStreamingHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
		mockCreate.mockImplementationOnce(async () => ({
			id: "test-completion",
			choices: [{ message: { role: "assistant", content: "Response" } }],
			usage: {
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: cachedTokens },
			},
		}))

		const chunks = await collectStream(nonStreamingHandler.createMessage("system prompt", []))

		expect(chunks).toContainEqual({ type: "usage", inputTokens: 100, outputTokens: 5 })
	})
})
