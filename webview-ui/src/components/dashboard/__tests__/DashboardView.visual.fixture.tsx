/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import enDashboard from "@/i18n/locales/en/dashboard.json" with { type: "json" }
import enStats from "@/i18n/locales/en/stats.json" with { type: "json" }

import DashboardView from "../DashboardView"

// NOTE: this module intentionally exports ONLY the mounted component
// (`DashboardViewFixture`). The `makeFixtureSnapshot` data builder used to live
// here too, but exporting a non-component helper alongside the component made
// the Playwright CT Vite pipeline instantiate this module twice at collection
// time, surfacing as `SyntaxError: Identifier 'DashboardViewFixture' has
// already been declared`. The data builder now lives in the test file, matching
// the TaskList fixture pattern (component-only export).

// ── Translations ─────────────────────────────────────────────────────────────
// The dashboard components read `useAppTranslation()` from BOTH the real
// `@/i18n/TranslationContext` (DashboardView/DashboardSummary/UsageHeatmap) and
// the Playwright stub `@src/i18n/TranslationContext` (TaskList). Mirror the
// OpenAICompatible fixture: load the real English locale files, flatten them,
// and wrap with both providers so every component renders real labels.
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

const translations: Record<string, string> = {
	...flattenTranslations(enDashboard as Record<string, unknown>, "dashboard:"),
	...flattenTranslations(enStats as Record<string, unknown>, "stats:"),
}

const t = (key: string) => translations[key] ?? key

const translationContextValue = {
	t,
	i18n: null as unknown as typeof import("../../../i18n/setup").default,
}

// ── Fixture ──────────────────────────────────────────────────────────────────

/**
 * Mounts the full `DashboardView` inside the providers it requires:
 * - `ExtensionStateContextProvider` — `TabContent` calls `useExtensionState()`
 *   which throws outside a provider.
 * - Both `PlaywrightTranslationContext` (stub used by TaskList) and
 *   `AppTranslationContext` (real one used by DashboardView and its siblings)
 *   with real English locale labels.
 *
 * Data is delivered via a stream snapshot dispatched by the test after mount:
 * the stream hook captures the `requestId` it posts in `subscribeDashboardStats`
 * and rejects snapshots whose `requestId` does not match (stale-epoch check).
 */
export function DashboardViewFixture() {
	return (
		<ExtensionStateContextProvider>
			<PlaywrightTranslationContext.Provider value={translationContextValue}>
				<AppTranslationContext.Provider value={translationContextValue}>
					<div className="w-[520px] h-[360px] bg-vscode-editor-background text-vscode-foreground overflow-hidden">
						<DashboardView onDone={() => {}} />
					</div>
				</AppTranslationContext.Provider>
			</PlaywrightTranslationContext.Provider>
		</ExtensionStateContextProvider>
	)
}
