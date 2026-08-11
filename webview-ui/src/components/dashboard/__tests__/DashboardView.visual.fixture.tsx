/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import type {
	DashboardTaskStatsSnapshot,
	StatsBucket,
	StatsQuery,
} from "@roo-code/types"

import { TranslationContext as AppTranslationContext } from "@/i18n/TranslationContext"
import { TranslationContext as PlaywrightTranslationContext } from "@src/i18n/TranslationContext"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import enDashboard from "@/i18n/locales/en/dashboard.json" with { type: "json" }
import enStats from "@/i18n/locales/en/stats.json" with { type: "json" }

import DashboardView from "../DashboardView"

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

// ── Mock data ────────────────────────────────────────────────────────────────

function makeBucket(overrides: Partial<StatsBucket> = {}): StatsBucket {
	return {
		key: {},
		events: 10,
		completedCalls: 8,
		failedCalls: 1,
		cancelledCalls: 1,
		inputTokens: 5000,
		outputTokens: 2500,
		cacheReadTokens: 1000,
		cacheWriteTokens: 500,
		reasoningTokens: 200,
		totalTokens: 7500,
		costUsd: 0.15,
		unknownEventCount: 0,
		...overrides,
	}
}

const now = Date.now()

// 30 days of heatmap activity, oldest first, with a rising wave and lighter
// weekends so the heatmap shows multiple intensity levels instead of a flat row.
const heatmapValues: number[] = Array.from({ length: 30 }, (_, i) => {
	const wave = Math.sin(i / 3.5) * 0.5 + 0.5
	const weekend = i % 7 === 0 || i % 7 === 6 ? 0.25 : 1
	return Math.round(800 + 9000 * wave * weekend)
})

// Build a full `DashboardTaskStatsSnapshot` matching the shape the stream hook
// expects. `requestId` must equal the subscription requestId the hook posts in
// `subscribeDashboardStats` so the stale-epoch check passes.
export function makeFixtureSnapshot(requestId: string): DashboardTaskStatsSnapshot {
	return {
		requestId,
		generation: 1,
		sequence: 10,
		stats: {
			query: {
				preset: "today",
				timezone: "UTC",
				groupBy: ["model"],
				includeCancelled: false,
				cacheRatio: 0.94,
			} satisfies StatsQuery,
			generatedAt: new Date(now).toISOString(),
			buckets: [
				makeBucket({
					key: { model: "claude-sonnet-4-20250514" },
					events: 6,
					totalTokens: 5000,
					inputTokens: 3500,
					outputTokens: 1500,
					cacheReadTokens: 800,
					cacheWriteTokens: 400,
					reasoningTokens: 150,
					costUsd: 0.1,
				}),
				makeBucket({
					key: { model: "gpt-4o" },
					events: 4,
					totalTokens: 2500,
					inputTokens: 1500,
					outputTokens: 1000,
					cacheReadTokens: 200,
					cacheWriteTokens: 100,
					reasoningTokens: 50,
					costUsd: 0.05,
				}),
			],
			totals: makeBucket({
				events: 10,
				totalTokens: 7500,
				inputTokens: 5000,
				outputTokens: 2500,
				costUsd: 0.15,
			}),
			coverage: {
				firstEventAt: new Date(now - 3 * 86_400_000).toISOString(),
				lastEventAt: new Date(now).toISOString(),
				recordingPaused: false,
				backfilledEventCount: 2,
			},
		},
		tasks: {
			requestId,
			catalogRevision: 1,
			tasks: [
				{
					taskId: "task-1",
					rootTaskId: "task-1",
					title: "Implement OAuth refresh flow",
					taskTimestamp: now - 30 * 60_000,
					lastUsageAt: now - 5 * 60_000,
					totalCost: 0.08,
					totalTokens: 4000,
					inputTokens: 2800,
					outputTokens: 1200,
					model: "claude-sonnet-4-20250514",
					provider: "anthropic",
					models: ["claude-sonnet-4-20250514"],
					modes: ["code"],
					eventCount: 4,
					childTaskIds: [],
				},
				{
					taskId: "task-2",
					rootTaskId: "task-2",
					title: "Fix cache ratio bug",
					taskTimestamp: now - 2 * 3_600_000,
					lastUsageAt: now - 30 * 60_000,
					totalCost: 0.04,
					totalTokens: 2000,
					inputTokens: 1400,
					outputTokens: 600,
					model: "gpt-4o",
					provider: "openai",
					models: ["gpt-4o"],
					modes: ["debug"],
					eventCount: 3,
					childTaskIds: [],
				},
				{
					taskId: "task-3",
					rootTaskId: "task-3",
					title: "Translate dashboard strings",
					taskTimestamp: now - 3 * 3_600_000,
					lastUsageAt: now - 2 * 3_600_000,
					totalCost: 0.03,
					totalTokens: 1500,
					inputTokens: 800,
					outputTokens: 700,
					model: "claude-sonnet-4-20250514",
					provider: "anthropic",
					models: ["claude-sonnet-4-20250514"],
					modes: ["translate"],
					eventCount: 3,
					childTaskIds: [],
				},
			],
			childTasks: [],
			cursor: undefined,
			totalEstimate: 3,
		},
		heatmap: {
			rangeDays: 30,
			values: heatmapValues,
		},
	}
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
