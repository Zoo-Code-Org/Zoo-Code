import { describe, it, expect } from "vitest"

import type { UsageEventV1, StatsQuery, StatsSnapshot } from "@roo-code/types"

import { UsageAggregator } from "../UsageAggregator"

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a UsageEventV1 event for testing.
 */
function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: "2026-07-19T10:00:00.000Z",
		timezoneOffsetMinutes: 540, // KST UTC+9
		status: "completed",
		attempt: 1,
		taskId: "task-001",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		mode: "code",
		usage: {
			inputTokens: { value: 1000, source: "provider" },
			outputTokens: { value: 500, source: "provider" },
			costUsd: { value: 0.01, source: "provider" },
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

/**
 * Creates a default StatsQuery.
 */
function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "Asia/Seoul",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageAggregator", () => {
	const aggregator = new UsageAggregator()

	describe("query - basic", () => {
		it("should return empty snapshot for no events", () => {
			const query = makeQuery()
			const result = aggregator.query([], query)

			expect(result.buckets).toHaveLength(0)
			expect(result.totals.events).toBe(0)
			expect(result.totals.completedCalls).toBe(0)
			expect(result.coverage.firstEventAt).toBeUndefined()
			expect(result.coverage.lastEventAt).toBeUndefined()
			expect(result.coverage.recordingPaused).toBe(false)
			expect(result.coverage.backfilledEventCount).toBe(0)
		})

		it("should aggregate a single event into totals", () => {
			const event = makeEvent({
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query([event], query)

			expect(result.totals.events).toBe(1)
			expect(result.totals.completedCalls).toBe(1)
			expect(result.totals.inputTokens).toBe(1000)
			expect(result.totals.outputTokens).toBe(500)
			expect(result.totals.costUsd).toBe(0.01)
		})

		it("should aggregate multiple events into totals", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					usage: {
						inputTokens: { value: 3000, source: "provider" },
						outputTokens: { value: 1500, source: "provider" },
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(3)
			expect(result.totals.inputTokens).toBe(6000)
			expect(result.totals.outputTokens).toBe(3000)
		})
	})

	describe("query - status grouping", () => {
		it("should count completed, failed, and cancelled separately", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "completed" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", status: "failed" }),
				makeEvent({ eventId: "evt-4", idempotencyKey: "idem-4", status: "cancelled" }),
			]
			const query = makeQuery({ groupBy: [], includeCancelled: true })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(4)
			expect(result.totals.completedCalls).toBe(2)
			expect(result.totals.failedCalls).toBe(1)
			expect(result.totals.cancelledCalls).toBe(1)
		})

		it("should exclude cancelled events when includeCancelled is false", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			]
			const query = makeQuery({ groupBy: [], includeCancelled: false })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
			expect(result.totals.completedCalls).toBe(1)
			expect(result.totals.cancelledCalls).toBe(0)
		})
	})

	describe("query - day grouping", () => {
		it("should group events by day bucket", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-19T15:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-20T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["day"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			// Based on Asia/Seoul (UTC+9), 2026-07-19 10:00 UTC = 2026-07-19 19:00 KST
			// 2026-07-20 10:00 UTC = 2026-07-20 19:00 KST
			const dayKeys = result.buckets.map((b) => b.key.day).sort()
			expect(dayKeys).toContain("2026-07-19")
			expect(dayKeys).toContain("2026-07-20")
		})

		it("should sort day buckets in ascending order", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-19T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["day"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			expect(result.buckets[0].key.day).toBe("2026-07-19")
			expect(result.buckets[1].key.day).toBe("2026-07-20")
		})
	})

	describe("query - provider/model/mode grouping", () => {
		it("should group by provider", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", provider: "anthropic" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", provider: "anthropic" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", provider: "openai" }),
			]
			const query = makeQuery({ groupBy: ["provider"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			const providers = result.buckets.map((b) => b.key.provider).sort()
			expect(providers).toEqual(["anthropic", "openai"])
		})

		it("should group by model", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", model: "claude-sonnet-4-20250514" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", model: "gpt-4o" }),
			]
			const query = makeQuery({ groupBy: ["model"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
		})

		it("should group by mode", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", mode: "code" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", mode: "architect" }),
			]
			const query = makeQuery({ groupBy: ["mode"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
		})
	})

	describe("query - multi-axis grouping", () => {
		it("should group by day + provider (2 axes)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "anthropic",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "openai",
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					occurredAt: "2026-07-20T10:00:00.000Z",
					provider: "anthropic",
				}),
			]
			const query = makeQuery({ groupBy: ["day", "provider"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
		})

		it("should group by day + provider + model (3 axes)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "anthropic",
					model: "claude-opus-4-20250514",
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "openai",
					model: "gpt-4o",
				}),
			]
			const query = makeQuery({ groupBy: ["day", "provider", "model"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
		})
	})

	describe("query - source grouping", () => {
		it("should separate events by cost source", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { costUsd: { value: 0.01, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					usage: { costUsd: { value: 0.02, source: "estimated" } },
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					usage: { costUsd: { value: 0.03, source: "backfilled" } },
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
			const sources = result.buckets.map((b) => b.key.source).sort()
			expect(sources).toEqual(["backfilled", "estimated", "provider"])
		})
	})

	describe("query - inclusion semantics", () => {
		it("should count unknownEventCount when inclusion is unknown", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "unknown",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.unknownEventCount).toBe(1)
		})

		it("should not count unknownEventCount when all inclusions are known", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "included",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.unknownEventCount).toBe(0)
		})

		it("should accumulate cacheReadTokens regardless of inclusion rule", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						cacheReadTokens: { value: 200, source: "provider" },
					},
					semantics: {
						cacheReadInInput: "included",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.cacheReadTokens).toBe(200)
		})
	})

	describe("query - time range filtering", () => {
		it("should filter events by preset 'today'", () => {
			const now = new Date()
			const todayIso = now.toISOString()
			const pastDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: todayIso }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: pastDate }),
			]
			const query = makeQuery({ preset: "today", groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
		})

		it("should filter events by preset '7d'", () => {
			const now = new Date()
			const recentIso = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
			const oldIso = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: recentIso }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: oldIso }),
			]
			const query = makeQuery({ preset: "7d", groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
		})

		it("should include all events with preset 'all'", () => {
			const now = new Date()
			const oldIso = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: now.toISOString() }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: oldIso }),
			]
			const query = makeQuery({ preset: "all", groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(2)
		})

		it("should filter events by explicit from/to", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-21T10:00:00.000Z" }),
			]
			const query = makeQuery({
				from: "2026-07-20T00:00:00.000Z",
				to: "2026-07-21T00:00:00.000Z",
				groupBy: [],
			})

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
		})
	})

	describe("query - coverage", () => {
		it("should compute firstEventAt and lastEventAt", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-21T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.coverage.firstEventAt).toBe("2026-07-19T10:00:00.000Z")
			expect(result.coverage.lastEventAt).toBe("2026-07-21T10:00:00.000Z")
		})

		it("should count backfilled events in coverage", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", provenance: "live" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", provenance: "history-backfill" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", provenance: "history-backfill" }),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.coverage.backfilledEventCount).toBe(2)
		})

		it("should pass recordingPaused option to coverage", () => {
			const query = makeQuery({ groupBy: [] })
			const result = aggregator.query([], query, { recordingPaused: true })

			expect(result.coverage.recordingPaused).toBe(true)
		})
	})

	describe("query - sorting", () => {
		it("should sort category buckets by totalTokens descending then name ascending", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provider: "openai",
					usage: { inputTokens: { value: 1000, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					provider: "anthropic",
					usage: { inputTokens: { value: 3000, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					provider: "google",
					usage: { inputTokens: { value: 2000, source: "provider" } },
				}),
			]
			const query = makeQuery({ groupBy: ["provider"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
			// totalTokens descending: anthropic(3000) > google(2000) > openai(1000)
			expect(result.buckets[0].key.provider).toBe("anthropic")
			expect(result.buckets[1].key.provider).toBe("google")
			expect(result.buckets[2].key.provider).toBe("openai")
		})
	})

	describe("query - missing values", () => {
		it("should handle events with missing usage fields", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {}, // all usage fields missing
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
			expect(result.totals.inputTokens).toBe(0)
			expect(result.totals.outputTokens).toBe(0)
			expect(result.totals.costUsd).toBe(0)
		})

		it("should default missing SourcedNumber value to 0", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						// outputTokens, cacheRead, cacheWrite, reasoning, total, cost all missing
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.inputTokens).toBe(1000)
			expect(result.totals.outputTokens).toBe(0)
			expect(result.totals.cacheReadTokens).toBe(0)
			expect(result.totals.cacheWriteTokens).toBe(0)
			expect(result.totals.reasoningTokens).toBe(0)
			// totalTokens is recomputed as inputTokens + outputTokens (1000 + 0 = 1000),
			// not read from the stored event.usage.totalTokens field.
			expect(result.totals.totalTokens).toBe(1000)
			// Feature 1: When costUsd is missing, the aggregator now computes
			// the cost on-the-fly from the model's pricing info. The default
			// test event uses provider "anthropic" + model "claude-sonnet-4-20250514"
			// with 1000 input tokens. Anthropic pricing: $3/1M input tokens →
			// 1000 × 3 / 1_000_000 = 0.003.
			expect(result.totals.costUsd).toBeCloseTo(0.003, 5)
		})

		it("should not double-count cache/reasoning tokens in totalTokens", () => {
			// Regression test: totalTokens must equal inputTokens + outputTokens only.
			// Cache tokens are a subset of input; reasoning tokens are a subset of output.
			// See docs/260720_22_gitignore-heatmap-fix/213200_debug-report.md
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 100, source: "provider" },
						outputTokens: { value: 50, source: "provider" },
						cacheReadTokens: { value: 40, source: "provider" },
						cacheWriteTokens: { value: 10, source: "provider" },
						reasoningTokens: { value: 20, source: "provider" },
						// Deliberately set a bad stored totalTokens (old double-counted sum)
						totalTokens: { value: 220, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			// 100 + 50 = 150, NOT 220 (100 + 50 + 40 + 10 + 20)
			expect(result.totals.totalTokens).toBe(150)
			expect(result.totals.inputTokens).toBe(100)
			expect(result.totals.outputTokens).toBe(50)
			expect(result.totals.cacheReadTokens).toBe(40)
			expect(result.totals.cacheWriteTokens).toBe(10)
			expect(result.totals.reasoningTokens).toBe(20)
		})
	})

	// ── Week and Month grouping ───────────────────────────────────────────

	describe("query - week grouping", () => {
		it("should group events by ISO week bucket", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-13T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-15T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-20T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["week"] })

			const result = aggregator.query(events, query)

			// 2026-07-13 KST = 2026-07-13 19:00 → ISO week 28
			// 2026-07-15 KST = 2026-07-15 19:00 → ISO week 29
			// 2026-07-20 KST = 2026-07-20 19:00 → ISO week 29
			expect(result.buckets.length).toBeGreaterThanOrEqual(1)
			const weekKeys = result.buckets.map((b) => b.key.week)
			weekKeys.forEach((key) => {
				expect(key).toMatch(/^\d{4}-W\d{2}$/)
			})
		})

		it("should sort week buckets in ascending order", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-13T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["week"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			// week key is a string in "YYYY-Www" format, so string comparison is used
			const firstWeek = result.buckets[0].key.week ?? ""
			const secondWeek = result.buckets[1].key.week ?? ""
			expect(firstWeek.localeCompare(secondWeek)).toBeLessThan(0)
		})
	})

	describe("query - month grouping", () => {
		it("should group events by month bucket", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-08-15T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["month"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			const monthKeys = result.buckets.map((b) => b.key.month).sort()
			expect(monthKeys).toContain("2026-07")
			expect(monthKeys).toContain("2026-08")
		})

		it("should sort month buckets in ascending order", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-08-15T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-19T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["month"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			expect(result.buckets[0].key.month).toBe("2026-07")
			expect(result.buckets[1].key.month).toBe("2026-08")
		})
	})

	// ── Status grouping ────────────────────────────────────────────────────

	describe("query - status grouping", () => {
		it("should group events by status", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "completed" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", status: "failed" }),
				makeEvent({ eventId: "evt-4", idempotencyKey: "idem-4", status: "cancelled" }),
			]
			const query = makeQuery({ groupBy: ["status"], includeCancelled: true })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
			const statuses = result.buckets.map((b) => b.key.status).sort()
			expect(statuses).toEqual(["cancelled", "completed", "failed"])
		})

		it("should exclude cancelled from status grouping when includeCancelled is false", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			]
			const query = makeQuery({ groupBy: ["status"], includeCancelled: false })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(1)
			expect(result.buckets[0].key.status).toBe("completed")
		})
	})

	// ── Inclusion semantics edge cases ─────────────────────────────────────

	describe("query - inclusion semantics edge cases", () => {
		it("should accumulate cacheWriteTokens regardless of cacheWriteInInput value", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						cacheWriteTokens: { value: 500, source: "provider" },
					},
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "included",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.cacheWriteTokens).toBe(500)
		})

		it("should accumulate reasoningTokens regardless of reasoningInOutput value", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						reasoningTokens: { value: 800, source: "provider" },
					},
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "included",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.reasoningTokens).toBe(800)
		})

		it("should count unknownEventCount when cacheWriteInInput is unknown", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "unknown",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.unknownEventCount).toBe(1)
		})

		it("should count unknownEventCount when reasoningInOutput is unknown", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "unknown",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.unknownEventCount).toBe(1)
		})

		it("should count unknownEventCount once even when multiple inclusions are unknown", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "unknown",
						cacheWriteInInput: "unknown",
						reasoningInOutput: "unknown",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			// Even with multiple unknowns in one event, only increments by 1
			expect(result.totals.unknownEventCount).toBe(1)
		})
	})

	// ── Source grouping edge cases ─────────────────────────────────────────

	describe("query - source grouping edge cases", () => {
		it("should group by 'unknown' source when event has no costUsd or token sources", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {}, // all usage fields missing
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(1)
			expect(result.buckets[0].key.source).toBe("unknown")
		})

		it("should create separate buckets for different token sources within one event", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "estimated" },
						costUsd: { value: 0.01, source: "backfilled" },
					},
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			// 3 different sources → 3 buckets
			expect(result.buckets).toHaveLength(3)
			const sources = result.buckets.map((b) => b.key.source).sort()
			expect(sources).toEqual(["backfilled", "estimated", "provider"])
		})
	})

	// ── Multi-axis sorting ─────────────────────────────────────────────────

	describe("query - multi-axis sorting", () => {
		it("should sort by time axis when time axis is present in multi-axis grouping", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-20T10:00:00.000Z",
					provider: "anthropic",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "openai",
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "anthropic",
				}),
			]
			const query = makeQuery({ groupBy: ["day", "provider"] })

			const result = aggregator.query(events, query)

			// Sort ascending by time axis
			expect(result.buckets.length).toBeGreaterThanOrEqual(2)
			for (let i = 1; i < result.buckets.length; i++) {
				const prev = result.buckets[i - 1].key.day ?? ""
				const curr = result.buckets[i].key.day ?? ""
				expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0)
			}
		})

		it("should sort category buckets by name ascending when totalTokens are equal", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provider: "zeta",
					usage: { inputTokens: { value: 1000, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					provider: "alpha",
					usage: { inputTokens: { value: 1000, source: "provider" } },
				}),
			]
			const query = makeQuery({ groupBy: ["provider"] })

			const result = aggregator.query(events, query)

			// Same totalTokens → name ascending
			expect(result.buckets[0].key.provider).toBe("alpha")
			expect(result.buckets[1].key.provider).toBe("zeta")
		})
	})

	// ── Coverage edge cases ────────────────────────────────────────────────

	describe("query - coverage edge cases", () => {
		it("should return undefined firstEventAt and lastEventAt for empty visible events", () => {
			const query = makeQuery({ groupBy: [] })
			const result = aggregator.query([], query)

			expect(result.coverage.firstEventAt).toBeUndefined()
			expect(result.coverage.lastEventAt).toBeUndefined()
		})

		it("should compute firstEventAt and lastEventAt from visible (non-cancelled) events only", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					status: "cancelled",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-20T10:00:00.000Z",
					status: "completed",
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					occurredAt: "2026-07-21T10:00:00.000Z",
					status: "completed",
				}),
			]
			const query = makeQuery({ groupBy: [], includeCancelled: false })

			const result = aggregator.query(events, query)

			// Cancelled events are excluded from coverage
			expect(result.coverage.firstEventAt).toBe("2026-07-20T10:00:00.000Z")
			expect(result.coverage.lastEventAt).toBe("2026-07-21T10:00:00.000Z")
		})

		it("should count only visible backfilled events in coverage", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provenance: "history-backfill",
					status: "completed",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					provenance: "history-backfill",
					status: "cancelled",
				}),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", provenance: "live", status: "completed" }),
			]
			const query = makeQuery({ groupBy: [], includeCancelled: false })

			const result = aggregator.query(events, query)

			// Cancelled backfill events are excluded from visible, so only 1 is counted
			expect(result.coverage.backfilledEventCount).toBe(1)
		})
	})

	// ── Empty groupBy ──────────────────────────────────────────────────────

	describe("query - empty groupBy", () => {
		it("should return a single empty-key bucket when groupBy is empty", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			// Empty groupBy → single bucket with empty key
			expect(result.buckets).toHaveLength(1)
			expect(Object.keys(result.buckets[0].key)).toHaveLength(0)
			expect(result.buckets[0].events).toBe(2)
		})
	})

	// ── Preset 30d filtering ────────────────────────────────────────────────

	describe("query - preset 30d filtering", () => {
		it("should filter events by preset '30d'", () => {
			const now = new Date()
			const recentIso = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
			const oldIso = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: recentIso }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: oldIso }),
			]
			const query = makeQuery({ preset: "30d", groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
		})
	})

	// ── Snapshot structure ─────────────────────────────────────────────────

	describe("query - snapshot structure", () => {
		it("should return snapshot with query, generatedAt, buckets, totals, and coverage", () => {
			const query = makeQuery({ groupBy: [] })
			const result = aggregator.query([], query)

			expect(result.query).toEqual(query)
			expect(result.generatedAt).toBeTruthy()
			expect(Array.isArray(result.buckets)).toBe(true)
			expect(result.totals).toBeDefined()
			expect(result.coverage).toBeDefined()
		})

		it("should return generatedAt as a valid ISO date string", () => {
			const query = makeQuery({ groupBy: [] })
			const result = aggregator.query([], query)

			const parsed = new Date(result.generatedAt)
			expect(parsed.getTime()).not.toBeNaN()
		})
	})
})
