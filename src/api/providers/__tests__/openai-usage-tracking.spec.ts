// npx vitest run api/providers/__tests__/openai-usage-tracking.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import { ApiHandlerOptions } from "../../../shared/api"
import { calculateApiCostOpenAI } from "../../../shared/cost"
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

	it.each(["gpt-4", "o3-mini"])(
		"reports cached prompt tokens from a non-streaming %s response",
		async (openAiModelId) => {
			const nonStreamingHandler = new OpenAiHandler({
				...mockOptions,
				openAiModelId,
				openAiStreamingEnabled: false,
			})
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
		},
	)

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
		["fractional", 10.5],
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
		["fractional", 10.5],
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

	describe.each([true, false])("cache accounting with streaming=%s", (openAiStreamingEnabled) => {
		it.each([
			["authoritative count", 23, 23],
			["authoritative zero", 0, undefined],
			["fully cached prompt", 100, 100],
			["null falls back", null, 71],
			["absent falls back", undefined, 71],
			["negative", -1, undefined],
			["fractional", 10.5, undefined],
			["infinite", Infinity, undefined],
			["NaN", NaN, undefined],
			["string", "23", undefined],
			["object", { tokens: 23 }, undefined],
			["proxy cache reads exceed uncached input", 101, 101],
		])("respects %s without substituting a conflicting fallback", async (_name, reported, expected) => {
			const cacheHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled })
			const usage = {
				prompt_tokens: 100,
				completion_tokens: 5,
				cache_creation_input_tokens: 7,
				cache_read_input_tokens: reported,
				prompt_tokens_details: { cached_tokens: 71 },
			}
			mockCreate.mockResolvedValueOnce(
				openAiStreamingEnabled
					? asyncStreamFrom([{ choices: [], usage }])
					: { choices: [{ message: { content: "Response" } }], usage },
			)

			const chunks = await collectStream(cacheHandler.createMessage("system prompt", []))

			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
				{
					type: "usage",
					inputTokens: 100,
					outputTokens: 5,
					cacheWriteTokens: 7,
					cacheReadTokens: expected,
				},
			])
		})

		// Only OpenAI's nested counter must be a subset of prompt_tokens; this pins the inclusive boundary.
		it.each([
			["below the prompt size", 99, 99],
			["equal to the prompt size", 100, 100],
			["above the prompt size", 101, undefined],
		])(
			"accepts a nested cached_tokens count %s with no cache_read_input_tokens",
			async (_name, cached, expected) => {
				const cacheHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled })
				const usage = {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: cached },
				}
				mockCreate.mockResolvedValueOnce(
					openAiStreamingEnabled
						? asyncStreamFrom([{ choices: [], usage }])
						: { choices: [{ message: { content: "Response" } }], usage },
				)

				const chunks = await collectStream(cacheHandler.createMessage("system prompt", []))

				expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
					{ type: "usage", inputTokens: 100, outputTokens: 5, cacheReadTokens: expected },
				])
			},
		)
	})

	it.each([null, undefined, {}, { prompt_tokens_details: null }])(
		"defaults missing non-streaming usage counters to zero: %j",
		async (usage) => {
			const nonStreamingHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled: false })
			mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "Response" } }], usage })

			const chunks = await collectStream(nonStreamingHandler.createMessage("system prompt", []))

			expect(chunks.filter((chunk) => chunk.type === "usage")).toEqual([
				{ type: "usage", inputTokens: 0, outputTokens: 0 },
			])
		},
	)

	describe.each([true, false])("cache-write shape coverage with streaming=%s", (openAiStreamingEnabled) => {
		const usageChunksFor = async (usage: Record<string, unknown>) => {
			const cacheHandler = new OpenAiHandler({ ...mockOptions, openAiStreamingEnabled })
			mockCreate.mockResolvedValueOnce(
				openAiStreamingEnabled
					? asyncStreamFrom([{ choices: [], usage }])
					: { choices: [{ message: { content: "Response" } }], usage },
			)

			const chunks = await collectStream(cacheHandler.createMessage("system prompt", []))

			return chunks.filter((chunk) => chunk.type === "usage")
		}

		it("reads the nested cache_write_tokens shape it previously ignored", async () => {
			// This is the OpenAiHandler write gap K7 names: the handler read only
			// the top-level Anthropic-style counter, so a proxy reporting writes
			// under prompt_tokens_details billed them as zero.
			expect(
				await usageChunksFor({
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
				}),
			).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 5, cacheWriteTokens: 30, cacheReadTokens: 20 }])
		})

		it("still reads the top-level cache_creation_input_tokens shape", async () => {
			expect(
				await usageChunksFor({
					prompt_tokens: 100,
					completion_tokens: 5,
					cache_creation_input_tokens: 7,
				}),
			).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 5, cacheWriteTokens: 7 }])
		})

		it("does not bill a top-level prompt_cache_miss_tokens counter as a cache write", async () => {
			// A miss is a token that was looked up in the cache and not found, so it
			// is ordinary input that prompt_tokens already covers. Reporting it as a
			// write would move it off the input price line onto the cache-write line,
			// where most catalogs charge nothing. openai-native.ts states the same
			// rule: "missFromDetails is NOT used as fallback for cache writes".
			expect(
				await usageChunksFor({
					prompt_tokens: 1000,
					completion_tokens: 5,
					prompt_cache_miss_tokens: 400,
				}),
			).toEqual([{ type: "usage", inputTokens: 1000, outputTokens: 5 }])
		})

		it("leaves the miss tokens in the input pool that Task.ts prices", async () => {
			// This handler emits no totalCost; Task.ts recomputes it from the counters
			// in the chunk. The chunk is therefore the contract, and the money is
			// asserted against it so a label-only regression cannot pass.
			const [chunk] = await usageChunksFor({
				prompt_tokens: 1000,
				completion_tokens: 5,
				prompt_cache_miss_tokens: 400,
			})

			const customModel: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
			}

			const { totalCost } = calculateApiCostOpenAI(
				customModel,
				chunk.inputTokens,
				chunk.outputTokens,
				chunk.cacheWriteTokens,
				chunk.cacheReadTokens,
			)

			// All 1000 prompt tokens bill at the input price, including the 400 misses:
			// (3.0 / 1_000_000) * 1000 = 0.003
			// Output: (15.0 / 1_000_000) * 5 = 0.000075
			// Total: 0.003075
			expect(totalCost).toBeCloseTo(0.003075, 9)

			// The defect subtracted the 400 misses from the input pool and priced them
			// at a cache-write rate the model never declared, billing 0.001875.
			expect(totalCost).not.toBeCloseTo(0.001875, 9)
		})

		it("never sums two write shapes that report the same quantity", async () => {
			// Every shape below describes the same 30 written tokens. Summing
			// would bill 90 and is the additive-usage trap the wave forbids.
			const chunks = await usageChunksFor({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_cache_miss_tokens: 30,
				cache_creation_input_tokens: 30,
				prompt_tokens_details: { cache_miss_tokens: 30, cache_write_tokens: 30 },
			})

			expect(chunks).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 5, cacheWriteTokens: 30 }])
		})

		it("keeps a genuine write counter ahead of the Anthropic-style one", async () => {
			expect(
				await usageChunksFor({
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cache_write_tokens: 30 },
					cache_creation_input_tokens: 99,
				}),
			).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 5, cacheWriteTokens: 30 }])
		})

		it("reports no write counter when the provider reports none", async () => {
			expect(await usageChunksFor({ prompt_tokens: 100, completion_tokens: 5 })).toEqual([
				{ type: "usage", inputTokens: 100, outputTokens: 5 },
			])
		})
	})
})
