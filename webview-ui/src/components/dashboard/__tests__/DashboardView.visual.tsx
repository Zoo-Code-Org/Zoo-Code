/* v8 ignore file -- Playwright component visual test. */
import React from "react"

import { expect, test } from "../../../../playwright/coverage-fixture"

import { DashboardViewFixture, makeFixtureSnapshot } from "./DashboardView.visual.fixture"

// Regression/visual coverage for the full Dashboard view: header controls,
// summary cards, heatmap, cache-ratio input, breakdown table, and task list.
//
// The dashboard is stream-driven: `useDashboardStatsStream` posts
// `subscribeDashboardStats` via `vscode.postMessage`. Under Playwright CT the
// vscode alias is `src/__mocks__/vscode.js` and `acquireVsCodeApi` is absent,
// so `postMessage` falls back to `console.log(message)`. The test installs a
// window-level `console.log` interceptor BEFORE mount that stores the
// subscription message, then replays a full snapshot with the matching
// requestId so the reducer's stale-epoch check passes and real data renders
// (not the loading/empty state).

test("renders the dashboard with summary, heatmap, breakdown, and tasks in the VS Code dark theme", async ({
	mount,
	page,
}) => {
	// Intercept `console.log` inside the page before the component mounts. The
	// vscode browser fallback (`src/utils/vscode.ts`) logs the posted message
	// object; we store it on `window` so the test can read the requestId.
	await page.evaluate(() => {
		const originalLog = window.console.log.bind(window.console)
		;(window as unknown as { __dashboardSubscriptions__: unknown[] }).__dashboardSubscriptions__ = []
		window.console.log = (...args: unknown[]) => {
			const message = args[0]
			if (message && typeof message === "object" && (message as { type?: string }).type === "subscribeDashboardStats") {
				;(window as unknown as { __dashboardSubscriptions__: unknown[] }).__dashboardSubscriptions__.push(
					message,
				)
			}
			originalLog(...args)
		}
	})

	const component = await mount(<DashboardViewFixture />)

	// Wait for the subscription post to be captured, then deliver the snapshot.
	const subscription = await page
		.waitForFunction(() => {
			const subs = (window as unknown as { __dashboardSubscriptions__: unknown[] }).__dashboardSubscriptions__
			return subs.length > 0 ? subs[0] : undefined
		})
		.then((handle) => handle.jsonValue())

	const requestId = (subscription as { dashboardStatsSubscription?: { requestId?: string } })
		.dashboardStatsSubscription?.requestId
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
