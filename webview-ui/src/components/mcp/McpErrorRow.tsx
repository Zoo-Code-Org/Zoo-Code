import { useMemo } from "react"

import type { McpErrorEntry } from "@roo-code/types"

// `Intl.DateTimeFormat` instances are immutable and locale-fixed, so they are
// built once per timezone and cached instead of per render. The cache key is
// the resolved timezone string: an instance built without an explicit timeZone
// option resolves the zone at construction time, so reusing one instance
// across a runtime timezone change (tests, or a moved webview host) would
// format in the stale zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>()

const getFormatter = (options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const cacheKey = `${timeZone}:${JSON.stringify(options)}`
	let formatter = formatterCache.get(cacheKey)

	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone })
		formatterCache.set(cacheKey, formatter)
	}

	return formatter
}

const timeFormat = () => getFormatter({ hour: "numeric", minute: "2-digit" })
const weekdayFormat = () => getFormatter({ weekday: "long" })
const shortDateFormat = () => getFormatter({ year: "numeric", month: "2-digit", day: "2-digit" })

const MILLISECONDS_IN_DAY = 86_400_000
const MILLISECONDS_IN_MINUTE = 60_000

/**
 * Whole calendar days from `baseDate` to `date`, in local time.
 *
 * Calendar days, not elapsed milliseconds: 23:59 and 00:01 on consecutive days
 * are one day apart even though only two minutes elapsed.
 *
 * Each local midnight is normalized by its own UTC offset before dividing, the
 * same arithmetic `date-fns`' `differenceInCalendarDays` uses. Raw millisecond
 * subtraction alone breaks when the two midnights have different offsets:
 * Pacific/Apia skipped 2011-12-30 entirely (UTC-11 -> UTC+13), so the
 * 2011-12-29 and 2011-12-31 midnights are only 24h apart but are two calendar
 * days apart, and a 23h/25h DST day would otherwise round to the wrong side.
 *
 * The inputs are copied and zeroed with `setHours` rather than rebuilt through
 * `new Date(year, month, day)`, because that constructor maps years 0-99 onto
 * 1900-1999: a date in year 99 would be silently read as 1999 and produce a
 * delta of centuries instead of a day.
 */
const differenceInCalendarDays = (date: Date, baseDate: Date): number => {
	const dateMidnight = new Date(date)
	dateMidnight.setHours(0, 0, 0, 0)

	const baseMidnight = new Date(baseDate)
	baseMidnight.setHours(0, 0, 0, 0)

	const dateOffsetMs = dateMidnight.getTimezoneOffset() * MILLISECONDS_IN_MINUTE
	const baseOffsetMs = baseMidnight.getTimezoneOffset() * MILLISECONDS_IN_MINUTE

	return Math.round(
		(dateMidnight.getTime() - dateOffsetMs - (baseMidnight.getTime() - baseOffsetMs)) / MILLISECONDS_IN_DAY,
	)
}

/**
 * Render a timestamp the way `date-fns`' `formatRelative` did for the `en-US`
 * locale: a calendar phrase for the surrounding two weeks, a short date beyond.
 *
 * | Distance to `baseDate` | Result                  |
 * | ---------------------- | ----------------------- |
 * | Same day               | `today at 9:00 AM`      |
 * | Previous day           | `yesterday at 9:00 AM`  |
 * | Next day               | `tomorrow at 9:00 AM`   |
 * | Previous 2-6 days      | `last Tuesday at 9:00 AM` |
 * | Next 2-6 days          | `Saturday at 9:00 AM`   |
 * | Anything else          | `10/22/2026`            |
 *
 * The output is deliberately fixed to `en-US` because that is what the previous
 * implementation produced: `formatRelative` was called without a `locale`
 * option, so it used date-fns' `enUS` default regardless of the UI language.
 *
 * @throws {RangeError} When `date` is an invalid date.
 */
export const formatRelativeTimestamp = (date: Date, baseDate: Date): string => {
	const dayDelta = differenceInCalendarDays(date, baseDate)

	if (Number.isNaN(dayDelta)) {
		throw new RangeError("Invalid time value")
	}

	const time = timeFormat().format(date)

	if (dayDelta < -6 || dayDelta >= 7) {
		return shortDateFormat().format(date)
	}
	if (dayDelta < -1) {
		return `last ${weekdayFormat().format(date)} at ${time}`
	}
	if (dayDelta < 0) {
		return `yesterday at ${time}`
	}
	if (dayDelta < 1) {
		return `today at ${time}`
	}
	if (dayDelta < 2) {
		return `tomorrow at ${time}`
	}

	return `${weekdayFormat().format(date)} at ${time}`
}

type McpErrorRowProps = {
	error: McpErrorEntry
}

export const McpErrorRow = ({ error }: McpErrorRowProps) => {
	const color = useMemo(() => {
		switch (error.level) {
			case "error":
				return "var(--vscode-testing-iconFailed)"
			case "warn":
				return "var(--vscode-charts-yellow)"
			case "info":
				return "var(--vscode-testing-iconPassed)"
		}
	}, [error.level])

	return (
		<div className="text-sm bg-vscode-textCodeBlock-background border-l-2 p-2" style={{ borderColor: color }}>
			<div className="mb-1" style={{ color }}>
				{error.message}
			</div>
			<div className="text-xs text-vscode-descriptionForeground">
				{formatRelativeTimestamp(new Date(error.timestamp), new Date())}
			</div>
		</div>
	)
}
