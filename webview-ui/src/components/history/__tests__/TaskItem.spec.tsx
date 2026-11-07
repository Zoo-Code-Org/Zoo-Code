import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import TaskItem from "../TaskItem"

vi.mock("@src/utils/vscode")
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/utils/format", () => ({
	formatTimeAgo: vi.fn(() => "2 hours ago"),
	formatDateTime: vi.fn(() => "Jan 15, 2024, 2:30 PM"),
	formatLargeNumber: vi.fn((num: number) => num.toString()),
}))

const mockTask = {
	id: "1",
	number: 1,
	task: "Test task",
	ts: Date.now(),
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.002,
	workspace: "/test/workspace",
}

describe("TaskItem", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders task information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		expect(screen.getByText("$0.00")).toBeInTheDocument() // Component shows $0.00 for small amounts
	})

	it("handles selection in selection mode", () => {
		const onToggleSelection = vi.fn()
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={onToggleSelection}
				isSelectionMode={true}
			/>,
		)

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)

		expect(onToggleSelection).toHaveBeenCalledWith("1", true)
	})

	it("shows action buttons", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should show copy and export buttons
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.getByTestId("export")).toBeInTheDocument()
	})

	it("displays time ago information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should display time ago format
		expect(screen.getByText(/ago/)).toBeInTheDocument()
	})

	it("applies hover effect class", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		const taskItem = screen.getByTestId("task-item-1")
		expect(taskItem).toHaveClass("hover:text-vscode-foreground")
	})

	it("shows the custom title instead of the prompt when renamed", () => {
		render(<TaskItem item={{ ...mockTask, title: "My title" }} variant="full" />)

		expect(screen.getByText("My title")).toBeInTheDocument()
		expect(screen.queryByText("Test task")).not.toBeInTheDocument()
	})

	it("opens an inline editor from the rename button without opening the task", () => {
		render(<TaskItem item={mockTask} variant="full" />)

		fireEvent.click(screen.getByTestId("rename-task-button"))

		expect(screen.getByTestId("task-title-input")).toHaveValue("Test task")
		fireEvent.click(screen.getByTestId("task-title-input"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("saves the new title on Enter and closes the editor", () => {
		render(<TaskItem item={mockTask} variant="full" />)

		fireEvent.click(screen.getByTestId("rename-task-button"))
		const input = screen.getByTestId("task-title-input")
		fireEvent.change(input, { target: { value: "  Renamed task  " } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "renameTaskWithId", taskId: "1", text: "Renamed task" })
		expect(screen.queryByTestId("task-title-input")).not.toBeInTheDocument()
	})

	it("does not show the rename button in the compact variant", () => {
		render(<TaskItem item={mockTask} variant="compact" />)

		expect(screen.queryByTestId("rename-task-button")).not.toBeInTheDocument()
	})
})
