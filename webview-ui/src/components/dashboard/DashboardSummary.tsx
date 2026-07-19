import React, { memo } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import type { StatsBucket } from "@roo-code/types"

import { StandardTooltip } from "@/components/ui"

// ── Number formatting ───────────────────────────────────────────────────────

/**
 * Format a large number with K/M/B suffixes for display.
 * The exact value is available via tooltip title attribute.
 */
function formatCompact(value: number): string {
	if (value === 0) return "0"
	const abs = Math.abs(value)
	if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
	if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
	return value.toLocaleString()
}

function formatCost(value: number): string {
	if (value === 0) return "$0.00"
	if (value < 0.01) return `$${value.toFixed(4)}`
	return `$${value.toFixed(2)}`
}

// ── SummaryCard ─────────────────────────────────────────────────────────────

interface SummaryCardProps {
	label: string
	value: string
	exactValue: string
	unknownCount?: number
}

const SummaryCard = memo(({ label, value, exactValue, unknownCount }: SummaryCardProps) => (
	<div className="flex flex-col gap-1 rounded-md border border-vscode-panel-border bg-vscode-editor-background p-3">
		<span className="text-xs text-vscode-descriptionForeground">{label}</span>
		<StandardTooltip content={exactValue}>
			<span className="text-lg font-semibold text-vscode-foreground" tabIndex={0}>
				{value}
			</span>
		</StandardTooltip>
		{unknownCount !== undefined && unknownCount > 0 && (
			<span className="text-xs text-vscode-descriptionForeground">
				({unknownCount} unknown)
			</span>
		)}
	</div>
))

// ── DashboardSummary ────────────────────────────────────────────────────────

interface DashboardSummaryProps {
	totals: StatsBucket
}

const DashboardSummary = memo(({ totals }: DashboardSummaryProps) => {
	const { t } = useAppTranslation()

	const cacheTotal = totals.cacheReadTokens + totals.cacheWriteTokens

	return (
		<div
			className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
			data-testid="dashboard-summary">
			<SummaryCard
				label={t("dashboard:summary.totalTokens")}
				value={formatCompact(totals.totalTokens)}
				exactValue={totals.totalTokens.toLocaleString()}
				unknownCount={totals.unknownEventCount}
			/>
			<SummaryCard
				label={t("dashboard:summary.inputTokens")}
				value={formatCompact(totals.inputTokens)}
				exactValue={totals.inputTokens.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.outputTokens")}
				value={formatCompact(totals.outputTokens)}
				exactValue={totals.outputTokens.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.cacheTokens")}
				value={formatCompact(cacheTotal)}
				exactValue={cacheTotal.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.cost")}
				value={formatCost(totals.costUsd)}
				exactValue={`$${totals.costUsd.toFixed(6)}`}
			/>
		</div>
	)
})

export default DashboardSummary
