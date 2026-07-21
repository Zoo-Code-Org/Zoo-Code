import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import type { StatsBucket } from "@roo-code/types"

import { Button, StandardTooltip } from "@/components/ui"

// ── Types ───────────────────────────────────────────────────────────────────

interface DailyActivity {
	date: string // YYYY-MM-DD
	totalTokens: number
	events: number
}

// ── Heatmap color levels ────────────────────────────────────────────────────

/**
 * Map a token value to a 0-5 intensity level based on the max value.
 * Level 0 = no data, 1-5 = increasing intensity.
 */
function getIntensityLevel(value: number, maxValue: number): number {
	if (value === 0 || maxValue === 0) return 0
	const ratio = value / maxValue
	if (ratio < 0.2) return 1
	if (ratio < 0.4) return 2
	if (ratio < 0.6) return 3
	if (ratio < 0.8) return 4
	return 5
}

const HEATMAP_COLORS: Record<number, string> = {
	0: "transparent", // No data — white border only
	1: "#c6dbef", // Lightest blue
	2: "#9ecae1", // Light blue
	3: "#6baed6", // Medium blue
	4: "#3182bd", // Dark blue
	5: "#08519c", // Darkest blue
}

// ── Date helpers ────────────────────────────────────────────────────────────

function formatDateKey(date: Date): string {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, "0")
	const day = String(date.getDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

function formatDisplayDate(dateKey: string): string {
	try {
		const date = new Date(dateKey + "T00:00:00")
		return date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		})
	} catch {
		return dateKey
	}
}

// ── Range configuration ─────────────────────────────────────────────────────

type HeatmapRange = "30d" | "60d" | "120d" | "360d"

const RANGE_DAYS: Record<HeatmapRange, number> = {
	"30d": 30,
	"60d": 60,
	"120d": 120,
	"360d": 360,
}

const RANGE_OPTIONS: HeatmapRange[] = ["30d", "60d", "120d", "360d"]

// ── UsageHeatmap ────────────────────────────────────────────────────────────

