// Type-only import: erased at compile time, so it does NOT trigger a runtime
// `require("node:sqlite")` at module load. `node:sqlite` is only available in
// Node.js >= 22.5; the VS Code extension host for the e2e-mock suite runs an
// older Electron/Node that lacks it. A static value import would crash the
// entire extension module graph on load ("No such built-in module: node:sqlite").
import type { DatabaseSync } from "node:sqlite"
import { createRequire } from "node:module"
import * as fs from "fs"
import * as path from "path"

import type { UsageEventV1 } from "@roo-code/types"

import { getEffectiveCost, computeCacheDiscountBase, providerReportsCache } from "./costRecalculation"
import { isStatsQueryRangeBounded, type StatsQueryRangeMs } from "./statsQueryRange"

// ── Lazy node:sqlite loader ──────────────────────────────────────────────────

/**
 * Lazily resolves the `DatabaseSync` constructor from the built-in `node:sqlite`
 * module. The require is deferred until `initialize()` actually runs, so the
 * module graph loads cleanly on runtimes without `node:sqlite` (e.g. the older
 * Electron/Node used by the e2e-mock VS Code host). When unavailable, this
 * throws, and `initialize()` surfaces a StatsDbError which callers already
 * handle by degrading to a no-database state.
 */
let cachedDatabaseSync: typeof DatabaseSync | null = null
function loadDatabaseSync(): typeof DatabaseSync {
	if (cachedDatabaseSync) {
		return cachedDatabaseSync
	}
	// createRequire so this works regardless of ESM/CJS bundling of the extension.
	const require = createRequire(__filename)
	const mod = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync }
	cachedDatabaseSync = mod.DatabaseSync
	return cachedDatabaseSync
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Current schema version for the SQLite database. */
const SCHEMA_VERSION = 8

/** Singleton key in stats_meta for the single metadata row. */
const META_KEY = "singleton"

/** Maximum number of events returned in a single batch read. */
const MAX_BATCH_SIZE = 100

/** Maximum task IDs per focused SQLite query, safely below SQLite's parameter ceiling. */
const TASK_ID_QUERY_CHUNK_SIZE = 900

/**
 * Special root_task_id value used for non-cancelled-only rollup rows.
 * When includeCancelled=false, queries use this key to exclude cancelled events.
 */
const NON_CANCELLED_KEY = "__nc__"

/**
 * Axes supported by breakdown rollup rows.
 * For each event, per-axis breakdown rows are stored in stats_rollup.
 * The 'day' axis is handled via daily aggregate rollups (no separate breakdown needed).
 */
const BREAKDOWN_AXES = ["model", "provider", "mode"] as const

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Database error codes.
 * Format: STATS_DB/function/NNN
 */
export type StatsDbErrorCode =
	| "STATS_DB/open/001" // Database open failed
	| "STATS_DB/migrate/001" // Schema migration failed
	| "STATS_DB/migrate/002" // Schema v4 migration failed (timezone offset fix)
	| "STATS_DB/migrate/003" // Schema v5 migration failed (task usage projection)
	| "STATS_DB/migrate/004" // Schema v6 migration failed (unreported cache input tokens)
	| "STATS_DB/migrate/005" // Schema v7 migration failed (rollup self-heal rebuild)
	| "STATS_DB/migrate/006" // Schema v8 migration failed (cache discount base backfill)
	| "STATS_DB/append/001" // Transaction failed
	| "STATS_DB/read/001" // Query failed
	| "STATS_DB/clear/001" // Clear failed
	| "STATS_DB/meta/001" // Meta read/write failed
	| "STATS_DB/rebuild/001" // Rollup rebuild failed

export class StatsDbError extends Error {
	constructor(
		public readonly code: StatsDbErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsDbError"
	}
}

// ── Types ───────────────────────────────────────────────────────────────────

/** Result of an idempotent append. */
export interface AppendResult {
	/** True if the event was newly inserted, false if it was a duplicate. */
	inserted: boolean
	/** The monotonic sequence number assigned to this event (existing or new). */
	sequence: number
}

/** A page of events read by sequence cursor. */
export interface EventBatch {
	/** Events in ascending sequence order. */
	events: Array<UsageEventV1 & { sequence: number }>
	/** True if more events exist beyond this batch. */
	hasMore: boolean
}

/** A page of session summaries. */
export interface SessionPage {
	sessions: SessionRow[]
	/** Opaque cursor for the next page. Absent if this is the last page. */
	cursor?: string
	/** Estimated total session count. */
	totalEstimate: number
}

/** A session summary row from the database. */
export interface SessionRow {
	rootTaskId: string
	title: string
	totalCost: number
	totalTokens: number
	model: string
	provider: string
	lastActivity: number
	eventCount: number
}

/** Direct per-task usage summary from the task usage projection. */
export interface TaskUsageRow {
	taskId: string
	totalCost: number
	totalTokens: number
	eventCount: number
	lastActivity: number
	model: string
	provider: string
	/** Sum of per-event cacheRatio discount bases (USD) for this task. */
	cacheDiscountBase?: number
}

/**
 * Per-task identity aggregates composed straight from usage_events:
 * input/output token sums plus the distinct models and modes a task used.
 */
export interface TaskIdentityAggregate {
	inputTokens: number
	outputTokens: number
	models: string[]
	modes: string[]
}

/** A daily rollup row. */
export interface DailyRollupRow {
	day: string
	totalCost: number
	totalTokens: number
	eventCount: number
}

/** A detailed daily rollup row with all token breakdowns. */
export interface DailyRollupDetailedRow {
	day: string
	eventCount: number
	completedCalls: number
	failedCalls: number
	cancelledCalls: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens: number
	totalTokens: number
	costUsd: number
	uncachedInputTokens: number
	unreportedCacheInputTokens?: number
	cacheDiscountBase?: number
}

/** A breakdown rollup row for a specific axis. */
export interface BreakdownRollupRow {
	axisValue: string
	eventCount: number
	completedCalls: number
	failedCalls: number
	cancelledCalls: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens: number
	totalTokens: number
	costUsd: number
	uncachedInputTokens: number
	unreportedCacheInputTokens?: number
	cacheDiscountBase?: number
}

/** Coverage statistics for a time range. */
export interface CoverageStats {
	firstEventAt: string | undefined
	lastEventAt: string | undefined
	backfilledEventCount: number
}

/** Migration checkpoint stored in stats_meta. */
export interface MigrationCheckpoint {
	/** Last migrated segment file name. */
	lastSegment: string
	/** Last migrated line number within that segment. */
	lastLine: number
	/** Total events migrated so far. */
	eventsMigrated: number
	/** Whether migration is complete. */
	complete: boolean
}

/** Internal metadata structure stored in stats_meta singleton. */
interface MetaData {
	schemaVersion: number
	generation: number
	lastSequence: number
	migrationCheckpoint: MigrationCheckpoint
}

function createZeroTaskUsageRow(taskId: string): TaskUsageRow {
	return {
		taskId,
		totalCost: 0,
		totalTokens: 0,
		eventCount: 0,
		lastActivity: 0,
		model: "",
		provider: "",
		cacheDiscountBase: 0,
	}
}

/** Splits a GROUP_CONCAT aggregate back into an array; NULL/empty yields []. */
function splitGroupConcat(value: unknown): string[] {
	if (typeof value !== "string" || value.length === 0) {
		return []
	}
	return value.split(",")
}

/**
 * Computes a local day bucket (YYYY-MM-DD) from epoch milliseconds and timezone offset.
 *
 * The timezone offset is added to the UTC epoch to derive the local calendar date.
 * This ensures events near midnight UTC are bucketed into the correct local day,
 * matching the user's perception of "today".
 *
 * @param epochMs - UTC epoch milliseconds
 * @param timezoneOffsetMinutes - Offset from UTC in minutes (e.g., 540 for UTC+9 Seoul)
 * @returns YYYY-MM-DD string in local time
 */
