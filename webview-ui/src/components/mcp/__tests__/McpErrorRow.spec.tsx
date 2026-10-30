import React from "react"
import { render, screen } from "@/utils/test-utils"

import { McpErrorRow, formatRelativeTimestamp } from "../McpErrorRow"

// Thursday 29 October 2026, 12:00 local. Fixed so every expectation below is
// independent of the machine clock and timezone.
const BASE = new Date(2026, 9, 29, 12, 0, 0)

describe("formatRelativeTimestamp", () => {
	// Expected strings captured from date-fns `formatRelative` (en-US) before the
	// swap, so this table pins behaviour equivalence rather than new behaviour.
	it.each([
		["same day, earlier", new Date(2026, 9, 29, 9, 0), "today at 9:00 AM"],
		["same day, later", new Date(2026, 9, 29, 21, 5), "today at 9:05 PM"],
		["same day, midnight", new Date(2026, 9, 29, 0, 0), "today at 12:00 AM"],
		["previous day", new Date(2026, 9, 28, 23, 59), "yesterday at 11:59 PM"],
		["two days back", new Date(2026, 9, 27, 9, 0), "last Tuesday at 9:00 AM"],
		["six days back", new Date(2026, 9, 23, 9, 0), "last Friday at 9:00 AM"],
		["seven days back", new Date(2026, 9, 22, 9, 0), "10/22/2026"],
		["thirty days back", new Date(2026, 8, 29, 9, 0), "09/29/2026"],
		["four hundred days back", new Date(2025, 8, 24, 9, 0), "09/24/2025"],
		["next day", new Date(2026, 9, 30, 9, 0), "tomorrow at 9:00 AM"],
		["two days ahead", new Date(2026, 9, 31, 9, 0), "Saturday at 9:00 AM"],
		["six days ahead", new Date(2026, 10, 4, 9, 0), "Wednesday at 9:00 AM"],
		["seven days ahead", new Date(2026, 10, 5, 9, 0), "11/05/2026"],
	])("formats %s", (_label, date, expected) => {
		expect(formatRelativeTimestamp(date, BASE)).toBe(expected)
	})

	it("counts calendar days, not elapsed time", () => {
		// Two minutes apart, but on different calendar days. Expected strings
		// verified against date-fns `formatRelative` for the same inputs.
		expect(formatRelativeTimestamp(new Date(2026, 9, 29, 0, 1), new Date(2026, 9, 28, 23, 59))).toBe(
			"tomorrow at 12:01 AM",
		)
		expect(formatRelativeTimestamp(new Date(2026, 9, 28, 23, 59), new Date(2026, 9, 29, 0, 1))).toBe(
			"yesterday at 11:59 PM",
		)
	})

	it("throws on an invalid date", () => {
		expect(() => formatRelativeTimestamp(new Date(Number.NaN), BASE)).toThrow(RangeError)
	})

	it("keeps two-digit years instead of remapping them to 1900s", () => {
		// `new Date(99, 11, 31)` would mean 1999. These are real year-99 dates, and
		// the day delta across the year-99/100 boundary must stay one day.
		const year99 = new Date("0099-12-31T12:00:00")
		const year100 = new Date("0100-01-01T12:00:00")

		expect(year99.getFullYear()).toBe(99)
		expect(formatRelativeTimestamp(year99, year100)).toBe("yesterday at 12:00 PM")
		expect(formatRelativeTimestamp(year100, year99)).toBe("tomorrow at 12:00 PM")
		expect(formatRelativeTimestamp(year100, year100)).toBe("today at 12:00 PM")
	})
})

describe("McpErrorRow", () => {
	// Freeze the clock at a stable midday instant. Without this the component
	// formats against the live `new Date()` while the fixture is built from the
	// live `Date.now()`; in the first five minutes after local midnight the two
	// land on different calendar days and the "today at" assertion fails.
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(2026, 9, 29, 12, 0, 0))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("renders the error message and a relative timestamp", () => {
		const timestamp = Date.now() - 5 * 60 * 1000

		render(<McpErrorRow error={{ message: "Connection refused", timestamp, level: "error" }} />)

		expect(screen.getByText("Connection refused")).toBeInTheDocument()
		expect(screen.getByText("today at 11:55 AM")).toBeInTheDocument()
	})

	it("still renders a same-day timestamp just after local midnight", () => {
		// The exact window the flake appeared in: 00:02 local, five minutes ago
		// lands on the previous calendar day, so the phrasing must be "yesterday".
		vi.setSystemTime(new Date(2026, 9, 29, 0, 2, 0))

		render(<McpErrorRow error={{ message: "late", timestamp: Date.now() - 5 * 60 * 1000, level: "warn" }} />)

		expect(screen.getByText("yesterday at 11:57 PM")).toBeInTheDocument()
	})

	it.each([
		["error", "var(--vscode-testing-iconFailed)"],
		["warn", "var(--vscode-charts-yellow)"],
		["info", "var(--vscode-testing-iconPassed)"],
	] as const)("colors the %s level", (level, expectedColor) => {
		render(<McpErrorRow error={{ message: "msg", timestamp: Date.now(), level }} />)

		expect(screen.getByText("msg")).toHaveStyle({ color: expectedColor })
	})
})
