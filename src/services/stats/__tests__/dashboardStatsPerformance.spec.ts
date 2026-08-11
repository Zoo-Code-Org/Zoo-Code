import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { assembleRollupSnapshot, applyEventToProjection } from "../UsageStatsProjection"
import { UsageAggregator } from "../UsageAggregator"

// ── Test Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
	const prefix = path.join(os.tmpdir(), "usage-stats-perf-test-")
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

describe("Dashboard Stats Performance (ST-1: Rollup-backed Read Path)", () => {
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

	// ── Parity: rollup snapshot == event-based aggregator ─────────────────

	describe("parity: rollup snapshot vs UsageAggregator", () => {
		it("should match totals for single-axis [model] query (preset: all)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					provider: "openai",
					model: "gpt-4o",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 500, source: "provider" },
						outputTokens: { value: 250, source: "provider" },
						costUsd: { value: 0.005, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: ["model"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.outputTokens).toBe(aggregatorSnapshot.totals.outputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.totals.totalTokens).toBe(aggregatorSnapshot.totals.totalTokens)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)

			// Check each bucket matches
			for (let i = 0; i < dbSnapshot.buckets.length; i++) {
				expect(dbSnapshot.buckets[i].events).toBe(aggregatorSnapshot.buckets[i].events)
				expect(dbSnapshot.buckets[i].inputTokens).toBe(aggregatorSnapshot.buckets[i].inputTokens)
				expect(dbSnapshot.buckets[i].outputTokens).toBe(aggregatorSnapshot.buckets[i].outputTokens)
				expect(dbSnapshot.buckets[i].costUsd).toBeCloseTo(aggregatorSnapshot.buckets[i].costUsd, 10)
			}
		})

		it("should match totals for single-axis [provider] query (preset: all)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
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

			const query = makeQuery({ preset: "all", groupBy: ["provider"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
		})

		it("should match totals for single-axis [mode] query (preset: all)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					mode: "code",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					mode: "architect",
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

			const query = makeQuery({ preset: "all", groupBy: ["mode"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
		})

		it("should match totals for single-axis [day] query (preset: all)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
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

			const query = makeQuery({ preset: "all", groupBy: ["day"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
		})

		it("should match totals for empty groupBy (preset: all)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
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

			const query = makeQuery({ preset: "all", groupBy: [] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.buckets.length).toBe(0) // No grouping = no buckets
		})

		it("should match totals with cancelled events excluded (includeCancelled: false)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
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
					status: "cancelled",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-3",
					idempotencyKey: "idem-3",
					status: "completed",
					provider: "openai",
					usage: {
						inputTokens: { value: 3000, source: "provider" },
						outputTokens: { value: 1500, source: "provider" },
						costUsd: { value: 0.03, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: ["provider"], includeCancelled: false })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
		})

		it("should match totals with cancelled events included (includeCancelled: true)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
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
					status: "cancelled",
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

			const query = makeQuery({ preset: "all", groupBy: ["model"], includeCancelled: true })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.cancelledCalls).toBe(aggregatorSnapshot.totals.cancelledCalls)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
		})

		it("should match coverage (firstEventAt, lastEventAt, backfilledEventCount)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					provenance: "live",
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-20T10:00:00.000Z",
					provenance: "history-backfill",
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: [] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.coverage.firstEventAt).toBe(aggregatorSnapshot.coverage.firstEventAt)
			expect(dbSnapshot.coverage.lastEventAt).toBe(aggregatorSnapshot.coverage.lastEventAt)
			expect(dbSnapshot.coverage.backfilledEventCount).toBe(aggregatorSnapshot.coverage.backfilledEventCount)
		})

		it("should match cost for events without costUsd (cost recalculation)", () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						// costUsd missing — should be computed
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: ["model"] })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			// Both should use getEffectiveCost
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			// Anthropic claude-sonnet-4: $3/1M input, $15/1M output
			// 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(0.0105, 5)
		})
	})

	// ── Parity with cacheRatio: fast path (rollups) vs per-event aggregator ──
	// Production queries always carry cacheRatio (0.94). These tests pin that
	// the rollup fast path returns the same numbers as the per-event path for
	// homogeneous reporting buckets, and exact parity for mixed-reporting
	// buckets via the persisted unreported-cache input sums.

	describe("parity with cacheRatio: rollup snapshot vs UsageAggregator", () => {
		it("unreported cacheRead: estimation matches within rounding tolerance", () => {
			const events = [
				makeEvent({
					eventId: "evt-cr-1",
					idempotencyKey: "idem-cr-1",
					provider: "openai",
					model: "gpt-4o",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-cr-2",
					idempotencyKey: "idem-cr-2",
					provider: "openai",
					model: "gpt-4o",
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

			const query = makeQuery({ preset: "all", groupBy: ["model"], cacheRatio: 0.94 })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			// Estimation is applied in BOTH paths: unreported cacheRead is
			// estimated as input * 0.94 per event (aggregator) vs per bucket
			// (rollup converter). Per-event rounding can drift by < 1 token
			// per event, so allow tolerance = number of events.
			expect(dbSnapshot.totals.events).toBe(aggregatorSnapshot.totals.events)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.outputTokens).toBe(aggregatorSnapshot.totals.outputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(
				Math.abs(dbSnapshot.totals.cacheReadTokens - aggregatorSnapshot.totals.cacheReadTokens),
			).toBeLessThanOrEqual(events.length)
			// Both paths must estimate a non-zero cacheRead (~0.94 * 3000 = 2820).
			expect(dbSnapshot.totals.cacheReadTokens).toBeGreaterThan(2800)
			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)

			// Cost semantics: unreported events are discounted by ratio × discountBase.
			// gpt-4o: inputPrice $2.5/1M, cacheReadsPrice $1.25/1M → per-event bases
			// 1000/1M × 1.25 = 0.00125 and 2000/1M × 1.25 = 0.0025.
			// total = 0.03 − 0.94 × 0.00375 = 0.026475 (both paths, within rounding).
			expect(aggregatorSnapshot.totals.costUsd).toBeCloseTo(0.026475, 10)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(0.026475, 10)
		})

		it("server-reported cacheRead: exact match, no estimation applied", () => {
			const events = [
				makeEvent({
					eventId: "evt-cr-3",
					idempotencyKey: "idem-cr-3",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						cacheReadTokens: { value: 400, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-cr-4",
					idempotencyKey: "idem-cr-4",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						cacheReadTokens: { value: 800, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: ["model"], cacheRatio: 0.94 })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			// Server-reported values must be used verbatim in BOTH paths —
			// cacheRatio estimation must not touch reported cacheRead.
			expect(dbSnapshot.totals.cacheReadTokens).toBe(aggregatorSnapshot.totals.cacheReadTokens)
			expect(dbSnapshot.totals.cacheReadTokens).toBe(1200)
			expect(dbSnapshot.totals.inputTokens).toBe(aggregatorSnapshot.totals.inputTokens)
			expect(dbSnapshot.totals.outputTokens).toBe(aggregatorSnapshot.totals.outputTokens)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(aggregatorSnapshot.totals.costUsd, 10)
			expect(dbSnapshot.buckets[0]?.cacheReadTokens).toBe(aggregatorSnapshot.buckets[0]?.cacheReadTokens)

			// Server-reported events keep verbatim costs — no ratio discount in
			// either path. Exact match: 0.01 + 0.02 = 0.03.
			expect(aggregatorSnapshot.totals.costUsd).toBeCloseTo(0.03, 10)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(0.03, 10)
		})

		it("mixed-reporting bucket: exact parity between fast path and per-event path", () => {
			// One event reports cacheRead, another (same bucket) does not.
			// The rollup row persists the full input sum over unreported events,
			// so the fast path estimates exactly those events — identical to
			// the per-event path.
			const events = [
				makeEvent({
					eventId: "evt-cr-5",
					idempotencyKey: "idem-cr-5",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						cacheReadTokens: { value: 400, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-cr-6",
					idempotencyKey: "idem-cr-6",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
			]

			for (const event of events) {
				db.append(event)
			}

			const query = makeQuery({ preset: "all", groupBy: ["model"], cacheRatio: 0.94 })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			// Both paths: 400 reported + round(1000 * 0.94) estimated = 1340.
			expect(aggregatorSnapshot.totals.cacheReadTokens).toBe(1340)
			expect(dbSnapshot.totals.cacheReadTokens).toBe(1340)

			// Cost parity: the reported event keeps its verbatim 0.01; the
			// unreported one is discounted by 0.94 × (1000/1M × (3.0 − 0.3))
			// = 0.002538 → 0.01 + 0.007462 = 0.017462 in both paths.
			expect(aggregatorSnapshot.totals.costUsd).toBeCloseTo(0.017462, 10)
			expect(dbSnapshot.totals.costUsd).toBeCloseTo(0.017462, 10)
		})

		it("day axis with cacheRatio: bucket parity within rounding tolerance", () => {
			const events = [
				makeEvent({
					eventId: "evt-cr-7",
					idempotencyKey: "idem-cr-7",
					occurredAt: "2026-07-18T10:00:00.000Z",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-cr-8",
					idempotencyKey: "idem-cr-8",
					occurredAt: "2026-07-19T10:00:00.000Z",
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

			const query = makeQuery({ preset: "all", groupBy: ["day"], cacheRatio: 0.94 })
			const aggregator = new UsageAggregator()
			const aggregatorSnapshot = aggregator.query(events, query)
			const dbSnapshot = assembleRollupSnapshot(db, query)

			expect(dbSnapshot.buckets.length).toBe(aggregatorSnapshot.buckets.length)
			for (let i = 0; i < dbSnapshot.buckets.length; i++) {
				expect(dbSnapshot.buckets[i].inputTokens).toBe(aggregatorSnapshot.buckets[i].inputTokens)
				expect(dbSnapshot.buckets[i].outputTokens).toBe(aggregatorSnapshot.buckets[i].outputTokens)
				expect(dbSnapshot.buckets[i].costUsd).toBeCloseTo(aggregatorSnapshot.buckets[i].costUsd, 10)
				// Single-event buckets: per-event and per-row rounding are identical.
				expect(dbSnapshot.buckets[i].cacheReadTokens).toBe(aggregatorSnapshot.buckets[i].cacheReadTokens)
			}

			// Per-bucket discounted costs (claude-sonnet-4: base = input/1M × 2.7):
			// day 1: 0.01 − 0.94 × 0.0027 = 0.007462
			// day 2: 0.02 − 0.94 × 0.0054 = 0.014924
			expect(dbSnapshot.buckets[0].costUsd).toBeCloseTo(0.007462, 10)
			expect(dbSnapshot.buckets[1].costUsd).toBeCloseTo(0.014924, 10)
		})
	})

	// ── querySessionByRootTaskId ──────────────────────────────────────────

	describe("querySessionByRootTaskId", () => {
		it("should return the same result as querySessions(100).find(...)", () => {
			// Seed multiple sessions
			for (let i = 0; i < 5; i++) {
				db.append(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
						taskId: `task-${i}`,
						rootTaskId: `task-${i}`,
						occurredAt: new Date(2026, 6, 19 + i, 10, 0, 0).toISOString(),
						usage: {
							inputTokens: { value: 1000 * (i + 1), source: "provider" },
							outputTokens: { value: 500 * (i + 1), source: "provider" },
							costUsd: { value: 0.01 * (i + 1), source: "provider" },
						},
					}),
				)
			}

			const targetRootTaskId = "task-3"

			// Old approach: querySessions(100).find(...)
			const sessionPage = db.querySessions(100, undefined)
			const oldResult = sessionPage.sessions.find((s) => s.rootTaskId === targetRootTaskId)

			// New approach: querySessionByRootTaskId
			const newResult = db.querySessionByRootTaskId(targetRootTaskId)

			expect(newResult).toBeDefined()
			expect(oldResult).toBeDefined()
			expect(newResult!.rootTaskId).toBe(oldResult!.rootTaskId)
			expect(newResult!.eventCount).toBe(oldResult!.eventCount)
			expect(newResult!.totalCost).toBeCloseTo(oldResult!.totalCost, 10)
			expect(newResult!.totalTokens).toBe(oldResult!.totalTokens)
			expect(newResult!.model).toBe(oldResult!.model)
			expect(newResult!.provider).toBe(oldResult!.provider)
			expect(newResult!.lastActivity).toBe(oldResult!.lastActivity)
		})

		it("should return undefined for non-existent root_task_id", () => {
			db.append(
				makeEvent({
					taskId: "task-A",
					rootTaskId: "task-A",
				}),
			)

			const result = db.querySessionByRootTaskId("non-existent")
			expect(result).toBeUndefined()
		})

		it("should return undefined for empty database", () => {
			const result = db.querySessionByRootTaskId("any")
			expect(result).toBeUndefined()
		})
	})

	// ── Performance: 50K events → < 200ms snapshot assembly ──────────────

	describe("performance: 10K events snapshot assembly", () => {
		it("should assemble a snapshot in < 200ms for 10K events (preset: all, groupBy: [model])", () => {
			// Seed 10K events using bulkAppend
			const batchSize = 2000
			const totalEvents = 10000
			const models = ["claude-sonnet-4-20250514", "gpt-4o", "gemini-2.0-flash", "claude-haiku-4", "deepseek-chat"]
			const providers = ["anthropic", "openai", "gemini", "anthropic", "deepseek"]
			const modes = ["code", "architect", "ask", "debug", "code"]

			for (let batch = 0; batch < totalEvents / batchSize; batch++) {
				const events: UsageEventV1[] = []
				for (let i = 0; i < batchSize; i++) {
					const idx = batch * batchSize + i
					const modelIdx = idx % models.length
					events.push(
						makeEvent({
							eventId: `evt-${idx}`,
							idempotencyKey: `idem-${idx}`,
							taskId: `task-${idx % 100}`,
							rootTaskId: `task-${idx % 100}`,
							occurredAt: new Date(2026, 0, 1, 0, Math.floor(idx / 600), idx % 60).toISOString(),
							provider: providers[modelIdx],
							model: models[modelIdx],
							mode: modes[modelIdx],
							usage: {
								inputTokens: { value: 1000 + idx, source: "provider" },
								outputTokens: { value: 500 + idx, source: "provider" },
								costUsd: { value: 0.01, source: "provider" },
							},
						}),
					)
				}
				db.bulkAppend(events)
			}

			// Verify event count
			const totals = db.queryLifetimeTotals()
			expect(totals.eventCount).toBe(totalEvents)

			// Measure snapshot assembly time
			const query = makeQuery({ preset: "all", groupBy: ["model"] })

			// Warm up (first call may have JIT overhead)
			assembleRollupSnapshot(db, query)

			// Timed run
			const start = performance.now()
			const snapshot = assembleRollupSnapshot(db, query)
			const elapsed = performance.now() - start

			expect(snapshot.totals.events).toBe(totalEvents)
			expect(snapshot.buckets.length).toBe(models.length)
			expect(elapsed).toBeLessThan(200)

			console.log(`  10K events snapshot assembly: ${elapsed.toFixed(1)}ms`)
		}, 300000) // 5 minute timeout for seeding

		it("should assemble a snapshot in < 200ms for 10K events (preset: all, groupBy: [day])", () => {
			// Seed 10K events
			const batchSize = 2000
			const totalEvents = 10000

			for (let batch = 0; batch < totalEvents / batchSize; batch++) {
				const events: UsageEventV1[] = []
				for (let i = 0; i < batchSize; i++) {
					const idx = batch * batchSize + i
					events.push(
						makeEvent({
							eventId: `evt-d-${idx}`,
							idempotencyKey: `idem-d-${idx}`,
							taskId: `task-d-${idx % 100}`,
							rootTaskId: `task-d-${idx % 100}`,
							occurredAt: new Date(2026, 0, 1 + Math.floor(idx / 1000), 0, 0, idx % 60).toISOString(),
							usage: {
								inputTokens: { value: 1000, source: "provider" },
								outputTokens: { value: 500, source: "provider" },
								costUsd: { value: 0.01, source: "provider" },
							},
						}),
					)
				}
				db.bulkAppend(events)
			}

			const query = makeQuery({ preset: "all", groupBy: ["day"] })

			// Warm up
			assembleRollupSnapshot(db, query)

			// Timed run
			const start = performance.now()
			const snapshot = assembleRollupSnapshot(db, query)
			const elapsed = performance.now() - start

			expect(snapshot.totals.events).toBe(totalEvents)
			expect(elapsed).toBeLessThan(200)

			console.log(`  10K events [day] snapshot assembly: ${elapsed.toFixed(1)}ms`)
		}, 300000)
	})

	// ── applyEventToProjection uses querySessionByRootTaskId ─────────────

	describe("applyEventToProjection with querySessionByRootTaskId", () => {
		it("should return correct session upsert using direct lookup", () => {
			const event = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				taskId: "task-direct",
				rootTaskId: "task-direct",
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
			const upsert = delta.sessionUpsert.find((s) => s.rootTaskId === "task-direct")
			expect(upsert).toBeDefined()
			expect(upsert!.eventCount).toBe(1)
			expect(upsert!.totalCost).toBe(0.01)
		})

		it("should still work when session has many events (not limited by querySessions page size)", () => {
			// Seed 200 sessions to ensure the target is beyond querySessions(100) page
			for (let i = 0; i < 200; i++) {
				db.append(
					makeEvent({
						eventId: `evt-seed-${i}`,
						idempotencyKey: `idem-seed-${i}`,
						taskId: `task-seed-${i}`,
						rootTaskId: `task-seed-${i}`,
						occurredAt: new Date(2026, 0, 1, 0, Math.floor(i / 60), i % 60).toISOString(),
					}),
				)
			}

			// Now append the target event
			const targetEvent = makeEvent({
				eventId: "evt-target",
				idempotencyKey: "idem-target",
				taskId: "task-target",
				rootTaskId: "task-target",
				occurredAt: new Date().toISOString(),
				usage: {
					inputTokens: { value: 5000, source: "provider" },
					outputTokens: { value: 2500, source: "provider" },
					costUsd: { value: 0.5, source: "provider" },
				},
			})
			db.append(targetEvent)

			const query = makeQuery({ groupBy: ["day"] })
			const delta = applyEventToProjection(db, targetEvent, query, "req-001", 30, 1, 201)

			// The old querySessions(100).find(...) would NOT find "task-target"
			// because it's beyond the first 100 results.
			// The new querySessionByRootTaskId should find it directly.
			expect(delta.sessionUpsert.length).toBeGreaterThanOrEqual(1)
			const upsert = delta.sessionUpsert.find((s) => s.rootTaskId === "task-target")
			expect(upsert).toBeDefined()
			expect(upsert!.totalCost).toBe(0.5)
		})
	})
})
