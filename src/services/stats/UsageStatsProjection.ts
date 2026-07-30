// src/services/stats/UsageStatsProjection.ts
//
// Sub-task 3: Rollup snapshot assembly, edge-day correction, bucket-key
// serialization, and session page projection.
//
// These functions read from the SQLite database (UsageStatsDatabase) and
// return typed projection results. Cost recalculation remains single-source
// logic (delegated to computeEventDelta / getEffectiveCost) — no cost
// arithmetic is duplicated in SQL.

import type {
	UsageEventV1,
	StatsQuery,
	StatsSnapshot,
	StatsBucket,
	StatsBucketDelta,
	DashboardSessionPage,
	DashboardSessionSummary,
	DashboardStatsDelta,
	DashboardSessionUpsert,
	HeatmapSnapshot,
} from "@roo-code/types"

import { UsageStatsDatabase, type SessionRow, type DailyRollupRow } from "./UsageStatsDatabase"
import {
	computeEventContribution,
	computeEventDelta,
	computeGroupKeys,
	computeTimeBuckets,
	resolveTimeRange,
	serializeBucketKey,
	type BucketDeltaValues,
} from "./UsageAggregator"

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Projection error codes.
 * Format: STATS_PROJ/function/NNN
 */
export type StatsProjErrorCode =
	| "STATS_PROJ/assembleRollupSnapshot/001" // Database read failed
	| "STATS_PROJ/computeSessionPage/001" // Session query failed
	| "STATS_PROJ/computeHeatmapSnapshot/001" // Heatmap query failed
	| "STATS_PROJ/applyEventToProjection/001" // Atomic update failed

