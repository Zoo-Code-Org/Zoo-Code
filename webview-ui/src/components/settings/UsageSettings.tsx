import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { Download } from "lucide-react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"
import { formatLargeNumber, formatTimeAgo } from "@src/utils/format"
import { providerLabel } from "@src/utils/providerLabel"
import {
	UNRECORDED,
	USAGE_RANGES,
	type UsageMetric,
	type UsageRange,
	modelIdFromKey,
	bucketView,
	metricTotal,
	pickMetric,
	primaryUsage,
	summarizeUsage,
	usageToCsv,
} from "@src/utils/usage"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ProviderLimits } from "./ProviderLimits"

const formatCost = (cost: number) => `$${cost.toFixed(2)}`

const PALETTE = [
	"var(--vscode-charts-blue)",
	"var(--vscode-charts-purple)",
	"var(--vscode-charts-green)",
	"var(--vscode-charts-orange)",
	"var(--vscode-charts-yellow)",
	"var(--vscode-charts-red)",
]

const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "narrow" })
const DAY_FMT = new Intl.DateTimeFormat(undefined, { day: "numeric" })

/**
 * Usage tab.
 *
 * 1. Provider limits: live credits/balances from each connected provider.
 * 2. Usage history: rollup of local task history (tokens, cost when the
 *    provider reports a price, breakdowns, top tasks).
 *
 * Subscription providers (e.g. GitHub Copilot) record no per-task price, so
 * when a range has tokens but no cost the history switches to tokens and the
 * cost stat is hidden rather than shown as a misleading "$0.00".
 */
