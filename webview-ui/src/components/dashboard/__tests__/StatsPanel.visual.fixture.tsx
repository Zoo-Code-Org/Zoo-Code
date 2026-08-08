import React from "react"

import type { StatsBucket } from "@roo-code/types"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@/components/ui/tooltip"

import DashboardSummary from "../DashboardSummary"
import UsageHeatmap from "../../stats/UsageHeatmap"

// Fixture for the visual regression tests in StatsPanel.visual.tsx.
// Playwright CT cannot mount components defined inline in the test file,
// so we export fixture components that wrap the real components with the
// TranslationContext.Provider (the CT bundle aliases TranslationContext
// to a minimal mock at webview-ui/playwright/TranslationContext.ts).

function makeBucket(overrides: Partial<StatsBucket> = {}): StatsBucket {
	return {
		key: {},
		events: 120,
		completedCalls: 100,
		failedCalls: 12,
		cancelledCalls: 8,
		inputTokens: 1_245_000,
		outputTokens: 612_400,
		cacheReadTokens: 84_200,
		cacheWriteTokens: 41_800,
		reasoningTokens: 15_300,
		totalTokens: 1_857_400,
		costUsd: 12.345678,
		unknownEventCount: 0,
		...overrides,
	}
}

const translations: Record<string, string> = {
	"dashboard:summary.totalTokens": "Total Tokens",
	"dashboard:summary.inputTokens": "Input Tokens",
	"dashboard:summary.outputTokens": "Output Tokens",
	"dashboard:summary.cacheTokens": "Cache Tokens",
	"dashboard:summary.cost": "Cost",
	"stats:heatmap.title": "Daily Activity",
	"stats:heatmap.30d": "30 Days",
	"stats:heatmap.60d": "60 Days",
	"stats:heatmap.120d": "120 Days",
	"stats:heatmap.360d": "360 Days",
	"stats:heatmap.less": "Less",
	"stats:heatmap.more": "More",
	"stats:heatmap.noData": "No data",
	"stats:heatmap.loading": "Loading...",
}

const t = (key: string) => translations[key] ?? key

const TranslationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<TranslationContext.Provider value={{ t, i18n: null as unknown as typeof import("../../../i18n/setup").default }}>
		<TooltipProvider>{children}</TooltipProvider>
	</TranslationContext.Provider>
)

// ── Summary cards (overview) ────────────────────────────────────────────────

export const SummaryOverviewFixture = () => (
	<TranslationProvider>
		<div style={{ width: 480, padding: 8 }}>
			<DashboardSummary totals={makeBucket()} />
		</div>
	</TranslationProvider>
)

// ── Daily heatmap (chart) ───────────────────────────────────────────────────

export const DailyHeatmapFixture = () => {
	// Oldest-first values, one per day, deterministic for stable snapshots.
	const values = Array.from({ length: 30 }, (_, i) => ((i * 7919) % 50_000) + (i % 7 === 0 ? 0 : 500))

	return (
		<TranslationProvider>
			<div style={{ width: 480, padding: 8 }}>
				<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={() => {}} />
			</div>
		</TranslationProvider>
	)
}

// ── Provider breakdown ──────────────────────────────────────────────────────

export const ProviderBreakdownFixture = () => {
	const providers = [
		{ name: "anthropic", bucket: makeBucket({ totalTokens: 980_000, costUsd: 7.21 }) },
		{ name: "openai", bucket: makeBucket({ totalTokens: 640_000, costUsd: 4.02 }) },
		{ name: "google", bucket: makeBucket({ totalTokens: 237_400, costUsd: 1.11 }) },
	]

	return (
		<div style={{ width: 480, padding: 8 }}>
			<table data-testid="provider-breakdown" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
				<thead>
					<tr style={{ textAlign: "left", opacity: 0.7 }}>
						<th style={{ padding: "4px 8px" }}>Provider</th>
						<th style={{ padding: "4px 8px" }}>Tokens</th>
						<th style={{ padding: "4px 8px" }}>Cost</th>
					</tr>
				</thead>
				<tbody>
					{providers.map((p) => (
						<tr key={p.name} data-testid="provider-row">
							<td style={{ padding: "4px 8px" }}>{p.name}</td>
							<td style={{ padding: "4px 8px" }}>{p.bucket.totalTokens.toLocaleString()}</td>
							<td style={{ padding: "4px 8px" }}>${p.bucket.costUsd.toFixed(2)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
