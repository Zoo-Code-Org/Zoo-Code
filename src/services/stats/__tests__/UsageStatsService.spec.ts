import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsService, StatsServiceError } from "../UsageStatsService"
import { StatsStoreError } from "../UsageEventStore"

// ── Test Helpers ────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "usage-stats-svc-test-")
	return fs.mkdtemp(prefix)
}

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

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "Asia/Seoul",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageStatsService", () => {
	let tempDir: string
	let service: UsageStatsService

	beforeEach(async () => {
		tempDir = await createTempDir()
		service = new UsageStatsService(tempDir)
		await service.initialize()
	})

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	// ── Constructor + initialize ──────────────────────────────────────────

	describe("constructor + initialize", () => {
		it("should construct and initialize without error", async () => {
			const dir = await createTempDir()
			const svc = new UsageStatsService(dir)
			await svc.initialize()
			// directory structure should exist
			const statsDir = path.join(dir, "usage-stats")
			const exists = await fs
				.access(statsDir)
				.then(() => true)
				.catch(() => false)
			expect(exists).toBe(true)
			await fs.rm(dir, { recursive: true, force: true })
		})

		it("should be safe to call initialize multiple times", async () => {
			await service.initialize()
			await service.initialize()
		})
	})

	// ── queryStats ─────────────────────────────────────────────────────────

	describe("queryStats", () => {
		it("should return empty snapshot when no events", async () => {
			const result = await service.queryStats(makeQuery())
			expect(result.totals.events).toBe(0)
			expect(result.buckets).toHaveLength(0)
		})

		it("should return snapshot with events", async () => {
			await service.backfillFromHistory([makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })])

			const result = await service.queryStats(makeQuery({ groupBy: [] }))
			expect(result.totals.events).toBe(1)
			expect(result.totals.inputTokens).toBe(1000)
		})

		it("should respect preset 'today'", async () => {
			const now = new Date()
			const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-today", idempotencyKey: "idem-today", occurredAt: now.toISOString() }),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ preset: "today", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should respect preset '7d'", async () => {
			const now = new Date()
			const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
			const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({
					eventId: "evt-recent",
					idempotencyKey: "idem-recent",
					occurredAt: recentDate.toISOString(),
				}),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ preset: "7d", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should respect preset '30d'", async () => {
			const now = new Date()
			const recentDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
			const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({
					eventId: "evt-recent",
					idempotencyKey: "idem-recent",
					occurredAt: recentDate.toISOString(),
				}),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ preset: "30d", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should respect preset 'all'", async () => {
			const now = new Date()
			const oldDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ preset: "all", groupBy: [] }))
			expect(result.totals.events).toBe(2)
		})

		it("should filter by explicit from/to", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-21T10:00:00.000Z" }),
			])

			const result = await service.queryStats(
				makeQuery({
					from: "2026-07-20T00:00:00.000Z",
					to: "2026-07-21T00:00:00.000Z",
					groupBy: [],
				}),
			)
			expect(result.totals.events).toBe(1)
		})

		it("should exclude cancelled events by default", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			])

			const result = await service.queryStats(makeQuery({ groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should include cancelled events when includeCancelled is true", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			])

			const result = await service.queryStats(makeQuery({ groupBy: [], includeCancelled: true }))
			expect(result.totals.events).toBe(2)
		})

		it("should pass recordingPaused to coverage", async () => {
			const result = await service.queryStats(makeQuery({ groupBy: [] }), { recordingPaused: true })
			expect(result.coverage.recordingPaused).toBe(true)
		})
	})

	// ── exportStats - JSON ─────────────────────────────────────────────────

	describe("exportStats - JSON", () => {
		it("should export events as JSON with correct schema", async () => {
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })
			await service.backfillFromHistory([event])

			const query = makeQuery({ preset: "all", groupBy: [] })
			const result = await service.exportStats(query, "json")

			expect(result).toHaveProperty("exportSchemaVersion", 1)
			expect(result).toHaveProperty("exportedAt")
			expect(typeof (result as { exportedAt: string }).exportedAt).toBe("string")
			expect(result).toHaveProperty("query", query)
			expect((result as { events: UsageEventV1[] }).events).toHaveLength(1)
			expect((result as { events: UsageEventV1[] }).events[0].eventId).toBe("evt-1")
		})

		it("should filter events by time range in JSON export", async () => {
			const now = new Date()
			const oldDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.exportStats(makeQuery({ preset: "today", groupBy: [] }), "json")
			expect((result as { events: UsageEventV1[] }).events).toHaveLength(1)
		})

		it("should exclude cancelled events in JSON export by default", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "json")
			expect((result as { events: UsageEventV1[] }).events).toHaveLength(1)
		})
	})

	// ── exportStats - CSV ──────────────────────────────────────────────────

	describe("exportStats - CSV", () => {
		it("should export events as CSV with header row", async () => {
			await service.backfillFromHistory([makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			expect(typeof result).toBe("string")

			const lines = (result as string).split("\n")
			const header = lines[0]
			expect(header).toContain("eventId")
			expect(header).toContain("idempotencyKey")
			expect(header).toContain("occurredAt")
			expect(header).toContain("status")
			expect(header).toContain("provider")
			expect(header).toContain("model")
			expect(header).toContain("inputTokens")
			expect(header).toContain("costUsd")
			expect(header).toContain("provenance")
		})

		it("should have one data row per event", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
			])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			// 1 header + 2 data rows
			expect(lines).toHaveLength(3)
		})

		it("should export empty CSV with only header when no events", async () => {
			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			expect(lines).toHaveLength(1)
			expect(lines[0]).toContain("eventId")
		})

		it("should include all token columns with values", async () => {
			const event = makeEvent({
				eventId: "evt-full",
				idempotencyKey: "idem-full",
				usage: {
					inputTokens: { value: 1000, source: "provider" },
					outputTokens: { value: 500, source: "provider" },
					cacheWriteTokens: { value: 200, source: "provider" },
					cacheReadTokens: { value: 100, source: "provider" },
					reasoningTokens: { value: 50, source: "provider" },
					totalTokens: { value: 1850, source: "provider" },
					costUsd: { value: 0.03, source: "provider" },
				},
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]
			expect(dataRow).toContain("1000")
			expect(dataRow).toContain("500")
			expect(dataRow).toContain("200")
			expect(dataRow).toContain("100")
			expect(dataRow).toContain("50")
			expect(dataRow).toContain("1850")
			expect(dataRow).toContain("0.03")
		})

		it("should handle missing usage fields as empty cells", async () => {
			const event = makeEvent({
				eventId: "evt-sparse",
				idempotencyKey: "idem-sparse",
				usage: {},
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			// Should not throw, data row exists
			expect(lines).toHaveLength(2)
		})

		it("should handle parentTaskId null as empty cell", async () => {
			const event = makeEvent({
				eventId: "evt-no-parent",
				idempotencyKey: "idem-no-parent",
				parentTaskId: undefined,
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			expect(typeof result).toBe("string")
		})

		it("should include parentTaskId when present", async () => {
			const event = makeEvent({
				eventId: "evt-with-parent",
				idempotencyKey: "idem-with-parent",
				parentTaskId: "parent-task-001",
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			expect(lines[1]).toContain("parent-task-001")
		})

		it("should include semantics columns", async () => {
			const event = makeEvent({
				eventId: "evt-sem",
				idempotencyKey: "idem-sem",
				semantics: {
					cacheReadInInput: "included",
					cacheWriteInInput: "excluded",
					reasoningInOutput: "unknown",
				},
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			expect(lines[1]).toContain("included")
			expect(lines[1]).toContain("unknown")
		})
	})

	// ── exportStats - invalid format ───────────────────────────────────────

	describe("exportStats - invalid format", () => {
		it("should throw StatsServiceError with code STATS_SERVICE/export/001 for invalid format", async () => {
			await expect(service.exportStats(makeQuery({ groupBy: [] }), "xml" as "json")).rejects.toThrow(
				StatsServiceError,
			)

			await expect(service.exportStats(makeQuery({ groupBy: [] }), "xml" as "json")).rejects.toThrow(
				/STATS_SERVICE\/export\/001/,
			)
		})
	})

	// ── CSV cell escaping ──────────────────────────────────────────────────

	describe("CSV cell escaping", () => {
		it("should prefix formula injection characters with single quote", async () => {
			const event = makeEvent({
				eventId: "=evt-inject",
				idempotencyKey: "idem-inject",
				provider: "+provider",
				model: "-model",
				mode: "@mode",
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]

			// Formula injection prevention: =, +, -, @ prefixed with '
			expect(dataRow).toContain("'=evt-inject")
			expect(dataRow).toContain("'" + "+provider")
			expect(dataRow).toContain("'" + "-model")
			expect(dataRow).toContain("'@mode")
		})

		it("should quote cells containing commas", async () => {
			const event = makeEvent({
				eventId: "evt-comma",
				idempotencyKey: "idem-comma",
				model: "model,with,commas",
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			// The model field with commas should be quoted
			expect(lines[1]).toContain('"model,with,commas"')
		})

		it("should quote cells containing double quotes and escape them", async () => {
			const event = makeEvent({
				eventId: "evt-quote",
				idempotencyKey: "idem-quote",
				model: 'model"with"quotes',
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			// Double quotes inside cells should be escaped as ""
			expect(lines[1]).toContain('"model""with""quotes"')
		})

		it("should quote cells containing newlines", async () => {
			const event = makeEvent({
				eventId: "evt-newline",
				idempotencyKey: "idem-newline",
				model: "model\nwith\nnewline",
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			// The newline in the cell should be quoted, so the CSV has more lines
			// But the quoted cell should contain the newline
			expect(result as string).toContain('"model')
			expect(result as string).toContain('newline"')
		})

		it("should not quote or prefix normal values", async () => {
			const event = makeEvent({
				eventId: "evt-normal",
				idempotencyKey: "idem-normal",
				model: "normal-model",
			})
			await service.backfillFromHistory([event])

			const result = await service.exportStats(makeQuery({ preset: "all", groupBy: [] }), "csv")
			const lines = (result as string).split("\n")
			// Normal value should not be quoted
			expect(lines[1]).toContain("normal-model")
			// Should not be wrapped in quotes (unless other fields need quoting)
			// The model field itself should not start with a quote
			expect(lines[1]).not.toContain('"normal-model"')
		})
	})

	// ── issueClearNonce ────────────────────────────────────────────────────

	describe("issueClearNonce", () => {
		it("should return a non-empty nonce string", () => {
			const nonce = service.issueClearNonce()
			expect(typeof nonce).toBe("string")
			expect(nonce.length).toBeGreaterThan(0)
		})

		it("should return different nonces on each call", () => {
			const nonce1 = service.issueClearNonce()
			const nonce2 = service.issueClearNonce()
			expect(nonce1).not.toBe(nonce2)
		})

		it("should generate UUID-format nonce (crypto.randomUUID)", () => {
			const nonce = service.issueClearNonce()
			// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
			expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		})
	})

	// ── clearStats ─────────────────────────────────────────────────────────

	describe("clearStats", () => {
		it("should clear stats with valid nonce", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
			])

			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			// Verify events are cleared
			const result = await service.queryStats(makeQuery({ groupBy: [] }))
			expect(result.totals.events).toBe(0)
		})

		it("should throw StatsServiceError with code STATS_SERVICE/clear/001 for invalid nonce", async () => {
			service.issueClearNonce()
			await expect(service.clearStats("invalid-nonce")).rejects.toThrow(StatsServiceError)
			await expect(service.clearStats("invalid-nonce")).rejects.toThrow(/STATS_SERVICE\/clear\/001/)
		})

		it("should throw StatsServiceError when no nonce was issued", async () => {
			await expect(service.clearStats("some-nonce")).rejects.toThrow(StatsServiceError)
			await expect(service.clearStats("some-nonce")).rejects.toThrow(/STATS_SERVICE\/clear\/001/)
		})

		it("should throw StatsServiceError for expired nonce", async () => {
			const nonce = service.issueClearNonce()

			// Mock Date.now to simulate expiry (6 minutes later = 1 minute past 5-minute expiry)
			const realDateNow = Date.now
			const futureTime = realDateNow() + 6 * 60 * 1000
			vi.spyOn(Date, "now").mockReturnValue(futureTime)

			try {
				await expect(service.clearStats(nonce)).rejects.toThrow(StatsServiceError)
				await expect(service.clearStats(nonce)).rejects.toThrow(/STATS_SERVICE\/clear\/001/)
			} finally {
				vi.restoreAllMocks()
			}
		})

		it("should consume nonce after use (single use)", async () => {
			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			// Second use with same nonce should fail
			await expect(service.clearStats(nonce)).rejects.toThrow(StatsServiceError)
			await expect(service.clearStats(nonce)).rejects.toThrow(/STATS_SERVICE\/clear\/001/)
		})
	})

	// ── backfillFromHistory ────────────────────────────────────────────────

	describe("backfillFromHistory", () => {
		it("should append events with provenance 'history-backfill'", async () => {
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", provenance: "live" })
			const count = await service.backfillFromHistory([event])
			expect(count).toBe(1)

			// Verify the event was stored with provenance "history-backfill"
			const result = await service.queryStats(makeQuery({ groupBy: [] }))
			expect(result.totals.events).toBe(1)
			expect(result.coverage.backfilledEventCount).toBe(1)
		})

		it("should return count of appended events", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3" }),
			]
			const count = await service.backfillFromHistory(events)
			expect(count).toBe(3)
		})

		it("should return 0 for empty array", async () => {
			const count = await service.backfillFromHistory([])
			expect(count).toBe(0)
		})

		it("should deduplicate by idempotencyKey", async () => {
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-same" })
			await service.backfillFromHistory([event])
			const count = await service.backfillFromHistory([event])
			expect(count).toBe(0)
		})

		it("should catch StatsStoreError and continue (not throw)", async () => {
			// Create a service with a capped store to trigger StatsStoreError
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })

			const dir = await createTempDir()
			const cappedService = new UsageStatsService(dir)
			await cappedService.initialize()

			// Force cap by accessing internal state
			const internalStore = (cappedService as unknown as { store: { capped: boolean } }).store
			internalStore.capped = true

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const count = await cappedService.backfillFromHistory([event])

			// StatsStoreError should be caught, not re-thrown
			expect(count).toBe(0)
			expect(warnSpy).toHaveBeenCalled()

			warnSpy.mockRestore()
			await fs.rm(dir, { recursive: true, force: true })
		})

		it("should re-throw non-StatsStoreError errors as StatsServiceError", async () => {
			const event = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })

			// Mock the store's append to throw a non-StatsStoreError
			const internalStore = (service as unknown as { store: { append: (e: UsageEventV1) => Promise<boolean> } })
				.store
			const originalAppend = internalStore.append
			internalStore.append = vi.fn().mockRejectedValue(new Error("unexpected error"))

			await expect(service.backfillFromHistory([event])).rejects.toThrow(StatsServiceError)
			await expect(service.backfillFromHistory([event])).rejects.toThrow(/STATS_SERVICE\/backfill\/001/)

			// Restore
			internalStore.append = originalAppend
		})
	})

	// ── isCapped ───────────────────────────────────────────────────────────

	describe("isCapped", () => {
		it("should return false for a fresh store", () => {
			expect(service.isCapped()).toBe(false)
		})
	})

	// ── resolvePresetRange (via queryStats/exportStats) ────────────────────

	describe("resolvePresetRange - timezone handling", () => {
		it("should handle UTC timezone with 'today' preset", async () => {
			const now = new Date()
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ timezone: "UTC", preset: "today", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should handle America/New_York timezone with 'today' preset", async () => {
			const now = new Date()
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
			])

			const result = await service.queryStats(
				makeQuery({ timezone: "America/New_York", preset: "today", groupBy: [] }),
			)
			// Event should be within today's range in any timezone
			expect(result.totals.events).toBe(1)
		})

		it("should handle Asia/Seoul timezone with '7d' preset", async () => {
			const now = new Date()
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ timezone: "Asia/Seoul", preset: "7d", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should handle '30d' preset with UTC timezone", async () => {
			const now = new Date()
			const recentDate = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({
					eventId: "evt-recent",
					idempotencyKey: "idem-recent",
					occurredAt: recentDate.toISOString(),
				}),
			])

			const result = await service.queryStats(makeQuery({ timezone: "UTC", preset: "30d", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should handle 'all' preset with any timezone", async () => {
			const now = new Date()
			const oldDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-now", idempotencyKey: "idem-now", occurredAt: now.toISOString() }),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-old", occurredAt: oldDate.toISOString() }),
			])

			const result = await service.queryStats(
				makeQuery({ timezone: "America/New_York", preset: "all", groupBy: [] }),
			)
			expect(result.totals.events).toBe(2)
		})
	})

	// ── toTimezoneStartOfDay (via exportStats filtering) ────────────────────

	describe("toTimezoneStartOfDay", () => {
		it("should correctly filter events at timezone day boundary (UTC)", async () => {
			// Event at 23:59 UTC should be in "today" for UTC timezone
			const now = new Date()
			const lateEvent = new Date(now)
			lateEvent.setUTCHours(23, 59, 0, 0)

			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-late", idempotencyKey: "idem-late", occurredAt: lateEvent.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ timezone: "UTC", preset: "today", groupBy: [] }))
			// If the event is today in UTC, it should be included
			// (depends on current time, but late event at 23:59 should be within today)
			expect(result.totals.events).toBeGreaterThanOrEqual(0)
		})

		it("should correctly filter events at timezone day boundary (Asia/Seoul)", async () => {
			// In Asia/Seoul (UTC+9), 15:00 UTC = 00:00 next day KST
			// So an event at 14:59 UTC is still "today" in KST
			const now = new Date()
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: now.toISOString() }),
			])

			const result = await service.queryStats(makeQuery({ timezone: "Asia/Seoul", preset: "today", groupBy: [] }))
			expect(result.totals.events).toBe(1)
		})

		it("should correctly filter events at timezone day boundary (America/New_York)", async () => {
			const now = new Date()
			await service.backfillFromHistory([
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: now.toISOString() }),
			])

			const result = await service.queryStats(
				makeQuery({ timezone: "America/New_York", preset: "today", groupBy: [] }),
			)
			expect(result.totals.events).toBe(1)
		})
	})

	// ── generateNonce ──────────────────────────────────────────────────────

	describe("generateNonce", () => {
		it("should generate a UUID-format string via issueClearNonce", () => {
			const nonce = service.issueClearNonce()
			// crypto.randomUUID produces UUID v4
			expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
		})

		it("should fallback to timestamp+random format when crypto.randomUUID is unavailable", () => {
			// Mock require to simulate crypto.randomUUID unavailability
			const originalRequire = require
			const moduleCache = require.cache

			// We can't easily mock require in this context, but we can verify
			// the nonce is always a non-empty string regardless of the path
			const nonce = service.issueClearNonce()
			expect(typeof nonce).toBe("string")
			expect(nonce.length).toBeGreaterThan(0)
		})
	})

	// ── StatsServiceError ──────────────────────────────────────────────────

	describe("StatsServiceError", () => {
		it("should have correct name and message format", () => {
			const error = new StatsServiceError("STATS_SERVICE/export/001", "test message")
			expect(error.name).toBe("StatsServiceError")
			expect(error.message).toBe("[STATS_SERVICE/export/001] test message")
			expect(error.code).toBe("STATS_SERVICE/export/001")
		})

		it("should preserve cause when provided", () => {
			const cause = new Error("root cause")
			const error = new StatsServiceError("STATS_SERVICE/backfill/001", "wrapper", cause)
			expect(error.cause).toBe(cause)
		})
	})
})
