import React from "react"

import type { DashboardTaskSummary } from "@roo-code/types"

import TaskList from "../TaskList"

function toTasksById(tasks: DashboardTaskSummary[]): Record<string, DashboardTaskSummary> {
	return Object.fromEntries(tasks.map((task) => [task.taskId, task]))
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
