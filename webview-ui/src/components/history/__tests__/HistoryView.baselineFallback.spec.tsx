import { render, screen, fireEvent } from "@/utils/test-utils"
import type { HistoryItem } from "@roo-code/types"
import type { TaskGroup } from "../types"

import HistoryView from "../HistoryView"

vi.mock("../useTaskSearch")
vi.mock("../useGroupedTasks")
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: vi.fn(({ data, itemContent }) => (
		<div data-testid="virtuoso-container">
			{data?.map((entry: any, index: number) => (
				<div key={entry?.parent?.id ?? entry?.id ?? index}>{itemContent(index, entry)}</div>
			))}
		</div>
	)),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			if (!params) return key
			return Object.entries(params).reduce(
				(acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v)),
				key,
			)
		},
	}),
}))

vi.mock("../TaskGroupItem", () => {
	return {
		default: vi.fn(({ group, variant, onToggleExpand, isSelected, onToggleSelection, onDelete }) => (
			<div data-testid={`task-group-${group.parent.id}`} data-variant={variant}>
				<span>{group.parent.task}</span>
				{onToggleExpand && (
					<button data-testid={`expand-${group.parent.id}`} onClick={onToggleExpand}>
						expand
					</button>
				)}
				{onToggleSelection && (
					<input
						type="checkbox"
						data-testid={`select-${group.parent.id}`}
						checked={isSelected}
						onChange={(e) => onToggleSelection(group.parent.id, e.target.checked)}
					/>
				)}
				{onDelete && (
					<button data-testid={`delete-${group.parent.id}`} onClick={() => onDelete(group.parent.id)}>
						delete
					</button>
				)}
			</div>
		)),
	}
})

vi.mock("../TaskItem", () => {
	return {
		default: vi.fn(({ item, isSelected, onToggleSelection, onDelete }) => (
			<div data-testid={`task-item-${item.id}`}>
				<span>{item.task}</span>
				{onToggleSelection && (
					<input
						type="checkbox"
						data-testid={`select-item-${item.id}`}
						checked={isSelected}
						onChange={(e) => onToggleSelection(item.id, e.target.checked)}
					/>
				)}
				{onDelete && (
					<button data-testid={`delete-item-${item.id}`} onClick={() => onDelete(item.id)}>
						delete
					</button>
				)}
			</div>
		)),
	}
})

// Force useTaskOrganization to throw so the ErrorBoundary activates the baseline fallback
vi.mock("../TaskOrganizationInteractionContext", async () => {
	const actual = await vi.importActual<typeof import("../TaskOrganizationInteractionContext")>(
		"../TaskOrganizationInteractionContext",
	)
	return {
		...actual,
		useTaskOrganization: vi.fn(() => {
			throw new Error("forced organization failure")
		}),
	}
})

import { useTaskSearch } from "../useTaskSearch"
import { useGroupedTasks } from "../useGroupedTasks"
import { useExtensionState } from "@src/context/ExtensionStateContext"

const mockUseTaskSearch = useTaskSearch as any
const mockUseGroupedTasks = useGroupedTasks as any
const mockUseExtensionState = useExtensionState as any

