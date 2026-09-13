import React, { memo } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import type { StatsBucket } from "@roo-code/types"

import { StandardTooltip } from "@/components/ui"
import { formatCompact, formatCost } from "@/utils/formatNumber"

import AnimatedNumber from "./AnimatedNumber"

// ── SummaryCard ─────────────────────────────────────────────────────────────

interface SummaryCardProps {
	label: string
	/** Target numeric value to animate towards. */
	value: number
	/** Formatter for the animated display value. */
	format: (value: number) => string
	/** Exact (unrounded) value for the tooltip. */
	exactValue: string
}

const SummaryCard = memo(({ label, value, format, exactValue }: SummaryCardProps) => {
	return (
		<div className="flex flex-col gap-1 rounded-md border border-vscode-panel-border bg-vscode-editor-background p-3">
			<span className="text-xs text-vscode-descriptionForeground">{label}</span>
			<StandardTooltip content={exactValue}>
				<AnimatedNumber
					value={value}
					format={format}
					className="text-lg font-semibold text-vscode-foreground block"
				/>
			</StandardTooltip>
		</div>
	)
})

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
				value={totals.totalTokens}
				format={formatCompact}
				exactValue={totals.totalTokens.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.inputTokens")}
				value={totals.inputTokens}
				format={formatCompact}
				exactValue={totals.inputTokens.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.outputTokens")}
				value={totals.outputTokens}
				format={formatCompact}
				exactValue={totals.outputTokens.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.cacheTokens")}
				value={cacheTotal}
				format={formatCompact}
				exactValue={cacheTotal.toLocaleString()}
			/>
			<SummaryCard
				label={t("dashboard:summary.cost")}
				value={totals.costUsd}
				format={formatCost}
				exactValue={`$${totals.costUsd.toFixed(6)}`}
			/>
		</div>
	)
})

export default DashboardSummary
