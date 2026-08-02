import * as fs from "fs"
import * as path from "path"

import type { UsageEventV1 } from "@roo-code/types"
import { UsageEventV1 as UsageEventV1Schema } from "@roo-code/types"

import { UsageStatsDatabase, type MigrationCheckpoint } from "./UsageStatsDatabase"

// ── Constants ──────────────────────────────────────────────────────────────

/** Number of events to migrate per batch. */
const MIGRATION_BATCH_SIZE = 1000

/** Segment file name prefix (must match UsageEventStore). */
const SEGMENT_PREFIX = "events-"

/** Segment file extension (must match UsageEventStore). */
const SEGMENT_EXT = ".ndjson"

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Migration error codes.
 * Format: STATS_MIGRATION/function/NNN
 */
export type StatsMigrationErrorCode =
	| "STATS_MIGRATION/read/001" // Failed to read segment files
	| "STATS_MIGRATION/parse/001" // Failed to parse event
	| "STATS_MIGRATION/append/001" // Failed to append migrated event
	| "STATS_MIGRATION/checkpoint/001" // Failed to update checkpoint

export class StatsMigrationError extends Error {
	constructor(
		public readonly code: StatsMigrationErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsMigrationError"
	}
}

// ── UsageStatsMigration ─────────────────────────────────────────────────────

/**
 * Migrates legacy NDJSON segments into the SQLite canonical store.
 *
 * Design principles (architecture report section 1.4A):
 * - Reads existing NDJSON segments from the usage-stats directory
 * - Migrates in bounded batches (1000 events per batch)
 * - Checkpoints progress for interruption safety
 * - Preserves event identity and privacy rules
 * - Legacy parent chain resolution with cycle guard
 * - Does NOT delete legacy NDJSON segments
 *
 * The migration is idempotent: if interrupted, it resumes from the last
 * checkpoint. Already-migrated events are skipped by the database's
 * INSERT OR IGNORE on idempotency_key.
 */
export class UsageStatsMigration {
	private readonly statsDir: string
	private readonly db: UsageStatsDatabase

	/**
	 * @param statsDir The usage-stats directory path (same as UsageEventStore).
	 * @param db The target SQLite database.
	 */
	constructor(statsDir: string, db: UsageStatsDatabase) {
		this.statsDir = statsDir
		this.db = db
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Runs the full migration from NDJSON segments to the SQLite database.
	 * Resumes from the last checkpoint if interrupted.
	 *
	 * @returns The total number of events migrated (newly inserted).
	 */
	migrate(): { totalMigrated: number; totalSkipped: number; complete: boolean } {
		const checkpoint = this.db.getMigrationCheckpoint()

		// If already complete, nothing to do
		if (checkpoint.complete) {
			return { totalMigrated: 0, totalSkipped: 0, complete: true }
		}

		// List segment files
		const segmentFiles = this.listSegmentFiles()

		if (segmentFiles.length === 0) {
			// No segments to migrate — mark complete
			this.db.setMigrationCheckpoint({
				...checkpoint,
				complete: true,
			})
			return { totalMigrated: 0, totalSkipped: 0, complete: true }
		}

		// Build parent map for root task resolution
		// We need to read all events first to build the parent map,
		// but we do it in a streaming fashion: first pass collects
		// taskId → parentTaskId mappings, second pass migrates.
		const parentMap = this.buildParentMap(segmentFiles)

		let totalMigrated = checkpoint.eventsMigrated
		let totalSkipped = 0

		// Determine starting point from checkpoint
		let startSegmentIdx = 0
		let startLine = 0

		if (checkpoint.lastSegment) {
			const idx = segmentFiles.indexOf(checkpoint.lastSegment)
			if (idx >= 0) {
				startSegmentIdx = idx
				startLine = checkpoint.lastLine
			}
		}

		let currentSegment = checkpoint.lastSegment
		let currentLine = checkpoint.lastLine

		for (let segIdx = startSegmentIdx; segIdx < segmentFiles.length; segIdx++) {
			const segmentFile = segmentFiles[segIdx]
			const segmentPath = path.join(this.statsDir, segmentFile)

			let content: string
			try {
				content = fs.readFileSync(segmentPath, "utf-8")
			} catch (err) {
				throw new StatsMigrationError("STATS_MIGRATION/read/001", `Failed to read segment ${segmentFile}`, err)
			}

			const lines = content.split("\n")
			// Remove trailing empty line
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop()
			}

			// Skip already-migrated lines for the starting segment
			const startLineIdx = segIdx === startSegmentIdx ? startLine : 0

			let batchEvents: UsageEventV1[] = []
			let batchCount = 0

			for (let i = startLineIdx; i < lines.length; i++) {
				const line = lines[i]
				if (!line.trim()) {
					continue
				}

				let event: UsageEventV1
				try {
					const parsed = JSON.parse(line)
					const result = UsageEventV1Schema.safeParse(parsed)
					if (!result.success) {
						// Skip corrupt lines (same as UsageEventStore quarantine)
						continue
					}
					event = result.data
				} catch {
					// Skip unparseable lines
					continue
				}

				// Resolve root task ID if not present
				if (!event.rootTaskId) {
					event = {
						...event,
						rootTaskId: this.resolveRootTaskId(event, parentMap),
					}
				}

				batchEvents.push(event)
				batchCount++
				currentLine = i + 1
				currentSegment = segmentFile

				// Flush batch when full
				if (batchCount >= MIGRATION_BATCH_SIZE) {
					const result = this.flushBatch(batchEvents)
					totalMigrated += result.migrated
					totalSkipped += result.skipped

					// Update checkpoint
					this.db.setMigrationCheckpoint({
						lastSegment: currentSegment,
						lastLine: currentLine,
						eventsMigrated: totalMigrated,
						complete: false,
					})

					batchEvents = []
					batchCount = 0
				}
			}

			// Flush remaining events for this segment
			if (batchEvents.length > 0) {
				const result = this.flushBatch(batchEvents)
				totalMigrated += result.migrated
				totalSkipped += result.skipped

				this.db.setMigrationCheckpoint({
					lastSegment: currentSegment,
					lastLine: currentLine,
					eventsMigrated: totalMigrated,
					complete: false,
				})

				batchEvents = []
				batchCount = 0
			}

			// Move to next segment — reset line counter
			currentLine = 0
		}

		// Mark migration complete
		this.db.setMigrationCheckpoint({
			lastSegment: currentSegment || segmentFiles[segmentFiles.length - 1],
			lastLine: currentLine,
			eventsMigrated: totalMigrated,
			complete: true,
		})

		return { totalMigrated, totalSkipped, complete: true }
	}

