import type { TFunction } from "i18next"
import {
	formatLargeNumber,
	formatDateOnly,
	formatDateTime,
	formatMessageTime,
	formatTimeAgo,
	formatTimeOnly,
	hourCycleOptions,
	resolveLocale,
} from "../format"

// Mock i18next
vi.mock("i18next", () => ({
	default: { language: "en" },
}))

// Returns translation keys with interpolated values appended.
const t = ((key: string, options?: { count?: number }) => {
	const translations: Record<string, string> = {
		"common:number_format.billion_suffix": "b",
		"common:number_format.million_suffix": "m",
		"common:number_format.thousand_suffix": "k",
		"common:time_ago.just_now": "just now",
		"common:time_ago.seconds_ago": "{{count}} seconds ago",
		"common:time_ago.minute_ago": "a minute ago",
		"common:time_ago.minutes_ago": "{{count}} minutes ago",
		"common:time_ago.hour_ago": "an hour ago",
		"common:time_ago.hours_ago": "{{count}} hours ago",
		"common:time_ago.day_ago": "a day ago",
		"common:time_ago.days_ago": "{{count}} days ago",
		"common:time_ago.week_ago": "a week ago",
		"common:time_ago.weeks_ago": "{{count}} weeks ago",
		"common:time_ago.month_ago": "a month ago",
		"common:time_ago.months_ago": "{{count}} months ago",
		"common:time_ago.year_ago": "a year ago",
		"common:time_ago.years_ago": "{{count}} years ago",
	}

	let result = translations[key] || key
	if (options?.count !== undefined) {
		result = result.replace("{{count}}", options.count.toString())
	}
	return result
}) as unknown as TFunction

describe("formatLargeNumber", () => {
	it("should format billions", () => {
		expect(formatLargeNumber(1500000000, t)).toBe("1.5b")
		expect(formatLargeNumber(2000000000, t)).toBe("2.0b")
	})

	it("should format millions", () => {
		expect(formatLargeNumber(1500000, t)).toBe("1.5m")
		expect(formatLargeNumber(2000000, t)).toBe("2.0m")
	})

	it("should format thousands", () => {
		expect(formatLargeNumber(1500, t)).toBe("1.5k")
		expect(formatLargeNumber(2000, t)).toBe("2.0k")
	})

	it("should return string for small numbers", () => {
		expect(formatLargeNumber(999, t)).toBe("999")
		expect(formatLargeNumber(100, t)).toBe("100")
	})

	it("takes suffixes from the given t", () => {
		const givenT = vi.fn((key: string) => (key === "common:number_format.thousand_suffix" ? " mil" : key))

		// `TFunction` is branded; the mock only needs to answer a key lookup.
		expect(formatLargeNumber(1500, givenT as unknown as TFunction)).toBe("1.5 mil")
		expect(givenT).toHaveBeenCalledWith("common:number_format.thousand_suffix")
	})
})

describe("hourCycleOptions", () => {
	it("leaves auto to the locale", () => {
		expect(hourCycleOptions("auto")).toEqual({})
		expect(hourCycleOptions()).toEqual({})
	})

	it("maps 12h / 24h", () => {
		expect(hourCycleOptions("12h")).toEqual({ hour12: true })
		// h23 (not hour12:false) avoids "24:05" rendering in some engines
		expect(hourCycleOptions("24h")).toEqual({ hourCycle: "h23" })
	})
})

describe("formatDateOnly", () => {
	const ts = new Date(2026, 9, 7, 14, 41).getTime() // 7 Oct 2026

	it.each([
		["mdy", "10/07/2026"],
		["dmy", "07/10/2026"],
		["ymd", "2026-10-07"],
	] as const)("writes %s as %s, zero-padded and locale-independent", (format, expected) => {
		expect(formatDateOnly(ts, "en", format)).toBe(expected)
	})

	it("follows the given locale for auto", () => {
		expect(formatDateOnly(ts, "en", "auto")).toMatch(/2026/)
		expect(formatDateOnly(ts, "en")).toBe(formatDateOnly(ts, "en", "auto"))
		expect(formatDateOnly(ts, "de", "auto")).toBe("07.10.2026")
	})
})

