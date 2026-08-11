/* v8 ignore file -- Playwright component visual test. */
import React from "react"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import enStats from "@/i18n/locales/en/stats.json" with { type: "json" }

import { expect, test } from "../../../../playwright/coverage-fixture"

import UsageHeatmap from "../UsageHeatmap"

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

const translations: Record<string, string> = flattenTranslations(enStats as Record<string, unknown>, "stats:")

const translationContextValue = {
	t: (key: string) => translations[key] ?? key,
	i18n: null as unknown as typeof import("../../../i18n/setup").default,
}

// 60 days of activity, oldest first. A sine wave with weekend dips produces
// all five intensity levels (1–5) plus empty days (level 0) so the heatmap
// colors are meaningfully exercised.
const values: number[] = Array.from({ length: 60 }, (_, i) => {
	const wave = Math.sin(i / 4) * 0.5 + 0.5
	const weekend = i % 7 === 0 || i % 7 === 6 ? 0.2 : 1
	return Math.round(500 + 10_000 * wave * weekend)
})

// Visual coverage for the GitHub-style activity heatmap with the 60-day range
// active. A non-empty `values` array guarantees the grid + legend render
// instead of the "no activity" empty state.
test("renders the 60-day usage heatmap in the VS Code dark theme", async ({ mount }) => {
	const component = await mount(
		<PlaywrightTranslationContext.Provider value={translationContextValue}>
			<AppTranslationContext.Provider value={translationContextValue}>
				<div className="w-[520px] bg-vscode-editor-background p-4 text-vscode-foreground">
					<UsageHeatmap values={values} rangeDays={60} selectedRange="60d" onRangeChange={() => {}} />
				</div>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>,
	)

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	// The heatmap grid must render (not the "no activity" empty state).
	await expect(component.getByRole("img", { name: "Daily Activity" })).toBeVisible()

	await expect(component).toHaveScreenshot("usage-heatmap-dark.png")
})
