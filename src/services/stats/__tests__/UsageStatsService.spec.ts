import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsService, StatsServiceError } from "../UsageStatsService"
import { StatsStoreError } from "../UsageEventStore"

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a temporary directory for testing.
 * Does not touch the actual global storage.
 */
async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "usage-stats-svc-test-")
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
		occurredAt: "2026-07-19T10:00:00.000Z",
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

/**
 * Creates a default StatsQuery.
 */
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
		// Clean up temp directory (test isolation)
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	// ── initialize ──────────────────────────────────────────────────────────

	describe("initialize", () => {
		it("should create the stats directory structure on initialize", async () => {
			const statsDir = path.join(tempDir, "usage-stats")
			const dirExists = await fs
				.access(statsDir)
				.then(() => true)
				.catch(() => false)
			expect(dirExists).toBe(true)
		})

		it("should be idempotent (calling initialize twice does not throw)", async () => {
			// Second call is a no-op
			await expect(service.initialize()).resolves.toBeUndefined()
		})
	})

	// ── queryStats ──────────────────────────────────────────────────────────

	describe("queryStats", () => {
		it("should return empty snapshot when no events exist", async () => {
			const query = makeQuery()
			const result = await service.queryStats(query)

			expect(result.buckets).toHaveLength(0)
			expect(result.totals.events).toBe(0)
			expect(result.coverage.firstEventAt).toBeUndefined()
			expect(result.coverage.lastEventAt).toBeUndefined()
		})

		it("should aggregate events stored via the underlying store", async () => {
			// Cannot directly access the internal store of the service, so inject events via backfill.
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					occurredAt: "2026-07-19T10:00:00.000Z",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "provider" },
						costUsd: { value: 0.01, source: "provider" },
					},
				}),
				makeEvent({
					eventId: "evt-2",
					idempotencyKey: "idem-2",
					occurredAt: "2026-07-19T15:00:00.000Z",
					usage: {
						inputTokens: { value: 2000, source: "provider" },
						outputTokens: { value: 1000, source: "provider" },
						costUsd: { value: 0.02, source: "provider" },
					},
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ groupBy: ["day"] })
			const result = await service.queryStats(query)

			expect(result.totals.events).toBe(2)
			expect(result.totals.inputTokens).toBe(3000)
			expect(result.totals.outputTokens).toBe(1500)
			expect(result.totals.costUsd).toBeCloseTo(0.03, 5)
		})

		it("should pass recordingPaused option through to the snapshot coverage", async () => {
			const query = makeQuery()
			const result = await service.queryStats(query, { recordingPaused: true })

			expect(result.coverage.recordingPaused).toBe(true)
		})

		it("should default recordingPaused to false when not provided", async () => {
			const query = makeQuery()
			const result = await service.queryStats(query)

			expect(result.coverage.recordingPaused).toBe(false)
		})
	})

	// ── exportStats ─────────────────────────────────────────────────────────

	describe("exportStats - JSON", () => {
		it("should export events as JSON with correct schema", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "json")

			expect(typeof result).not.toBe("string")
			const jsonExport = result as {
				exportSchemaVersion: number
				exportedAt: string
				query: StatsQuery
				events: UsageEventV1[]
			}

			expect(jsonExport.exportSchemaVersion).toBe(1)
			expect(jsonExport.exportedAt).toBeTruthy()
			expect(jsonExport.query).toEqual(query)
			expect(jsonExport.events).toHaveLength(2)
		})

		it("should filter events by preset in JSON export", async () => {
			const now = new Date()
			const recentIso = now.toISOString()
			const oldIso = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString()

			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: recentIso }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: oldIso }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "today" })
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			// oldIso is outside the today range, so only 1 remains
			expect(jsonExport.events).toHaveLength(1)
			expect(jsonExport.events[0].eventId).toBe("evt-1")
		})

		it("should exclude cancelled events by default in JSON export", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all", includeCancelled: false })
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			expect(jsonExport.events).toHaveLength(1)
			expect(jsonExport.events[0].status).toBe("completed")
		})

		it("should include cancelled events when includeCancelled is true", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all", includeCancelled: true })
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			expect(jsonExport.events).toHaveLength(2)
		})

		it("should export empty events array when no data exists", async () => {
			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			expect(jsonExport.events).toHaveLength(0)
		})
	})

	describe("exportStats - CSV", () => {
		it("should export events as CSV with header row", async () => {
			const events = [makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")

			expect(typeof result).toBe("string")
			const lines = (result as string).split("\n")
			// header + 1 data row
			expect(lines).toHaveLength(2)
			expect(lines[0]).toContain("eventId")
			expect(lines[0]).toContain("idempotencyKey")
			expect(lines[0]).toContain("occurredAt")
			expect(lines[0]).toContain("provider")
			expect(lines[0]).toContain("model")
			expect(lines[0]).toContain("inputTokens")
			expect(lines[0]).toContain("costUsd")
			expect(lines[0]).toContain("provenance")
		})

		it("should include data values in CSV rows", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: {
						inputTokens: { value: 1500, source: "provider" },
						outputTokens: { value: 750, source: "provider" },
						costUsd: { value: 0.03, source: "provider" },
					},
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]

			expect(dataRow).toContain("evt-1")
			expect(dataRow).toContain("idem-1")
			expect(dataRow).toContain("anthropic")
			expect(dataRow).toContain("claude-sonnet-4-20250514")
			expect(dataRow).toContain("1500")
			expect(dataRow).toContain("750")
			expect(dataRow).toContain("0.03")
		})

		it("should output only header when no events exist", async () => {
			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")

			expect(typeof result).toBe("string")
			const lines = (result as string).split("\n")
			expect(lines).toHaveLength(1)
			expect(lines[0]).toContain("eventId")
		})

		it("should escape formula injection in CSV cells (=, +, -, @ prefixes)", async () => {
			const events = [
				makeEvent({
					eventId: "=evt-injection",
					idempotencyKey: "idem-1",
					provider: "+provider",
					model: "@model",
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]

			// Prevent formula injection: ' prefix
			expect(dataRow).toContain("'=evt-injection")
			expect(dataRow).toContain("'+provider")
			expect(dataRow).toContain("'@model")
		})

		it("should quote cells containing commas", async () => {
			const events = [
				makeEvent({
					eventId: "evt,with,commas",
					idempotencyKey: "idem-1",
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]

			// Quoting when comma is included
			expect(dataRow).toContain('"evt,with,commas"')
		})

		it("should quote cells containing double quotes and escape them", async () => {
			const events = [
				makeEvent({
					eventId: 'evt"with"quotes',
					idempotencyKey: "idem-1",
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const dataRow = lines[1]

			// Quoting + "" escape when " is included
			expect(dataRow).toContain('"evt""with""quotes"')
		})

		it("should output empty cell for missing optional usage fields", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {}, // all usage fields missing
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			// inputTokens column index
			const inputTokensIdx = headerCols.indexOf("inputTokens")
			expect(inputTokensIdx).toBeGreaterThanOrEqual(0)
			expect(dataCols[inputTokensIdx]).toBe("")

			// costUsd column index
			const costUsdIdx = headerCols.indexOf("costUsd")
			expect(costUsdIdx).toBeGreaterThanOrEqual(0)
			expect(dataCols[costUsdIdx]).toBe("")
		})

		it("should output empty cell for missing parentTaskId", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					parentTaskId: undefined,
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			const parentTaskIdIdx = headerCols.indexOf("parentTaskId")
			expect(parentTaskIdIdx).toBeGreaterThanOrEqual(0)
			expect(dataCols[parentTaskIdIdx]).toBe("")
		})

		it("should output parentTaskId value when present", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					parentTaskId: "parent-001",
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			const parentTaskIdIdx = headerCols.indexOf("parentTaskId")
			expect(dataCols[parentTaskIdIdx]).toBe("parent-001")
		})

		it("should output source columns alongside value columns", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					usage: {
						inputTokens: { value: 1000, source: "provider" },
						outputTokens: { value: 500, source: "estimated" },
						costUsd: { value: 0.01, source: "backfilled" },
					},
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			const inputTokensSourceIdx = headerCols.indexOf("inputTokensSource")
			expect(dataCols[inputTokensSourceIdx]).toBe("provider")

			const outputTokensSourceIdx = headerCols.indexOf("outputTokensSource")
			expect(dataCols[outputTokensSourceIdx]).toBe("estimated")

			const costUsdSourceIdx = headerCols.indexOf("costUsdSource")
			expect(dataCols[costUsdSourceIdx]).toBe("backfilled")
		})

		it("should output semantics inclusion columns", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					semantics: {
						cacheReadInInput: "included",
						cacheWriteInInput: "excluded",
						reasoningInOutput: "unknown",
					},
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			const cacheReadInInputIdx = headerCols.indexOf("cacheReadInInput")
			expect(dataCols[cacheReadInInputIdx]).toBe("included")

			const cacheWriteInInputIdx = headerCols.indexOf("cacheWriteInInput")
			expect(dataCols[cacheWriteInInputIdx]).toBe("excluded")

			const reasoningInOutputIdx = headerCols.indexOf("reasoningInOutput")
			expect(dataCols[reasoningInOutputIdx]).toBe("unknown")
		})

		it("should output provenance column", async () => {
			const events = [
				makeEvent({
					eventId: "evt-1",
					idempotencyKey: "idem-1",
					provenance: "live",
				}),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "csv")
			const lines = (result as string).split("\n")
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")

			const provenanceIdx = headerCols.indexOf("provenance")
			expect(dataCols[provenanceIdx]).toBe("history-backfill")
		})
	})

	describe("getFilteredEvents", () => {
		it("should return filtered events without JSON round-trip", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", status: "completed" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", status: "cancelled" }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all", includeCancelled: false })
			const filtered = await service.getFilteredEvents(query)

			expect(filtered).toHaveLength(1)
			expect(filtered[0].eventId).toBe("evt-1")
			// Returned objects should be the same UsageEventV1 instances, not JSON
			// stringified and parsed copies.
			expect(filtered[0]).toBeInstanceOf(Object)
		})
	})

	describe("exportStats - invalid format", () => {
		it("should throw StatsServiceError for unsupported format", async () => {
			const query = makeQuery({ preset: "all" })

			await expect(service.exportStats(query, "xml" as "json" | "csv")).rejects.toThrow(StatsServiceError)
		})

		it("should include error code STATS_SERVICE/export/001 for unsupported format", async () => {
			const query = makeQuery({ preset: "all" })

			try {
				await service.exportStats(query, "xml" as "json" | "csv")
				expect.fail("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(StatsServiceError)
				expect((err as StatsServiceError).code).toBe("STATS_SERVICE/export/001")
			}
		})
	})

	describe("exportStats - time range filtering with explicit from/to", () => {
		it("should filter events by explicit from/to in export", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3", occurredAt: "2026-07-21T10:00:00.000Z" }),
			]
			await service.backfillFromHistory(events)

			const query = makeQuery({
				from: "2026-07-20T00:00:00.000Z",
				to: "2026-07-21T00:00:00.000Z",
			})
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			expect(jsonExport.events).toHaveLength(1)
			expect(jsonExport.events[0].eventId).toBe("evt-2")
		})
	})

	// ── issueClearNonce ─────────────────────────────────────────────────────

	describe("issueClearNonce", () => {
		it("should return a non-empty nonce string", () => {
			const nonce = service.issueClearNonce()

			expect(typeof nonce).toBe("string")
			expect(nonce.length).toBeGreaterThan(0)
		})

		it("should return different nonces on subsequent calls", () => {
			const nonce1 = service.issueClearNonce()
			const nonce2 = service.issueClearNonce()

			expect(nonce1).not.toBe(nonce2)
		})
	})

	// ── clearStats ──────────────────────────────────────────────────────────

	describe("clearStats", () => {
		it("should clear stats when valid nonce is provided", async () => {
			// Inject data
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
			]
			await service.backfillFromHistory(events)

			// Verify before deletion
			const before = await service.queryStats(makeQuery({ preset: "all" }))
			expect(before.totals.events).toBe(2)

			// Issue nonce then clear
			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			// Verify after deletion
			const after = await service.queryStats(makeQuery({ preset: "all" }))
			expect(after.totals.events).toBe(0)
		})

		it("should throw StatsServiceError when nonce is mismatched", async () => {
			service.issueClearNonce()

			await expect(service.clearStats("wrong-nonce")).rejects.toThrow(StatsServiceError)
		})

		it("should include error code STATS_SERVICE/clear/001 for nonce mismatch", async () => {
			service.issueClearNonce()

			try {
				await service.clearStats("wrong-nonce")
				expect.fail("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(StatsServiceError)
				expect((err as StatsServiceError).code).toBe("STATS_SERVICE/clear/001")
			}
		})

		it("should throw StatsServiceError when no nonce was issued", async () => {
			await expect(service.clearStats("any-nonce")).rejects.toThrow(StatsServiceError)
		})

		it("should throw StatsServiceError when nonce has expired", async () => {
			vi.useFakeTimers()

			const nonce = service.issueClearNonce()

			// After 6 minutes (nonce is valid for 5 minutes)
			vi.advanceTimersByTime(6 * 60 * 1000)

			await expect(service.clearStats(nonce)).rejects.toThrow(StatsServiceError)

			vi.useRealTimers()
		})

		it("should include error code STATS_SERVICE/clear/001 for expired nonce", async () => {
			vi.useFakeTimers()

			const nonce = service.issueClearNonce()
			vi.advanceTimersByTime(6 * 60 * 1000)

			try {
				await service.clearStats(nonce)
				expect.fail("should have thrown")
			} catch (err) {
				expect(err).toBeInstanceOf(StatsServiceError)
				expect((err as StatsServiceError).code).toBe("STATS_SERVICE/clear/001")
			}

			vi.useRealTimers()
		})

		it("should consume nonce after successful clear (one-time use)", async () => {
			const events = [makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })]
			await service.backfillFromHistory(events)

			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			// Retry with the same nonce → should fail
			await expect(service.clearStats(nonce)).rejects.toThrow(StatsServiceError)
		})
	})

	// ── backfillFromHistory ──────────────────────────────────────────────────

	describe("backfillFromHistory", () => {
		it("should append events and return the count of appended events", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" }),
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3" }),
			]

			const count = await service.backfillFromHistory(events)
			expect(count).toBe(3)
		})

		it("should set provenance to history-backfill for all events", async () => {
			const events = [makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", provenance: "live" })]

			await service.backfillFromHistory(events)

			const query = makeQuery({ preset: "all" })
			const result = await service.exportStats(query, "json")
			const jsonExport = result as { events: UsageEventV1[] }

			expect(jsonExport.events[0].provenance).toBe("history-backfill")
		})

		it("should return 0 for empty events array", async () => {
			const count = await service.backfillFromHistory([])
			expect(count).toBe(0)
		})

		it("should deduplicate events with same idempotencyKey", async () => {
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-1" }), // Same idempotencyKey
			]

			const count = await service.backfillFromHistory(events)
			expect(count).toBe(1)
		})

		it("should swallow StatsStoreError and continue processing remaining events", async () => {
			// First event is normal, second is deduped with the same idempotencyKey (returns false),
			// third is normal
			const events = [
				makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" }),
				makeEvent({ eventId: "evt-2", idempotencyKey: "idem-1" }), // dedupe → false
				makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3" }),
			]

			const count = await service.backfillFromHistory(events)
			// Deduped ones return false → count does not increment
			expect(count).toBe(2)
		})
	})

	// ── isCapped ────────────────────────────────────────────────────────────

	describe("isCapped", () => {
		it("should return false for a fresh store", () => {
			expect(service.isCapped()).toBe(false)
		})

		it("should return false after appending a small number of events", async () => {
			const events = [makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })]
			await service.backfillFromHistory(events)

			expect(service.isCapped()).toBe(false)
		})
	})

	// ── Error class ─────────────────────────────────────────────────────────

	describe("StatsServiceError", () => {
		it("should format message with error code prefix", () => {
			const err = new StatsServiceError("STATS_SERVICE/export/001", "Unsupported export format: xml")

			expect(err.message).toContain("[STATS_SERVICE/export/001]")
			expect(err.message).toContain("Unsupported export format: xml")
			expect(err.name).toBe("StatsServiceError")
		})

		it("should preserve cause when provided", () => {
			const cause = new Error("root cause")
			const err = new StatsServiceError("STATS_SERVICE/backfill/001", "Backfill failed", cause)

			expect(err.cause).toBe(cause)
		})
	})
})