export function computeLocalDayBucket(epochMs: number, timezoneOffsetMinutes: number): string {
	const localMs = epochMs + timezoneOffsetMinutes * 60_000
	const d = new Date(localMs)
	const year = d.getUTCFullYear()
	const month = String(d.getUTCMonth() + 1).padStart(2, "0")
	const day = String(d.getUTCDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

// ── UsageStatsDatabase ──────────────────────────────────────────────────────

/**
 * SQLite-backed canonical usage event store with rollups and projections.
 *
 * Design principles (architecture report section 1.4A):
 * - Uses `node:sqlite` (built-in, no external dependency)
 * - WAL mode for concurrent read/write
 * - Busy timeout for cross-window safety
 * - Transactional idempotent append (INSERT OR IGNORE on event identity)
 * - Monotonic sequence generation
 * - Rollup updates (daily, monthly, lifetime totals)
 * - Session projection upserts
 * - Indexed page queries with cursor support
 * - Bounded batch reads (max 100)
 * - Clear generation support
 *
 * Security: does not store prompt, response, API key, or workspace path.
 * (Structurally guaranteed because these fields are not in UsageEventV1)
 */
export class UsageStatsDatabase {
	private readonly dbPath: string
	private db: DatabaseSync | null = null

	/** Whether the database has been opened and migrated. */
	private initialized = false

	/**
	 * @param statsDir The usage-stats directory path (same as UsageEventStore).
	 */
	constructor(statsDir: string) {
		this.dbPath = path.join(statsDir, "usage.db")
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	/**
	 * Opens the database, creates the schema if needed, and runs migrations.
	 */
	initialize(): void {
		if (this.initialized) {
			return
		}

		// Ensure parent directory exists
		const dir = path.dirname(this.dbPath)
		try {
			fs.mkdirSync(dir, { recursive: true })
		} catch (err) {
			throw new StatsDbError("STATS_DB/open/001", `Failed to create database directory: ${dir}`, err)
		}

		let DatabaseSyncCtor: typeof DatabaseSync
		try {
			DatabaseSyncCtor = loadDatabaseSync()
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/open/001",
				"node:sqlite is unavailable in this runtime (requires Node.js >= 22.5); usage stats database disabled",
				err,
			)
		}

		try {
			this.db = new DatabaseSyncCtor(this.dbPath)

			// Enable WAL mode and busy timeout for concurrent access
			this.db.exec("PRAGMA journal_mode = WAL")
			this.db.exec("PRAGMA busy_timeout = 5000")
			this.db.exec("PRAGMA synchronous = NORMAL")

			this.createSchema()
			this.runMigrations()

			this.initialized = true
		} catch (err) {
			if (this.db) {
				try {
					this.db.close()
				} catch {
					// Ignore close errors while cleaning up a failed initialization.
				}
				this.db = null
			}
			throw new StatsDbError("STATS_DB/open/001", `Failed to initialize database: ${this.dbPath}`, err)
		}
	}

	/**
	 * Closes the database connection.
	 */
	close(): void {
		if (this.db) {
			try {
				this.db.close()
			} catch {
				// Ignore close errors
			}
			this.db = null
		}
		this.initialized = false
	}

	// ── Schema ─────────────────────────────────────────────────────────────

	/**
	 * Creates all tables and indexes if they don't exist.
	 */
	private createSchema(): void {
		const db = this.getDb()

		db.exec(`
			CREATE TABLE IF NOT EXISTS usage_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT NOT NULL UNIQUE,
				idempotency_key TEXT NOT NULL UNIQUE,
				occurred_at TEXT NOT NULL,
				occurred_epoch_ms INTEGER NOT NULL,
				timezone_offset_minutes INTEGER NOT NULL,
				status TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				task_id TEXT NOT NULL,
				parent_task_id TEXT,
				root_task_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				mode TEXT NOT NULL,
				endpoint TEXT,
				model_pricing_json TEXT,
				usage_json TEXT NOT NULL,
				semantics_json TEXT NOT NULL,
				provenance TEXT NOT NULL,
				schema_version INTEGER NOT NULL DEFAULT 1,
				cache_discount_base REAL NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_usage_events_occurred ON usage_events(occurred_epoch_ms);
			CREATE INDEX IF NOT EXISTS idx_usage_events_root ON usage_events(root_task_id);
			CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
			CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
			CREATE INDEX IF NOT EXISTS idx_usage_events_mode ON usage_events(mode);
			CREATE INDEX IF NOT EXISTS idx_usage_events_seq ON usage_events(seq);
			CREATE INDEX IF NOT EXISTS idx_usage_events_task ON usage_events(task_id);

			CREATE TABLE IF NOT EXISTS stats_rollup (
				period_type TEXT NOT NULL,
				period_key TEXT NOT NULL,
				root_task_id TEXT NOT NULL DEFAULT '',
				axis TEXT NOT NULL DEFAULT '',
				axis_value TEXT NOT NULL DEFAULT '',
				event_count INTEGER NOT NULL DEFAULT 0,
				completed_calls INTEGER NOT NULL DEFAULT 0,
				failed_calls INTEGER NOT NULL DEFAULT 0,
				cancelled_calls INTEGER NOT NULL DEFAULT 0,
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				reasoning_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				cost_usd REAL NOT NULL DEFAULT 0,
				uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
				unreported_cache_input_tokens INTEGER NOT NULL DEFAULT 0,
				cache_discount_base REAL NOT NULL DEFAULT 0,
				PRIMARY KEY (period_type, period_key, root_task_id, axis, axis_value)
			);

			CREATE TABLE IF NOT EXISTS session_metadata (
				root_task_id TEXT PRIMARY KEY,
				title TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL DEFAULT '',
				total_cost REAL NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				event_count INTEGER NOT NULL DEFAULT 0,
				last_activity_ms INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_session_metadata_last_activity
				ON session_metadata(last_activity_ms DESC);

			CREATE TABLE IF NOT EXISTS task_usage_metadata (
				task_id TEXT PRIMARY KEY,
				total_cost REAL NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				event_count INTEGER NOT NULL DEFAULT 0,
				last_activity_ms INTEGER NOT NULL DEFAULT 0,
				model TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL DEFAULT '',
				cache_discount_base REAL NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS session_activity (
				root_task_id TEXT NOT NULL,
				day TEXT NOT NULL,
				total_cost REAL NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				event_count INTEGER NOT NULL DEFAULT 0,
				last_activity_ms INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (root_task_id, day)
			);

			CREATE INDEX IF NOT EXISTS idx_session_activity_day
				ON session_activity(day, last_activity_ms DESC);

			CREATE TABLE IF NOT EXISTS stats_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
		`)

		// Migration: add uncached_input_tokens column to stats_rollup if it doesn't exist
		try {
			db.exec("ALTER TABLE stats_rollup ADD COLUMN uncached_input_tokens INTEGER NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}

		// Migration: add unreported_cache_input_tokens column to stats_rollup if it
		// doesn't exist. This must run before any schema-version migration, since
		// those rebuild rollups through updateRollup(), which writes this column.
		try {
			db.exec("ALTER TABLE stats_rollup ADD COLUMN unreported_cache_input_tokens INTEGER NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}

		// Migration: add cache_discount_base columns if they don't exist. These
		// must also run before any schema-version migration: the v8 rebuild
		// writes all three through the shared per-event write paths.
		try {
			db.exec("ALTER TABLE usage_events ADD COLUMN cache_discount_base REAL NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}
		try {
			db.exec("ALTER TABLE stats_rollup ADD COLUMN cache_discount_base REAL NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}
		try {
			db.exec("ALTER TABLE task_usage_metadata ADD COLUMN cache_discount_base REAL NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}

		// Migration: add model_pricing_json column to usage_events if it doesn't
		// exist. Stores a snapshot of the model's pricing info at capture time for
		// custom/user-configured models not in the static provider registry.
		try {
			db.exec("ALTER TABLE usage_events ADD COLUMN model_pricing_json TEXT")
		} catch {
			// Column already exists
		}

		// Initialize singleton meta if absent
		const existing = db.prepare("SELECT value FROM stats_meta WHERE key = ?").get(META_KEY) as
			| { value: string }
			| undefined

		if (!existing) {
			const metaValue = JSON.stringify({
				schemaVersion: SCHEMA_VERSION,
				generation: 1,
				lastSequence: 0,
				migrationCheckpoint: {
					lastSegment: "",
					lastLine: 0,
					eventsMigrated: 0,
					complete: false,
				} satisfies MigrationCheckpoint,
			})
			db.prepare("INSERT INTO stats_meta (key, value) VALUES (?, ?)").run(META_KEY, metaValue)
		}
	}

	/**
	 * Runs schema version migrations.
	 */
	private runMigrations(): void {
		const db = this.getDb()
		const meta = this.readMetaInternal(db)

		if (meta.schemaVersion < 2) {
			this.migrateToV2(db)
		}

		// Re-read meta after v2 migration (it updates schemaVersion)
		const metaAfterV2 = this.readMetaInternal(db)
		if (metaAfterV2.schemaVersion < 3) {
			this.migrateToV3(db)
		}

		// Re-read meta after v3 migration (it updates schemaVersion)
		const metaAfterV3 = this.readMetaInternal(db)
		if (metaAfterV3.schemaVersion < 4) {
			this.migrateToV4(db)
		}

		const metaAfterV4 = this.readMetaInternal(db)
		if (metaAfterV4.schemaVersion < 5) {
			this.migrateToV5(db)
		}

		const metaAfterV5 = this.readMetaInternal(db)
		if (metaAfterV5.schemaVersion < 6) {
			this.migrateToV6(db)
		}

		const metaAfterV6 = this.readMetaInternal(db)
		if (metaAfterV6.schemaVersion < 7) {
			this.migrateToV7(db)
		}

		const metaAfterV7 = this.readMetaInternal(db)
		if (metaAfterV7.schemaVersion < 8) {
			this.migrateToV8(db)
		}
	}

	/**
	 * Migration v3 → v4: Fix inverted timezone_offset_minutes sign.
	 *
	 * In v3, `getTimezoneOffset()` (minutes WEST of UTC, negative for UTC+9)
	 * was stored directly. `computeLocalDayBucket` expects minutes EAST of UTC
	 * (positive for UTC+9), causing all day buckets to be shifted backward.
	 *
	 * This migration:
	 * 1. Flips the sign of timezone_offset_minutes for all events
	 * 2. Deletes all derived tables (rollups, session_activity, session_metadata)
	 * 3. Rebuilds everything from the corrected events
	 *
	 * Idempotent: running twice produces the same result.
	 */
	private migrateToV4(db: DatabaseSync): void {
		try {
			db.exec("BEGIN")

			// 1. Flip sign of timezone_offset_minutes for all events
			db.exec("UPDATE usage_events SET timezone_offset_minutes = -timezone_offset_minutes")

			// 2. Update schema version
			const meta = this.readMetaInternal(db)
			meta.schemaVersion = 4
			this.updateMeta(db, meta)

			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/002",
				"Failed to migrate to schema v4 (timezone offset sign fix)",
				err,
			)
		}

		// 3. Rebuild all derived data (rollups, session_metadata, session_activity)
		//    from the sign-corrected events. The previous implementation deleted the
		//    derived data without rebuilding it, leaving stats_rollup/session_activity
		//    empty after a v1->v4 (or v3->v4) migration and breaking every dashboard
		//    query. rebuildRollupsFromEvents() manages its own transaction and deletes
		//    the derived tables before rebuilding, so we call it after committing the
		//    sign flip above (cannot nest transactions).
		try {
			this.rebuildRollupsFromEvents()
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/migrate/002",
				"Failed to rebuild derived data after schema v4 migration (timezone offset sign fix)",
				err,
			)
		}
	}

	/**
	 * Migration v4 → v5: backfill the direct task usage projection from events.
	 *
	 * Schema creation is additive, so existing databases already have the table
	 * by the time this runs. Rebuilding ensures projection rows are complete and
	 * uses ascending event sequence to deterministically resolve timestamp ties.
	 */
	private migrateToV5(db: DatabaseSync): void {
		try {
			db.exec("BEGIN")
			this.updateMeta(db, { schemaVersion: 5 })
			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/003",
				"Failed to migrate to schema v5 (task usage projection)",
				err,
			)
		}

		try {
			this.rebuildRollupsFromEvents()
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/migrate/003",
				"Failed to rebuild task usage projection after schema v5 migration",
				err,
			)
		}
	}

	/**
	 * Migration v5 → v6: backfill unreported_cache_input_tokens on rollup rows.
	 *
	 * The new column stores, per rollup row, the sum of FULL input tokens over
	 * events whose provider did not report cacheReadTokens. The dashboard
	 * cacheRatio simulation uses it to estimate unreported cache reads with
	 * per-event parity on mixed-reporting buckets (where the bucket-level
	 * cacheRead sum is non-zero but some events report nothing).
	 *
	 * Idempotent: the ALTER is a no-op once the column exists, and the rebuild
	 * recomputes every rollup row from the raw events.
	 */
	private migrateToV6(db: DatabaseSync): void {
		try {
			db.exec("ALTER TABLE stats_rollup ADD COLUMN unreported_cache_input_tokens INTEGER NOT NULL DEFAULT 0")
		} catch {
			// Column already exists
		}

		// Rebuild rollups so existing rows carry the new column's values.
		// This runs BEFORE the version marker is committed: if the rebuild
		// fails, the meta stays at v5 and the migration is retried on the next
		// activation instead of being permanently skipped with stale rollups.
		try {
			this.rebuildRollupsFromEvents()
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/migrate/004",
				"Failed to rebuild rollups after schema v6 migration (unreported cache input tokens)",
				err,
			)
		}

		try {
			db.exec("BEGIN")
			this.updateMeta(db, { schemaVersion: 6 })
			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/004",
				"Failed to migrate to schema v6 (unreported cache input tokens)",
				err,
			)
		}
	}

	/**
	 * Migration v6 → v7: Self-heal rebuild for databases stranded on v6 with
	 * stale rollups. v6 committed its version marker before rebuilding, so a
	 * failed rebuild (lock contention, a corrupt event row, an interrupted
	 * activation) left the meta at v6 with pre-v6 rollup values — every later
	 * activation then skipped the migration entirely. v7 rebuilds the rollups
	 * (idempotent) and only then commits the version marker.
	 */
	private migrateToV7(db: DatabaseSync): void {
		try {
			this.rebuildRollupsFromEvents()
		} catch (err) {
			throw new StatsDbError("STATS_DB/migrate/005", "Failed to rebuild rollups for schema v7 (self-heal)", err)
		}

		try {
			db.exec("BEGIN")
			this.updateMeta(db, { schemaVersion: 7 })
			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError("STATS_DB/migrate/005", "Failed to migrate to schema v7 (self-heal)", err)
		}
	}

	/**
	 * Migration v7 → v8: backfill cache_discount_base on events, rollups, and
	 * task usage metadata.
	 *
	 * The new column stores, per event, the cacheRatio cost-discount base
	 * (inputTokens / 1M × max(0, inputPrice − cacheReadsPrice), 0 when the
	 * provider reports cacheReadTokens or pricing is unavailable). The
	 * dashboard cacheRatio simulation subtracts ratio × base from stored
	 * costs so estimated cache reads are priced at the cache-read rate.
	 *
	 * Rebuild-then-commit (same pattern as v7): the rebuild recomputes every
	 * derived row AND backfills usage_events.cache_discount_base from the raw
	 * events. If it fails, the meta stays at v7 and the migration is retried
	 * on the next activation.
	 */
	private migrateToV8(db: DatabaseSync): void {
		try {
			this.rebuildRollupsFromEvents()
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/migrate/006",
				"Failed to rebuild rollups for schema v8 (cache discount base backfill)",
				err,
			)
		}

		try {
			db.exec("BEGIN")
			this.updateMeta(db, { schemaVersion: 8 })
			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/006",
				"Failed to migrate to schema v8 (cache discount base backfill)",
				err,
			)
		}
	}

	/**
	 * Migration v1 → v2: Recompute day/month buckets using local timezone.
	 *
	 * In v1, dayBucket was derived from `occurredAt.slice(0, 10)` which is a UTC
	 * calendar date. In UTC+9, events near midnight UTC were bucketed into the
	 * wrong local day, causing heatmap and rollup misalignment.
	 *
	 * This migration:
	 * 1. Deletes existing daily/monthly rollups and session_activity rows
	 * 2. Reads all usage_events and recomputes day/month buckets using
	 *    occurred_epoch_ms + timezone_offset_minutes
	 * 3. Rebuilds daily/monthly rollups and session_activity
	 *
	 * Idempotent: running twice produces the same result (delete + rebuild).
	 * session_metadata is NOT touched (lifetime totals are timezone-independent).
	 */
	private migrateToV2(db: DatabaseSync): void {
		try {
			db.exec("BEGIN")

			// 1. Delete existing daily and monthly rollups (main aggregates only)
			db.exec(
				"DELETE FROM stats_rollup WHERE period_type IN ('daily', 'monthly') AND root_task_id = '' AND axis = ''",
			)

			// 2. Delete session_activity (will be rebuilt with local day buckets)
			db.exec("DELETE FROM session_activity")

			// 3. Read all events in batches and rebuild rollups + session_activity
			let afterSeq = 0
			const batchSize = 1000

			const sessionActivityStmt = db.prepare(`
				INSERT INTO session_activity (
					root_task_id, day, total_cost, total_tokens, event_count, last_activity_ms
				) VALUES (
					@rootTaskId, @day, @costUsd, @totalTokens, 1, @lastActivityMs
				)
				ON CONFLICT(root_task_id, day) DO UPDATE SET
					total_cost = total_cost + @costUsd,
					total_tokens = total_tokens + @totalTokens,
					event_count = event_count + 1,
					last_activity_ms = @lastActivityMs
			`)

			while (true) {
				const rows = db
					.prepare(
						`SELECT seq, occurred_epoch_ms, timezone_offset_minutes, status, root_task_id,
						 provider, model, model_pricing_json, usage_json, semantics_json
						 FROM usage_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
					)
					.all(afterSeq, batchSize) as Array<Record<string, unknown>>

				if (rows.length === 0) {
					break
				}

				for (const row of rows) {
					const epochMs = row.occurred_epoch_ms as number
					const tzOffset = row.timezone_offset_minutes as number
					const dayBucket = computeLocalDayBucket(epochMs, tzOffset)
					const monthBucket = dayBucket.slice(0, 7)
					const rootTaskId = (row.root_task_id as string) ?? ""
					const status = row.status as string
					const provider = row.provider as string
					const model = row.model as string
					const usage = JSON.parse(row.usage_json as string)
					const semantics = JSON.parse(row.semantics_json as string)

					const inputTokens = usage.inputTokens?.value ?? 0
					const outputTokens = usage.outputTokens?.value ?? 0
					const cacheReadTokens = usage.cacheReadTokens?.value ?? 0
					const cacheWriteTokens = usage.cacheWriteTokens?.value ?? 0
					const reasoningTokens = usage.reasoningTokens?.value ?? 0
					const totalTokens = usage.totalTokens?.value ?? inputTokens + outputTokens
					const costUsd = usage.costUsd?.value ?? 0
					const uncachedInputTokens = this.computeUncachedInputTokens(usage, semantics)
					const eventForCost = {
						provider,
						model,
						modelPricing: row.model_pricing_json
							? (JSON.parse(row.model_pricing_json as string) as UsageEventV1["modelPricing"])
							: undefined,
						usage: { ...usage },
					} as UsageEventV1
					const unreportedCacheInputTokens =
						providerReportsCache(provider, model, eventForCost.modelPricing) || cacheReadTokens > 0
							? 0
							: inputTokens
					const cacheDiscountBase = computeCacheDiscountBase(eventForCost)

					const completedCalls = status === "completed" ? 1 : 0
					const failedCalls = status === "failed" ? 1 : 0
					const cancelledCalls = status === "cancelled" ? 1 : 0

					// Rebuild daily rollup
					this.updateRollup(db, {
						periodType: "daily",
						periodKey: dayBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Rebuild monthly rollup
					this.updateRollup(db, {
						periodType: "monthly",
						periodKey: monthBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Rebuild session_activity (without touching session_metadata)
					sessionActivityStmt.run({
						rootTaskId,
						day: dayBucket,
						costUsd,
						totalTokens,
						lastActivityMs: epochMs,
					})
				}

				afterSeq = (rows[rows.length - 1].seq as number) ?? afterSeq
			}

			// 4. Update schema version
			this.updateMeta(db, { schemaVersion: 2 })

			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/001",
				"Failed to migrate to schema v2 (local day bucket recompute)",
				err,
			)
		}
	}

	/**
	 * Migration v2 → v3: Backfill breakdown rollup rows and non-cancelled-only rollups.
	 *
	 * In v2, only aggregate rollup rows (axis='', root_task_id='') were stored.
	 * In v3, per-axis breakdown rows (axis='model'/'provider'/'mode') and
	 * non-cancelled-only rollup rows (root_task_id='__nc__') are also stored
	 * for fast snapshot assembly without scanning all events.
	 *
	 * This migration:
	 * 1. Deletes existing breakdown rows (axis != '') and non-cancelled rows
	 * 2. Reads all usage_events in batches and generates breakdown + non-cancelled rollups
	 * 3. Uses getEffectiveCost() for cost (matching computeEventDelta)
	 *
	 * Idempotent: running twice produces the same result (delete + rebuild).
	 */
	private migrateToV3(db: DatabaseSync): void {
		try {
			db.exec("BEGIN")

			// 1. Delete existing breakdown rows and non-cancelled rows
			db.exec("DELETE FROM stats_rollup WHERE axis != '' OR root_task_id = '__nc__'")

			// 2. Read all events in batches and rebuild breakdown + non-cancelled rollups
			let afterSeq = 0
			const batchSize = 1000

			while (true) {
				const rows = db
					.prepare(
						`SELECT seq, occurred_epoch_ms, timezone_offset_minutes, status, root_task_id,
						 provider, model, mode, model_pricing_json, usage_json, semantics_json, provenance
						 FROM usage_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
					)
					.all(afterSeq, batchSize) as Array<Record<string, unknown>>

				if (rows.length === 0) {
					break
				}

				for (const row of rows) {
					const epochMs = row.occurred_epoch_ms as number
					const tzOffset = row.timezone_offset_minutes as number
					const dayBucket = computeLocalDayBucket(epochMs, tzOffset)
					const monthBucket = dayBucket.slice(0, 7)
					const status = row.status as string
					const provider = row.provider as string
					const model = row.model as string
					const mode = row.mode as string
					const provenance = (row.provenance as string) ?? "live"
					const usage = JSON.parse(row.usage_json as string)
					const semantics = JSON.parse(row.semantics_json as string)

					const inputTokens = usage.inputTokens?.value ?? 0
					const outputTokens = usage.outputTokens?.value ?? 0
					const cacheReadTokens = usage.cacheReadTokens?.value ?? 0
					const cacheWriteTokens = usage.cacheWriteTokens?.value ?? 0
					const reasoningTokens = usage.reasoningTokens?.value ?? 0
					const totalTokens = usage.totalTokens?.value ?? inputTokens + outputTokens
					// Use getEffectiveCost for consistency with computeEventDelta
					const eventForCost = {
						provider,
						model,
						modelPricing: row.model_pricing_json
							? (JSON.parse(row.model_pricing_json as string) as UsageEventV1["modelPricing"])
							: undefined,
						usage: { ...usage },
					} as UsageEventV1
					const costUsd = getEffectiveCost(eventForCost)
					const cacheDiscountBase = computeCacheDiscountBase(eventForCost)
					const uncachedInputTokens = this.computeUncachedInputTokens(usage, semantics)
					const unreportedCacheInputTokens =
						providerReportsCache(provider, model, eventForCost.modelPricing) || cacheReadTokens > 0
							? 0
							: inputTokens

					const completedCalls = status === "completed" ? 1 : 0
					const failedCalls = status === "failed" ? 1 : 0
					const cancelledCalls = status === "cancelled" ? 1 : 0

					// Build breakdown rows for each axis
					const axisValues: Array<{ axis: string; axisValue: string }> = [
						{ axis: "model", axisValue: model },
						{ axis: "provider", axisValue: provider },
						{ axis: "mode", axisValue: mode },
					]

					for (const { axis, axisValue } of axisValues) {
						// Daily breakdown
						this.updateRollup(db, {
							periodType: "daily",
							periodKey: dayBucket,
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Monthly breakdown
						this.updateRollup(db, {
							periodType: "monthly",
							periodKey: monthBucket,
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Lifetime breakdown
						this.updateRollup(db, {
							periodType: "lifetime",
							periodKey: "all",
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})
					}

					// Non-cancelled-only rollups (root_task_id = '__nc__')
					if (status !== "cancelled") {
						// Daily non-cancelled
						this.updateRollup(db, {
							periodType: "daily",
							periodKey: dayBucket,
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Monthly non-cancelled
						this.updateRollup(db, {
							periodType: "monthly",
							periodKey: monthBucket,
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Lifetime non-cancelled
						this.updateRollup(db, {
							periodType: "lifetime",
							periodKey: "all",
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Non-cancelled breakdown rows for each axis
						for (const { axis, axisValue } of [
							{ axis: "model", axisValue: model },
							{ axis: "provider", axisValue: provider },
							{ axis: "mode", axisValue: mode },
						]) {
							// Daily non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "daily",
								periodKey: dayBucket,
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})

							// Monthly non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "monthly",
								periodKey: monthBucket,
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})

							// Lifetime non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "lifetime",
								periodKey: "all",
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})
						}
					}
				}

				afterSeq = (rows[rows.length - 1].seq as number) ?? afterSeq
			}

			// 3. Update schema version
			this.updateMeta(db, { schemaVersion: 3 })

			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError(
				"STATS_DB/migrate/001",
				"Failed to migrate to schema v3 (breakdown rollup backfill)",
				err,
			)
		}
	}

	// ── Public API: Rebuild Rollups ─────────────────────────────────────────

	/**
	 * Rebuilds all derived tables (stats_rollup, session_metadata, task_usage_metadata,
	 * session_activity)
	 * from the raw usage_events table.
	 *
	 * This is a self-contained, idempotent operation:
	 * 1. Deletes all rows from stats_rollup, session_metadata, task_usage_metadata,
	 *    and session_activity
	 * 2. Reads all usage_events in batches
	 * 3. Rebuilds: daily/monthly/lifetime aggregate rollups, breakdown rollups
	 *    (per model/provider/mode axis), non-cancelled rollups, root-session and
	 *    direct-task metadata projections, and session_activity
	 *
	 * Use case: when events were inserted before rollup tables were created
	 * (migration gap), or when rollup tables become stale/corrupt.
	 *
	 * Does NOT touch usage_events or stats_meta (schema version, generation).
	 */
	public rebuildRollupsFromEvents(): void {
		const db = this.getDb()

		try {
			db.exec("BEGIN")

			// 1. Delete all derived data
			db.exec("DELETE FROM stats_rollup")
			db.exec("DELETE FROM session_metadata")
			db.exec("DELETE FROM task_usage_metadata")
			db.exec("DELETE FROM session_activity")

			// 2. Read all events in batches and rebuild everything
			let afterSeq = 0
			const batchSize = 1000

			const sessionActivityStmt = db.prepare(`
				INSERT INTO session_activity (
					root_task_id, day, total_cost, total_tokens, event_count, last_activity_ms
				) VALUES (
					@rootTaskId, @day, @costUsd, @totalTokens, 1, @lastActivityMs
				)
				ON CONFLICT(root_task_id, day) DO UPDATE SET
					total_cost = total_cost + @costUsd,
					total_tokens = total_tokens + @totalTokens,
					event_count = event_count + 1,
					last_activity_ms = @lastActivityMs
			`)

			const sessionMetadataStmt = db.prepare(`
				INSERT INTO session_metadata (
					root_task_id, title, model, provider,
					total_cost, total_tokens, event_count, last_activity_ms
				) VALUES (
					@rootTaskId, '', @model, @provider,
					@costUsd, @totalTokens, 1, @lastActivityMs
				)
				ON CONFLICT(root_task_id) DO UPDATE SET
					total_cost = total_cost + @costUsd,
					total_tokens = total_tokens + @totalTokens,
					event_count = event_count + 1,
					last_activity_ms = @lastActivityMs,
					updated_at = datetime('now')
			`)

			const taskUsageMetadataStmt = db.prepare(`
				INSERT INTO task_usage_metadata (
					task_id, model, provider, total_cost, total_tokens, event_count, last_activity_ms,
					cache_discount_base
				) VALUES (
					@taskId, @model, @provider, @costUsd, @totalTokens, 1, @lastActivityMs,
					@cacheDiscountBase
				)
				ON CONFLICT(task_id) DO UPDATE SET
					total_cost = total_cost + @costUsd,
					total_tokens = total_tokens + @totalTokens,
					event_count = event_count + 1,
					model = CASE
						WHEN @lastActivityMs >= last_activity_ms THEN @model
						ELSE model
					END,
					provider = CASE
						WHEN @lastActivityMs >= last_activity_ms THEN @provider
						ELSE provider
					END,
					last_activity_ms = @lastActivityMs,
					cache_discount_base = cache_discount_base + @cacheDiscountBase
			`)

			// Backfill the per-event discount base onto usage_events itself so the
			// bounded task-usage SQL path can SUM it straight off the event rows.
			const eventDiscountBaseStmt = db.prepare(`
				UPDATE usage_events SET cache_discount_base = @cacheDiscountBase WHERE seq = @seq
			`)

			while (true) {
				const rows = db
					.prepare(
						`SELECT seq, occurred_epoch_ms, timezone_offset_minutes, status, task_id, root_task_id,
						 provider, model, mode, model_pricing_json, usage_json, semantics_json, provenance
						 FROM usage_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
					)
					.all(afterSeq, batchSize) as Array<Record<string, unknown>>

				if (rows.length === 0) {
					break
				}

				for (const row of rows) {
					const epochMs = row.occurred_epoch_ms as number
					const tzOffset = row.timezone_offset_minutes as number
					const dayBucket = computeLocalDayBucket(epochMs, tzOffset)
					const monthBucket = dayBucket.slice(0, 7)
					const taskId = row.task_id as string
					const rootTaskId = (row.root_task_id as string) ?? ""
					const status = row.status as string
					const provider = row.provider as string
					const model = row.model as string
					const mode = row.mode as string
					const usage = JSON.parse(row.usage_json as string)
					const semantics = JSON.parse(row.semantics_json as string)

					const inputTokens = usage.inputTokens?.value ?? 0
					const outputTokens = usage.outputTokens?.value ?? 0
					const cacheReadTokens = usage.cacheReadTokens?.value ?? 0
					const cacheWriteTokens = usage.cacheWriteTokens?.value ?? 0
					const reasoningTokens = usage.reasoningTokens?.value ?? 0
					const totalTokens = usage.totalTokens?.value ?? inputTokens + outputTokens
					// Use getEffectiveCost for consistency with computeEventDelta
					const eventForCost = {
						provider,
						model,
						modelPricing: row.model_pricing_json
							? (JSON.parse(row.model_pricing_json as string) as UsageEventV1["modelPricing"])
							: undefined,
						usage: { ...usage },
					} as UsageEventV1
					const costUsd = getEffectiveCost(eventForCost)
					const cacheDiscountBase = computeCacheDiscountBase(eventForCost)
					const uncachedInputTokens = this.computeUncachedInputTokens(usage, semantics)
					const unreportedCacheInputTokens =
						providerReportsCache(provider, model, eventForCost.modelPricing) || cacheReadTokens > 0
							? 0
							: inputTokens

					const completedCalls = status === "completed" ? 1 : 0
					const failedCalls = status === "failed" ? 1 : 0
					const cancelledCalls = status === "cancelled" ? 1 : 0

					// ── Aggregate rollups (axis='', root_task_id='') ──

					// Daily aggregate
					this.updateRollup(db, {
						periodType: "daily",
						periodKey: dayBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Monthly aggregate
					this.updateRollup(db, {
						periodType: "monthly",
						periodKey: monthBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Lifetime aggregate
					this.updateRollup(db, {
						periodType: "lifetime",
						periodKey: "all",
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// ── Breakdown rollups (per axis) ──

					const axisValues: Array<{ axis: string; axisValue: string }> = [
						{ axis: "model", axisValue: model },
						{ axis: "provider", axisValue: provider },
						{ axis: "mode", axisValue: mode },
					]

					for (const { axis, axisValue } of axisValues) {
						// Daily breakdown
						this.updateRollup(db, {
							periodType: "daily",
							periodKey: dayBucket,
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Monthly breakdown
						this.updateRollup(db, {
							periodType: "monthly",
							periodKey: monthBucket,
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Lifetime breakdown
						this.updateRollup(db, {
							periodType: "lifetime",
							periodKey: "all",
							rootTaskId: "",
							axis,
							axisValue,
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})
					}

					// ── Non-cancelled-only rollups (root_task_id='__nc__') ──

					if (status !== "cancelled") {
						// Daily non-cancelled aggregate
						this.updateRollup(db, {
							periodType: "daily",
							periodKey: dayBucket,
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Monthly non-cancelled aggregate
						this.updateRollup(db, {
							periodType: "monthly",
							periodKey: monthBucket,
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Lifetime non-cancelled aggregate
						this.updateRollup(db, {
							periodType: "lifetime",
							periodKey: "all",
							rootTaskId: NON_CANCELLED_KEY,
							axis: "",
							axisValue: "",
							eventCount: 1,
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})

						// Non-cancelled breakdown rows for each axis
						for (const { axis, axisValue } of axisValues) {
							// Daily non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "daily",
								periodKey: dayBucket,
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})

							// Monthly non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "monthly",
								periodKey: monthBucket,
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})

							// Lifetime non-cancelled breakdown
							this.updateRollup(db, {
								periodType: "lifetime",
								periodKey: "all",
								rootTaskId: NON_CANCELLED_KEY,
								axis,
								axisValue,
								eventCount: 1,
								completedCalls,
								failedCalls,
								cancelledCalls,
								inputTokens,
								outputTokens,
								cacheReadTokens,
								cacheWriteTokens,
								reasoningTokens,
								totalTokens,
								costUsd,
								uncachedInputTokens,
								unreportedCacheInputTokens,
								cacheDiscountBase,
							})
						}
					}

					// ── Metadata projections ──

					// Rebuild session_metadata (lifetime totals per root_task_id)
					sessionMetadataStmt.run({
						rootTaskId,
						model,
						provider,
						costUsd,
						totalTokens,
						lastActivityMs: epochMs,
					})

					// Rebuild direct task totals. Rows are processed by ascending sequence;
					// >= intentionally lets a later sequence win timestamp ties.
					taskUsageMetadataStmt.run({
						taskId,
						model,
						provider,
						costUsd,
						totalTokens,
						lastActivityMs: epochMs,
						cacheDiscountBase,
					})

					// Persist the recomputed discount base on the event row itself.
					eventDiscountBaseStmt.run({
						seq: row.seq as number,
						cacheDiscountBase,
					})

					// Rebuild session_activity (per-day per-root_task_id)
					sessionActivityStmt.run({
						rootTaskId,
						day: dayBucket,
						costUsd,
						totalTokens,
						lastActivityMs: epochMs,
					})
				}

				afterSeq = (rows[rows.length - 1].seq as number) ?? afterSeq
			}

			db.exec("COMMIT")
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError("STATS_DB/rebuild/001", "Failed to rebuild rollups from events", err)
		}
	}

	/**
	 * Returns the total number of rows in stats_rollup.
	 * Used by the stream coordinator to detect whether derived tables
	 * are empty (migration gap) without relying on heatmap all-zero
	 * detection (which is a legitimate state for inactive users).
	 */
	getRollupCount(): number {
		const db = this.getDb()
		try {
			const row = db.prepare("SELECT COUNT(*) as c FROM stats_rollup").get() as { c: number }
			return row.c
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query rollup count", err)
		}
	}

	// ── Public API: Append ─────────────────────────────────────────────────

	/**
	 * Appends an event idempotently within a single transaction.
	 * If the event identity (idempotency_key) already exists, it is ignored.
	 * Rollups and session projections are updated atomically.
	 *
	 * DatabaseSync is synchronous, so no async queue is needed.
	 * SQLite's own busy_timeout handles cross-process serialization.
	 *
	 * @returns AppendResult with inserted flag and assigned sequence
	 */
	append(event: UsageEventV1): AppendResult {
		return this.appendInternal(event)
	}

	/**
	 * Internal append logic. Runs in a single transaction.
	 */
	private appendInternal(event: UsageEventV1): AppendResult {
		const db = this.getDb()

		// Resolve root task ID
		const rootTaskId = event.rootTaskId ?? event.taskId

		// Compute epoch ms for indexing
		const occurredEpochMs = new Date(event.occurredAt).getTime()

		// Compute day bucket using local timezone (not UTC calendar date)
		const dayBucket = computeLocalDayBucket(occurredEpochMs, event.timezoneOffsetMinutes)
		const monthBucket = dayBucket.slice(0, 7) // YYYY-MM

		// Serialize usage and semantics as JSON
		const usageJson = JSON.stringify(event.usage)
		const semanticsJson = JSON.stringify(event.semantics)

		// Extract token values
		const inputTokens = event.usage.inputTokens?.value ?? 0
		const outputTokens = event.usage.outputTokens?.value ?? 0
		const cacheReadTokens = event.usage.cacheReadTokens?.value ?? 0
		const cacheWriteTokens = event.usage.cacheWriteTokens?.value ?? 0
		const reasoningTokens = event.usage.reasoningTokens?.value ?? 0
		const totalTokens = event.usage.totalTokens?.value ?? inputTokens + outputTokens
		// Use getEffectiveCost for rollup consistency with computeEventDelta
		const costUsd = getEffectiveCost(event)
		const uncachedInputTokens = this.computeUncachedInputTokens(event.usage, event.semantics)
		const unreportedCacheInputTokens =
			providerReportsCache(event.provider, event.model, event.modelPricing) || cacheReadTokens > 0
				? 0
				: inputTokens
		const cacheDiscountBase = computeCacheDiscountBase(event)

		const status = event.status
		const completedCalls = status === "completed" ? 1 : 0
		const failedCalls = status === "failed" ? 1 : 0
		const cancelledCalls = status === "cancelled" ? 1 : 0

		try {
			db.exec("BEGIN")

			// Idempotent insert: INSERT OR IGNORE on unique idempotency_key
			const insertStmt = db.prepare(`
				INSERT OR IGNORE INTO usage_events (
						event_id, idempotency_key, occurred_at, occurred_epoch_ms,
						timezone_offset_minutes, status, attempt,
						task_id, parent_task_id, root_task_id,
						provider, model, mode, endpoint, model_pricing_json,
						usage_json, semantics_json, provenance, schema_version,
						cache_discount_base
					) VALUES (
						@eventId, @idempotencyKey, @occurredAt, @occurredEpochMs,
						@timezoneOffsetMinutes, @status, @attempt,
						@taskId, @parentTaskId, @rootTaskId,
						@provider, @model, @mode, @endpoint, @modelPricingJson,
						@usageJson, @semanticsJson, @provenance, @schemaVersion,
						@cacheDiscountBase
					)
			`)

			const insertResult = insertStmt.run({
				eventId: event.eventId,
				idempotencyKey: event.idempotencyKey,
				occurredAt: event.occurredAt,
				occurredEpochMs,
				timezoneOffsetMinutes: event.timezoneOffsetMinutes,
				status: event.status,
				attempt: event.attempt,
				taskId: event.taskId,
				parentTaskId: event.parentTaskId ?? null,
				rootTaskId,
				provider: event.provider,
				model: event.model,
				mode: event.mode,
				endpoint: event.endpoint ?? null,
				usageJson,
				semanticsJson,
				provenance: event.provenance,
				schemaVersion: event.schemaVersion,
				cacheDiscountBase,
				modelPricingJson: event.modelPricing ? JSON.stringify(event.modelPricing) : null,
			})

			const inserted = insertResult.changes > 0

			let sequence: number

			if (inserted) {
				// Get the auto-incremented sequence
				const row = db
					.prepare("SELECT seq FROM usage_events WHERE idempotency_key = ?")
					.get(event.idempotencyKey) as { seq: number }
				sequence = row.seq

				// Update rollups: daily
				this.updateRollup(db, {
					periodType: "daily",
					periodKey: dayBucket,
					rootTaskId: "",
					axis: "",
					axisValue: "",
					eventCount: 1,
					completedCalls,
					failedCalls,
					cancelledCalls,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					reasoningTokens,
					totalTokens,
					costUsd,
					uncachedInputTokens,
					unreportedCacheInputTokens,
					cacheDiscountBase,
				})

				// Update rollups: monthly
				this.updateRollup(db, {
					periodType: "monthly",
					periodKey: monthBucket,
					rootTaskId: "",
					axis: "",
					axisValue: "",
					eventCount: 1,
					completedCalls,
					failedCalls,
					cancelledCalls,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					reasoningTokens,
					totalTokens,
					costUsd,
					uncachedInputTokens,
					unreportedCacheInputTokens,
					cacheDiscountBase,
				})

				// Update rollups: lifetime
				this.updateRollup(db, {
					periodType: "lifetime",
					periodKey: "all",
					rootTaskId: "",
					axis: "",
					axisValue: "",
					eventCount: 1,
					completedCalls,
					failedCalls,
					cancelledCalls,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					reasoningTokens,
					totalTokens,
					costUsd,
					uncachedInputTokens,
					unreportedCacheInputTokens,
					cacheDiscountBase,
				})

				// Update breakdown rollups for each supported axis
				this.updateBreakdownRollups(db, event, dayBucket, monthBucket, {
					completedCalls,
					failedCalls,
					cancelledCalls,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					reasoningTokens,
					totalTokens,
					costUsd,
					uncachedInputTokens,
					unreportedCacheInputTokens,
					cacheDiscountBase,
				})

				// Update non-cancelled-only rollups (root_task_id = '__nc__')
				if (status !== "cancelled") {
					this.updateNonCancelledRollups(db, dayBucket, monthBucket, {
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})
				}

				// Update root-session and direct-task projections.
				this.upsertSession(db, {
					rootTaskId,
					model: event.model,
					provider: event.provider,
					costUsd,
					totalTokens,
					lastActivityMs: occurredEpochMs,
					dayBucket,
				})
				this.upsertTaskUsage(db, {
					taskId: event.taskId,
					model: event.model,
					provider: event.provider,
					costUsd,
					totalTokens,
					lastActivityMs: occurredEpochMs,
					cacheDiscountBase,
				})

				// Update last sequence in meta
				this.updateMeta(db, { lastSequence: sequence })
			} else {
				// Duplicate: fetch existing sequence
				const row = db
					.prepare("SELECT seq FROM usage_events WHERE idempotency_key = ?")
					.get(event.idempotencyKey) as { seq: number }
				sequence = row.seq
			}

			db.exec("COMMIT")

			return { inserted, sequence }
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore rollback errors
			}
			throw new StatsDbError("STATS_DB/append/001", `Failed to append event ${event.eventId}`, err)
		}
	}

	/**
	 * Bulk appends multiple events in a single transaction for performance.
	 * Each event is still idempotent (INSERT OR IGNORE on idempotency_key).
	 * Rollups and session projections are updated atomically for all events.
	 *
	 * @returns Number of newly inserted events
	 */
	bulkAppend(events: UsageEventV1[]): number {
		if (events.length === 0) {
			return 0
		}

		const db = this.getDb()
		let insertedCount = 0

		try {
			db.exec("BEGIN")

			for (const event of events) {
				const rootTaskId = event.rootTaskId ?? event.taskId
				const occurredEpochMs = new Date(event.occurredAt).getTime()
				const dayBucket = computeLocalDayBucket(occurredEpochMs, event.timezoneOffsetMinutes)
				const monthBucket = dayBucket.slice(0, 7) // YYYY-MM
				const usageJson = JSON.stringify(event.usage)
				const semanticsJson = JSON.stringify(event.semantics)

				const inputTokens = event.usage.inputTokens?.value ?? 0
				const outputTokens = event.usage.outputTokens?.value ?? 0
				const cacheReadTokens = event.usage.cacheReadTokens?.value ?? 0
				const cacheWriteTokens = event.usage.cacheWriteTokens?.value ?? 0
				const reasoningTokens = event.usage.reasoningTokens?.value ?? 0
				const totalTokens = event.usage.totalTokens?.value ?? inputTokens + outputTokens
				// Use getEffectiveCost for rollup consistency with computeEventDelta
				const costUsd = getEffectiveCost(event)
				const uncachedInputTokens = this.computeUncachedInputTokens(event.usage, event.semantics)
				const unreportedCacheInputTokens =
					providerReportsCache(event.provider, event.model, event.modelPricing) || cacheReadTokens > 0
						? 0
						: inputTokens
				const cacheDiscountBase = computeCacheDiscountBase(event)

				const status = event.status
				const completedCalls = status === "completed" ? 1 : 0
				const failedCalls = status === "failed" ? 1 : 0
				const cancelledCalls = status === "cancelled" ? 1 : 0

				const insertStmt = db.prepare(`
					INSERT OR IGNORE INTO usage_events (
							event_id, idempotency_key, occurred_at, occurred_epoch_ms,
							timezone_offset_minutes, status, attempt,
							task_id, parent_task_id, root_task_id,
							provider, model, mode, endpoint, model_pricing_json,
							usage_json, semantics_json, provenance, schema_version,
							cache_discount_base
						) VALUES (
							@eventId, @idempotencyKey, @occurredAt, @occurredEpochMs,
							@timezoneOffsetMinutes, @status, @attempt,
							@taskId, @parentTaskId, @rootTaskId,
							@provider, @model, @mode, @endpoint, @modelPricingJson,
							@usageJson, @semanticsJson, @provenance, @schemaVersion,
							@cacheDiscountBase
						)
				`)

				const insertResult = insertStmt.run({
					eventId: event.eventId,
					idempotencyKey: event.idempotencyKey,
					occurredAt: event.occurredAt,
					occurredEpochMs,
					timezoneOffsetMinutes: event.timezoneOffsetMinutes,
					status: event.status,
					attempt: event.attempt,
					taskId: event.taskId,
					parentTaskId: event.parentTaskId ?? null,
					rootTaskId,
					provider: event.provider,
					model: event.model,
					mode: event.mode,
					endpoint: event.endpoint ?? null,
					usageJson,
					semanticsJson,
					provenance: event.provenance,
					schemaVersion: event.schemaVersion,
					cacheDiscountBase,
					modelPricingJson: event.modelPricing ? JSON.stringify(event.modelPricing) : null,
				})

				if (insertResult.changes > 0) {
					insertedCount++

					const row = db
						.prepare("SELECT seq FROM usage_events WHERE idempotency_key = ?")
						.get(event.idempotencyKey) as { seq: number }
					const sequence = row.seq

					// Update rollups: daily
					this.updateRollup(db, {
						periodType: "daily",
						periodKey: dayBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Update rollups: monthly
					this.updateRollup(db, {
						periodType: "monthly",
						periodKey: monthBucket,
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Update rollups: lifetime
					this.updateRollup(db, {
						periodType: "lifetime",
						periodKey: "all",
						rootTaskId: "",
						axis: "",
						axisValue: "",
						eventCount: 1,
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Update breakdown rollups for each supported axis
					this.updateBreakdownRollups(db, event, dayBucket, monthBucket, {
						completedCalls,
						failedCalls,
						cancelledCalls,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						reasoningTokens,
						totalTokens,
						costUsd,
						uncachedInputTokens,
						unreportedCacheInputTokens,
						cacheDiscountBase,
					})

					// Update non-cancelled-only rollups
					if (status !== "cancelled") {
						this.updateNonCancelledRollups(db, dayBucket, monthBucket, {
							completedCalls,
							failedCalls,
							cancelledCalls,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							reasoningTokens,
							totalTokens,
							costUsd,
							uncachedInputTokens,
							unreportedCacheInputTokens,
							cacheDiscountBase,
						})
					}

					// Update root-session and direct-task projections.
					this.upsertSession(db, {
						rootTaskId,
						model: event.model,
						provider: event.provider,
						costUsd,
						totalTokens,
						lastActivityMs: occurredEpochMs,
						dayBucket,
					})
					this.upsertTaskUsage(db, {
						taskId: event.taskId,
						model: event.model,
						provider: event.provider,
						costUsd,
						totalTokens,
						lastActivityMs: occurredEpochMs,
						cacheDiscountBase,
					})

					this.updateMeta(db, { lastSequence: sequence })
				}
			}

			db.exec("COMMIT")
			return insertedCount
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore
			}
			throw new StatsDbError("STATS_DB/append/001", `Failed to bulk append ${events.length} events`, err)
		}
	}

	// ── Public API: Read ───────────────────────────────────────────────────

	/**
	 * Reads events by sequence cursor, bounded to MAX_BATCH_SIZE.
	 * Returns events with sequence > afterSequence in ascending order.
	 */
	readEventsAfter(afterSequence: number, limit: number = MAX_BATCH_SIZE): EventBatch {
		const db = this.getDb()
		const boundedLimit = Math.min(limit, MAX_BATCH_SIZE)

		try {
			const rows = db
				.prepare(`SELECT * FROM usage_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
				.all(afterSequence, boundedLimit) as Array<Record<string, unknown>>

			const events = rows.map((row) => this.rowToEvent(row))

			// Check if more exist
			const lastSeq = rows.length > 0 ? (rows[rows.length - 1].seq as number) : afterSequence
			const moreRows = db.prepare("SELECT COUNT(*) as c FROM usage_events WHERE seq > ?").get(lastSeq) as {
				c: number
			}

			return {
				events,
				hasMore: moreRows.c > 0,
			}
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", `Failed to read events after sequence ${afterSequence}`, err)
		}
	}

	/**
	 * Reads all events in bounded batches. Useful for migration and rebuilds.
	 * Returns an async iterator yielding batches.
	 */
	*readAllBatches(batchSize: number = MAX_BATCH_SIZE): Generator<EventBatch> {
		const boundedSize = Math.min(batchSize, MAX_BATCH_SIZE)
		let afterSeq = 0

		while (true) {
			const batch = this.readEventsAfter(afterSeq, boundedSize)
			if (batch.events.length === 0) {
				break
			}
			yield batch
			afterSeq = batch.events[batch.events.length - 1].sequence
			if (!batch.hasMore) {
				break
			}
		}
	}

	/**
	 * Reads all events as an array. For compatibility with existing callers.
	 * Uses bounded batches internally.
	 */
	readAllEvents(): Array<UsageEventV1 & { sequence: number }> {
		const events: Array<UsageEventV1 & { sequence: number }> = []
		for (const batch of this.readAllBatches()) {
			events.push(...batch.events)
		}
		return events
	}

	/**
	 * Reads events within a half-open occurred-time range [fromMs, toMs) as an
	 * array, in ascending sequence order. Uses bounded batches internally; the
	 * range filter rides the idx_usage_events_occurred index. Pass 0 /
	 * Number.MAX_SAFE_INTEGER for an unbounded read.
	 */
	readEventsInRange(fromMs: number, toMs: number): Array<UsageEventV1 & { sequence: number }> {
		const db = this.getDb()
		const events: Array<UsageEventV1 & { sequence: number }> = []

		try {
			const stmt = db.prepare(
				`SELECT * FROM usage_events
				 WHERE occurred_epoch_ms >= ? AND occurred_epoch_ms < ? AND seq > ?
				 ORDER BY seq ASC LIMIT ?`,
			)

			let afterSeq = 0
			while (true) {
				const rows = stmt.all(fromMs, toMs, afterSeq, MAX_BATCH_SIZE) as Array<Record<string, unknown>>
				if (rows.length === 0) {
					break
				}
				events.push(...rows.map((row) => this.rowToEvent(row)))
				afterSeq = rows[rows.length - 1].seq as number
				if (rows.length < MAX_BATCH_SIZE) {
					break
				}
			}

			return events
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", `Failed to read events in range [${fromMs}, ${toMs})`, err)
		}
	}

	/**
	 * Reads direct-task usage summaries without scanning the event log.
	 * Each SQLite query is chunked below the parameter ceiling. The returned map
	 * always contains every requested task ID, using zero metrics for no-event
	 * tasks so callers can compose task trees without per-task fallbacks.
	 *
	 * When `rangeMs` is bounded, totals are aggregated from the raw usage_events
	 * rows whose `occurred_epoch_ms` falls inside the half-open range, because
	 * the task_usage_metadata projection only holds all-time totals. The
	 * aggregation mirrors upsertTaskUsage exactly: cancelled events are
	 * included, cost uses getEffectiveCost, and model/provider come from the
	 * in-range event with the latest occurred timestamp. An absent or
	 * unbounded range keeps the metadata-table fast path.
	 */
	queryTaskUsageByTaskIds(taskIds: string[], rangeMs?: StatsQueryRangeMs): Map<string, TaskUsageRow> {
		const db = this.getDb()
		const uniqueTaskIds = [...new Set(taskIds)]
		const result = new Map<string, TaskUsageRow>(
			uniqueTaskIds.map((taskId) => [taskId, createZeroTaskUsageRow(taskId)]),
		)

		if (isStatsQueryRangeBounded(rangeMs)) {
			try {
				for (let start = 0; start < uniqueTaskIds.length; start += TASK_ID_QUERY_CHUNK_SIZE) {
					const chunk = uniqueTaskIds.slice(start, start + TASK_ID_QUERY_CHUNK_SIZE)
					const placeholders = chunk.map(() => "?").join(", ")

					let rangeSql = ""
					const params: Array<string | number> = [...chunk]
					if (rangeMs?.fromMs !== undefined) {
						rangeSql += " AND occurred_epoch_ms >= ?"
						params.push(rangeMs.fromMs)
					}
					if (rangeMs?.toMs !== undefined) {
						rangeSql += " AND occurred_epoch_ms < ?"
						params.push(rangeMs.toMs)
					}

					// Token/cost sums are aggregated in SQL straight off usage_json,
					// so matching rows are never deserialized. The total_tokens
					// expression mirrors the JS fallback chain exactly
					// (totalTokens?.value ?? input + output).
					const aggregateRows = db
						.prepare(
							`SELECT task_id,
								COUNT(*) as event_count,
								SUM(COALESCE(json_extract(usage_json, '$.totalTokens.value'),
									COALESCE(json_extract(usage_json, '$.inputTokens.value'), 0) +
									COALESCE(json_extract(usage_json, '$.outputTokens.value'), 0))) as total_tokens,
								SUM(COALESCE(json_extract(usage_json, '$.costUsd.value'), 0)) as stored_cost,
								SUM(cache_discount_base) as cache_discount_base,
								SUM(CASE WHEN json_extract(usage_json, '$.costUsd.value') IS NULL THEN 1 ELSE 0 END) as missing_cost_count
							 FROM usage_events
							 WHERE task_id IN (${placeholders})${rangeSql}
							 GROUP BY task_id`,
						)
						.all(...params) as Array<Record<string, unknown>>

					for (const row of aggregateRows) {
						const taskRow = result.get(row.task_id as string)!
						taskRow.eventCount = row.event_count as number
						taskRow.totalTokens = row.total_tokens as number
						taskRow.totalCost = row.stored_cost as number
						taskRow.cacheDiscountBase = (row.cache_discount_base as number) ?? 0
					}

					// Latest-activity metadata mirrors the append-time upsert
					// exactly: lastActivity comes from the highest-sequence in-range
					// event (the upsert overwrites it unconditionally), while
					// model/provider come from the last event whose occurred
					// timestamp is >= its in-range sequence predecessor's (the
					// upsert's >= comparison against the previously stored value).
					const metaRows = db
						.prepare(
							`SELECT task_id,
								MAX(CASE WHEN seq_rn = 1 THEN occurred_epoch_ms END) as last_activity,
								MAX(CASE WHEN meta_rn = 1 THEN model END) as model,
								MAX(CASE WHEN meta_rn = 1 THEN provider END) as provider
							 FROM (
								SELECT task_id, model, provider, occurred_epoch_ms,
									ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY seq DESC) as seq_rn,
									ROW_NUMBER() OVER (
										PARTITION BY task_id
										ORDER BY CASE WHEN occurred_epoch_ms >= prev_occurred THEN 0 ELSE 1 END, seq DESC
									) as meta_rn
								FROM (
									SELECT task_id, model, provider, occurred_epoch_ms, seq,
										LAG(occurred_epoch_ms, 1, -1) OVER (PARTITION BY task_id ORDER BY seq ASC) as prev_occurred
									FROM usage_events
									WHERE task_id IN (${placeholders})${rangeSql}
								)
							 )
							 GROUP BY task_id`,
						)
						.all(...params) as Array<Record<string, unknown>>

					for (const row of metaRows) {
						const taskRow = result.get(row.task_id as string)!
						taskRow.lastActivity = row.last_activity as number
						taskRow.model = row.model as string
						taskRow.provider = row.provider as string
					}

					// Events without a stored cost need getEffectiveCost recalc
					// (model pricing lookup) — deserialize only those rows.
					if (aggregateRows.some((row) => (row.missing_cost_count as number) > 0)) {
						const missingCostRows = db
							.prepare(
								`SELECT * FROM usage_events
								 WHERE task_id IN (${placeholders})${rangeSql}
								 AND json_extract(usage_json, '$.costUsd.value') IS NULL
								 ORDER BY seq ASC`,
							)
							.all(...params) as Array<Record<string, unknown>>

						for (const row of missingCostRows) {
							const event = this.rowToEvent(row)
							result.get(event.taskId)!.totalCost += getEffectiveCost(event)
						}
					}
				}
				return result
			} catch (err) {
				throw new StatsDbError("STATS_DB/read/001", "Failed to query ranged task usage", err)
			}
		}

		try {
			for (let start = 0; start < uniqueTaskIds.length; start += TASK_ID_QUERY_CHUNK_SIZE) {
				const chunk = uniqueTaskIds.slice(start, start + TASK_ID_QUERY_CHUNK_SIZE)
				const placeholders = chunk.map(() => "?").join(", ")
				const rows = db
					.prepare(
						`SELECT task_id, total_cost, total_tokens, event_count, last_activity_ms, model, provider,
							cache_discount_base
						 FROM task_usage_metadata
						 WHERE task_id IN (${placeholders})`,
					)
					.all(...chunk) as Array<Record<string, unknown>>

				for (const row of rows) {
					const taskId = row.task_id as string
					result.set(taskId, {
						taskId,
						totalCost: row.total_cost as number,
						totalTokens: row.total_tokens as number,
						eventCount: row.event_count as number,
						lastActivity: row.last_activity_ms as number,
						model: row.model as string,
						provider: row.provider as string,
						cacheDiscountBase: (row.cache_discount_base as number) ?? 0,
					})
				}
			}

			return result
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query task usage metadata", err)
		}
	}

	/**
	 * Reads per-task identity aggregates (input/output token sums plus the
	 * distinct models and modes used) in one grouped pass over usage_events.
	 * Each SQLite query is chunked below the parameter ceiling. The returned map
	 * always contains every requested task ID, using zero metrics and empty
	 * lists for no-event tasks so callers can compose task trees without
	 * per-task fallbacks.
	 *
	 * When `rangeMs` carries bounds, only rows whose `occurred_epoch_ms` falls
	 * inside the half-open range are aggregated. Distinct models/modes come
	 * from GROUP_CONCAT, whose order is unspecified; callers that need
	 * first-seen order must re-union the per-task lists deterministically.
	 */
	queryTaskIdentityAggregates(taskIds: string[], rangeMs?: StatsQueryRangeMs): Map<string, TaskIdentityAggregate> {
		const db = this.getDb()
		const uniqueTaskIds = [...new Set(taskIds)]
		const result = new Map<string, TaskIdentityAggregate>(
			uniqueTaskIds.map((taskId) => [taskId, { inputTokens: 0, outputTokens: 0, models: [], modes: [] }]),
		)

		try {
			for (let start = 0; start < uniqueTaskIds.length; start += TASK_ID_QUERY_CHUNK_SIZE) {
				const chunk = uniqueTaskIds.slice(start, start + TASK_ID_QUERY_CHUNK_SIZE)
				const placeholders = chunk.map(() => "?").join(", ")

				let rangeSql = ""
				const params: Array<string | number> = [...chunk]
				if (rangeMs?.fromMs !== undefined) {
					rangeSql += " AND occurred_epoch_ms >= ?"
					params.push(rangeMs.fromMs)
				}
				if (rangeMs?.toMs !== undefined) {
					rangeSql += " AND occurred_epoch_ms < ?"
					params.push(rangeMs.toMs)
				}

				// NULLIF drops empty model/mode strings from the distinct lists
				// (GROUP_CONCAT ignores NULLs). Model and mode names never contain
				// commas, so the default ',' separator splits back unambiguously.
				const rows = db
					.prepare(
						`SELECT task_id,
							SUM(COALESCE(json_extract(usage_json, '$.inputTokens.value'), 0)) as input_tokens,
							SUM(COALESCE(json_extract(usage_json, '$.outputTokens.value'), 0)) as output_tokens,
							GROUP_CONCAT(DISTINCT NULLIF(model, '')) as models,
							GROUP_CONCAT(DISTINCT NULLIF(mode, '')) as modes
						 FROM usage_events
						 WHERE task_id IN (${placeholders})${rangeSql}
						 GROUP BY task_id`,
					)
					.all(...params) as Array<Record<string, unknown>>

				for (const row of rows) {
					result.set(row.task_id as string, {
						inputTokens: row.input_tokens as number,
						outputTokens: row.output_tokens as number,
						models: splitGroupConcat(row.models),
						modes: splitGroupConcat(row.modes),
					})
				}
			}

			return result
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query task identity aggregates", err)
		}
	}

	/**
	 * Reads events for direct task IDs using the task index, without an
	 * unbounded full-log read. Result order matches the global event sequence.
	 * When `rangeMs` is bounded, only events whose `occurred_epoch_ms` falls
	 * inside the half-open range are returned; status inclusion is unchanged.
	 */
	queryEventsByTaskIds(taskIds: string[], rangeMs?: StatsQueryRangeMs): Array<UsageEventV1 & { sequence: number }> {
		const db = this.getDb()
		const uniqueTaskIds = [...new Set(taskIds)]
		const events: Array<UsageEventV1 & { sequence: number }> = []

		try {
			for (let start = 0; start < uniqueTaskIds.length; start += TASK_ID_QUERY_CHUNK_SIZE) {
				const chunk = uniqueTaskIds.slice(start, start + TASK_ID_QUERY_CHUNK_SIZE)
				const placeholders = chunk.map(() => "?").join(", ")
				let sql = `SELECT * FROM usage_events WHERE task_id IN (${placeholders})`
				const params: Array<string | number> = [...chunk]
				if (rangeMs?.fromMs !== undefined) {
					sql += " AND occurred_epoch_ms >= ?"
					params.push(rangeMs.fromMs)
				}
				if (rangeMs?.toMs !== undefined) {
					sql += " AND occurred_epoch_ms < ?"
					params.push(rangeMs.toMs)
				}
				sql += " ORDER BY seq ASC"
				const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
				events.push(...rows.map((row) => this.rowToEvent(row)))
			}

			return events.sort((left, right) => left.sequence - right.sequence)
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query events by task IDs", err)
		}
	}

	// ── Public API: Session Projections ────────────────────────────────────

	/**
	 * Queries session summaries with cursor pagination.
	 * Sessions are ordered by last activity descending.
	 *
	 * @param limit Page size (1-100)
	 * @param cursor Opaque cursor from a previous page. Absent for first page.
	 */
	querySessions(limit: number = 50, cursor?: string): SessionPage {
		const db = this.getDb()
		const boundedLimit = Math.min(Math.max(1, limit), MAX_BATCH_SIZE)

		try {
			// Decode cursor: it's the last_activity_ms of the last row
			let cursorCondition = ""
			const params: Array<string | number> = [boundedLimit]

			if (cursor) {
				const cursorMs = parseInt(cursor, 10)
				if (isNaN(cursorMs)) {
					throw new StatsDbError("STATS_DB/read/001", `Invalid session cursor: ${cursor}`)
				}
				cursorCondition = "WHERE last_activity_ms < ?"
				params.unshift(cursorMs)
			}

			const rows = db
				.prepare(
					`SELECT root_task_id, title, total_cost, total_tokens, model, provider,
						last_activity_ms, event_count
					 FROM session_metadata
					 ${cursorCondition}
					 ORDER BY last_activity_ms DESC
					 LIMIT ?`,
				)
				.all(...params) as Array<Record<string, unknown>>

			const sessions: SessionRow[] = rows.map((row) => ({
				rootTaskId: row.root_task_id as string,
				title: row.title as string,
				totalCost: row.total_cost as number,
				totalTokens: row.total_tokens as number,
				model: row.model as string,
				provider: row.provider as string,
				lastActivity: row.last_activity_ms as number,
				eventCount: row.event_count as number,
			}))

			// Total estimate
			const countRow = db.prepare("SELECT COUNT(*) as c FROM session_metadata").get() as {
				c: number
			}

			// Next cursor
			let nextCursor: string | undefined
			if (sessions.length === boundedLimit) {
				const lastActivity = sessions[sessions.length - 1].lastActivity
				// Check if more rows exist
				const moreRow = db
					.prepare("SELECT COUNT(*) as c FROM session_metadata WHERE last_activity_ms < ?")
					.get(lastActivity) as { c: number }
				if (moreRow.c > 0) {
					nextCursor = String(lastActivity)
				}
			}

			return {
				sessions,
				cursor: nextCursor,
				totalEstimate: countRow.c,
			}
		} catch (err) {
			if (err instanceof StatsDbError) {
				throw err
			}
			throw new StatsDbError("STATS_DB/read/001", "Failed to query sessions", err)
		}
	}

	// ── Public API: Rollups ───────────────────────────────────────────────

	/**
	 * Reads daily rollup values for a range of days.
	 * Returns one row per day, oldest first.
	 */
	queryDailyRollups(fromDay: string, toDay: string): DailyRollupRow[] {
		const db = this.getDb()

		try {
			const rows = db
				.prepare(
					`SELECT period_key as day, cost_usd as total_cost, total_tokens, event_count
					 FROM stats_rollup
					 WHERE period_type = 'daily' AND root_task_id = '' AND axis = ''
					 AND period_key >= ? AND period_key <= ?
					 ORDER BY period_key ASC`,
				)
				.all(fromDay, toDay) as Array<Record<string, unknown>>

			return rows.map((row) => ({
				day: row.day as string,
				totalCost: row.total_cost as number,
				totalTokens: row.total_tokens as number,
				eventCount: row.event_count as number,
			}))
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/read/001",
				`Failed to query daily rollups from ${fromDay} to ${toDay}`,
				err,
			)
		}
	}

	/**
	 * Reads the lifetime totals rollup.
	 */
	queryLifetimeTotals(): {
		eventCount: number
		totalCost: number
		totalTokens: number
		inputTokens: number
		outputTokens: number
		cacheReadTokens: number
		cacheWriteTokens: number
		reasoningTokens: number
		completedCalls: number
		failedCalls: number
		cancelledCalls: number
	} {
		const db = this.getDb()

		try {
			const row = db
				.prepare(
					`SELECT event_count, cost_usd as total_cost, total_tokens,
						input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
						reasoning_tokens, completed_calls, failed_calls, cancelled_calls
					 FROM stats_rollup
					 WHERE period_type = 'lifetime' AND root_task_id = '' AND axis = ''
					 AND period_key = 'all'`,
				)
				.get() as Record<string, unknown> | undefined

			if (!row) {
				return {
					eventCount: 0,
					totalCost: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					completedCalls: 0,
					failedCalls: 0,
					cancelledCalls: 0,
				}
			}

			return {
				eventCount: row.event_count as number,
				totalCost: row.total_cost as number,
				totalTokens: row.total_tokens as number,
				inputTokens: row.input_tokens as number,
				outputTokens: row.output_tokens as number,
				cacheReadTokens: row.cache_read_tokens as number,
				cacheWriteTokens: row.cache_write_tokens as number,
				reasoningTokens: row.reasoning_tokens as number,
				completedCalls: row.completed_calls as number,
				failedCalls: row.failed_calls as number,
				cancelledCalls: row.cancelled_calls as number,
			}
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query lifetime totals", err)
		}
	}

	/**
	 * Queries breakdown rollup rows for a specific axis within a time range.
	 * Returns one row per axis_value, ordered by total_tokens descending.
	 *
	 * @param periodType 'daily', 'monthly', or 'lifetime'
	 * @param fromKey Period key range start (inclusive). Use 'all' for lifetime.
	 * @param toKey Period key range end (inclusive). Use 'all' for lifetime.
	 * @param axis The breakdown axis ('model', 'provider', 'mode')
	 * @param includeCancelled If true, queries aggregate rows (root_task_id='').
	 *                         If false, queries non-cancelled rows (root_task_id='__nc__').
	 */
	queryBreakdownRollups(
		periodType: string,
		fromKey: string,
		toKey: string,
		axis: string,
		includeCancelled: boolean = false,
	): BreakdownRollupRow[] {
		const db = this.getDb()
		const rootTaskId = includeCancelled ? "" : NON_CANCELLED_KEY

		try {
			let rows: Array<Record<string, unknown>>

			if (periodType === "lifetime") {
				rows = db
					.prepare(
						`SELECT axis_value, event_count, completed_calls, failed_calls, cancelled_calls,
							input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
							reasoning_tokens, total_tokens, cost_usd, uncached_input_tokens,
							unreported_cache_input_tokens, cache_discount_base
						 FROM stats_rollup
						 WHERE period_type = 'lifetime' AND period_key = 'all'
						 AND root_task_id = ? AND axis = ?
						 ORDER BY total_tokens DESC`,
					)
					.all(rootTaskId, axis) as Array<Record<string, unknown>>
			} else {
				rows = db
					.prepare(
						`SELECT axis_value,
							SUM(event_count) as event_count,
							SUM(completed_calls) as completed_calls,
							SUM(failed_calls) as failed_calls,
							SUM(cancelled_calls) as cancelled_calls,
							SUM(input_tokens) as input_tokens,
							SUM(output_tokens) as output_tokens,
							SUM(cache_read_tokens) as cache_read_tokens,
							SUM(cache_write_tokens) as cache_write_tokens,
							SUM(reasoning_tokens) as reasoning_tokens,
							SUM(total_tokens) as total_tokens,
							SUM(cost_usd) as cost_usd,
							SUM(uncached_input_tokens) as uncached_input_tokens,
							SUM(unreported_cache_input_tokens) as unreported_cache_input_tokens,
							SUM(cache_discount_base) as cache_discount_base
						 FROM stats_rollup
						 WHERE period_type = ? AND root_task_id = ? AND axis = ?
						 AND period_key >= ? AND period_key <= ?
						 GROUP BY axis_value
						 ORDER BY total_tokens DESC`,
					)
					.all(periodType, rootTaskId, axis, fromKey, toKey) as Array<Record<string, unknown>>
			}

			return rows.map((row) => ({
				axisValue: row.axis_value as string,
				eventCount: row.event_count as number,
				completedCalls: row.completed_calls as number,
				failedCalls: row.failed_calls as number,
				cancelledCalls: row.cancelled_calls as number,
				inputTokens: row.input_tokens as number,
				outputTokens: row.output_tokens as number,
				cacheReadTokens: row.cache_read_tokens as number,
				cacheWriteTokens: row.cache_write_tokens as number,
				reasoningTokens: row.reasoning_tokens as number,
				totalTokens: row.total_tokens as number,
				costUsd: row.cost_usd as number,
				uncachedInputTokens: (row.uncached_input_tokens as number) ?? 0,
				unreportedCacheInputTokens: (row.unreported_cache_input_tokens as number) ?? 0,
				cacheDiscountBase: (row.cache_discount_base as number) ?? 0,
			}))
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", `Failed to query breakdown rollups for axis ${axis}`, err)
		}
	}

	/**
	 * Queries detailed daily rollup rows (with all token breakdowns) for a range.
	 * Returns one row per day, oldest first.
	 *
	 * @param fromDay Start day (YYYY-MM-DD, inclusive)
	 * @param toDay End day (YYYY-MM-DD, inclusive)
	 * @param includeCancelled If true, queries aggregate rows. If false, non-cancelled.
	 */
	queryDailyRollupsDetailed(
		fromDay: string,
		toDay: string,
		includeCancelled: boolean = false,
	): DailyRollupDetailedRow[] {
		const db = this.getDb()
		const rootTaskId = includeCancelled ? "" : NON_CANCELLED_KEY

		try {
			const rows = db
				.prepare(
					`SELECT period_key as day, event_count, completed_calls, failed_calls, cancelled_calls,
						input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
						reasoning_tokens, total_tokens, cost_usd, uncached_input_tokens,
						unreported_cache_input_tokens, cache_discount_base
					 FROM stats_rollup
					 WHERE period_type = 'daily' AND root_task_id = ? AND axis = ''
					 AND period_key >= ? AND period_key <= ?
					 ORDER BY period_key ASC`,
				)
				.all(rootTaskId, fromDay, toDay) as Array<Record<string, unknown>>

			return rows.map((row) => ({
				day: row.day as string,
				eventCount: row.event_count as number,
				completedCalls: row.completed_calls as number,
				failedCalls: row.failed_calls as number,
				cancelledCalls: row.cancelled_calls as number,
				inputTokens: row.input_tokens as number,
				outputTokens: row.output_tokens as number,
				cacheReadTokens: row.cache_read_tokens as number,
				cacheWriteTokens: row.cache_write_tokens as number,
				reasoningTokens: row.reasoning_tokens as number,
				totalTokens: row.total_tokens as number,
				costUsd: row.cost_usd as number,
				uncachedInputTokens: (row.uncached_input_tokens as number) ?? 0,
				unreportedCacheInputTokens: (row.unreported_cache_input_tokens as number) ?? 0,
				cacheDiscountBase: (row.cache_discount_base as number) ?? 0,
			}))
		} catch (err) {
			throw new StatsDbError(
				"STATS_DB/read/001",
				`Failed to query detailed daily rollups from ${fromDay} to ${toDay}`,
				err,
			)
		}
	}

	/**
	 * Queries lifetime totals, optionally excluding cancelled events.
	 */
	queryLifetimeTotalsFiltered(includeCancelled: boolean = false): {
		eventCount: number
		totalCost: number
		totalTokens: number
		inputTokens: number
		outputTokens: number
		cacheReadTokens: number
		cacheWriteTokens: number
		reasoningTokens: number
		completedCalls: number
		failedCalls: number
		cancelledCalls: number
		uncachedInputTokens: number
		unreportedCacheInputTokens: number
		cacheDiscountBase: number
	} {
		const db = this.getDb()
		const rootTaskId = includeCancelled ? "" : NON_CANCELLED_KEY

		try {
			const row = db
				.prepare(
					`SELECT event_count, cost_usd as total_cost, total_tokens,
						input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
						reasoning_tokens, completed_calls, failed_calls, cancelled_calls,
						uncached_input_tokens, unreported_cache_input_tokens, cache_discount_base
					 FROM stats_rollup
					 WHERE period_type = 'lifetime' AND root_task_id = ? AND axis = ''
					 AND period_key = 'all'`,
				)
				.get(rootTaskId) as Record<string, unknown> | undefined

			if (!row) {
				return {
					eventCount: 0,
					totalCost: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					completedCalls: 0,
					failedCalls: 0,
					cancelledCalls: 0,
					uncachedInputTokens: 0,
					unreportedCacheInputTokens: 0,
					cacheDiscountBase: 0,
				}
			}

			return {
				eventCount: row.event_count as number,
				totalCost: row.total_cost as number,
				totalTokens: row.total_tokens as number,
				inputTokens: row.input_tokens as number,
				outputTokens: row.output_tokens as number,
				cacheReadTokens: row.cache_read_tokens as number,
				cacheWriteTokens: row.cache_write_tokens as number,
				reasoningTokens: row.reasoning_tokens as number,
				completedCalls: row.completed_calls as number,
				failedCalls: row.failed_calls as number,
				cancelledCalls: row.cancelled_calls as number,
				uncachedInputTokens: (row.uncached_input_tokens as number) ?? 0,
				unreportedCacheInputTokens: (row.unreported_cache_input_tokens as number) ?? 0,
				cacheDiscountBase: (row.cache_discount_base as number) ?? 0,
			}
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query lifetime totals (filtered)", err)
		}
	}

	/**
	 * Queries coverage statistics (first/last event timestamps, backfill count)
	 * for a given time range.
	 *
	 * @param fromEpochMs Start epoch ms (inclusive). 0 for no lower bound.
	 * @param toEpochMs End epoch ms (exclusive). Infinity for no upper bound.
	 * @param includeCancelled If true, includes cancelled events.
	 */
	queryCoverageStats(fromEpochMs: number, toEpochMs: number, includeCancelled: boolean = false): CoverageStats {
		const db = this.getDb()

		try {
			let query = `SELECT MIN(occurred_epoch_ms) as first_ms, MAX(occurred_epoch_ms) as last_ms,
						SUM(CASE WHEN provenance = 'history-backfill' THEN 1 ELSE 0 END) as backfilled
						FROM usage_events
						WHERE occurred_epoch_ms >= ? AND occurred_epoch_ms < ?`
			const params: Array<number | string> = [fromEpochMs, toEpochMs]

			if (!includeCancelled) {
				query += ` AND status != 'cancelled'`
			}

			const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined

			if (!row || row.first_ms === null) {
				return {
					firstEventAt: undefined,
					lastEventAt: undefined,
					backfilledEventCount: 0,
				}
			}

			return {
				firstEventAt: new Date(row.first_ms as number).toISOString(),
				lastEventAt: new Date(row.last_ms as number).toISOString(),
				backfilledEventCount: row.backfilled as number,
			}
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", "Failed to query coverage stats", err)
		}
	}

	/**
	 * Queries a single session by root_task_id.
	 * This is a direct lookup (O(1) via primary key) replacing the
	 * previous pattern of querySessions(100).find(...).
	 *
	 * @returns The session row, or undefined if not found.
	 */
	querySessionByRootTaskId(rootTaskId: string): SessionRow | undefined {
		const db = this.getDb()

		try {
			const row = db
				.prepare(
					`SELECT root_task_id, title, total_cost, total_tokens, model, provider,
						last_activity_ms, event_count
					 FROM session_metadata
					 WHERE root_task_id = ?`,
				)
				.get(rootTaskId) as Record<string, unknown> | undefined

			if (!row) {
				return undefined
			}

			return {
				rootTaskId: row.root_task_id as string,
				title: row.title as string,
				totalCost: row.total_cost as number,
				totalTokens: row.total_tokens as number,
				model: row.model as string,
				provider: row.provider as string,
				lastActivity: row.last_activity_ms as number,
				eventCount: row.event_count as number,
			}
		} catch (err) {
			throw new StatsDbError("STATS_DB/read/001", `Failed to query session by root_task_id: ${rootTaskId}`, err)
		}
	}

	// ── Public API: Clear ─────────────────────────────────────────────────

	/**
	 * Clears all data and increments the generation.
	 * This atomically deletes all events, rollups, and projections,
	 * then increments the generation in stats_meta.
	 */
	clearGeneration(): number {
		const db = this.getDb()

		try {
			db.exec("BEGIN")

			db.exec("DELETE FROM usage_events")
			db.exec("DELETE FROM stats_rollup")
			db.exec("DELETE FROM session_metadata")
			db.exec("DELETE FROM task_usage_metadata")
			db.exec("DELETE FROM session_activity")

			// Increment generation
			const meta = this.readMetaInternal(db)
			const newGeneration = meta.generation + 1
			this.updateMeta(db, {
				generation: newGeneration,
				lastSequence: 0,
				migrationCheckpoint: {
					lastSegment: "",
					lastLine: 0,
					eventsMigrated: 0,
					complete: false,
				},
			})

			db.exec("COMMIT")
			return newGeneration
		} catch (err) {
			try {
				db.exec("ROLLBACK")
			} catch {
				// Ignore
			}
			throw new StatsDbError("STATS_DB/clear/001", "Failed to clear generation", err)
		}
	}

	// ── Public API: Meta ───────────────────────────────────────────────────

	/**
	 * Returns the current generation number.
	 */
	getGeneration(): number {
		const db = this.getDb()
		return this.readMetaInternal(db).generation
	}

	/**
	 * Returns the last sequence number.
	 */
	getLastSequence(): number {
		const db = this.getDb()
		return this.readMetaInternal(db).lastSequence
	}

	/**
	 * Returns the migration checkpoint.
	 */
	getMigrationCheckpoint(): MigrationCheckpoint {
		const db = this.getDb()
		return this.readMetaInternal(db).migrationCheckpoint
	}

	/**
	 * Updates the migration checkpoint.
	 */
	setMigrationCheckpoint(checkpoint: MigrationCheckpoint): void {
		const db = this.getDb()
		this.updateMeta(db, { migrationCheckpoint: checkpoint })
	}

	// ── Internal: Rollup Update ────────────────────────────────────────────

	/**
	 * Computes the uncached portion of an event's input tokens. This is the
	 * base the dashboard cacheRatio simulation scales to estimate unreported
	 * cache reads, so it must exclude tokens that were already served from
	 * (or written to) the cache.
	 *
	 * Cache components are subtracted only when the event semantics say they
	 * are included in inputTokens (OpenAI-style: prompt_tokens includes
	 * cached tokens). Events that exclude them (Anthropic-style) — or carry
	 * unknown inclusion — keep their full input as the uncached base.
	 */
	private computeUncachedInputTokens(
		usage: {
			inputTokens?: { value?: number }
			cacheReadTokens?: { value?: number }
			cacheWriteTokens?: { value?: number }
		},
		semantics: { cacheReadInInput?: string; cacheWriteInInput?: string },
	): number {
		const inputTokens = usage.inputTokens?.value ?? 0
		const includedCacheRead = semantics.cacheReadInInput === "included" ? (usage.cacheReadTokens?.value ?? 0) : 0
		const includedCacheWrite = semantics.cacheWriteInInput === "included" ? (usage.cacheWriteTokens?.value ?? 0) : 0
		return Math.max(0, inputTokens - includedCacheRead - includedCacheWrite)
	}

	/**
	 * Parameters for updating a rollup row.
	 */
	private updateRollup(
		db: DatabaseSync,
		params: {
			periodType: string
			periodKey: string
			rootTaskId: string
			axis: string
			axisValue: string
			eventCount: number
			completedCalls: number
			failedCalls: number
			cancelledCalls: number
			inputTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheWriteTokens: number
			reasoningTokens: number
			totalTokens: number
			costUsd: number
			uncachedInputTokens?: number
			unreportedCacheInputTokens?: number
			cacheDiscountBase?: number
		},
	): void {
		const uncachedInputTokens = params.uncachedInputTokens ?? params.inputTokens
		const unreportedCacheInputTokens = params.unreportedCacheInputTokens ?? 0
		const cacheDiscountBase = params.cacheDiscountBase ?? 0

		db.prepare(
			`INSERT INTO stats_rollup (
				period_type, period_key, root_task_id, axis, axis_value,
				event_count, completed_calls, failed_calls, cancelled_calls,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				reasoning_tokens, total_tokens, cost_usd, uncached_input_tokens,
				unreported_cache_input_tokens, cache_discount_base
			) VALUES (
				@periodType, @periodKey, @rootTaskId, @axis, @axisValue,
				@eventCount, @completedCalls, @failedCalls, @cancelledCalls,
				@inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
				@reasoningTokens, @totalTokens, @costUsd, @uncachedInputTokens,
				@unreportedCacheInputTokens, @cacheDiscountBase
			)
			ON CONFLICT(period_type, period_key, root_task_id, axis, axis_value)
			DO UPDATE SET
				event_count = event_count + @eventCount,
				completed_calls = completed_calls + @completedCalls,
				failed_calls = failed_calls + @failedCalls,
				cancelled_calls = cancelled_calls + @cancelledCalls,
				input_tokens = input_tokens + @inputTokens,
				output_tokens = output_tokens + @outputTokens,
				cache_read_tokens = cache_read_tokens + @cacheReadTokens,
				cache_write_tokens = cache_write_tokens + @cacheWriteTokens,
				reasoning_tokens = reasoning_tokens + @reasoningTokens,
				total_tokens = total_tokens + @totalTokens,
				cost_usd = cost_usd + @costUsd,
				uncached_input_tokens = uncached_input_tokens + @uncachedInputTokens,
				unreported_cache_input_tokens = unreported_cache_input_tokens + @unreportedCacheInputTokens,
				cache_discount_base = cache_discount_base + @cacheDiscountBase`,
		).run({
			periodType: params.periodType,
			periodKey: params.periodKey,
			rootTaskId: params.rootTaskId,
			axis: params.axis,
			axisValue: params.axisValue,
			eventCount: params.eventCount,
			completedCalls: params.completedCalls,
			failedCalls: params.failedCalls,
			cancelledCalls: params.cancelledCalls,
			inputTokens: params.inputTokens,
			outputTokens: params.outputTokens,
			cacheReadTokens: params.cacheReadTokens,
			cacheWriteTokens: params.cacheWriteTokens,
			reasoningTokens: params.reasoningTokens,
			totalTokens: params.totalTokens,
			costUsd: params.costUsd,
			uncachedInputTokens,
			unreportedCacheInputTokens,
			cacheDiscountBase,
		})
	}

	/**
	 * Updates breakdown rollup rows for each supported axis (model, provider, mode).
	 * For each axis, writes daily, monthly, and lifetime breakdown rows.
	 * Also writes non-cancelled-only breakdown rows (root_task_id='__nc__')
	 * for non-cancelled events to support includeCancelled=false queries.
	 */
	private updateBreakdownRollups(
		db: DatabaseSync,
		event: UsageEventV1,
		dayBucket: string,
		monthBucket: string,
		values: {
			completedCalls: number
			failedCalls: number
			cancelledCalls: number
			inputTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheWriteTokens: number
			reasoningTokens: number
			totalTokens: number
			costUsd: number
			uncachedInputTokens?: number
			unreportedCacheInputTokens?: number
			cacheDiscountBase?: number
		},
	): void {
		const axisValueMap: Record<string, string> = {
			model: event.model,
			provider: event.endpoint ? `${event.provider} (${event.endpoint})` : event.provider,
			mode: event.mode,
		}

		const isCancelled = event.status === "cancelled"

		for (const axis of BREAKDOWN_AXES) {
			const axisValue = axisValueMap[axis]

			// Aggregate breakdown (root_task_id = "")
			// Daily breakdown
			this.updateRollup(db, {
				periodType: "daily",
				periodKey: dayBucket,
				rootTaskId: "",
				axis,
				axisValue,
				eventCount: 1,
				...values,
			})

			// Monthly breakdown
			this.updateRollup(db, {
				periodType: "monthly",
				periodKey: monthBucket,
				rootTaskId: "",
				axis,
				axisValue,
				eventCount: 1,
				...values,
			})

			// Lifetime breakdown
			this.updateRollup(db, {
				periodType: "lifetime",
				periodKey: "all",
				rootTaskId: "",
				axis,
				axisValue,
				eventCount: 1,
				...values,
			})

			// Non-cancelled-only breakdown (root_task_id = NON_CANCELLED_KEY)
			if (!isCancelled) {
				// Daily non-cancelled breakdown
				this.updateRollup(db, {
					periodType: "daily",
					periodKey: dayBucket,
					rootTaskId: NON_CANCELLED_KEY,
					axis,
					axisValue,
					eventCount: 1,
					...values,
				})

				// Monthly non-cancelled breakdown
				this.updateRollup(db, {
					periodType: "monthly",
					periodKey: monthBucket,
					rootTaskId: NON_CANCELLED_KEY,
					axis,
					axisValue,
					eventCount: 1,
					...values,
				})

				// Lifetime non-cancelled breakdown
				this.updateRollup(db, {
					periodType: "lifetime",
					periodKey: "all",
					rootTaskId: NON_CANCELLED_KEY,
					axis,
					axisValue,
					eventCount: 1,
					...values,
				})
			}
		}
	}

	/**
	 * Updates non-cancelled-only aggregate rollup rows (root_task_id = '__nc__').
	 * These rows exclude cancelled events for fast includeCancelled=false queries.
	 */
	private updateNonCancelledRollups(
		db: DatabaseSync,
		dayBucket: string,
		monthBucket: string,
		values: {
			completedCalls: number
			failedCalls: number
			cancelledCalls: number
			inputTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheWriteTokens: number
			reasoningTokens: number
			totalTokens: number
			costUsd: number
			uncachedInputTokens?: number
			unreportedCacheInputTokens?: number
			cacheDiscountBase?: number
		},
	): void {
		// Daily non-cancelled
		this.updateRollup(db, {
			periodType: "daily",
			periodKey: dayBucket,
			rootTaskId: NON_CANCELLED_KEY,
			axis: "",
			axisValue: "",
			eventCount: 1,
			...values,
		})

		// Monthly non-cancelled
		this.updateRollup(db, {
			periodType: "monthly",
			periodKey: monthBucket,
			rootTaskId: NON_CANCELLED_KEY,
			axis: "",
			axisValue: "",
			eventCount: 1,
			...values,
		})

		// Lifetime non-cancelled
		this.updateRollup(db, {
			periodType: "lifetime",
			periodKey: "all",
			rootTaskId: NON_CANCELLED_KEY,
			axis: "",
			axisValue: "",
			eventCount: 1,
			...values,
		})
	}

	// ── Internal: Session Upsert ───────────────────────────────────────────

	/**
	 * Upserts a session metadata row and its daily activity.
	 */
	private upsertSession(
		db: DatabaseSync,
		params: {
			rootTaskId: string
			model: string
			provider: string
			costUsd: number
			totalTokens: number
			lastActivityMs: number
			dayBucket: string
		},
	): void {
		// Upsert session_metadata
		db.prepare(
			`INSERT INTO session_metadata (
				root_task_id, title, model, provider,
				total_cost, total_tokens, event_count, last_activity_ms
			) VALUES (
				@rootTaskId, '', @model, @provider,
				@costUsd, @totalTokens, 1, @lastActivityMs
			)
			ON CONFLICT(root_task_id) DO UPDATE SET
				total_cost = total_cost + @costUsd,
				total_tokens = total_tokens + @totalTokens,
				event_count = event_count + 1,
				last_activity_ms = MAX(last_activity_ms, @lastActivityMs),
				updated_at = datetime('now')`,
		).run({
			rootTaskId: params.rootTaskId,
			model: params.model,
			provider: params.provider,
			costUsd: params.costUsd,
			totalTokens: params.totalTokens,
			lastActivityMs: params.lastActivityMs,
		})

		// Upsert session_activity for the day
		db.prepare(
			`INSERT INTO session_activity (
				root_task_id, day, total_cost, total_tokens, event_count, last_activity_ms
			) VALUES (
				@rootTaskId, @day, @costUsd, @totalTokens, 1, @lastActivityMs
			)
			ON CONFLICT(root_task_id, day) DO UPDATE SET
				total_cost = total_cost + @costUsd,
				total_tokens = total_tokens + @totalTokens,
				event_count = event_count + 1,
				last_activity_ms = MAX(last_activity_ms, @lastActivityMs)`,
		).run({
			rootTaskId: params.rootTaskId,
			day: params.dayBucket,
			costUsd: params.costUsd,
			totalTokens: params.totalTokens,
			lastActivityMs: params.lastActivityMs,
		})
	}

	/**
	 * Upserts one direct task usage projection row. Metadata belongs to the
	 * newest event; on equal timestamps, the later append wins deterministically.
	 */
	private upsertTaskUsage(
		db: DatabaseSync,
		params: {
			taskId: string
			model: string
			provider: string
			costUsd: number
			totalTokens: number
			lastActivityMs: number
			cacheDiscountBase?: number
		},
	): void {
		db.prepare(
			`INSERT INTO task_usage_metadata (
				task_id, model, provider, total_cost, total_tokens, event_count, last_activity_ms,
				cache_discount_base
			) VALUES (
				@taskId, @model, @provider, @costUsd, @totalTokens, 1, @lastActivityMs,
				@cacheDiscountBase
			)
			ON CONFLICT(task_id) DO UPDATE SET
				total_cost = total_cost + @costUsd,
				total_tokens = total_tokens + @totalTokens,
				event_count = event_count + 1,
				model = CASE
					WHEN @lastActivityMs >= last_activity_ms THEN @model
					ELSE model
				END,
				provider = CASE
					WHEN @lastActivityMs >= last_activity_ms THEN @provider
					ELSE provider
				END,
				last_activity_ms = @lastActivityMs,
				cache_discount_base = cache_discount_base + @cacheDiscountBase`,
		).run({ ...params, cacheDiscountBase: params.cacheDiscountBase ?? 0 })
	}

	// ── Internal: Meta Management ──────────────────────────────────────────

	/**
	 * Reads the meta singleton.
	 */
	private readMetaInternal(db: DatabaseSync): MetaData {
		const row = db.prepare("SELECT value FROM stats_meta WHERE key = ?").get(META_KEY) as
			| { value: string }
			| undefined

		if (!row) {
			return {
				schemaVersion: SCHEMA_VERSION,
				generation: 1,
				lastSequence: 0,
				migrationCheckpoint: {
					lastSegment: "",
					lastLine: 0,
					eventsMigrated: 0,
					complete: false,
				},
			}
		}

		try {
			return JSON.parse(row.value) as MetaData
		} catch {
			// Corrupt meta — return defaults
			return {
				schemaVersion: SCHEMA_VERSION,
				generation: 1,
				lastSequence: 0,
				migrationCheckpoint: {
					lastSegment: "",
					lastLine: 0,
					eventsMigrated: 0,
					complete: false,
				},
			}
		}
	}

	/**
	 * Updates the meta singleton with partial values.
	 */
	private updateMeta(db: DatabaseSync, updates: Partial<MetaData>): void {
		const current = this.readMetaInternal(db)
		const updated = { ...current, ...updates }
		db.prepare("UPDATE stats_meta SET value = ?, updated_at = datetime('now') WHERE key = ?").run(
			JSON.stringify(updated),
			META_KEY,
		)
	}

	// ── Internal: Row Conversion ───────────────────────────────────────────

	/**
	 * Converts a database row to a UsageEventV1 with sequence.
	 */
	private rowToEvent(row: Record<string, unknown>): UsageEventV1 & { sequence: number } {
		return {
			schemaVersion: row.schema_version as 1,
			eventId: row.event_id as string,
			idempotencyKey: row.idempotency_key as string,
			occurredAt: row.occurred_at as string,
			timezoneOffsetMinutes: row.timezone_offset_minutes as number,
			status: row.status as UsageEventV1["status"],
			attempt: row.attempt as number,
			taskId: row.task_id as string,
			parentTaskId: (row.parent_task_id as string | null) ?? undefined,
			rootTaskId: (row.root_task_id as string | null) ?? undefined,
			provider: row.provider as string,
			model: row.model as string,
			mode: row.mode as string,
			endpoint: (row.endpoint as string | null) ?? undefined,
			modelPricing: row.model_pricing_json
				? (JSON.parse(row.model_pricing_json as string) as UsageEventV1["modelPricing"])
				: undefined,
			usage: JSON.parse(row.usage_json as string),
			semantics: JSON.parse(row.semantics_json as string),
			provenance: row.provenance as UsageEventV1["provenance"],
			sequence: row.seq as number,
		}
	}

	// ── Internal: Utilities ─────────────────────────────────────────────────

	/**
	 * Returns the database handle, throwing if not initialized.
	 */
	private getDb(): DatabaseSync {
		if (!this.db) {
			throw new StatsDbError("STATS_DB/open/001", "Database not initialized. Call initialize() first.")
		}
		return this.db
	}

	/**
	 * For testing: returns the database path.
	 */
	_getDbPath(): string {
		return this.dbPath
	}

	/**
	 * For testing: returns whether the database is initialized.
	 */
	_isInitialized(): boolean {
		return this.initialized
	}
}
