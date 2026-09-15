import type {
	UsageEventV1,
	StatsQuery,
	StatsSnapshot,
	StatsBucket,
	StatsBucketDelta,
	SourcedNumber,
	UsageValueSource,
} from "@roo-code/types"

import {
	getEffectiveCost,
	computeEventCost,
	computeCacheDiscountBase,
	applyCacheDiscount,
	providerReportsCache,
} from "./costRecalculation"
import type { CustomModelPricingMap } from "./costRecalculation"

// ── Types ───────────────────────────────────────────────────────────────────

/** Internal event representation used for aggregation (UsageEventV1 + derived fields) */
interface AggregatableEvent {
	event: UsageEventV1
	/** Calendar bucket key based on timezone (e.g. "2026-07-19") */
	dayBucket?: string
	/** Calendar week bucket key based on timezone (e.g. "2026-W29") */
	weekBucket?: string
	/** Calendar month bucket key based on timezone (e.g. "2026-07") */
	monthBucket?: string
}

/** Internal structure for separating cost by source */
interface SourceSeparatedCost {
	provider: number
	estimated: number
	backfilled: number
}

/**
 * Numeric delta values for a stats bucket, without the key field.
 * Used internally by computeEventDelta and applyDeltaToBucket.
 */
export type BucketDeltaValues = Omit<StatsBucketDelta, "key">

// ── Empty Bucket Factory ────────────────────────────────────────────────────

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

// ── Standalone Pure Functions (extracted from class) ────────────────────────
//
// These functions are pure (no side effects, no instance state).
// They are extracted from the UsageAggregator class so they can be
// reused by UsageStatsProjection and tested independently.

/**
 * Extracts the numeric value from a SourcedNumber.
 */
function extractSourcedValue(sourced?: SourcedNumber): number {
	return sourced?.value ?? 0
}

/**
 * Converts a UTC Date to the same instant in the specified timezone.
 * Uses the Intl API to handle DST automatically.
 */
function toTimezoneDate(date: Date, timezone: string): Date {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	})

	const parts = formatter.formatToParts(date)
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0"
	const year = parseInt(get("year"), 10)
	const month = parseInt(get("month"), 10) - 1
	const day = parseInt(get("day"), 10)
	const hour = parseInt(get("hour"), 10) % 24 // Convert 24-hour to 0-hour
	const minute = parseInt(get("minute"), 10)
	const second = parseInt(get("second"), 10)

	// Convert timezone wall-clock time to UTC
	const utcGuess = Date.UTC(year, month, day, hour, minute, second)
	const tzOffset = getTimezoneOffsetMinutes(date, timezone)
	return new Date(utcGuess + tzOffset * 60 * 1000)
}

/**
 * Returns the UTC offset for the specified timezone in minutes.
 */
function getTimezoneOffsetMinutes(date: Date, timezone: string): number {
	const utcDate = new Date(date.toISOString())
	const tzFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	})
	const tzParts = tzFormatter.formatToParts(utcDate)
	const get = (type: string) => parseInt(tzParts.find((p) => p.type === type)?.value ?? "0", 10)
	const tzYear = get("year")
	const tzMonth = get("month") - 1
	const tzDay = get("day")
	const tzHour = get("hour") % 24
	const tzMinute = get("minute")
	const tzSecond = get("second")

	const tzEpoch = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond)
	return Math.round((utcDate.getTime() - tzEpoch) / 60000)
}

/**
 * Returns the 00:00:00 UTC for the given date based on the timezone.
 *
 * DST-correct: evaluates the timezone offset at the candidate midnight
 * instant rather than at the input date. This prevents 1-hour errors
 * when the input date and the target midnight fall on opposite sides
 * of a DST transition.
 *
 * Algorithm:
 *   1. Determine the calendar date (year/month/day) in the target timezone.
 *   2. Compute a candidate UTC instant by interpreting wall-clock midnight as UTC.
 *   3. Evaluate the timezone offset at that candidate instant.
 *   4. Apply the offset to get the true UTC of timezone midnight.
 *
 * A single iteration suffices because the candidate instant (step 2) is
 * within ~14 hours of the true midnight, which is always enough to
 * determine the correct DST offset in all real-world timezones.
 */
