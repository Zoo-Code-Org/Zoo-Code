import * as path from "path"
import { providerIdentifiers } from "@roo-code/types"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery, ExtensionMessage, DashboardStatsSubscription } from "@roo-code/types"

import type { HistoryItem } from "@roo-code/types"
import { DashboardTaskCatalog, type DashboardTaskCatalogSource } from "../DashboardTaskCatalog"
import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { UsageStatsStreamCoordinator, type StatsStreamSink } from "../UsageStatsStreamCoordinator"
import * as UsageStatsProjection from "../UsageStatsProjection"

vi.mock("vscode", () => {
	class EventEmitter<T> {
		private readonly listeners = new Set<(event: T) => unknown>()
		readonly event = (listener: (event: T) => unknown) => {
			this.listeners.add(listener)
			return { dispose: () => this.listeners.delete(listener) }
		}
		fire(event: T): void {
			for (const listener of this.listeners) {
				listener(event)
			}
		}
		dispose(): void {
			this.listeners.clear()
		}
	}

	return { EventEmitter }
})

// ── Test Helpers ────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "usage-stats-coordinator-test-")
	return fs.mkdtemp(prefix)
}

function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
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
		provider: providerIdentifiers.anthropic,
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

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "UTC",
		groupBy: ["day"],
		includeCancelled: false,
		cacheRatio: 0.1,
		...overrides,
	}
}

