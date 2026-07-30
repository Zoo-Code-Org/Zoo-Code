import React, { memo, useCallback, useMemo } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { Button, StandardTooltip } from "@/components/ui"

// ── Types ────────────────────────────────────────────────────────────────────

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

const RANGE_OPTIONS: HeatmapRange[] = ["30d", "60d", "120d", "360d"]

// ── UsageHeatmap (controlled) ────────────────────────────────────────────────

export interface UsageHeatmapProps {
	/** Daily heatmap values from the stream (oldest first). */
	values: number[]
	/** Number of days the values array covers. */
	rangeDays: number
	/** Currently selected range label for button highlighting. */
	selectedRange: HeatmapRange
	/** Called when the user changes the range. */
	onRangeChange: (range: HeatmapRange) => void
}

const UsageHeatmap = memo(({ values, rangeDays, selectedRange, onRangeChange }: UsageHeatmapProps) => {
	const { t } = useAppTranslation()

	const handleRangeChange = useCallback(
		(newRange: HeatmapRange) => {
			onRangeChange(newRange)
		},
		[onRangeChange],
	)

	// Build a map of day-index → value from the stream's values array.
	// The values array is oldest-first, so index 0 = oldest day.
	const dailyMap = useMemo(() => {
		const map = new Map<string, DailyActivity>()
		const today = new Date()
		today.setHours(0, 0, 0, 0)

		for (let i = 0; i < values.length; i++) {
			const daysAgo = values.length - 1 - i
			const date = new Date(today)
			date.setDate(date.getDate() - daysAgo)
			const key = formatDateKey(date)
			map.set(key, {
				date: key,
				totalTokens: values[i] ?? 0,
				events: 0,
			})
		}

		return map
	}, [values])

	// Generate the date range for display
	const days = useMemo(() => {
		const count = rangeDays
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
	}, [dailyMap, rangeDays])

	const maxTokens = useMemo(() => {
		let max = 0
		for (const day of days) {
			if (day.totalTokens > max) max = day.totalTokens
		}
		return max
	}, [days])

	const hasData = maxTokens > 0

	// Gap between cells: tighter for longer ranges
	const gap = selectedRange === "30d" ? "gap-0.5" : "gap-px"

	return (
		<div className="flex flex-col gap-2" data-testid="usage-heatmap">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium text-vscode-foreground m-0">{t("stats:heatmap.title")}</h4>
				<div className="flex gap-1">
					{RANGE_OPTIONS.map((option) => (
						<Button
							key={option}
							variant={selectedRange === option ? "primary" : "ghost"}
							size="sm"
							onClick={() => handleRangeChange(option)}
							data-testid={`heatmap-range-${option}`}>
							{t(`stats:heatmap.${option}`)}
						</Button>
					))}
				</div>
			</div>

			{!hasData ? (
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
											? `${formatDisplayDate(day.date)}: ${day.totalTokens.toLocaleString()} tokens`
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

UsageHeatmap.displayName = "UsageHeatmap"

export default UsageHeatmap