const UsageHeatmap = memo(() => {
	const { t } = useAppTranslation()
	const [range, setRange] = useState<HeatmapRange>("30d")
	const [heatmapBuckets, setHeatmapBuckets] = useState<StatsBucket[]>([])
	const [loading, setLoading] = useState(true)
	const latestHeatmapRequestIdRef = useRef<string>("")

	// Fetch heatmap data independently from the top-level date picker.
	// Sends a getUsageStats message with a "heatmap-" requestId prefix so
	// responses can be filtered from DashboardView's own requests.
	const fetchHeatmapData = useCallback((rangeArg: HeatmapRange) => {
		const days = RANGE_DAYS[rangeArg]
		const requestId = `heatmap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		latestHeatmapRequestIdRef.current = requestId
		setLoading(true)

		const from = new Date(Date.now() - days * 86400000)
		from.setHours(0, 0, 0, 0)

		let timezone: string
		try {
			timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
		} catch {
			timezone = "UTC"
		}

		vscode.postMessage({
			type: "getUsageStats",
			requestId,
			usageStatsQuery: {
				from: from.toISOString(),
				timezone,
				groupBy: ["day"],
				includeCancelled: false,
			},
		})
	}, [])

	// Listen for responses to our heatmap requests and perform initial fetch.
	useEffect(() => {
		const handleMessage = (e: MessageEvent) => {
			const message = e.data

			if (
				message.type === "getUsageStatsResponse" &&
				typeof message.requestId === "string" &&
				message.requestId.startsWith("heatmap-") &&
				message.requestId === latestHeatmapRequestIdRef.current
			) {
				if (message.usageStatsSnapshot) {
					setHeatmapBuckets(message.usageStatsSnapshot.buckets ?? [])
				}
				setLoading(false)
			}
		}

		window.addEventListener("message", handleMessage)
		fetchHeatmapData(range) // Initial fetch

		return () => window.removeEventListener("message", handleMessage)
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	const handleRangeChange = useCallback(
		(newRange: HeatmapRange) => {
			setRange(newRange)
			fetchHeatmapData(newRange)
		},
		[fetchHeatmapData],
	)

	// Extract daily activity from buckets that have a "day" key
	const dailyMap = useMemo(() => {
		const map = new Map<string, DailyActivity>()

		for (const bucket of heatmapBuckets) {
			const dayKey = bucket.key?.day
			if (!dayKey) continue

			const existing = map.get(dayKey)
			if (existing) {
				existing.totalTokens += bucket.totalTokens
				existing.events += bucket.events
			} else {
				map.set(dayKey, {
					date: dayKey,
					totalTokens: bucket.totalTokens,
					events: bucket.events,
				})
			}
		}

		return map
	}, [heatmapBuckets])

	// Generate the date range for display
	const days = useMemo(() => {
		const count = RANGE_DAYS[range]
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		const result: DailyActivity[] = []

		for (let i = count - 1; i >= 0; i--) {
			const date = new Date(today)
			date.setDate(date.getDate() - i)
			const key = formatDateKey(date)
			const activity = dailyMap.get(key)
			result.push(
				activity || {
					date: key,
					totalTokens: 0,
					events: 0,
				},
			)
		}

		return result
	}, [dailyMap, range])

	const maxTokens = useMemo(() => {
		let max = 0
		for (const day of days) {
			if (day.totalTokens > max) max = day.totalTokens
		}
		return max
	}, [days])

	const hasData = maxTokens > 0

	// Gap between cells: tighter for longer ranges
	const gap = range === "30d" ? "gap-0.5" : "gap-px"

	return (
		<div className="flex flex-col gap-2" data-testid="usage-heatmap">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium text-vscode-foreground m-0">{t("stats:heatmap.title")}</h4>
				<div className="flex gap-1">
					{RANGE_OPTIONS.map((option) => (
						<Button
							key={option}
							variant={range === option ? "primary" : "ghost"}
							size="sm"
							onClick={() => handleRangeChange(option)}
							data-testid={`heatmap-range-${option}`}>
							{t(`stats:heatmap.${option}`)}
						</Button>
					))}
				</div>
			</div>

			{loading && !hasData ? (
				<div className="text-xs text-vscode-descriptionForeground py-4">{t("stats:heatmap.loading")}</div>
			) : !hasData ? (
				<div className="text-xs text-vscode-descriptionForeground py-4">{t("stats:heatmap.noData")}</div>
			) : (
				<>
					<div
						className={`grid grid-flow-col grid-rows-7 ${gap} overflow-x-auto`}
						style={{
							gridTemplateColumns: `repeat(${Math.ceil(days.length / 7)}, minmax(14px, 1fr))`,
						}}
						role="img"
						aria-label={t("stats:heatmap.title")}>
						{days.map((day) => {
							const level = getIntensityLevel(day.totalTokens, maxTokens)
							return (
								<StandardTooltip
									key={day.date}
									content={
										day.totalTokens > 0
											? `${formatDisplayDate(day.date)}: ${day.totalTokens.toLocaleString()} tokens (${day.events} requests)`
											: `${formatDisplayDate(day.date)}: ${t("stats:heatmap.noData")}`
									}>
									<div
										className="rounded-sm transition-colors min-w-[14px] min-h-[14px]"
										style={{
											backgroundColor: HEATMAP_COLORS[level],
											border: "1px solid rgba(255, 255, 255, 0.3)",
										}}
										aria-label={`${day.date}: ${day.totalTokens} tokens`}
									/>
								</StandardTooltip>
							)
						})}
					</div>

					{/* Legend */}
					<div className="flex items-center gap-1 text-xs text-vscode-descriptionForeground">
						<span>{t("stats:heatmap.less")}</span>
						{[0, 1, 2, 3, 4, 5].map((level) => (
							<div
								key={level}
								className="w-3 h-3 rounded-sm"
								style={{
									backgroundColor: HEATMAP_COLORS[level],
									border: "1px solid rgba(255, 255, 255, 0.3)",
								}}
							/>
						))}
						<span>{t("stats:heatmap.more")}</span>
					</div>
				</>
			)}
		</div>
	)
})

export default UsageHeatmap
