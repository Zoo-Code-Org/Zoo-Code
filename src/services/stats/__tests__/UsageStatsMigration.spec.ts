import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"

import { UsageStatsDatabase } from "../UsageStatsDatabase"
import { UsageStatsMigration } from "../UsageStatsMigration"

// ── Test Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
	const prefix = path.join(os.tmpdir(), "usage-stats-migration-test-")
	return fs.mkdtempSync(prefix)
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

/**
 * Writes events to an NDJSON segment file in the stats directory.
 */
function writeSegment(statsDir: string, segmentName: string, events: UsageEventV1[]): void {
	const segmentPath = path.join(statsDir, segmentName)
	const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
	fs.writeFileSync(segmentPath, lines, "utf-8")
}

/**
 * Writes events to a segment file with a specific number of lines,
 * some of which may be corrupt.
 */
function writeSegmentWithCorruption(
	statsDir: string,
	segmentName: string,
	events: UsageEventV1[],
	corruptLines: string[],
): void {
	const segmentPath = path.join(statsDir, segmentName)
	const validLines = events.map((e) => JSON.stringify(e))
	const allLines = [...validLines, ...corruptLines]
	fs.writeFileSync(segmentPath, allLines.join("\n") + "\n", "utf-8")
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageStatsMigration", () => {
	let tempDir: string
	let statsDir: string
	let db: UsageStatsDatabase
	let migration: UsageStatsMigration

	beforeEach(() => {
		tempDir = createTempDir()
		statsDir = path.join(tempDir, "usage-stats")
		fs.mkdirSync(statsDir, { recursive: true })

		db = new UsageStatsDatabase(statsDir)
		db.initialize()
		migration = new UsageStatsMigration(statsDir, db)
	})

	afterEach(() => {
		db.close()
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	describe("migrate (basic)", () => {
		it("should migrate events from a single segment file", () => {
			const events: UsageEventV1[] = []
			for (let i = 0; i < 10; i++) {
				events.push(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
						taskId: `task-${i % 3}`,
						rootTaskId: `task-${i % 3}`,
					}),
				)
			}

			writeSegment(statsDir, "events-000001.ndjson", events)

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(10)
			expect(result.totalSkipped).toBe(0)

			// Verify events are in the database
			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(10)
		})

		it("should migrate events from multiple segment files", () => {
			const events1: UsageEventV1[] = []
			const events2: UsageEventV1[] = []

			for (let i = 0; i < 5; i++) {
				events1.push(makeEvent({ eventId: `e1-${i}`, idempotencyKey: `k1-${i}` }))
				events2.push(makeEvent({ eventId: `e2-${i}`, idempotencyKey: `k2-${i}` }))
			}

			writeSegment(statsDir, "events-000001.ndjson", events1)
			writeSegment(statsDir, "events-000002.ndjson", events2)

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(10)

			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(10)
		})

		it("should handle empty stats directory (no segments)", () => {
			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(0)
		})

		it("flips the legacy inverted timezone_offset sign for NDJSON-sourced events", () => {
			// Pre-fix recorder stored getTimezoneOffset() directly: minutes WEST
			// of UTC, i.e. -540 for KST (UTC+9). The v4 SQLite migration flips
			// rows already in the database; NDJSON-sourced rows must receive the
			// same correction during migration.
			writeSegment(statsDir, "events-000001.ndjson", [
				makeEvent({
					eventId: "evt-legacy",
					idempotencyKey: "idem-legacy",
					timezoneOffsetMinutes: -540,
				}),
			])

			const result = migration.migrate()

			expect(result.totalMigrated).toBe(1)
			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(1)
			expect(dbEvents[0].timezoneOffsetMinutes).toBe(540)
		})

		it("does not double-flip events that were already dual-written to SQLite", () => {
			// Post-fix events are appended to SQLite by UsageEventStore at write
			// time (correct sign, +540 for KST). Their NDJSON lines are skipped
			// by INSERT OR IGNORE, so the in-memory flip never persists.
			const dualWritten = makeEvent({
				eventId: "evt-dual",
				idempotencyKey: "idem-dual",
				timezoneOffsetMinutes: 540,
			})
			db.append(dualWritten)

			writeSegment(statsDir, "events-000001.ndjson", [dualWritten])

			const result = migration.migrate()

			expect(result.totalMigrated).toBe(0)
			expect(result.totalSkipped).toBe(1)
			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(1)
			expect(dbEvents[0].timezoneOffsetMinutes).toBe(540)
		})
	})

	describe("idempotency", () => {
		it("should not duplicate events on re-migration", () => {
			const events: UsageEventV1[] = []
			for (let i = 0; i < 10; i++) {
				events.push(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
					}),
				)
			}

			writeSegment(statsDir, "events-000001.ndjson", events)

			// First migration
			const result1 = migration.migrate()
			expect(result1.totalMigrated).toBe(10)

			// Second migration (should be a no-op since already complete)
			const migration2 = new UsageStatsMigration(statsDir, db)
			const result2 = migration2.migrate()

			expect(result2.complete).toBe(true)
			expect(result2.totalMigrated).toBe(0)
			expect(result2.totalSkipped).toBe(0)

			// Database should still have exactly 10 events
			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(10)
		})
	})

	describe("migration restart after interruption", () => {
		it("should resume from checkpoint after interruption", () => {
			// Create 2500 events (exceeds batch size of 1000)
			const events: UsageEventV1[] = []
			for (let i = 0; i < 2500; i++) {
				events.push(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
						taskId: `task-${i % 5}`,
						rootTaskId: `task-${i % 5}`,
					}),
				)
			}

			writeSegment(statsDir, "events-000001.ndjson", events)

			// Simulate partial migration: first migrate the first 1000 events
			db.bulkAppend(events.slice(0, 1000))

			// Set checkpoint at line 1000 (as if migration was interrupted)
			db.setMigrationCheckpoint({
				lastSegment: "events-000001.ndjson",
				lastLine: 1000,
				eventsMigrated: 1000,
				complete: false,
			})

			// Resume migration
			const result = migration.migrate()

			expect(result.complete).toBe(true)
			// totalMigrated is cumulative from checkpoint (1000 already + 1500 new = 2500)
			expect(result.totalMigrated).toBe(2500)

			// Database should have all 2500 events
			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(2500)
		}, 60000)

		it("should handle checkpoint at segment boundary", () => {
			const events1: UsageEventV1[] = []
			const events2: UsageEventV1[] = []

			for (let i = 0; i < 5; i++) {
				events1.push(makeEvent({ eventId: `e1-${i}`, idempotencyKey: `k1-${i}` }))
				events2.push(makeEvent({ eventId: `e2-${i}`, idempotencyKey: `k2-${i}` }))
			}

			writeSegment(statsDir, "events-000001.ndjson", events1)
			writeSegment(statsDir, "events-000002.ndjson", events2)

			// Simulate checkpoint at end of first segment (first 5 already migrated)
			db.bulkAppend(events1)
			db.setMigrationCheckpoint({
				lastSegment: "events-000001.ndjson",
				lastLine: 5,
				eventsMigrated: 5,
				complete: false,
			})

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			// totalMigrated is cumulative from checkpoint (5 already + 5 new = 10)
			expect(result.totalMigrated).toBe(10)

			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(10)
		})
	})

	describe("corruption detection", () => {
		it("should skip corrupt lines during migration", () => {
			const validEvents: UsageEventV1[] = []
			for (let i = 0; i < 5; i++) {
				validEvents.push(
					makeEvent({
						eventId: `evt-${i}`,
						idempotencyKey: `idem-${i}`,
					}),
				)
			}

			const corruptLines = ["this is not valid json", '{"invalid": "schema"}', ""]

			writeSegmentWithCorruption(statsDir, "events-000001.ndjson", validEvents, corruptLines)

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(5)

			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(5)
		})
	})

	describe("legacy parent chain resolution", () => {
		it("should resolve root task ID for events without rootTaskId", () => {
			// Create events with parent chain: task-C → task-B → task-A (root)
			const events: UsageEventV1[] = [
				makeEvent({
					eventId: "evt-A",
					idempotencyKey: "idem-A",
					taskId: "task-A",
					// No parentTaskId — this is the root
				}),
				makeEvent({
					eventId: "evt-B",
					idempotencyKey: "idem-B",
					taskId: "task-B",
					parentTaskId: "task-A",
				}),
				makeEvent({
					eventId: "evt-C",
					idempotencyKey: "idem-C",
					taskId: "task-C",
					parentTaskId: "task-B",
				}),
			]

			writeSegment(statsDir, "events-000001.ndjson", events)

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(3)

			// All events should be grouped under task-A
			const sessions = db.querySessions(50)
			expect(sessions.sessions).toHaveLength(1)
			expect(sessions.sessions[0].rootTaskId).toBe("task-A")
			expect(sessions.sessions[0].eventCount).toBe(3)
		})

		it("should handle cyclic parent chains without infinite loop", () => {
			// Create a cycle: task-A → task-B → task-A
			const events: UsageEventV1[] = [
				makeEvent({
					eventId: "evt-A",
					idempotencyKey: "idem-A",
					taskId: "task-A",
					parentTaskId: "task-B",
				}),
				makeEvent({
					eventId: "evt-B",
					idempotencyKey: "idem-B",
					taskId: "task-B",
					parentTaskId: "task-A",
				}),
			]

			writeSegment(statsDir, "events-000001.ndjson", events)

			// Should not hang
			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(2)

			// Should have sessions (root resolution terminates via cycle guard)
			const sessions = db.querySessions(50)
			expect(sessions.sessions.length).toBeGreaterThanOrEqual(1)
		})

		it("should handle missing parent gracefully", () => {
			const events: UsageEventV1[] = [
				makeEvent({
					eventId: "evt-orphan",
					idempotencyKey: "idem-orphan",
					taskId: "task-orphan",
					parentTaskId: "task-nonexistent",
				}),
			]

			writeSegment(statsDir, "events-000001.ndjson", events)

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(1)

			// Should fall back to the event's own taskId as root
			const sessions = db.querySessions(50)
			expect(sessions.sessions).toHaveLength(1)
			expect(sessions.sessions[0].rootTaskId).toBe("task-orphan")
		})
	})

	describe("privacy preservation", () => {
		it("should not include prompt, response, API key, or workspace path", () => {
			const event = makeEvent({
				eventId: "evt-privacy",
				idempotencyKey: "idem-privacy",
			})

			// Add extra fields that should NOT be in the schema
			const rawEvent = {
				...event,
				prompt: "secret prompt",
				response: "secret response",
				apiKey: "sk-xxx",
				workspacePath: "/home/user/secret",
			}

			writeSegment(statsDir, "events-000001.ndjson", [rawEvent as unknown as UsageEventV1])

			const result = migration.migrate()

			expect(result.complete).toBe(true)
			expect(result.totalMigrated).toBe(1)

			const dbEvents = db.readAllEvents()
			expect(dbEvents).toHaveLength(1)

			// Verify no sensitive fields leaked
			const eventJson = JSON.stringify(dbEvents[0])
			expect(eventJson).not.toContain("secret prompt")
			expect(eventJson).not.toContain("secret response")
			expect(eventJson).not.toContain("sk-xxx")
			expect(eventJson).not.toContain("/home/user/secret")
		})
	})

	describe("does not delete legacy segments", () => {
		it("should leave NDJSON segment files intact after migration", () => {
			const events: UsageEventV1[] = []
			for (let i = 0; i < 5; i++) {
				events.push(makeEvent({ eventId: `evt-${i}`, idempotencyKey: `idem-${i}` }))
			}

			writeSegment(statsDir, "events-000001.ndjson", events)

			migration.migrate()

			// Segment file should still exist
			const segmentPath = path.join(statsDir, "events-000001.ndjson")
			expect(fs.existsSync(segmentPath)).toBe(true)
		})
	})

	describe("checkpoint management", () => {
		it("should mark migration as complete after full migration", () => {
			writeSegment(statsDir, "events-000001.ndjson", [makeEvent()])

			migration.migrate()

			const checkpoint = migration.getCheckpoint()
			expect(checkpoint.complete).toBe(true)
		})

		it("should report incomplete checkpoint during partial migration", () => {
			// Set up a partial checkpoint
			db.setMigrationCheckpoint({
				lastSegment: "",
				lastLine: 0,
				eventsMigrated: 0,
				complete: false,
			})

			expect(migration.isComplete()).toBe(false)
		})
	})
})
