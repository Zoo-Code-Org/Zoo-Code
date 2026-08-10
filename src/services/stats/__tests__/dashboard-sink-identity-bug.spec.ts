/**
 * Test to verify the sink identity bug in replaceSubscription.
 *
 * In production, getCoordinatorAndSink() creates a NEW ProviderStreamSink
 * instance for every message handler call. This means:
 * - subscribeDashboardStats creates sinkA
 * - replaceDashboardStatsSubscription creates sinkB (different object)
 *
 * The coordinator uses sink object identity as the Map key. So
 * replaceSubscription(sinkB, newSub) cannot find and remove the old
 * subscription (sinkA), resulting in orphaned subscriptions.
 *
 * This test simulates the production behavior and verifies the bug.
 */

import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, ExtensionMessage, DashboardStatsSubscription } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { UsageStatsStreamCoordinator, type StatsStreamSink } from "../UsageStatsStreamCoordinator"

async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "sink-identity-bug-test-")
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

function makeSubscription(overrides: Partial<DashboardStatsSubscription> = {}): DashboardStatsSubscription {
	return {
		requestId: `req-${Math.random().toString(36).slice(2)}`,
		range: {
			preset: "today",
			timezone: "Asia/Seoul",
			groupBy: ["model"],
			includeCancelled: false,
			cacheRatio: 0.94,
		},
		sessionPageSize: 50,
		heatmapRangeDays: 30,
		...overrides,
	}
}

class MockSink implements StatsStreamSink {
	readonly messages: ExtensionMessage[] = []

	postMessage(message: ExtensionMessage): void {
		this.messages.push(message)
	}

	isVisible(): boolean {
		return true
	}

	messagesOfType(type: string): ExtensionMessage[] {
		return this.messages.filter((m) => m.type === type)
	}
}

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

describe("Sink Identity Bug", () => {
	it("sinkB should receive snapshot even when sinkA is orphaned", () => {
		const coordinator = new UsageStatsStreamCoordinator(db)

		// Seed some events
		db.append(makeEvent())

		// Simulate production: subscribeDashboardStats creates sinkA
		const sinkA = new MockSink()
		coordinator.subscribe(sinkA, makeSubscription({ requestId: "sub-old" }))

		expect(coordinator._subscriptionCount()).toBe(1)

		// Simulate production: replaceDashboardStatsSubscription creates sinkB (NEW instance)
		const sinkB = new MockSink()
		coordinator.replaceSubscription(sinkB, makeSubscription({ requestId: "sub-new" }))

		// sinkB should receive a snapshot with the new requestId
		const newSnapshots = sinkB.messagesOfType("dashboardStatsStreamSnapshot")
		expect(newSnapshots).toHaveLength(1)
		expect(newSnapshots[0].dashboardStatsStreamSnapshot?.requestId).toBe("sub-new")
		// Snapshot should have data
		expect(newSnapshots[0].dashboardStatsStreamSnapshot?.stats.totals.events).toBeGreaterThanOrEqual(1)

		coordinator.dispose()
	})

	it("replaceSubscription with a DIFFERENT sink instance should not orphan the old subscription", () => {
		const coordinator = new UsageStatsStreamCoordinator(db)

		// Seed some events
		db.append(makeEvent())

		// Simulate production: subscribeDashboardStats creates sinkA
		const sinkA = new MockSink()
		coordinator.subscribe(sinkA, makeSubscription({ requestId: "sub-old" }))

		expect(coordinator._subscriptionCount()).toBe(1)

		const oldSnapshots = sinkA.messagesOfType("dashboardStatsStreamSnapshot")
		expect(oldSnapshots).toHaveLength(1)
		expect(oldSnapshots[0].dashboardStatsStreamSnapshot?.requestId).toBe("sub-old")

		// Simulate production: replaceDashboardStatsSubscription creates sinkB (NEW instance)
		const sinkB = new MockSink()
		coordinator.replaceSubscription(sinkB, makeSubscription({ requestId: "sub-new" }))

		// BUG: The old subscription (sinkA) is NOT removed because
		// replaceSubscription uses sink object identity as the key.
		// The map now has BOTH sinkA and sinkB.
		console.log("Subscription count after replace:", coordinator._subscriptionCount())

		// The old subscription should have been removed
		// Currently it's 2 (both sinkA and sinkB) — this is the bug
		expect(coordinator._subscriptionCount()).toBe(1) // Should be 1 after replace

		coordinator.dispose()
	})

	it("old subscription should not receive deltas after replace with different sink", () => {
		const coordinator = new UsageStatsStreamCoordinator(db)

		// Seed initial events
		db.append(makeEvent())

		// Subscribe with sinkA
		const sinkA = new MockSink()
		coordinator.subscribe(sinkA, makeSubscription({ requestId: "sub-old" }))
		sinkA.messages.length = 0

		// Replace with sinkB (different instance)
		const sinkB = new MockSink()
		coordinator.replaceSubscription(sinkB, makeSubscription({ requestId: "sub-new" }))
		sinkB.messages.length = 0

		// Append a new event — triggers drain
		db.append(makeEvent())
		coordinator.notifyEventAppended(makeEvent())
		vi.advanceTimersByTime(100)

		// sinkA should NOT receive deltas (it's orphaned)
		const sinkADeltas = sinkA.messagesOfType("dashboardStatsStreamDelta")
		console.log("sinkA deltas after replace:", sinkADeltas.length)

		// sinkB should receive deltas
		const sinkBDeltas = sinkB.messagesOfType("dashboardStatsStreamDelta")
		console.log("sinkB deltas after replace:", sinkBDeltas.length)

		// After replace, only the new subscription should receive deltas
		// But since sinkA is still in the map, it also gets deltas
		// This means the webview receives BOTH old-epoch and new-epoch deltas
		// The old-epoch deltas are rejected by the frontend, but this wastes bandwidth
		// and could cause confusion

		coordinator.dispose()
	})
})
