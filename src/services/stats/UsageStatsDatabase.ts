import { DatabaseSync } from "node:sqlite"
import * as fs from "fs"
import * as path from "path"

import type { UsageEventV1 } from "@roo-code/types"

// ── Constants ──────────────────────────────────────────────────────────────

/** Current schema version for the SQLite database. */
const SCHEMA_VERSION = 2

/** Singleton key in stats_meta for the single metadata row. */
const META_KEY = "singleton"

/** Maximum number of events returned in a single batch read. */
const MAX_BATCH_SIZE = 100

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Database error codes.
 * Format: STATS_DB/function/NNN
 */
export type StatsDbErrorCode =
	| "STATS_DB/open/001" // Database open failed
	| "STATS_DB/migrate/001" // Schema migration failed
	| "STATS_DB/append/001" // Transaction failed
	| "STATS_DB/read/001" // Query failed
	| "STATS_DB/clear/001" // Clear failed
	| "STATS_DB/meta/001" // Meta read/write failed

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

/** A daily rollup row. */
export interface DailyRollupRow {
	day: string
	totalCost: number
	totalTokens: number
	eventCount: number
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

		try {
			this.db = new DatabaseSync(this.dbPath)
		} catch (err) {
			throw new StatsDbError("STATS_DB/open/001", `Failed to open database: ${this.dbPath}`, err)
		}

		// Enable WAL mode and busy timeout for concurrent access
		try {
			this.db.exec("PRAGMA journal_mode = WAL")
			this.db.exec("PRAGMA busy_timeout = 5000")
			this.db.exec("PRAGMA synchronous = NORMAL")
		} catch (err) {
			throw new StatsDbError("STATS_DB/open/001", "Failed to set pragmas", err)
		}

		this.createSchema()
		this.runMigrations()

		this.initialized = true
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
				usage_json TEXT NOT NULL,
				semantics_json TEXT NOT NULL,
				provenance TEXT NOT NULL,
				schema_version INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE INDEX IF NOT EXISTS idx_usage_events_occurred ON usage_events(occurred_epoch_ms);
			CREATE INDEX IF NOT EXISTS idx_usage_events_root ON usage_events(root_task_id);
			CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
			CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
			CREATE INDEX IF NOT EXISTS idx_usage_events_mode ON usage_events(mode);
			CREATE INDEX IF NOT EXISTS idx_usage_events_seq ON usage_events(seq);

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
	 * Currently only version 1 exists.
	 */
	private runMigrations(): void {
		const db = this.getDb()
		const meta = this.readMetaInternal(db)

		if (meta.schemaVersion < 2) {
			this.migrateToV2(db)
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
						`SELECT seq, occurred_epoch_ms, timezone_offset_minutes, status, root_task_id, usage_json
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
					const usage = JSON.parse(row.usage_json as string)

					const inputTokens = usage.inputTokens?.value ?? 0
					const outputTokens = usage.outputTokens?.value ?? 0
					const cacheReadTokens = usage.cacheReadTokens?.value ?? 0
					const cacheWriteTokens = usage.cacheWriteTokens?.value ?? 0
					const reasoningTokens = usage.reasoningTokens?.value ?? 0
					const totalTokens = usage.totalTokens?.value ?? inputTokens + outputTokens
					const costUsd = usage.costUsd?.value ?? 0

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
		const costUsd = event.usage.costUsd?.value ?? 0

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
					provider, model, mode, endpoint,
					usage_json, semantics_json, provenance, schema_version
				) VALUES (
					@eventId, @idempotencyKey, @occurredAt, @occurredEpochMs,
					@timezoneOffsetMinutes, @status, @attempt,
					@taskId, @parentTaskId, @rootTaskId,
					@provider, @model, @mode, @endpoint,
					@usageJson, @semanticsJson, @provenance, @schemaVersion
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
				})

				// Update session projection
				this.upsertSession(db, {
					rootTaskId,
					model: event.model,
					provider: event.provider,
					costUsd,
					totalTokens,
					lastActivityMs: occurredEpochMs,
					dayBucket,
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
				const costUsd = event.usage.costUsd?.value ?? 0

				const status = event.status
				const completedCalls = status === "completed" ? 1 : 0
				const failedCalls = status === "failed" ? 1 : 0
				const cancelledCalls = status === "cancelled" ? 1 : 0

				const insertStmt = db.prepare(`
					INSERT OR IGNORE INTO usage_events (
						event_id, idempotency_key, occurred_at, occurred_epoch_ms,
						timezone_offset_minutes, status, attempt,
						task_id, parent_task_id, root_task_id,
						provider, model, mode, endpoint,
						usage_json, semantics_json, provenance, schema_version
					) VALUES (
						@eventId, @idempotencyKey, @occurredAt, @occurredEpochMs,
						@timezoneOffsetMinutes, @status, @attempt,
						@taskId, @parentTaskId, @rootTaskId,
						@provider, @model, @mode, @endpoint,
						@usageJson, @semanticsJson, @provenance, @schemaVersion
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
					})

					// Update session projection
					this.upsertSession(db, {
						rootTaskId,
						model: event.model,
						provider: event.provider,
						costUsd,
						totalTokens,
						lastActivityMs: occurredEpochMs,
						dayBucket,
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
		},
	): void {
		db.prepare(
			`INSERT INTO stats_rollup (
				period_type, period_key, root_task_id, axis, axis_value,
				event_count, completed_calls, failed_calls, cancelled_calls,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				reasoning_tokens, total_tokens, cost_usd
			) VALUES (
				@periodType, @periodKey, @rootTaskId, @axis, @axisValue,
				@eventCount, @completedCalls, @failedCalls, @cancelledCalls,
				@inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
				@reasoningTokens, @totalTokens, @costUsd
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
				cost_usd = cost_usd + @costUsd`,
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
				last_activity_ms = @lastActivityMs,
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
				last_activity_ms = @lastActivityMs`,
		).run({
			rootTaskId: params.rootTaskId,
			day: params.dayBucket,
			costUsd: params.costUsd,
			totalTokens: params.totalTokens,
			lastActivityMs: params.lastActivityMs,
		})
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
