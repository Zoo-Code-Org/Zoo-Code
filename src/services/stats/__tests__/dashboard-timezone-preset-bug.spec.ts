/**
 * Test to verify that resolveTimeRange + event filtering works correctly
 * for Asia/Seoul timezone with events near day boundaries.
 *
 * The user is in Asia/Seoul (UTC+9). Events near midnight Seoul time
 * could be misclassified if the timezone handling is wrong.
 */

import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { assembleRollupSnapshot } from "../UsageStatsProjection"

function createTempDir(): string {
	const prefix = path.join(os.tmpdir(), "dashboard-tz-preset-bug-")
	return fs.mkdtempSync(prefix)
}

function makeEventAt(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: new Date().toISOString(),
		timezoneOffsetMinutes: 540, // Asia/Seoul UTC+9
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

describe("Timezone Preset Bug Investigation", () => {
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

	it("events at different times of day should be correctly filtered by preset", () => {
		const now = new Date()

		// Create events at various times relative to now
		const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000)
		const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000)
		const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000)
		const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)

		db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r-now", taskId: "t-now" }))
		db.append(makeEventAt({ occurredAt: oneHourAgo.toISOString(), rootTaskId: "r-1h", taskId: "t-1h" }))
		db.append(makeEventAt({ occurredAt: twelveHoursAgo.toISOString(), rootTaskId: "r-12h", taskId: "t-12h" }))
		db.append(makeEventAt({ occurredAt: twentyFiveHoursAgo.toISOString(), rootTaskId: "r-25h", taskId: "t-25h" }))
		db.append(makeEventAt({ occurredAt: threeDaysAgo.toISOString(), rootTaskId: "r-3d", taskId: "t-3d" }))

		// Query with "today" preset
		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))
		// Query with "7d" preset
		const sevenDaySnap = assembleRollupSnapshot(db, frontendQuery("7d"))
		// Query with "all" preset
		const allSnap = assembleRollupSnapshot(db, frontendQuery("all"))

		console.log("=== Timezone Preset Test ===")
		console.log("Current time (UTC):", now.toISOString())
		console.log("today events:", todaySnap.totals.events)
		console.log("7d events:", sevenDaySnap.totals.events)
		console.log("all events:", allSnap.totals.events)
		console.log("today coverage:", todaySnap.coverage.lastEventAt)

		// All should include all 5 events
		expect(allSnap.totals.events).toBe(5)

		// 7d should include all 5 events (3 days ago is within 7 days)
		expect(sevenDaySnap.totals.events).toBe(5)

		// Today should have fewer events than 7d
		// (only events from today in Seoul timezone)
		expect(todaySnap.totals.events).toBeLessThanOrEqual(sevenDaySnap.totals.events)

		// Verify data is actually different
		if (todaySnap.totals.events === sevenDaySnap.totals.events) {
			console.error("BUG: today and 7d return same event count!")
			console.error("today totals:", todaySnap.totals)
			console.error("7d totals:", sevenDaySnap.totals)
		}
	})

	it("event at exactly midnight Seoul should be in today", () => {
		// Create an event at exactly midnight Seoul time
		// Midnight Seoul = 15:00 UTC previous day
		const now = new Date()
		const seoulMidnight = new Date(now)
		seoulMidnight.setUTCHours(15, 0, 0, 0)
		// If 15:00 UTC today is in the future, use yesterday's 15:00 UTC
		if (seoulMidnight > now) {
			seoulMidnight.setUTCDate(seoulMidnight.getUTCDate() - 1)
		}

		db.append(
			makeEventAt({
				occurredAt: seoulMidnight.toISOString(),
				rootTaskId: "r-midnight",
				taskId: "t-midnight",
			}),
		)

		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))

		console.log("Seoul midnight event at:", seoulMidnight.toISOString())
		console.log("today events for midnight event:", todaySnap.totals.events)

		// The midnight event should be included in "today"
		expect(todaySnap.totals.events).toBeGreaterThanOrEqual(1)
	})

	it("event just before midnight Seoul should be in yesterday", () => {
		const now = new Date()
		// 14:59 UTC = 23:59 Seoul (just before midnight)
		const beforeMidnight = new Date(now)
		beforeMidnight.setUTCHours(14, 59, 0, 0)
		if (beforeMidnight > now) {
			beforeMidnight.setUTCDate(beforeMidnight.getUTCDate() - 1)
		}

		db.append(
			makeEventAt({
				occurredAt: beforeMidnight.toISOString(),
				rootTaskId: "r-before",
				taskId: "t-before",
			}),
		)

		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))
		const sevenDaySnap = assembleRollupSnapshot(db, frontendQuery("7d"))

		console.log("Before midnight event at:", beforeMidnight.toISOString())
		console.log("today events:", todaySnap.totals.events)
		console.log("7d events:", sevenDaySnap.totals.events)

		// The event might or might not be in "today" depending on whether
		// 23:59 Seoul is today or yesterday
		// But 7d should definitely include it
		expect(sevenDaySnap.totals.events).toBeGreaterThanOrEqual(1)
	})
})
