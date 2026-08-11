// src/services/stats/UsageStatsProjection.ts
//
// Sub-task 3: Rollup snapshot assembly, edge-day correction, bucket-key
// serialization, and session page projection.
//
// These functions read from the SQLite database (UsageStatsDatabase) and
// return typed projection results. Cost recalculation remains single-source
// logic (delegated to computeEventDelta / getEffectiveCost) — no cost
// arithmetic is duplicated in SQL.
//
// ST-1 Optimization: assembleRollupSnapshot() now uses pre-computed rollup
// tables instead of scanning all events. For single-axis queries on
// model/provider/mode/day, the fast path reads O(distinct values) rows
// instead of O(N) events. Multi-axis or week/month/source/status axes fall
// back to a (range-bounded) event scan.

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

import {
	UsageStatsDatabase,
	type SessionRow,
	type DailyRollupRow,
	type BreakdownRollupRow,
	type DailyRollupDetailedRow,
} from "./UsageStatsDatabase"
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

// Memoized per-timezone day formatter — see UsageAggregator for the same
// pattern; Intl.DateTimeFormat construction is expensive per call.
const dayFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getDayFormatter(timezone: string): Intl.DateTimeFormat {
	let formatter = dayFormatterCache.get(timezone)
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
		dayFormatterCache.set(timezone, formatter)
	}
	return formatter
}

/**
 * Computes the day bucket (YYYY-MM-DD) for a given timestamp in the
 * specified timezone. This is the edge-day correction function: it
 * correctly handles midnight and DST boundaries by using the Intl API.
 */
