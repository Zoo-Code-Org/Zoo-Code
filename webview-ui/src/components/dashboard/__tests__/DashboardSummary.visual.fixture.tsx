/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import type { StatsBucket } from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import enDashboard from "@/i18n/locales/en/dashboard.json" with { type: "json" }

import { TooltipProvider } from "@/components/ui/tooltip"

import DashboardSummary from "../DashboardSummary"

// NOTE: this module intentionally exports ONLY the mounted component. Defining
// the translation helpers in the same file as the visual test (which also
// imports the component under test) makes the Playwright CT Vite pipeline
// instantiate `@/i18n/TranslationContext` twice, so the component reads a
// different `TranslationContext` instance than the provider supplies and the
// labels render empty. Keeping the provider wiring here — in the same module
// graph that imports `DashboardSummary` — guarantees a single shared context.
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

const translations: Record<string, string> = flattenTranslations(enDashboard as Record<string, unknown>, "dashboard:")

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

/**
 * Mounts `DashboardSummary` with the real English dashboard labels and a
 * `TooltipProvider` (its `StandardTooltip` cards throw without one).
 */
export function DashboardSummaryFixture() {
	return (
		<PlaywrightTranslationContext.Provider value={translationContextValue}>
			<AppTranslationContext.Provider value={translationContextValue}>
				<TooltipProvider>
					<div className="w-[520px] bg-vscode-editor-background p-4 text-vscode-foreground">
						<DashboardSummary totals={totals} />
					</div>
				</TooltipProvider>
			</AppTranslationContext.Provider>
		</PlaywrightTranslationContext.Provider>
	)
}
