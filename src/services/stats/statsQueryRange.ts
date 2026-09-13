// src/services/stats/statsQueryRange.ts
//
// Shared resolution of a StatsQuery time range into epoch-millisecond bounds.
//
// The main dashboard stats and the Dashboard "Tasks" list must agree on range
// bounds exactly, so this module is the single source of truth for:
//   preset → local-day bounds in the query timezone (via startOfDayInTimezone)
//   custom → explicit query.from/to ISO instants
// Inclusion is half-open: fromMs <= t < toMs. An absent bound is unbounded,
// and a fully unbounded range (preset "all" or no bounds at all) means no
// filtering.

import type { StatsQuery } from "@roo-code/types"

import { startOfDayInTimezone } from "./UsageAggregator"

/** Half-open [fromMs, toMs) epoch-millisecond bounds. An absent bound is unbounded. */
export interface StatsQueryRangeMs {
	fromMs?: number
	toMs?: number
}

/**
 * Resolves a StatsQuery time range to half-open epoch-millisecond bounds.
 * - preset: local-day bounds in the query timezone, evaluated at `now`
 * - otherwise: explicit query.from/to ISO instants
 * - preset "all" (or a query without any bounds): unbounded ({})
 */
export function resolveStatsQueryRangeMs(query: StatsQuery, now: Date = new Date()): StatsQueryRangeMs {
	if (query.preset) {
		const { from, to } = resolvePresetRange(query.preset, query.timezone, now)
		return { fromMs: from?.getTime(), toMs: to?.getTime() }
	}

	return {
		fromMs: query.from ? new Date(query.from).getTime() : undefined,
		toMs: query.to ? new Date(query.to).getTime() : undefined,
	}
}

/** Returns true when at least one side of the range is bounded (i.e. filtering applies). */
export function isStatsQueryRangeBounded(range: StatsQueryRangeMs | undefined): boolean {
	return range?.fromMs !== undefined || range?.toMs !== undefined
}

/**
 * Half-open inclusion test: fromMs <= timeMs < toMs.
 * An undefined or fully unbounded range includes every timestamp.
 */
export function isWithinStatsQueryRange(range: StatsQueryRangeMs | undefined, timeMs: number): boolean {
	if (range?.fromMs !== undefined && timeMs < range.fromMs) return false
	if (range?.toMs !== undefined && timeMs >= range.toMs) return false
	return true
}

/**
 * Computes the local-day time range from a preset.
 * "all" is intentionally unbounded.
 */
function resolvePresetRange(
	preset: NonNullable<StatsQuery["preset"]>,
	timezone: string,
	now: Date,
): { from?: Date; to?: Date } {
	const tzNow = startOfDayInTimezone(now, timezone)

	switch (preset) {
		case "today": {
			const from = new Date(tzNow)
			const to = new Date(from)
			to.setDate(to.getDate() + 1)
			return { from, to }
		}
		case "7d": {
			const to = new Date(tzNow)
			to.setDate(to.getDate() + 1)
			const from = new Date(to)
			from.setDate(from.getDate() - 7)
			return { from, to }
		}
		case "30d": {
			const to = new Date(tzNow)
			to.setDate(to.getDate() + 1)
			const from = new Date(to)
			from.setDate(from.getDate() - 30)
			return { from, to }
		}
		case "all":
			return {}
	}
}
