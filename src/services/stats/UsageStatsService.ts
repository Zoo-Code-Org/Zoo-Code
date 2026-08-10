import * as vscode from "vscode"
import type { UsageEventV1, StatsQuery, StatsSnapshot } from "@roo-code/types"

import { UsageEventStore, StatsStoreError } from "./UsageEventStore"
import { UsageAggregator } from "./UsageAggregator"
import { UsageStatsDatabase } from "./UsageStatsDatabase"
import { UsageStatsMigration } from "./UsageStatsMigration"
import { UsageStatsStreamCoordinator } from "./UsageStatsStreamCoordinator"
import { DashboardTaskCatalog } from "./DashboardTaskCatalog"
import { isWithinStatsQueryRange, resolveStatsQueryRangeMs } from "./statsQueryRange"

// ── Export Format ───────────────────────────────────────────────────────────

export type ExportFormat = "json" | "csv"

/** JSON export result */
export interface JsonExport {
	exportSchemaVersion: 1
	exportedAt: string
	query: StatsQuery
	events: UsageEventV1[]
}

// ── Error Codes ─────────────────────────────────────────────────────────────

export type StatsServiceErrorCode =
	| "STATS_SERVICE/export/001" // Unsupported format
	| "STATS_SERVICE/clear/001" // Nonce mismatch
	| "STATS_SERVICE/backfill/001" // Backfill failed

export class StatsServiceError extends Error {
	constructor(
		public readonly code: StatsServiceErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsServiceError"
	}
}

// ── CSV Column Order ────────────────────────────────────────────────────────

/**
 * Fixed column order for CSV export.
 * Missing values become empty cells, 0 becomes `0`.
 * Source and inclusion fields are placed in separate columns.
 */
const CSV_COLUMNS = [
	"eventId",
	"idempotencyKey",
	"occurredAt",
	"timezoneOffsetMinutes",
	"status",
	"attempt",
	"taskId",
	"parentTaskId",
	"rootTaskId",
	"provider",
	"model",
	"mode",
	"endpoint",
	"inputTokens",
	"inputTokensSource",
	"outputTokens",
	"outputTokensSource",
	"cacheWriteTokens",
	"cacheWriteTokensSource",
	"cacheReadTokens",
	"cacheReadTokensSource",
	"reasoningTokens",
	"reasoningTokensSource",
	"totalTokens",
	"totalTokensSource",
	"costUsd",
	"costUsdSource",
	"cacheReadInInput",
	"cacheWriteInInput",
	"reasoningInOutput",
	"provenance",
] as const

// ── UsageStatsService ───────────────────────────────────────────────────────

/**
 * Statistics service facade.
 * Integrates UsageEventStore and UsageAggregator.
 *
 * Design principles (architecture report section 5.15-5.17):
 * - query: Query statistics via the aggregation engine
 * - export: Export statistics in JSON/CSV format
 * - clear: Delete statistics data after nonce verification
 * - backfill: Restore events from past task history
 *
 * Security: does not store prompt, response, API key, or workspace path.
 */
export class UsageStatsService {
	private readonly store: UsageEventStore
	private readonly aggregator: UsageAggregator
	private readonly storageDir: string
	private readonly database: UsageStatsDatabase
	/** Read-only History-first task catalog supplied by the extension host. */
	private readonly taskCatalog?: DashboardTaskCatalog

	/** Demand-driven host stream coordinator for dashboard stats. */
	private coordinator: UsageStatsStreamCoordinator | null = null
	/** Releases the catalog change listener owned by this service. */
	private taskCatalogSubscription: vscode.Disposable | null = null

	/** Nonce for clear verification (short-lived) */
	private clearNonce: string | null = null
	private clearNonceExpiresAt: number = 0

	/**
	 * File system watcher for cross-window change detection.
	 * Watches events-*.ndjson in the globalStorage usage-stats directory.
	 */
	private watcher: vscode.FileSystemWatcher | null = null

	/**
	 * Listeners registered for external change notifications.
	 * Fires when another VS Code window writes to the usage stats files.
	 */
	private readonly changeListeners: Array<() => void> = []

