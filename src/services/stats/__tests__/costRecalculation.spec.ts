// src/services/stats/__tests__/costRecalculation.spec.ts
//
// Tests for Feature 1: Recalculate cost for old usage events at query time.

import { describe, it, expect } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"

import { getEffectiveCost, computeEventCost, lookupModelInfo } from "../costRecalculation"

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
	})
})
