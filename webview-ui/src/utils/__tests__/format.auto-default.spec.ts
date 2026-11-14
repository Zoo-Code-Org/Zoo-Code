import { formatDateOnly, formatTimeOnly, hourCycleOptions } from "../format"

// Wed 27 May 2026, 15:00 local - a time where a 12h/24h difference is visible.
const timestamp = new Date(2026, 4, 27, 15, 0, 0).getTime()

describe("formatDateOnly - the default order is the auto order", () => {
	it("leaves an omitted order to the locale, the same as asking for auto", () => {
		expect(formatDateOnly(timestamp, "en")).toBe(formatDateOnly(timestamp, "en", "auto"))
	})

	it("uses the fixed numeric orders when they are asked for", () => {
		expect(formatDateOnly(timestamp, "en", "mdy")).toBe("05/27/2026")
		expect(formatDateOnly(timestamp, "en", "dmy")).toBe("27/05/2026")
		expect(formatDateOnly(timestamp, "en", "ymd")).toBe("2026-05-27")
		expect(formatDateOnly(timestamp, "en")).not.toBe(formatDateOnly(timestamp, "en", "ymd"))
	})
})

describe("formatTimeOnly - the default clock is the auto clock", () => {
	it("leaves an omitted format to the locale, the same as asking for auto", () => {
		expect(formatTimeOnly(timestamp, "en-US")).toBe(formatTimeOnly(timestamp, "en-US", "auto"))
	})

	it("honours an explicit 24h clock over the locale default", () => {
		expect(formatTimeOnly(timestamp, "en-US", "24h")).not.toBe(formatTimeOnly(timestamp, "en-US", "auto"))
		expect(formatTimeOnly(timestamp, "en-US", "24h")).toContain("15:00")
	})
})

describe("hourCycleOptions - what auto hands to the locale", () => {
	it("hands the locale nothing for auto, whether asked for or left out", () => {
		expect(hourCycleOptions()).toStrictEqual({})
		expect(hourCycleOptions("auto")).toStrictEqual({})
	})

	it("maps the two explicit clocks to their hour-cycle options", () => {
		expect(hourCycleOptions("12h")).toStrictEqual({ hour12: true })
		expect(hourCycleOptions("24h")).toStrictEqual({ hourCycle: "h23" })
	})
})