function makeTask(id: string, overrides?: Partial<HistoryItem>): HistoryItem {
	return {
		id,
		number: 1,
		task: `Task ${id}`,
		ts: Date.now(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
		...overrides,
	}
}

function makeGroup(task: HistoryItem, subtasks: TaskGroup["subtasks"] = []): TaskGroup {
	return {
		parent: { ...task, isSubtask: false },
		subtasks,
		isExpanded: false,
	}
}

const mockTasks: HistoryItem[] = [
	makeTask("task-1", { ts: 600 }),
	makeTask("task-2", { ts: 500 }),
	makeTask("task-3", { ts: 400 }),
	makeTask("task-4", { ts: 300 }),
]

describe("HistoryView baseline fallback (ErrorBoundary)", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		mockUseExtensionState.mockReturnValue({
			cwd: "/test/workspace",
			taskOrganization: undefined,
			mutateTaskOrganization: vi.fn(),
		})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
		consoleWarnSpy.mockRestore()
	})

	it("renders grouped task list via baseline fallback", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// All groups rendered via baseline
		expect(screen.getByTestId("task-group-task-1")).toBeInTheDocument()
		expect(screen.getByTestId("task-group-task-2")).toBeInTheDocument()
		expect(screen.getByTestId("task-group-task-3")).toBeInTheDocument()
		expect(screen.getByTestId("task-group-task-4")).toBeInTheDocument()
	})

	it("renders search mode flat task list in baseline fallback", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "task",
			setSearchQuery: vi.fn(),
			sortOption: "mostRelevant" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: "newest" as const,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [],
			flatTasks: mockTasks,
			toggleExpand: vi.fn(),
			isSearchMode: true,
		})

		render(<HistoryView onDone={vi.fn()} />)

		expect(screen.getByTestId("task-item-task-1")).toBeInTheDocument()
		expect(screen.getByTestId("task-item-task-2")).toBeInTheDocument()
	})

	it("baseline fallback selection mode toggle works", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode
		const toggleButton = screen.getByTestId("toggle-selection-mode-button")
		fireEvent.click(toggleButton)

		// Selection checkboxes should appear
		expect(screen.getByTestId("select-task-1")).toBeInTheDocument()
		expect(screen.getByTestId("select-task-2")).toBeInTheDocument()
	})

	it("baseline fallback task selection works", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// Select a task
		const checkbox = screen.getByTestId("select-task-1")
		fireEvent.click(checkbox)

		// Should show selected count (multiple elements may match, so use getAllByText)
		expect(screen.getAllByText(/history:selectedItems/).length).toBeGreaterThan(0)
	})

	it("baseline fallback select all / deselect all works", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// The baseline fallback's select-all checkbox is the first Checkbox component
		// rendered inside the selection toolbar. It's the one without a data-testid
		// (unlike the per-task checkboxes from the mocked TaskGroupItem).
		const toolbar = screen.getByText(/history:selectAll|history:deselectAll/).closest("div")!
		const selectAllCheckbox = toolbar.parentElement!.querySelector("button[role='checkbox']")!
		fireEvent.click(selectAllCheckbox)

		// Should show all selected
		expect(screen.getByText(/history:deselectAll/)).toBeInTheDocument()
	})

	it("baseline fallback delete dialog opens for single task", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Click delete on first task
		fireEvent.click(screen.getByTestId("delete-task-1"))

		// Delete dialog should appear
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
	})

	it("baseline fallback sort select is present", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Sort select should be present (Select component renders trigger)
		expect(screen.getByText(/history:sort.newest/)).toBeInTheDocument()
	})

	it("baseline fallback workspace filter select is present", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Workspace select should show current
		expect(screen.getByText(/history:workspace.current/)).toBeInTheDocument()
	})

	it("baseline fallback done button calls onDone", () => {
		const onDone = vi.fn()
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={onDone} />)

		fireEvent.click(screen.getByTestId("history-done-button"))
		expect(onDone).toHaveBeenCalled()
	})

	it("baseline fallback search input accepts text", () => {
		const setSearchQuery = vi.fn()
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery,
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		const searchInput = screen.getByTestId("history-search-input")
		fireEvent.input(searchInput, { target: { value: "test query" } })

		expect(setSearchQuery).toHaveBeenCalledWith("test query")
	})

	it("baseline fallback batch delete dialog opens when tasks selected", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode and select a task
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("select-task-1"))

		// Click batch delete
		fireEvent.click(screen.getByText("history:deleteSelected"))

		// Batch delete dialog should appear
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
	})

	it("baseline fallback clear selection button works", () => {
		mockUseTaskSearch.mockReturnValue({
			tasks: mockTasks,
			searchQuery: "",
			setSearchQuery: vi.fn(),
			sortOption: "newest" as const,
			setSortOption: vi.fn(),
			lastNonRelevantSort: null,
			setLastNonRelevantSort: vi.fn(),
			showAllWorkspaces: false,
			setShowAllWorkspaces: vi.fn(),
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: mockTasks.map((t) => makeGroup(t)),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode and select a task
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("select-task-1"))

		// Clear selection
		fireEvent.click(screen.getByText("history:clearSelection"))

		// Selection count should be 0
		expect(screen.getByText(/history:selectedItems/)).toBeInTheDocument()
	})
})
