import { expect, test } from "../../../../playwright/coverage-fixture"

// Regression tests for the "Tasks header shows a count but no rows render"
// bug: with only `maxHeight` set, the Virtuoso scroller's `height: 100%`
// resolves against an auto-height parent, collapses to 0px, and deadlocks
// (0 viewport -> 0 rendered items -> 0 content height). jsdom tests cannot
// catch this (no layout, and unit tests mock react-virtuoso), so these run
// in a real browser via Playwright CT.

test("renders task rows with a definite, capped scroller height", async ({ mount }) => {
	const component = await mount("dashboard-task-list-many")

	// Rows must actually reach the DOM and be laid out.
	await expect(component.getByTestId("dashboard-task-row").first()).toBeVisible()

	// The scroller must grow to the 400px cap (not collapse to 0).
	const scroller = component.locator("[data-virtuoso-scroller]")
	await expect
		.poll(async () => scroller.evaluate((el: HTMLElement) => el.clientHeight), {
			message: "scroller height reaches cap",
		})
		.toBe(400)
})

test("shrinks the scroller to the content height when only a few tasks exist", async ({ mount }) => {
	const component = await mount("dashboard-task-list-few")

	const scroller = component.locator("[data-virtuoso-scroller]")
	await expect
		.poll(async () => scroller.evaluate((el: HTMLElement) => el.clientHeight), {
			message: "scroller height is non-zero",
		})
		.toBeGreaterThan(0)

	const height = await scroller.evaluate((el: HTMLElement) => el.clientHeight)
	expect(height).toBeLessThan(400)

	await expect(component.getByTestId("dashboard-task-row")).toHaveCount(3)
})

test("root rows expand into subtask rows, and subtask rows toggle their detail", async ({ mount }) => {
	const component = await mount("dashboard-task-list-hierarchy")

	// Initially only the root row is visible; subtask titles are not rendered.
	await expect(component.getByTestId("dashboard-task-row")).toHaveCount(1)
	await expect(component.getByText("Subtask A")).toHaveCount(0)

	// Click the root row -> subtask rows appear (and the list grows).
	await component.getByTestId("dashboard-task-row").click()
	await expect(component.getByTestId("dashboard-subtask-row")).toHaveCount(2)
	await expect(component.getByText("Subtask A")).toBeVisible()
	await expect(component.getByText("Subtask B")).toBeVisible()

	// Click a subtask -> its (loading) detail slot opens without collapsing the list.
	await component.getByTestId("dashboard-subtask-row").first().click()
	await expect(component.getByTestId("dashboard-task-detail-loading")).toBeVisible()
	await expect(component.getByTestId("dashboard-subtask-row")).toHaveCount(2)
})