export class StatsProjError extends Error {
	constructor(
		public readonly code: StatsProjErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsProjError"
	}
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Creates an empty StatsBucket with the given key.
 */
function createEmptyBucket(key: Record<string, string> = {}): StatsBucket {
	return {
		key,
		events: 0,
		completedCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		unknownEventCount: 0,
	}
}

/**
 * Converts a SessionRow (DB type) to a DashboardSessionSummary (wire type).
 */
function sessionRowToSummary(row: SessionRow): DashboardSessionSummary {
	return {
		rootTaskId: row.rootTaskId,
		title: row.title,
		totalCost: row.totalCost,
		totalTokens: row.totalTokens,
		model: row.model,
		provider: row.provider,
		lastActivity: row.lastActivity,
		eventCount: row.eventCount,
	}
}

/**
 * Converts a SessionRow (DB type) to a DashboardSessionUpsert (wire type).
 */
function sessionRowToUpsert(row: SessionRow): DashboardSessionUpsert {
	return {
		rootTaskId: row.rootTaskId,
		title: row.title,
		totalCost: row.totalCost,
		totalTokens: row.totalTokens,
		model: row.model,
		provider: row.provider,
		lastActivity: row.lastActivity,
		eventCount: row.eventCount,
	}
}

/**
 * Applies a BucketDeltaValues to a StatsBucket in place.
 */
function applyDeltaToBucket(bucket: StatsBucket, delta: BucketDeltaValues): void {
	bucket.events += delta.events
	bucket.completedCalls += delta.completedCalls
	bucket.failedCalls += delta.failedCalls
	bucket.cancelledCalls += delta.cancelledCalls
	bucket.inputTokens += delta.inputTokens
	bucket.outputTokens += delta.outputTokens
	bucket.cacheReadTokens += delta.cacheReadTokens
	bucket.cacheWriteTokens += delta.cacheWriteTokens
	bucket.reasoningTokens += delta.reasoningTokens
	bucket.totalTokens += delta.totalTokens
	bucket.costUsd += delta.costUsd
	bucket.unknownEventCount += delta.unknownEventCount
}

/**
 * Converts a BucketDeltaValues + key into a StatsBucketDelta.
 */
function toBucketDelta(key: Record<string, string>, delta: BucketDeltaValues): StatsBucketDelta {
	return { key, ...delta }
}

/**
 * Computes the day bucket (YYYY-MM-DD) for a given timestamp in the
 * specified timezone. This is the edge-day correction function: it
 * correctly handles midnight and DST boundaries by using the Intl API.
 */
export function computeDayBucket(occurredAt: string, timezone: string): string {
	const date = new Date(occurredAt)
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	return formatter.format(date).replace(/\//g, "-")
}

/**
 * Computes the date range (from/to as YYYY-MM-DD strings) for a given
 * number of days ending at today (in the specified timezone).
 * Returns oldest-first ordering.
 */
function computeHeatmapRange(rangeDays: number, timezone: string): { fromDay: string; toDay: string; days: string[] } {
	const now = new Date()

	// Compute today's day bucket in the timezone
	const toDay = computeDayBucket(now.toISOString(), timezone)

	// Compute fromDay = toDay - (rangeDays - 1)
	const toDate = new Date(toDay + "T00:00:00Z")
	const fromDate = new Date(toDate)
	fromDate.setUTCDate(fromDate.getUTCDate() - (rangeDays - 1))
	const fromDay = fromDate.toISOString().slice(0, 10)

	// Generate all days in range (oldest first)
	const days: string[] = []
	const cursor = new Date(fromDate)
	while (cursor <= toDate) {
		days.push(cursor.toISOString().slice(0, 10))
		cursor.setUTCDate(cursor.getUTCDate() + 1)
	}

	return { fromDay, toDay, days }
}

// ── Public API: assembleRollupSnapshot ──────────────────────────────────────

/**
 * Reads persisted rollups for the given query range and assembles a
 * StatsSnapshot from the database.
 *
 * This function reads all events matching the query's time range from the
 * database and aggregates them using the same pure logic as UsageAggregator.
 * The rollup tables in the DB are used for fast heatmap and session queries,
 * but the main snapshot is assembled from events to ensure exact correctness
 * (including cost recalculation, cache ratio, and inclusion semantics).
 *
 * @param db The initialized UsageStatsDatabase
 * @param query The statistics query
 * @param options Additional options (e.g. recordingPaused)
 */
export function assembleRollupSnapshot(
	db: UsageStatsDatabase,
	query: StatsQuery,
	options: { recordingPaused?: boolean } = {},
): StatsSnapshot {
	try {
		// Read all events from the database
		const allEvents = db.readAllEvents()

		// Filter by time range
		const { from, to } = resolveTimeRange(query)
		const filtered = allEvents.filter((event) => {
			const eventTime = new Date(event.occurredAt).getTime()
			if (from && eventTime < from.getTime()) return false
			if (to && eventTime >= to.getTime()) return false
			return true
		})

		// Filter cancelled
		const includeCancelled = query.includeCancelled ?? false
		const visibleEvents = includeCancelled ? filtered : filtered.filter((e) => e.status !== "cancelled")

		// Compute bucket keys
		const groupBy = query.groupBy
		const cacheRatio = query.cacheRatio
		const bucketMap = new Map<string, StatsBucket>()

		for (const event of visibleEvents) {
			const timeBuckets = computeTimeBuckets(event, query.timezone)
			const item = { event, ...timeBuckets }
			const groupKeys = computeGroupKeys(event, groupBy, query.timezone)

			for (const bucketKey of groupKeys) {
				const mapKey = serializeBucketKey(bucketKey)
				let bucket = bucketMap.get(mapKey)
				if (!bucket) {
					bucket = createEmptyBucket(bucketKey)
					bucketMap.set(mapKey, bucket)
				}
				const delta = computeEventDelta(event, cacheRatio)
				applyDeltaToBucket(bucket, delta)
			}
		}

		// Compute totals
		const totals = createEmptyBucket()
		for (const event of visibleEvents) {
			const delta = computeEventDelta(event, cacheRatio)
			applyDeltaToBucket(totals, delta)
		}

		// Sort buckets
		const buckets = sortBuckets(Array.from(bucketMap.values()), groupBy)

		// Compute coverage
		const times = visibleEvents.map((e) => new Date(e.occurredAt).getTime()).sort((a, b) => a - b)
		const backfilledEventCount = visibleEvents.filter((e) => e.provenance === "history-backfill").length

		return {
			query,
			generatedAt: new Date().toISOString(),
			buckets,
			totals,
			coverage: {
				firstEventAt: times.length > 0 ? new Date(times[0]).toISOString() : undefined,
				lastEventAt: times.length > 0 ? new Date(times[times.length - 1]).toISOString() : undefined,
				recordingPaused: options.recordingPaused ?? false,
				backfilledEventCount,
			},
		}
	} catch (err) {
		throw new StatsProjError("STATS_PROJ/assembleRollupSnapshot/001", "Failed to assemble rollup snapshot", err)
	}
}

// ── Public API: computeSessionPage ──────────────────────────────────────────

/**
 * Reads session_metadata and session_activity from the database and returns
 * a cursor-paged DashboardSessionPage.
 *
 * @param db The initialized UsageStatsDatabase
 * @param query The statistics query (used for requestId correlation)
 * @param requestId Correlation ID for the subscription
 * @param cursor Opaque cursor from a previous page (absent for first page)
 * @param limit Page size (1-100)
 */
export function computeSessionPage(
	db: UsageStatsDatabase,
	requestId: string,
	cursor?: string,
	limit: number = 50,
): DashboardSessionPage {
	try {
		const page = db.querySessions(limit, cursor)

		return {
			requestId,
			sessions: page.sessions.map(sessionRowToSummary),
			cursor: page.cursor,
			totalEstimate: page.totalEstimate,
		}
	} catch (err) {
		throw new StatsProjError("STATS_PROJ/computeSessionPage/001", "Failed to compute session page", err)
	}
}

// ── Public API: computeHeatmapSnapshot ───────────────────────────────────────

/**
 * Reads daily rollups for the heatmap range and returns a HeatmapSnapshot.
 *
 * Edge-day correction: the day boundaries are computed using the query's
 * timezone, ensuring events at midnight or during DST transitions are
 * assigned to the correct day.
 *
 * @param db The initialized UsageStatsDatabase
 * @param rangeDays Number of days for the heatmap (30, 60, 120, 360)
 * @param timezone IANA timezone for day boundary computation
 */
export function computeHeatmapSnapshot(db: UsageStatsDatabase, rangeDays: number, timezone: string): HeatmapSnapshot {
	try {
		const { fromDay, toDay, days } = computeHeatmapRange(rangeDays, timezone)

		// Query daily rollups from the DB
		const rollups: DailyRollupRow[] = db.queryDailyRollups(fromDay, toDay)

		// Build a map of day → cost for fast lookup
		const costByDay = new Map<string, number>()
		for (const rollup of rollups) {
			costByDay.set(rollup.day, rollup.totalCost)
		}

		// Assemble values array (one per day, oldest first, 0 for missing days)
		const values = days.map((day) => costByDay.get(day) ?? 0)

		return {
			rangeDays,
			values,
		}
	} catch (err) {
		throw new StatsProjError("STATS_PROJ/computeHeatmapSnapshot/001", "Failed to compute heatmap snapshot", err)
	}
}

// ── Public API: applyEventToProjection ──────────────────────────────────────

/**
 * Atomically updates rollups and session projections for a single event
 * and returns the DashboardStatsDelta that should be sent to subscribers.
 *
 * This function:
 * 1. Appends the event to the database (idempotent, transactional)
 * 2. Computes the total delta using the pure computeEventContribution
 * 3. Computes breakdown deltas for each group key
 * 4. Computes the heatmap day delta (if the event falls within the heatmap range)
 * 5. Reads the updated session metadata for session upserts
 *
 * Cost recalculation is single-source: the delta is computed using
 * computeEventDelta (which calls getEffectiveCost), NOT from SQL arithmetic.
 *
 * @param db The initialized UsageStatsDatabase
 * @param event The usage event to apply
 * @param query The statistics query (for time range and groupBy)
 * @param requestId Correlation ID for the subscription
 * @param heatmapRangeDays Number of days for the heatmap
 * @param generation Current store generation
 * @param sequence Sequence number of the event
 */
export function applyEventToProjection(
	db: UsageStatsDatabase,
	event: UsageEventV1,
	query: StatsQuery,
	requestId: string,
	heatmapRangeDays: number,
	generation: number,
	sequence: number,
): DashboardStatsDelta {
	try {
		// 1. Compute the total delta (pure function, checks query filter)
		const totalContribution = computeEventContribution(event, query)

		// If the event doesn't match the query filter, return a zero delta
		if (totalContribution === null) {
			return {
				requestId,
				generation,
				sequence,
				totalDelta: toBucketDelta({}, zeroDelta()),
				breakdownDelta: [],
				heatmapDayDelta: undefined,
				sessionUpsert: [],
			}
		}

		// 2. Compute breakdown deltas for each group key
		const groupKeys = computeGroupKeys(event, query.groupBy, query.timezone)
		const breakdownDelta: StatsBucketDelta[] = groupKeys.map((key) => {
			const delta = computeEventDelta(event, query.cacheRatio)
			return toBucketDelta(key, delta)
		})

		// 3. Compute heatmap day delta
		let heatmapDayDelta: { dayIndex: number; delta: number } | undefined

		const { fromDay, days } = computeHeatmapRange(heatmapRangeDays, query.timezone)
		const eventDay = computeDayBucket(event.occurredAt, query.timezone)
		const dayIndex = days.indexOf(eventDay)

		if (dayIndex >= 0) {
			// The event falls within the heatmap range
			const eventCost = computeEventDelta(event, query.cacheRatio).costUsd
			heatmapDayDelta = { dayIndex, delta: eventCost }
		}

		// 4. Read updated session metadata for session upserts
		// The event was already appended to the DB by the caller (UsageStatsService).
		// We read the current session state to produce the upsert.
		const sessionPage = db.querySessions(100, undefined)
		const rootTaskId = event.rootTaskId ?? event.taskId
		const sessionRow = sessionPage.sessions.find((s) => s.rootTaskId === rootTaskId)

		const sessionUpsert: DashboardSessionUpsert[] = []
		if (sessionRow) {
			sessionUpsert.push(sessionRowToUpsert(sessionRow))
		}

		// 5. Return the delta
		return {
			requestId,
			generation,
			sequence,
			totalDelta: toBucketDelta({}, totalContribution),
			breakdownDelta,
			heatmapDayDelta,
			sessionUpsert,
		}
	} catch (err) {
		throw new StatsProjError(
			"STATS_PROJ/applyEventToProjection/001",
			`Failed to apply event ${event.eventId} to projection`,
			err,
		)
	}
}

// ── Internal: Zero Delta ────────────────────────────────────────────────────

/**
 * Creates a zero-valued BucketDeltaValues.
 */
function zeroDelta(): BucketDeltaValues {
	return {
		events: 0,
		completedCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		unknownEventCount: 0,
	}
}

// ── Internal: Sort Buckets ──────────────────────────────────────────────────

/**
 * Sorts buckets by the same rules as UsageAggregator.
 * - If a time axis is present, sort by time ascending
 * - Otherwise, sort by totalTokens descending then name ascending
 */
function sortBuckets(buckets: StatsBucket[], groupBy: StatsQuery["groupBy"]): StatsBucket[] {
	const hasTimeAxis = groupBy.some((g) => g === "day" || g === "week" || g === "month")

	if (hasTimeAxis) {
		const timeAxis = groupBy.find((g) => g === "day" || g === "week" || g === "month")!
		return buckets.sort((a, b) => {
			const aTime = a.key[timeAxis] ?? ""
			const bTime = b.key[timeAxis] ?? ""
			return aTime.localeCompare(bTime)
		})
	}

	return buckets.sort((a, b) => {
		const diff = b.totalTokens - a.totalTokens
		if (diff !== 0) return diff
		const aName = Object.values(a.key).join("/")
		const bName = Object.values(b.key).join("/")
		return aName.localeCompare(bName)
	})
}
