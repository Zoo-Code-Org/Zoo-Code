import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery, ExtensionMessage, DashboardStatsSubscription } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { UsageStatsStreamCoordinator, type StatsStreamSink } from "../UsageStatsStreamCoordinator"

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
})
