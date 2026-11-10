import { afterAll, describe, expect, it } from "vitest"

import type { HistoryItem } from "@roo-code/types"

import { rangeStart, summarizeUsage, usageToCsv } from "../usage"

// These cases only mean something in a zone that observes DST: in UTC a fixed 24h step and a calendar
// day are the same thing, so the old implementation would pass. The zone is pinned here, and every test
// asserts that its fixture really crosses an offset change, so a runner that ignores TZ fails loudly
// instead of passing vacuously.
//
// The zone must be set before any fixture below is computed (they are built at collection time), so it
// is set at module level rather than in beforeAll.
const previousZone = process.env.TZ
process.env.TZ = "America/New_York"

afterAll(() => {
	if (previousZone === undefined) delete process.env.TZ
	else process.env.TZ = previousZone
})

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime()
const offsetOf = (ts: number) => new Date(ts).getTimezoneOffset()

let counter = 0
const item = (overrides: Partial<HistoryItem>): HistoryItem => ({
	id: `dst${++counter}`,
	number: counter,
	ts: 0,
	task: `task ${counter}`,
	tokensIn: 100,
	tokensOut: 0,
	totalCost: 1,
	workspace: "/ws/a",
	...overrides,
})

// US clocks go forward on 2026-03-08 (a 23h day) and back on 2026-11-01 (a 25h day).
const SPRING = { now: at(2026, 2, 11, 15), firstDay: at(2026, 2, 5), lastDay: at(2026, 2, 11) }
const FALL = { now: at(2026, 10, 4, 15), firstDay: at(2026, 9, 29), lastDay: at(2026, 10, 4) }

describe.each([
	["spring forward (23h day)", SPRING],
	["fall back (25h day)", FALL],
])("a 7-day window across %s", (_name, w) => {
	it("really crosses a clock change in this runner", () => {
		expect(offsetOf(w.firstDay)).not.toBe(offsetOf(w.lastDay))
	})

	it("starts at local midnight", () => {
		const start = rangeStart("7d", w.now)!
		expect(start).toBe(w.firstDay)
		expect(new Date(start).getHours()).toBe(0)
		expect(new Date(start).getMinutes()).toBe(0)
	})

	it("charts one bar per calendar day, ending on today", () => {
		const { daily } = summarizeUsage([item({ ts: w.now - 60_000 })], { range: "7d", now: w.now })

		expect(daily).toHaveLength(7)
		// Every bar is a local midnight, on consecutive calendar dates, with no day skipped or repeated.
		const dates = daily.map((d) => new Date(d.day))
		dates.forEach((d) => expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]))
		dates.slice(1).forEach((d, i) => {
			const prev = new Date(dates[i])
			prev.setDate(prev.getDate() + 1)
			expect(d.getTime()).toBe(prev.getTime())
		})
		expect(daily[0].day).toBe(w.firstDay)
		expect(daily.at(-1)!.day).toBe(w.lastDay)
	})

	it("puts today's spend in today's bar, so the bars add up to the total", () => {
		const history = [
			item({ ts: w.firstDay + 30 * 60_000, totalCost: 2 }),
			item({ ts: w.lastDay + 30 * 60_000, totalCost: 3 }),
		]
		const s = summarizeUsage(history, { range: "7d", now: w.now })
		expect(s.totalCost).toBe(5)
		expect(s.daily.at(-1)).toMatchObject({ day: w.lastDay, cost: 3 })
		expect(s.daily[0]).toMatchObject({ day: w.firstDay, cost: 2 })
		expect(s.daily.reduce((sum, d) => sum + d.cost, 0)).toBe(s.totalCost)
	})

	it("includes a task from the first minute of the first day, and excludes the minute before it", () => {
		const csv = usageToCsv(
			[
				item({ task: "first-minute", ts: w.firstDay + 60_000 }),
				item({ task: "just-before", ts: w.firstDay - 60_000 }),
			],
			{ range: "7d", now: w.now },
		)
		expect(csv).toContain("first-minute")
		expect(csv).not.toContain("just-before")
	})
})

describe("a 30-day window across a clock change", () => {
	it("charts 30 consecutive local days ending on today", () => {
		const now = at(2026, 10, 3, 15)
		expect(offsetOf(rangeStart("30d", now)!)).not.toBe(offsetOf(now))

		const { daily } = summarizeUsage([item({ ts: now - 60_000 })], { range: "30d", now })
		expect(daily).toHaveLength(30)
		expect(daily.at(-1)!.day).toBe(at(2026, 10, 3))
		daily.forEach((d) => expect(new Date(d.day).getHours()).toBe(0))
		expect(new Set(daily.map((d) => d.day)).size).toBe(30)
	})
})

// The ends of a day that is 23 or 25 hours long, to the millisecond, built from local calendar fields (a fixed 24-hour
// step would put them an hour off, or on the wrong day).
describe.each([
	["the 23-hour day of spring forward", { y: 2026, m: 2, d: 8, hours: 23 }],
	["the 25-hour day of fall back", { y: 2026, m: 10, d: 1, hours: 25 }],
])("the ends of %s", (_name, day) => {
	const first = new Date(day.y, day.m, day.d, 0, 0, 0, 0).getTime()
	const last = new Date(day.y, day.m, day.d, 23, 59, 59, 999).getTime()
	const nextFirst = new Date(day.y, day.m, day.d + 1, 0, 0, 0, 0).getTime()
	const previousLast = new Date(day.y, day.m, day.d - 1, 23, 59, 59, 999).getTime()
	const now = new Date(day.y, day.m, day.d, 12, 0).getTime()
	const tasks = () => [
		item({ task: "previous-last-ms", ts: previousLast }),
		item({ task: "first-ms", ts: first }),
		item({ task: "last-ms", ts: last }),
		item({ task: "next-first-ms", ts: nextFirst }),
	]
	const written = (range: "today" | "7d" | "30d") =>
		usageToCsv(tasks(), { range, now })
			.split("\n")
			.slice(1)
			.map((row) => /"(task [^"]*|[a-z-]+ms)"/.exec(row)?.[1])

	it("really is a day that is not 24 hours long in this runner", () => {
		expect((nextFirst - first) / 3_600_000).toBe(day.hours)
		expect(last - first).toBe(day.hours * 3_600_000 - 1)
	})

	it.each([
		["today", ["first-ms", "last-ms"]],
		["7d", ["previous-last-ms", "first-ms", "last-ms"]],
		["30d", ["previous-last-ms", "first-ms", "last-ms"]],
	] as const)(
		"writes exactly the tasks of %s, oldest first: both ends of the day, and neither the millisecond after it nor, for today, the one before",
		(range, expected) => {
			// The first millisecond of tomorrow is after today, and the last of yesterday is before it.
			expect(written(range)).toEqual(expected)
		},
	)

	it.each(["today", "7d", "30d"] as const)(
		"counts the same tasks in the totals as rows in the export, for %s",
		(range) => {
			const summary = summarizeUsage(tasks(), { range, now })

			expect(summary.taskCount).toBe(written(range).length)
			if (range === "today") {
				expect(summary.daily).toHaveLength(1)
				expect(summary.daily[0]).toMatchObject({ day: first })
			}
		},
	)

	it("for a window that begins on this day, includes the first millisecond and excludes the one before", () => {
		const windowNow = new Date(day.y, day.m, day.d + 6, 12, 0).getTime() // this day is the first of its 7 days

		expect(rangeStart("7d", windowNow)).toBe(first)
		const rows = usageToCsv(tasks(), { range: "7d", now: windowNow })
		expect(rows).toContain("first-ms")
		expect(rows).not.toContain("previous-last-ms")
	})
})
