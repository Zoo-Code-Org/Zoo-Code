import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"

import { DailyHeatmapFixture, ProviderBreakdownFixture, SummaryOverviewFixture } from "./StatsPanel.visual.fixture"

// Visual regression tests for the usage-stats dashboard panels (PR #1134).
// These run in a real browser via Playwright CT and capture screenshots with
// `toHaveScreenshot` so that chart/table layout regressions are caught by CI.
//
// Fixtures live in StatsPanel.visual.fixture.tsx because Playwright CT cannot
// mount components defined inline in the test file.

test("renders summary overview cards with stable layout", async ({ mount }) => {
	const component = await mount(<SummaryOverviewFixture />)

	await expect(component.getByTestId("dashboard-summary")).toBeVisible()

	// Wait for the animated counters to settle before snapshotting.
	// `formatCompact(1_857_400)` yields a string like "1.9M"; assert on the
	// non-animated cost card (always rendered synchronously) instead.
	await expect(component.locator("text=$12.35")).toBeVisible()

	await expect(component).toHaveScreenshot("stats-summary-overview.png", { maxDiffPixels: 10000 })
})

test("renders daily activity heatmap for the 30d range", async ({ mount }) => {
	const component = await mount(<DailyHeatmapFixture />)

	await expect(component.getByTestId("usage-heatmap")).toBeVisible()
	await expect(component.getByTestId("heatmap-range-30d")).toBeVisible()

	await expect(component).toHaveScreenshot("stats-daily-chart.png", { maxDiffPixels: 10000 })
})

test("renders provider breakdown table with stable layout", async ({ mount }) => {
	const component = await mount(<ProviderBreakdownFixture />)

	await expect(component.getByTestId("provider-breakdown")).toBeVisible()
	await expect(component.getByTestId("provider-row")).toHaveCount(3)

	await expect(component).toHaveScreenshot("stats-provider-breakdown.png", { maxDiffPixels: 10000 })
})
