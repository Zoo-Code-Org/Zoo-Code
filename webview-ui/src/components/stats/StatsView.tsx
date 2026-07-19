import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Download, Trash2, RefreshCw } from "lucide-react"

import type { ExtensionMessage, StatsQuery, StatsSnapshot } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { Button, StandardTooltip } from "@/components/ui"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
	AlertDialogAction,
} from "@/components/ui/alert-dialog"

import { Tab, TabHeader, TabContent } from "../common/Tab"
import StatsSummary from "./StatsSummary"
import UsageHeatmap from "./UsageHeatmap"

// ── Types ───────────────────────────────────────────────────────────────────

type StatsPreset = "today" | "7d" | "30d" | "all"
type GroupByOption = "model" | "provider" | "mode" | "status"

interface StatsViewProps {
	onDone: () => void
}

// ── Number formatting ───────────────────────────────────────────────────────

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

// ── StatsView ───────────────────────────────────────────────────────────────

const StatsView = memo(({ onDone }: StatsViewProps) => {
	const { t } = useAppTranslation()

	const [preset, setPreset] = useState<StatsPreset>("today")
	const [groupBy, setGroupBy] = useState<GroupByOption>("model")
	const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showClearDialog, setShowClearDialog] = useState(false)
	const [clearNonce, setClearNonce] = useState<string | null>(null)

	// Track the latest request to ignore stale responses
	const latestRequestIdRef = useRef<string>("")

	// ── Query construction ──────────────────────────────────────────────────

	const timezone = useMemo(() => {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		} catch {
			return "UTC"
		}
	}, [])

	const buildQuery = useCallback(
		(currentPreset: StatsPreset, currentGroupBy: GroupByOption): StatsQuery => {
			const now = new Date()
			let from: string | undefined
			let to: string | undefined

			if (currentPreset === "today") {
				const startOfDay = new Date(now)
				startOfDay.setHours(0, 0, 0, 0)
				from = startOfDay.toISOString()
			} else if (currentPreset === "7d") {
				const start = new Date(now)
				start.setDate(start.getDate() - 7)
				from = start.toISOString()
			} else if (currentPreset === "30d") {
				const start = new Date(now)
				start.setDate(start.getDate() - 30)
				from = start.toISOString()
			}
			// "all" → no from/to

			return {
				preset: currentPreset,
				from,
				to,
				timezone,
				groupBy: [currentGroupBy],
				includeCancelled: false,
			}
		},
		[timezone],
	)

	// ── Fetch statistics ─────────────────────────────────────────────────────

	const fetchStats = useCallback(
		(currentPreset: StatsPreset, currentGroupBy: GroupByOption) => {
			const requestId = `stats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			latestRequestIdRef.current = requestId
			setLoading(true)
			setError(null)

			const query = buildQuery(currentPreset, currentGroupBy)
			vscode.postMessage({
				type: "getUsageStats",
				requestId,
				usageStatsQuery: query,
			})
		},
		[buildQuery],
	)

	// Initial fetch on mount
	useEffect(() => {
		fetchStats(preset, groupBy)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Refetch when preset or groupBy changes
	const handlePresetChange = useCallback(
		(newPreset: StatsPreset) => {
			setPreset(newPreset)
			fetchStats(newPreset, groupBy)
		},
		[groupBy, fetchStats],
	)

	const handleGroupByChange = useCallback(
		(newGroupBy: GroupByOption) => {
			setGroupBy(newGroupBy)
			fetchStats(preset, newGroupBy)
		},
		[preset, fetchStats],
	)

	const handleRefresh = useCallback(() => {
		fetchStats(preset, groupBy)
	}, [preset, groupBy, fetchStats])

	// ── Listen for responses ────────────────────────────────────────────────

	useEffect(() => {
		const handleMessage = (e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "getUsageStatsResponse") {
				// Only accept the latest request's response
				if (message.requestId !== latestRequestIdRef.current) return

				if (message.usageStatsSnapshot) {
					setSnapshot(message.usageStatsSnapshot)
					setLoading(false)
					setError(null)
				} else {
					setError(t("stats:states.error"))
					setLoading(false)
				}
			}

			if (message.type === "usageStatsChanged") {
				// Data changed externally — refetch with debounce
				const timer = setTimeout(() => fetchStats(preset, groupBy), 300)
				return () => clearTimeout(timer)
			}

			if (message.type === "requestClearNonceResponse") {
				// B2 fix: host issues the nonce; store it and open the confirm dialog.
				// If the host returned null/error, surface it without opening the dialog.
				if (message.clearNonce) {
					setClearNonce(message.clearNonce)
					setShowClearDialog(true)
				} else {
					setError(message.error || t("stats:states.error"))
					setShowClearDialog(false)
					setClearNonce(null)
				}
			}

			if (message.type === "clearUsageStatsResponse") {
				if (message.clearUsageStatsResult?.success) {
					setShowClearDialog(false)
					setClearNonce(null)
					fetchStats(preset, groupBy)
				} else {
					setError(message.clearUsageStatsResult?.error || t("stats:states.error"))
					setShowClearDialog(false)
					setClearNonce(null)
				}
			}

			if (message.type === "exportUsageStatsResponse") {
				// Host handles the save dialog; nothing to do in webview
				// unless there's an error
				if (message.exportUsageStatsResult?.error) {
					setError(message.exportUsageStatsResult.error)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [t, preset, groupBy, fetchStats])

	// ── Export ───────────────────────────────────────────────────────────────

	const handleExport = useCallback(
		(format: "json" | "csv") => {
			const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			const query = buildQuery(preset, groupBy)
			vscode.postMessage({
				type: "exportUsageStats",
				requestId,
				usageStatsQuery: query,
				exportUsageStatsFormat: format,
			})
		},
		[preset, groupBy, buildQuery],
	)

	// ── Clear ────────────────────────────────────────────────────────────────

	const handleClearRequest = useCallback(() => {
		// B2 fix: ask the host to issue a clear nonce. The host-generated nonce
		// is returned via `requestClearNonceResponse` and stored in `clearNonce`.
		// Previously the webview generated its own nonce, which the host never
		// stored, so `clearStats` always failed with "nonce mismatch".
		const requestId = `clear-nonce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		vscode.postMessage({
			type: "requestClearNonce",
			requestId,
		})
	}, [])

	const handleClearConfirm = useCallback(() => {
		if (!clearNonce) return
		vscode.postMessage({
			type: "clearUsageStats",
			requestId: clearNonce,
			clearUsageStatsNonce: clearNonce,
		})
	}, [clearNonce])

	// ── Derived data ─────────────────────────────────────────────────────────

	const buckets = useMemo(() => snapshot?.buckets ?? [], [snapshot])
	const totals = useMemo(
		() =>
			snapshot?.totals ?? {
				key: {},
				events: 0,
				completedCalls: 0,
				failedCalls: 0,
				cancelledCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				unknownEventCount: 0,
			},
		[snapshot],
	)

	const hasData = totals.events > 0

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<Tab data-testid="stats-view">
			<TabHeader className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							className="px-1.5 -ml-2"
							onClick={onDone}
							aria-label={t("stats:done")}
							data-testid="stats-done-button">
							<ArrowLeft />
							<span className="sr-only">{t("stats:done")}</span>
						</Button>
						<h3 className="text-vscode-foreground m-0">{t("stats:title")}</h3>
					</div>
					<div className="flex items-center gap-1">
						<StandardTooltip content={t("stats:actions.refresh")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleRefresh}
								data-testid="stats-refresh-button"
								aria-label={t("stats:actions.refresh")}>
								<RefreshCw className={loading ? "animate-spin" : ""} />
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("stats:actions.exportJson")}>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => handleExport("json")}
								data-testid="stats-export-json"
								disabled={!hasData}>
								<Download className="size-3.5" />
								<span className="hidden sm:inline">{t("stats:actions.exportJson")}</span>
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("stats:actions.exportCsv")}>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => handleExport("csv")}
								data-testid="stats-export-csv"
								disabled={!hasData}>
								<Download className="size-3.5" />
								<span className="hidden sm:inline">{t("stats:actions.exportCsv")}</span>
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("stats:actions.clear")}>
							<Button
								variant="destructive"
								size="sm"
								onClick={handleClearRequest}
								data-testid="stats-clear-button"
								disabled={!hasData}>
								<Trash2 className="size-3.5" />
								<span className="hidden sm:inline">{t("stats:actions.clear")}</span>
							</Button>
						</StandardTooltip>
					</div>
				</div>

				{/* Range selector */}
				<div className="flex flex-wrap items-center gap-1">
					{(["today", "7d", "30d", "all"] as StatsPreset[]).map((p) => (
						<Button
							key={p}
							variant={preset === p ? "primary" : "secondary"}
							size="sm"
							onClick={() => handlePresetChange(p)}
							data-testid={`stats-range-${p}`}>
							{t(`stats:range.${p}`)}
						</Button>
					))}
				</div>
			</TabHeader>

			<TabContent className="flex flex-col gap-4">
				{/* Loading state */}
				{loading && (
					<div className="flex items-center justify-center py-8" data-testid="stats-loading">
						<RefreshCw className="size-5 animate-spin text-vscode-descriptionForeground" />
						<span className="ml-2 text-sm text-vscode-descriptionForeground">
							{t("stats:states.loading")}
						</span>
					</div>
				)}

				{/* Error state */}
				{!loading && error && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="stats-error">
						<span className="text-sm text-vscode-errorForeground">{error}</span>
						<Button variant="secondary" size="sm" onClick={handleRefresh}>
							{t("stats:actions.refresh")}
						</Button>
					</div>
				)}

				{/* Empty state */}
				{!loading && !error && !hasData && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="stats-empty">
						<span className="text-sm text-vscode-descriptionForeground">{t("stats:states.empty")}</span>
						<span className="text-xs text-vscode-descriptionForeground">{t("stats:states.emptyHint")}</span>
					</div>
				)}

				{/* Data display */}
				{!loading && !error && hasData && (
					<>
						{/* Summary cards */}
						<StatsSummary totals={totals} />

						{/* Heatmap */}
						<UsageHeatmap buckets={buckets} />

						{/* Breakdown table */}
						<div className="flex flex-col gap-2" data-testid="stats-breakdown">
							<div className="flex items-center justify-between">
								<h4 className="text-sm font-medium text-vscode-foreground m-0">
									{t("stats:breakdown.title")}
								</h4>
								<div className="flex gap-1">
									{(["model", "provider", "mode", "status"] as GroupByOption[]).map((g) => (
										<Button
											key={g}
											variant={groupBy === g ? "primary" : "ghost"}
											size="sm"
											onClick={() => handleGroupByChange(g)}
											data-testid={`stats-groupby-${g}`}>
											{t(`stats:breakdown.${g}`)}
										</Button>
									))}
								</div>
							</div>

							{/* Responsive table wrapper */}
							<div className="overflow-x-auto rounded-md border border-vscode-panel-border">
								<table className="w-full text-xs">
									<thead className="bg-vscode-editor-inactiveSelectionBackground">
										<tr>
											<th className="px-2 py-1.5 text-left font-medium text-vscode-foreground whitespace-nowrap">
												{t(`stats:breakdown.${groupBy}`)}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.events")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.inputTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.outputTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.cacheReadTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.cacheWriteTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.reasoningTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.totalTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("stats:breakdown.costUsd")}
											</th>
										</tr>
									</thead>
									<tbody>
										{buckets.map((bucket, index) => {
											const keyValue =
												bucket.key?.[groupBy] ?? bucket.key?.day ?? t("stats:breakdown.unknown")
											return (
												<tr
													key={`${groupBy}-${index}`}
													className="border-t border-vscode-panel-border">
													<td className="px-2 py-1.5 text-vscode-foreground whitespace-nowrap">
														{String(keyValue)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{bucket.events}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCompact(bucket.inputTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCompact(bucket.outputTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCompact(bucket.cacheReadTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCompact(bucket.cacheWriteTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCompact(bucket.reasoningTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums font-medium">
														{formatCompact(bucket.totalTokens)}
													</td>
													<td className="px-2 py-1.5 text-right text-vscode-foreground tabular-nums">
														{formatCost(bucket.costUsd)}
													</td>
												</tr>
											)
										})}
									</tbody>
								</table>
							</div>
						</div>

						{/* Data coverage */}
						{snapshot?.coverage && (
							<div
								className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-3 text-xs text-vscode-descriptionForeground"
								data-testid="stats-coverage">
								<span className="font-medium text-vscode-foreground">{t("stats:coverage.title")}</span>
								{snapshot.coverage.firstEventAt && (
									<span>
										{t("stats:coverage.liveFrom")}:{" "}
										{new Date(snapshot.coverage.firstEventAt).toLocaleString()}
									</span>
								)}
								{snapshot.coverage.backfilledEventCount > 0 && (
									<span>
										{t("stats:coverage.backfilledEvents")}: {snapshot.coverage.backfilledEventCount}
									</span>
								)}
								{snapshot.coverage.recordingPaused && (
									<span className="text-vscode-errorForeground">{t("stats:coverage.paused")}</span>
								)}
							</div>
						)}
					</>
				)}
			</TabContent>

			{/* Clear confirmation dialog */}
			<AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
				<AlertDialogContent data-testid="stats-clear-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("stats:clearDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("stats:clearDialog.description")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel data-testid="stats-clear-cancel">
							{t("stats:clearDialog.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleClearConfirm}
							data-testid="stats-clear-confirm"
							className="bg-vscode-errorForeground text-white hover:bg-vscode-errorForeground/90">
							{t("stats:clearDialog.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default StatsView