describe("formatTimeOnly", () => {
	const ts = new Date(2026, 9, 27, 14, 41).getTime()

	it("honours 24h and 12h", () => {
		expect(formatTimeOnly(ts, "en", "24h")).toBe("14:41")
		expect(formatTimeOnly(ts, "en", "12h")).toMatch(/^2:41\s?PM$/i)
	})
})

describe("formatDateTime", () => {
	it("includes date and time honouring the formats", () => {
		const timestamp = new Date("2024-01-15T00:05:00").getTime()
		const result = formatDateTime(timestamp, "en", "24h")
		expect(result).toMatch(/2024/)
		expect(result).toMatch(/00:05/)
	})

	it("combines the chosen date order with the chosen clock", () => {
		const ts = new Date(2026, 9, 27, 14, 41).getTime()
		expect(formatDateTime(ts, "en", "24h", "dmy")).toBe("27/10/2026, 14:41")
		expect(formatDateTime(ts, "en", "24h", "ymd")).toBe("2026-10-27, 14:41")
	})
})

describe("formatTimeAgo", () => {
	let originalDateNow: () => number

	beforeEach(() => {
		// Mock Date.now to have a consistent "now" time
		originalDateNow = Date.now
		Date.now = vi.fn(() => new Date("2024-01-15T12:00:00").getTime())
	})

	afterEach(() => {
		// Restore original Date.now
		Date.now = originalDateNow
	})

	it('should return "just now" for very recent times', () => {
		const timestamp = new Date("2024-01-15T11:59:35").getTime() // 25 seconds ago
		expect(formatTimeAgo(timestamp, t)).toBe("just now")
	})

	it("should format seconds ago", () => {
		const timestamp = new Date("2024-01-15T11:59:15").getTime() // 45 seconds ago
		expect(formatTimeAgo(timestamp, t)).toBe("45 seconds ago")
	})

	it("should format a minute ago", () => {
		const timestamp = new Date("2024-01-15T11:59:00").getTime() // 1 minute ago
		expect(formatTimeAgo(timestamp, t)).toBe("a minute ago")
	})

	it("should format minutes ago", () => {
		const timestamp = new Date("2024-01-15T11:45:00").getTime() // 15 minutes ago
		expect(formatTimeAgo(timestamp, t)).toBe("15 minutes ago")
	})

	it("should format an hour ago", () => {
		const timestamp = new Date("2024-01-15T11:00:00").getTime() // 1 hour ago
		expect(formatTimeAgo(timestamp, t)).toBe("an hour ago")
	})

	it("should format hours ago", () => {
		const timestamp = new Date("2024-01-15T09:00:00").getTime() // 3 hours ago
		expect(formatTimeAgo(timestamp, t)).toBe("3 hours ago")
	})

	it("should format a day ago", () => {
		const timestamp = new Date("2024-01-14T12:00:00").getTime() // 1 day ago
		expect(formatTimeAgo(timestamp, t)).toBe("a day ago")
	})

	it("should format days ago", () => {
		const timestamp = new Date("2024-01-12T12:00:00").getTime() // 3 days ago
		expect(formatTimeAgo(timestamp, t)).toBe("3 days ago")
	})

	it("should format a week ago", () => {
		const timestamp = new Date("2024-01-08T12:00:00").getTime() // 7 days ago
		expect(formatTimeAgo(timestamp, t)).toBe("a week ago")
	})

	it("should format weeks ago", () => {
		const timestamp = new Date("2024-01-01T12:00:00").getTime() // 14 days ago
		expect(formatTimeAgo(timestamp, t)).toBe("2 weeks ago")
	})

	it("should format a month ago", () => {
		const timestamp = new Date("2023-12-15T12:00:00").getTime() // ~1 month ago
		expect(formatTimeAgo(timestamp, t)).toBe("a month ago")
	})

	it("should format months ago", () => {
		const timestamp = new Date("2023-10-15T12:00:00").getTime() // ~3 months ago
		expect(formatTimeAgo(timestamp, t)).toBe("3 months ago")
	})

	it("should format a year ago", () => {
		const timestamp = new Date("2023-01-15T12:00:00").getTime() // 1 year ago
		expect(formatTimeAgo(timestamp, t)).toBe("a year ago")
	})

	it("should format years ago", () => {
		const timestamp = new Date("2021-01-15T12:00:00").getTime() // 3 years ago
		expect(formatTimeAgo(timestamp, t)).toBe("3 years ago")
	})

	it("takes translations from the given t", () => {
		const givenT = vi.fn((key: string, options?: Record<string, unknown>) => `es:${key}:${options?.count}`)
		const timestamp = new Date("2024-01-15T09:00:00").getTime() // 3 hours ago

		// `TFunction` is branded; the mock only needs to answer a key lookup with `count`.
		expect(formatTimeAgo(timestamp, givenT as unknown as TFunction)).toBe("es:common:time_ago.hours_ago:3")
		expect(givenT).toHaveBeenCalledWith("common:time_ago.hours_ago", { count: 3 })
	})
})

