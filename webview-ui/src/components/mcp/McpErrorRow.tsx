import { useMemo } from "react"

import type { McpErrorEntry } from "@roo-code/types"

// `Intl.DateTimeFormat` instances are immutable and locale-fixed, so build them
// once per module instead of per render.
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "long" })
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
})

const MILLISECONDS_IN_DAY = 86_400_000

/**
 * Whole calendar days from `baseDate` to `date`, in local time.
 *
 * Calendar days, not elapsed milliseconds: 23:59 and 00:01 on consecutive days
 * are one day apart even though only two minutes elapsed. Local midnights are
 * compared directly, so DST shifts (23h or 25h days) still round to one day.
 */
const differenceInCalendarDays = (date: Date, baseDate: Date): number => {
	const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate())
	const baseMidnight = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())

	return Math.round((dateMidnight.getTime() - baseMidnight.getTime()) / MILLISECONDS_IN_DAY)
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

	const time = TIME_FORMAT.format(date)

	if (dayDelta < -6 || dayDelta >= 7) {
		return SHORT_DATE_FORMAT.format(date)
	}
	if (dayDelta < -1) {
		return `last ${WEEKDAY_FORMAT.format(date)} at ${time}`
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

	return `${WEEKDAY_FORMAT.format(date)} at ${time}`
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
