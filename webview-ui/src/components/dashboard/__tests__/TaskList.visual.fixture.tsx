import React from "react"

import { providerIdentifiers, type DashboardTaskSummary } from "@roo-code/types"

import TaskList from "../TaskList"

function toTasksById(tasks: DashboardTaskSummary[]): Record<string, DashboardTaskSummary> {
	return Object.fromEntries(tasks.map((task) => [task.taskId, task]))
}

export function makeTasks(count: number): DashboardTaskSummary[] {
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
		provider: providerIdentifiers.anthropic,
		models: ["claude-sonnet-4-20250514"],
		modes: ["code"],
		eventCount: i + 1,
		childTaskIds: [],
	}))
}

/**
 * Gallery story fixture: 50 rows so the Virtuoso scroller reaches its 400px cap.
 */
export function TaskListManyFixture() {
	const tasks = makeTasks(50)
	return (
		<TaskList
			tasks={tasks}
			tasksById={toTasksById(tasks)}
			taskDetails={{}}
			taskDetailErrors={{}}
			taskDetailLoading={new Set()}
			onToggleTask={() => {}}
			totalEstimate={tasks.length}
		/>
	)
}

/**
 * Gallery story fixture: only 3 rows so the Virtuoso scroller shrinks to fit.
 */
export function TaskListFewFixture() {
	const tasks = makeTasks(3)
	return (
		<TaskList
			tasks={tasks}
			tasksById={toTasksById(tasks)}
			taskDetails={{}}
			taskDetailErrors={{}}
			taskDetailLoading={new Set()}
			onToggleTask={() => {}}
			totalEstimate={tasks.length}
		/>
	)
}

// ── Hierarchy (root > subtask) ───────────────────────────────────────────────

export function HierarchyFixture() {
	const childA: DashboardTaskSummary = {
		taskId: "child-a",
		rootTaskId: "root-1",
		parentTaskId: "root-1",
		title: "Subtask A",
		taskTimestamp: Date.now() - 60_000,
		lastUsageAt: Date.now() - 60_000,
		totalCost: 0.02,
		totalTokens: 500,
		inputTokens: 300,
		outputTokens: 200,
		model: "claude-sonnet-4-20250514",
		provider: providerIdentifiers.anthropic,
		models: ["claude-sonnet-4-20250514"],
		modes: ["code"],
		eventCount: 1,
		childTaskIds: [],
	}
	const childB: DashboardTaskSummary = { ...childA, taskId: "child-b", title: "Subtask B" }
	const root: DashboardTaskSummary = {
		...childA,
		taskId: "root-1",
		parentTaskId: undefined,
		title: "Root task",
		childTaskIds: ["child-a", "child-b"],
		totalTokens: 1500,
		eventCount: 3,
	}

	const [expandedRootId, setExpandedRootId] = React.useState<string | undefined>(undefined)
	const [expandedDetailTaskId, setExpandedDetailTaskId] = React.useState<string | undefined>(undefined)

	return (
		<TaskList
			tasks={[root]}
			tasksById={toTasksById([root, childA, childB])}
			expandedRootId={expandedRootId}
			expandedDetailTaskId={expandedDetailTaskId}
			taskDetails={{}}
			taskDetailErrors={{}}
			// Pretend child-a's detail fetch is always in flight so expanding it
			// renders the loading slot.
			taskDetailLoading={new Set(["child-a"])}
			onToggleTask={(taskId) => {
				if (taskId === "root-1") {
					setExpandedRootId((current) => (current === taskId ? undefined : taskId))
					setExpandedDetailTaskId(undefined)
				} else {
					setExpandedDetailTaskId((current) => (current === taskId ? undefined : taskId))
				}
			}}
			totalEstimate={1}
		/>
	)
}
