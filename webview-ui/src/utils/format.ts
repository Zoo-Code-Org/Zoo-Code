import i18next from "i18next"

export type TimeFormat = "auto" | "12h" | "24h"
export type DateFormat = "auto" | "mdy" | "dmy" | "ymd"

export function formatLargeNumber(num: number): string {
	if (num >= 1e9) {
		return (num / 1e9).toFixed(1) + i18next.t("common:number_format.billion_suffix")
	}
	if (num >= 1e6) {
		return (num / 1e6).toFixed(1) + i18next.t("common:number_format.million_suffix")
	}
	if (num >= 1e3) {
		return (num / 1e3).toFixed(1) + i18next.t("common:number_format.thousand_suffix")
	}
	return num.toString()
}

/**
 * Maps the user's time format preference to `Intl` hour-cycle options.
 * "auto" returns `{}` so the locale decides (e.g. 24h for de, 12h for en-US).
 */
export function hourCycleOptions(timeFormat: TimeFormat = "auto"): Intl.DateTimeFormatOptions {
	switch (timeFormat) {
		case "12h":
			return { hour12: true }
		case "24h":
			return { hourCycle: "h23" }
		default:
			return {}
	}
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * Date only, in the chosen order. "auto" follows the display language; the
 * explicit orders use a fixed numeric form (e.g. 10/27/2026, 27/10/2026,
 * 2026-10-27) so the preview and the app agree regardless of locale.
 */
export const formatDateOnly = (
	timestamp: number,
	dateFormat: DateFormat = "auto",
	locale: string = i18next.language || "en",
) => {
	const date = new Date(timestamp)

	switch (dateFormat) {
		case "mdy":
			return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`
		case "dmy":
			return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
		case "ymd":
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
		default:
			return date.toLocaleDateString(locale, { dateStyle: "medium" })
	}
}

/**
 * Clock time only, honouring the 12h/24h choice. `locale` defaults to the active display language;
 * pass one to preview a language that has not been saved yet.
 */
export const formatTimeOnly = (
	timestamp: number,
	timeFormat: TimeFormat = "auto",
	locale: string = i18next.language || "en",
) =>
	new Date(timestamp).toLocaleTimeString(locale, {
		hour: "numeric",
		minute: "2-digit",
		...hourCycleOptions(timeFormat),
	})

/** Full date + time, used for tooltips on relative timestamps and for absolute task times. */
export const formatDateTime = (
	timestamp: number,
	timeFormat: TimeFormat = "auto",
	dateFormat: DateFormat = "auto",
	locale: string = i18next.language || "en",
) => `${formatDateOnly(timestamp, dateFormat, locale)}, ${formatTimeOnly(timestamp, timeFormat, locale)}`

export const formatTimeAgo = (timestamp: number) => {
	const now = Date.now()
	const diff = now - timestamp
	const seconds = Math.floor(diff / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)
	const weeks = Math.floor(days / 7)
	const months = Math.floor(days / 30)
	const years = Math.floor(days / 365)

	if (years > 0) {
		return years === 1
			? i18next.t("common:time_ago.year_ago")
			: i18next.t("common:time_ago.years_ago", { count: years })
	}
	if (months > 0) {
		return months === 1
			? i18next.t("common:time_ago.month_ago")
			: i18next.t("common:time_ago.months_ago", { count: months })
	}
	if (weeks > 0) {
		return weeks === 1
			? i18next.t("common:time_ago.week_ago")
			: i18next.t("common:time_ago.weeks_ago", { count: weeks })
	}
	if (days > 0) {
		return days === 1
			? i18next.t("common:time_ago.day_ago")
			: i18next.t("common:time_ago.days_ago", { count: days })
	}
	if (hours > 0) {
		return hours === 1
			? i18next.t("common:time_ago.hour_ago")
			: i18next.t("common:time_ago.hours_ago", { count: hours })
	}
	if (minutes > 0) {
		return minutes === 1
			? i18next.t("common:time_ago.minute_ago")
			: i18next.t("common:time_ago.minutes_ago", { count: minutes })
	}
	if (seconds > 30) {
		return i18next.t("common:time_ago.seconds_ago", { count: seconds })
	}

	return i18next.t("common:time_ago.just_now")
}

const DAY_MS = 24 * 60 * 60 * 1000

const startOfDay = (ts: number) => {
	const d = new Date(ts)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/**
 * Compact timestamp for a chat message, in the user's time/date formats:
 *
 *   same day            "Today 2:41 PM"
 *   previous day        "Yesterday 11:43 AM"
 *   within the last week "Mon 11:43 AM"
 *   same year            "Oct 7, 11:43 AM"       (order follows dateFormat when set)
 *   other year           "Oct 7, 2025, 11:43 AM"
 *
 * "Today"/"Yesterday" come from `Intl.RelativeTimeFormat`, so they are
 * localised with no extra translation keys. Day boundaries are local midnight,
 * not 24h windows, so 00:05 vs 23:55 the day before reads correctly.
 */
export const formatMessageTime = (
	timestamp: number,
	{
		now = Date.now(),
		timeFormat = "auto",
		dateFormat = "auto",
	}: { now?: number; timeFormat?: TimeFormat; dateFormat?: DateFormat } = {},
): string => {
	const locale = i18next.language || "en"
	const time = formatTimeOnly(timestamp, timeFormat)
	const daysAgo = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS)

	if (daysAgo === 0 || daysAgo === 1) {
		const label = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-daysAgo, "day")
		// Sentence case: "today" -> "Today" (a no-op for scripts without case).
		return `${label.charAt(0).toLocaleUpperCase(locale)}${label.slice(1)} ${time}`
	}

	if (daysAgo > 1 && daysAgo < 7) {
		return `${new Date(timestamp).toLocaleDateString(locale, { weekday: "short" })} ${time}`
	}

	const sameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear()

	if (dateFormat !== "auto") {
		// Explicit numeric orders are always written in full so they stay unambiguous.
		return `${formatDateOnly(timestamp, dateFormat)}, ${time}`
	}

	const date = new Date(timestamp).toLocaleDateString(
		locale,
		sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
	)
	return `${date}, ${time}`
}