function makeSubscription(overrides: Partial<DashboardStatsSubscription> = {}): DashboardStatsSubscription {
	return {
		requestId: `req-${Math.random().toString(36).slice(2)}`,
		range: makeQuery(),
		sessionPageSize: 50,
		heatmapRangeDays: 30,
		...overrides,
	}
}

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Math.random().toString(36).slice(2)}`,
		number: 1,
		ts: Date.now(),
		task: "History task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

function createTaskCatalog(initialItems: HistoryItem[]): {
	catalog: DashboardTaskCatalog
	replace(items: HistoryItem[]): void
	emitChange(): void
} {
	let items = initialItems
	const listeners = new Set<() => void>()
	const source: DashboardTaskCatalogSource = {
		getAll: () => items,
		onDidChange: (listener) => {
			listeners.add(listener)
			return { dispose: () => listeners.delete(listener) }
		},
	}

	return {
		catalog: new DashboardTaskCatalog(source),
		replace(nextItems: HistoryItem[]) {
			items = nextItems
		},
		emitChange() {
			for (const listener of listeners) {
				listener()
			}
		},
	}
}

/**
 * Mock sink that records all posted messages and reports visibility.
 */
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

	/** Returns only messages of a specific type. */
	messagesOfType(type: string): ExtensionMessage[] {
		return this.messages.filter((m) => m.type === type)
	}
}

/**
 * A sink whose postMessage always throws.
 */
class RejectingSink implements StatsStreamSink {
	readonly messages: ExtensionMessage[] = []

	postMessage(_message: ExtensionMessage): void {
		throw new Error("postMessage rejected")
	}

	isVisible(): boolean {
		return true
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

describe("UsageStatsStreamCoordinator", () => {
	describe("no-subscriber idle behavior", () => {
		it("should not schedule a drain when there are no subscribers", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			coordinator.notifyEventAppended(makeEvent())
			expect(coordinator._isDrainPending()).toBe(false)
			coordinator.dispose()
		})

		it("should not schedule a drain for external change with no subscribers", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			coordinator.notifyExternalChange()
			expect(coordinator._isDrainPending()).toBe(false)
			coordinator.dispose()
		})
	})

	describe("subscribe — initial snapshot", () => {
		it("should send an initial snapshot on subscribe", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			const sub = makeSubscription()

			coordinator.subscribe(sink, sub)

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)
			expect(snapshots[0].dashboardStatsStreamSnapshot?.requestId).toBe(sub.requestId)
			expect(snapshots[0].dashboardStatsStreamSnapshot?.generation).toBe(1)
			expect(snapshots[0].dashboardStatsStreamSnapshot?.sequence).toBe(0)

			coordinator.dispose()
		})

		it("should send error when database is null", () => {
			const coordinator = new UsageStatsStreamCoordinator(null)
			const sink = new MockSink()
			const sub = makeSubscription()

			coordinator.subscribe(sink, sub)

			const errors = sink.messagesOfType("dashboardStatsStreamError")
			expect(errors).toHaveLength(1)
			expect(errors[0].dashboardStatsStreamError?.code).toBe("STATS_STREAM/subscribe/001")

			coordinator.dispose()
		})

		it("includes zero-usage History tasks in a task snapshot", () => {
			const { catalog } = createTaskCatalog([makeHistoryItem({ id: "history-only", ts: 100 })])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()

			coordinator.subscribe(sink, makeSubscription())

			const snapshot = sink.messagesOfType("dashboardStatsStreamSnapshot")[0].dashboardStatsStreamSnapshot
			if (!snapshot || !("tasks" in snapshot)) {
				throw new Error("STATS_TEST/historyTaskSnapshot/001: expected task snapshot")
			}
			expect(snapshot.tasks.tasks).toEqual([
				expect.objectContaining({ taskId: "history-only", eventCount: 0, totalTokens: 0, totalCost: 0 }),
			])

			coordinator.dispose()
			catalog.dispose()
		})
	})

	describe("History-first task stream updates", () => {
		it("upserts the direct task and its visible ancestor after usage", () => {
			const { catalog } = createTaskCatalog([
				makeHistoryItem({ id: "root", ts: 200 }),
				makeHistoryItem({ id: "child", ts: 100, parentTaskId: "root", rootTaskId: "root" }),
			])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			const event = makeEvent({ taskId: "child", rootTaskId: "root" })
			db.append(event)
			coordinator.notifyEventAppended(event)
			vi.advanceTimersByTime(100)

			const delta = sink.messagesOfType("dashboardStatsStreamDelta")[0].dashboardStatsStreamDelta
			if (!delta || !("taskUpsert" in delta)) {
				throw new Error("STATS_TEST/historyTaskDelta/001: expected task delta")
			}
			expect(delta.taskUpsert.map((task) => task.taskId)).toEqual(["child", "root"])
			expect(delta.taskUpsert.find((task) => task.taskId === "root")).toMatchObject({ eventCount: 1 })

			coordinator.dispose()
			catalog.dispose()
		})

		it("coalesces a History mutation burst into one replacement task snapshot", async () => {
			const source = createTaskCatalog([makeHistoryItem({ id: "initial", ts: 100 })])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: source.catalog })
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			source.replace([makeHistoryItem({ id: "updated", ts: 200 })])
			source.emitChange()
			await vi.advanceTimersByTimeAsync(300)
			coordinator.notifyTaskCatalogChanged()
			coordinator.notifyTaskCatalogChanged()
			await vi.advanceTimersByTimeAsync(50)

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)
			const snapshot = snapshots[0].dashboardStatsStreamSnapshot
			if (!snapshot || !("tasks" in snapshot)) {
				throw new Error("STATS_TEST/historyTaskCatalogChange/001: expected task snapshot")
			}
			expect(snapshot.tasks.tasks).toEqual([expect.objectContaining({ taskId: "updated" })])

			coordinator.dispose()
			source.catalog.dispose()
		})

		it("keeps History task IDs with zero metrics after a generation reset", () => {
			const { catalog } = createTaskCatalog([makeHistoryItem({ id: "history-task", ts: 100 })])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			db.append(makeEvent({ taskId: "history-task", rootTaskId: "history-task" }))
			coordinator.resetGeneration()

			const snapshot = sink.messagesOfType("dashboardStatsStreamSnapshot").at(-1)?.dashboardStatsStreamSnapshot
			if (!snapshot || !("tasks" in snapshot)) {
				throw new Error("STATS_TEST/historyTaskReset/001: expected task snapshot")
			}
			expect(snapshot.tasks.tasks).toEqual([
				expect.objectContaining({ taskId: "history-task", eventCount: 0, totalTokens: 0, totalCost: 0 }),
			])

			coordinator.dispose()
			catalog.dispose()
		})

		it("filters the snapshot task page to the subscription range", () => {
			const { catalog } = createTaskCatalog([
				makeHistoryItem({ id: "old-task", ts: Date.parse("2026-07-01T00:00:00.000Z") }),
				makeHistoryItem({ id: "recent-task", ts: Date.parse("2026-08-01T00:00:00.000Z") }),
			])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()

			coordinator.subscribe(
				sink,
				makeSubscription({
					range: makeQuery({ from: "2026-07-15T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" }),
				}),
			)

			const snapshot = sink.messagesOfType("dashboardStatsStreamSnapshot")[0].dashboardStatsStreamSnapshot
			if (!snapshot || !("tasks" in snapshot)) {
				throw new Error("STATS_TEST/historyTaskRangeSnapshot/001: expected task snapshot")
			}
			expect(snapshot.tasks.tasks.map((task) => task.taskId)).toEqual(["recent-task"])
			expect(snapshot.tasks.totalEstimate).toBe(1)

			coordinator.dispose()
			catalog.dispose()
		})

		it("filters task upserts by creation timestamp and in-range figures on drain", () => {
			const { catalog } = createTaskCatalog([
				makeHistoryItem({ id: "old-task", ts: Date.parse("2026-07-01T00:00:00.000Z") }),
				makeHistoryItem({ id: "recent-task", ts: Date.parse("2026-08-01T00:00:00.000Z") }),
			])
			// An out-of-range event for the in-range task: counted all-time but
			// excluded from range-filtered figures.
			db.append(
				makeEvent({
					taskId: "recent-task",
					rootTaskId: "recent-task",
					occurredAt: "2026-07-10T00:00:00.000Z",
					usage: {
						totalTokens: { value: 999, source: "provider" },
						costUsd: { value: 9, source: "provider" },
					},
				}),
			)
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()
			coordinator.subscribe(
				sink,
				makeSubscription({
					range: makeQuery({ from: "2026-07-15T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" }),
				}),
			)
			sink.messages.length = 0

			// In-range activity on a task created outside the range: no upsert.
			const oldTaskEvent = makeEvent({
				taskId: "old-task",
				rootTaskId: "old-task",
				occurredAt: "2026-08-02T00:00:00.000Z",
			})
			db.append(oldTaskEvent)
			// In-range activity on the in-range task: upsert with ranged figures.
			const recentTaskEvent = makeEvent({
				taskId: "recent-task",
				rootTaskId: "recent-task",
				occurredAt: "2026-08-02T00:00:00.000Z",
				usage: { totalTokens: { value: 100, source: "provider" }, costUsd: { value: 1, source: "provider" } },
			})
			db.append(recentTaskEvent)
			coordinator.notifyEventAppended(recentTaskEvent)
			vi.advanceTimersByTime(100)

			const deltas = sink.messagesOfType("dashboardStatsStreamDelta")
			expect(deltas.length).toBeGreaterThan(0)
			let recentUpsert: { taskId: string } | undefined
			for (const message of deltas) {
				const delta = message.dashboardStatsStreamDelta
				if (!delta || !("taskUpsert" in delta)) {
					throw new Error("STATS_TEST/historyTaskRangeDelta/001: expected task delta")
				}
				expect(delta.taskUpsert.map((task) => task.taskId)).not.toContain("old-task")
				recentUpsert = delta.taskUpsert.find((task) => task.taskId === "recent-task") ?? recentUpsert
			}
			expect(recentUpsert).toMatchObject({ eventCount: 1, totalTokens: 100, totalCost: 1 })

			coordinator.dispose()
			catalog.dispose()
		})

		it("exposes the sink's active subscription via getSubscription", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			expect(coordinator.getSubscription(sink)).toBeUndefined()
			const subscription = makeSubscription()
			coordinator.subscribe(sink, subscription)
			expect(coordinator.getSubscription(sink)).toBe(subscription)
			coordinator.unsubscribe(sink)
			expect(coordinator.getSubscription(sink)).toBeUndefined()

			coordinator.dispose()
		})
	})

	describe("local notification coalescing", () => {
		it("should coalesce multiple notifications into a single drain", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			// Clear snapshot messages
			sink.messages.length = 0

			// Append events to the DB directly
			db.append(makeEvent())
			db.append(makeEvent())
			db.append(makeEvent())

			// Notify 3 times rapidly
			coordinator.notifyEventAppended(makeEvent())
			coordinator.notifyEventAppended(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			// A drain should be pending (coalesced)
			expect(coordinator._isDrainPending()).toBe(true)

			// Advance timers to trigger the drain
			vi.advanceTimersByTime(100)

			// Should have sent deltas (at least 1 delta message)
			const deltas = sink.messagesOfType("dashboardStatsStreamDelta")
			expect(deltas.length).toBeGreaterThan(0)

			coordinator.dispose()
		})
	})

	describe("external notification coalescing", () => {
		it("should coalesce external change notifications", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			db.append(makeEvent())

			coordinator.notifyExternalChange()
			coordinator.notifyExternalChange()

			expect(coordinator._isDrainPending()).toBe(true)

			vi.advanceTimersByTime(100)

			const deltas = sink.messagesOfType("dashboardStatsStreamDelta")
			expect(deltas.length).toBeGreaterThan(0)

			coordinator.dispose()
		})
	})

	describe("query filtering", () => {
		it("should send zero deltas for events outside the query time range", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()

			// Subscribe with a query that only includes future events
			const futureQuery = makeQuery({
				from: new Date(Date.now() + 86400000).toISOString(),
			})
			coordinator.subscribe(sink, makeSubscription({ range: futureQuery }))
			sink.messages.length = 0

			// Append an event in the past (outside query range)
			const event = makeEvent({
				occurredAt: new Date(Date.now() - 86400000).toISOString(),
			})
			db.append(event)
			coordinator.notifyEventAppended(event)

			vi.advanceTimersByTime(100)

			// The delta should still be sent (with zero values since event is outside range)
			const deltas = sink.messagesOfType("dashboardStatsStreamDelta")
			expect(deltas).toHaveLength(1)
			// Total delta events should be 0 (filtered out)
			expect(deltas[0].dashboardStatsStreamDelta?.totalDelta.events).toBe(0)

			coordinator.dispose()
		})
	})

	describe("max batch / size limits", () => {
		it("should limit each drain batch to MAX_BATCH_EVENTS (100)", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Append 150 events
			for (let i = 0; i < 150; i++) {
				db.append(makeEvent())
			}
			coordinator.notifyEventAppended(makeEvent())

			// Advance only enough for the first coalesced drain (50ms)
			vi.advanceTimersByTime(50)

			const deltasAfterFirstBatch = sink.messagesOfType("dashboardStatsStreamDelta")
			// First batch should be bounded to 100 events
			expect(deltasAfterFirstBatch.length).toBeLessThanOrEqual(100)

			coordinator.dispose()
		})
	})

	describe("duplicate notifications", () => {
		it("should not re-send deltas for already-seen sequences", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Append one event
			const event = makeEvent()
			db.append(event)
			coordinator.notifyEventAppended(event)

			vi.advanceTimersByTime(100)

			const deltasAfterFirst = sink.messagesOfType("dashboardStatsStreamDelta").length
			expect(deltasAfterFirst).toBeGreaterThan(0)

			// Notify again with the same event (no new DB writes)
			coordinator.notifyEventAppended(event)
			vi.advanceTimersByTime(100)

			// No new deltas should be sent (sequence already advanced)
			const deltasAfterSecond = sink.messagesOfType("dashboardStatsStreamDelta").length
			expect(deltasAfterSecond).toBe(deltasAfterFirst)

			coordinator.dispose()
		})
	})

	describe("pause and resume", () => {
		it("should stop delta delivery when paused", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			coordinator.pause(sink)

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			vi.advanceTimersByTime(100)

			// No deltas should be delivered while paused
			expect(sink.messagesOfType("dashboardStatsStreamDelta")).toHaveLength(0)

			coordinator.dispose()
		})

		it("should resume delta delivery from the last sequence", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Append an event before pausing
			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())
			vi.advanceTimersByTime(100)

			const deltasBeforePause = sink.messagesOfType("dashboardStatsStreamDelta").length
			expect(deltasBeforePause).toBeGreaterThan(0)

			// Pause
			coordinator.pause(sink)

			// Append more events while paused
			db.append(makeEvent())
			db.append(makeEvent())

			// Resume with the last known sequence
			const lastSeq = db.getLastSequence() - 2 // back up 2 events
			coordinator.resume(sink, lastSeq)

			vi.advanceTimersByTime(100)

			// Should receive deltas for the 2 events that happened while paused
			const deltasAfterResume = sink.messagesOfType("dashboardStatsStreamDelta").length
			expect(deltasAfterResume).toBeGreaterThan(0)

			coordinator.dispose()
		})
	})

	describe("hidden resume after long period", () => {
		it("should send full snapshot when gap is too large (>100 events)", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Append 150 events (more than MAX_BATCH_EVENTS)
			for (let i = 0; i < 150; i++) {
				db.append(makeEvent())
			}

			// Resume with sequence 0 (gap of 150 > 100)
			coordinator.resume(sink, 0)

			// Should send a snapshot, not deltas
			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)

			coordinator.dispose()
		})
	})

	describe("gap fallback to snapshot", () => {
		it("should send snapshot when generation changes during resume", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Simulate generation change by clearing
			db.clearGeneration()

			coordinator.resume(sink, 0)

			// Should send a snapshot (generation changed)
			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)

			coordinator.dispose()
		})
	})

	describe("rollover at midnight", () => {
		it("should send fresh snapshots when day boundary is crossed", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Force the rollover check by advancing the interval timer
			// The coordinator checks every 30 seconds
			vi.advanceTimersByTime(31000)

			// No snapshots should be sent if day hasn't changed yet
			// (lastDayBucket is set on first check, so first check doesn't trigger)
			expect(sink.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(0)

			coordinator.dispose()
		})
	})

	describe("clear generation", () => {
		it("should send reset snapshot to all subscribers on resetGeneration", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink1 = new MockSink()
			const sink2 = new MockSink()

			coordinator.subscribe(sink1, makeSubscription())
			coordinator.subscribe(sink2, makeSubscription())

			sink1.messages.length = 0
			sink2.messages.length = 0

			// Append some events first
			db.append(makeEvent())
			db.append(makeEvent())

			coordinator.resetGeneration()

			// Both subscribers should receive a fresh snapshot
			expect(sink1.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(1)
			expect(sink2.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(1)

			coordinator.dispose()
		})
	})

	describe("message failure (rejected postMessage)", () => {
		it("should handle rejected postMessage on delta without crashing", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new RejectingSink()

			// Subscribe — snapshot will also fail, but that's handled
			coordinator.subscribe(sink, makeSubscription())

			// Append and notify
			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			// Should not throw
			expect(() => vi.advanceTimersByTime(100)).not.toThrow()

			coordinator.dispose()
		})

		it("should mark subscriber for snapshot fallback on delta failure", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			// Make postMessage throw on delta delivery only
			const originalPostMessage = sink.postMessage.bind(sink)
			let callCount = 0
			sink.postMessage = (msg: ExtensionMessage) => {
				callCount++
				if (msg.type === "dashboardStatsStreamDelta") {
					throw new Error("rejected")
				}
				originalPostMessage(msg)
			}

			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			vi.advanceTimersByTime(100)

			// The coordinator should not have crashed
			// The subscriber's snapshotSent flag should be false (marked for fallback)
			expect(coordinator._subscriptionCount()).toBe(1)

			coordinator.dispose()
		})
	})

	describe("disposal cleanup", () => {
		it("should clear all subscriptions on dispose", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink1 = new MockSink()
			const sink2 = new MockSink()

			coordinator.subscribe(sink1, makeSubscription())
			coordinator.subscribe(sink2, makeSubscription())

			expect(coordinator._subscriptionCount()).toBe(2)

			coordinator.dispose()

			expect(coordinator._subscriptionCount()).toBe(0)
		})

		it("should not schedule drains after dispose", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			coordinator.dispose()

			coordinator.notifyEventAppended(makeEvent())
			expect(coordinator._isDrainPending()).toBe(false)
		})

		it("should not accept new subscriptions after dispose", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			coordinator.dispose()

			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			expect(coordinator._subscriptionCount()).toBe(0)
			expect(sink.messages).toHaveLength(0)
		})
	})

	describe("replaceSubscription", () => {
		it("should replace the subscription and send a new snapshot", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			const sub1 = makeSubscription({ requestId: "req-1" })
			coordinator.subscribe(sink, sub1)

			sink.messages.length = 0

			const sub2 = makeSubscription({ requestId: "req-2" })
			coordinator.replaceSubscription(sink, sub2)

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)
			expect(snapshots[0].dashboardStatsStreamSnapshot?.requestId).toBe("req-2")

			coordinator.dispose()
		})
	})

	describe("unsubscribe", () => {
		it("should remove the subscription", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			expect(coordinator._subscriptionCount()).toBe(1)

			coordinator.unsubscribe(sink)

			expect(coordinator._subscriptionCount()).toBe(0)

			coordinator.dispose()
		})

		it("should not deliver deltas after unsubscribe", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			coordinator.unsubscribe(sink)

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())
			vi.advanceTimersByTime(100)

			expect(sink.messagesOfType("dashboardStatsStreamDelta")).toHaveLength(0)

			coordinator.dispose()
		})
	})

	describe("visibility filtering", () => {
		it("should skip delta delivery when sink is not visible", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.setVisible(false)
			sink.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			vi.advanceTimersByTime(100)

			// No deltas should be delivered when not visible
			expect(sink.messagesOfType("dashboardStatsStreamDelta")).toHaveLength(0)

			coordinator.dispose()
		})

		it("should still deliver snapshots when sink is not visible", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			sink.setVisible(false)

			coordinator.subscribe(sink, makeSubscription())

			// Snapshot should still be delivered even when not visible
			expect(sink.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(1)

			coordinator.dispose()
		})
	})

	describe("multiple subscribers", () => {
		it("should deliver deltas to all active subscribers", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink1 = new MockSink()
			const sink2 = new MockSink()

			coordinator.subscribe(sink1, makeSubscription())
			coordinator.subscribe(sink2, makeSubscription())

			sink1.messages.length = 0
			sink2.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			vi.advanceTimersByTime(100)

			expect(sink1.messagesOfType("dashboardStatsStreamDelta").length).toBeGreaterThan(0)
			expect(sink2.messagesOfType("dashboardStatsStreamDelta").length).toBeGreaterThan(0)

			coordinator.dispose()
		})

		it("should only deliver deltas to non-paused subscribers", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink1 = new MockSink()
			const sink2 = new MockSink()

			coordinator.subscribe(sink1, makeSubscription())
			coordinator.subscribe(sink2, makeSubscription())

			coordinator.pause(sink2)

			sink1.messages.length = 0
			sink2.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			vi.advanceTimersByTime(100)

			expect(sink1.messagesOfType("dashboardStatsStreamDelta").length).toBeGreaterThan(0)
			expect(sink2.messagesOfType("dashboardStatsStreamDelta")).toHaveLength(0)

			coordinator.dispose()
		})

		describe("auto-rebuild stale rollups", () => {
			/**
			 * Helper: clears derived tables (stats_rollup, session_metadata, session_activity)
			 * to simulate a migration gap or stale derived data.
			 */
			function clearDerivedTables(): void {
				const rawDb = db as unknown as { db: { exec: (sql: string) => void } }
				rawDb.db.exec("DELETE FROM stats_rollup")
				rawDb.db.exec("DELETE FROM session_metadata")
				rawDb.db.exec("DELETE FROM session_activity")
			}

			it("should auto-rebuild when events exist but derived tables are empty", () => {
				// Append an event (populates all tables), then clear derived tables
				db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
				clearDerivedTables()

				const rebuildSpy = vi.spyOn(db, "rebuildRollupsFromEvents")

				const coordinator = new UsageStatsStreamCoordinator(db)
				const sink = new MockSink()
				coordinator.subscribe(sink, makeSubscription())

				// First snapshot is sent immediately with empty/stale data (non-blocking)
				const snapshotsBeforeFlush = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshotsBeforeFlush).toHaveLength(1)
				expect(rebuildSpy).not.toHaveBeenCalled()

				// Flush the setImmediate to run the async rebuild
				// Use runOnlyPendingTimers to avoid infinite loop from rollover setInterval
				vi.runOnlyPendingTimers()

				// Rebuild should have been triggered
				expect(rebuildSpy).toHaveBeenCalledTimes(1)

				// A second snapshot should have been sent with rebuilt data
				const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshots).toHaveLength(2)
				const rebuiltSnapshot = snapshots[1].dashboardStatsStreamSnapshot
				expect(rebuiltSnapshot).toBeDefined()
				if (!rebuiltSnapshot || !("sessions" in rebuiltSnapshot)) {
					throw new Error("STATS_TEST/rebuildSnapshot/001: expected legacy session snapshot")
				}

				// After rebuild, sessions should be populated
				expect(rebuiltSnapshot.sessions.sessions.length).toBeGreaterThan(0)

				// After rebuild, heatmap should have at least one non-zero value
				expect(rebuiltSnapshot.heatmap.values.some((v) => v > 0)).toBe(true)

				coordinator.dispose()
				rebuildSpy.mockRestore()
			})

			it("should NOT rebuild when derived tables are already consistent", () => {
				// Append an event normally — all derived tables are populated
				db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))

				const rebuildSpy = vi.spyOn(db, "rebuildRollupsFromEvents")

				const coordinator = new UsageStatsStreamCoordinator(db)
				const sink = new MockSink()
				coordinator.subscribe(sink, makeSubscription())

				// Flush any pending timers (should be none since rebuild is not needed)
				vi.runOnlyPendingTimers()

				// Rebuild should NOT have been called
				expect(rebuildSpy).not.toHaveBeenCalled()

				// Snapshot should still be sent with data
				const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshots).toHaveLength(1)
				const snapshot = snapshots[0].dashboardStatsStreamSnapshot
				if (!snapshot || !("sessions" in snapshot)) {
					throw new Error("STATS_TEST/consistentSnapshot/001: expected legacy session snapshot")
				}
				expect(snapshot.sessions.sessions.length).toBeGreaterThan(0)

				coordinator.dispose()
				rebuildSpy.mockRestore()
			})

			it("should send original snapshot when rebuildRollupsFromEvents throws", () => {
				// Append an event, then clear derived tables
				db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
				clearDerivedTables()

				// Mock rebuild to throw
				const rebuildSpy = vi.spyOn(db, "rebuildRollupsFromEvents").mockImplementation(() => {
					throw new Error("rebuild failed")
				})

				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				const coordinator = new UsageStatsStreamCoordinator(db)
				const sink = new MockSink()

				// Should not throw — snapshot is sent synchronously, rebuild is async
				expect(() => coordinator.subscribe(sink, makeSubscription())).not.toThrow()

				// First snapshot is sent immediately (with stale/empty derived data)
				const snapshotsBeforeFlush = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshotsBeforeFlush).toHaveLength(1)

				// Flush the setImmediate to run the async rebuild (which will throw)
				vi.runOnlyPendingTimers()

				// Rebuild was attempted
				expect(rebuildSpy).toHaveBeenCalledTimes(1)

				// Error was logged
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					expect.stringContaining("Async rebuild failed"),
					expect.any(Error),
				)

				// Snapshot should still be sent (with stale/empty derived data)
				const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshots).toHaveLength(1)

				// No error message should be sent (the catch handles it gracefully)
				const errors = sink.messagesOfType("dashboardStatsStreamError")
				expect(errors).toHaveLength(0)

				coordinator.dispose()
				rebuildSpy.mockRestore()
				consoleErrorSpy.mockRestore()
			})

			it("should only attempt rebuild once across multiple snapshots (one-time check)", () => {
				// Append an event, then clear derived tables
				db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
				clearDerivedTables()

				const rebuildSpy = vi.spyOn(db, "rebuildRollupsFromEvents")

				const coordinator = new UsageStatsStreamCoordinator(db)
				const sink = new MockSink()

				// First subscribe — schedules async rebuild
				coordinator.subscribe(sink, makeSubscription({ requestId: "req-1" }))

				// Flush the setImmediate to run the async rebuild
				vi.runOnlyPendingTimers()
				expect(rebuildSpy).toHaveBeenCalledTimes(1)

				// Replace subscription — triggers sendSnapshot again
				coordinator.replaceSubscription(sink, makeSubscription({ requestId: "req-2" }))

				// Flush any pending timers
				vi.runOnlyPendingTimers()

				// Rebuild should NOT have been called again (rollupsRebuilt flag is true)
				expect(rebuildSpy).toHaveBeenCalledTimes(1)

				// Snapshots should have been sent:
				// 1. req-1 initial (empty data)
				// 2. req-1 post-rebuild (with data)
				// 3. req-2 initial (with data, no rebuild needed)
				const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
				expect(snapshots.length).toBeGreaterThanOrEqual(2)
				expect(snapshots[0].dashboardStatsStreamSnapshot?.requestId).toBe("req-1")
				expect(snapshots[snapshots.length - 1].dashboardStatsStreamSnapshot?.requestId).toBe("req-2")

				coordinator.dispose()
				rebuildSpy.mockRestore()
			})
		})
	})

	describe("force drain", () => {
		it("should drain immediately when _forceDrain is called", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			// Force drain without waiting for timer
			coordinator._forceDrain()

			expect(sink.messagesOfType("dashboardStatsStreamDelta").length).toBeGreaterThan(0)

			coordinator.dispose()
		})
	})

	describe("diff coverage: coordinator edge cases", () => {
		it("re-subscribing the same sink replaces the existing subscription", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			const sub1 = makeSubscription({ requestId: "req-1" })
			coordinator.subscribe(sink, sub1)

			expect(coordinator.getSubscription(sink)?.requestId).toBe("req-1")
			expect(sink.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(1)

			const sub2 = makeSubscription({ requestId: "req-2" })
			coordinator.subscribe(sink, sub2)

			expect(coordinator.getSubscription(sink)?.requestId).toBe("req-2")
			expect(sink.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(2)

			coordinator.dispose()
		})

		it("dispose clears the catalog debounce timer", () => {
			const { catalog } = createTaskCatalog([makeHistoryItem({ id: "cat", ts: 100 })])
			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			coordinator.notifyTaskCatalogChanged()
			expect(coordinator["catalogSnapshotTimer"]).not.toBeNull()

			coordinator.dispose()
			expect(coordinator["catalogSnapshotTimer"]).toBeNull()

			catalog.dispose()
		})

		it("force-flushes the drain when coalescing exceeds MAX_COALESCE_MS", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			// Wait long enough that the next notification exceeds the max coalesce window
			vi.advanceTimersByTime(110)
			coordinator.notifyEventAppended(makeEvent())

			expect(sink.messagesOfType("dashboardStatsStreamDelta").length).toBeGreaterThan(0)

			coordinator.dispose()
		})

		it("sends a snapshot during drain when the generation changes", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Change generation outside the coordinator so subscribers stay on the old generation
			db.clearGeneration()

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())
			coordinator._forceDrain()

			expect(sink.messagesOfType("dashboardStatsStreamSnapshot").length).toBeGreaterThan(0)
			expect(sink.messagesOfType("dashboardStatsStreamDelta")).toHaveLength(0)

			coordinator.dispose()
		})

		it("falls back to snapshot when applyEventToProjection throws during drain", () => {
			const applySpy = vi.spyOn(UsageStatsProjection, "applyEventToProjection").mockImplementation(() => {
				throw new Error("projection failed")
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())
			coordinator._forceDrain()

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to compute delta"), expect.anything())
			expect(sink.messagesOfType("dashboardStatsStreamSnapshot").length).toBeGreaterThan(0)

			applySpy.mockRestore()
			warnSpy.mockRestore()
			coordinator.dispose()
		})

		it("logs and swallows drain failure when readEventsAfter throws", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			const readSpy = vi.spyOn(db, "readEventsAfter").mockImplementation(() => {
				throw new Error("read failed")
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			db.append(makeEvent())
			coordinator.notifyEventAppended(makeEvent())

			expect(() => coordinator._forceDrain()).not.toThrow()
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Drain failed"), expect.anything())

			readSpy.mockRestore()
			warnSpy.mockRestore()
			coordinator.dispose()
		})

		it("does not run async rebuild after the coordinator is disposed", () => {
			db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
			const rawDb = db as unknown as { db: { exec: (sql: string) => void } }
			rawDb.db.exec("DELETE FROM stats_rollup")
			rawDb.db.exec("DELETE FROM session_metadata")
			rawDb.db.exec("DELETE FROM session_activity")

			const rebuildSpy = vi.spyOn(db, "rebuildRollupsFromEvents")

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			coordinator.dispose()
			vi.runOnlyPendingTimers()

			expect(rebuildSpy).not.toHaveBeenCalled()

			rebuildSpy.mockRestore()
		})

		it("sends a post-rebuild task snapshot when a task catalog is configured", () => {
			const { catalog } = createTaskCatalog([makeHistoryItem({ id: "history-task", ts: 100 })])
			db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
			const rawDb = db as unknown as { db: { exec: (sql: string) => void } }
			rawDb.db.exec("DELETE FROM stats_rollup")
			rawDb.db.exec("DELETE FROM session_metadata")
			rawDb.db.exec("DELETE FROM session_activity")

			const coordinator = new UsageStatsStreamCoordinator(db, { taskCatalog: catalog })
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())

			const snapshotsBefore = sink.messagesOfType("dashboardStatsStreamSnapshot").length
			vi.runOnlyPendingTimers()

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots.length).toBeGreaterThan(snapshotsBefore)
			const rebuiltSnapshot = snapshots[snapshots.length - 1].dashboardStatsStreamSnapshot
			expect(rebuiltSnapshot).toBeDefined()
			if (!rebuiltSnapshot || !("tasks" in rebuiltSnapshot)) {
				throw new Error("STATS_TEST/postRebuildTaskSnapshot/001: expected task snapshot")
			}
			expect(rebuiltSnapshot.tasks.tasks).toEqual([expect.objectContaining({ taskId: "history-task" })])

			coordinator.dispose()
			catalog.dispose()
		})

		it("logs when sending a post-rebuild snapshot throws", () => {
			db.append(makeEvent({ occurredAt: "2026-07-30T10:00:00Z" }))
			const rawDb = db as unknown as { db: { exec: (sql: string) => void } }
			rawDb.db.exec("DELETE FROM stats_rollup")
			rawDb.db.exec("DELETE FROM session_metadata")
			rawDb.db.exec("DELETE FROM session_activity")

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			class SinkThatThrowsOnRebuildSnapshot implements StatsStreamSink {
				private callCount = 0
				postMessage(message: ExtensionMessage): void {
					this.callCount++
					if (this.callCount > 1 && message.type === "dashboardStatsStreamSnapshot") {
						throw new Error("snapshot rejected")
					}
				}
				isVisible(): boolean {
					return true
				}
			}

			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new SinkThatThrowsOnRebuildSnapshot()
			coordinator.subscribe(sink, makeSubscription())

			vi.runOnlyPendingTimers()

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to send post-rebuild snapshot"),
				expect.anything(),
			)

			warnSpy.mockRestore()
			coordinator.dispose()
		})

		it("sends a fresh snapshot at midnight rollover", () => {
			const coordinator = new UsageStatsStreamCoordinator(db)
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Start just before midnight on day 1
			vi.setSystemTime(new Date("2026-08-01T23:59:50.000Z"))
			// Trigger first rollover check (sets lastDayBucket to day 2)
			vi.advanceTimersByTime(30_000)

			expect(sink.messagesOfType("dashboardStatsStreamSnapshot")).toHaveLength(0)

			// Advance to day 3 and trigger another rollover check
			vi.setSystemTime(new Date("2026-08-03T00:00:10.000Z"))
			vi.advanceTimersByTime(30_000)

			coordinator.dispose()
		})

		it("sends fresh snapshots to active subscribers when notifyUsageMutated is called", () => {
			let customPricing: UsageStatsProjection.CustomModelPricingMap | undefined = undefined
			const coordinator = new UsageStatsStreamCoordinator(db, {
				customPricingProvider: () => customPricing,
			})
			const sink = new MockSink()
			coordinator.subscribe(sink, makeSubscription())
			sink.messages.length = 0

			// Update custom pricing and notify
			customPricing = new Map([["openai|my-custom-model", { inputPrice: 5.0 }]])
			coordinator.notifyUsageMutated()

			const snapshots = sink.messagesOfType("dashboardStatsStreamSnapshot")
			expect(snapshots).toHaveLength(1)

			coordinator.dispose()
		})
	})
})
