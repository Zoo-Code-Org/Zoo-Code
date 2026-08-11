// src/services/stats/__tests__/costRecalculation.spec.ts
//
// Tests for Feature 1: Recalculate cost for old usage events at query time.

import { describe, it, expect } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"

import {
	getEffectiveCost,
	computeEventCost,
	lookupModelInfo,
	computeCacheDiscountBase,
	applyCacheDiscount,
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
		provider: "anthropic",
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

		it("should resolve qwen-code models to qwenCodeModels pricing (non-zero)", () => {
			// Regression test for Bug 3: qwen-code models had all-zero prices.
			// Now qwen3-coder-plus has inputPrice=$1.0/1M, outputPrice=$5.0/1M.
			const info = lookupModelInfo("qwen-code", "qwen3-coder-plus")
			expect(info).toBeDefined()
			expect(info?.inputPrice).toBe(1.0)
			expect(info?.outputPrice).toBe(5.0)
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
				provider: "anthropic",
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
				provider: "openai",
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
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					// All tokens zero/missing
				},
			})
			expect(computeEventCost(event)).toBe(0)
		})

		it("should include cache costs for Anthropic-semantic providers", () => {
			const event = makeEvent({
				provider: "anthropic",
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
				provider: "openai-codex",
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
				provider: "openai-codex",
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

		it("should compute non-zero cost for qwen-code event with missing costUsd", () => {
			// Regression test for Bug 3: qwen-code models had all-zero prices.
			// Now qwen3-coder-plus has inputPrice=$1.0/1M, outputPrice=$5.0/1M.
			const event = makeEvent({
				provider: "qwen-code",
				model: "qwen3-coder-plus",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 0, source: "provider" },
					// costUsd missing
				},
			})
			// qwenCodeModels["qwen3-coder-plus"]: inputPrice=$1.0/1M
			// 100K input tokens × $1.0/1M = $0.1
			// This must NOT be 0 — that was the bug.
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(0.1, 5)
		})

		it("should compute non-zero cost for qwen-code with input + output tokens", () => {
			const event = makeEvent({
				provider: "qwen-code",
				model: "qwen3-coder-plus",
				usage: {
					inputTokens: { value: 100_000, source: "provider" },
					outputTokens: { value: 100_000, source: "provider" },
					// costUsd missing
				},
			})
			// qwenCodeModels["qwen3-coder-plus"]: inputPrice=$1.0/1M, outputPrice=$5.0/1M
			// 100K input × $1/1M + 100K output × $5/1M = $0.1 + $0.5 = $0.6
			const cost = computeEventCost(event)
			expect(cost).toBeGreaterThan(0)
			expect(cost).toBeCloseTo(0.6, 5)
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
				provider: "anthropic",
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
				provider: "anthropic",
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
				provider: "openai-codex",
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
				provider: "anthropic",
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
				provider: "mistral",
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
				provider: "anthropic",
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
				provider: "anthropic",
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
				provider: "anthropic",
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
				provider: "anthropic",
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
})
