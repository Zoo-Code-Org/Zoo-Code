import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"
import { UsageEventStore } from "../UsageEventStore"

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a temporary directory for testing.
 * Does not touch the actual global storage.
 */
async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "usage-stats-test-")
	return fs.mkdtemp(prefix)
}

/**
 * Creates a UsageEventV1 event for testing.
 */
function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: new Date().toISOString(),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageEventStore", () => {
	let tempDir: string
	let store: UsageEventStore

	beforeEach(async () => {
		tempDir = await createTempDir()
		store = new UsageEventStore(tempDir)
		await store.initialize()
	})

	afterEach(async () => {
		// Clean up temp directory (test isolation)
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	describe("initialize", () => {
		it("should create stats directory structure", async () => {
			const statsDir = store._getStatsDir()
			const dirExists = await fs
				.access(statsDir)
				.then(() => true)
				.catch(() => false)
			expect(dirExists).toBe(true)

			const quarantineDir = path.join(statsDir, "quarantine")
			const quarantineExists = await fs
				.access(quarantineDir)
				.then(() => true)
				.catch(() => false)
			expect(quarantineExists).toBe(true)
		})

		it("should create manifest.json on first init", async () => {
			const manifestPath = path.join(store._getStatsDir(), "manifest.json")
			const content = await fs.readFile(manifestPath, "utf-8")
			const manifest = JSON.parse(content)
			expect(manifest.manifestVersion).toBe(1)
			expect(manifest.generation).toBe(1)
			expect(manifest.currentSegment).toBe(1)
		})

		it("should be idempotent (multiple initialize calls)", async () => {
			await store.initialize()
			await store.initialize()
			// should not throw
		})
	})

	describe("append", () => {
		it("should append a valid event", async () => {
			const event = makeEvent()
			const result = await store.append(event)
			expect(result).toBe(true)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
			expect(events[0].eventId).toBe(event.eventId)
		})

		it("should deduplicate by idempotencyKey", async () => {
			const event = makeEvent()
			const result1 = await store.append(event)
			const result2 = await store.append(event)

			expect(result1).toBe(true)
			expect(result2).toBe(false)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
		})

		it("should append multiple different events", async () => {
			const event1 = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })
			const event2 = makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" })
			const event3 = makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3" })

			await store.append(event1)
			await store.append(event2)
			await store.append(event3)

			const events = await store.readAll()
			expect(events).toHaveLength(3)
		})

		it("should persist events to NDJSON file", async () => {
			const event = makeEvent()
			await store.append(event)

			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			const content = await fs.readFile(segmentPath, "utf-8")
			const lines = content.trim().split("\n")
			expect(lines).toHaveLength(1)

			const parsed = JSON.parse(lines[0])
			expect(parsed.eventId).toBe(event.eventId)
		})

		it("should persist optional endpoint field when provided", async () => {
			const event = makeEvent({ endpoint: "kimi.ai" })
			await store.append(event)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
			expect(events[0].endpoint).toBe("kimi.ai")
		})

		it("should not require endpoint field (backward compatible)", async () => {
			const event = makeEvent()
			await store.append(event)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
			expect(events[0].endpoint).toBeUndefined()
		})

		it("should serialize concurrent appends via promise queue", async () => {
			const events = Array.from({ length: 10 }, (_, i) =>
				makeEvent({ eventId: `evt-${i}`, idempotencyKey: `idem-${i}` }),
			)

			const results = await Promise.all(events.map((e) => store.append(e)))
			expect(results.every((r) => r === true)).toBe(true)

			const stored = await store.readAll()
			expect(stored).toHaveLength(10)
		})

		it("should invalidate cache when a segment rotation happens during append", async () => {
			// Force the current segment to be just under the rotation threshold
			// by writing a large payload to the segment file directly.
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			const paddingSize = 5 * 1024 * 1024 // 5 MiB
			const padding = "{" + "a".repeat(paddingSize) + "}\n"
			await fs.writeFile(segmentPath, padding, "utf-8")

			// Prime the cache so the next readAll would return the cached snapshot.
			await store.readAll()

			// Append a valid event. The segment is already at the rotation threshold,
			// so appendInternal will rotate to segment 2. The cache must be
			// invalidated because the cached snapshot no longer reflects the new
			// segment layout.
			const event = makeEvent({ eventId: "evt-rot", idempotencyKey: "idem-rot" })
			const result = await store.append(event)
			expect(result).toBe(true)

			// The next readAll should rescan from disk and include the appended event.
			const stored = await store.readAll()
			expect(stored).toHaveLength(1)
			expect(stored[0].eventId).toBe("evt-rot")
		})
	})

	describe("readAll", () => {
		it("should return empty array when no events", async () => {
			const events = await store.readAll()
			expect(events).toHaveLength(0)
		})

		it("should read all events in order", async () => {
			const event1 = makeEvent({
				eventId: "evt-1",
				idempotencyKey: "idem-1",
				occurredAt: "2026-07-19T10:00:00.000Z",
			})
			const event2 = makeEvent({
				eventId: "evt-2",
				idempotencyKey: "idem-2",
				occurredAt: "2026-07-19T11:00:00.000Z",
			})

			await store.append(event1)
			await store.append(event2)

			const events = await store.readAll()
			expect(events).toHaveLength(2)
			expect(events[0].eventId).toBe("evt-1")
			expect(events[1].eventId).toBe("evt-2")
		})

		it("should quarantine corrupt last line if it ends with newline", async () => {
			const event = makeEvent()
			await store.append(event)

			// Add a corrupt line that ends with \n (fully written, not a crash tail)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, "{invalid json line\n")

			const events = await store.readAll()
			expect(events).toHaveLength(1) // corrupt line is skipped

			const quarantinePath = path.join(store._getStatsDir(), "quarantine", "corrupt-lines.jsonl")
			const quarantineExists = await fs
				.access(quarantinePath)
				.then(() => true)
				.catch(() => false)
			expect(quarantineExists).toBe(true)

			const quarantineContent = await fs.readFile(quarantinePath, "utf-8")
			const quarantineEntries = quarantineContent
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
			expect(quarantineEntries).toHaveLength(1)
			expect(quarantineEntries[0].line).toBe(2)
		})

		it("should quarantine schema-invalid last line if it ends with newline", async () => {
			const event = makeEvent()
			await store.append(event)

			// Add a schema-invalid line ending with \n
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, JSON.stringify({ schemaVersion: 999, invalid: true }) + "\n")

			const events = await store.readAll()
			expect(events).toHaveLength(1)

			const quarantinePath = path.join(store._getStatsDir(), "quarantine", "corrupt-lines.jsonl")
			const quarantineExists = await fs
				.access(quarantinePath)
				.then(() => true)
				.catch(() => false)
			expect(quarantineExists).toBe(true)
		})

		it("should ignore truncated last line (crash tail) without writing quarantine report", async () => {
			const event = makeEvent()
			await store.append(event)

			// Manually add a truncated line (last line, no trailing newline)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, '{"partial": tru') // Truncated JSON without \n

			const events = await store.readAll()
			expect(events).toHaveLength(1) // crash tail is ignored

			const quarantinePath = path.join(store._getStatsDir(), "quarantine", "corrupt-lines.jsonl")
			const quarantineExists = await fs
				.access(quarantinePath)
				.then(() => true)
				.catch(() => false)
			expect(quarantineExists).toBe(false)
		})

		it("should write quarantine report for corrupt lines in the middle", async () => {
			const event = makeEvent()
			await store.append(event)

			// Add a corrupt line in the middle (not the last position)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			const validLine = JSON.stringify(makeEvent({ eventId: "evt-valid", idempotencyKey: "idem-valid" })) + "\n"
			await fs.appendFile(segmentPath, "{corrupt\n")
			await fs.appendFile(segmentPath, validLine)

			await store.readAll()

			const quarantinePath = path.join(store._getStatsDir(), "quarantine", "corrupt-lines.jsonl")
			const quarantineExists = await fs
				.access(quarantinePath)
				.then(() => true)
				.catch(() => false)
			expect(quarantineExists).toBe(true)
		})

		it("should not cache corrupt lines from a crash tail on first readAll", async () => {
			const event = makeEvent({ eventId: "evt-clean", idempotencyKey: "idem-clean" })
			await store.append(event)

			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			// Append a corrupt middle line followed by a valid line, then a truncated
			// crash tail as the very last line. The crash tail should be ignored and
			// must not appear in the cached snapshot on subsequent reads.
			const validLine = JSON.stringify(makeEvent({ eventId: "evt-valid", idempotencyKey: "idem-valid" })) + "\n"
			await fs.appendFile(segmentPath, "{corrupt middle\n")
			await fs.appendFile(segmentPath, validLine)
			await fs.appendFile(segmentPath, '{"partial": tru')

			const firstRead = await store.readAll()
			expect(firstRead).toHaveLength(2)
			expect(firstRead.map((e) => e.eventId)).toContain("evt-clean")
			expect(firstRead.map((e) => e.eventId)).toContain("evt-valid")

			// A second readAll should return the exact same cached snapshot without
			// reintroducing the crash tail or corrupt middle line.
			const secondRead = await store.readAll()
			expect(secondRead).toHaveLength(2)
			expect(secondRead.map((e) => e.eventId)).toEqual(firstRead.map((e) => e.eventId))
		})

		it("should rescan when more segments exist on disk than cached segment count", async () => {
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })
			await store.append(event)

			// Prime the cache.
			await store.readAll()

			// Simulate an external writer (or another process) creating segment 2
			// directly with a valid event.
			const segment2Path = path.join(store._getStatsDir(), "events-000002.ndjson")
			const externalEvent = makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" })
			await fs.writeFile(segment2Path, JSON.stringify(externalEvent) + "\n", "utf-8")

			// The cached snapshot only knew about segment 1. readAll must detect the
			// extra segment and invalidate the cache so the external event is included.
			const events = await store.readAll()
			expect(events).toHaveLength(2)
			expect(events.map((e) => e.eventId)).toContain("evt-1")
			expect(events.map((e) => e.eventId)).toContain("evt-2")
		})
	})

	describe("clear", () => {
		it("should clear all events and increment generation", async () => {
			await store.append(makeEvent({ idempotencyKey: "idem-1" }))
			await store.append(makeEvent({ idempotencyKey: "idem-2" }))

			await store.clear()

			const events = await store.readAll()
			expect(events).toHaveLength(0)

			const manifest = await store.getManifest()
			expect(manifest.generation).toBe(2)
			expect(manifest.currentSegment).toBe(1)
		})

		it("should reset idempotency set after clear", async () => {
			const event = makeEvent({ idempotencyKey: "idem-same" })
			await store.append(event)

			await store.clear()

			// After clear, the same idempotencyKey can be appended again
			const result = await store.append(event)
			expect(result).toBe(true)
		})

		it("should clean up old-generation directory after clear", async () => {
			await store.append(makeEvent())

			await store.clear()

			const oldGenDir = path.join(store._getStatsDir(), "old-generation-1")
			const oldGenExists = await fs
				.access(oldGenDir)
				.then(() => true)
				.catch(() => false)
			expect(oldGenExists).toBe(false)
		})
	})

	describe("idempotency recovery on restart and multi-instance", () => {
		it("should rebuild idempotency set from segment scan on re-init", async () => {
			const event = makeEvent({ idempotencyKey: "idem-persist" })
			await store.append(event)

			// Create a new store instance (simulate restart)
			const newStore = new UsageEventStore(tempDir)
			await newStore.initialize()

			// Attempt to append with the same idempotencyKey → should be deduped
			const result = await newStore.append(event)
			expect(result).toBe(false)
		})

		it("should double-check idempotency across concurrent store instances sharing same directory", async () => {
			const store2 = new UsageEventStore(tempDir)
			await store2.initialize()

			const event = makeEvent({ idempotencyKey: "idem-cross-instance" })

			// First append on store1 succeeds
			const result1 = await store.append(event)
			expect(result1).toBe(true)

			// Second append on store2 with same idempotencyKey is rejected under lock
			const result2 = await store2.append(event)
			expect(result2).toBe(false)

			const events = await store2.readAll()
			expect(events).toHaveLength(1)
		})
	})

	describe("cache invalidation on same-segment append", () => {
		it("should detect external writes to the active segment via stat+mtime", async () => {
			// First append creates segment 1 and warms the cache
			await store.append(makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }))
			const events1 = await store.readAll()
			expect(events1).toHaveLength(1)

			// Simulate another VS Code window appending to the SAME segment file
			// by writing directly to the file (bypassing this store instance).
			const statsDir = store._getStatsDir()
			const segment1Path = path.join(statsDir, "events-000001.ndjson")
			const externalEvent = makeEvent({ eventId: "evt-external", idempotencyKey: "idem-external" })
			await fs.appendFile(segment1Path, JSON.stringify(externalEvent) + "\n", "utf-8")

			// Force a different mtime to ensure the stat check detects the change.
			// Some filesystems have coarse mtime granularity (1s or more).
			const future = new Date(Date.now() + 10000)
			await fs.utimes(segment1Path, future, future)

			// The cache must be invalidated by the stat+mtime check so the
			// external event is included in the next readAll().
			const events2 = await store.readAll()
			expect(events2).toHaveLength(2)
			expect(events2.map((e) => e.eventId)).toContain("evt-1")
			expect(events2.map((e) => e.eventId)).toContain("evt-external")
		})

		it("should return cached events when no external modification occurred", async () => {
			await store.append(makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }))
			const events1 = await store.readAll()
			expect(events1).toHaveLength(1)

			// Second readAll should return the same cached array content
			const events2 = await store.readAll()
			expect(events2).toEqual(events1)
		})
	})

	describe("error handling and hard cap", () => {
		it("should report not capped initially", async () => {
			expect(store.isCapped()).toBe(false)
		})

		it("should not throw on duplicate append (idempotent)", async () => {
			const event = makeEvent()
			await store.append(event)

			// Re-appending the same event is not an error
			await expect(store.append(event)).resolves.toBe(false)
		})

		it("should prospectively reject appends when hard cap would be reached", async () => {
			const TOTAL_MAX_BYTES = 100 * 1024 * 1024 // 100 MiB
			const statsDir = store._getStatsDir()

			// Pre-fill a dummy segment file that puts total size just 50 bytes below 100 MiB
			const dummySegment = path.join(statsDir, "events-000001.ndjson")
			const dummySize = TOTAL_MAX_BYTES - 50
			const buffer = Buffer.alloc(dummySize, " ")
			await fs.writeFile(dummySegment, buffer)

			const event = makeEvent()
			// Appending an event (which serializes to > 100 bytes) must prospectively fail
			await expect(store.append(event)).rejects.toThrow("Storage hard cap (100 MiB) reached")
			expect(store.isCapped()).toBe(true)
		})
	})
})
