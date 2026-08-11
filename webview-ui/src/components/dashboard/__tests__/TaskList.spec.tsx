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

// Capture the last endReached callback so tests can trigger it manually.
let lastEndReached: (() => void) | undefined
export function triggerVirtuosoEndReached() {
	lastEndReached?.()
}

// Mock react-virtuoso to render all items without virtualization in tests
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
		endReached,
	}: {
		data: DashboardTaskSummary[]
		itemContent: (index: number, task: DashboardTaskSummary) => React.ReactNode
		endReached?: () => void
	}) => {
		lastEndReached = endReached
		return (
			<div data-testid="virtuoso-mock">
				{data.map((task, index) => (
					<React.Fragment key={task.taskId}>{itemContent(index, task)}</React.Fragment>
				))}
			</div>
		)
	},
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
		inputTokens: 1000,
		outputTokens: 500,
		model: "gpt-4",
		provider: "openai",
		models: ["gpt-4"],
		modes: ["code"],
		lastUsageAt: Date.now(),
		eventCount: 1,
		childTaskIds: [],
		...overrides,
	}
}

function toTasksById(tasks: DashboardTaskSummary[]): Record<string, DashboardTaskSummary> {
	return Object.fromEntries(tasks.map((task) => [task.taskId, task]))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TaskList", () => {
	const defaultProps = {
		tasksById: {} as Record<string, DashboardTaskSummary>,
		expandedRootId: undefined,
		expandedDetailTaskId: undefined,
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
		const tasks = [makeTask({ taskId: "task-A", title: "Task A" }), makeTask({ taskId: "task-B", title: "Task B" })]
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
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} onToggleTask={onToggleTask} />)
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
				expandedDetailTaskId="task-A"
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
				expandedDetailTaskId="task-A"
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
				expandedDetailTaskId="task-A"
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

	it("hides subtasks until the root row is expanded", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({ taskId: "root-1", title: "Root one", childTaskIds: ["child-1"] })
		const { container } = render(
			<TaskList tasks={[root]} {...defaultProps} tasksById={toTasksById([root, child])} />,
		)
		expect(container.textContent).toContain("Root one")
		expect(container.textContent).not.toContain("Child one")
		expect(container.querySelector('[data-testid="dashboard-subtask-row"]')).toBeFalsy()
	})

	it("renders subtask rows when the root is expanded", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({ taskId: "root-1", title: "Root one", childTaskIds: ["child-1"] })
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
			/>,
		)
		expect(container.querySelector('[data-testid="dashboard-subtask-list"]')).toBeTruthy()
		expect(container.querySelector('[data-testid="dashboard-subtask-row"]')).toBeTruthy()
		expect(container.textContent).toContain("Child one")
		// A root with subtasks expands into the list, not into its own detail.
		expect(container.querySelector('[data-testid="dashboard-session-detail-no-calls"]')).toBeFalsy()
	})

	it("renders the subtree aggregate strip on an expanded root", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({
			taskId: "root-1",
			title: "Root one",
			childTaskIds: ["child-1"],
			inputTokens: 2500,
			outputTokens: 800,
			totalCost: 0.07,
			eventCount: 3,
			models: ["gpt-4", "claude"],
			modes: ["code", "architect"],
		})
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
			/>,
		)
		const strip = container.querySelector('[data-testid="dashboard-task-aggregate"]')
		expect(strip).toBeTruthy()
		expect(strip?.textContent).toContain("dashboard:sessionDetail.input 2.5K")
		expect(strip?.textContent).toContain("dashboard:sessionDetail.output 800")
		expect(strip?.textContent).toContain("dashboard:sessionDetail.cost $0.07")
		expect(strip?.textContent).toContain("dashboard:taskAggregate.modes code, architect")
		expect(strip?.textContent).toContain("dashboard:taskAggregate.models gpt-4, claude")
		// The strip sits above the subtask list inside the root's expansion area.
		expect(
			strip!.compareDocumentPosition(container.querySelector('[data-testid="dashboard-subtask-list"]')!) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
	})

	it("does not render the aggregate strip on subtask rows", () => {
		const child = makeTask({
			taskId: "child-1",
			rootTaskId: "root-1",
			parentTaskId: "root-1",
			title: "Child one",
			models: ["child-model"],
			modes: ["ask"],
		})
		const root = makeTask({ taskId: "root-1", title: "Root one", childTaskIds: ["child-1"] })
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
			/>,
		)
		// Exactly one strip, holding the root's aggregate values — not the child's.
		const strips = container.querySelectorAll('[data-testid="dashboard-task-aggregate"]')
		expect(strips).toHaveLength(1)
		expect(strips[0].textContent).not.toContain("child-model")
	})

	it("hides the aggregate strip when the root has no usage events", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({
			taskId: "root-1",
			title: "Root one",
			childTaskIds: ["child-1"],
			eventCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			models: [],
			modes: [],
		})
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
			/>,
		)
		expect(container.querySelector('[data-testid="dashboard-task-aggregate"]')).toBeFalsy()
		// The subtask list itself still renders.
		expect(container.querySelector('[data-testid="dashboard-subtask-list"]')).toBeTruthy()
	})

	it("calls onToggleTask with the subtask id when a subtask row is clicked", () => {
		const onToggleTask = vi.fn()
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({ taskId: "root-1", title: "Root one", childTaskIds: ["child-1"] })
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
				onToggleTask={onToggleTask}
			/>,
		)
		const row = container.querySelector('[data-testid="dashboard-subtask-row"]')
		expect(row).toBeTruthy()
		fireEvent.click(row!)
		expect(onToggleTask).toHaveBeenCalledWith("child-1")
	})

	it("shows a subtask detail under the subtask row when loaded", () => {
		const child = makeTask({ taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", title: "Child one" })
		const root = makeTask({ taskId: "root-1", title: "Root one", childTaskIds: ["child-1"] })
		const detail: DashboardTaskDetail = {
			taskId: "child-1",
			title: "Child one",
			taskTimestamp: Date.now(),
			models: ["gpt-4"],
			modes: ["code"],
			totalTokens: 500,
			totalCost: 0.02,
			callCount: 1,
			apiCalls: [],
		}
		const { container } = render(
			<TaskList
				tasks={[root]}
				{...defaultProps}
				tasksById={toTasksById([root, child])}
				expandedRootId="root-1"
				expandedDetailTaskId="child-1"
				taskDetails={{ "child-1": detail }}
			/>,
		)
		expect(container.querySelector('[data-testid="dashboard-session-detail-no-calls"]')).toBeTruthy()
	})

	describe("formatRelativeTime branches", () => {
		const baseTime = new Date("2026-08-07T12:00:00.000Z").getTime()

		beforeEach(() => {
			vi.useFakeTimers()
			vi.setSystemTime(baseTime)
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function renderWithTimestamp(timestamp: number) {
			const tasks = [makeTask({ taskId: "time-task", lastUsageAt: timestamp })]
			const { container } = render(<TaskList tasks={tasks} {...defaultProps} />)
			return container
		}

		it("renders just now for timestamps under a minute ago", () => {
			const container = renderWithTimestamp(baseTime - 30 * 1000)
			expect(container.textContent).toContain("time.justNow")
		})

		it("renders minutes ago for timestamps 1-59 minutes ago", () => {
			const container = renderWithTimestamp(baseTime - 5 * 60 * 1000)
			expect(container.textContent).toContain("time.minutesAgo")
		})

		it("renders hours ago for timestamps 1-23 hours ago", () => {
			const container = renderWithTimestamp(baseTime - 3 * 60 * 60 * 1000)
			expect(container.textContent).toContain("time.hoursAgo")
		})

		it("renders yesterday for timestamps exactly one day ago", () => {
			const container = renderWithTimestamp(baseTime - 24 * 60 * 60 * 1000)
			expect(container.textContent).toContain("time.yesterday")
		})

		it("renders days ago for timestamps 2-6 days ago", () => {
			const container = renderWithTimestamp(baseTime - 3 * 24 * 60 * 60 * 1000)
			expect(container.textContent).toContain("time.daysAgo")
		})

		it("renders absolute date for timestamps older than a week", () => {
			const timestamp = new Date("2026-07-25T12:00:00.000Z").getTime()
			const container = renderWithTimestamp(timestamp)
			// Absolute fallback uses toLocaleDateString(); ensure it no longer shows relative keys.
			expect(container.textContent).not.toContain("time.justNow")
			expect(container.textContent).not.toContain("time.minutesAgo")
			expect(container.textContent).not.toContain("time.hoursAgo")
			expect(container.textContent).not.toContain("time.yesterday")
			expect(container.textContent).not.toContain("time.daysAgo")
		})
	})

	it("toggles a row on Enter and Space keydown", () => {
		const onToggleTask = vi.fn()
		const tasks = [makeTask({ taskId: "task-A", title: "Keyboard me" })]
		const { container } = render(<TaskList tasks={tasks} {...defaultProps} onToggleTask={onToggleTask} />)
		const row = container.querySelector('[data-testid="dashboard-task-row"]')
		expect(row).toBeTruthy()

		fireEvent.keyDown(row!, { key: "Enter" })
		expect(onToggleTask).toHaveBeenCalledWith("task-A")

		onToggleTask.mockClear()
		fireEvent.keyDown(row!, { key: " " })
		expect(onToggleTask).toHaveBeenCalledWith("task-A")
	})

	it("calls onLoadMore when endReached fires and a cursor is present", () => {
		const onLoadMore = vi.fn()
		const tasks = [makeTask({ taskId: "task-A" })]
		render(<TaskList tasks={tasks} {...defaultProps} onLoadMore={onLoadMore} taskCursor="cursor-1" />)

		triggerVirtuosoEndReached()
		expect(onLoadMore).toHaveBeenCalled()
	})
})
