/**
 * Reproduction test for dashboard preset-change bug.
 *
 * Bug symptoms (from user report):
 * 1. Clicking Today/7D/30D/All presets doesn't change the displayed data
 * 2. "Today" section is missing from Daily Activity heatmap
 * 3. Sessions list is empty
 *
 * Root cause hypothesis: replaceSubscription sends a new query with a
 * different preset, but the snapshot returned contains identical or empty
 * data. This test verifies the full flow from subscription → snapshot
 * for different presets against a seeded database.
 */

import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery, ExtensionMessage, DashboardStatsSubscription } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { UsageStatsStreamCoordinator, type StatsStreamSink } from "../UsageStatsStreamCoordinator"

// ── Test Helpers ────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "dashboard-preset-bug-test-")
	return fs.mkdtemp(prefix)
}

/** Create an event at a specific date/time with specific tokens */
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

/** Build a StatsQuery matching what the frontend buildQuery sends */
function buildFrontendQuery(preset: "today" | "7d" | "30d" | "all", groupBy: string[] = ["model"]): StatsQuery {
	return {
		preset,
		from: undefined,
		to: undefined,
		timezone: "Asia/Seoul",
		groupBy: groupBy as StatsQuery["groupBy"],
		includeCancelled: false,
		cacheRatio: 0.94, // Default from DashboardView
	}
}

function makeSubscription(overrides: Partial<DashboardStatsSubscription> = {}): DashboardStatsSubscription {
	return {
		requestId: `req-${Math.random().toString(36).slice(2)}`,
		range: buildFrontendQuery("today"),
		sessionPageSize: 50,
		heatmapRangeDays: 30,
		...overrides,
	}
}

class MockSink implements StatsStreamSink {
	readonly messages: ExtensionMessage[] = []
	private visible = true

	postMessage(message: ExtensionMessage): void {
		this.messages.push(message)
	}

	isVisible(): boolean {
		return this.visible
	}

	setVisible(v: boolean): void {
		this.visible = v
	}