describe("formatMessageTime", () => {
	// Wed 14 Oct 2026, 15:00 local.
	const NOW = new Date(2026, 9, 14, 15, 0).getTime()
	const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime()
	const fmt = (ts: number, opts: Parameters<typeof formatMessageTime>[2] = {}, locale = "en") =>
		formatMessageTime(ts, locale, { now: NOW, timeFormat: "12h", ...opts })

	it.each([
		["tomorrow", at(2026, 9, 15, 9, 5), /^Oct 15, 9:05\s?AM$/],
		["three days ahead", at(2026, 9, 17, 9, 5), /^Oct 17, 9:05\s?AM$/],
		["a month ahead", at(2026, 10, 14, 9, 5), /^Nov 14, 9:05\s?AM$/],
		["next year", at(2027, 9, 14, 9, 5), /^Oct 14, 2027, 9:05\s?AM$/],
	])("shows the date, not Today, Yesterday or a weekday, for a time %s", (_label, ts, expected) => {
		// A time after `now` (a clock that was set wrong, or a skewed host) is not "ago": it is dated.
		expect(fmt(ts)).toMatch(expected)
	})

	it("writes a future time with the chosen date order", () => {
		expect(fmt(at(2026, 9, 15, 9, 5), { timeFormat: "24h", dateFormat: "ymd" })).toBe("2026-10-15, 09:05")
	})

	it("says Today for the same calendar day", () => {
		expect(fmt(at(2026, 9, 14, 9, 5))).toMatch(/^Today 9:05\s?AM$/)
	})

	it("says Yesterday for the previous calendar day", () => {
		expect(fmt(at(2026, 9, 13, 11, 43))).toMatch(/^Yesterday 11:43\s?AM$/)
	})

	it("uses calendar-day boundaries, not 24-hour windows", () => {
		// 23:55 yesterday is only ~15h before NOW but is still "Yesterday"; 00:05 today is "Today".
		expect(fmt(at(2026, 9, 13, 23, 55))).toMatch(/^Yesterday/)
		expect(fmt(at(2026, 9, 14, 0, 5))).toMatch(/^Today/)
	})

	it("uses a weekday for the rest of the last week", () => {
		expect(fmt(at(2026, 9, 12, 8, 0))).toMatch(/^Mon 8:00\s?AM$/) // 12 Oct 2026 is a Monday
		expect(fmt(at(2026, 9, 8, 8, 0))).toMatch(/^Thu 8:00\s?AM$/) // 6 days ago
	})

	it("switches to a date at 7 days", () => {
		expect(fmt(at(2026, 9, 7, 8, 0))).toMatch(/^Oct 7, 8:00\s?AM$/)
	})

	it("omits the year within the current year and includes it otherwise", () => {
		expect(fmt(at(2026, 0, 2, 10, 0))).toMatch(/^Jan 2, 10:00\s?AM$/)
		expect(fmt(at(2025, 11, 31, 10, 0))).toMatch(/^Dec 31, 2025, 10:00\s?AM$/)
	})

	it("treats a message from earlier in a different year as older even when under 7 days away", () => {
		const newYear = new Date(2027, 0, 2, 12, 0).getTime()
		// 30 Dec 2026 is 3 days before → weekday, no year needed.
		expect(formatMessageTime(at(2026, 11, 30, 9, 0), "en", { now: newYear, timeFormat: "24h" })).toMatch(
			/^Wed 09:00$/,
		)
	})

	it("honours the 24-hour setting", () => {
		expect(fmt(at(2026, 9, 14, 14, 41), { timeFormat: "24h" })).toBe("Today 14:41")
	})

	describe("with a stored language that is not a usable locale", () => {
		const SENT = new Date(2024, 2, 7, 14, 41).getTime()

		it.each(["not a locale!!", "xx-ZZ-garbage", "xx-ZZ", "en_US", "---", "x"])(
			"formats in English instead of throwing for %j",
			(bad) => {
				expect(() => formatTimeOnly(SENT, bad)).not.toThrow()
				expect(() => formatDateOnly(SENT, bad)).not.toThrow()
				expect(() => formatDateTime(SENT, bad)).not.toThrow()
				expect(() => formatMessageTime(SENT, bad, { now: SENT })).not.toThrow()
				expect(formatMessageTime(SENT, bad, { now: SENT })).toContain("Today")
				expect(formatDateOnly(SENT, bad)).toBe(formatDateOnly(SENT, "en", "auto"))
				expect(formatTimeOnly(SENT, bad)).toBe(formatTimeOnly(SENT, "en", "auto"))
				expect(formatDateTime(SENT, bad)).toBe(formatDateTime(SENT, "en", "auto", "auto"))
			},
		)

		it("formats in English when no language is set at all", () => {
			expect(formatDateOnly(SENT, "")).toBe(formatDateOnly(SENT, "en", "auto"))
			expect(formatTimeOnly(SENT, "")).toBe(formatTimeOnly(SENT, "en", "auto"))
			expect(formatDateTime(SENT, "")).toBe(formatDateTime(SENT, "en", "auto", "auto"))
			expect(formatMessageTime(SENT, "", { now: SENT })).toContain("Today")
		})

		it("resolves a supported locale to itself, and a missing one to English", () => {
			expect(resolveLocale("de")).toBe("de")
			expect(resolveLocale(undefined)).toBe("en")
			expect(resolveLocale("")).toBe("en")
		})
	})

	describe("in another display language (automatic date format)", () => {
		it("names today and yesterday in that language", () => {
			expect(fmt(at(2026, 9, 14, 14, 41), { timeFormat: "24h" }, "de")).toBe("Heute 14:41")
			expect(fmt(at(2026, 9, 13, 11, 43), { timeFormat: "24h" }, "de")).toBe("Gestern 11:43")
		})

		it("names the weekday in that language", () => {
			expect(fmt(at(2026, 9, 12, 8, 0), { timeFormat: "24h" }, "de")).toMatch(/^Mo\.? 0?8:00$/) // a Monday
		})

		it("writes an older date in that language's own order and month name", () => {
			expect(fmt(at(2024, 2, 7, 14, 41), { timeFormat: "24h" }, "de")).toBe("7. März 2024, 14:41")
			// The same date within the current year leaves the year out.
			expect(fmt(at(2026, 2, 7, 14, 41), { timeFormat: "24h" }, "de")).toMatch(/^7\. März, 14:41$/)
		})

		it("still lets an explicit date order win over the language", () => {
			expect(fmt(at(2024, 2, 7, 14, 41), { timeFormat: "24h", dateFormat: "mdy" }, "de")).toBe(
				"03/07/2024, 14:41",
			)
		})
	})

	it("honours an explicit date order for older messages", () => {
		expect(fmt(at(2026, 0, 2, 10, 0), { timeFormat: "24h", dateFormat: "dmy" })).toBe("02/01/2026, 10:00")
		expect(fmt(at(2026, 0, 2, 10, 0), { timeFormat: "24h", dateFormat: "ymd" })).toBe("2026-01-02, 10:00")
	})

	it("keeps Today/Yesterday/weekday regardless of date order", () => {
		expect(fmt(at(2026, 9, 14, 9, 0), { dateFormat: "ymd" })).toMatch(/^Today/)
	})

	it("treats a future timestamp (clock skew) as today rather than a bogus label", () => {
		expect(fmt(at(2026, 9, 14, 23, 59))).toMatch(/^Today/)
	})
})
