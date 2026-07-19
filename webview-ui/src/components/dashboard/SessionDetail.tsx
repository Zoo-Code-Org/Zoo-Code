import React, { memo, useMemo } from "react"

import type { SessionDetail as SessionDetailType, APICallRecord } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { formatCompact, formatCost } from "@/utils/formatNumber"

// ── Time formatting ──────────────────────────────────────────────────────────

/**
 * Formats an epoch millisecond timestamp as HH:MM (24-hour, local time).
 * Example: 1721404320000 -> "14:32"
 *
 * Uses the user's local timezone so the displayed time matches what they
 * would see in their task history.
 */
function formatTime(timestamp: number): string {
	if (!timestamp) return "--:--"
	try {
		const date = new Date(timestamp)
		const hours = String(date.getHours()).padStart(2, "0")
		const minutes = String(date.getMinutes()).padStart(2, "0")
		return `${hours}:${minutes}`
	} catch {
		return "--:--"
	}
}

// ── Status icon ──────────────────────────────────────────────────────────────

/**
 * Renders a status icon for an API call.
 * - completed: ✅
 * - failed: ❌
 * - cancelled: 🔄
 *
 * The icon is paired with an `aria-label` and a `title` so screen readers and
 * tooltips convey the status without relying on the emoji alone.
 */
function StatusIcon({ status }: { status: APICallRecord["status"] }) {
	const { t } = useAppTranslation()
	const icon = status === "completed" ? "✅" : status === "failed" ? "❌" : "🔄"
	const label = t(`dashboard:sessionDetail.status`)
	return (
		<span role="img" aria-label={`${label}: ${status}`} title={`${label}: ${status}`} className="text-xs">
			{icon}
		</span>
	)
}

// ── API call list ────────────────────────────────────────────────────────────

interface APICallListProps {
	apiCalls: APICallRecord[]
}

/**
 * Renders the per-API-call table for an expanded session.
 *
 * Columns: # (index), Time, Input Tokens, Output Tokens, Cost, Status, Model.
 * The table is wrapped in an `overflow-x-auto` container so it remains usable
 * on narrow viewports without breaking the dashboard layout.
 */
const APICallList = memo(({ apiCalls }: APICallListProps) => {
	const { t } = useAppTranslation()

	if (apiCalls.length === 0) {
		return (
			<div
				className="flex items-center justify-center py-3 text-xs text-vscode-descriptionForeground"
				data-testid="dashboard-session-detail-no-calls">
				{t("dashboard:sessionDetail.noApiCalls")}
			</div>
		)
	}

	return (
		<div
			className="overflow-x-auto rounded-md border border-vscode-panel-border"
			data-testid="dashboard-session-detail-calls">
			<table className="w-full text-xs">
				<thead className="bg-vscode-editor-inactiveSelectionBackground">
					<tr>
						<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
							#
						</th>
						<th className="px-2 py-1.5 text-left font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.time")}
						</th>
						<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.input")}
						</th>
						<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.output")}
						</th>
						<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.cost")}
						</th>
						<th className="px-2 py-1.5 text-center font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.status")}
						</th>
						<th className="px-2 py-1.5 text-left font-medium text-vscode-foreground whitespace-nowrap">
							{t("dashboard:sessionDetail.model")}
						</th>
					</tr>
				</thead>
				<tbody>
					{apiCalls.map((call) => (
						<tr
							key={call.index}
							className="border-t border-vscode-panel-border"
							data-testid={`dashboard-session-detail-call-${call.index}`}>
							<td className="px-2 py-1.5 text-right text-vscode-descriptionForeground tabular-nums">
								{call.index}
							</td>
							<td className="px-2 py-1.5 text-left text-vscode-foreground tabular-nums whitespace-nowrap">
								{formatTime(call.timestamp)}
							</td>
							<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
								{formatCompact(call.inputTokens)}
							</td>
							<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
								{formatCompact(call.outputTokens)}
							</td>
							<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
								{formatCost(call.costUsd)}
							</td>
							<td className="px-2 py-1.5 text-center">
								<StatusIcon status={call.status} />
							</td>
							<td className="px-2 py-1.5 text-left text-vscode-foreground whitespace-nowrap">
								{call.model}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
})

APICallList.displayName = "APICallList"

// ── SessionDetail ────────────────────────────────────────────────────────────

interface SessionDetailProps {
	/** The full session detail including per-API-call records. */
	detail: SessionDetailType
}

/**
 * Renders the expanded session detail: a summary header (totals, model,
 * mode, call count) followed by the per-API-call table.
 *
 * The summary header reuses the same fields as {@link SessionSummary} so the
 * expanded view is consistent with the collapsed row. The API call list is
 * rendered by {@link APICallList}.
 */
const SessionDetail = memo(({ detail }: SessionDetailProps) => {
	const { t } = useAppTranslation()

	// Derive summary fields for the header. SessionSummary only carries a
	// combined `totalTokens`, so input/output totals are aggregated from the
	// per-call records to give the user a meaningful split at a glance.
	const { totalInputTokens, totalOutputTokens } = useMemo(() => {
		let input = 0
		let output = 0
		for (const call of detail.apiCalls) {
			input += call.inputTokens
			output += call.outputTokens
		}
		return { totalInputTokens: input, totalOutputTokens: output }
	}, [detail.apiCalls])

	const summaryItems = useMemo(
		() => [
			{ label: t("dashboard:sessionDetail.input"), value: formatCompact(totalInputTokens) },
			{ label: t("dashboard:sessionDetail.output"), value: formatCompact(totalOutputTokens) },
			{ label: t("dashboard:sessionDetail.cost"), value: formatCost(detail.totalCost) },
			{ label: t("dashboard:sessionDetail.model"), value: detail.model || "—" },
			{ label: t("dashboard:sessionDetail.mode"), value: detail.mode || "—" },
		],
		[detail, t, totalInputTokens, totalOutputTokens],
	)

	return (
		<div
			className="flex flex-col gap-2 border-t border-vscode-panel-border bg-vscode-editor-background px-2 py-2"
			data-testid="dashboard-session-detail">
			{/* Summary header */}
			<div className="flex flex-col gap-1">
				<span className="text-[10px] font-medium uppercase tracking-wide text-vscode-descriptionForeground">
					{t("dashboard:sessionDetail.summary")}
				</span>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					{summaryItems.map((item, i) => (
						<span
							key={i}
							className="flex items-center gap-1 whitespace-nowrap"
							data-testid={`dashboard-session-detail-summary-${i}`}>
							<span className="text-vscode-descriptionForeground">{item.label}:</span>
							<span className="font-medium text-vscode-foreground tabular-nums">{item.value}</span>
						</span>
					))}
				</div>
			</div>

			{/* API calls section */}
			<div className="flex flex-col gap-1">
				<span className="text-[10px] font-medium uppercase tracking-wide text-vscode-descriptionForeground">
					{t("dashboard:sessionDetail.apiCalls")}
				</span>
				<APICallList apiCalls={detail.apiCalls} />
			</div>
		</div>
	)
})

SessionDetail.displayName = "SessionDetail"

export default SessionDetail