export function startOfDayInTimezone(date: Date, timezone: string): Date {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	const parts = formatter.formatToParts(date)
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0"
	const year = parseInt(get("year"), 10)
	const month = parseInt(get("month"), 10) - 1
	const day = parseInt(get("day"), 10)

	// Wall-clock midnight interpreted as UTC (candidate instant)
	const midnightEpoch = Date.UTC(year, month, day, 0, 0, 0)

	// Evaluate the offset at the candidate midnight, not at the input date.
	// This ensures DST transitions between "now" and midnight are handled.
	const candidateMidnightUtc = new Date(midnightEpoch)
	const tzOffset = getTimezoneOffsetMinutes(candidateMidnightUtc, timezone)
	return new Date(midnightEpoch + tzOffset * 60 * 1000)
}

/**
 * Determines the time range based on the query's preset/from/to.
 * - today: from 00:00 today in the query timezone up to (but not including) 00:00 the next day
 * - 7d/30d: 7/30 calendar days including today
 * - all: all supported events
 */
export function resolveTimeRange(query: StatsQuery): { from?: Date; to?: Date } {
	if (query.preset) {
		const now = new Date()
		const tzNow = toTimezoneDate(now, query.timezone)

		switch (query.preset) {
			case "today": {
				const from = startOfDayInTimezone(tzNow, query.timezone)
				const to = new Date(from)
				to.setDate(to.getDate() + 1)
				return { from, to }
			}
			case "7d": {
				const to = startOfDayInTimezone(tzNow, query.timezone)
				to.setDate(to.getDate() + 1)
				const from = new Date(to)
				from.setDate(from.getDate() - 7)
				return { from, to }
			}
			case "30d": {
				const to = startOfDayInTimezone(tzNow, query.timezone)
				to.setDate(to.getDate() + 1)
				const from = new Date(to)
				from.setDate(from.getDate() - 30)
				return { from, to }
			}
			case "all":
				return {}
		}
	}

	// Explicit from/to
	const from = query.from ? new Date(query.from) : undefined
	const to = query.to ? new Date(query.to) : undefined
	return { from, to }
}

// ── Memoized date formatters ────────────────────────────────────────────────
// Intl.DateTimeFormat construction is expensive; it happened once per event
// (day + month + week buckets). Formatters are immutable and thread-safe for
// reuse, so cache one per (timezone, kind) pair.
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getDateFormatter(timezone: string, kind: "day" | "month"): Intl.DateTimeFormat {
	const key = `${timezone}|${kind}`
	let formatter = dateFormatterCache.get(key)
	if (!formatter) {
		formatter =
			kind === "day"
				? new Intl.DateTimeFormat("en-CA", {
						timeZone: timezone,
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
					})
				: new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" })
		dateFormatterCache.set(key, formatter)
	}
	return formatter
}

/**
 * Computes the ISO 8601 week number (YYYY-Www format).
 * Calculated based on the timezone.
 */
