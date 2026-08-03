// npx vitest run src/components/dashboard/__tests__/TaskList.spec.tsx

import React from "react"
import { render, fireEvent } from "@/utils/test-utils"

import type { DashboardTaskDetail, DashboardTaskSummary } from "@roo-code/types"

import TaskList from "../TaskList"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// Mock react-virtuoso to render all items without virtualization in tests
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
	}: {
		data: DashboardTaskSummary[]
		itemContent: (index: number, task: DashboardTaskSummary) => React.ReactNode
	}) => (
		<div data-testid="virtuoso-mock">
			{data.map((task, index) => (
				<React.Fragment key={task.taskId}>{itemContent(index, task)}</React.Fragment>
			))}
		</div>
	),
}))

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<DashboardTaskSummary> = {}): DashboardTaskSummary {
	return {
		taskId: "task-001",
		rootTaskId: "task-001",
		title: "Test task",
		taskTimestamp: Date.now(),
		totalCost: 0.05,
		totalTokens: 1500,
		model: "gpt-4",
		provider: "openai",
		lastUsageAt: Date.now(),
		eventCount: 1,
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TaskList", () => {
	const defaultProps = {
		expandedTaskId: undefined,
		taskDetails: {} as Record<string, DashboardTaskDetail | null>,
		taskDetailErrors: {} as Record<string, string | null>,
		taskDetailLoading: new Set<string>(),
		onToggleTask: vi.fn(),
	}

	it("renders the tasks container", () => {
		const { container } = render(<TaskList tasks={[]} {...defaultProps} />)
		const tasks = container.querySelector('[data-testid="dashboard-tasks"]')
		expect(tasks).toBeTruthy()
	})

	it("renders empty state when no tasks", () => {
		const { container } = render(<TaskList tasks={[]} {...defaultProps} />)
		const empty = container.querySelector('[data-testid="dashboard-tasks-empty"]')
		expect(empty).toBeTruthy()
		expect(empty?.textContent).toContain("dashboard:tasks.noTasks")
	})

	it("renders task rows for each task", () => {
		const tasks = [
			makeTask({ taskId: "task-A", title: "Task A" }),
			makeTask({ taskId: "task-B", title: "Task B" }),
		]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} />)
		expect(container.textContent).toContain("Task A")
		expect(container.textContent).toContain("Task B")
	})

	it("renders the title header", () => {
		const { container } = render(<TaskList tasks={[]} {...defaultProps} />)
		expect(container.textContent).toContain("dashboard:tasks.title")
	})

	it("calls onToggleTask when a task row is clicked", () => {
		const onToggleTask = vi.fn()
		const tasks = [makeTask({ taskId: "task-A", title: "Click me" })]
		const { container } = render(
			<TaskList tasks={tasks} {...defaultProps} onToggleTask={onToggleTask} />,
		)
		const row = container.querySelector('[data-testid="dashboard-task-row"]')
		expect(row).toBeTruthy()
		fireEvent.click(row!)
		expect(onToggleTask).toHaveBeenCalledWith("task-A")
	})

	it("shows loading state when task detail is loading", () => {
		const tasks = [makeTask({ taskId: "task-A" })]
		const { container } = render(
			<TaskList
				tasks={tasks}
				{...defaultProps}
				expandedTaskId="task-A"
				taskDetailLoading={new Set(["task-A"])}
			/>,
		)
		expect(container.textContent).toContain("dashboard:states.loading")
	})

	it("shows error state when task detail fetch failed", () => {
		const tasks = [makeTask({ taskId: "task-A" })]
		const { container } = render(
			<TaskList
				tasks={tasks}
				{...defaultProps}
				expandedTaskId="task-A"
				taskDetailErrors={{ "task-A": "Network error" }}
			/>,
		)
		expect(container.textContent).toContain("Network error")
	})

	it("shows task detail when expanded and loaded", () => {
		const tasks = [makeTask({ taskId: "task-A" })]
		const detail: DashboardTaskDetail = {
			taskId: "task-A",
			title: "Test task",
			taskTimestamp: Date.now(),
			models: ["gpt-4"],
			modes: ["code"],
			totalTokens: 1500,
			totalCost: 0.05,
			callCount: 1,
			apiCalls: [],
		}
		const { container } = render(
			<TaskList
				tasks={tasks}
				{...defaultProps}
				expandedTaskId="task-A"
				taskDetails={{ "task-A": detail }}
			/>,
		)
		const noCalls = container.querySelector('[data-testid="dashboard-session-detail-no-calls"]')
		expect(noCalls).toBeTruthy()
	})

	it("displays formatted tokens and cost in task row", () => {
		const tasks = [makeTask({ taskId: "task-A", totalTokens: 1_500_000, totalCost: 1.23 })]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} />)
		expect(container.textContent).toContain("1.50M")
		expect(container.textContent).toContain("$1.23")
	})

	it("displays zero metrics and omits empty metadata separators", () => {
		const tasks = [
			makeTask({ taskId: "task-zero", totalTokens: 0, totalCost: 0, eventCount: 0, model: "", provider: "" }),
		]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} />)
		expect(container.textContent).toContain("0")
		expect(container.textContent).toContain("$0.00")
		expect(container.textContent).toContain("dashboard:tasks.callCount")
		expect(container.textContent).not.toContain(" ·  · ")
	})

	it("renders total estimate when provided", () => {
		const tasks = [makeTask({ taskId: "task-A" })]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} totalEstimate={42} />)
		expect(container.textContent).toContain("(42)")
	})

	it("does not render total estimate when undefined", () => {
		const tasks = [makeTask({ taskId: "task-A" })]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} />)
		expect(container.textContent).not.toContain("(")
	})

	it("does not request the next page without a cursor or while a page is loading", () => {
		const onLoadMore = vi.fn()
		const tasks = [makeTask({ taskId: "task-A" }), makeTask({ taskId: "task-B" })]
		render(<TaskList tasks={tasks} {...defaultProps} onLoadMore={onLoadMore} />)
		expect(onLoadMore).not.toHaveBeenCalled()
	})
})