	constructor(globalStoragePath: string, taskCatalog?: DashboardTaskCatalog) {
		this.storageDir = globalStoragePath
		this.database = new UsageStatsDatabase(this.getStatsDir(globalStoragePath))
		this.store = new UsageEventStore(globalStoragePath, this.database)
		this.aggregator = new UsageAggregator()
		this.taskCatalog = taskCatalog
	}

	// ── Public API ──────────────────────────────────────────────────────────

	private initPromise: Promise<void> | null = null

	/**
	 * Initializes the service.
	 * Performs store initialization, database initialization, migration,
	 * and sets up the file system watcher.
	 */
	async initialize(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.doInitialize()
		}
		return this.initPromise
	}

	private async doInitialize(): Promise<void> {
		// The catalog is a History-store projection. Do not construct the stream
		// until its source has completed initialization, otherwise the first page
		// can race the initial history reconciliation.
		await this.taskCatalog?.sourceInitialized
		this.taskCatalog?.rebuild()

		// Initialize the SQLite database
		try {
			this.database.initialize()
		} catch (err) {
			console.warn("[UsageStatsService] Failed to initialize SQLite database:", err)
		}

		// Initialize the NDJSON store (also appends to database when available)
		await this.store.initialize()

		// Run migration from legacy NDJSON segments if not yet complete
		if (this.database._isInitialized()) {
			try {
				const migration = new UsageStatsMigration(
					this.database._getDbPath().replace(/[/\\]usage\.db$/, ""),
					this.database,
				)
				const result = migration.migrate()
				if (result.totalMigrated > 0) {
					console.log(
						`[UsageStatsService] Migrated ${result.totalMigrated} events from NDJSON to SQLite (${result.totalSkipped} duplicates skipped)`,
					)
				}
			} catch (err) {
				console.warn("[UsageStatsService] NDJSON migration failed:", err)
			}
		}

		this.setupFileWatcher()

		// Create the stream coordinator only after both the database and catalog
		// are readable. The catalog remains read-only from the stats boundary.
		this.coordinator = new UsageStatsStreamCoordinator(this.database._isInitialized() ? this.database : null, {
			taskCatalog: this.taskCatalog,
		})
		this.taskCatalogSubscription =
			this.taskCatalog?.onDidChange(() => this.coordinator?.notifyTaskCatalogChanged()) ?? null
	}

	async ensureInitialized(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise
		}
	}

	/**
	 * Disposes the service, releasing the file system watcher and database.
	 */
	dispose(): void {
		this.coordinator?.dispose()
		this.coordinator = null
		this.taskCatalogSubscription?.dispose()
		this.taskCatalogSubscription = null
		this.watcher?.dispose()
		this.watcher = null
		this.changeListeners.length = 0
		this.database.close()
	}

	/**
	 * Returns the SQLite database for indexed dashboard queries.
	 * Returns null if the database is not initialized.
	 */
	getDatabase(): UsageStatsDatabase | null {
		return this.database._isInitialized() ? this.database : null
	}

	/** Returns the injected read-only History-first Dashboard task catalog, when configured by the host. */
	getTaskCatalog(): DashboardTaskCatalog | undefined {
		return this.taskCatalog
	}

	/**
	 * Returns the stream coordinator for dashboard stats subscriptions.
	 * Returns null if the service has not been initialized or the coordinator
	 * could not be created (e.g., database unavailable).
	 */
	getCoordinator(): UsageStatsStreamCoordinator | null {
		return this.coordinator
	}

	/**
	 * Returns the stats directory path for the given global storage path.
	 */
	private getStatsDir(globalStoragePath: string): string {
		return globalStoragePath + "/usage-stats"
	}

	/**
	 * Registers a listener that fires when the usage stats files change on disk.
	 * Returns a disposable that unregisters the listener.
	 */
	onDidChange(listener: () => void): { dispose(): void } {
		this.changeListeners.push(listener)
		return {
			dispose: () => {
				const idx = this.changeListeners.indexOf(listener)
				if (idx >= 0) {
					this.changeListeners.splice(idx, 1)
				}
			},
		}
	}

	/**
	 * Appends a usage event to the shared store.
	 * This is the single in-process write entry for live recordings.
	 * Delegates to the owned UsageEventStore.
	 *
	 * @returns true if appended, false if deduplicated
	 */
	async append(event: UsageEventV1): Promise<boolean> {
		const appended = await this.store.append(event)
		if (appended) {
			// Notify the coordinator that a new event was committed.
			// The coordinator only schedules an indexed drain; it never
			// carries uncommitted data.
			this.coordinator?.notifyEventAppended(event)
		}
		return appended
	}

	/**
	 * Queries statistics.
	 *
	 * @param query Statistics query
	 * @param options Additional options
	 * @returns Statistics snapshot
	 */
	async queryStats(query: StatsQuery, options: { recordingPaused?: boolean } = {}): Promise<StatsSnapshot> {
		const events = await this.store.readAll()
		return this.aggregator.query(events, query, options)
	}

	/**
	 * Exports statistics.
	 *
	 * @param query Statistics query (export target range)
	 * @param format Export format ("json" or "csv")
	 * @returns Object for JSON, string for CSV
	 */
	async exportStats(query: StatsQuery, format: ExportFormat): Promise<JsonExport | string> {
		const events = await this.store.readAll()

		// Time range filtering
		const filtered = this.filterEventsByQuery(events, query)

		switch (format) {
			case "json":
				return {
					exportSchemaVersion: 1,
					exportedAt: new Date().toISOString(),
					query,
					events: filtered,
				}

			case "csv":
				return this.eventsToCsv(filtered)

			default:
				throw new StatsServiceError(
					"STATS_SERVICE/export/001",
					`Unsupported export format: ${format as string}`,
				)
		}
	}

	/**
	 * Returns the raw events filtered by the query's time range and
	 * includeCancelled flag. This avoids the JSON serialize/parse round-trip
	 * that `exportStats(query, "json")` performs for callers that only need
	 * in-memory events (e.g., dashboard session grouping).
	 *
	 * @param query Statistics query
	 * @returns Filtered events
	 */
	async getFilteredEvents(query: StatsQuery): Promise<UsageEventV1[]> {
		const events = await this.store.readAll()
		return this.filterEventsByQuery(events, query)
	}

	/**
	 * Issues a nonce for statistics deletion.
	 * The Host calls this method after the UI's first confirmation dialog.
	 *
	 * @returns Short-lived nonce (valid for 5 minutes)
	 */
	issueClearNonce(): string {
		const nonce = this.generateNonce()
		this.clearNonce = nonce
		// Valid for 5 minutes
		this.clearNonceExpiresAt = Date.now() + 5 * 60 * 1000
		return nonce
	}

	/**
	 * Deletes statistics data.
	 * The nonce must be valid (within 5 minutes, single-use).
	 *
	 * @param nonce Nonce issued by issueClearNonce()
	 * @throws StatsServiceError on nonce mismatch or expiration
	 */
	async clearStats(nonce: string): Promise<void> {
		// Nonce verification
		if (!this.clearNonce || this.clearNonce !== nonce) {
			throw new StatsServiceError("STATS_SERVICE/clear/001", "Invalid clear nonce: nonce mismatch")
		}

		if (Date.now() > this.clearNonceExpiresAt) {
			this.clearNonce = null
			throw new StatsServiceError("STATS_SERVICE/clear/001", "Invalid clear nonce: nonce expired")
		}

		// Consume single-use nonce
		this.clearNonce = null

		// Clear the store
		await this.store.clear()

		// Clear the SQLite projection so the dashboard stops showing cleared
		// data. Prefer the coordinator's resetGeneration(), which also pushes a
		// reset snapshot to all stream subscribers; fall back to clearing the
		// database directly when no coordinator exists. A projection failure
		// must never fail the clear operation itself.
		try {
			if (this.coordinator) {
				this.coordinator.resetGeneration()
			} else if (this.database._isInitialized()) {
				this.database.clearGeneration()
			}
		} catch (err) {
			console.warn("[UsageStatsService] Failed to clear SQLite stats projection:", err)
		}
	}

	/**
	 * Restores usage events from past task history.
	 * Called when UsageRecorder in Commit 3 is actually implemented.
	 *
	 * @param events Array of events to restore
	 * @returns Number of restored events (actual appended count may differ due to dedupe)
	 */
	async backfillFromHistory(events: UsageEventV1[]): Promise<number> {
		let appended = 0

		for (const event of events) {
			try {
				// provenance must be "history-backfill"
				const backfillEvent: UsageEventV1 = {
					...event,
					provenance: "history-backfill",
				}
				const result = await this.store.append(backfillEvent)
				if (result) {
					appended++
				}
			} catch (err) {
				// Storage errors do not fail the LLM task
				if (err instanceof StatsStoreError) {
					console.warn(`[UsageStatsService] backfill append failed for event ${event.eventId}:`, err)
				} else {
					throw new StatsServiceError(
						"STATS_SERVICE/backfill/001",
						`Backfill failed for event ${event.eventId}`,
						err,
					)
				}
			}
		}

		return appended
	}

	/**
	 * Checks whether the store has reached the hard cap.
	 */
	isCapped(): boolean {
		return this.store.isCapped()
	}

	// ── Internal: File Watcher ──────────────────────────────────────────────

	/**
	 * Sets up a FileSystemWatcher on the usage-stats directory to detect
	 * changes made by other VS Code windows. When another window writes to
	 * events-*.ndjson, this window emits onDidChange so the local webview
	 * can refresh its dashboard.
	 */
	private setupFileWatcher(): void {
		try {
			// globalStorageUri is outside the workspace, so RelativePattern
			// may not match. Use a glob pattern on the absolute path instead.
			const pattern = new vscode.RelativePattern(this.storageDir, "usage-stats/events-*.ndjson")
			this.watcher = vscode.workspace.createFileSystemWatcher(pattern)

			let debounceTimer: ReturnType<typeof setTimeout> | null = null
			const notify = () => {
				if (debounceTimer) {
					clearTimeout(debounceTimer)
				}
				debounceTimer = setTimeout(() => {
					for (const listener of this.changeListeners) {
						listener()
					}
					// Notify the coordinator of external (cross-window) changes
					this.coordinator?.notifyExternalChange()
					debounceTimer = null
				}, 300)
			}

			this.watcher.onDidChange(notify)
			this.watcher.onDidCreate(notify)
		} catch {
			// Watcher setup failure is non-fatal — cross-window refresh
			// will simply not work, but same-window refresh still does.
			console.warn("[UsageStatsService] Failed to set up file watcher for cross-window stats sync")
		}
	}

	// ── Internal: Event Filtering ───────────────────────────────────────────

	/**
	 * Filters events according to the query conditions.
	 * Handles time range and includeCancelled.
	 */
	private filterEventsByQuery(events: UsageEventV1[], query: StatsQuery): UsageEventV1[] {
		// Time range (half-open: fromMs <= t < toMs), resolved by the shared
		// range module so export/getFilteredEvents and the Dashboard "Tasks"
		// list can never drift apart.
		const rangeMs = resolveStatsQueryRangeMs(query)
		let filtered = events.filter((event) => isWithinStatsQueryRange(rangeMs, new Date(event.occurredAt).getTime()))

		// Cancelled filtering
		const includeCancelled = query.includeCancelled ?? false
		if (!includeCancelled) {
			filtered = filtered.filter((e) => e.status !== "cancelled")
		}

		return filtered
	}

	// ── Internal: CSV ────────────────────────────────────────────────────────

	/**
	 * Converts an array of events to a CSV string.
	 * - One row per event
	 * - Fixed column order
	 * - Missing values become empty cells, 0 becomes `0`
	 * - Source and inclusion fields are placed in separate columns
	 * - Prevents spreadsheet formula injection: prefixes `=`, `+`, `-`, `@` with `'`
	 */
	private eventsToCsv(events: UsageEventV1[]): string {
		const rows: string[] = []

		// header
		rows.push(CSV_COLUMNS.join(","))

		for (const event of events) {
			const row = this.eventToCsvRow(event)
			rows.push(row)
		}

		return rows.join("\n")
	}

	/**
	 * Converts a single event to a CSV row.
	 */
	private eventToCsvRow(event: UsageEventV1): string {
		const values: string[] = []

		for (const col of CSV_COLUMNS) {
			const value = this.extractCsvValue(event, col)
			values.push(this.escapeCsvCell(value))
		}

		return values.join(",")
	}

	/**
	 * Extracts the value corresponding to a column from an event.
	 */
	private extractCsvValue(event: UsageEventV1, column: string): string {
		switch (column) {
			case "eventId":
				return event.eventId
			case "idempotencyKey":
				return event.idempotencyKey
			case "occurredAt":
				return event.occurredAt
			case "timezoneOffsetMinutes":
				return String(event.timezoneOffsetMinutes)
			case "status":
				return event.status
			case "attempt":
				return String(event.attempt)
			case "taskId":
				return event.taskId
			case "parentTaskId":
				return event.parentTaskId ?? ""
			case "rootTaskId":
				return event.rootTaskId ?? ""
			case "provider":
				return event.provider
			case "model":
				return event.model
			case "mode":
				return event.mode
			case "endpoint":
				return event.endpoint ?? ""
			case "inputTokens":
				return event.usage.inputTokens ? String(event.usage.inputTokens.value) : ""
			case "inputTokensSource":
				return event.usage.inputTokens?.source ?? ""
			case "outputTokens":
				return event.usage.outputTokens ? String(event.usage.outputTokens.value) : ""
			case "outputTokensSource":
				return event.usage.outputTokens?.source ?? ""
			case "cacheWriteTokens":
				return event.usage.cacheWriteTokens ? String(event.usage.cacheWriteTokens.value) : ""
			case "cacheWriteTokensSource":
				return event.usage.cacheWriteTokens?.source ?? ""
			case "cacheReadTokens":
				return event.usage.cacheReadTokens ? String(event.usage.cacheReadTokens.value) : ""
			case "cacheReadTokensSource":
				return event.usage.cacheReadTokens?.source ?? ""
			case "reasoningTokens":
				return event.usage.reasoningTokens ? String(event.usage.reasoningTokens.value) : ""
			case "reasoningTokensSource":
				return event.usage.reasoningTokens?.source ?? ""
			case "totalTokens":
				return event.usage.totalTokens ? String(event.usage.totalTokens.value) : ""
			case "totalTokensSource":
				return event.usage.totalTokens?.source ?? ""
			case "costUsd":
				return event.usage.costUsd ? String(event.usage.costUsd.value) : ""
			case "costUsdSource":
				return event.usage.costUsd?.source ?? ""
			case "cacheReadInInput":
				return event.semantics.cacheReadInInput
			case "cacheWriteInInput":
				return event.semantics.cacheWriteInInput
			case "reasoningInOutput":
				return event.semantics.reasoningInOutput
			case "provenance":
				return event.provenance
			default:
				return ""
		}
	}

	/**
	 * Escapes a CSV cell.
	 * - Prevents spreadsheet formula injection: prefixes `=`, `+`, `-`, `@` with `'`
	 * - If the value contains `,`, `"`, or `\n`, wraps it in `"..."` and escapes inner `"` as `""`
	 */
	private escapeCsvCell(value: string): string {
		// Empty value becomes an empty cell
		if (value === "") {
			return ""
		}

		// Prevent formula injection
		let escaped = value
		if (/^[=+\-@]/.test(escaped)) {
			escaped = `'${escaped}`
		}

		// Check if quoting is needed
		if (/[",\n]/.test(escaped)) {
			escaped = `"${escaped.replace(/"/g, '""')}"`
		}

		return escaped
	}

	// ── Internal: Nonce ─────────────────────────────────────────────────────

	/**
	 * Generates a short-lived nonce.
	 * Provides a fallback for environments where crypto.randomUUID is unavailable.
	 */
	private generateNonce(): string {
		try {
			const crypto = require("crypto")
			return crypto.randomUUID()
		} catch {
			// fallback: timestamp + random
			return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
		}
	}
}
