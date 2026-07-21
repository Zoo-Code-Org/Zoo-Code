import React, { memo } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import type { StatsBucket } from "@roo-code/types"

import { StandardTooltip } from "@/components/ui"
import { formatCompact, formatCost } from "@/utils/formatNumber"

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
			<span className="text-xs text-vscode-descriptionForeground">({unknownCount} uncertain)</span>
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
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" data-testid="dashboard-summary">
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
