import React from "react"

import type { DashboardTaskSummary } from "@roo-code/types"

import { expect, test } from "../../../../playwright/coverage-fixture"

import TaskList from "../TaskList"
import { HierarchyFixture } from "./TaskList.visual.fixture"

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
		inputTokens: 700 * (i + 1),
		outputTokens: 300 * (i + 1),
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		models: ["claude-sonnet-4-20250514"],
		modes: ["code"],
		eventCount: i + 1,
		childTaskIds: [],
	}))
}

function toTasksById(tasks: DashboardTaskSummary[]): Record<string, DashboardTaskSummary> {
	return Object.fromEntries(tasks.map((task) => [task.taskId, task]))
}

function renderTaskList(tasks: DashboardTaskSummary[], allTasks: DashboardTaskSummary[] = tasks) {
	return (
		<TaskList
			tasks={tasks}
			tasksById={toTasksById(allTasks)}
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

test("root rows expand into subtask rows, and subtask rows toggle their detail", async ({ mount }) => {
	const component = await mount(<HierarchyFixture />)

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
