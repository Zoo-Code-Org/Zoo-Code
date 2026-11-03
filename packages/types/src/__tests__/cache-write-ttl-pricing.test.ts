// npx vitest run src/__tests__/cache-write-ttl-pricing.test.ts

import { describe, it, expect } from "vitest"

import { anthropicModels } from "../providers/anthropic.js"
import { bedrockModels } from "../providers/bedrock.js"
import { openAiNativeModels } from "../providers/openai.js"
import {
	CACHE_WRITE_MULTIPLIER_12H,
	CACHE_WRITE_MULTIPLIER_1H,
	deriveCacheWritesPrice12h,
	deriveCacheWritesPrice1h,
	type ModelInfo,
} from "../model.js"

/**
 * Catalog invariant for the TTL accounting program (ADR-0006 phase 1).
 *
 * A model that advertises prompt caching on a provider which can report a
 * long-lived cache write must carry the matching per-TTL write rate. Without it
 * the cost layer can only fall back to the aggregate write rate, which
 * under-reports every long-lived write (37.5% for Anthropic 1h, 50% for OpenAI 12h).
 */
describe("cache-write TTL pricing catalog invariant", () => {
	const anthropicFamilyEntries = Object.entries(anthropicModels as Record<string, ModelInfo>)

	const bedrockAnthropicEntries = Object.entries(bedrockModels as Record<string, ModelInfo>).filter(([id]) =>
		id.startsWith("anthropic."),
	)

	const openAiLongLivedEntries = Object.entries(openAiNativeModels as Record<string, ModelInfo>).filter(
		([id]) => id.startsWith("gpt-5.6") || id.startsWith("gpt-6"),
	)

	it("every Anthropic catalog entry with prompt caching defines cacheWritesPrice1h", () => {
		const missing = anthropicFamilyEntries
			.filter(([, info]) => info.supportsPromptCache && info.cacheWritesPrice1h === undefined)
			.map(([id]) => id)

		expect(missing).toEqual([])
	})

	it("every Bedrock Anthropic-family entry with prompt caching defines cacheWritesPrice1h", () => {
		const missing = bedrockAnthropicEntries
			.filter(([, info]) => info.supportsPromptCache && info.cacheWritesPrice1h === undefined)
			.map(([id]) => id)

		expect(missing).toEqual([])
	})

	it("every OpenAI 5.6/6-class entry defines cacheWritesPrice12h", () => {
		expect(openAiLongLivedEntries.length).toBeGreaterThan(0)

		const missing = openAiLongLivedEntries
			.filter(([, info]) => info.supportsPromptCache && info.cacheWritesPrice12h === undefined)
			.map(([id]) => id)

		expect(missing).toEqual([])
	})

	it("Anthropic 1h rates match the documented 2x input-price relationship", () => {
		for (const [id, info] of anthropicFamilyEntries) {
			if (info.cacheWritesPrice1h === undefined || info.inputPrice === undefined) continue
			expect(info.cacheWritesPrice1h, id).toBeCloseTo(info.inputPrice * CACHE_WRITE_MULTIPLIER_1H, 9)
		}
	})

	it("OpenAI 12h rates match the documented 2.5x input-price relationship", () => {
		for (const [id, info] of openAiLongLivedEntries) {
			if (info.cacheWritesPrice12h === undefined || info.inputPrice === undefined) continue
			expect(info.cacheWritesPrice12h, id).toBeCloseTo(info.inputPrice * CACHE_WRITE_MULTIPLIER_12H, 9)
		}
	})

	it("deriveCacheWritesPrice1h scales inputPrice by 2x and stays undefined without one", () => {
		expect(deriveCacheWritesPrice1h(3.0)).toBe(6.0)
		expect(deriveCacheWritesPrice1h(undefined)).toBeUndefined()
	})

	it("deriveCacheWritesPrice12h scales inputPrice by 2.5x and stays undefined without one", () => {
		expect(deriveCacheWritesPrice12h(4.0)).toBe(10.0)
		expect(deriveCacheWritesPrice12h(undefined)).toBeUndefined()
	})
})
