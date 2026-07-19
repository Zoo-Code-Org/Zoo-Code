import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Download, Trash2, RefreshCw } from "lucide-react"

import type { ExtensionMessage, StatsQuery, StatsSnapshot, SessionSummary } from "@roo-code/types"

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
import DashboardSummary from "./DashboardSummary"
import SessionList from "./SessionList"
import UsageHeatmap from "../stats/UsageHeatmap"

// ── Types ───────────────────────────────────────────────────────────────────

// Dashboard range presets. "custom" is a local-only UI state: when selected,
// the query is sent with explicit from/to ISO strings and no `preset` field
// (the backend StatsQuery schema only allows today/7d/30d/all for `preset`).
type DashboardPreset = "today" | "7d" | "30d" | "custom" | "all"
type DashboardGroupBy = "model" | "provider" | "mode"

interface DashboardViewProps {
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

// ── DashboardView ───────────────────────────────────────────────────────────

const DashboardView = memo(({ onDone }: DashboardViewProps) => {
	const { t } = useAppTranslation()

	const [preset, setPreset] = useState<DashboardPreset>("today")
	const [groupBy, setGroupBy] = useState<DashboardGroupBy>("model")
	const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showClearDialog, setShowClearDialog] = useState(false)
	const [clearNonce, setClearNonce] = useState<string | null>(null)

	// Custom range date inputs (YYYY-MM-DD). Only used when preset === "custom".
	const [customFrom, setCustomFrom] = useState<string>("")
	const [customTo, setCustomTo] = useState<string>("")

	// Track the latest request to ignore stale responses
	const latestRequestIdRef = useRef<string>("")

	// ── Sessions state (Commit 3) ──────────────────────────────────────────
	// Sessions are fetched independently from the stats snapshot so that the
	// session list can update without re-fetching the full aggregation. The
	// session request reuses the same `buildQuery()` time range so the two
	// views stay consistent.
	const [sessions, setSessions] = useState<SessionSummary[]>([])
	const [sessionsLoading, setSessionsLoading] = useState(false)
	const [sessionsError, setSessionsError] = useState<string | null>(null)
	const [modelFilter, setModelFilter] = useState<string | undefined>(undefined)
	const [providerFilter, setProviderFilter] = useState<string | undefined>(undefined)
	const latestSessionsRequestIdRef = useRef<string>("")

	// ── Query construction ──────────────────────────────────────────────────

	const timezone = useMemo(() => {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		} catch {
			return "UTC"
		}
	}, [])

	const buildQuery = useCallback(
		(
			currentPreset: DashboardPreset,
			currentGroupBy: DashboardGroupBy,
			fromOverride?: string,
			toOverride?: string,
		): StatsQuery => {
			const now = new Date()
			let from: string | undefined
			let to: string | undefined
			// The backend preset enum is ["today", "7d", "30d", "all"].
			// For "custom" we omit preset and send explicit from/to ISO strings.
			let queryPreset: StatsQuery["preset"]

			if (currentPreset === "today") {
				const startOfDay = new Date(now)
				startOfDay.setHours(0, 0, 0, 0)
				from = startOfDay.toISOString()
				queryPreset = "today"
			} else if (currentPreset === "7d") {
				const start = new Date(now)
				start.setDate(start.getDate() - 7)
				from = start.toISOString()
				queryPreset = "7d"
			} else if (currentPreset === "30d") {
				const start = new Date(now)
				start.setDate(start.getDate() - 30)
				from = start.toISOString()
				queryPreset = "30d"
			} else if (currentPreset === "custom") {
				// Convert YYYY-MM-DD inputs to ISO start-of-day / end-of-day.
				// fromOverride/toOverride let a fresh input value be used
				// immediately without waiting for state to flush.
				const fromStr = fromOverride ?? customFrom
				const toStr = toOverride ?? customTo
				if (fromStr) {
					from = new Date(`${fromStr}T00:00:00`).toISOString()
				}
				if (toStr) {
					to = new Date(`${toStr}T23:59:59.999`).toISOString()
				}
				// No preset for custom range
			}
			// "all" → no from/to, preset "all"
			else if (currentPreset === "all") {
				queryPreset = "all"
			}

			return {
				preset: queryPreset,
				from,
				to,
				timezone,
				groupBy: [currentGroupBy],
				includeCancelled: false,
			}
		},
		[timezone, customFrom, customTo],
	)

	// ── Fetch statistics ─────────────────────────────────────────────────────

	const fetchStats = useCallback(
		(
			currentPreset: DashboardPreset,
			currentGroupBy: DashboardGroupBy,
			fromOverride?: string,
			toOverride?: string,
		) => {
			const requestId = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			latestRequestIdRef.current = requestId
			setLoading(true)
			setError(null)

			const query = buildQuery(currentPreset, currentGroupBy, fromOverride, toOverride)
			vscode.postMessage({
				type: "getUsageStats",
				requestId,
				usageStatsQuery: query,
			})
		},
		[buildQuery],
	)