export const UsageSettings = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => {
	const { t } = useAppTranslation()
	const { taskHistory, cwd } = useExtensionState()

	const [range, setRange] = useState<UsageRange>("7d")
	const [scope, setScope] = useState<"workspace" | "all">("workspace")

	const workspace = scope === "workspace" ? cwd : undefined

	// Provider and model come from what each request recorded, never from the
	// currently selected profile, so switching providers doesn't relabel history.
	const history = useMemo(() => taskHistory ?? [], [taskHistory])

	// One "now" for the view and for the export, rolled over at the next local midnight. Without it a
	// tab left open across midnight keeps yesterday's window while Export (computed at click time)
	// would use today's, and the two would disagree.
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const nextMidnight = new Date(now)
		nextMidnight.setHours(24, 0, 0, 0)
		const timer = setTimeout(() => setNow(Date.now()), nextMidnight.getTime() - now + 1000)
		return () => clearTimeout(timer)
	}, [now])

	const summary = useMemo(() => summarizeUsage(history, { range, workspace, now }), [history, range, workspace, now])

	const providerName = (key: string) => (key === UNRECORDED ? t("settings:usage.notRecorded") : providerLabel(key))

	const metric: UsageMetric = pickMetric(summary)
	const value = (cost: number, tokens: number) => (metric === "cost" ? cost : tokens)
	const fmt = (cost: number, tokens: number) => (metric === "cost" ? formatCost(cost) : formatLargeNumber(tokens))
	const total = metricTotal(summary, metric)

	// Row view-model: the priced/unpriced rule lives in `bucketView` (pure, tested).
	const bucketRow = (b: { cost: number; tokens: number; priced: boolean }) => {
		const view = bucketView(b, metric, total)
		return {
			...view,
			label: view.unpriced
				? `${formatLargeNumber(b.tokens)} ${t("settings:usage.tokensShort")} · ${t("settings:usage.noPrice")}`
				: fmt(b.cost, b.tokens),
		}
	}

	const maxDaily = Math.max(0, ...summary.daily.map((d) => value(d.cost, d.tokens)))
	const showDayLabels = summary.daily.length <= 14
	const isEmpty = summary.taskCount === 0

	const handleExport = () => {
		const csv = usageToCsv(history, { range, workspace, now })
		const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
		const a = document.createElement("a")
		a.href = url
		a.download = `zoo-usage-${range}.csv`
		a.click()
		URL.revokeObjectURL(url)
	}

	return (
		<div className={cn("flex flex-col", className)} {...props}>
			<SectionHeader description={t("settings:usage.description")}>{t("settings:sections.usage")}</SectionHeader>

			<Section>
				<div className="flex flex-col gap-5">
					<ProviderLimits />

					<section className="flex flex-col gap-3">
						<div className="flex items-center justify-between gap-2">
							<SectionTitle>{t("settings:usage.history")}</SectionTitle>
							{!isEmpty && (
								<button
									type="button"
									className="flex items-center gap-1 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground bg-transparent cursor-pointer"
									onClick={handleExport}
									data-testid="usage-export-csv">
									<Download className="size-3.5" />
									{t("settings:usage.exportCsv")}
								</button>
							)}
						</div>

						{/* Filters */}
						<SearchableSetting
							settingId="usage-filters"
							section="usage"
							label={t("settings:usage.range.label")}>
							<div className="flex flex-wrap items-center gap-2">
								<div
									className="inline-flex rounded-md border border-vscode-input-border overflow-hidden"
									role="radiogroup"
									aria-label={t("settings:usage.range.label")}>
									{USAGE_RANGES.map((r) => (
										<button
											key={r}
											type="button"
											role="radio"
											aria-checked={r === range}
											onClick={() => setRange(r)}
											data-testid={`usage-range-${r}`}
											className={cn(
												"px-2.5 py-1 text-xs border-r border-vscode-input-border last:border-r-0 cursor-pointer",
												r === range
													? "bg-vscode-button-background text-vscode-button-foreground"
													: "bg-vscode-input-background text-vscode-foreground hover:bg-vscode-list-hoverBackground",
											)}>
											{t(`settings:usage.range.${r}`)}
										</button>
									))}
								</div>
								<Select value={scope} onValueChange={(v) => setScope(v as "workspace" | "all")}>
									<SelectTrigger
										className="h-7 w-auto min-w-36 text-xs"
										data-testid="usage-scope-select">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="workspace">{t("settings:usage.scope.workspace")}</SelectItem>
										<SelectItem value="all">{t("settings:usage.scope.all")}</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</SearchableSetting>

						{isEmpty ? (
							<div
								className="rounded-md border border-dashed border-vscode-panel-border px-3 py-6 text-center text-sm text-vscode-descriptionForeground"
								data-testid="usage-empty">
								{t("settings:usage.empty")}
							</div>
						) : (
							<>
								{/* Three compact stat cards, as in the design mock */}
								<div className="grid grid-cols-3 gap-2" data-testid="usage-stats">
									{metric === "cost" ? (
										<Stat
											value={formatCost(summary.totalCost)}
											label={t("settings:usage.stats.cost")}
										/>
									) : (
										<Stat
											value={formatLargeNumber(summary.totalTokens)}
											label={t("settings:usage.stats.tokens")}
											hint={t("settings:usage.stats.inOut", {
												input: formatLargeNumber(summary.tokensIn),
												output: formatLargeNumber(summary.tokensOut),
											})}
										/>
									)}
									{metric === "cost" ? (
										<Stat
											value={formatLargeNumber(summary.totalTokens)}
											label={t("settings:usage.stats.tokens")}
											hint={
												summary.cacheReads > 0
													? t("settings:usage.stats.cacheHit", {
															percent: Math.round(summary.cacheHitRate * 100),
														})
													: undefined
											}
										/>
									) : (
										<Stat
											value={String(
												summary.byModel.filter((m) => m.key !== UNRECORDED).length || "–",
											)}
											label={t("settings:usage.stats.models")}
										/>
									)}
									<Stat value={String(summary.taskCount)} label={t("settings:usage.stats.tasks")} />
								</div>

								{metric === "tokens" && (
									<p
										className="m-0 text-xs text-vscode-descriptionForeground"
										data-testid="usage-no-pricing-note">
										{t("settings:usage.noPricingNote")}
									</p>
								)}

								{summary.daily.length > 1 && (
									<Block
										title={
											metric === "cost"
												? t("settings:usage.dailyCost")
												: t("settings:usage.dailyTokens")
										}>
										<div
											className="flex items-end gap-1 h-16"
											role="img"
											aria-label={t("settings:usage.chartLabel", {
												metric:
													metric === "cost"
														? t("settings:usage.dailyCost")
														: t("settings:usage.dailyTokens"),
												total: fmt(summary.totalCost, summary.totalTokens),
											})}
											data-testid="usage-daily-chart">
											{summary.daily.map((d) => {
												const v = value(d.cost, d.tokens)
												return (
													<div
														key={d.day}
														className={cn(
															"flex-1 rounded-sm",
															v > 0
																? "bg-vscode-charts-blue"
																: "bg-vscode-input-background",
														)}
														style={{
															height:
																maxDaily > 0 && v > 0
																	? `${Math.max(6, (v / maxDaily) * 100)}%`
																	: "2px",
														}}
														title={`${new Date(d.day).toLocaleDateString()} · ${fmt(d.cost, d.tokens)}`}
													/>
												)
											})}
										</div>
										{showDayLabels && (
											<div className="flex gap-1 mt-1 text-[10px] text-vscode-descriptionForeground">
												{summary.daily.map((d) => (
													<span key={d.day} className="flex-1 text-center">
														{summary.daily.length <= 7
															? WEEKDAY_FMT.format(d.day)
															: DAY_FMT.format(d.day)}
													</span>
												))}
											</div>
										)}
									</Block>
								)}

								<Breakdown
									title={t("settings:usage.byProvider")}
									rows={summary.byProvider.map((b) => ({
										key: b.key,
										name: providerName(b.key),
										...bucketRow(b),
									}))}
									testId="usage-by-provider"
								/>
								<Breakdown
									title={t("settings:usage.byModel")}
									rows={summary.byModel.map((b) => ({
										key: b.key,
										name: modelIdFromKey(b.key) ?? t("settings:usage.notRecorded"),
										subtitle: b.apiProvider ? providerLabel(b.apiProvider) : undefined,
										...bucketRow(b),
									}))}
									testId="usage-by-model"
								/>
								<p
									className="m-0 text-xs text-vscode-descriptionForeground"
									data-testid="usage-by-mode">
									<span className="font-medium">{t("settings:usage.byMode")}:</span>{" "}
									{summary.byMode.map((m) => `${m.key} ${bucketRow(m).label}`).join(" · ")}
								</p>

								<Block
									title={
										metric === "cost"
											? t("settings:usage.topTasks")
											: t("settings:usage.topTasksTokens")
									}
									testId="usage-top-tasks">
									<div className="rounded-md border border-vscode-panel-border divide-y divide-vscode-panel-border overflow-hidden">
										{summary.topTasks.map((task) => (
											<button
												key={task.id}
												type="button"
												className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm bg-transparent hover:bg-vscode-list-hoverBackground cursor-pointer"
												onClick={() =>
													vscode.postMessage({ type: "showTaskWithId", text: task.id })
												}>
												<span className="min-w-0">
													<span className="block break-words">{task.task}</span>
													{primaryUsage(task) && (
														<span className="block break-words text-xs text-vscode-descriptionForeground">
															{[
																primaryUsage(task)?.apiProvider
																	? providerLabel(primaryUsage(task)!.apiProvider!)
																	: undefined,
																primaryUsage(task)?.modelId,
															]
																.filter(Boolean)
																.join(" · ")}
														</span>
													)}
												</span>
												<span className="shrink-0 flex items-baseline gap-1.5 whitespace-nowrap">
													<span className="font-medium tabular-nums">
														{metric === "cost" && !(task.totalCost > 0)
															? `${formatLargeNumber((task.tokensIn || 0) + (task.tokensOut || 0))} ${t("settings:usage.tokensShort")}`
															: fmt(
																	task.totalCost || 0,
																	(task.tokensIn || 0) + (task.tokensOut || 0),
																)}
													</span>
													<span className="text-xs text-vscode-descriptionForeground">
														{formatTimeAgo(task.ts)}
													</span>
												</span>
											</button>
										))}
									</div>
								</Block>

								<p className="m-0 text-[11px] text-vscode-descriptionForeground">
									{t("settings:usage.disclaimer")}
								</p>
							</>
						)}
					</section>
				</div>
			</Section>
		</div>
	)
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
	<h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground">{children}</h4>
)

