// npx vitest run api/transform/__tests__/chat-usage-normalization.spec.ts

import { normalizeChatUsage } from "../chat-usage-normalization"

// Documented DeepSeek usage block, copied from the vendor's OpenAPI example.
// https://api-docs.deepseek.com/api/create-chat-completion
const documentedDeepSeekUsage = {
	prompt_tokens: 7,
	completion_tokens: 11,
	total_tokens: 18,
	prompt_tokens_details: { cached_tokens: 0 },
	prompt_cache_hit_tokens: 0,
	prompt_cache_miss_tokens: 7,
}

describe("normalizeChatUsage", () => {
	it("returns undefined when the provider sent no usage object", () => {
		expect(normalizeChatUsage(undefined)).toBeUndefined()
		expect(normalizeChatUsage(null)).toBeUndefined()
	})

	it("returns undefined for a truthy non-object usage value", () => {
		// A malformed proxy can send a scalar where the usage object belongs.
		expect(normalizeChatUsage("usage" as unknown as Record<string, unknown>)).toBeUndefined()
		expect(normalizeChatUsage(0 as unknown as Record<string, unknown>)).toBeUndefined()
	})

	it("reads the documented DeepSeek top-level shape", () => {
		expect(normalizeChatUsage(documentedDeepSeekUsage)).toEqual({
			inputTokens: 7,
			outputTokens: 11,
			cacheReadTokens: 0,
			cacheWriteTokens: 7,
		})
	})

	it("reads a top-level-only usage object with no nested details", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 120,
				completion_tokens: 30,
				prompt_cache_hit_tokens: 100,
				prompt_cache_miss_tokens: 20,
			}),
		).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 20 })
	})

	it("reads the nested-only shape used by OpenAI and by legacy DeepSeek fixtures", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 100,
				completion_tokens: 50,
				prompt_tokens_details: { cached_tokens: 20, cache_miss_tokens: 80 },
			}),
		).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 80 })
	})

	it("does not add the nested and top-level shapes together when both are present", () => {
		// Both shapes describe the same 100 reads / 20 writes. Summing would
		// report 200 / 40 and double the billed cache tokens.
		const normalized = normalizeChatUsage({
			prompt_tokens: 120,
			completion_tokens: 30,
			prompt_tokens_details: { cached_tokens: 100, cache_miss_tokens: 20 },
			prompt_cache_hit_tokens: 100,
			prompt_cache_miss_tokens: 20,
		})

		expect(normalized?.cacheReadTokens).toBe(100)
		expect(normalized?.cacheWriteTokens).toBe(20)
	})

	it("prefers the nested cached_tokens over the top-level hit counter for reads", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 120,
				prompt_tokens_details: { cached_tokens: 100 },
				prompt_cache_hit_tokens: 90,
			})?.cacheReadTokens,
		).toBe(100)
	})

	it("prefers the top-level miss counter over the nested one for writes", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 120,
				prompt_tokens_details: { cache_miss_tokens: 20 },
				prompt_cache_miss_tokens: 30,
			})?.cacheWriteTokens,
		).toBe(30)
	})

	it("falls through a malformed alias to the next one", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 120,
				prompt_cache_miss_tokens: "30",
				prompt_tokens_details: { cache_miss_tokens: 20 },
			})?.cacheWriteTokens,
		).toBe(20)
	})

	it("leaves cache counters undefined when the provider reports none", () => {
		const normalized = normalizeChatUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })

		expect(normalized).toEqual({ inputTokens: 100, outputTokens: 50 })
		expect(normalized).not.toHaveProperty("cacheReadTokens")
		expect(normalized).not.toHaveProperty("cacheWriteTokens")
	})

	it("rejects negative and fractional token counts", () => {
		expect(
			normalizeChatUsage({
				prompt_tokens: 120,
				prompt_cache_hit_tokens: -1,
				prompt_cache_miss_tokens: 1.5,
			}),
		).toEqual({ inputTokens: 120, outputTokens: 0 })
	})

	it("defaults missing prompt and completion tokens to zero", () => {
		expect(normalizeChatUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
	})
})
