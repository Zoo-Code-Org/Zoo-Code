/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import enStats from "@/i18n/locales/en/stats.json" with { type: "json" }

import { TooltipProvider } from "@/components/ui/tooltip"

import UsageHeatmap from "../UsageHeatmap"

// NOTE: this module intentionally exports ONLY the mounted component. Defining
// the translation helpers in the same file as the visual test (which also
// imports the component under test) makes the Playwright CT Vite pipeline
// instantiate `@/i18n/TranslationContext` twice, so the component reads a
// different `TranslationContext` instance than the provider supplies and the
// labels render empty. Keeping the provider wiring here — in the same module
// graph that imports `UsageHeatmap` — guarantees a single shared context.
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

/**
 * Mounts `UsageHeatmap` with the real English stats labels and a
 * `TooltipProvider` (its day cells throw without one).
 */
export function UsageHeatmapFixture() {
	return (
		<PlaywrightTranslationContext.Provider value={translationContextValue}>
			<AppTranslationContext.Provider value={translationContextValue}>
				<TooltipProvider>
					<div className="w-[520px] bg-vscode-editor-background p-4 text-vscode-foreground">
						<UsageHeatmap values={values} rangeDays={60} selectedRange="60d" onRangeChange={() => {}} />
					</div>
				</TooltipProvider>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>
	)
}
