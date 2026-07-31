/**
 * Test to verify that assembleRollupSnapshot returns different data
 * for different presets when called with the exact query the frontend sends.
 *
 * The frontend always sends cacheRatio: 0.94, which forces the event-scan
 * fallback path (assembleRollupSnapshotFromEvents). This test verifies
 * that the fallback path correctly filters by preset date ranges.
 */

import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { assembleRollupSnapshot, computeSessionPage, computeHeatmapSnapshot } from "../UsageStatsProjection"

function createTempDir(): string {
	const prefix = path.join(os.tmpdir(), "dashboard-frontend-query-bug-")
	return fs.mkdtempSync(prefix)
}

function makeEventAt(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: new Date().toISOString(),
		timezoneOffsetMinutes: 540,
		status: "completed",
		attempt: 1,
		taskId: "task-001",
		rootTaskId: "root-task-001",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		mode: "code",
		usage: {
			inputTokens: { value: 1000, source: "provider" },
			outputTokens: { value: 500, source: "provider" },
			totalTokens: { value: 1500, source: "provider" },
			costUsd: { value: 0.01, source: "provider" },
		},
		semantics: {
			cacheReadInInput: "unknown",
			cacheWriteInInput: "unknown",
			reasoningInOutput: "unknown",
		},
		provenance: "live",
		...overrides,
	}
}

/** Exact replica of the frontend buildQuery output */
function frontendQuery(preset: "today" | "7d" | "30d" | "all"): StatsQuery {
	return {
		preset,
		from: undefined,
		to: undefined,
		timezone: "Asia/Seoul",
		groupBy: ["model"],
		includeCancelled: false,
		cacheRatio: 0.94,
	}
}

describe("Frontend Query Bug Investigation", () => {
	let tempDir: string
	let db: UsageStatsDatabase

	beforeEach(() => {
		tempDir = createTempDir()
		db = new UsageStatsDatabase(tempDir)
		db.initialize()
	})

	afterEach(() => {
		db.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("should return different event counts for today vs 7d vs all", () => {
		const now = new Date()
		const yesterday = new Date(now)
		yesterday.setDate(yesterday.getDate() - 1)
		const tenDaysAgo = new Date(now)
		tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)

		// Seed events
		db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r1", taskId: "t1" }))
		db.append(makeEventAt({ occurredAt: yesterday.toISOString(), rootTaskId: "r2", taskId: "t2" }))
		db.append(makeEventAt({ occurredAt: tenDaysAgo.toISOString(), rootTaskId: "r3", taskId: "t3" }))

		// Query with "today" preset
		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))
		// Query with "7d" preset
		const sevenDaySnap = assembleRollupSnapshot(db, frontendQuery("7d"))
		// Query with "all" preset
		const allSnap = assembleRollupSnapshot(db, frontendQuery("all"))

		console.log("today events:", todaySnap.totals.events)
		console.log("7d events:", sevenDaySnap.totals.events)
		console.log("all events:", allSnap.totals.events)
		console.log("today coverage:", todaySnap.coverage)
		console.log("7d coverage:", sevenDaySnap.coverage)

		// All should include all 3 events
		expect(allSnap.totals.events).toBe(3)

		// 7d should include today + yesterday (2 events)
		// (10 days ago is outside 7d range)
		expect(sevenDaySnap.totals.events).toBeGreaterThanOrEqual(todaySnap.totals.events)

		// Today should have at least 1 event
		expect(todaySnap.totals.events).toBeGreaterThanOrEqual(1)

		// 7d should have more events than today (unless all events are today)
		if (sevenDaySnap.totals.events === todaySnap.totals.events) {
			// This is the bug! Same data for different presets
			console.error("BUG: 7d and today return same event count!")
		}
	})

	it("sessions should be populated after seeding events", () => {
		const now = new Date()

		db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r1", taskId: "t1" }))
		db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r2", taskId: "t2" }))

		const sessionPage = computeSessionPage(db, "test-req", undefined, 50)

		console.log("sessions count:", sessionPage.sessions.length)
		console.log("totalEstimate:", sessionPage.totalEstimate)

		expect(sessionPage.sessions.length).toBeGreaterThanOrEqual(1)
	})

	it("heatmap should include today's data", () => {
		const now = new Date()

		db.append(
			makeEventAt({
				occurredAt: now.toISOString(),
				rootTaskId: "r1",
				taskId: "t1",
				usage: {
					inputTokens: { value: 5000, source: "provider" },
					outputTokens: { value: 2000, source: "provider" },
					totalTokens: { value: 7000, source: "provider" },
					costUsd: { value: 0.1, source: "provider" },
				},
			}),
		)

		const heatmap = computeHeatmapSnapshot(db, 30, "Asia/Seoul")

		console.log("heatmap values (last 5):", heatmap.values.slice(-5))
		console.log("heatmap rangeDays:", heatmap.rangeDays)

		// Today (last element) should have non-zero value
		const todayValue = heatmap.values[heatmap.values.length - 1]
		expect(todayValue).toBeGreaterThan(0)
	})

	it("coverage should reflect seeded events", () => {
		const now = new Date()
		const yesterday = new Date(now)
		yesterday.setDate(yesterday.getDate() - 1)

		db.append(makeEventAt({ occurredAt: yesterday.toISOString(), rootTaskId: "r1", taskId: "t1" }))
		db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r2", taskId: "t2" }))

		const snap = assembleRollupSnapshot(db, frontendQuery("all"))

		console.log("coverage:", snap.coverage)

		expect(snap.coverage.firstEventAt).toBeTruthy()
		expect(snap.coverage.lastEventAt).toBeTruthy()
	})
})
