/* v8 ignore file -- Playwright component visual test. */
import {
	providerIdentifiers,
	type DashboardTaskStatsSnapshot,
	type StatsBucket,
	type StatsQuery,
} from "@roo-code/types"

import { expect, test } from "../../../../playwright/coverage-fixture"

// Regression/visual coverage for the full Dashboard view: header controls,
// summary cards, heatmap, cache-ratio input, breakdown table, and task list.
//
// The dashboard is stream-driven: `useDashboardStatsStream` posts
// `subscribeDashboardStats` via `vscode.postMessage`. In the Playwright gallery
// the page's inline `acquireVsCodeApi` stub exists, so posts are captured into
// `window.__vscodeMessages` (see playwright/gallery/index.html). After mount
// the test reads the subscription message from that buffer and replays a full
// snapshot with the matching requestId so the reducer's stale-epoch check
// passes and real data renders (not the loading/empty state).
//
// NOTE: the mounted component (`DashboardViewFixture`) lives in
// playwright/gallery/stories.tsx ("dashboard-view" story), which wires the
// fixture from the sibling `.visual.fixture.tsx` module. The
// `makeFixtureSnapshot` data builder lives HERE, not in the fixture module —
// exporting a non-component helper alongside the component caused the CT Vite
// pipeline to instantiate the fixture module twice, producing
// `SyntaxError: Identifier 'DashboardViewFixture' has already been declared`
// at collection time.

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

const FIXED_EPOCH = new Date("2026-05-15T12:00:00.000Z").getTime()
const now = FIXED_EPOCH

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
function makeFixtureSnapshot(requestId: string): DashboardTaskStatsSnapshot {
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
					provider: providerIdentifiers.anthropic,
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
					provider: providerIdentifiers.openai,
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
					provider: providerIdentifiers.anthropic,
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

test("renders the dashboard with summary, heatmap, breakdown, and tasks in the VS Code dark theme", async ({
	mount,
	page,
}) => {
	await page.clock.install({ time: FIXED_EPOCH })

	const component = await mount("dashboard-view")

	// Wait for the subscription post to land in the gallery's vscode message
	// capture (`window.__vscodeMessages`, populated by the inline
	// `acquireVsCodeApi` stub in playwright/gallery/index.html), then read the
	// requestId.
	const subscription = await page
		.waitForFunction(() => {
			const messages = window.__vscodeMessages
			const first = messages?.find((message) => message.type === "subscribeDashboardStats")
			return first ?? undefined
		})
		.then((handle) => handle.jsonValue())

	// `waitForFunction` only resolves once a matching message exists, so the
	// subscription payload is non-null here; the type simply hasn't narrowed.
	const subscriptionMessage = subscription as { dashboardStatsSubscription?: { requestId?: string } } | undefined
	const requestId = subscriptionMessage?.dashboardStatsSubscription?.requestId
	expect(requestId).toBeDefined()

	// The stream hook reads `message.dashboardStatsStreamSnapshot` (and checks
	// `message.type === "dashboardStatsStreamSnapshot"`), so the snapshot must
	// be dispatched inside the standard extension message envelope.
	await page.evaluate((snapshot) => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "dashboardStatsStreamSnapshot", dashboardStatsStreamSnapshot: snapshot },
			}),
		)
	}, makeFixtureSnapshot(requestId!))

	// Data must render: summary cards, heatmap cells, breakdown table rows,
	// and task rows are all present (not the loading/empty state).
	await expect(component.getByTestId("dashboard-summary")).toBeVisible()
	await expect(component.getByTestId("usage-heatmap")).toBeVisible()
	await expect(component.getByTestId("dashboard-breakdown")).toBeVisible()
	await expect(component.getByTestId("dashboard-task-row").first()).toBeVisible()

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	await expect(component).toHaveScreenshot("dashboard-view-dark.png")
})
