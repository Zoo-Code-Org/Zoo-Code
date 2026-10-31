/**
 * Small, pure helpers shared by the quota services (`copilotQuota`,
 * `providerQuotas`). Kept in one place so payload parsing behaves identically
 * everywhere and is tested once.
 */

export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

/**
 * Epoch milliseconds from a provider timestamp. Numbers below 1e12 are treated
 * as epoch seconds; strings are parsed as dates. Anything else is undefined.
 */
export const toEpochMs = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value < 1_000_000_000_000 ? value * 1000 : value
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Date.parse(value)
		return Number.isNaN(parsed) ? undefined : parsed
	}
	return undefined
}

/** `$12.40`, `-$0.50`, `¥8.00`. */
export const formatMoney = (value: number, symbol = "$"): string =>
	`${value < 0 ? "-" : ""}${symbol}${Math.abs(value).toFixed(2)}`

/** `140,000` / `39,389.3`: whole numbers stay whole, fractions keep one decimal. */
export const formatCredits = (value: number): string =>
	value.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 })

/** One decimal, matching GitHub's own panel. */
export const roundToTenth = (value: number): number => Math.round(value * 10) / 10

/**
 * Turns an unknown failure into a short, safe string for the UI. Only the
 * well-understood cases keep their text; anything else (network stack errors
 * can embed URLs or headers) collapses to a generic message so credentials
 * can never ride an error back to the webview.
 */
export class QuotaHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`)
		this.name = "QuotaHttpError"
	}
}

export function safeErrorMessage(error: unknown): string {
	if (error instanceof QuotaHttpError) return error.message
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return "Request timed out"
	}
	return "Request failed"
}
