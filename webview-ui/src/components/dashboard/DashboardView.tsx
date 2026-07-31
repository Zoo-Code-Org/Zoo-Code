import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Download, Trash2, RefreshCw, Database } from "lucide-react"

import type { ExtensionMessage, StatsQuery, StatsBucket, SessionDetail, DashboardSessionSummary } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { formatCompact, formatCost } from "@/utils/formatNumber"

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
import { useDashboardStatsStream } from "./useDashboardStatsStream"

// ── Types ───────────────────────────────────────────────────────────────────

// Dashboard range presets. "custom" is a local-only UI state: when selected,
// the query is sent with explicit from/to ISO strings and no `preset` field
// (the backend StatsQuery schema only allows today/7d/30d/all for `preset`).
type DashboardPreset = "today" | "7d" | "30d" | "custom" | "all"
type DashboardGroupBy = "model" | "provider" | "mode"
type HeatmapRange = "30d" | "60d" | "120d" | "360d"

const HEATMAP_RANGE_DAYS: Record<HeatmapRange, number> = {
	"30d": 30,
	"60d": 60,
	"120d": 120,
	"360d": 360,
}

interface DashboardViewProps {
	onDone: () => void
}

// ── DashboardView ───────────────────────────────────────────────────────────

const DashboardView = memo(({ onDone }: DashboardViewProps) => {
	const { t } = useAppTranslation()

	const [preset, setPreset] = useState<DashboardPreset>("today")
	const [groupBy, setGroupBy] = useState<DashboardGroupBy>("model")
	const [showClearDialog, setShowClearDialog] = useState(false)
	const [clearNonce, setClearNonce] = useState<string | null>(null)
	// Cache ratio for estimation when provider doesn't report cacheReadTokens (default 94%)
	const [cacheRatio, setCacheRatio] = useState<number>(0.94)
	const [heatmapRange, setHeatmapRange] = useState<HeatmapRange>("30d")
	const [isResyncing, setIsResyncing] = useState(false)

	// ── Session detail state ────────────────────────────────────────────────
	// Only one session is expanded at a time (accordion pattern). The detail
	// is fetched on first expansion via `getDashboardSessionDetail` and cached
	// in `sessionDetails` so re-expanding does not refetch.
	const [expandedTaskId, setExpandedTaskId] = useState<string | undefined>(undefined)
	const [sessionDetails, setSessionDetails] = useState<Record<string, SessionDetail | null>>({})
	const [sessionDetailErrors, setSessionDetailErrors] = useState<Record<string, string | null>>({})
	const [sessionDetailLoading, setSessionDetailLoading] = useState<Set<string>>(new Set())
	const latestSessionDetailRequestIdRef = useRef<string>("")

	// ── Error state (for clear/export errors) ───────────────────────────────
	const [error, setError] = useState<string | null>(null)

	// Custom range date inputs (YYYY-MM-DD). Only used when preset === "custom".
	// Default to yesterday~today so the inputs are never empty on first selection.
	const toLocalDateString = useCallback((d: Date) => {
		const year = d.getFullYear()
		const month = String(d.getMonth() + 1).padStart(2, "0")
		const day = String(d.getDate()).padStart(2, "0")
		return `${year}-${month}-${day}`
	}, [])

	const defaultDateRange = useMemo(() => {
		const now = new Date()
		const yesterday = new Date(now)
		yesterday.setDate(now.getDate() - 1)
		return { from: toLocalDateString(yesterday), to: toLocalDateString(now) }
	}, [toLocalDateString])

	const [customFrom, setCustomFrom] = useState<string>(defaultDateRange.from)
	const [customTo, setCustomTo] = useState<string>(defaultDateRange.to)

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
			const _now = new Date()
			let from: string | undefined
			let to: string | undefined
			let queryPreset: StatsQuery["preset"]

			// ST-5: Named presets (today/7d/30d/all) must NOT send from/to.
			// The backend resolves date ranges from the preset string itself.
			// Only the "custom" preset sends explicit from/to values.
			if (currentPreset === "today") {
				queryPreset = "today"
			} else if (currentPreset === "7d") {
				queryPreset = "7d"
			} else if (currentPreset === "30d") {
				queryPreset = "30d"
			} else if (currentPreset === "custom") {
				const fromStr = fromOverride ?? customFrom
				const toStr = toOverride ?? customTo
				if (fromStr) {
					from = new Date(`${fromStr}T00:00:00`).toISOString()
				}
				if (toStr) {
					to = new Date(`${toStr}T23:59:59.999`).toISOString()
				}
			} else if (currentPreset === "all") {
				queryPreset = "all"
			}

			return {
				preset: queryPreset,
				from,
				to,
				timezone,
				groupBy: (
					[currentGroupBy] as Array<
						"day" | "week" | "month" | "provider" | "model" | "mode" | "status" | "source"
					>
				).filter((v, i, a) => a.indexOf(v) === i),
				includeCancelled: false,
				cacheRatio,
			}
		},
		[timezone, customFrom, customTo, cacheRatio],
	)

	// ── Streaming hook ──────────────────────────────────────────────────────

	const streamRange = useMemo(() => buildQuery(preset, groupBy), [buildQuery, preset, groupBy])
	const streamHeatmapRangeDays = HEATMAP_RANGE_DAYS[heatmapRange]

	const {
		state: streamState,
		requestSessionPage,
		replaceSubscription,
	} = useDashboardStatsStream({
		range: streamRange,
		heatmapRangeDays: streamHeatmapRangeDays,
		sessionPageSize: 50,
	})

	// ── Replace subscription when preset/groupBy/heatmapRange changes ───────

	const prevPresetRef = useRef(preset)
	const prevGroupByRef = useRef(groupBy)
	const prevHeatmapRangeRef = useRef(heatmapRange)
	const prevCacheRatioRef = useRef(cacheRatio)

	useEffect(() => {
		const presetChanged = prevPresetRef.current !== preset
		const groupByChanged = prevGroupByRef.current !== groupBy
		const heatmapRangeChanged = prevHeatmapRangeRef.current !== heatmapRange
		const cacheRatioChanged = prevCacheRatioRef.current !== cacheRatio

		if (presetChanged || groupByChanged || heatmapRangeChanged || cacheRatioChanged) {
			prevPresetRef.current = preset
			prevGroupByRef.current = groupBy
			prevHeatmapRangeRef.current = heatmapRange
			prevCacheRatioRef.current = cacheRatio

			// For custom preset, only replace if both dates are present
			if (preset === "custom" && (!customFrom || !customTo)) {
				return
			}

			replaceSubscription(buildQuery(preset, groupBy), HEATMAP_RANGE_DAYS[heatmapRange], 50)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [preset, groupBy, heatmapRange, cacheRatio])

	// ── Clear isResyncing when new snapshot arrives ──────────────────────────

	useEffect(() => {
		if (isResyncing) {
			setIsResyncing(false)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streamState.generatedAt])

	// ── Fetch session detail (on expand) ───────────────────────────────────

	const fetchSessionDetail = useCallback((taskId: string) => {
		const requestId = `dashboard-session-detail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		latestSessionDetailRequestIdRef.current = requestId

		setSessionDetailLoading((prev) => {
			const next = new Set(prev)
			next.add(taskId)
			return next
		})
		setSessionDetailErrors((prev) => {
			if (prev[taskId] === undefined) return prev
			const next = { ...prev }
			next[taskId] = null
			return next
		})

		vscode.postMessage({
			type: "getDashboardSessionDetail",
			requestId,
			taskId,
		})
	}, [])

	const handleToggleSession = useCallback(
		(taskId: string) => {
			setExpandedTaskId((current) => {
				if (current === taskId) return undefined
				if (sessionDetails[taskId] === undefined && !sessionDetailLoading.has(taskId)) {
					fetchSessionDetail(taskId)
				}
				return taskId
			})
		},
		[sessionDetails, sessionDetailLoading, fetchSessionDetail],
	)

	// ── Manual refresh = explicit background resync ────────────────────────

	const handleRefresh = useCallback(() => {
		replaceSubscription(buildQuery(preset, groupBy), HEATMAP_RANGE_DAYS[heatmapRange], 50)
	}, [preset, groupBy, heatmapRange, buildQuery, replaceSubscription])

	// ── Preset / groupBy / heatmap range handlers ───────────────────────────

	const handlePresetChange = useCallback((newPreset: DashboardPreset) => {
		setPreset(newPreset)
		setIsResyncing(true)
	}, [])

	const handleGroupByChange = useCallback((newGroupBy: DashboardGroupBy) => {
		setGroupBy(newGroupBy)
	}, [])

	const handleHeatmapRangeChange = useCallback((newRange: HeatmapRange) => {
		setHeatmapRange(newRange)
	}, [])

	const handleApplyCustomRange = useCallback(() => {
		if (!customFrom || !customTo) return
		replaceSubscription(buildQuery("custom", groupBy, customFrom, customTo), HEATMAP_RANGE_DAYS[heatmapRange], 50)
	}, [customFrom, customTo, groupBy, heatmapRange, buildQuery, replaceSubscription])

	// ── Listen for session detail + clear/export responses ──────────────────

	useEffect(() => {
		const handleMessage = (e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "dashboardSessionDetailResponse") {
				if (message.requestId !== latestSessionDetailRequestIdRef.current) return

				const taskId = expandedTaskId
				if (!taskId) return

				setSessionDetailLoading((prev) => {
					if (!prev.has(taskId)) return prev
					const next = new Set(prev)
					next.delete(taskId)
					return next
				})

				const detail = message.dashboardSessionDetail ?? null
				const detailError = message.error || t("dashboard:states.error")

				setSessionDetails((prev) => ({
					...prev,
					[taskId]: detail,
				}))
				setSessionDetailErrors((prev) => ({
					...prev,
					[taskId]: detail ? null : detailError,
				}))
			}

			if (message.type === "requestClearNonceResponse") {
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
					// Trigger a resync after clear
					replaceSubscription(buildQuery(preset, groupBy), HEATMAP_RANGE_DAYS[heatmapRange], 50)
				} else {
					setError(message.clearUsageStatsResult?.error || t("dashboard:states.error"))
					setShowClearDialog(false)
					setClearNonce(null)
				}
			}

			if (message.type === "exportUsageStatsResponse") {
				if (message.exportUsageStatsResult?.error) {
					setError(message.exportUsageStatsResult.error)
				}
			}

			if (message.type === "rebuildUsageStatsResponse") {
				if (message.rebuildUsageStatsResult?.success) {
					// Trigger a resync after rebuild
					replaceSubscription(buildQuery(preset, groupBy), HEATMAP_RANGE_DAYS[heatmapRange], 50)
				} else {
					setError(message.rebuildUsageStatsResult?.error || t("dashboard:states.error"))
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [t, expandedTaskId, preset, groupBy, heatmapRange])

	// ── Export ───────────────────────────────────────────────────────────────

	const handleExport = useCallback(
		(format: "csv") => {
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

	// ── Rebuild stats (rebuild rollup tables from raw events) ───────────────

	const handleRebuildStats = useCallback(() => {
		const requestId = `dashboard-rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		vscode.postMessage({
			type: "rebuildUsageStats",
			requestId,
		})
	}, [])

	// ── Derived data from stream state ──────────────────────────────────────

	const totals: StatsBucket = useMemo(
		() =>
			streamState.totals ?? {
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
		[streamState.totals],
	)

	const buckets = useMemo(
		() => streamState.bucketOrder.map((key) => streamState.buckets[key]).filter(Boolean),
		[streamState.buckets, streamState.bucketOrder],
	)

	const sessions: DashboardSessionSummary[] = useMemo(
		() => streamState.sessionOrder.map((id) => streamState.sessions[id]).filter(Boolean),
		[streamState.sessions, streamState.sessionOrder],
	)

	const hasData = totals.events > 0

	// Loading is only true before the first snapshot arrives.
	// After the first snapshot, we never show a loading spinner (architecture goal 1.1#1).
	const isLoading = streamState.isLoading

	// Background error is non-fatal; existing data stays visible.
	const backgroundError = streamState.backgroundError

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
								<RefreshCw className={isLoading ? "animate-spin" : ""} />
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
						<StandardTooltip content={t("dashboard:actions.rebuild")}>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleRebuildStats}
								data-testid="dashboard-rebuild-button"
								disabled={!hasData}>
								<Database className="size-3.5" />
								<span className="hidden sm:inline">{t("dashboard:actions.rebuild")}</span>
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

				{/* Cache ratio estimation input */}
				<div className="flex items-center gap-2" data-testid="dashboard-cache-ratio">
					<label
						htmlFor="dashboard-cache-ratio-input"
						className="text-xs text-vscode-descriptionForeground whitespace-nowrap">
						{t("dashboard:cacheRatio.label")}
					</label>
					<input
						id="dashboard-cache-ratio-input"
						type="number"
						min="0"
						max="100"
						step="1"
						value={Math.round(cacheRatio * 100)}
						onChange={(e) => {
							const value = parseInt(e.target.value, 10)
							if (!isNaN(value) && value >= 0 && value <= 100) {
								setCacheRatio(value / 100)
							}
						}}
						className="w-16 rounded border border-vscode-panel-border bg-vscode-input-background px-1.5 py-0.5 text-xs text-vscode-input-foreground"
						data-testid="dashboard-cache-ratio-input"
					/>
					<span className="text-xs text-vscode-descriptionForeground">%</span>
					<span className="text-xs text-vscode-descriptionForeground">{t("dashboard:cacheRatio.hint")}</span>
				</div>
			</TabHeader>

			<TabContent className="flex flex-col gap-4">
				{/* Loading state — only before first snapshot */}
				{isLoading && (
					<div className="flex items-center justify-center py-8" data-testid="dashboard-loading">
						<RefreshCw className="size-5 animate-spin text-vscode-descriptionForeground" />
						<span className="ml-2 text-sm text-vscode-descriptionForeground">
							{t("dashboard:states.loading")}
						</span>
					</div>
				)}

				{/* Error state — only when no data and a fatal error occurred */}
				{!isLoading && error && !hasData && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="dashboard-error">
						<span className="text-sm text-vscode-errorForeground">{error}</span>
						<Button variant="secondary" size="sm" onClick={handleRefresh}>
							{t("dashboard:actions.refresh")}
						</Button>
					</div>
				)}

				{/* Background error banner — non-fatal, data stays visible */}
				{!isLoading && backgroundError && hasData && (
					<div
						className="flex items-center gap-2 rounded-md border border-vscode-inputValidation-warningBorder bg-vscode-inputValidation-warningBackground px-3 py-2 text-xs text-vscode-foreground"
						data-testid="dashboard-background-error">
						<span>{backgroundError.message}</span>
						<Button variant="ghost" size="sm" onClick={handleRefresh}>
							{t("dashboard:actions.refresh")}
						</Button>
					</div>
				)}

				{/* Clear/export error — non-fatal, data stays visible */}
				{!isLoading && error && hasData && (
					<div
						className="flex items-center gap-2 rounded-md border border-vscode-inputValidation-warningBorder bg-vscode-inputValidation-warningBackground px-3 py-2 text-xs text-vscode-foreground"
						data-testid="dashboard-error-banner">
						<span>{error}</span>
					</div>
				)}

				{/* Empty state */}
				{!isLoading && !error && !hasData && (
					<div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="dashboard-empty">
						<span className="text-sm text-vscode-descriptionForeground">{t("dashboard:states.empty")}</span>
						<span className="text-xs text-vscode-descriptionForeground">
							{t("dashboard:states.emptyHint")}
						</span>
					</div>
				)}

				{/* Data display */}
				{!isLoading && !error && hasData && (
					<>
						{/* Resync loading indicator — shown during preset transitions */}
						{isResyncing && (
							<div
								className="flex items-center justify-center gap-2 rounded-md border border-vscode-inputValidation-infoBorder bg-vscode-inputValidation-infoBackground px-3 py-2 text-xs text-vscode-foreground"
								data-testid="dashboard-resyncing">
								<RefreshCw className="size-3.5 animate-spin" />
								<span>{t("dashboard:states.loading")}</span>
							</div>
						)}

						{/* Summary cards */}
						<DashboardSummary totals={totals} />

						{/* Heatmap — controlled by stream */}
						<UsageHeatmap
							values={streamState.heatmapValues}
							rangeDays={streamState.heatmapRangeDays ?? HEATMAP_RANGE_DAYS[heatmapRange]}
							selectedRange={heatmapRange}
							onRangeChange={handleHeatmapRangeChange}
						/>

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

						{/* Sessions list — virtualized, stream-controlled */}
						<SessionList
							sessions={sessions}
							expandedTaskId={expandedTaskId}
							sessionDetails={sessionDetails}
							sessionDetailErrors={sessionDetailErrors}
							sessionDetailLoading={sessionDetailLoading}
							onToggleSession={handleToggleSession}
							onLoadMore={() => requestSessionPage()}
							totalEstimate={streamState.sessionTotalEstimate}
						/>

						{/* Data coverage */}
						{streamState.coverage && (
							<div
								className="flex flex-col gap-1 rounded-md border border-vscode-panel-border p-3 text-xs text-vscode-descriptionForeground"
								data-testid="dashboard-coverage">
								<span className="font-medium text-vscode-foreground">
									{t("dashboard:coverage.title")}
								</span>
								{streamState.coverage.firstEventAt && (
									<span>
										{t("dashboard:coverage.liveFrom")}:{" "}
										{new Date(streamState.coverage.firstEventAt).toLocaleString()}
									</span>
								)}
								{streamState.coverage.lastEventAt && (
									<span>
										{t("dashboard:coverage.lastUpdated")}:{" "}
										{new Date(streamState.coverage.lastEventAt).toLocaleString()}
									</span>
								)}
								{streamState.coverage.backfilledEventCount > 0 && (
									<span>
										{t("dashboard:coverage.backfilledEvents")}:{" "}
										{streamState.coverage.backfilledEventCount}
									</span>
								)}
								{streamState.coverage.recordingPaused && (
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
