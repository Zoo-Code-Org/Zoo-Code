import type {
	UsageEventV1,
	StatsQuery,
	StatsSnapshot,
	StatsBucket,
	SourcedNumber,
	UsageValueSource,
} from "@roo-code/types"

import { getEffectiveCost, computeEventCost } from "./costRecalculation"

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
	 * @param options Additional options (e.g. recordingPaused)
	 */
	query(events: UsageEventV1[], query: StatsQuery, options: { recordingPaused?: boolean } = {}): StatsSnapshot {
		// 1. Time range filtering
		const { from, to } = this.resolveTimeRange(query)
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
			const bucketKeys = this.computeTimeBuckets(event, query.timezone)
			return { event, ...bucketKeys }
		})

		// 4. Grouping and aggregation
		const groupBy = query.groupBy
		const bucketMap = new Map<string, StatsBucket>()

		for (const item of aggregatable) {
			const bucketKeys = this.getGroupKeys(item, groupBy)
			for (const bucketKey of bucketKeys) {
				const mapKey = this.serializeKey(bucketKey)
				let bucket = bucketMap.get(mapKey)
				if (!bucket) {
					bucket = createEmptyBucket(bucketKey)
					bucketMap.set(mapKey, bucket)
				}
				this.accumulateIntoBucket(bucket, item.event)
			}
		}

		// 5. Compute totals
		const totals = createEmptyBucket()
		for (const item of aggregatable) {
			this.accumulateIntoBucket(totals, item.event)
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

	// ── Time Range Resolution ───────────────────────────────────────────────

	/**
	 * Determines the time range based on the query's preset/from/to.
	 * - today: from 00:00 today in the query timezone up to (but not including) 00:00 the next day
	 * - 7d/30d: 7/30 calendar days including today
	 * - all: all supported events
	 */
	private resolveTimeRange(query: StatsQuery): { from?: Date; to?: Date } {
		if (query.preset) {
			const now = new Date()
			const tzNow = this.toTimezoneDate(now, query.timezone)

			switch (query.preset) {
				case "today": {
					const from = this.startOfDay(tzNow, query.timezone)
					const to = new Date(from)
					to.setDate(to.getDate() + 1)
					return { from, to }
				}
				case "7d": {
					const to = this.startOfDay(tzNow, query.timezone)
					to.setDate(to.getDate() + 1)
					const from = new Date(to)
					from.setDate(from.getDate() - 7)
					return { from, to }
				}
				case "30d": {
					const to = this.startOfDay(tzNow, query.timezone)
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

	/**
	 * Converts a UTC Date to the same instant in the specified timezone.
	 * Uses the Intl API to handle DST automatically.
	 */
	private toTimezoneDate(date: Date, timezone: string): Date {
		// Get the wall-clock time in the timezone
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
		// tzOffset = UTC - (timezone wall-clock as UTC)
		// Actual UTC of timezone wall-clock = wall-clock as UTC + tzOffset
		const utcGuess = Date.UTC(year, month, day, hour, minute, second)
		const tzOffset = this.getTimezoneOffsetMinutes(date, timezone)
		return new Date(utcGuess + tzOffset * 60 * 1000)
	}

	/**
	 * Returns the UTC offset for the specified timezone in minutes.
	 */
	private getTimezoneOffsetMinutes(date: Date, timezone: string): number {
		// Format the UTC time in the timezone
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

		// Convert timezone wall-clock to UTC epoch
		const tzEpoch = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond)
		// offset = UTC epoch - timezone epoch (in minutes)
		// If the timezone is ahead of UTC (e.g. Asia/Seoul = +9), tzEpoch is less than the UTC epoch
		// offset = (utcEpoch - tzEpoch) / 60000
		return Math.round((utcDate.getTime() - tzEpoch) / 60000)
	}

	/**
	 * Returns the 00:00:00 UTC for the given date based on the timezone.
	 */
	private startOfDay(date: Date, timezone: string): Date {
		const tzDate = this.toTimezoneDate(date, timezone)
		// Extract only the wall-clock date in the timezone
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

		// Convert 00:00:00 in the timezone to UTC
		const midnightEpoch = Date.UTC(year, month, day, 0, 0, 0)
		const tzOffset = this.getTimezoneOffsetMinutes(date, timezone)
		// tzOffset = UTC - (timezone wall-clock as UTC)
		// Actual UTC of timezone midnight = timezone midnight wall-clock as UTC + tzOffset
		return new Date(midnightEpoch + tzOffset * 60 * 1000)
	}

	// ── Time Bucket Computation ─────────────────────────────────────────────

	/**
	 * Computes calendar bucket keys for an event based on the timezone.
	 * DST is handled automatically by the Intl API.
	 */
	private computeTimeBuckets(
		event: UsageEventV1,
		timezone: string,
	): { dayBucket?: string; weekBucket?: string; monthBucket?: string } {
		const date = new Date(event.occurredAt)

		// day bucket: YYYY-MM-DD (timezone-based)
		const dayFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
		const dayBucket = dayFormatter.format(date).replace(/\//g, "-")

		// month bucket: YYYY-MM
		const monthFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
		})
		const monthBucket = monthFormatter.format(date).replace(/\//g, "-")

		// week bucket: YYYY-Www (ISO week)
		const weekBucket = this.computeIsoWeekBucket(date, timezone)

		return { dayBucket, weekBucket, monthBucket }
	}

	/**
	 * Computes the ISO 8601 week number (YYYY-Www format).
	 * Calculated based on the timezone.
	 */
	private computeIsoWeekBucket(date: Date, timezone: string): string {
		// Get the date in the timezone
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
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

	// ── Grouping ────────────────────────────────────────────────────────────

	/**
	 * Returns the bucket key combinations for the groupBy axes from the event.
	 * Up to 3 axes can be combined.
	 */
	private getGroupKeys(item: AggregatableEvent, groupBy: StatsQuery["groupBy"]): Record<string, string>[] {
		if (groupBy.length === 0) {
			return [{}]
		}

		// Get possible values for each axis as arrays, then compute Cartesian product
		const axisValues: Record<string, string[]> = {}

		for (const axis of groupBy) {
			axisValues[axis] = this.getAxisValues(item, axis)
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
	 * Returns the values of an event for a single axis.
	 * The source axis can have multiple values depending on the source of costUsd.
	 */
	private getAxisValues(item: AggregatableEvent, axis: string): string[] {
		const { event } = item

		switch (axis) {
			case "day":
				return item.dayBucket ? [item.dayBucket] : []
			case "week":
				return item.weekBucket ? [item.weekBucket] : []
			case "month":
				return item.monthBucket ? [item.monthBucket] : []
			case "provider":
				return [event.provider]
			case "model":
				return [event.model]
			case "mode":
				return [event.mode]
			case "status":
				return [event.status]
			case "source": {
				// Separate by the source of costUsd.
				// Feature 1: If the event has no costUsd but the cost can be
				// computed on-the-fly from model pricing, treat the source as
				// "estimated" (since it is derived, not provider-reported).
				const sources = new Set<string>()
				if (event.usage.costUsd) {
					sources.add(event.usage.costUsd.source)
				} else {
					// Check if cost can be computed; if so, mark as "estimated".
					// Otherwise the source remains "unknown".
					const computedCost = computeEventCost(event)
					if (computedCost > 0) {
						sources.add("estimated")
					}
				}
				// Also consider the source of input/output tokens
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

	// ── Accumulation ────────────────────────────────────────────────────────

	/**
	 * Accumulates the event's values into the bucket.
	 * Handles inclusion semantics.
	 */
	private accumulateIntoBucket(bucket: StatsBucket, event: UsageEventV1): void {
		bucket.events++

		// Status count
		switch (event.status) {
			case "completed":
				bucket.completedCalls++
				break
			case "failed":
				bucket.failedCalls++
				break
			case "cancelled":
				bucket.cancelledCalls++
				break
		}

		// Token accumulation (inclusion semantics handling)
		// If cacheReadInInput is "included", do not subtract cacheReadTokens from inputTokens (already included)
		// If "excluded", add separately
		// If "unknown", increment unknownEventCount

		const inputTokens = this.extractValue(event.usage.inputTokens)
		const outputTokens = this.extractValue(event.usage.outputTokens)
		const cacheReadTokens = this.extractValue(event.usage.cacheReadTokens)
		const cacheWriteTokens = this.extractValue(event.usage.cacheWriteTokens)
		const reasoningTokens = this.extractValue(event.usage.reasoningTokens)
		const totalTokens = this.extractValue(event.usage.totalTokens)
		// Feature 1: If costUsd is missing on old events, compute it on-the-fly
		// from the model's pricing info. Never modifies the stored event.
		const costUsd = getEffectiveCost(event)

		// Inclusion semantics check
		const hasUnknownInclusion =
			event.semantics.cacheReadInInput === "unknown" ||
			event.semantics.cacheWriteInInput === "unknown" ||
			event.semantics.reasoningInOutput === "unknown"

		if (hasUnknownInclusion) {
			bucket.unknownEventCount++
		}

		// Accumulate token values
		// If cacheReadInInput is "included", cacheRead is already included in inputTokens,
		// so do not add cacheReadTokens separately (prevent duplication)
		// If "excluded", add cacheReadTokens separately
		bucket.inputTokens += inputTokens
		bucket.outputTokens += outputTokens

		if (event.semantics.cacheReadInInput === "excluded") {
			bucket.cacheReadTokens += cacheReadTokens
		} else if (event.semantics.cacheReadInInput === "included") {
			// Already included in inputTokens, so no separate addition
			// But record it in the cacheReadTokens field (for reference)
			bucket.cacheReadTokens += cacheReadTokens
		} else {
			// unknown: add for now, but mark via unknownEventCount
			bucket.cacheReadTokens += cacheReadTokens
		}

		if (event.semantics.cacheWriteInInput === "excluded") {
			bucket.cacheWriteTokens += cacheWriteTokens
		} else if (event.semantics.cacheWriteInInput === "included") {
			bucket.cacheWriteTokens += cacheWriteTokens
		} else {
			bucket.cacheWriteTokens += cacheWriteTokens
		}

		if (event.semantics.reasoningInOutput === "excluded") {
			bucket.reasoningTokens += reasoningTokens
		} else if (event.semantics.reasoningInOutput === "included") {
			bucket.reasoningTokens += reasoningTokens
		} else {
			bucket.reasoningTokens += reasoningTokens
		}

		bucket.totalTokens += totalTokens
		bucket.costUsd += costUsd
	}

	/**
	 * Extracts the value from a SourcedNumber.
	 */
	private extractValue(sourced?: SourcedNumber): number {
		return sourced?.value ?? 0
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

	// ── Utilities ───────────────────────────────────────────────────────────

	/**
	 * Serializes the bucket key object for use as a Map key.
	 */
	private serializeKey(key: Record<string, string>): string {
		return Object.keys(key)
			.sort()
			.map((k) => `${k}=${key[k]}`)
			.join("|")
	}
}
