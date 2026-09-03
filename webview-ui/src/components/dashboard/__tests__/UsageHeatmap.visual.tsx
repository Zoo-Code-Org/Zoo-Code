/* v8 ignore file -- Playwright component visual test. */
import { expect, test } from "../../../../playwright/coverage-fixture"

// Visual coverage for the GitHub-style activity heatmap with the 60-day range
// active. A non-empty `values` array guarantees the grid + legend render
// instead of the "no activity" empty state.
test("renders the 60-day usage heatmap in the VS Code dark theme", async ({ mount }) => {
	const component = await mount("dashboard-heatmap")

	await component.evaluate(async () => {
		await document.fonts.ready
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	})

	// The heatmap grid must render (not the "no activity" empty state).
	await expect(component.getByRole("img", { name: "Daily Activity" })).toBeVisible()

	await expect(component).toHaveScreenshot("usage-heatmap-dark.png")
})