	// ── Fetch sessions (Commit 3) ──────────────────────────────────────────
	// Sends `getDashboardSessions` with the same time-range query as the
	// stats fetch, plus optional model/provider filters. The response is
	// correlated via `latestSessionsRequestIdRef` to ignore stale results.
	const fetchSessions = useCallback(
		(
			currentPreset: DashboardPreset,
			currentGroupBy: DashboardGroupBy,
			fromOverride?: string,
			toOverride?: string,
			modelFilterOverride?: string | undefined,
			providerFilterOverride?: string | undefined,
		) => {
			const requestId = `dashboard-sessions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			latestSessionsRequestIdRef.current = requestId
			setSessionsLoading(true)
			setSessionsError(null)

			const query = buildQuery(currentPreset, currentGroupBy, fromOverride, toOverride)
			vscode.postMessage({
				type: "getDashboardSessions",
				requestId,
				usageStatsQuery: query,
				dashboardSessionFilters: {
					model: modelFilterOverride,
					provider: providerFilterOverride,
				},
			})
		},
		[buildQuery],
	)

	// Initial fetch on mount
	useEffect(() => {
		fetchStats(preset, groupBy)
		fetchSessions(preset, groupBy)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Refetch when preset or groupBy changes
	const handlePresetChange = useCallback(
		(newPreset: DashboardPreset) => {
			setPreset(newPreset)
			// For custom, only fetch if both dates are present
			if (newPreset === "custom" && (!customFrom || !customTo)) {
				return
			}
			fetchStats(newPreset, groupBy)
			fetchSessions(newPreset, groupBy, undefined, undefined, modelFilter, providerFilter)
		},
		[groupBy, fetchStats, fetchSessions, customFrom, customTo, modelFilter, providerFilter],
	)

	const handleGroupByChange = useCallback(
		(newGroupBy: DashboardGroupBy) => {
			setGroupBy(newGroupBy)
			fetchStats(preset, newGroupBy)
			fetchSessions(preset, newGroupBy, undefined, undefined, modelFilter, providerFilter)
		},
		[preset, fetchStats, fetchSessions, modelFilter, providerFilter],
	)

	const handleRefresh = useCallback(() => {
		fetchStats(preset, groupBy)
		fetchSessions(preset, groupBy, undefined, undefined, modelFilter, providerFilter)
	}, [preset, groupBy, fetchStats, fetchSessions, modelFilter, providerFilter])

	// Apply a custom date range: triggered when both inputs are filled and
	// the user wants to run the query (e.g. on "To" date change, or explicitly).
	const handleApplyCustomRange = useCallback(() => {
		if (!customFrom || !customTo) return
		fetchStats("custom", groupBy, customFrom, customTo)
		fetchSessions("custom", groupBy, customFrom, customTo, modelFilter, providerFilter)
	}, [customFrom, customTo, groupBy, fetchStats, fetchSessions, modelFilter, providerFilter])

	// ── Session filter handlers (Commit 3) ────────────────────────────────
	// When a filter changes, re-fetch sessions with the new filter. The
	// stats snapshot is unaffected by model/provider filters.
	const handleModelFilterChange = useCallback(
		(value: string | undefined) => {
			setModelFilter(value)
			fetchSessions(preset, groupBy, undefined, undefined, value, providerFilter)
		},
		[preset, groupBy, providerFilter, fetchSessions],
	)

	const handleProviderFilterChange = useCallback(
		(value: string | undefined) => {
			setProviderFilter(value)
			fetchSessions(preset, groupBy, undefined, undefined, modelFilter, value)
		},
		[preset, groupBy, modelFilter, fetchSessions],
	)

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
					setError(t("dashboard:states.error"))
					setLoading(false)
				}
			}

			if (message.type === "usageStatsChanged") {
				// Data changed externally — refetch both stats and sessions with debounce
				const timer = setTimeout(() => {
					fetchStats(preset, groupBy)
					fetchSessions(preset, groupBy, undefined, undefined, modelFilter, providerFilter)
				}, 300)
				return () => clearTimeout(timer)
			}

			if (message.type === "dashboardSessionsResponse") {
				// Only accept the latest sessions request's response
				if (message.requestId !== latestSessionsRequestIdRef.current) return

				if (message.dashboardSessions) {
					setSessions(message.dashboardSessions)
					setSessionsLoading(false)
					setSessionsError(null)
				} else {
					setSessionsError(message.error || t("dashboard:states.error"))
					setSessionsLoading(false)
				}
			}

			if (message.type === "requestClearNonceResponse") {
				// Host issues the nonce; store it and open the confirm dialog.
				// If the host returned null/error, surface it without opening the dialog.
				if (message.clearNonce) {
					setClearNonce(message.clearNonce)
					setShowClearDialog(true)
				} else {
					setError(message.error || t("dashboard:states.error"))
					setShowClearDialog(false)
					setClearNonce(null)
				}
			}

			if (message.type === "clearUsageStatsResponse") {
				if (message.clearUsageStatsResult?.success) {
					setShowClearDialog(false)
					setClearNonce(null)
					fetchStats(preset, groupBy)
					fetchSessions(preset, groupBy, undefined, undefined, modelFilter, providerFilter)
				} else {
					setError(message.clearUsageStatsResult?.error || t("dashboard:states.error"))
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
	}, [t, preset, groupBy, fetchStats, fetchSessions, modelFilter, providerFilter])

	// ── Export ───────────────────────────────────────────────────────────────

	const handleExport = useCallback(
		(format: "json" | "csv") => {
			const requestId = `dashboard-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
		// Ask the host to issue a clear nonce. The host-generated nonce is
		// returned via `requestClearNonceResponse` and stored in `clearNonce`.
		const requestId = `dashboard-clear-nonce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
		<Tab data-testid="dashboard-view">
			<TabHeader className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							className="px-1.5 -ml-2"
							onClick={onDone}
							aria-label={t("dashboard:done")}
							data-testid="dashboard-done-button">
							<ArrowLeft />
							<span className="sr-only">{t("dashboard:done")}</span>
						</Button>
						<h3 className="text-vscode-foreground m-0">{t("dashboard:title")}</h3>
					</div>
					<div className="flex items-center gap-1">
						<StandardTooltip content={t("dashboard:actions.refresh")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleRefresh}
								data-testid="dashboard-refresh-button"
								aria-label={t("dashboard:actions.refresh")}>
								<RefreshCw className={loading ? "animate-spin" : ""} />
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("dashboard:actions.exportJson")}>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => handleExport("json")}
								data-testid="dashboard-export-json"
								disabled={!hasData}>
								<Download className="size-3.5" />
								<span className="hidden sm:inline">{t("dashboard:actions.exportJson")}</span>
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("dashboard:actions.exportCsv")}>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => handleExport("csv")}
								data-testid="dashboard-export-csv"
								disabled={!hasData}>
								<Download className="size-3.5" />
								<span className="hidden sm:inline">{t("dashboard:actions.exportCsv")}</span>
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("dashboard:actions.clear")}>
							<Button
								variant="destructive"
								size="sm"
								onClick={handleClearRequest}
								data-testid="dashboard-clear-button"
								disabled={!hasData}>
								<Trash2 className="size-3.5" />
								<span className="hidden sm:inline">{t("dashboard:actions.clear")}</span>
							</Button>
						</StandardTooltip>
					</div>
				</div>

				{/* Range selector */}
				<div className="flex flex-wrap items-center gap-1">
					{(["today", "7d", "30d", "custom", "all"] as DashboardPreset[]).map((p) => (
						<Button
							key={p}
							variant={preset === p ? "primary" : "secondary"}
							size="sm"
							onClick={() => handlePresetChange(p)}
							data-testid={`dashboard-range-${p}`}>
							{t(`dashboard:range.${p}`)}
						</Button>
					))}

					{/* Custom date range inputs — shown only when "custom" is active */}
					{preset === "custom" && (
						<div className="flex items-center gap-1 ml-2" data-testid="dashboard-custom-range">
							<label
								htmlFor="dashboard-custom-from"
								className="text-xs text-vscode-descriptionForeground whitespace-nowrap">
								{t("dashboard:customRange.from")}
							</label>
							<input
								id="dashboard-custom-from"
								type="date"
								value={customFrom}
								onChange={(e) => setCustomFrom(e.target.value)}
								className="rounded border border-vscode-panel-border bg-vscode-input-background px-1.5 py-0.5 text-xs text-vscode-input-foreground"
								data-testid="dashboard-custom-from"
							/>
							<label
								htmlFor="dashboard-custom-to"
								className="text-xs text-vscode-descriptionForeground whitespace-nowrap">
								{t("dashboard:customRange.to")}
							</label>
							<input
								id="dashboard-custom-to"
								type="date"
								value={customTo}
								onChange={(e) => setCustomTo(e.target.value)}
								className="rounded border border-vscode-panel-border bg-vscode-input-background px-1.5 py-0.5 text-xs text-vscode-input-foreground"
								data-testid="dashboard-custom-to"
							/>
							<Button
								variant="primary"
								size="sm"
								onClick={handleApplyCustomRange}
								disabled={!customFrom || !customTo}
								data-testid="dashboard-custom-apply">
								{t("dashboard:actions.refresh")}
							</Button>
						</div>
					)}
				</div>
			</TabHeader>

			<TabContent className="flex flex-col gap-4">
				{/* Loading state */}
				{loading && (
					<div className="flex items-center justify-center py-8" data-testid="dashboard-loading">
						<RefreshCw className="size-5 animate-spin text-vscode-descriptionForeground" />
						<span className="ml-2 text-sm text-vscode-descriptionForeground">
							{t("dashboard:states.loading")}
						</span>
					</div>
				)}

				{/* Error state */}
				{!loading && error && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="dashboard-error">
						<span className="text-sm text-vscode-errorForeground">{error}</span>
						<Button variant="secondary" size="sm" onClick={handleRefresh}>
							{t("dashboard:actions.refresh")}
						</Button>
					</div>
				)}

				{/* Empty state */}
				{!loading && !error && !hasData && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="dashboard-empty">
						<span className="text-sm text-vscode-descriptionForeground">{t("dashboard:states.empty")}</span>
						<span className="text-xs text-vscode-descriptionForeground">
							{t("dashboard:states.emptyHint")}
						</span>
					</div>
				)}

				{/* Data display */}
				{!loading && !error && hasData && (
					<>
						{/* Summary cards */}
						<DashboardSummary totals={totals} />

						{/* Heatmap */}
						<UsageHeatmap buckets={buckets} />

						{/* Breakdown table */}
						<div className="flex flex-col gap-2" data-testid="dashboard-breakdown">
							<div className="flex items-center justify-between">
								<h4 className="text-sm font-medium text-vscode-foreground m-0">
									{t("dashboard:breakdown.title")}
								</h4>
								<div className="flex flex-wrap gap-1">
									{(["model", "provider", "mode"] as DashboardGroupBy[]).map((g) => (
										<Button
											key={g}
											variant={groupBy === g ? "primary" : "ghost"}
											size="sm"
											onClick={() => handleGroupByChange(g)}
											data-testid={`dashboard-groupby-${g}`}>
											{t(`dashboard:breakdown.${g}`)}
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
												{t(`dashboard:breakdown.${groupBy}`)}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.events")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.inputTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.outputTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.cacheReadTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.cacheWriteTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.reasoningTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.totalTokens")}
											</th>
											<th className="px-2 py-1.5 text-right font-medium text-vscode-foreground whitespace-nowrap">
												{t("dashboard:breakdown.costUsd")}
											</th>
										</tr>
									</thead>
									<tbody>
										{buckets.map((bucket, index) => {
											const keyValue = bucket.key?.[groupBy] ?? t("dashboard:breakdown.unknown")
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

						{/* Sessions list (Commit 3) */}
						{sessionsLoading ? (
							<div
								className="flex items-center justify-center py-4"
								data-testid="dashboard-sessions-loading">
								<RefreshCw className="size-4 animate-spin text-vscode-descriptionForeground" />
								<span className="ml-2 text-xs text-vscode-descriptionForeground">
									{t("dashboard:states.loading")}
								</span>
							</div>
						) : sessionsError ? (
							<div
								className="flex items-center justify-center py-4 text-xs text-vscode-errorForeground"
								data-testid="dashboard-sessions-error">
								{sessionsError}
							</div>
						) : (
							<SessionList
								sessions={sessions}
								modelFilter={modelFilter}
								providerFilter={providerFilter}
								onModelFilterChange={handleModelFilterChange}
								onProviderFilterChange={handleProviderFilterChange}
							/>
						)}

						{/* Data coverage */}
						{snapshot?.coverage && (
							<div
								className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-3 text-xs text-vscode-descriptionForeground"
								data-testid="dashboard-coverage">
								<span className="font-medium text-vscode-foreground">
									{t("dashboard:coverage.title")}
								</span>
								{snapshot.coverage.firstEventAt && (
									<span>
										{t("dashboard:coverage.liveFrom")}:{" "}
										{new Date(snapshot.coverage.firstEventAt).toLocaleString()}
									</span>
								)}
								{snapshot.coverage.backfilledEventCount > 0 && (
									<span>
										{t("dashboard:coverage.backfilledEvents")}:{" "}
										{snapshot.coverage.backfilledEventCount}
									</span>
								)}
								{snapshot.coverage.recordingPaused && (
									<span className="text-vscode-errorForeground">
										{t("dashboard:coverage.paused")}
									</span>
								)}
							</div>
						)}
					</>
				)}
			</TabContent>

			{/* Clear confirmation dialog */}
			<AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
				<AlertDialogContent data-testid="dashboard-clear-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>{t("dashboard:clearDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("dashboard:clearDialog.description")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel data-testid="dashboard-clear-cancel">
							{t("dashboard:clearDialog.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleClearConfirm}
							data-testid="dashboard-clear-confirm"
							className="bg-vscode-errorForeground text-white hover:bg-vscode-errorForeground/90">
							{t("dashboard:clearDialog.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default DashboardView
