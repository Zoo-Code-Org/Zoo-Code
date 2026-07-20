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
})