export function computeDayBucket(occurredAt: string, timezone: string): string {
	const date = new Date(occurredAt)
	return getDayFormatter(timezone).format(date).replace(/\//g, "-")
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

// ── Internal: Rollup Fast Path Helpers ──────────────────────────────────────

/**
 * Axes that have pre-computed breakdown rollup rows in the database.
 * The 'day' axis is handled via daily rollup queries (not per-axis breakdown).
 */
const ROLLUP_SUPPORTED_AXES = new Set(["model", "provider", "mode", "day"])

/**
 * Determines whether the fast rollup path can be used for the given query.
 *
 * The fast path is available when:
 * 1. All groupBy axes are supported by pre-computed rollups
 * 2. At most one non-day axis (multi-axis Cartesian products are not pre-computed)
 *
 * cacheRatio estimation is compatible with rollups: rollup rows persist
 * `unreportedCacheInputTokens` (the full input sum over events that did not
 * report cacheReadTokens), and the row→bucket converters add
 * `round(unreported * cacheRatio)` on top of the server-reported sum — the
 * same per-event semantics as computeEventDelta, so mixed-reporting buckets
 * match the event-scan path exactly. For rows built without the new column
 * (hand-built test rows), the converters fall back to the legacy
 * bucket-level estimate.
 */
function canUseRollupFastPath(query: StatsQuery): boolean {
	// Check all axes are supported
	for (const axis of query.groupBy) {
		if (!ROLLUP_SUPPORTED_AXES.has(axis)) {
			return false
		}
	}

	// Multi-axis queries (excluding day) are not pre-computed.
	// e.g., [model, provider] would need Cartesian product rows.
	// But [day, model] is also multi-axis and not pre-computed.
	// Only single-axis queries use the fast path.
	if (query.groupBy.length > 1) {
		return false
	}

	return true
}

/**
 * Converts a BreakdownRollupRow to a StatsBucket with the given key.
 */
function breakdownRowToBucket(row: BreakdownRollupRow, axis: string, cacheRatio?: number): StatsBucket {
	let cacheReadTokens = row.cacheReadTokens
	if (cacheRatio !== undefined && cacheRatio > 0) {
		const unreported =
			row.unreportedCacheInputTokens ??
			(row.cacheReadTokens === 0 ? (row.uncachedInputTokens ?? row.inputTokens) : 0)
		if (unreported > 0) {
			cacheReadTokens += Math.round(unreported * cacheRatio)
		}
	}
	return {
		key: { [axis]: row.axisValue },
		events: row.eventCount,
		completedCalls: row.completedCalls,
		failedCalls: row.failedCalls,
		cancelledCalls: row.cancelledCalls,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		reasoningTokens: row.reasoningTokens,
		totalTokens: row.totalTokens,
		costUsd: row.costUsd,
		unknownEventCount: 0,
	}
}

/**
 * Converts a DailyRollupDetailedRow to a StatsBucket with a day key.
 */
function dailyRowToBucket(row: DailyRollupDetailedRow, cacheRatio?: number): StatsBucket {
	let cacheReadTokens = row.cacheReadTokens
	if (cacheRatio !== undefined && cacheRatio > 0) {
		const unreported =
			row.unreportedCacheInputTokens ??
			(row.cacheReadTokens === 0 ? (row.uncachedInputTokens ?? row.inputTokens) : 0)
		if (unreported > 0) {
			cacheReadTokens += Math.round(unreported * cacheRatio)
		}
	}
	return {
		key: { day: row.day },
		events: row.eventCount,
		completedCalls: row.completedCalls,
		failedCalls: row.failedCalls,
		cancelledCalls: row.cancelledCalls,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cacheReadTokens,
		cacheWriteTokens: row.cacheWriteTokens,
		reasoningTokens: row.reasoningTokens,
		totalTokens: row.totalTokens,
		costUsd: row.costUsd,
		unknownEventCount: 0,
	}
}

/**
 * Sums an array of DailyRollupDetailedRow into a single totals bucket.
 */
function sumDailyRowsToTotals(rows: DailyRollupDetailedRow[], cacheRatio?: number): StatsBucket {
	const totals = createEmptyBucket()
	for (const row of rows) {
		totals.events += row.eventCount
		totals.completedCalls += row.completedCalls
		totals.failedCalls += row.failedCalls
		totals.cancelledCalls += row.cancelledCalls
		totals.inputTokens += row.inputTokens
		totals.outputTokens += row.outputTokens
		let cacheReadTokens = row.cacheReadTokens
		if (cacheRatio !== undefined && cacheRatio > 0) {
			const unreported =
				row.unreportedCacheInputTokens ??
				(row.cacheReadTokens === 0 ? (row.uncachedInputTokens ?? row.inputTokens) : 0)
			if (unreported > 0) {
				cacheReadTokens += Math.round(unreported * cacheRatio)
			}
		}
		totals.cacheReadTokens += cacheReadTokens
		totals.cacheWriteTokens += row.cacheWriteTokens
		totals.reasoningTokens += row.reasoningTokens
		totals.totalTokens += row.totalTokens
		totals.costUsd += row.costUsd
	}
	return totals
}

/**
 * Converts lifetime totals (from queryLifetimeTotalsFiltered) to a StatsBucket.
 */
function lifetimeTotalsToBucket(
	totals: {
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
		uncachedInputTokens?: number
		unreportedCacheInputTokens?: number
	},
	cacheRatio?: number,
): StatsBucket {
	let cacheReadTokens = totals.cacheReadTokens
	if (cacheRatio !== undefined && cacheRatio > 0) {
		const unreported =
			totals.unreportedCacheInputTokens ??
			(totals.cacheReadTokens === 0 ? (totals.uncachedInputTokens ?? totals.inputTokens) : 0)
		if (unreported > 0) {
			cacheReadTokens += Math.round(unreported * cacheRatio)
		}
	}
	return {
		key: {},
		events: totals.eventCount,
		completedCalls: totals.completedCalls,
		failedCalls: totals.failedCalls,
		cancelledCalls: totals.cancelledCalls,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens,
		cacheWriteTokens: totals.cacheWriteTokens,
		reasoningTokens: totals.reasoningTokens,
		totalTokens: totals.totalTokens,
		costUsd: totals.totalCost,
		unknownEventCount: 0,
	}
}

// ── Public API: assembleRollupSnapshot ──────────────────────────────────────

/**
 * Reads persisted rollups for the given query range and assembles a
 * StatsSnapshot from the database.
 *
 * ST-1 Optimization: This function now uses pre-computed rollup tables
 * instead of scanning all events. For single-axis queries on
 * model/provider/mode/day, the fast path reads O(distinct values) rows
 * instead of O(N) events.
 *
 * For complex queries (multi-axis, week/month/source/status axes), it falls
 * back to the range-bounded event-scan path.
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
		// Check if we can use the fast rollup path
		if (canUseRollupFastPath(query)) {
			return assembleRollupSnapshotFast(db, query, options)
		}
		return assembleRollupSnapshotFromEvents(db, query, options)
	} catch (err) {
		throw new StatsProjError("STATS_PROJ/assembleRollupSnapshot/001", "Failed to assemble rollup snapshot", err)
	}
}

/**
 * Fast path: assembles a snapshot from pre-computed rollup tables.
 * Used for single-axis queries on model/provider/mode/day.
 */
function assembleRollupSnapshotFast(
	db: UsageStatsDatabase,
	query: StatsQuery,
	options: { recordingPaused?: boolean },
): StatsSnapshot {
	const includeCancelled = query.includeCancelled ?? false
	const groupBy = query.groupBy
	const cacheRatio = query.cacheRatio
	const { from, to } = resolveTimeRange(query)

	// Determine the time range for rollup queries
	const isAllTime = !from && !to

	// Compute fromDay/toDay for daily rollup queries
	let fromDay = "0000-01-01"
	let toDay = "9999-12-31"
	let fromEpochMs = 0
	let toEpochMs = Number.MAX_SAFE_INTEGER

	if (from) {
		fromDay = computeDayBucket(from.toISOString(), query.timezone)
		fromEpochMs = from.getTime()
	}
	if (to) {
		// to is exclusive, so use the day before for inclusive query
		const dayBefore = new Date(to.getTime() - 1)
		toDay = computeDayBucket(dayBefore.toISOString(), query.timezone)
		toEpochMs = to.getTime()
	}

	// Compute totals
	let totals: StatsBucket
	if (isAllTime) {
		const lifetimeTotals = db.queryLifetimeTotalsFiltered(includeCancelled)
		totals = lifetimeTotalsToBucket(lifetimeTotals, cacheRatio)
	} else {
		const dailyRows = db.queryDailyRollupsDetailed(fromDay, toDay, includeCancelled)
		totals = sumDailyRowsToTotals(dailyRows, cacheRatio)
	}

	// Compute breakdown buckets
	let buckets: StatsBucket[] = []

	if (groupBy.length === 0) {
		// No grouping — return a single bucket with totals
		buckets = []
	} else {
		const axis = groupBy[0]

		if (axis === "day") {
			// Day axis: use detailed daily rollups
			const dailyRows = db.queryDailyRollupsDetailed(fromDay, toDay, includeCancelled)
			buckets = dailyRows.map((row) => dailyRowToBucket(row, cacheRatio))
		} else {
			// model/provider/mode axis: use breakdown rollups
			let breakdownRows: BreakdownRollupRow[]

			if (isAllTime) {
				breakdownRows = db.queryBreakdownRollups("lifetime", "all", "all", axis, includeCancelled)
			} else {
				// Use daily rollups for date ranges — daily breakdown rows are written
				// at append time and already handle per-day granularity correctly
				breakdownRows = db.queryBreakdownRollups("daily", fromDay, toDay, axis, includeCancelled)
			}

			buckets = breakdownRows.map((row) => breakdownRowToBucket(row, axis, cacheRatio))
		}
	}

	// Sort buckets
	buckets = sortBuckets(buckets, groupBy)

	// Compute coverage from the DB (fast indexed query)
	const coverageStats = db.queryCoverageStats(fromEpochMs, toEpochMs, includeCancelled)

	return {
		query,
		generatedAt: new Date().toISOString(),
		buckets,
		totals,
		coverage: {
			firstEventAt: coverageStats.firstEventAt,
			lastEventAt: coverageStats.lastEventAt,
			recordingPaused: options.recordingPaused ?? false,
			backfilledEventCount: coverageStats.backfilledEventCount,
		},
	}
}

/**
 * Fallback path: assembles a snapshot by scanning events in the query range.
 * Used for multi-axis queries and week/month/source/status axes.
 */
function assembleRollupSnapshotFromEvents(
	db: UsageStatsDatabase,
	query: StatsQuery,
	options: { recordingPaused?: boolean },
): StatsSnapshot {
	// Read only the events inside the query range (SQL-side filter riding the
	// occurred_epoch_ms index); the JS range filter below stays as a safety
	// net and is now a no-op.
	const { from, to } = resolveTimeRange(query)
	const fromEpochMs = from?.getTime() ?? 0
	const toEpochMs = to?.getTime() ?? Number.MAX_SAFE_INTEGER
	const allEvents = db.readEventsInRange(fromEpochMs, toEpochMs)

	// Filter by time range (safety net — the DB read is already range-bounded)
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

	// Compute coverage from the DB (fast indexed query)
	const coverageStats = db.queryCoverageStats(fromEpochMs, toEpochMs, includeCancelled)

	return {
		query,
		generatedAt: new Date().toISOString(),
		buckets,
		totals,
		coverage: {
			firstEventAt: coverageStats.firstEventAt,
			lastEventAt: coverageStats.lastEventAt,
			recordingPaused: options.recordingPaused ?? false,
			backfilledEventCount: coverageStats.backfilledEventCount,
		},
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

		// Build a map of day → tokens for fast lookup
		// ST-3: Heatmap displays tokens, not cost — use totalTokens for consistency
		const tokensByDay = new Map<string, number>()
		for (const rollup of rollups) {
			tokensByDay.set(rollup.day, rollup.totalTokens)
		}

		// Assemble values array (one per day, oldest first, 0 for missing days)
		const values = days.map((day) => tokensByDay.get(day) ?? 0)

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
			// ST-3: Heatmap displays tokens, not cost — use totalTokens for consistency
			const eventTokens = computeEventDelta(event, query.cacheRatio).totalTokens
			heatmapDayDelta = { dayIndex, delta: eventTokens }
		}

		// 4. Read updated session metadata for session upserts
		// The event was already appended to the DB by the caller (UsageStatsService).
		// We read the current session state to produce the upsert.
		// ST-1: Use direct lookup by root_task_id instead of querySessions(100).find(...)
		const rootTaskId = event.rootTaskId ?? event.taskId
		const sessionRow = db.querySessionByRootTaskId(rootTaskId)

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
