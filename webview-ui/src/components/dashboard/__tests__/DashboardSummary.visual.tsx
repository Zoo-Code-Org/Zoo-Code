/* v8 ignore file -- Playwright component visual test. */
import React from "react"

import type { StatsBucket } from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import enDashboard from "@/i18n/locales/en/dashboard.json" with { type: "json" }

import { expect, test } from "../../../../playwright/coverage-fixture"

import DashboardSummary from "../DashboardSummary"

function flattenTranslations(obj: Record<string, unknown>, prefix: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = `${prefix}${key}`
		if (typeof value === "string") {
			result[fullKey] = value
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			Object.assign(result, flattenTranslations(value as Record<string, unknown>, `${fullKey}.`))
		}
	}
	return result
}

const translations: Record<string, string> = flattenTranslations(
	enDashboard as Record<string, unknown>,
	"dashboard:",
)

const translationContextValue = {
	t: (key: string) => translations[key] ?? key,
	i18n: null as unknown as typeof import("../../../i18n/setup").default,
}

const totals: StatsBucket = {
	key: {},
	events: 128,
	completedCalls: 100,
	failedCalls: 20,
	cancelledCalls: 8,
	inputTokens: 1_234_567,
	outputTokens: 456_789,
	cacheReadTokens: 890_123,
	cacheWriteTokens: 45_678,
	reasoningTokens: 12_345,
	totalTokens: 2_640_502,
	costUsd: 12.3456,
	unknownEventCount: 0,
}

// Visual coverage for the summary card grid (tokens, cache, cost). The cards
// use `AnimatedNumber`, which snaps to the target value on first render when
// reduced motion is active (Playwright CT runs with reduced motion), so the
// screenshot shows the final formatted values.
test("renders the summary cards with token and cost totals in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(
		<PlaywrightTranslationContext.Provider value={translationContextValue}>
			<AppTranslationContext.Provider value={translationContextValue}>
				<div className="w-[520px] bg-vscode-editor-background p-4 text-vscode-foreground">
					<DashboardSummary totals={totals} />
				</div>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>,
	)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	// All five summary cards must render with their labels.
	await expect(component.getByTestId("dashboard-summary")).toBeVisible()
	await expect(component.getByText("Total tokens")).toBeVisible()
	await expect(component.getByText("Input tokens")).toBeVisible()
	await expect(component.getByText("Output tokens")).toBeVisible()
	await expect(component.getByText("Cache tokens")).toBeVisible()
	await expect(component.getByText("Cost")).toBeVisible()

	await expect(component).toHaveScreenshot("dashboard-summary-dark.png")
})