const Block = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
	<div className="flex flex-col gap-2" data-testid={testId}>
		<div className="text-xs font-medium text-vscode-descriptionForeground">{title}</div>
		{children}
	</div>
)

const Stat = ({ value, label, hint }: { value: string; label: string; hint?: string }) => (
	<div className="min-w-0 rounded-md border border-vscode-panel-border bg-vscode-input-background px-2.5 py-2">
		<div className="text-lg font-semibold leading-tight text-vscode-foreground tabular-nums break-words">
			{value}
		</div>
		<div className="text-[11px] text-vscode-descriptionForeground">{label}</div>
		{hint && <div className="mt-0.5 text-[11px] text-vscode-descriptionForeground break-words">{hint}</div>}
	</div>
)

const Breakdown = ({
	title,
	rows,
	testId,
}: {
	title: string
	rows: { key: string; name: string; subtitle?: string; label: string; percent: number; unpriced?: boolean }[]
	testId: string
}) => (
	<Block title={title} testId={testId}>
		<div className="flex flex-col gap-1.5">
			{rows.slice(0, 5).map((row, i) => {
				const pct = row.percent
				const color = row.unpriced ? "var(--vscode-descriptionForeground)" : PALETTE[i % PALETTE.length]
				return (
					<div
						key={row.key}
						className="grid grid-cols-[8px_minmax(0,1fr)_auto_minmax(40px,25%)_30px] items-center gap-2 text-xs"
						title={row.subtitle ? `${row.name} · ${row.subtitle}` : row.name}>
						<span className="size-2 rounded-full" style={{ background: color }} />
						<span className="min-w-0 break-words text-sm">
							{row.name}
							{row.subtitle && (
								<span className="ml-1.5 text-vscode-descriptionForeground text-xs">{row.subtitle}</span>
							)}
						</span>
						<span
							className={cn("tabular-nums text-sm", row.unpriced && "text-vscode-descriptionForeground")}
							data-testid={row.unpriced ? "usage-unpriced" : undefined}>
							{row.label}
						</span>
						<span className="h-1 rounded-full bg-vscode-input-background overflow-hidden">
							<span
								className="block h-full rounded-full"
								style={{ width: `${pct}%`, background: color }}
							/>
						</span>
						<span className="text-right tabular-nums text-vscode-descriptionForeground">
							{row.unpriced ? "–" : `${pct}%`}
						</span>
					</div>
				)
			})}
		</div>
	</Block>
)
