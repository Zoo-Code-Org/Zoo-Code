/**
 * Shared number/cost formatting helpers for the dashboard views.
 *
 * These were previously duplicated across DashboardSummary, DashboardView,
 * SessionList, and SessionDetail. Centralizing them here ensures consistent
 * formatting (K/M/B suffixes, currency precision) across all dashboard
 * surfaces and makes future adjustments a single-file change.
 */

/**
 * Format a large number with K/M/B suffixes for display.
 *
 * - 0           -> "0"
 * - 999         -> "999"
 * - 1_500       -> "1.5K"
 * - 1_500_000   -> "1.50M"
 * - 1_500_000_000 -> "1.50B"
 *
 * The exact unrounded value is intended to be surfaced via a tooltip
 * `title` attribute by callers, so this function only returns the
 * compact representation.
 */
export function formatCompact(value: number): string {
	if (value === 0) return "0"
	const abs = Math.abs(value)
	if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
	return value.toLocaleString()
}

/**
 * Format a USD cost value for display.
 *
 * - 0       -> "$0.00"
 * - 0.005   -> "$0.0050"  (sub-cent values keep 4 decimals for visibility)
 * - 1.234   -> "$1.23"
 */
export function formatCost(value: number): string {
	if (value === 0) return "$0.00"
	if (value < 0.01) return `$${value.toFixed(4)}`
	return `$${value.toFixed(2)}`
}
