import type { StatsQuery } from "@roo-code/types"

import { isStatsQueryRangeBounded, isWithinStatsQueryRange, resolveStatsQueryRangeMs } from "../statsQueryRange"

function makeQuery(overrides: Partial<StatsQuery> = {}): StatsQuery {
	return {
		timezone: "UTC",
		groupBy: ["day"],
		includeCancelled: false,
		...overrides,
	}
}

describe("statsQueryRange", () => {
	describe("resolveStatsQueryRangeMs", () => {
		const now = new Date("2026-08-03T15:30:00.000Z")

		it("resolves preset today to local-day bounds in the query timezone", () => {
			const range = resolveStatsQueryRangeMs(makeQuery({ preset: "today" }), now)
			expect(range.fromMs).toBe(Date.parse("2026-08-03T00:00:00.000Z"))
			expect(range.toMs).toBe(Date.parse("2026-08-04T00:00:00.000Z"))
		})

		it("resolves preset 7d to seven calendar days including today", () => {
			const range = resolveStatsQueryRangeMs(makeQuery({ preset: "7d" }), now)
			expect(range.fromMs).toBe(Date.parse("2026-07-28T00:00:00.000Z"))
			expect(range.toMs).toBe(Date.parse("2026-08-04T00:00:00.000Z"))
		})

		it("resolves preset 30d to thirty calendar days including today", () => {
			const range = resolveStatsQueryRangeMs(makeQuery({ preset: "30d" }), now)
			expect(range.fromMs).toBe(Date.parse("2026-07-05T00:00:00.000Z"))
			expect(range.toMs).toBe(Date.parse("2026-08-04T00:00:00.000Z"))
		})

		it("resolves preset bounds in a non-UTC timezone", () => {
			// 2026-08-03 00:30 in Seoul is still 2026-08-02 in UTC.
			const seoulNow = new Date("2026-08-02T15:30:00.000Z")
			const range = resolveStatsQueryRangeMs(makeQuery({ preset: "today", timezone: "Asia/Seoul" }), seoulNow)
			// Seoul midnight (UTC+9) is 15:00Z of the previous UTC day.
			expect(range.fromMs).toBe(Date.parse("2026-08-02T15:00:00.000Z"))
			expect(range.toMs).toBe(Date.parse("2026-08-03T15:00:00.000Z"))
		})

		it("resolves preset all to an unbounded range", () => {
			expect(resolveStatsQueryRangeMs(makeQuery({ preset: "all" }), now)).toEqual({})
		})

		it("resolves explicit from/to ISO instants when no preset is set", () => {
			const range = resolveStatsQueryRangeMs(
				makeQuery({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" }),
				now,
			)
			expect(range.fromMs).toBe(Date.parse("2026-07-01T00:00:00.000Z"))
			expect(range.toMs).toBe(Date.parse("2026-07-31T23:59:59.999Z"))
		})

		it("keeps one-sided custom bounds and ignores from/to when a preset is set", () => {
			expect(resolveStatsQueryRangeMs(makeQuery({ from: "2026-07-01T00:00:00.000Z" }), now)).toEqual({
				fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
				toMs: undefined,
			})
			// Named presets resolve from the preset itself, never from from/to.
			expect(
				resolveStatsQueryRangeMs(
					makeQuery({ preset: "all", from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T00:00:00.000Z" }),
					now,
				),
			).toEqual({})
		})

		it("resolves a query without any bounds to an unbounded range", () => {
			expect(resolveStatsQueryRangeMs(makeQuery(), now)).toEqual({})
		})
	})

	describe("isStatsQueryRangeBounded", () => {
		it("is false for undefined or fully unbounded ranges and true otherwise", () => {
			expect(isStatsQueryRangeBounded(undefined)).toBe(false)
			expect(isStatsQueryRangeBounded({})).toBe(false)
			expect(isStatsQueryRangeBounded({ fromMs: 1 })).toBe(true)
			expect(isStatsQueryRangeBounded({ toMs: 2 })).toBe(true)
			expect(isStatsQueryRangeBounded({ fromMs: 1, toMs: 2 })).toBe(true)
		})
	})

	describe("isWithinStatsQueryRange", () => {
		it("applies half-open inclusion: fromMs <= t < toMs", () => {
			const range = { fromMs: 100, toMs: 200 }
			expect(isWithinStatsQueryRange(range, 99)).toBe(false)
			expect(isWithinStatsQueryRange(range, 100)).toBe(true)
			expect(isWithinStatsQueryRange(range, 199)).toBe(true)
			expect(isWithinStatsQueryRange(range, 200)).toBe(false)
		})

		it("includes every timestamp when the range is undefined or unbounded", () => {
			expect(isWithinStatsQueryRange(undefined, 0)).toBe(true)
			expect(isWithinStatsQueryRange({}, 0)).toBe(true)
			expect(isWithinStatsQueryRange({}, Number.MAX_SAFE_INTEGER)).toBe(true)
		})
	})
})
