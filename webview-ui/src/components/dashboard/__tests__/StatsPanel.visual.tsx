import React from "react"

import type { StatsBucket } from "@roo-code/types"

import { expect, test } from "../../../../playwright/coverage-fixture"

import DashboardSummary from "../DashboardSummary"
import UsageHeatmap from "../../stats/UsageHeatmap"

// Visual regression tests for the usage-stats dashboard panels (PR #1134).
// These run in a real browser via Playwright CT and capture screenshots with
// `toHaveScreenshot` so that chart/table layout regressions are caught by CI.

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

// ── Summary cards (overview) ────────────────────────────────────────────────

test("renders summary overview cards with stable layout", async ({ mount }) => {
	const component = await mount(
		<div style={{ width: 480, padding: 8 }}>
			<DashboardSummary totals={makeBucket()} />
		</div>,
	)

	await expect(component.getByTestId("dashboard-summary")).toBeVisible()

	// Wait for the animated counters to settle before snapshotting.
	// `formatCompact(1_857_400)` yields a string like "1.9M"; assert on the
	// non-animated cost card (always rendered synchronously) instead.
	await expect(component.locator("text=$12.35")).toBeVisible()

	await expect(component).toHaveScreenshot("stats-summary-overview.png", { maxDiffPixels: 10000 })
})

// ── Daily heatmap (chart) ───────────────────────────────────────────────────

test("renders daily activity heatmap for the 30d range", async ({ mount }) => {
	// Oldest-first values, one per day, deterministic for stable snapshots.
	const values = Array.from({ length: 30 }, (_, i) => ((i * 7919) % 50_000) + (i % 7 === 0 ? 0 : 500))

	const component = await mount(
		<div style={{ width: 480, padding: 8 }}>
			<UsageHeatmap values={values} rangeDays={30} selectedRange="30d" onRangeChange={() => {}} />
		</div>,
	)

	await expect(component.getByTestId("usage-heatmap")).toBeVisible()
	await expect(component.getByTestId("heatmap-range-30d")).toBeVisible()

	await expect(component).toHaveScreenshot("stats-daily-chart.png", { maxDiffPixels: 10000 })
})

// ── Provider breakdown ──────────────────────────────────────────────────────

function ProviderBreakdownFixture() {
	const providers = [
		{ name: "anthropic", bucket: makeBucket({ totalTokens: 980_000, costUsd: 7.21 }) },
		{ name: "openai", bucket: makeBucket({ totalTokens: 640_000, costUsd: 4.02 }) },
		{ name: "google", bucket: makeBucket({ totalTokens: 237_400, costUsd: 1.11 }) },
	]

	return (
		<div style={{ width: 480, padding: 8 }} data-testid="provider-breakdown">
			<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
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

test("renders provider breakdown table with stable layout", async ({ mount }) => {
	const component = await mount(<ProviderBreakdownFixture />)

	await expect(component.getByTestId("provider-breakdown")).toBeVisible()
	await expect(component.getByTestId("provider-row")).toHaveCount(3)

	await expect(component).toHaveScreenshot("stats-provider-breakdown.png", { maxDiffPixels: 10000 })
})
