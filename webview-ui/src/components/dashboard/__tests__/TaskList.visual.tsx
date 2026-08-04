import React from "react"

import type { DashboardTaskSummary } from "@roo-code/types"

import { expect, test } from "../../../../playwright/coverage-fixture"

import TaskList from "../TaskList"

// Regression tests for the "Tasks header shows a count but no rows render"
// bug: with only `maxHeight` set, the Virtuoso scroller's `height: 100%`
// resolves against an auto-height parent, collapses to 0px, and deadlocks
// (0 viewport -> 0 rendered items -> 0 content height). jsdom tests cannot
// catch this (no layout, and unit tests mock react-virtuoso), so these run
// in a real browser via Playwright CT.

function makeTasks(count: number): DashboardTaskSummary[] {
	return Array.from({ length: count }, (_, i) => ({
		taskId: `task-${i}`,
		rootTaskId: `task-${i}`,
		title: `Task ${i}`,
		taskTimestamp: Date.now() - i * 60_000,
		lastUsageAt: Date.now() - i * 60_000,
		totalCost: 0.01 * (i + 1),
		totalTokens: 1000 * (i + 1),
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		eventCount: i + 1,
	}))
}

function renderTaskList(tasks: DashboardTaskSummary[]) {
	return (
		<TaskList
			tasks={tasks}
			taskDetails={{}}
			taskDetailErrors={{}}
			taskDetailLoading={new Set()}
			onToggleTask={() => {}}
			totalEstimate={tasks.length}
		/>
	)
}

test("renders task rows with a definite, capped scroller height", async ({ mount }) => {
	const component = await mount(renderTaskList(makeTasks(50)))

	// Rows must actually reach the DOM and be laid out.
	await expect(component.getByTestId("dashboard-task-row").first()).toBeVisible()

	// The scroller must grow to the 400px cap (not collapse to 0).
	const scroller = component.locator("[data-virtuoso-scroller]")
	await expect
		.poll(async () => scroller.evaluate((el) => el.clientHeight), { message: "scroller height reaches cap" })
		.toBe(400)
})

test("shrinks the scroller to the content height when only a few tasks exist", async ({ mount }) => {
	const component = await mount(renderTaskList(makeTasks(3)))

	const scroller = component.locator("[data-virtuoso-scroller]")
	await expect
		.poll(async () => scroller.evaluate((el) => el.clientHeight), { message: "scroller height is non-zero" })
		.toBeGreaterThan(0)

	const height = await scroller.evaluate((el) => el.clientHeight)
	expect(height).toBeLessThan(400)

	await expect(component.getByTestId("dashboard-task-row")).toHaveCount(3)
})
