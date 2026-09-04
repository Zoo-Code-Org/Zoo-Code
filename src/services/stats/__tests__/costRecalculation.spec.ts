// src/services/stats/__tests__/costRecalculation.spec.ts
//
// Tests for Feature 1: Recalculate cost for old usage events at query time.

import { describe, it, expect } from "vitest"
import { providerIdentifiers } from "@roo-code/types"

import type { UsageEventV1 } from "@roo-code/types"

import {
	getEffectiveCost,
	computeEventCost,
	lookupModelInfo,
	providerReportsCache,
	computeCacheDiscountBase,
	applyCacheDiscount,
	customPricingKey,
	computeCostFromAggregated,
} from "../costRecalculation"

// ── Test Helpers ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: "2026-07-19T10:00:00.000Z",
		timezoneOffsetMinutes: 540,
		status: "completed",
		attempt: 1,
		taskId: "task-001",
		provider: providerIdentifiers.anthropic,
		model: "claude-sonnet-4-5",
		mode: "code",
		usage: {
			inputTokens: { value: 1000, source: "provider" },
			outputTokens: { value: 500, source: "provider" },
		},
		semantics: {
			cacheReadInInput: "excluded",
			cacheWriteInInput: "excluded",
			reasoningInOutput: "excluded",
		},
		provenance: "live",
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("costRecalculation", () => {
	describe("lookupModelInfo", () => {
		it("should find model info for a known Anthropic model", () => {
			const info = lookupModelInfo("anthropic", "claude-sonnet-4-5")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(3.0)
			expect(info?.outputPrice).toBe(15.0)
		})

		it("should find model info for a known OpenAI model", () => {
			const info = lookupModelInfo("openai", "gpt-5.6-sol")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(5.0)
		})

		it("should resolve openai-codex models to openAiNativeModels pricing (non-zero)", () => {
			// Regression test for Bug 2: openai-codex was mapped to openAiCodexModels
			// which has all-zero prices. Now it maps to openAiNativeModels so users
			// see the equivalent API cost.
			const info = lookupModelInfo("openai-codex", "gpt-5.6-sol")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(5.0)
			expect(info?.outputPrice).toBe(30.0)
		})

		it("should resolve qwen-code models to qwenCodeModels pricing", () => {
			const info = lookupModelInfo("qwen-code", "qwen3-coder-plus")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(0)
			expect(info?.outputPrice).toBe(0)
		})

		it("should return undefined for an unknown provider", () => {
			const info = lookupModelInfo("unknown-provider", "some-model")
			expect(info).toBeUndefined()
		})

		it("should return undefined for a model with no substring match in a known provider", () => {
			const info = lookupModelInfo("anthropic", "zzz-nonexistent-xyz")
			expect(info).toBeUndefined()
		})

		it("should match via substring for versioned model IDs", () => {
			// "claude-sonnet-4-20250514" should match "claude-sonnet-4" family
			const info = lookupModelInfo("anthropic", "claude-sonnet-4-20250514")
			expect(info).toBeDefined()
		})

		it("should pick the longest matching substring when multiple known IDs match", () => {
			// The model string contains both "claude-sonnet-4-20250514" and "claude-sonnet-4".
			// The lookup iterates over sorted known IDs and returns the first (longest) match.
			const info = lookupModelInfo("anthropic", "claude-sonnet-4-20250514-snapshot")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(3.0)
			expect(info?.outputPrice).toBe(15.0)
		})
	})

	describe("computeEventCost", () => {
		it("should return 0 when event already has a costUsd value", () => {
			const event = makeEvent({
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.05, source: "provider" },
				},
			})
			// computeEventCost returns the stored cost when present
			expect(computeEventCost(event)).toBe(0.05)
		})

		it("should compute cost for Anthropic event with missing costUsd", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing
				},
			})
			// Anthropic claude-sonnet-4-5: $3/1M input tokens
			// 1M input tokens × $3/1M = $3.0
			expect(computeEventCost(event)).toBeCloseTo(3.0, 5)
		})

		it("should compute cost for OpenAI event with missing costUsd", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "gpt-5.6-sol",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing
				},
			})
			// OpenAI gpt-5.6-sol: $5/1M input tokens (below long-context threshold of 272K)
			// 100K input tokens at $5/1M = $0.5
			expect(computeEventCost(event)).toBeCloseTo(0.5, 5)
		})

		it("should return 0 when model info is not available", () => {
			const event = makeEvent({
				provider: "unknown-provider",
				model: "unknown-model",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			expect(computeEventCost(event)).toBe(0)
		})

		it("should return 0 when all token counts are zero", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					// All tokens zero/missing
				},
			})
			expect(computeEventCost(event)).toBe(0)
		})

		it("should include cache costs for Anthropic-semantic providers", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 0, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					cacheWriteTokens: { value: 1_000_000, source: "provider" },
					cacheReadTokens: { value: 1_000_000, source: "provider" },
					// costUsd missing
				},
			})
			// claude-sonnet-4-5: cacheWritesPrice=$3.75/1M, cacheReadsPrice=$0.30/1M
			// 1M cache write × $3.75/1M + 1M cache read × $0.30/1M = $4.05
			expect(computeEventCost(event)).toBeCloseTo(4.05, 5)
		})

		it("should compute non-zero cost for openai-codex (ChatGPT Plus/Pro) event with missing costUsd", () => {
			// Regression test for Bug 2: openai-codex events always showed $0.00
			// because openAiCodexModels has all-zero prices.
			// Fix: costRecalculation.ts maps "openai-codex" → openAiNativeModels
			// so users see the equivalent API cost.
			const event = makeEvent({
				provider: providerIdentifiers.openaiCodex,
				model: "gpt-5.6-sol",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing — simulates the old totalCost: 0 → falsy → undefined path
				},
			})
			// openAiNativeModels["gpt-5.6-sol"]: inputPrice=$5.0/1M
			// 100K input tokens × $5/1M = $0.5
			// This must NOT be 0 — that was the bug.
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(0.5, 5)
		})

		it("should compute non-zero cost for openai-codex with output tokens", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openaiCodex,
				model: "gpt-5.6-sol",
				usage: {
					// Use 100K each (200K total < 272K long-context threshold)
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 100_000, source: "provider" },
					// costUsd missing
				},
			})
			// openAiNativeModels["gpt-5.6-sol"]: inputPrice=$5.0/1M, outputPrice=$30.0/1M
			// 100K input × $5/1M + 100K output × $30/1M = $0.5 + $3.0 = $3.5
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(3.5, 5)
		})

		it("should compute non-zero cost for anthropic event with missing costUsd", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-3-5-sonnet-20241022",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing
				},
			})
			// anthropic claude-3-5-sonnet-20241022: inputPrice=$3.0/1M
			// 100K input tokens × $3.0/1M = $0.3
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(0.3, 5)
		})

		it("should compute non-zero cost for anthropic with input + output tokens", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-3-5-sonnet-20241022",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 100_000, source: "provider" },
					// costUsd missing
				},
			})
			// 100K input × $3/1M + 100K output × $15/1M = $0.3 + $1.5 = $1.8
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(1.8, 5)
		})

		it("should use OpenAI semantics for Vertex Gemini models (inputTokens includes cached tokens)", () => {
			// Vertex Gemini uses OpenAI semantics: inputTokens includes cacheReadTokens and cacheWriteTokens.
			// gemini-3.7-flash: inputPrice=$0.75/1M, outputPrice=$3.75/1M, cacheReadsPrice=$0.075/1M, cacheWritesPrice=$0.5/1M
			const event = makeEvent({
				provider: providerIdentifiers.vertex,
				model: "gemini-3.7-flash",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 100_000, source: "provider" },
					cacheWriteTokens: { value: 100_000, source: "provider" },
					cacheReadTokens: { value: 200_000, source: "provider" },
				},
			})
			// nonCachedInputTokens = 1,000,000 - 200,000 - 100,000 = 700,000
			// cost = 0.7M * $0.75 + 0.1M * $0.5 + 0.2M * $0.075 + 0.1M * $3.75
			//      = 0.525 + 0.05 + 0.015 + 0.375 = 0.965
			const cost = computeEventCost(event)
			expect(cost).toBeCloseTo(0.965, 5)
		})

		it("should use Anthropic semantics for Vertex Claude models (inputTokens excludes cached tokens)", () => {
			// Vertex Claude uses Anthropic semantics: inputTokens does NOT include cached tokens.
			// claude-sonnet-4-5@20250929: inputPrice=$3.0/1M, outputPrice=$15.0/1M, cacheReadsPrice=$0.30/1M, cacheWritesPrice=$3.75/1M
			const event = makeEvent({
				provider: providerIdentifiers.vertex,
				model: "claude-sonnet-4-5@20250929",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 10_000, source: "provider" },
					cacheWriteTokens: { value: 10_000, source: "provider" },
					cacheReadTokens: { value: 20_000, source: "provider" },
				},
			})
			// cost = 0.1M * $3.0 + 0.01M * $3.75 + 0.02M * $0.30 + 0.01M * $15.0
			//      = 0.30 + 0.0375 + 0.006 + 0.15 = 0.4935
			const cost = computeEventCost(event)
			expect(cost).toBeCloseTo(0.4935, 5)
		})
	})

	describe("getEffectiveCost", () => {
		it("should return stored cost when present", () => {
			const event = makeEvent({
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					costUsd: { value: 0.02, source: "provider" },
				},
			})
			expect(getEffectiveCost(event)).toBe(0.02)
		})

		it("should compute cost when costUsd is missing", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing
				},
			})
			expect(getEffectiveCost(event)).toBeCloseTo(3.0, 5)
		})

		it("should return 0 when costUsd is missing and model is unknown", () => {
			const event = makeEvent({
				provider: "unknown-provider",
				model: "unknown-model",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					// costUsd missing
				},
			})
			expect(getEffectiveCost(event)).toBe(0)
		})

		it("should return 0 when costUsd is undefined (not just missing value)", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					// costUsd is undefined (not present in usage object)
				},
			})
			// Should compute from pricing: 1000 × $3/1M = $0.003
			expect(getEffectiveCost(event)).toBeCloseTo(0.003, 5)
		})

		it("should compute non-zero cost for openai-codex event when costUsd is undefined", () => {
			// Regression test for Bug 2: openai-codex provider hardcoded totalCost: 0,
			// which UsageRecorder stored as costUsd: undefined (0 is falsy).
			// getEffectiveCost must fall through to computeEventCost and return
			// a non-zero value from openAiNativeModels pricing.
			const event = makeEvent({
				provider: providerIdentifiers.openaiCodex,
				model: "gpt-5.6-sol",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd is undefined — simulates the old totalCost: 0 → falsy → undefined path
				},
			})
			// openAiNativeModels["gpt-5.6-sol"]: inputPrice=$5.0/1M
			// 100K input tokens × $5/1M = $0.5
			// Must NOT be 0 — that was the bug.
			const cost = getEffectiveCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(0.5, 5)
		})
	})

	describe("computeCacheDiscountBase", () => {
		it("should return 0 when cacheReadTokens are server-reported", () => {
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					cacheReadTokens: { value: 300, source: "provider" },
				},
			})
			// Reported cache reads keep the verbatim cost path — no discount.
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("should return 0 when model pricing is unavailable", () => {
			const event = makeEvent({
				provider: "unknown-provider",
				model: "unknown-model",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
				},
			})
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("should return 0 when the model has no cache-read pricing", () => {
			// mistralModels["magistral-medium-latest"] has inputPrice but no cacheReadsPrice.
			const event = makeEvent({
				provider: providerIdentifiers.mistral,
				model: "magistral-medium-latest",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
				},
			})
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("should return 0 for cache-reporting provider with cacheRead=0 (true cache miss)", () => {
			// Bug 1 fix: anthropic reports cache. cacheRead=0 is a TRUE cache miss,
			// not "unreported". The slider must NOT vary the cost.
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					// cacheReadTokens missing → cache miss for a reporting provider
				},
			})
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("should return 0 when inputPrice is not cheaper than cacheReadsPrice", () => {
			// A synthetic event with zero input tokens always has a zero base.
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 0, source: "provider" },
				},
			})
			expect(computeCacheDiscountBase(event)).toBe(0)
		})
	})

	// ── Contract Tests: cacheRatio slider behavior ───────────────────────────

	describe("cacheRatio slider contract", () => {
		it("reported-provider event with cacheRead=0: cost invariant under ratio 0 vs 0.94", () => {
			// Bug 1: anthropic reports cache. cacheRead=0 is a true cache miss.
			// The slider must NOT vary the cost, and tokens must NOT be estimated.
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
					// cacheReadTokens missing → cache miss for a reporting provider
				},
			})

			// computeCacheDiscountBase must be 0 (no discount to apply).
			expect(computeCacheDiscountBase(event)).toBe(0)

			// Cost is invariant under any ratio.
			const baseCost = getEffectiveCost(event)
			expect(applyCacheDiscount(baseCost, computeCacheDiscountBase(event), 0)).toBe(baseCost)
			expect(applyCacheDiscount(baseCost, computeCacheDiscountBase(event), 0.94)).toBe(baseCost)
			expect(applyCacheDiscount(baseCost, computeCacheDiscountBase(event), 1)).toBe(baseCost)
		})

		it("unreported-provider event with unknown pricing: cost unchanged under any ratio", () => {
			// Bug 2: custom endpoint model not in static registry.
			// No pricing → discountBase = 0 → cost stays as-is.
			const event = makeEvent({
				provider: "unknown-provider",
				model: "custom-endpoint-model",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})

			expect(computeCacheDiscountBase(event)).toBe(0)

			const baseCost = getEffectiveCost(event)
			expect(applyCacheDiscount(baseCost, computeCacheDiscountBase(event), 0)).toBe(baseCost)
			expect(applyCacheDiscount(baseCost, computeCacheDiscountBase(event), 0.94)).toBe(baseCost)
		})

		it("reported-provider event: tokens unestimated (cacheRead stays 0)", () => {
			// Bug 1: for reporting providers, cacheReadTokens must NOT be estimated.
			// This is tested at the computeEventDelta level in UsageAggregator.spec.ts.
			// Here we verify the discount base is 0, which prevents estimation.
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					// cacheReadTokens missing
				},
			})
			// If discountBase is 0, the aggregator's isCacheReadUnreported check
			// determines whether to estimate. With the fix, isCacheReadUnreported
			// is false for reporting providers, so no estimation occurs.
			expect(computeCacheDiscountBase(event)).toBe(0)
		})
	})

	describe("applyCacheDiscount", () => {
		it("should leave the cost unchanged when cacheRatio is undefined or 0", () => {
			expect(applyCacheDiscount(0.01, 0.0027)).toBe(0.01)
			expect(applyCacheDiscount(0.01, 0.0027, 0)).toBe(0.01)
		})

		it("should subtract cacheRatio × discountBase", () => {
			// 0.01 − 0.5 × 0.0027 = 0.00865
			expect(applyCacheDiscount(0.01, 0.0027, 0.5)).toBeCloseTo(0.00865, 10)
			// 0.01 − 1 × 0.0027 = 0.0073
			expect(applyCacheDiscount(0.01, 0.0027, 1)).toBeCloseTo(0.0073, 10)
		})

		it("should floor the discounted cost at 0", () => {
			expect(applyCacheDiscount(0.001, 0.01, 1)).toBe(0)
		})
	})

	// ── Custom Model Pricing (modelPricing) Tests ──────────────────────────────

	describe("custom model pricing via modelPricing", () => {
		it("lookupModelInfo should fall back to modelPricing for unknown provider", () => {
			const pricing = { inputPrice: 2.0, outputPrice: 6.0, cacheReadsPrice: 0.5 }
			const info = lookupModelInfo("openai", "my-custom-model", pricing)
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(2.0)
			expect(info?.outputPrice).toBe(6.0)
			expect(info?.cacheReadsPrice).toBe(0.5)
		})

		it("lookupModelInfo should prefer static registry over modelPricing", () => {
			// anthropic/claude-sonnet-4-5 is in the static registry with
			// inputPrice=3.0. Even if modelPricing says 99.0, the static
			// registry value must win.
			const pricing = { inputPrice: 99.0, outputPrice: 99.0 }
			const info = lookupModelInfo("anthropic", "claude-sonnet-4-5", pricing)
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(3.0)
			expect(info?.outputPrice).toBe(15.0)
		})

		it("lookupModelInfo should return undefined when neither registry nor modelPricing", () => {
			const info = lookupModelInfo("unknown-provider", "unknown-model")
			expect(info).toBeUndefined()
		})

		it("lookupModelInfo should return undefined when modelPricing is undefined", () => {
			const info = lookupModelInfo("unknown-provider", "unknown-model", undefined)
			expect(info).toBeUndefined()
		})

		it("providerReportsCache should return false for custom model with cacheReadsPrice (not in static registry)", () => {
			// Custom models are NOT in the static registry, so even if they
			// define cacheReadsPrice, the provider's API doesn't report
			// cacheReadTokens. The slider should work for these models.
			const pricing = { inputPrice: 2.0, cacheReadsPrice: 0.5 }
			expect(providerReportsCache(providerIdentifiers.openai, "my-custom-model", pricing)).toBe(false)
		})

		it("providerReportsCache should return false for custom model without cacheReadsPrice", () => {
			const pricing = { inputPrice: 2.0, outputPrice: 6.0 }
			expect(providerReportsCache(providerIdentifiers.openai, "my-custom-model", pricing)).toBe(false)
		})

		it("providerReportsCache should return false for custom model with undefined modelPricing", () => {
			expect(providerReportsCache(providerIdentifiers.openai, "my-custom-model", undefined)).toBe(false)
		})

		it("computeCacheDiscountBase should return positive discount for custom model with cacheReadsPrice (non-reporting)", () => {
			// Custom model NOT in static registry → providerReportsCache returns false
			// → discountBase = (inputTokens/1M) × (inputPrice − cacheReadsPrice)
			// = (1000/1M) × (2.0 − 0.5) = 0.001 × 1.5 = 0.0015
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				modelPricing: { inputPrice: 2.0, outputPrice: 6.0, cacheReadsPrice: 0.5 },
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			expect(computeCacheDiscountBase(event)).toBeCloseTo(0.0015, 10)
		})

		it("computeCacheDiscountBase should return 0 for custom model without cacheReadsPrice", () => {
			// Custom model without cacheReadsPrice → providerReportsCache returns false
			// but computeCacheDiscountBase guard checks `typeof cacheReadsPrice !== "number"`
			// which fails → returns 0
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				modelPricing: { inputPrice: 2.0, outputPrice: 6.0 },
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("computeEventCost should compute cost from modelPricing for custom model", () => {
			// Custom model: inputPrice=2.0, outputPrice=6.0
			// OpenAI semantic: inputTokens includes cached tokens
			// cost = (1000 / 1M) * 2.0 + (500 / 1M) * 6.0 = 0.002 + 0.003 = 0.005
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				modelPricing: { inputPrice: 2.0, outputPrice: 6.0, cacheReadsPrice: 0.5 },
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing — should compute from modelPricing
				},
			})
			expect(computeEventCost(event)).toBeCloseTo(0.005, 10)
		})

		it("getEffectiveCost should use modelPricing when costUsd is missing", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				modelPricing: { inputPrice: 2.0, outputPrice: 6.0 },
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			// (1000 / 1M) * 2.0 + (500 / 1M) * 6.0 = 0.002 + 0.003 = 0.005
			expect(getEffectiveCost(event)).toBeCloseTo(0.005, 10)
		})

		it("static registry model should ignore modelPricing on event", () => {
			// anthropic/claude-sonnet-4-5 is in the static registry.
			// Even if the event carries modelPricing, the static registry
			// value must be used.
			const event = makeEvent({
				provider: providerIdentifiers.anthropic,
				model: "claude-sonnet-4-5",
				modelPricing: { inputPrice: 99.0, outputPrice: 99.0, cacheReadsPrice: 99.0 },
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			// Static registry: inputPrice=3.0, outputPrice=15.0
			// Anthropic semantic: inputTokens does NOT include cached tokens
			// cost = (1000 / 1M) * 3.0 + (500 / 1M) * 15.0 = 0.003 + 0.0075 = 0.0105
			expect(getEffectiveCost(event)).toBeCloseTo(0.0105, 10)
		})

		// ── Query-time CustomModelPricingMap tests ──────────────────────────

		it("lookupModelInfo should use customPricing map when model is not in static registry", () => {
			const map = new Map([["openai|my-custom-model", { inputPrice: 2.0, outputPrice: 6.0 }]])
			const info = lookupModelInfo("openai", "my-custom-model", undefined, map)
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(2.0)
			expect(info?.outputPrice).toBe(6.0)
		})

		it("lookupModelInfo should prefer customPricing map over static registry", () => {
			// anthropic/claude-sonnet-4-5 is in the static registry with inputPrice=3.0.
			// When customPricing specifies custom price overrides (e.g. 99.0),
			// customPricing must take precedence over static default registry models.
			const map = new Map([["anthropic|claude-sonnet-4-5", { inputPrice: 99.0, outputPrice: 99.0 }]])
			const info = lookupModelInfo("anthropic", "claude-sonnet-4-5", undefined, map)
			expect(info?.inputPrice).toBe(99.0)
		})

		it("lookupModelInfo should prefer customPricing map over event modelPricing", () => {
			// User-configured custom pricing map takes precedence over capture-time modelPricing
			const map = new Map([["openai|my-custom-model", { inputPrice: 99.0, outputPrice: 99.0 }]])
			const info = lookupModelInfo("openai", "my-custom-model", { inputPrice: 2.0, outputPrice: 6.0 }, map)
			expect(info?.inputPrice).toBe(99.0)
		})

		it("computeCacheDiscountBase should return positive discount for custom model with cacheReadsPrice via customPricing", () => {
			// Custom model NOT in static registry → providerReportsCache returns false
			// → discountBase = (1_000_000/1M) × (2.0 − 0.5) = 1.5
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				// modelPricing intentionally absent — simulating post-revert events
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			const map = new Map([["openai|my-custom-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])
			expect(computeCacheDiscountBase(event, map)).toBeCloseTo(1.5, 10)
		})

		it("computeCacheDiscountBase should return positive discount for non-registry model even with customPricing", () => {
			// Custom model NOT in static registry → providerReportsCache returns false
			// → discountBase = (1_000_000/1M) × (2.0 − 0.5) = 1.5
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-reporting-model",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			const map = new Map([["openai|my-reporting-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])
			expect(computeCacheDiscountBase(event, map)).toBeCloseTo(1.5, 10)
		})

		it("computeCacheDiscountBase should return 0 when customPricing has no cacheReadsPrice", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			const map = new Map([["openai|my-custom-model", { inputPrice: 2.0, outputPrice: 6.0 }]])
			// No cacheReadsPrice → guard check fails → 0
			expect(computeCacheDiscountBase(event, map)).toBe(0)
		})

		it("computeCacheDiscountBase should return 0 when customPricing is absent", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
				},
			})
			// No modelPricing on event, no customPricing map → lookupModelInfo returns undefined
			expect(computeCacheDiscountBase(event)).toBe(0)
		})

		it("getEffectiveCost should use customPricing when costUsd is missing", () => {
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			const map = new Map([["openai|my-custom-model", { inputPrice: 2.0, outputPrice: 6.0 }]])
			// (1000 / 1M) * 2.0 + (500 / 1M) * 6.0 = 0.002 + 0.003 = 0.005
			expect(getEffectiveCost(event, map)).toBeCloseTo(0.005, 10)
		})

		it("customPricingKey should build correct map key", () => {
			expect(customPricingKey("openai", "gpt-4")).toBe("openai|gpt-4")
			expect(customPricingKey("anthropic", "claude-sonnet-4")).toBe("anthropic|claude-sonnet-4")
		})

		it("full chain: customPricing → getEffectiveCost → computeCacheDiscountBase → applyCacheDiscount", () => {
			// Simulate the full query-time chain for a custom model:
			// inputPrice=3.0, cacheReadsPrice=0.3 (same as anthropic, but custom)
			// inputTokens=1_000_000, no costUsd, no modelPricing on event
			const event = makeEvent({
				provider: providerIdentifiers.openai,
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 1_000_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
				},
			})
			const map = new Map([["openai|my-custom-model", { inputPrice: 3.0, cacheReadsPrice: 0.3 }]])
			// Cost: (1_000_000 / 1M) * 3.0 = 3.0
			const cost = getEffectiveCost(event, map)
			expect(cost).toBeCloseTo(3.0, 10)

			// Discount base: (1_000_000 / 1M) × (3.0 − 0.3) = 2.7
			// Custom model NOT in static registry → providerReportsCache returns false
			const discountBase = computeCacheDiscountBase(event, map)
			expect(discountBase).toBeCloseTo(2.7, 10)

			// With cacheRatio=0.5: discounted = 3.0 − 0.5 × 2.7 = 1.65
			const discounted = applyCacheDiscount(cost, discountBase, 0.5)
			expect(discounted).toBeCloseTo(1.65, 10)
		})
	})

	describe("computeCostFromAggregated", () => {
		it("should use OpenAI semantics for Vertex Gemini models", () => {
			// gemini-3.7-flash: inputPrice=$0.75/1M, outputPrice=$3.75/1M, cacheReadsPrice=$0.075/1M, cacheWritesPrice=$0.5/1M
			// inputTokens = 1,000,000, outputTokens = 100,000, cacheWriteTokens = 100,000, cacheReadTokens = 200,000
			// nonCachedInputTokens = 1,000,000 - 200,000 - 100,000 = 700,000
			// cost = 0.7M * $0.75 + 0.1M * $0.5 + 0.2M * $0.075 + 0.1M * $3.75 = 0.965
			const cost = computeCostFromAggregated("vertex", "gemini-3.7-flash", 1_000_000, 100_000, 100_000, 200_000)
			expect(cost).toBeCloseTo(0.965, 5)
		})

		it("should use Anthropic semantics for Vertex Claude models", () => {
			// claude-sonnet-4-5@20250929: inputPrice=$3.0/1M, outputPrice=$15.0/1M, cacheReadsPrice=$0.30/1M, cacheWritesPrice=$3.75/1M
			// inputTokens = 100,000, outputTokens = 10,000, cacheWriteTokens = 10,000, cacheReadTokens = 20,000
			// cost = 0.1M * $3.0 + 0.01M * $3.75 + 0.02M * $0.30 + 0.01M * $15.0 = 0.4935
			const cost = computeCostFromAggregated(
				"vertex",
				"claude-sonnet-4-5@20250929",
				100_000,
				10_000,
				10_000,
				20_000,
			)
			expect(cost).toBeCloseTo(0.4935, 5)
		})

		it("should return 0 when all token counts are zero", () => {
			const cost = computeCostFromAggregated("vertex", "gemini-3.7-flash", 0, 0, 0, 0)
			expect(cost).toBe(0)
		})

		it("should return 0 for unknown provider", () => {
			const cost = computeCostFromAggregated("unknown-provider", "unknown-model", 1000, 1000, 0, 0)
			expect(cost).toBe(0)
		})
	})
})
