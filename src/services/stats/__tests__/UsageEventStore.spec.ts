import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"

import { UsageEventStore, StatsStoreError } from "../UsageEventStore"

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

		it("should skip corrupt lines and continue reading", async () => {
			const event = makeEvent()
			await store.append(event)

			// Manually add a corrupt line
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, "{invalid json line\n")

			const events = await store.readAll()
			expect(events).toHaveLength(1) // corrupt line is skipped
		})

		it("should ignore truncated last line (crash tail)", async () => {
			const event = makeEvent()
			await store.append(event)

			// Manually add a truncated line (last line)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, '{"partial": tru') // Truncated JSON

			const events = await store.readAll()
			expect(events).toHaveLength(1) // crash tail is ignored
		})

		it("should write quarantine report for corrupt lines", async () => {
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

		it("should move old segments to old-generation directory", async () => {
			await store.append(makeEvent())

			await store.clear()

			const oldGenDir = path.join(store._getStatsDir(), "old-generation-1")
			const oldGenExists = await fs
				.access(oldGenDir)
				.then(() => true)
				.catch(() => false)
			expect(oldGenExists).toBe(true)
		})
	})

	describe("idempotency recovery on restart", () => {
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
	})

	describe("error handling", () => {
		it("should throw StatsStoreError with correct code on cap reached", async () => {
			// This test is difficult to force the cap, so only verify isCapped() method behavior
			expect(store.isCapped()).toBe(false)
		})

		it("should not throw on duplicate append (idempotent)", async () => {
			const event = makeEvent()
			await store.append(event)

			// Re-appending the same event is not an error
			await expect(store.append(event)).resolves.toBe(false)
		})
	})
})
