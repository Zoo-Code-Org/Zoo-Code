import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import {
	assembleRollupSnapshot,
	computeSessionPage,
	computeHeatmapSnapshot,
	applyEventToProjection,
	computeDayBucket,
	sumBucketsToTotals,
	StatsProjError,
} from "../UsageStatsProjection"
import { UsageAggregator, computeEventContribution, serializeBucketKey } from "../UsageAggregator"

// ── Test Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
	const prefix = path.join(os.tmpdir(), "usage-stats-proj-test-")
	return fs.mkdtempSync(prefix)
}

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

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "Asia/Seoul",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageStatsProjection", () => {
	let tempDir: string
	let db: UsageStatsDatabase

	beforeEach(() => {
		tempDir = createTempDir()
		db = new UsageStatsDatabase(tempDir)
		db.initialize()
	})

	afterEach(() => {
		db.close()
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	// ── computeDayBucket (edge-day correction) ─────────────────────────────

	describe("computeDayBucket", () => {
		it("should compute the correct day for a midday event", () => {
			const day = computeDayBucket("2026-07-19T10:00:00.000Z", "Asia/Seoul")
			// 10:00 UTC = 19:00 KST → same calendar day
			expect(day).toBe("2026-07-19")
		})

		it("should handle midnight boundary in KST", () => {
			// 2026-07-19T15:00:00Z = 2026-07-20T00:00:00 KST (midnight)
			const day = computeDayBucket("2026-07-19T15:00:00.000Z", "Asia/Seoul")
			expect(day).toBe("2026-07-20")
		})

		it("should handle midnight boundary in UTC", () => {
			const day = computeDayBucket("2026-07-19T00:00:00.000Z", "UTC")
			expect(day).toBe("2026-07-19")
		})

		it("should handle midnight boundary in America/New_York", () => {
			// 2026-07-19T04:00:00Z = 2026-07-19T00:00:00 EDT (midnight)
			const day = computeDayBucket("2026-07-19T04:00:00.000Z", "America/New_York")
			expect(day).toBe("2026-07-19")
		})

		it("should handle DST transition (spring forward)", () => {
			// US DST spring forward: 2026-03-08T02:00 → 03:00 EST→EDT
			// 2026-03-08T07:00:00Z = 2026-03-08T03:00:00 EDT (after spring forward)
			const day = computeDayBucket("2026-03-08T07:00:00.000Z", "America/New_York")
			expect(day).toBe("2026-03-08")
		})

		it("should handle DST transition (fall back)", () => {
			// US DST fall back: 2026-11-01T02:00 → 01:00 EDT→EST
			// 2026-11-01T06:00:00Z = 2026-11-01T01:00:00 EST (after fall back)
			const day = computeDayBucket("2026-11-01T06:00:00.000Z", "America/New_York")
			expect(day).toBe("2026-11-01")
		})

		it("should handle different timezones consistently", () => {
			const iso = "2026-07-19T10:00:00.000Z"
			const kst = computeDayBucket(iso, "Asia/Seoul")
			const utc = computeDayBucket(iso, "UTC")
			const ny = computeDayBucket(iso, "America/New_York")

			// 10:00 UTC = 19:00 KST → 2026-07-19
			// 10:00 UTC = 10:00 UTC → 2026-07-19
			// 10:00 UTC = 06:00 EDT → 2026-07-19
			expect(kst).toBe("2026-07-19")
			expect(utc).toBe("2026-07-19")
			expect(ny).toBe("2026-07-19")
		})

		it("should produce different days for events at timezone boundaries", () => {
			// 2026-07-19T15:00:00Z = midnight KST on 2026-07-20
			// but still 2026-07-19 in UTC
			const kstDay = computeDayBucket("2026-07-19T15:00:00.000Z", "Asia/Seoul")
			const utcDay = computeDayBucket("2026-07-19T15:00:00.000Z", "UTC")
			expect(kstDay).toBe("2026-07-20")
			expect(utcDay).toBe("2026-07-19")
		})
	})

	// ── assembleRollupSnapshot ─────────────────────────────────────────────

	describe("assembleRollupSnapshot", () => {
		it("should return empty snapshot for empty database", () => {
			const query = makeQuery()
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.buckets).toHaveLength(0)
			expect(snapshot.totals.events).toBe(0)
			expect(snapshot.coverage.firstEventAt).toBeUndefined()
			expect(snapshot.coverage.lastEventAt).toBeUndefined()
		})

		it("should assemble a snapshot from database events", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: "2026-07-19T10:00:00.000Z",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"] })
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.totals.events).toBe(1)
			expect(snapshot.totals.inputTokens).toBe(1000)
			expect(snapshot.totals.outputTokens).toBe(500)
			expect(snapshot.totals.costUsd).toBe(0.01)
			expect(snapshot.buckets.length).toBeGreaterThanOrEqual(1)
		})

		it("should match UsageAggregator results for the same events", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provider: "anthropic",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-20T10:00:00.000Z",
					provider: "openai",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ groupBy: ["day", "provider"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.outputTokens).toBe(aggregatorSnapshot.totals.outputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.totals.totalTokens).toBe(aggregatorSnapshot.totals.totalTokens)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
		})

		it("should handle cost fallback for events without costUsd", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: [] })
			const snapshot = assembleRollupSnapshot(db, query)

			// Anthropic claude-sonnet-4: $3/1M input, $15/1M output
			// 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
			expect(snapshot.totals.costUsd).toBeCloseTo(0.0105, 5)
		})

		it("should filter by time range", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-20T10:00:00.000Z",
				}),
			)

			const query = makeQuery({
				from: "2026-07-20T00:00:00.000Z",
				to: "2026-07-21T00:00:00.000Z",
				groupBy: [],
			})
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.totals.events).toBe(1)
		})

		it("should exclude cancelled events by default", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					status: "completed",
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					status: "cancelled",
				}),
			)

			const query = makeQuery({ groupBy: [], includeCancelled: false })
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.totals.events).toBe(1)
		})

		it("should include cancelled events when includeCancelled is true", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					status: "completed",
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					status: "cancelled",
				}),
			)

			const query = makeQuery({ groupBy: [], includeCancelled: true })
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.totals.events).toBe(2)
			expect(snapshot.totals.cancelledCalls).toBe(1)
		})

		it("should compute coverage from visible events", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provenance: "live",
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-20T10:00:00.000Z",
					provenance: "history-backfill",
				}),
			)

			const query = makeQuery({ groupBy: [] })
			const snapshot = assembleRollupSnapshot(db, query)

			expect(snapshot.coverage.firstEventAt).toBe("2026-07-19T10:00:00.000Z")
			expect(snapshot.coverage.lastEventAt).toBe("2026-07-20T10:00:00.000Z")
			expect(snapshot.coverage.backfilledEventCount).toBe(1)
		})
	})

	// ── computeSessionPage ─────────────────────────────────────────────────

	describe("computeSessionPage", () => {
		it("should return empty page for empty database", () => {
			const page = computeSessionPage(db, "req-001")

			expect(page.requestId).toBe("req-001")
			expect(page.sessions).toHaveLength(0)
			expect(page.totalEstimate).toBe(0)
			expect(page.cursor).toBeUndefined()
		})

		it("should return sessions ordered by last activity descending", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					taskId: "task-A",
					rootTaskId: "task-A",
					occurredAt: "2026-07-19T10:00:00.000Z",
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					taskId: "task-B",
					rootTaskId: "task-B",
					occurredAt: "2026-07-20T10:00:00.000Z",
				}),
			)

			const page = computeSessionPage(db, "req-001")

			expect(page.sessions).toHaveLength(2)
			// Most recent first
			expect(page.sessions[0].rootTaskId).toBe("task-B")
			expect(page.sessions[1].rootTaskId).toBe("task-A")
		})

		it("should aggregate events within the same session", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					taskId: "task-A",
					rootTaskId: "task-A",
					occurredAt: "2026-07-19T10:00:00.000Z",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
			)
			db.append(
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					taskId: "task-A",
					rootTaskId: "task-A",
					occurredAt: "2026-07-19T11:00:00.000Z",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
			)

			const page = computeSessionPage(db, "req-001")

			expect(page.sessions).toHaveLength(1)
			expect(page.sessions[0].eventCount).toBe(2)
			// Event 1: 1000+500=1500, Event 2: 2000+1000=3000, Total=4500
			expect(page.sessions[0].totalTokens).toBe(4500)
			expect(page.sessions[0].totalCost).toBeCloseTo(0.03, 10)
		})

		it("should support cursor pagination", () => {
			// Insert 3 sessions with different timestamps
			for (let i = 0; i < 3; i++) {
				db.append(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
						taskId: `task-${i}`,
						rootTaskId: `task-${i}`,
						occurredAt: new Date(2026, 6, 19 + i, 10, 0, 0).toISOString(),
					}),
				)
			}

			// First page: limit 2
			const page1 = computeSessionPage(db, "req-001", undefined, 2)
			expect(page1.sessions).toHaveLength(2)
			expect(page1.cursor).toBeDefined()

			// Second page
			const page2 = computeSessionPage(db, "req-001", page1.cursor, 2)
			expect(page2.sessions).toHaveLength(1)
			expect(page2.cursor).toBeUndefined()
		})

		it("should maintain cursor consistency (no gaps, no duplicates)", () => {
			// Insert 5 sessions
			for (let i = 0; i < 5; i++) {
				db.append(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
						taskId: `task-${i}`,
						rootTaskId: `task-${i}`,
						occurredAt: new Date(2026, 6, 19 + i, 10, 0, 0).toISOString(),
					}),
				)
			}

			const allRootTaskIds: string[] = []
			let cursor: string | undefined

			// Page through all results with limit 2
			while (true) {
				const page = computeSessionPage(db, "req-001", cursor, 2)
				for (const session of page.sessions) {
					allRootTaskIds.push(session.rootTaskId)
				}
				if (!page.cursor) break
				cursor = page.cursor
			}

			// Should have all 5 sessions, no duplicates
			expect(allRootTaskIds).toHaveLength(5)
			expect(new Set(allRootTaskIds).size).toBe(5)
		})

		it("should propagate requestId", () => {
			const page = computeSessionPage(db, "my-request-id")
			expect(page.requestId).toBe("my-request-id")
		})
	})

	// ── computeHeatmapSnapshot ─────────────────────────────────────────────

	describe("computeHeatmapSnapshot", () => {
		it("should return a heatmap with the correct number of days", () => {
			const heatmap = computeHeatmapSnapshot(db, 30, "Asia/Seoul")
			expect(heatmap.rangeDays).toBe(30)
			expect(heatmap.values).toHaveLength(30)
		})

		it("should return zeros for empty database", () => {
			const heatmap = computeHeatmapSnapshot(db, 7, "Asia/Seoul")
			expect(heatmap.values.every((v) => v === 0)).toBe(true)
		})

		it("should show tokens for days with events", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: new Date().toISOString(),
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.05, source: "provider" },
					},
				}),
			)

			const heatmap = computeHeatmapSnapshot(db, 7, "Asia/Seoul")
			// ST-3: Heatmap values are token counts, not cost
			// At least one day should have non-zero tokens
			expect(heatmap.values.some((v) => v > 0)).toBe(true)
		})

		it("should handle different range sizes", () => {
			for (const rangeDays of [30, 60, 120, 360]) {
				const heatmap = computeHeatmapSnapshot(db, rangeDays, "Asia/Seoul")
				expect(heatmap.values).toHaveLength(rangeDays)
			}
		})
	})

	// ── applyEventToProjection ─────────────────────────────────────────────

	describe("applyEventToProjection", () => {
		it("should return a delta for a matching event", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: new Date().toISOString(),
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.requestId).toBe("req-001")
			expect(delta.generation).toBe(1)
			expect(delta.sequence).toBe(1)
			expect(delta.totalDelta.events).toBe(1)
			expect(delta.totalDelta.inputTokens).toBe(1000)
			expect(delta.totalDelta.costUsd).toBe(0.01)
		})

		it("should return zero delta for an event outside the query time range", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: "2026-01-01T10:00:00.000Z",
			})
			db.append(event)

			const query = makeQuery({
				from: "2026-07-01T00:00:00.000Z",
				to: "2026-07-31T00:00:00.000Z",
				groupBy: ["day"],
			})
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.totalDelta.events).toBe(0)
			expect(delta.totalDelta.inputTokens).toBe(0)
			expect(delta.breakdownDelta).toHaveLength(0)
		})

		it("should return zero delta for cancelled events when includeCancelled is false", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				status: "cancelled",
				occurredAt: new Date().toISOString(),
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"], includeCancelled: false })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.totalDelta.events).toBe(0)
		})

		it("should compute breakdown deltas for each group key", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: new Date().toISOString(),
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day", "provider"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.breakdownDelta.length).toBeGreaterThanOrEqual(1)
			for (const bd of delta.breakdownDelta) {
				expect(bd.events).toBe(1)
				expect(bd.inputTokens).toBe(1000)
				expect(Object.keys(bd.key).length).toBeGreaterThan(0)
			}
		})

		it("should compute heatmap day delta for events within the heatmap range", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: new Date().toISOString(),
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.05, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.heatmapDayDelta).toBeDefined()
			expect(delta.heatmapDayDelta!.dayIndex).toBeGreaterThanOrEqual(0)
			// ST-3: Heatmap delta is token count (1000 input + 500 output = 1500), not cost
			expect(delta.heatmapDayDelta!.delta).toBe(1500)
		})

		it("should not compute heatmap delta for events outside the heatmap range", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: "2020-01-01T10:00:00.000Z",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.05, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ preset: "all", groupBy: ["day"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.heatmapDayDelta).toBeUndefined()
		})

		it("should include session upsert for the event's session", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				taskId: "task-A",
				rootTaskId: "task-A",
				occurredAt: new Date().toISOString(),
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.01, source: "provider" },
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			expect(delta.sessionUpsert.length).toBeGreaterThanOrEqual(1)
			const upsert = delta.sessionUpsert.find((s) => s.rootTaskId === "task-A")
			expect(upsert).toBeDefined()
			expect(upsert!.eventCount).toBe(1)
			expect(upsert!.totalCost).toBe(0.01)
		})

		it("should use cost recalculation for events without costUsd", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: new Date().toISOString(),
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					// costUsd missing
				},
			})
			db.append(event)

			const query = makeQuery({ groupBy: ["day"] })
			const delta = applyEventToProjection(db, event, query, "req-001", 30, 1, 1)

			// Anthropic claude-sonnet-4: $3/1M input, $15/1M output
			// 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
			expect(delta.totalDelta.costUsd).toBeCloseTo(0.0105, 5)
		})
	})

	// ── Property: folding deltas equals full aggregate (with DB) ──────────

	describe("property: folding per-event deltas equals full aggregate (with DB)", () => {
		it("should produce the same totals as assembleRollupSnapshot", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: new Date().toISOString(),
					status: "completed",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: new Date(Date.now() + 3600000).toISOString(),
					status: "failed",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ groupBy: [], includeCancelled: true })
			const snapshot = assembleRollupSnapshot(db, query)

			// Fold per-event deltas
			let foldedEvents = 0
			let foldedInputTokens = 0
			let foldedOutputTokens = 0
			let foldedCostUsd = 0
			let foldedTotalTokens = 0

			for (const event of events) {
				const delta = computeEventContribution(event, query)
				expect(delta).not.toBeNull()
				foldedEvents += delta!.events
				foldedInputTokens += delta!.inputTokens
				foldedOutputTokens += delta!.outputTokens
				foldedCostUsd += delta!.costUsd
				foldedTotalTokens += delta!.totalTokens
			}

			expect(foldedEvents).toBe(snapshot.totals.events)
			expect(foldedInputTokens).toBe(snapshot.totals.inputTokens)
			expect(foldedOutputTokens).toBe(snapshot.totals.outputTokens)
			expect(foldedCostUsd).toBeCloseTo(snapshot.totals.costUsd, 10)
			expect(foldedTotalTokens).toBe(snapshot.totals.totalTokens)
		})
	})

	// ── Stable bucket-key serialization ───────────────────────────────────

	describe("stable bucket-key serialization", () => {
		it("should produce consistent keys regardless of insertion order", () => {
			const key1 = { day: "2026-07-19", provider: "anthropic" }
			const key2 = { provider: "anthropic", day: "2026-07-19" }
			expect(serializeBucketKey(key1)).toBe(serializeBucketKey(key2))
		})

		it("should produce unique keys for different values", () => {
			const key1 = { day: "2026-07-19", provider: "anthropic" }
			const key2 = { day: "2026-07-19", provider: "openai" }
			expect(serializeBucketKey(key1)).not.toBe(serializeBucketKey(key2))
		})

		it("should handle empty keys", () => {
			expect(serializeBucketKey({})).toBe("")
		})

		it("should handle single-axis keys", () => {
			const result = serializeBucketKey({ day: "2026-07-19" })
			expect(result).toBe("day=2026-07-19")
		})

		it("should handle three-axis keys consistently", () => {
			const key1 = { day: "2026-07-19", provider: "anthropic", model: "claude-sonnet-4" }
			const key2 = { model: "claude-sonnet-4", day: "2026-07-19", provider: "anthropic" }
			expect(serializeBucketKey(key1)).toBe(serializeBucketKey(key2))
		})
	})

	// ── Error handling ─────────────────────────────────────────────────────

	describe("error handling", () => {
		it("should throw StatsProjError on database failure", () => {
			// Close the DB to simulate failure
			db.close()

			expect(() => assembleRollupSnapshot(db, makeQuery())).toThrow(StatsProjError)
		})

		it("should throw StatsProjError when computeSessionPage fails", () => {
			db.close()

			expect(() => computeSessionPage(db, "req-001")).toThrow(StatsProjError)
		})

		it("should throw StatsProjError when computeHeatmapSnapshot fails", () => {
			db.close()

			expect(() => computeHeatmapSnapshot(db, 30, "Asia/Seoul")).toThrow(StatsProjError)
		})

		it("should throw StatsProjError when applyEventToProjection fails", () => {
			const event = makeEvent({ taskId: "task-A", rootTaskId: "task-A" })
			db.append(event)
			db.close()

			expect(() =>
				applyEventToProjection(db, event, makeQuery({ groupBy: ["day"] }), "req-001", 30, 1, 1),
			).toThrow(StatsProjError)
		})
	})

	describe("diff coverage: rollup fast path", () => {
		it("falls back to event scan for unsupported groupBy axes", () => {
			db.append(makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }))
			db.append(makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "failed" }))

			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["status"] }))

			expect(snapshot.totals.events).toBe(2)
			expect(snapshot.buckets).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ key: { status: "completed" } }),
					expect.objectContaining({ key: { status: "failed" } }),
				]),
			)
		})

		it("uses rollup fast path with cacheRatio, keeping server-reported cacheRead", () => {
			db.append(
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						cacheReadTokens: { value: 300, source: "provider" },
					},
				}),
			)

			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.5 }))

			expect(snapshot.totals.cacheReadTokens).toBe(300)
			expect(snapshot.buckets[0].cacheReadTokens).toBe(300)
		})
	})

	describe("cacheRatio estimation bug fix", () => {
		it("never increases cacheReadTokens for reporting providers (cacheRead=0 is a true miss)", () => {
			// Bug 1 fix: anthropic is a reporting provider (has cacheReadsPrice).
			// Event 1: Provider reports 300 cached tokens (cache hit).
			const evtReported = makeEvent({
				eventId: "evt-reported",
				idempotencyKey: "idem-reported",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 200, source: "provider" },
					cacheReadTokens: { value: 300, source: "provider" },
				},
			})

			// Event 2: Same reporting provider, cacheRead=0 (true cache miss).
			// No estimation should occur — cacheRead stays 0.
			const evtUnreported = makeEvent({
				eventId: "evt-unreported",
				idempotencyKey: "idem-unreported",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 200, source: "provider" },
				},
			})

			db.append(evtReported)
			db.append(evtUnreported)

			// Query with cacheRatio = 0.5 (50%)
			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.5 }))

			// For evtReported: cacheReadTokens = 300 (reported, no estimation).
			// For evtUnreported: cacheReadTokens = 0 (true cache miss, no estimation).
			// Total cacheReadTokens = 300 + 0 = 300.
			expect(snapshot.totals.cacheReadTokens).toBe(300)
			expect(snapshot.buckets[0].cacheReadTokens).toBe(300)

			// Cost semantics: both events keep verbatim cost (reporting provider).
			// evtReported: 1000 × $3/1M + 200 × $15/1M + 300 × $0.30/1M = 0.00609
			// evtUnreported: 1000 × $3/1M + 200 × $15/1M = 0.006
			// Total: 0.01209 (no discount applied).
			expect(snapshot.totals.costUsd).toBeCloseTo(0.01209, 10)
			expect(snapshot.buckets[0].costUsd).toBeCloseTo(0.01209, 10)
		})
	})

	describe("rollup fast path: customPricing cacheRatio fix", () => {
		it("should apply cacheRatio discount for custom models on the rollup fast path", () => {
			// Custom model NOT in the static registry → providerReportsCache returns false.
			// At write time, computeCacheDiscountBase returns 0 (no pricing available).
			// At query time with customPricing, the discount base should be recomputed.
			const event = makeEvent({
				eventId: "evt-custom-1",
				idempotencyKey: "idem-custom-1",
				provider: "openai",
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 10000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.02, source: "provider" },
				},
			})

			db.append(event)

			// customPricing: inputPrice=2.0, cacheReadsPrice=0.5
			// discountBase = (10000 / 1_000_000) * (2.0 - 0.5) = 0.015
			// With cacheRatio=0.5: cost = 0.02 - 0.5 * 0.015 = 0.0125
			const customPricing = new Map([["openai|my-custom-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])

			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.5 }), {
				customPricing,
			})

			// The fast path should have recomputed the discount base and applied it.
			// Without the fix, cacheDiscountBase would be 0 (stored at write time)
			// and costUsd would be 0.02 (no discount).
			expect(snapshot.totals.costUsd).toBeCloseTo(0.0125, 10)
			expect(snapshot.buckets[0].costUsd).toBeCloseTo(0.0125, 10)
		})

		it("should apply cacheRatio discount for custom models on lifetime totals (no groupBy)", () => {
			const event = makeEvent({
				eventId: "evt-custom-2",
				idempotencyKey: "idem-custom-2",
				provider: "openai",
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 10000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.02, source: "provider" },
				},
			})

			db.append(event)

			const customPricing = new Map([["openai|my-custom-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])

			// No groupBy → uses lifetime totals path
			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: [], cacheRatio: 0.5 }), { customPricing })

			// discountBase = (10000 / 1_000_000) * (2.0 - 0.5) = 0.015
			// cost = 0.02 - 0.5 * 0.015 = 0.0125
			expect(snapshot.totals.costUsd).toBeCloseTo(0.0125, 10)
		})

		it("should NOT apply discount for reporting providers even with customPricing", () => {
			// anthropic is a reporting provider → providerReportsCache returns true
			// → computeCacheDiscountBaseFromAggregated returns 0
			const event = makeEvent({
				eventId: "evt-anthropic-1",
				idempotencyKey: "idem-anthropic-1",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					inputTokens: { value: 10000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.02, source: "provider" },
				},
			})

			db.append(event)

			// Even with customPricing that has cacheReadsPrice, reporting providers
			// keep their verbatim cost (cacheRead=0 is a true miss).
			const customPricing = new Map([
				["anthropic|claude-sonnet-4-20250514", { inputPrice: 3.0, cacheReadsPrice: 0.3 }],
			])

			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.5 }), {
				customPricing,
			})

			// No discount applied — cost stays at 0.02
			expect(snapshot.totals.costUsd).toBeCloseTo(0.02, 10)
		})

		it("should produce same result as event-scan path for custom model with cacheRatio", () => {
			const event = makeEvent({
				eventId: "evt-custom-3",
				idempotencyKey: "idem-custom-3",
				provider: "openai",
				model: "my-custom-model",
				usage: {
					inputTokens: { value: 20000, source: "provider" },
					outputTokens: { value: 1000, source: "provider" },
					costUsd: { value: 0.05, source: "provider" },
				},
			})

			db.append(event)

			const customPricing = new Map([["openai|my-custom-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])

			// Fast path (single-axis → uses rollup tables)
			const fastSnapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.94 }), {
				customPricing,
			})

			// Event-scan path (multi-axis → forces event scan)
			const eventScanSnapshot = assembleRollupSnapshot(
				db,
				makeQuery({ groupBy: ["model", "provider"], cacheRatio: 0.94 }),
				{ customPricing },
			)

			// Both paths should produce the same cost
			expect(fastSnapshot.totals.costUsd).toBeCloseTo(eventScanSnapshot.totals.costUsd, 10)
		})
	})

	// ── sumBucketsToTotals ─────────────────────────────────────────────────

	describe("sumBucketsToTotals", () => {
		it("should return a zeroed bucket for empty buckets array", () => {
			const totals = sumBucketsToTotals([])
			expect(totals.events).toBe(0)
			expect(totals.completedCalls).toBe(0)
			expect(totals.failedCalls).toBe(0)
			expect(totals.cancelledCalls).toBe(0)
			expect(totals.inputTokens).toBe(0)
			expect(totals.outputTokens).toBe(0)
			expect(totals.cacheReadTokens).toBe(0)
			expect(totals.cacheWriteTokens).toBe(0)
			expect(totals.reasoningTokens).toBe(0)
			expect(totals.totalTokens).toBe(0)
			expect(totals.costUsd).toBe(0)
			expect(totals.unknownEventCount).toBe(0)
			expect(totals.key).toEqual({})
		})

		it("should accurately aggregate all metrics across multiple buckets", () => {
			const b1 = {
				key: { model: "model-a" },
				events: 2,
				completedCalls: 2,
				failedCalls: 0,
				cancelledCalls: 0,
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 100,
				cacheWriteTokens: 50,
				reasoningTokens: 25,
				totalTokens: 1200,
				costUsd: 0.05,
				unknownEventCount: 1,
			}
			const b2 = {
				key: { model: "model-b" },
				events: 3,
				completedCalls: 1,
				failedCalls: 1,
				cancelledCalls: 1,
				inputTokens: 2000,
				outputTokens: 400,
				cacheReadTokens: 300,
				cacheWriteTokens: 100,
				reasoningTokens: 50,
				totalTokens: 2400,
				costUsd: 0.1,
				unknownEventCount: 0,
			}

			const totals = sumBucketsToTotals([b1, b2])

			expect(totals.events).toBe(5)
			expect(totals.completedCalls).toBe(3)
			expect(totals.failedCalls).toBe(1)
			expect(totals.cancelledCalls).toBe(1)
			expect(totals.inputTokens).toBe(3000)
			expect(totals.outputTokens).toBe(600)
			expect(totals.cacheReadTokens).toBe(400)
			expect(totals.cacheWriteTokens).toBe(150)
			expect(totals.reasoningTokens).toBe(75)
			expect(totals.totalTokens).toBe(3600)
			expect(totals.costUsd).toBeCloseTo(0.15, 10)
			expect(totals.unknownEventCount).toBe(1)
			expect(totals.key).toEqual({})
		})
	})

	describe("rollup totals synthesis (sumBucketsToTotals)", () => {
		it("maintains sum(buckets.costUsd) === totals.costUsd when mixing priced and unpriced models", () => {
			// Event 1: Model with custom pricing
			const evtPriced = makeEvent({
				eventId: "evt-priced",
				idempotencyKey: "idem-priced",
				provider: "openai",
				model: "priced-custom-model",
				usage: {
					inputTokens: { value: 10000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.05, source: "provider" },
				},
			})

			// Event 2: Model without pricing (0 cost, missing from custom pricing map)
			const evtUnpriced = makeEvent({
				eventId: "evt-unpriced",
				idempotencyKey: "idem-unpriced",
				provider: "openai",
				model: "unpriced-custom-model",
				usage: {
					inputTokens: { value: 50000, source: "provider" },
					outputTokens: { value: 200, source: "provider" },
					costUsd: { value: 0, source: "provider" },
				},
			})

			db.append(evtPriced)
			db.append(evtUnpriced)

			// Custom pricing ONLY provided for the first model
			const customPricing = new Map([["openai|priced-custom-model", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])

			const snapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["model"], cacheRatio: 0.94 }), {
				customPricing,
			})

			// Invariant: sum of bucket costUsd must equal totals.costUsd exactly
			const bucketCostSum = snapshot.buckets.reduce((acc, b) => acc + b.costUsd, 0)
			expect(snapshot.totals.costUsd).toBeCloseTo(bucketCostSum, 10)

			// The priced model should receive its discount:
			// discountBase = (10000 / 1M) * (2.0 - 0.5) = 0.015
			// cost = 0.05 - 0.94 * 0.015 = 0.0359
			const pricedBucket = snapshot.buckets.find((b) => b.key.model === "priced-custom-model")
			expect(pricedBucket).toBeDefined()
			expect(pricedBucket!.costUsd).toBeCloseTo(0.0359, 10)

			// The unpriced model has 0 cost
			const unpricedBucket = snapshot.buckets.find((b) => b.key.model === "unpriced-custom-model")
			expect(unpricedBucket).toBeDefined()
			expect(unpricedBucket!.costUsd).toBe(0)

			// Totals cost must NOT be offset to 0 by any global calculation
			expect(snapshot.totals.costUsd).toBeCloseTo(0.0359, 10)
			expect(snapshot.totals.costUsd).toBeGreaterThan(0)
		})

		it("maintains sum(buckets.costUsd) === totals.costUsd for other single-axis groupBys (provider, day)", () => {
			const evt1 = makeEvent({
				eventId: "evt-p1",
				idempotencyKey: "idem-p1",
				occurredAt: "2026-07-19T10:00:00.000Z",
				provider: "openai",
				model: "model-1",
				usage: {
					inputTokens: { value: 10000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					costUsd: { value: 0.03, source: "provider" },
				},
			})
			const evt2 = makeEvent({
				eventId: "evt-p2",
				idempotencyKey: "idem-p2",
				occurredAt: "2026-07-20T10:00:00.000Z",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: {
					inputTokens: { value: 20000, source: "provider" },
					outputTokens: { value: 1000, source: "provider" },
					costUsd: { value: 0.06, source: "provider" },
				},
			})

			db.append(evt1)
			db.append(evt2)

			const customPricing = new Map([["openai|model-1", { inputPrice: 2.0, cacheReadsPrice: 0.5 }]])

			// Test provider axis
			const providerSnapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["provider"], cacheRatio: 0.5 }), {
				customPricing,
			})
			const providerCostSum = providerSnapshot.buckets.reduce((acc, b) => acc + b.costUsd, 0)
			expect(providerSnapshot.totals.costUsd).toBeCloseTo(providerCostSum, 10)

			// Test day axis
			const daySnapshot = assembleRollupSnapshot(db, makeQuery({ groupBy: ["day"], cacheRatio: 0.5 }), {
				customPricing,
			})
			const dayCostSum = daySnapshot.buckets.reduce((acc, b) => acc + b.costUsd, 0)
			expect(daySnapshot.totals.costUsd).toBeCloseTo(dayCostSum, 10)
		})
	})
})
