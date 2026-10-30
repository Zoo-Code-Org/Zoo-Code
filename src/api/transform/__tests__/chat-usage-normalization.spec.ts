// npx vitest run api/transform/__tests__/chat-usage-normalization.spec.ts

import { CompactLogger } from "../../../utils/logging/CompactLogger"

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

	describe("cache_creation_input_tokens (LiteLLM write shape)", () => {
		it("reads the LiteLLM top-level write counter when no DeepSeek write alias is present", () => {
			expect(
				normalizeChatUsage({
					prompt_tokens: 100,
					completion_tokens: 50,
					cache_creation_input_tokens: 20,
					cache_read_input_tokens: 30,
				}),
			).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 })
		})

		it("keeps the documented DeepSeek top-level miss counter ahead of it", () => {
			// Both describe the same writes. DeepSeek's documented shape wins and
			// the two are never added together.
			expect(
				normalizeChatUsage({
					prompt_tokens: 120,
					prompt_cache_miss_tokens: 20,
					cache_creation_input_tokens: 20,
				})?.cacheWriteTokens,
			).toBe(20)
		})

		it("keeps every DeepSeek write alias ahead of it", () => {
			expect(
				normalizeChatUsage({
					prompt_tokens: 120,
					prompt_tokens_details: { cache_miss_tokens: 20 },
					cache_creation_input_tokens: 99,
				})?.cacheWriteTokens,
			).toBe(20)

			expect(
				normalizeChatUsage({
					prompt_tokens: 120,
					prompt_tokens_details: { cache_write_tokens: 20 },
					cache_creation_input_tokens: 99,
				})?.cacheWriteTokens,
			).toBe(20)
		})

		it("does not sum it with a DeepSeek write alias reporting the same quantity", () => {
			const normalized = normalizeChatUsage({
				prompt_tokens: 120,
				completion_tokens: 30,
				prompt_cache_miss_tokens: 20,
				prompt_tokens_details: { cache_miss_tokens: 20, cache_write_tokens: 20 },
				cache_creation_input_tokens: 20,
			})

			expect(normalized?.cacheWriteTokens).toBe(20)
		})
	})

	describe("malformed counter hardening", () => {
		it.each([
			["a numeric string", "30"],
			["a fractional number", 1.5],
			["a negative number", -1],
			["NaN", NaN],
			["Infinity", Infinity],
			["an object", { tokens: 30 }],
			["a boolean", true],
		])("discards %s and falls through to the next alias", (_name, malformed) => {
			expect(
				normalizeChatUsage({
					prompt_tokens: 120,
					prompt_cache_miss_tokens: malformed,
					prompt_tokens_details: { cache_miss_tokens: 20 },
				})?.cacheWriteTokens,
			).toBe(20)
		})

		it("reports a present-but-malformed counter instead of discarding it silently", async () => {
			// A fresh module instance keeps this case independent of the dedupe
			// state that earlier cases in this file have already populated.
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: "30" })

				expect(warn).toHaveBeenCalledWith(expect.any(String), {
					path: "prompt_cache_miss_tokens",
					type: "string",
					length: 2,
					preview: "30",
				})
			} finally {
				warn.mockRestore()
			}
		})

		it("emits through a sink that is active outside tests", async () => {
			// The shared `logger` export is a no-op unless NODE_ENV is "test", so a
			// diagnostic routed through it is discarded in every real install. This
			// case simulates the production branch and asserts the warning still
			// reaches a real logger.
			const originalNodeEnv = process.env.NODE_ENV
			process.env.NODE_ENV = "production"
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")

				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: "30" })

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed token counter"), {
					path: "prompt_cache_miss_tokens",
					type: "string",
					length: 2,
					preview: "30",
				})
			} finally {
				warn.mockRestore()
				process.env.NODE_ENV = originalNodeEnv
			}
		})

		it("does not abort usage accounting when the sink itself fails", async () => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {
				throw new Error("log file unwritable")
			})

			try {
				// The malformed counter is still discarded and the valid alias still
				// resolves; a broken log sink must not surface as a usage failure.
				expect(
					freshNormalize({
						prompt_tokens: 120,
						prompt_cache_miss_tokens: "30",
						prompt_tokens_details: { cache_miss_tokens: 20 },
					})?.cacheWriteTokens,
				).toBe(20)
			} finally {
				warn.mockRestore()
			}
		})

		it("reports a malformed counter once per alias rather than on every chunk", async () => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: "30" })
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: "30" })
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: "30" })

				expect(warn).toHaveBeenCalledTimes(1)
			} finally {
				warn.mockRestore()
			}
		})

		it("names the exact field that was discarded", async () => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				freshNormalize({ prompt_tokens: "100", completion_tokens: -1 })

				expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed token counter"), {
					path: "prompt_tokens",
					type: "string",
					length: 3,
					preview: "100",
				})
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed token counter"), {
					path: "completion_tokens",
					type: "number",
					preview: -1,
				})
			} finally {
				warn.mockRestore()
			}
		})

		it("keeps the logged payload bounded for an arbitrarily large provider value", async () => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})
			const huge = "9".repeat(1_000_000)

			try {
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: huge })

				const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]

				// The raw megabyte must not reach the transport, which stringifies
				// and writes it synchronously to stdout and the log file.
				expect(meta).not.toHaveProperty("value")
				expect(meta.type).toBe("string")
				expect(meta.length).toBe(1_000_000)
				expect(typeof meta.preview).toBe("string")
				expect((meta.preview as string).length).toBeLessThanOrEqual(65)
				expect(JSON.stringify(meta).length).toBeLessThan(200)
			} finally {
				warn.mockRestore()
			}
		})

		it.each([
			["a boolean", true, { type: "boolean" }],
			["an object", { tokens: 30 }, { type: "object" }],
			["an array", [1, 2, 3], { type: "array" }],
			["NaN", NaN, { type: "number", preview: "NaN" }],
			["Infinity", Infinity, { type: "number", preview: "Infinity" }],
			["-Infinity", -Infinity, { type: "number", preview: "-Infinity" }],
			["a fractional number", 1.5, { type: "number", preview: 1.5 }],
		])("describes %s without logging the raw value", async (_name, malformed, expected) => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				freshNormalize({ prompt_tokens: 120, prompt_cache_miss_tokens: malformed })

				const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>]

				expect(meta).toEqual({ path: "prompt_cache_miss_tokens", ...expected })
			} finally {
				warn.mockRestore()
			}
		})

		it("keeps non-finite previews distinguishable after JSON serialization", async () => {
			vi.resetModules()
			const { CompactLogger: FreshCompactLogger } = await import("../../../utils/logging/CompactLogger")
			const { normalizeChatUsage: freshNormalize } = await import("../chat-usage-normalization")
			const warn = vi.spyOn(FreshCompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				// Distinct aliases so the per-path dedupe does not swallow two of the
				// three warnings.
				const serialized = [
					{ prompt_cache_miss_tokens: NaN },
					{ prompt_tokens_details: { cache_miss_tokens: Infinity } },
					{ cache_creation_input_tokens: -Infinity },
				].map((malformed) => {
					freshNormalize({ prompt_tokens: 120, ...malformed })
					const [, meta] = warn.mock.calls[warn.mock.calls.length - 1] as [string, Record<string, unknown>]
					return JSON.stringify(meta)
				})

				// The transport persists via JSON.stringify, which turns all three into
				// `null`. They must stay tellable apart in the written log line.
				expect(serialized).toEqual([
					expect.stringContaining('"preview":"NaN"'),
					expect.stringContaining('"preview":"Infinity"'),
					expect.stringContaining('"preview":"-Infinity"'),
				])
				expect(new Set(serialized).size).toBe(3)
				serialized.forEach((line) => expect(line).not.toContain('"preview":null'))
			} finally {
				warn.mockRestore()
			}
		})

		it("stays silent for counters the provider simply did not report", () => {
			const warn = vi.spyOn(CompactLogger.prototype, "warn").mockImplementation(() => {})

			try {
				normalizeChatUsage({ prompt_tokens: 100, completion_tokens: 50 })
				normalizeChatUsage({ prompt_tokens: 100, prompt_tokens_details: null })
				normalizeChatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: null })

				expect(warn).not.toHaveBeenCalled()
			} finally {
				warn.mockRestore()
			}
		})
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
