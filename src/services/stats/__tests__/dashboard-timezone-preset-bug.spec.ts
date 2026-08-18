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
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"))
		tempDir = createTempDir()
		db = new UsageStatsDatabase(tempDir)
		db.initialize()
	})

	afterEach(() => {
		vi.useRealTimers()
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

		// All should include all 5 events
		expect(allSnap.totals.events).toBe(5)

		// 7d should include all 5 events (3 days ago is within 7 days)
		expect(sevenDaySnap.totals.events).toBe(5)

		// Today should only include events from today in Seoul timezone (now, 1h ago, 12h ago)
		expect(todaySnap.totals.events).toBe(3)
	})

	it("event at exactly midnight Seoul should be in today", () => {
		// Seoul midnight of today (2026-06-15 00:00:00 KST = 2026-06-14 15:00:00 UTC)
		const seoulMidnight = new Date("2026-06-14T15:00:00.000Z")

		db.append(
			makeEventAt({
				occurredAt: seoulMidnight.toISOString(),
				rootTaskId: "r-midnight",
				taskId: "t-midnight",
			}),
		)

		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))

		// The midnight event should be included in "today"
		expect(todaySnap.totals.events).toBe(1)
	})

	it("event just before midnight Seoul should be in yesterday", () => {
		// 2026-06-14 23:59:00 KST = 2026-06-14 14:59:00 UTC (1 minute before Seoul midnight)
		const beforeMidnight = new Date("2026-06-14T14:59:00.000Z")

		db.append(
			makeEventAt({
				occurredAt: beforeMidnight.toISOString(),
				rootTaskId: "r-before",
				taskId: "t-before",
			}),
		)

		const todaySnap = assembleRollupSnapshot(db, frontendQuery("today"))
		const sevenDaySnap = assembleRollupSnapshot(db, frontendQuery("7d"))

		// Excluded from today, included in 7d
		expect(todaySnap.totals.events).toBe(0)
		expect(sevenDaySnap.totals.events).toBe(1)
	})
})
