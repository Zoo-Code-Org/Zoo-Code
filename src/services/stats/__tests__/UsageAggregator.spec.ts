import { describe, it, expect } from "vitest"

import type { UsageEventV1, StatsQuery, StatsSnapshot } from "@roo-code/types"

import { UsageAggregator } from "../UsageAggregator"

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * 테스트용 UsageEventV1 이벤트를 생성한다.
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
 * 기본 StatsQuery를 생성한다.
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
			// Asia/Seoul (UTC+9) 기준으로 2026-07-19 10:00 UTC = 2026-07-19 19:00 KST
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
			// totalTokens 내림차순: anthropic(3000) > google(2000) > openai(1000)
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
					usage: {}, // 모든 usage 필드 누락
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
			expect(result.totals.inputTokens).toBe(0)
			expect(result.totals.outputTokens).toBe(0)
			expect(result.totals.costUsd).toBe(0)
		})
	})

	describe("query - 30d preset", () => {
		it("should filter events by preset '30d'", () => {
			const now = new Date()
			const recentIso = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString()
			const oldIso = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: recentIso }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: oldIso }),
			]
			const query = makeQuery({ preset: "30d", groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.events).toBe(1)
		})
	})

	describe("query - week/month grouping", () => {
		it("should group events by week bucket", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-13T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-15T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-20T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["week"] })

			const result = aggregator.query(events, query)

			// 2026-07-13 and 2026-07-15 should be in the same ISO week
			// 2026-07-20 should be in the next week
			expect(result.buckets.length).toBeGreaterThanOrEqual(2)
			const weekKeys = result.buckets.map((b) => b.key.week).filter(Boolean)
			expect(weekKeys.length).toBeGreaterThan(0)
		})

		it("should group events by month bucket", () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-08-01T10:00:00.000Z" }),
			]
			const query = makeQuery({ groupBy: ["month"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			const monthKeys = result.buckets.map((b) => b.key.month).sort()
			expect(monthKeys).toContain("2026-07")
			expect(monthKeys).toContain("2026-08")
		})
	})

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
	})

	describe("query - source axis with token sources", () => {
		it("should separate events by inputTokens source", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { inputTokens: { value: 1000, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					usage: { inputTokens: { value: 2000, source: "estimated" } },
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			const sources = result.buckets.map((b) => b.key.source).sort()
			expect(sources).toEqual(["estimated", "provider"])
		})

		it("should separate events by outputTokens source", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { outputTokens: { value: 500, source: "provider" } },
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					usage: { outputTokens: { value: 600, source: "backfilled" } },
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(2)
			const sources = result.buckets.map((b) => b.key.source).sort()
			expect(sources).toEqual(["backfilled", "provider"])
		})

		it("should use 'unknown' source for events with no costUsd and no input/output tokens", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {},
				}),
			]
			const query = makeQuery({ groupBy: ["source"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(1)
			expect(result.buckets[0].key.source).toBe("unknown")
		})
	})

	describe("query - inclusion semantics branches", () => {
		it("should handle cacheWriteInInput 'included' semantics", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { cacheWriteTokens: { value: 200, source: "provider" } },
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "included",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.cacheWriteTokens).toBe(200)
			expect(result.totals.unknownEventCount).toBe(0)
		})

		it("should handle cacheWriteInInput 'unknown' semantics", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { cacheWriteTokens: { value: 200, source: "provider" } },
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "unknown",
						reasoningInOutput: "excluded",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.cacheWriteTokens).toBe(200)
			expect(result.totals.unknownEventCount).toBe(1)
		})

		it("should handle reasoningInOutput 'included' semantics", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { reasoningTokens: { value: 50, source: "provider" } },
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "included",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.reasoningTokens).toBe(50)
			expect(result.totals.unknownEventCount).toBe(0)
		})

		it("should handle reasoningInOutput 'unknown' semantics", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: { reasoningTokens: { value: 50, source: "provider" } },
					semantics: {
						cacheReadInInput: "excluded",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "unknown",
					},
				}),
			]
			const query = makeQuery({ groupBy: [] })

			const result = aggregator.query(events, query)

			expect(result.totals.reasoningTokens).toBe(50)
			expect(result.totals.unknownEventCount).toBe(1)
		})
	})

	describe("query - sort tiebreaker", () => {
		it("should sort by name ascending when totalTokens are equal", () => {
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
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					provider: "mid",
					usage: { inputTokens: { value: 1000, source: "provider" } },
				}),
			]
			const query = makeQuery({ groupBy: ["provider"] })

			const result = aggregator.query(events, query)

			expect(result.buckets).toHaveLength(3)
			// All have same totalTokens (1000), so sort by name ascending
			expect(result.buckets[0].key.provider).toBe("alpha")
			expect(result.buckets[1].key.provider).toBe("mid")
			expect(result.buckets[2].key.provider).toBe("zeta")
		})
	})
})
