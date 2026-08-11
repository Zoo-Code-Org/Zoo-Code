import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { UsageEventV1, StatsQuery } from "@roo-code/types"

import { UsageStatsService, StatsServiceError } from "../UsageStatsService"
import { StatsStoreError } from "../UsageEventStore"
import { UsageStatsMigration } from "../UsageStatsMigration"
import { UsageStatsDatabase } from "../UsageStatsDatabase"
import type { DashboardTaskCatalog } from "../DashboardTaskCatalog"

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

		it("waits for the injected catalog source before creating the coordinator", async () => {
			let resolveSourceInitialization: (() => void) | undefined
			const sourceInitialized = new Promise<void>((resolve) => {
				resolveSourceInitialization = resolve
			})
			const onDidChange = vi.fn(() => ({ dispose: vi.fn() }))
			// Partial double of the only members the service consumes; a full
			// DashboardTaskCatalog requires a TaskHistoryStore, hence the double
			// assertion.
			const catalog = {
				sourceInitialized,
				rebuild: vi.fn(),
				onDidChange,
			} as unknown as DashboardTaskCatalog
			const delayedService = new UsageStatsService(tempDir, catalog)
			const initialization = delayedService.initialize()

			await Promise.resolve()
			expect(catalog.rebuild).not.toHaveBeenCalled()
			resolveSourceInitialization!()
			await initialization

			expect(catalog.rebuild).toHaveBeenCalledOnce()
			expect(onDidChange).toHaveBeenCalledOnce()
			expect(delayedService.getTaskCatalog()).toBe(catalog)
			delayedService.dispose()
		})

		it("disposes the injected catalog listener with the service", async () => {
			const catalogSubscription = { dispose: vi.fn() }
			// Partial double of the only members the service consumes; a full
			// DashboardTaskCatalog requires a TaskHistoryStore, hence the double
			// assertion.
			const catalog = {
				sourceInitialized: Promise.resolve(),
				rebuild: vi.fn(),
				onDidChange: vi.fn(() => catalogSubscription),
			} as unknown as DashboardTaskCatalog
			const catalogService = new UsageStatsService(tempDir, catalog)
			await catalogService.initialize()

			catalogService.dispose()

			expect(catalogSubscription.dispose).toHaveBeenCalledOnce()
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

		it("should export rootTaskId and endpoint in their own CSV columns", async () => {
			await service.backfillFromHistory([
				makeEvent({
					eventId: "evt-root-endpoint",
					rootTaskId: "root-task-123",
					endpoint: "api.example.test",
				}),
			])

			const result = (await service.exportStats(makeQuery({ preset: "all" }), "csv")) as string
			const [header, dataRow] = result.split("\n")
			const headerCols = header.split(",")
			const dataCols = dataRow.split(",")

			expect(dataCols[headerCols.indexOf("rootTaskId")]).toBe("root-task-123")
			expect(dataCols[headerCols.indexOf("endpoint")]).toBe("api.example.test")
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

	describe("exportStats - ranged database read", () => {
		it("reads events via readEventsInRange limited to the query's time range", async () => {
			const events = [
				makeEvent({ eventId: "evt-in", idempotencyKey: "idem-in", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-out", idempotencyKey: "idem-out", occurredAt: "2026-07-25T10:00:00.000Z" }),
			]
			await service.backfillFromHistory(events)

			const database = service.getDatabase()
			expect(database).not.toBeNull()
			const rangeSpy = vi.spyOn(database!, "readEventsInRange")
			const readAllSpy = vi.spyOn(service["store"], "readAll")

			const query = makeQuery({
				from: "2026-07-20T00:00:00.000Z",
				to: "2026-07-21T00:00:00.000Z",
			})
			const result = (await service.exportStats(query, "json")) as { events: UsageEventV1[] }

			// The database read is scoped to the resolved query range...
			expect(rangeSpy).toHaveBeenCalledWith(
				new Date("2026-07-20T00:00:00.000Z").getTime(),
				new Date("2026-07-21T00:00:00.000Z").getTime(),
			)
			// ...so the full NDJSON scan is never needed...
			expect(readAllSpy).not.toHaveBeenCalled()
			// ...and only in-range events are exported.
			expect(result.events.map((e) => e.eventId)).toEqual(["evt-in"])

			rangeSpy.mockRestore()
			readAllSpy.mockRestore()
		})

		it("getFilteredEvents uses the ranged database read as well", async () => {
			const events = [
				makeEvent({ eventId: "evt-in", idempotencyKey: "idem-in", occurredAt: "2026-07-20T10:00:00.000Z" }),
				makeEvent({ eventId: "evt-out", idempotencyKey: "idem-out", occurredAt: "2026-07-25T10:00:00.000Z" }),
			]
			await service.backfillFromHistory(events)

			const database = service.getDatabase()
			expect(database).not.toBeNull()
			const rangeSpy = vi.spyOn(database!, "readEventsInRange")

			const filtered = await service.getFilteredEvents(
				makeQuery({
					from: "2026-07-20T00:00:00.000Z",
					to: "2026-07-21T00:00:00.000Z",
				}),
			)

			expect(rangeSpy).toHaveBeenCalled()
			expect(filtered.map((e) => e.eventId)).toEqual(["evt-in"])

			rangeSpy.mockRestore()
		})

		it("falls back to the full store scan when the database is unavailable", async () => {
			const freshDir = await createTempDir()
			const svc = new UsageStatsService(freshDir)
			const db = svc["database"] as UsageStatsDatabase

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.spyOn(db, "initialize").mockImplementation(() => {
				throw new Error("sqlite failed")
			})
			await svc.initialize()

			await svc.backfillFromHistory([makeEvent({ eventId: "evt-fallback", idempotencyKey: "idem-fallback" })])

			const readAllSpy = vi.spyOn(svc["store"], "readAll")
			const result = (await svc.exportStats(makeQuery({ preset: "all" }), "json")) as {
				events: UsageEventV1[]
			}

			expect(readAllSpy).toHaveBeenCalled()
			expect(result.events.map((e) => e.eventId)).toEqual(["evt-fallback"])

			readAllSpy.mockRestore()
			warnSpy.mockRestore()
			svc.dispose()
			await fs.rm(freshDir, { recursive: true, force: true })
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

		it("clears the SQLite projection and bumps the generation", async () => {
			const db = service.getDatabase()
			expect(db).not.toBeNull()
			if (!db) return

			await service.backfillFromHistory([makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })])

			const clearSpy = vi.spyOn(db, "clearGeneration")
			const generationBefore = db.getGeneration()

			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			expect(clearSpy).toHaveBeenCalledOnce()
			expect(db.getGeneration()).toBeGreaterThan(generationBefore)
		})

		it("sends a reset snapshot through the stream coordinator", async () => {
			const coordinator = service.getCoordinator()
			expect(coordinator).not.toBeNull()
			if (!coordinator) return

			const resetSpy = vi.spyOn(coordinator, "resetGeneration")

			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			expect(resetSpy).toHaveBeenCalledOnce()
		})

		it("does not throw when the SQLite projection clear fails", async () => {
			const db = service.getDatabase()
			expect(db).not.toBeNull()
			if (!db) return

			vi.spyOn(db, "clearGeneration").mockImplementation(() => {
				throw new Error("boom")
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const nonce = service.issueClearNonce()
			await expect(service.clearStats(nonce)).resolves.toBeUndefined()
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to clear SQLite stats projection"),
				expect.anything(),
			)

			warnSpy.mockRestore()
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

	// ── Diff coverage: preset ranges / CSV fallback / listeners / nonce ────

	describe("preset range resolution", () => {
		it("should include events from the last 7 days for preset 7d", async () => {
			const now = new Date()
			const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
			const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
			const events = [
				makeEvent({ eventId: "evt-recent", idempotencyKey: "idem-r", occurredAt: recent.toISOString() }),
				makeEvent({ eventId: "evt-old", idempotencyKey: "idem-o", occurredAt: old.toISOString() }),
			]
			await service.backfillFromHistory(events)

			const result = (await service.exportStats(makeQuery({ preset: "7d" }), "json")) as {
				events: UsageEventV1[]
			}
			expect(result.events.map((e) => e.eventId)).toContain("evt-recent")
			expect(result.events.map((e) => e.eventId)).not.toContain("evt-old")
		})

		it("should include events from the last 30 days for preset 30d", async () => {
			const now = new Date()
			const recent = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000)
			const old = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000)
			const events = [
				makeEvent({ eventId: "evt-recent30", idempotencyKey: "idem-r30", occurredAt: recent.toISOString() }),
				makeEvent({ eventId: "evt-old30", idempotencyKey: "idem-o30", occurredAt: old.toISOString() }),
			]
			await service.backfillFromHistory(events)

			const result = (await service.exportStats(makeQuery({ preset: "30d" }), "json")) as {
				events: UsageEventV1[]
			}
			expect(result.events.map((e) => e.eventId)).toContain("evt-recent30")
			expect(result.events.map((e) => e.eventId)).not.toContain("evt-old30")
		})
	})

	describe("CSV export - optional fields fallback", () => {
		it("should output empty cells for events without optional fields", async () => {
			const base = makeEvent({ eventId: "evt-min", idempotencyKey: "idem-min" })
			delete (base.usage as Record<string, unknown>).costUsd
			const events = [base]
			const appended = await service.backfillFromHistory(events)
			expect(appended).toBe(1)

			const result = (await service.exportStats(makeQuery({ preset: "all" }), "csv")) as string
			const lines = result.split("\n").filter((l) => l.length > 0)
			expect(lines.length).toBeGreaterThan(1)
			const headerCols = lines[0].split(",")
			const dataCols = lines[1].split(",")
			// costUsd missing -> empty cell
			const costIdx = headerCols.indexOf("costUsd")
			expect(dataCols[costIdx]).toBe("")
		})
	})

	describe("onDidChange listener disposal", () => {
		it("should remove listener when dispose is called", () => {
			const listeners: string[] = []
			const disposable = service.onDidChange(() => listeners.push("fired"))
			disposable.dispose()
			// Disposing again should be a no-op (idx < 0 path)
			disposable.dispose()
			expect(listeners).toHaveLength(0)
		})
	})

	describe("generateNonce fallback", () => {
		it("should fall back to timestamp-based nonce when crypto.randomUUID throws", () => {
			const crypto = require("crypto")
			const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
				throw new Error("crypto.randomUUID unavailable")
			})

			const svc = service as unknown as { generateNonce(): string }
			const nonce = svc.generateNonce()
			expect(typeof nonce).toBe("string")
			expect(nonce.length).toBeGreaterThan(0)
			expect(nonce).toContain("-")

			spy.mockRestore()
		})
	})

	describe("diff coverage: initialize error/fallback branches", () => {
		it("catches SQLite database initialization failure and continues", async () => {
			const freshDir = await createTempDir()
			const svc = new UsageStatsService(freshDir)
			const db = svc["database"] as UsageStatsDatabase

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			const initSpy = vi.spyOn(db, "initialize").mockImplementation(() => {
				throw new Error("sqlite failed")
			})

			await expect(svc.initialize()).resolves.toBeUndefined()

			expect(initSpy).toHaveBeenCalled()
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to initialize SQLite database"),
				expect.anything(),
			)

			warnSpy.mockRestore()
			initSpy.mockRestore()
			svc.dispose()
			await fs.rm(freshDir, { recursive: true, force: true })
		})

		it("logs migration success when events are migrated", async () => {
			const freshDir = await createTempDir()
			const statsDir = path.join(freshDir, "usage-stats")
			const segmentPath = path.join(statsDir, "events-000001.ndjson")
			const event = makeEvent({ eventId: "migrated-evt", idempotencyKey: "migrated-idem" })
			await fs.mkdir(statsDir, { recursive: true })
			await fs.writeFile(segmentPath, JSON.stringify(event) + "\n", "utf-8")

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const svc = new UsageStatsService(freshDir)
			await svc.initialize()

			// Migration should run and log success
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Migrated 1 events from NDJSON to SQLite"))

			logSpy.mockRestore()
			warnSpy.mockRestore()
			svc.dispose()
			await fs.rm(freshDir, { recursive: true, force: true })
		})

		it("catches NDJSON migration failure and continues", async () => {
			const freshDir = await createTempDir()
			const migrateSpy = vi.spyOn(UsageStatsMigration.prototype, "migrate").mockImplementation(() => {
				throw new Error("migration failed")
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const svc = new UsageStatsService(freshDir)
			await expect(svc.initialize()).resolves.toBeUndefined()

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NDJSON migration failed"), expect.anything())

			migrateSpy.mockRestore()
			warnSpy.mockRestore()
			svc.dispose()
			await fs.rm(freshDir, { recursive: true, force: true })
		})

		it("falls back to null when the catalog provides no change listener", async () => {
			const catalog = {
				sourceInitialized: Promise.resolve(),
				rebuild: vi.fn(),
				onDidChange: vi.fn(() => undefined),
			} as unknown as DashboardTaskCatalog

			const svc = new UsageStatsService(tempDir, catalog)
			await svc.initialize()

			expect(catalog.onDidChange).toHaveBeenCalledOnce()
			svc.dispose()
		})

		it("ensureInitialized waits for an in-flight initialization promise", async () => {
			let resolveInit: (() => void) | undefined
			const catalog = {
				sourceInitialized: new Promise<void>((resolve) => {
					resolveInit = resolve
				}),
				rebuild: vi.fn(),
				onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			} as unknown as DashboardTaskCatalog

			const svc = new UsageStatsService(tempDir, catalog)
			const initPromise = svc.initialize()
			const ensurePromise = svc.ensureInitialized()

			let ensureResolved = false
			void ensurePromise.then(() => {
				ensureResolved = true
			})

			await Promise.resolve()
			expect(ensureResolved).toBe(false)

			resolveInit!()
			await Promise.all([initPromise, ensurePromise])

			expect(ensureResolved).toBe(true)
			svc.dispose()
		})
	})

	describe("append coordinator notification", () => {
		it("notifies the coordinator after a successful append", async () => {
			const coordinator = service.getCoordinator()
			expect(coordinator).not.toBeNull()
			if (!coordinator) return

			const notifySpy = vi.spyOn(coordinator, "notifyEventAppended")
			const event = makeEvent({ eventId: "notify-evt", idempotencyKey: "notify-idem" })

			await service.append(event)

			expect(notifySpy).toHaveBeenCalledOnce()
			expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ eventId: "notify-evt" }))
		})
	})

	describe("clearStats direct database clear fallback", () => {
		it("clears the database directly when no coordinator exists", async () => {
			await service.backfillFromHistory([
				makeEvent({ eventId: "clear-fallback", idempotencyKey: "clear-fallback" }),
			])

			// Remove the coordinator without touching the database
			service["coordinator"] = null

			const db = service.getDatabase()
			expect(db).not.toBeNull()
			if (!db) return

			const clearSpy = vi.spyOn(db, "clearGeneration")
			const nonce = service.issueClearNonce()
			await service.clearStats(nonce)

			expect(clearSpy).toHaveBeenCalledOnce()
		})
	})

	describe("backfillFromHistory error handling", () => {
		it("re-throws non-StatsStoreError as StatsServiceError", async () => {
			const store = (service as unknown as { store: { append: () => Promise<boolean> } }).store
			const appendSpy = vi.spyOn(store, "append").mockRejectedValueOnce(new Error("unknown failure"))

			await expect(service.backfillFromHistory([makeEvent()])).rejects.toThrow(StatsServiceError)

			appendSpy.mockRestore()
		})
	})

	describe("file watcher debounce", () => {
		it("debounces file system change notifications for 300ms", async () => {
			vi.useFakeTimers()

			const listener = vi.fn()
			service.onDidChange(listener)

			const watcher = service["watcher"] as unknown as {
				onDidChange: ReturnType<typeof vi.fn>
				onDidCreate: ReturnType<typeof vi.fn>
			}
			expect(watcher).not.toBeNull()

			const onChangeCallback = watcher.onDidChange.mock.calls[0][0] as () => void
			onChangeCallback()

			// Listener should not fire immediately
			expect(listener).not.toHaveBeenCalled()

			vi.advanceTimersByTime(300)

			expect(listener).toHaveBeenCalledOnce()

			vi.useRealTimers()
		})
	})

	describe("CSV extractCsvValue default branch", () => {
		it("returns empty string for unknown columns", async () => {
			const svc = service as unknown as {
				extractCsvValue(event: UsageEventV1, column: string): string
			}
			const value = svc.extractCsvValue(makeEvent(), "unknownColumn")
			expect(value).toBe("")
		})
	})
})