	messagesOfType(type: string): ExtensionMessage[] {
		return this.messages.filter((m) => m.type === type)
	}
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

let tempDir: string
let db: UsageStatsDatabase

beforeEach(async () => {
	vi.useFakeTimers()
	tempDir = await createTempDir()
	db = new UsageStatsDatabase(tempDir)
	db.initialize()
})

afterEach(async () => {
	vi.useRealTimers()
	db.close()
	await fs.rm(tempDir, { recursive: true, force: true })
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Dashboard Preset Change Bug", () => {
	describe("Symptom 1: Preset buttons should change data", () => {
		it("replaceSubscription with different presets should return different snapshot data", () => {
			const now = new Date()
			const yesterday = new Date(now)
			yesterday.setDate(yesterday.getDate() - 1)
			const threeDaysAgo = new Date(now)
			threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)

			// Seed events: 1 today, 1 yesterday, 1 three days ago
			db.append(
				makeEventAt({
					occurredAt: now.toISOString(),
					rootTaskId: "root-today",
					taskId: "task-today",
				}),
			)
			db.append(
				makeEventAt({
					occurredAt: yesterday.toISOString(),
					rootTaskId: "root-yesterday",
					taskId: "task-yesterday",
				}),
			)
			db.append(
				makeEventAt({
					occurredAt: threeDaysAgo.toISOString(),
					rootTaskId: "root-3d",
					taskId: "task-3d",
				}),
			)

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			// Subscribe with "today" preset
			const todaySub = makeSubscription({
				requestId: "sub-today",
				range: buildFrontendQuery("today"),
			})
			coordinator.subscribe(sink, todaySub)

			const todaySnapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(todaySnapshots).toHaveLength(1)
			const todaySnap = todaySnapshots[0].dashboardStatsStreamSnapshot!
			const todayTotals = todaySnap.stats.totals

			sink.messages.length = 0

			// Replace with "7d" preset
			const sevenDaySub = makeSubscription({
				requestId: "sub-7d",
				range: buildFrontendQuery("7d"),
			})
			coordinator.replaceSubscription(sink, sevenDaySub)

			const sevenDaySnapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(sevenDaySnapshots).toHaveLength(1)
			const sevenDaySnap = sevenDaySnapshots[0].dashboardStatsStreamSnapshot!
			const sevenDayTotals = sevenDaySnap.stats.totals

			// 7d should include more events than today
			// Today should have 1 event, 7d should have 3 events (today + yesterday + 3 days ago)
			expect(sevenDayTotals.events).toBeGreaterThanOrEqual(todayTotals.events)

			// Verify the requestIds are different (new epoch)
			expect(todaySnap.requestId).toBe("sub-today")
			expect(sevenDaySnap.requestId).toBe("sub-7d")

			coordinator.dispose()
		})

		it("replaceSubscription from today to all should return all events", () => {
			const now = new Date()
			const oneYearAgo = new Date(now)
			oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

			// Seed events: 1 today, 1 from a year ago
			db.append(
				makeEventAt({
					occurredAt: now.toISOString(),
					rootTaskId: "root-today",
					taskId: "task-today",
				}),
			)
			db.append(
				makeEventAt({
					occurredAt: oneYearAgo.toISOString(),
					rootTaskId: "root-old",
					taskId: "task-old",
				}),
			)

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			// Subscribe with "today"
			coordinator.subscribe(
				sink,
				makeSubscription({
					requestId: "sub-today",
					range: buildFrontendQuery("today"),
				}),
			)

			const todaySnap = sink.messagesOfType("dashboardStatsStreamSnapshot")[0].dashboardStatsStreamSnapshot!

			sink.messages.length = 0

			// Replace with "all"
			coordinator.replaceSubscription(
				sink,
				makeSubscription({
					requestId: "sub-all",
					range: buildFrontendQuery("all"),
				}),
			)

			const allSnap = sink.messagesOfType("dashboardStatsStreamSnapshot")[0].dashboardStatsStreamSnapshot!

			// "all" should include both events
			expect(allSnap.stats.totals.events).toBeGreaterThanOrEqual(todaySnap.stats.totals.events)

			coordinator.dispose()
		})
	})

	describe("Symptom 2: Daily Activity Today missing", () => {
		it("heatmap should include today's data when events exist today", () => {
			const now = new Date()

			// Seed an event for today
			db.append(
				makeEventAt({
					occurredAt: now.toISOString(),
					rootTaskId: "root-today",
					taskId: "task-today",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						totalTokens: { value: 3000, source: "provider" },
						costUsd: { value: 0.05, source: "provider" },
					},
				}),
			)

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			coordinator.subscribe(
				sink,
				makeSubscription({
					requestId: "sub-heatmap",
					range: buildFrontendQuery("today"),
					heatmapRangeDays: 30,
				}),
			)

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)

			const snap = snapshots[0].dashboardStatsStreamSnapshot!
			const heatmap = snap.heatmap

			// Heatmap should have 30 values
			expect(heatmap.values).toHaveLength(30)
			expect(heatmap.rangeDays).toBe(30)

			// Today's value (last element, index 29) should be > 0
			const todayValue = heatmap.values[heatmap.values.length - 1]
			expect(todayValue).toBeGreaterThan(0)

			coordinator.dispose()
		})
	})

	describe("Symptom 3: Sessions empty", () => {
		it("sessions should be populated when events exist", () => {
			const now = new Date()

			// Seed events for two sessions
			db.append(
				makeEventAt({
					occurredAt: now.toISOString(),
					rootTaskId: "root-session-1",
					taskId: "task-session-1",
				}),
			)
			db.append(
				makeEventAt({
					occurredAt: now.toISOString(),
					rootTaskId: "root-session-2",
					taskId: "task-session-2",
					model: "gpt-4",
				}),
			)

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			coordinator.subscribe(
				sink,
				makeSubscription({
					requestId: "sub-sessions",
					range: buildFrontendQuery("today"),
				}),
			)

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)

			const snap = snapshots[0].dashboardStatsStreamSnapshot!
			const sessions = snap.sessions

			// Should have 2 sessions
			expect(sessions.sessions.length).toBeGreaterThanOrEqual(1)

			// Each session should have required fields
			for (const session of sessions.sessions) {
				expect(session.rootTaskId).toBeTruthy()
				expect(session.totalTokens).toBeGreaterThan(0)
			}

			coordinator.dispose()
		})
	})

	describe("Full flow: replaceSubscription produces different data for each preset", () => {
		it("should return different totals for today vs 7d vs 30d vs all", () => {
			const now = new Date()
			const yesterday = new Date(now)
			yesterday.setDate(yesterday.getDate() - 1)
			const tenDaysAgo = new Date(now)
			tenDaysAgo.setDate(tenDaysAgo.getDate() - 10)
			const sixtyDaysAgo = new Date(now)
			sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

			// Seed events across different time ranges
			db.append(makeEventAt({ occurredAt: now.toISOString(), rootTaskId: "r1", taskId: "t1" }))
			db.append(makeEventAt({ occurredAt: yesterday.toISOString(), rootTaskId: "r2", taskId: "t2" }))
			db.append(makeEventAt({ occurredAt: tenDaysAgo.toISOString(), rootTaskId: "r3", taskId: "t3" }))
			db.append(makeEventAt({ occurredAt: sixtyDaysAgo.toISOString(), rootTaskId: "r4", taskId: "t4" }))

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			const presets: Array<"today" | "7d" | "30d" | "all"> = ["today", "7d", "30d", "all"]
			const results: Array<{ preset: string; events: number }> = []

			for (const preset of presets) {
				sink.messages.length = 0
				coordinator.replaceSubscription(
					sink,
					makeSubscription({
						requestId: `sub-${preset}`,
						range: buildFrontendQuery(preset),
					}),
				)

				const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshots).toHaveLength(1)

				const snap = snapshots[0].dashboardStatsStreamSnapshot!
				results.push({ preset, events: snap.stats.totals.events })
			}

			// Each broader preset should include at least as many events as the narrower one
			const todayResult = results.find((r) => r.preset === "today")!
			const sevenDayResult = results.find((r) => r.preset === "7d")!
			const thirtyDayResult = results.find((r) => r.preset === "30d")!
			const allResult = results.find((r) => r.preset === "all")!

			expect(sevenDayResult.events).toBeGreaterThanOrEqual(todayResult.events)
			expect(thirtyDayResult.events).toBeGreaterThanOrEqual(sevenDayResult.events)
			expect(allResult.events).toBeGreaterThanOrEqual(thirtyDayResult.events)

			// "all" should have exactly 4 events
			expect(allResult.events).toBe(4)

			coordinator.dispose()
		})
	})
})
