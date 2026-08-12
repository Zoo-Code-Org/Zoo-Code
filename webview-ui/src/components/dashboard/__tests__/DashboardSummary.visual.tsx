/* v8 ignore file -- Playwright component visual test. */
import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"

import { DashboardSummaryFixture } from "./DashboardSummary.visual.fixture"

// Visual coverage for the summary card grid (tokens, cache, cost). The cards
// use `AnimatedNumber`, which snaps to the target value on first render when
// reduced motion is active (Playwright CT runs with reduced motion), so the
// screenshot shows the final formatted values.
test("renders the summary cards with token and cost totals in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(<DashboardSummaryFixture />)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	// All five summary cards must render with their labels (exact casing from
	// src/i18n/locales/en/dashboard.json).
	await expect(component.getByTestId("dashboard-summary")).toBeVisible()
	await expect(component.getByText("Total Tokens")).toBeVisible()
	await expect(component.getByText("Input Tokens")).toBeVisible()
	await expect(component.getByText("Output Tokens")).toBeVisible()
	await expect(component.getByText("Cache Tokens")).toBeVisible()
	await expect(component.getByText("Cost")).toBeVisible()

	await expect(component).toHaveScreenshot("dashboard-summary-dark.png")
})
