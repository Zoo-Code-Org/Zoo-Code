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
		it("never increases cacheReadTokens for events/rows with pre-existing cacheReadTokens > 0", () => {
			// Event 1: Provider reports 300 cached tokens out of 1000 input tokens
			const evtReported = makeEvent({
				eventId: "evt-reported",
				idempotencyKey: "idem-reported",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 200, source: "provider" },
					cacheReadTokens: { value: 300, source: "provider" },
				},
			})

			// Event 2: Provider does NOT report cacheReadTokens (0 or unassigned)
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

			// For evtReported: cacheReadTokens should remain 300 (NOT 300 + 500 = 800)
			// For evtUnreported: cacheReadTokens estimated as Math.round(1000 * 0.5) = 500
			// Total cacheReadTokens = 300 + 500 = 800
			expect(snapshot.totals.cacheReadTokens).toBe(800)
			expect(snapshot.buckets[0].cacheReadTokens).toBe(800)
		})
	})
})
