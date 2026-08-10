// src/services/stats/__tests__/UsageRecorder.spec.ts
//
// Tests for UsageRecorder finalization/idempotency helpers.

import { describe, it, expect, vi } from "vitest"

import { UsageRecorder } from "../UsageRecorder"

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<Parameters<UsageRecorder["finalizeUsageEvent"]>[2]> = {}) {
	return {
		taskId: "task-001",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		mode: "code",
		attempt: 1,
		inputTokens: 1000,
		outputTokens: 500,
		totalCost: 0.015,
		cacheReadInInput: "excluded" as const,
		cacheWriteInInput: "excluded" as const,
		reasoningInOutput: "excluded" as const,
		costSource: "provider" as const,
		tokenSource: "provider" as const,
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageRecorder", () => {
	describe("_hasFinalized", () => {
		it("returns true after a request has been finalized", async () => {
			const sink = { append: vi.fn().mockResolvedValue(true) }
			const recorder = new UsageRecorder(sink)

			expect(recorder._hasFinalized("task-001:0:1", "completed")).toBe(false)

			await recorder.finalizeUsageEvent("task-001:0:1", "completed", makeContext())

			expect(recorder._hasFinalized("task-001:0:1", "completed")).toBe(true)
			expect(sink.append).toHaveBeenCalledTimes(1)
		})
	})
})