function computeIsoWeekBucket(date: Date, timezone: string): string {
	const formatter = getDateFormatter(timezone, "day")
	const parts = formatter.formatToParts(date)
	const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10)
	const year = get("year")
	const month = get("month") - 1
	const day = get("day")

	// ISO week calculation
	const d = new Date(Date.UTC(year, month, day))
	const dayNum = d.getUTCDay() || 7 // Sunday=0 → 7
	d.setUTCDate(d.getUTCDate() + 4 - dayNum)
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
	const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)

	return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`
}

/**
 * Computes calendar bucket keys for an event based on the timezone.
 * DST is handled automatically by the Intl API.
 */
export function computeTimeBuckets(
	event: UsageEventV1,
	timezone: string,
): { dayBucket?: string; weekBucket?: string; monthBucket?: string } {
	const date = new Date(event.occurredAt)

	// day bucket: YYYY-MM-DD (timezone-based)
	const dayBucket = getDateFormatter(timezone, "day").format(date).replace(/\//g, "-")

	// month bucket: YYYY-MM
	const monthBucket = getDateFormatter(timezone, "month").format(date).replace(/\//g, "-")

	// week bucket: YYYY-Www (ISO week)
	const weekBucket = computeIsoWeekBucket(date, timezone)

	return { dayBucket, weekBucket, monthBucket }
}

/**
 * Serializes the bucket key object for use as a Map key.
 * Keys are sorted alphabetically for stable serialization.
 */
export function serializeBucketKey(key: Record<string, string>): string {
	return Object.keys(key)
		.sort()
		.map((k) => `${k}=${key[k]}`)
		.join("|")
}

/**
 * Returns the values of an event for a single axis.
 * The source axis can have multiple values depending on the source of costUsd.
 */
function getAxisValues(item: AggregatableEvent, axis: string): string[] {
	const { event } = item

	switch (axis) {
		case "day":
			return item.dayBucket ? [item.dayBucket] : []
		case "week":
			return item.weekBucket ? [item.weekBucket] : []
		case "month":
			return item.monthBucket ? [item.monthBucket] : []
		case "provider":
			// When an endpoint domain is recorded (custom base URL), append it
			// to the provider key so distinct servers appear as separate rows.
			return [event.endpoint ? `${event.provider} (${event.endpoint})` : event.provider]
		case "model":
			return [event.model]
		case "mode":
			return [event.mode]
		case "status":
			return [event.status]
		case "source": {
			const sources = new Set<string>()
			if (event.usage.costUsd) {
				sources.add(event.usage.costUsd.source)
			} else {
				const computedCost = computeEventCost(event)
				if (computedCost > 0) {
					sources.add("estimated")
				}
			}
			if (event.usage.inputTokens) {
				sources.add(event.usage.inputTokens.source)
			}
			if (event.usage.outputTokens) {
				sources.add(event.usage.outputTokens.source)
			}
			if (sources.size === 0) {
				sources.add("unknown")
			}
			return Array.from(sources)
		}
		default:
			return []
	}
}

/**
 * Returns the bucket key combinations for the groupBy axes from the event.
 * Up to 3 axes can be combined (Cartesian product).
 */
function getGroupKeysForItem(item: AggregatableEvent, groupBy: StatsQuery["groupBy"]): Record<string, string>[] {
	if (groupBy.length === 0) {
		return [{}]
	}

	const axisValues: Record<string, string[]> = {}

	for (const axis of groupBy) {
		axisValues[axis] = getAxisValues(item, axis)
	}

	// Cartesian product
	const axes = Object.keys(axisValues)
	const results: Record<string, string>[] = [{}]

	for (const axis of axes) {
		const newResults: Record<string, string>[] = []
		for (const existing of results) {
			for (const value of axisValues[axis]) {
				newResults.push({ ...existing, [axis]: value })
			}
		}
		results.length = 0
		results.push(...newResults)
	}

	return results
}

/**
 * Computes the group keys for an event based on the groupBy axes and timezone.
 * This is the public API for computing breakdown bucket keys.
 */
export function computeGroupKeys(
	event: UsageEventV1,
	groupBy: StatsQuery["groupBy"],
	timezone: string,
): Record<string, string>[] {
	const timeBuckets = computeTimeBuckets(event, timezone)
	const item: AggregatableEvent = { event, ...timeBuckets }
	return getGroupKeysForItem(item, groupBy)
}

// ── Delta Computation (pure) ────────────────────────────────────────────────

/**
 * Computes the numeric delta a single event contributes to a bucket.
 * This is the pure extraction of the accumulation logic from
 * accumulateIntoBucket(). It does NOT perform query filtering —
 * it assumes the event has already passed the filter.
 *
 * @param event The usage event
 * @param cacheRatio Optional cache ratio for estimating cacheReadTokens
 * @param customPricing Optional query-time pricing map for custom models
 * @returns The delta values (without a bucket key)
 */
export function computeEventDelta(
	event: UsageEventV1,
	cacheRatio?: number,
	customPricing?: CustomModelPricingMap,
): BucketDeltaValues {
	// Status count
	const completedCalls = event.status === "completed" ? 1 : 0
	const failedCalls = event.status === "failed" ? 1 : 0
	const cancelledCalls = event.status === "cancelled" ? 1 : 0

	// Token extraction (inclusion semantics handling)
	const inputTokens = extractSourcedValue(event.usage.inputTokens)
	const outputTokens = extractSourcedValue(event.usage.outputTokens)
	let cacheReadTokens = extractSourcedValue(event.usage.cacheReadTokens)
	const cacheWriteTokens = extractSourcedValue(event.usage.cacheWriteTokens)
	const reasoningTokens = extractSourcedValue(event.usage.reasoningTokens)
	// Feature 1: If costUsd is missing on old events, compute it on-the-fly
	// from the model's pricing info. Never modifies the stored event.
	let costUsd = getEffectiveCost(event, customPricing)

	// Cache ratio cost discount: when the provider does NOT report cache
	// info (capability check, not raw value), the estimated cache-read
	// portion of the input is priced at the (cheaper) cache-read rate, so
	// the cost is reduced by cacheRatio × discountBase. Providers that DO
	// report cache keep their verbatim cost — cacheRead=0 is a true miss.
	const isCacheReadUnreported = !providerReportsCache(event.provider, event.model, event.modelPricing, customPricing)
	if (isCacheReadUnreported && cacheRatio !== undefined && cacheRatio > 0) {
		costUsd = applyCacheDiscount(costUsd, computeCacheDiscountBase(event, customPricing), cacheRatio)
	}

	// Cache ratio estimation: if provider doesn't report cache info
	// (capability) and cacheRatio is provided, estimate cacheRead as
	// inputTokens * cacheRatio. For reporting providers, cacheRead stays
	// at the server-reported value (0 for a true cache miss).
	const isCacheReadEstimated = isCacheReadUnreported && cacheRatio !== undefined && cacheRatio > 0
	if (isCacheReadEstimated) {
		cacheReadTokens = Math.round(inputTokens * cacheRatio)
	}

	// Inclusion semantics check
	const hasUnknownInclusion =
		event.semantics.cacheReadInInput === "unknown" ||
		event.semantics.cacheWriteInInput === "unknown" ||
		event.semantics.reasoningInOutput === "unknown"
	const unknownEventCount = hasUnknownInclusion ? 1 : 0

	// Token accumulation:
	// cacheRead/cacheWrite/reasoning are accumulated regardless of inclusion
	// rule (the rule only affects whether they're "included" in input/output,
	// but we track them separately for reporting).
	//
	// totalTokens is recomputed from input + output (provider-neutral) to
	// repair historical events that may have been persisted with the old
	// double-counted sum.
	const totalTokens = inputTokens + outputTokens

	return {
		events: 1,
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
		unknownEventCount,
	}
}

/**
 * Applies a delta to a bucket in place (mutates the bucket).
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

// ── Public Contribution Function ────────────────────────────────────────────

/**
 * Computes the contribution of a single event to a given query.
 *
 * This is a pure function: no side effects, no database access.
 * It checks whether the event matches the query's filter (time range,
 * cancelled status) and, if so, returns the delta the event would
 * contribute to the query's totals bucket.
 *
 * The returned delta has an empty key `{}`. Callers that need
 * per-group breakdown deltas should use {@link computeGroupKeys} to
 * determine the appropriate bucket keys and clone the delta with
 * each key.
 *
 * @param event The usage event to evaluate
 * @param query The statistics query (provides time range, cancelled filter, cacheRatio)
 * @param customPricing Optional query-time pricing map for custom models
 * @returns The bucket delta, or null if the event does not match the query filter
 */
export function computeEventContribution(
	event: UsageEventV1,
	query: StatsQuery,
	customPricing?: CustomModelPricingMap,
): StatsBucketDelta | null {
	// 1. Time range filtering
	const { from, to } = resolveTimeRange(query)
	const eventTime = new Date(event.occurredAt).getTime()
	if (from && eventTime < from.getTime()) return null
	if (to && eventTime >= to.getTime()) return null

	// 2. Cancelled event filtering
	const includeCancelled = query.includeCancelled ?? false
	if (!includeCancelled && event.status === "cancelled") return null

	// 3. Compute delta values
	const delta = computeEventDelta(event, query.cacheRatio, customPricing)

	// 4. Return with empty key (caller assigns group-specific keys)
	return { key: {}, ...delta }
}

// ── UsageAggregator ────────────────────────────────────────────────────────

/**
 * Usage event aggregation engine.
 *
 * Design principles (architecture report section 5.17):
 * - Group by day/week/month/provider/model/mode/status/source (up to 3 axes)
 * - Timezone calendar bucket (DST handling)
 * - Separate unknown fields (unknownEventCount)
 * - Separate cost by source (provider/estimated/backfilled)
 * - Handle inclusion semantics (cacheReadInInput etc.)
 * - Result sorting: time ascending, category by known total descending then name ascending
 */
export class UsageAggregator {
	/**
	 * Aggregates an array of events according to the query conditions and returns a StatsSnapshot.
	 *
	 * @param events Array of events to aggregate (result of UsageEventStore.readAll())
	 * @param query Statistics query
	 * @param options Additional options (e.g. recordingPaused, customPricing)
	 */
	query(
		events: UsageEventV1[],
		query: StatsQuery,
		options: { recordingPaused?: boolean; customPricing?: CustomModelPricingMap } = {},
	): StatsSnapshot {
		// 1. Time range filtering
		const { from, to } = resolveTimeRange(query)
		const filtered = events.filter((event) => {
			const eventTime = new Date(event.occurredAt).getTime()
			if (from && eventTime < from.getTime()) return false
			if (to && eventTime >= to.getTime()) return false
			return true
		})

		// 2. Cancelled event filtering
		const includeCancelled = query.includeCancelled ?? false
		const visibleEvents = includeCancelled ? filtered : filtered.filter((e) => e.status !== "cancelled")

		// 3. Compute bucket keys based on timezone
		const aggregatable: AggregatableEvent[] = visibleEvents.map((event) => {
			const bucketKeys = computeTimeBuckets(event, query.timezone)
			return { event, ...bucketKeys }
		})

		// 4. Grouping and aggregation
		const groupBy = query.groupBy
		const bucketMap = new Map<string, StatsBucket>()
		const cacheRatio = query.cacheRatio
		const customPricing = options.customPricing

		for (const item of aggregatable) {
			const bucketKeys = getGroupKeysForItem(item, groupBy)
			for (const bucketKey of bucketKeys) {
				const mapKey = serializeBucketKey(bucketKey)
				let bucket = bucketMap.get(mapKey)
				if (!bucket) {
					bucket = createEmptyBucket(bucketKey)
					bucketMap.set(mapKey, bucket)
				}
				this.accumulateIntoBucket(bucket, item.event, cacheRatio, customPricing)
			}
		}

		// 5. Compute totals
		const totals = createEmptyBucket()
		for (const item of aggregatable) {
			this.accumulateIntoBucket(totals, item.event, cacheRatio, customPricing)
		}

		// 6. Sorting
		const buckets = this.sortBuckets(Array.from(bucketMap.values()), groupBy)

		// 7. Compute coverage
		const coverage = this.computeCoverage(events, aggregatable, options.recordingPaused)

		return {
			query,
			generatedAt: new Date().toISOString(),
			buckets,
			totals,
			coverage,
		}
	}

	// ── Accumulation ────────────────────────────────────────────────────────

	/**
	 * Accumulates the event's values into the bucket.
	 * Delegates to the pure computeEventDelta function.
	 */
	private accumulateIntoBucket(
		bucket: StatsBucket,
		event: UsageEventV1,
		cacheRatio?: number,
		customPricing?: CustomModelPricingMap,
	): void {
		const delta = computeEventDelta(event, cacheRatio, customPricing)
		applyDeltaToBucket(bucket, delta)
	}

	// ── Sorting ────────────────────────────────────────────────────────────

	/**
	 * Sorts the buckets.
	 * - If a time axis (day/week/month) is present, sort by time ascending
	 * - If only category axes are present, sort by known total descending then name ascending
	 */
	private sortBuckets(buckets: StatsBucket[], groupBy: StatsQuery["groupBy"]): StatsBucket[] {
		const hasTimeAxis = groupBy.some((g) => g === "day" || g === "week" || g === "month")

		if (hasTimeAxis) {
			// Sort by time axis
			const timeAxis = groupBy.find((g) => g === "day" || g === "week" || g === "month")!
			return buckets.sort((a, b) => {
				const aTime = a.key[timeAxis] ?? ""
				const bTime = b.key[timeAxis] ?? ""
				return aTime.localeCompare(bTime)
			})
		}

		// Category only: sort by known total descending then name ascending
		return buckets.sort((a, b) => {
			// Sort by totalTokens descending
			const diff = b.totalTokens - a.totalTokens
			if (diff !== 0) return diff

			// Sort by name ascending
			const aName = Object.values(a.key).join("/")
			const bName = Object.values(b.key).join("/")
			return aName.localeCompare(bName)
		})
	}

	// ── Coverage ────────────────────────────────────────────────────────────

	/**
	 * Computes coverage information.
	 */
	private computeCoverage(
		allEvents: UsageEventV1[],
		visibleEvents: AggregatableEvent[],
		recordingPaused: boolean = false,
	): StatsSnapshot["coverage"] {
		const times = visibleEvents.map((e) => new Date(e.event.occurredAt).getTime()).sort((a, b) => a - b)

		const backfilledEventCount = visibleEvents.filter((e) => e.event.provenance === "history-backfill").length

		return {
			firstEventAt: times.length > 0 ? new Date(times[0]).toISOString() : undefined,
			lastEventAt: times.length > 0 ? new Date(times[times.length - 1]).toISOString() : undefined,
			recordingPaused,
			backfilledEventCount,
		}
	}
}