	/**
	 * Returns whether migration has been completed.
	 */
	isComplete(): boolean {
		return this.db.getMigrationCheckpoint().complete
	}

	/**
	 * Returns the current migration checkpoint.
	 */
	getCheckpoint(): MigrationCheckpoint {
		return this.db.getMigrationCheckpoint()
	}

	// ── Internal: Batch Flush ────────────────────────────────────────────────

	/**
	 * Flushes a batch of events to the database.
	 * Uses idempotent append — already-migrated events are silently skipped.
	 */
	private flushBatch(events: UsageEventV1[]): { migrated: number; skipped: number } {
		let migrated = 0
		let skipped = 0

		for (const event of events) {
			try {
				const result = this.db.append(event)
				if (result.inserted) {
					migrated++
				} else {
					skipped++
				}
			} catch (err) {
				throw new StatsMigrationError(
					"STATS_MIGRATION/append/001",
					`Failed to migrate event ${event.eventId}`,
					err,
				)
			}
		}

		return { migrated, skipped }
	}

	// ── Internal: Segment Listing ────────────────────────────────────────────

	/**
	 * Lists segment files in the stats directory, sorted by name.
	 */
	private listSegmentFiles(): string[] {
		try {
			const allFiles = fs.readdirSync(this.statsDir)
			return allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT)).sort()
		} catch {
			return []
		}
	}

	// ── Internal: Parent Map ─────────────────────────────────────────────────

	/**
	 * Builds a map of taskId → parentTaskId from all segment files.
	 * This is needed for root task resolution during migration.
	 * Done in a streaming fashion to avoid loading all events into memory.
	 */
	private buildParentMap(segmentFiles: string[]): Map<string, string | undefined> {
		const parentMap = new Map<string, string | undefined>()

		for (const segmentFile of segmentFiles) {
			const segmentPath = path.join(this.statsDir, segmentFile)

			let content: string
			try {
				content = fs.readFileSync(segmentPath, "utf-8")
			} catch {
				// Skip unreadable segments
				continue
			}

			const lines = content.split("\n")
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop()
			}

			for (const line of lines) {
				if (!line.trim()) continue
				try {
					const parsed = JSON.parse(line)
					if (parsed && typeof parsed.taskId === "string") {
						if (!parentMap.has(parsed.taskId)) {
							parentMap.set(parsed.taskId, parsed.parentTaskId)
						}
					}
				} catch {
					// Skip corrupt lines
				}
			}
		}

		return parentMap
	}

	// ── Internal: Root Task Resolution ───────────────────────────────────────

	/**
	 * Resolves the root task ID for an event by following parent chains.
	 * Uses a cycle guard to prevent infinite loops.
	 *
	 * This mirrors the logic in `resolveRootTaskId()` from
	 * `usageStatsMessageHandler.ts`, but is duplicated here to avoid
	 * a circular dependency on the webview handler module.
	 */
	private resolveRootTaskId(event: UsageEventV1, parentMap: Map<string, string | undefined>): string {
		let current = event.taskId
		const visited = new Set<string>()

		while (!visited.has(current)) {
			visited.add(current)
			const parent = parentMap.get(current)
			// Stop if no parent, or if parent is not a known task in the map.
			// This prevents following a parentTaskId to a task that doesn't
			// exist in the event set (orphan parent reference).
			if (!parent || !parentMap.has(parent)) break
			current = parent
		}

		return current
	}
}
