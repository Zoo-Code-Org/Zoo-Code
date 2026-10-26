import type { TFunction } from "i18next"

import { formatLargeNumber, formatDate, formatTimeAgo } from "../format"

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

describe("formatDate", () => {
	it("should format date in English", () => {
		const timestamp = new Date("2024-01-15T14:30:00").getTime()
		const result = formatDate(timestamp)
		// The exact format depends on the locale, but it should contain the date components
		expect(result).toMatch(/january|jan/i)
		expect(result).toMatch(/15/)
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
