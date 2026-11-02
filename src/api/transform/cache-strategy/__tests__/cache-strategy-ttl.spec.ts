// npx vitest run src/api/transform/cache-strategy/__tests__/cache-strategy-ttl.spec.ts

import type { ContentBlock, SystemContentBlock } from "@aws-sdk/client-bedrock-runtime"

import { MultiPointStrategy } from "../multi-point-strategy"
import type { CacheStrategyConfig, ModelInfo } from "../types"

/**
 * TTL threading through the cache strategy (ADR-0006 PR-C7).
 *
 * The strategy is the single owner of the cache-point shape, so these tests pin the
 * two properties the provider relies on: a configured TTL reaches every cache point
 * it emits, and an unset TTL leaves the block byte-identical to a pre-knob build.
 */

const modelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsPromptCache: true,
	maxCachePoints: 4,
	minTokensPerCachePoint: 50,
	cachableFields: ["system", "messages", "tools"],
}

// The strategy estimates tokens by counting whitespace-separated words, so the
// fixtures need real words rather than one long run of characters.
const longText = (tokens: number) => "word ".repeat(tokens)

const createConfig = (overrides: Partial<CacheStrategyConfig> = {}): CacheStrategyConfig => ({
	modelInfo,
	systemPrompt: longText(200),
	messages: [
		{ role: "user", content: longText(200) },
		{ role: "assistant", content: longText(200) },
		{ role: "user", content: longText(200) },
	],
	usePromptCache: true,
	...overrides,
})

const collectCachePoints = (value: unknown): Array<Record<string, unknown>> => {
	const found: Array<Record<string, unknown>> = []

	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(walk)
			return
		}

		if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
				if (key === "cachePoint" && child && typeof child === "object") {
					found.push(child as Record<string, unknown>)
				}
				walk(child)
			}
		}
	}

	walk(value)
	return found
}

const serialize = (value: unknown) => JSON.parse(JSON.stringify(value))

describe("MultiPointStrategy cache TTL", () => {
	it("carries the configured TTL on the system and message cache points", () => {
		const strategy = new MultiPointStrategy(createConfig({ cacheTtl: "1h" }))
		const result = strategy.determineOptimalCachePoints()

		const cachePoints = collectCachePoints(serialize({ system: result.system, messages: result.messages }))

		expect(collectCachePoints(serialize(result.system)).length).toBeGreaterThan(0)
		expect(collectCachePoints(serialize(result.messages)).length).toBeGreaterThan(0)
		for (const cachePoint of cachePoints) {
			expect(cachePoint).toEqual({ type: "default", ttl: "1h" })
		}
	})

	it("omits the ttl key entirely when no TTL is configured", () => {
		const strategy = new MultiPointStrategy(createConfig())
		const result = strategy.determineOptimalCachePoints()

		const cachePoints = collectCachePoints(serialize({ system: result.system, messages: result.messages }))

		expect(cachePoints.length).toBeGreaterThan(0)
		for (const cachePoint of cachePoints) {
			// Deep-equality against the pre-knob literal, not just "no ttl": a stray
			// extra key would change the request bytes just as surely.
			expect(cachePoint).toEqual({ type: "default" })
		}
	})

	it("places the same cache points with and without a TTL", () => {
		const withoutTtl = new MultiPointStrategy(createConfig()).determineOptimalCachePoints()
		const withTtl = new MultiPointStrategy(createConfig({ cacheTtl: "1h" })).determineOptimalCachePoints()

		expect(withTtl.messageCachePointPlacements).toEqual(withoutTtl.messageCachePointPlacements)
		expect(collectCachePoints(serialize(withTtl.system)).length).toBe(
			collectCachePoints(serialize(withoutTtl.system)).length,
		)
	})

	it("keeps createCachePoint public so the provider's second emitter can reuse it", () => {
		// The provider's message-level emitter used to build its own literal, which is
		// how two emitters drift apart. Asserting the method is reachable from outside
		// the class is the cheap structural guard against it going back to private.
		const strategy = new MultiPointStrategy(createConfig({ cacheTtl: "1h" }))
		const block = strategy.createCachePoint() as unknown as { cachePoint: Record<string, unknown> }

		expect(block.cachePoint).toEqual({ type: "default", ttl: "1h" })
		expect(typeof (block as unknown as ContentBlock)).toBe("object")
	})

	it("returns an untyped-compatible block for the system union as well", () => {
		const strategy = new MultiPointStrategy(createConfig({ cacheTtl: "1h" }))
		const block = strategy.createCachePoint() as unknown as SystemContentBlock

		expect(collectCachePoints(serialize(block))).toEqual([{ type: "default", ttl: "1h" }])
	})
})
