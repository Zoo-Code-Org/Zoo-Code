import { render, screen, fireEvent } from "@/utils/test-utils"
import type { HistoryItem, TaskOrganizationStateV1 } from "@roo-code/types"
import type { TaskGroup } from "../types"

import HistoryPreview from "../HistoryPreview"

vi.mock("../useTaskSearch")
vi.mock("../useGroupedTasks")
vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
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
		default: vi.fn(({ group, variant }) => (
			<div data-testid={`task-group-${group.parent.id}`} data-variant={variant}>
				{group.parent.task}
			</div>
		)),
	}
})

vi.mock("../TaskOrganizationInteractionContext", async () => {
	const actual = await vi.importActual<typeof import("../TaskOrganizationInteractionContext")>(
		"../TaskOrganizationInteractionContext",
	)
	return {
		...actual,
		useTaskOrganization: vi.fn(),
	}
})

vi.mock("../PinnedHistoryItem", () => {
	return {
		PinnedHistoryItem: vi.fn(
			({ unit, folderName, label, "data-testid": dataTestId, onClick, isExpanded, children }) => (
				<div data-testid={dataTestId} onClick={onClick} data-expanded={isExpanded}>
					{unit ? (label ?? unit.rootTaskId) : folderName}
					{children}
				</div>
			),
		),
	}
})

vi.mock("../ManualFolderItem", () => {
	return {
		ManualFolderItem: vi.fn(
			({ folderId, name, "data-testid": dataTestId, onToggleExpand, isExpanded, children }) => (
				<div data-testid={dataTestId ?? `preview-folder-${folderId}`} data-expanded={isExpanded}>
					<button data-testid={`folder-expand-${folderId}`} onClick={onToggleExpand}>
						toggle
					</button>
					<span>{name}</span>
					{isExpanded && children}
				</div>
			),
		),
		ManualFolderMemberItem: vi.fn(({ children, unit }) => (
			<div data-testid={`folder-member-${unit?.rootTaskId}`}>{children}</div>
		)),
	}
})

vi.mock("../DraggableTaskEntry", () => {
	return {
		DraggableTaskEntry: vi.fn(({ children, id }) => <div data-testid={id}>{children}</div>),
	}
})

import { useTaskSearch } from "../useTaskSearch"
import { useGroupedTasks } from "../useGroupedTasks"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTaskOrganization } from "../TaskOrganizationInteractionContext"
import { vscode } from "@src/utils/vscode"

const mockUseTaskSearch = useTaskSearch as any
const mockUseGroupedTasks = useGroupedTasks as any
const mockUseExtensionState = useExtensionState as any
const mockUseTaskOrganization = useTaskOrganization as any

function createEmptyOrganizationState(): TaskOrganizationStateV1 {
	return {
		schemaVersion: 1,
		revision: 0,
		folders: [],
		pins: [],
		updatedAt: 0,
	}
}

const mockTasks: HistoryItem[] = [
	{
		id: "task-1",
		number: 1,
		task: "First task",
		ts: 600,
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
	},
	{
		id: "task-2",
		number: 2,
		task: "Second task",
		ts: 500,
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.02,
		workspace: "/test/workspace",
	},
	{
		id: "task-3",
		number: 3,
		task: "Third task",
		ts: 400,
		tokensIn: 150,
		tokensOut: 75,
		totalCost: 0.015,
		workspace: "/test/workspace",
	},
	{
		id: "task-4",
		number: 4,
		task: "Fourth task",
		ts: 300,
		tokensIn: 300,
		tokensOut: 150,
		totalCost: 0.03,
		workspace: "/test/workspace",
	},
	{
		id: "task-5",
		number: 5,
		task: "Fifth task",
		ts: 200,
		tokensIn: 250,
		tokensOut: 125,
		totalCost: 0.025,
		workspace: "/test/workspace",
	},
	{
		id: "task-6",
		number: 6,
		task: "Sixth task",
		ts: 100,
		tokensIn: 400,
		tokensOut: 200,
		totalCost: 0.04,
		workspace: "/test/workspace",
	},
]

function createMockGroups(tasks: HistoryItem[]): TaskGroup[] {
	return tasks.map((task) => ({
		parent: { ...task, isSubtask: false },
		subtasks: [],
		isExpanded: false,
	}))
}

function createGroupWithSubtasks(parent: HistoryItem, subtasks: HistoryItem[]): TaskGroup {
	return {
		parent: { ...parent, isSubtask: false },
		subtasks: subtasks.map((s) => ({
			item: { ...s, isSubtask: true },
			children: [],
			isExpanded: false,
		})),
		isExpanded: false,
	}
}

const defaultSearchResult = {
	tasks: mockTasks,
	searchQuery: "",
	setSearchQuery: vi.fn(),
	sortOption: "newest" as const,
	setSortOption: vi.fn(),
	lastNonRelevantSort: null,
	setLastNonRelevantSort: vi.fn(),
	showAllWorkspaces: false,
	setShowAllWorkspaces: vi.fn(),
}

describe("HistoryPreview coverage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			taskOrganization: createEmptyOrganizationState(),
			mutateTaskOrganization: vi.fn().mockResolvedValue({
				requestId: "",
				success: true,
				committedRevision: 1,
			}),
			cwd: "/test/workspace",
		})
		mockUseTaskOrganization.mockReturnValue({
			organization: createEmptyOrganizationState(),
			isPinned: () => false,
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})
	})

	it("renders pinned task shortcut in the pinned section", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			pins: [{ target: { kind: "task", taskId: "task-5" }, pinnedAt: 100 }],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: (target: any) => target.kind === "task" && target.taskId === "task-5",
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue(defaultSearchResult)
		mockUseGroupedTasks.mockReturnValue({
			groups: createMockGroups(mockTasks),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		expect(screen.getByTestId("preview-pinned-section")).toBeInTheDocument()
		expect(screen.getByTestId("preview-pinned-unit-task-5")).toBeInTheDocument()
	})

	it("renders pinned folder shortcut with member groups when expanded", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			folders: [
				{
					folderId: "folder-1",
					name: "My Folder",
					taskIds: ["task-1"],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			pins: [{ target: { kind: "folder", folderId: "folder-1" }, pinnedAt: 100 }],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: (target: any) => target.kind === "folder" && target.folderId === "folder-1",
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [mockTasks[0], mockTasks[1], mockTasks[2]],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [createMockGroups(mockTasks)[0], createMockGroups(mockTasks)[1], createMockGroups(mockTasks)[2]],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		expect(screen.getByTestId("preview-pinned-folder-folder-1")).toBeInTheDocument()
	})

	it("renders manual folders with expandable member groups", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			folders: [
				{
					folderId: "folder-1",
					name: "My Folder",
					taskIds: ["task-1"],
					createdAt: 1,
					updatedAt: 1,
				},
			],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: () => false,
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [mockTasks[0], mockTasks[1], mockTasks[2]],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [createMockGroups(mockTasks)[0], createMockGroups(mockTasks)[1], createMockGroups(mockTasks)[2]],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		// Folder should be visible
		expect(screen.getByTestId("preview-folder-folder-1")).toBeInTheDocument()
	})

	it("toggles pinned folder expand state on click", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			folders: [
				{
					folderId: "folder-1",
					name: "My Folder",
					taskIds: ["task-1"],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			pins: [{ target: { kind: "folder", folderId: "folder-1" }, pinnedAt: 100 }],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: (target: any) => target.kind === "folder" && target.folderId === "folder-1",
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [mockTasks[0], mockTasks[1], mockTasks[2]],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [createMockGroups(mockTasks)[0], createMockGroups(mockTasks)[1], createMockGroups(mockTasks)[2]],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		const pinnedFolder = screen.getByTestId("preview-pinned-folder-folder-1")
		expect(pinnedFolder).toHaveAttribute("data-expanded", "false")

		fireEvent.click(pinnedFolder)
		expect(pinnedFolder).toHaveAttribute("data-expanded", "true")

		// Toggle back
		fireEvent.click(pinnedFolder)
		expect(pinnedFolder).toHaveAttribute("data-expanded", "false")
	})

	it("sends switchTab message when view all history is clicked", () => {
		mockUseTaskSearch.mockReturnValue(defaultSearchResult)
		mockUseGroupedTasks.mockReturnValue({
			groups: createMockGroups(mockTasks),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		const viewAllButton = screen.getByLabelText("history:viewAllHistory")
		fireEvent.click(viewAllButton)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "switchTab", tab: "history" })
	})

	it("renders baseline fallback with groups and no organization features", () => {
		// Force the organization-aware inner preview to throw
		mockUseTaskOrganization.mockImplementation(() => {
			throw new Error("forced organization failure")
		})

		mockUseTaskSearch.mockReturnValue(defaultSearchResult)
		mockUseGroupedTasks.mockReturnValue({
			groups: createMockGroups(mockTasks),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			render(<HistoryPreview />)

			// Baseline: first four compact groups visible
			expect(screen.getByTestId("task-group-task-1")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-task-2")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-task-3")).toBeInTheDocument()
			expect(screen.getByTestId("task-group-task-4")).toBeInTheDocument()
			expect(screen.queryByTestId("task-group-task-5")).not.toBeInTheDocument()

			// No pinned section in baseline
			expect(screen.queryByTestId("preview-pinned-section")).not.toBeInTheDocument()
		} finally {
			consoleErrorSpy.mockRestore()
			consoleWarnSpy.mockRestore()
		}
	})

	it("baseline fallback view all button sends switchTab message", () => {
		mockUseTaskOrganization.mockImplementation(() => {
			throw new Error("forced organization failure")
		})

		mockUseTaskSearch.mockReturnValue(defaultSearchResult)
		mockUseGroupedTasks.mockReturnValue({
			groups: createMockGroups(mockTasks),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			render(<HistoryPreview />)

			const viewAllButton = screen.getByLabelText("history:viewAllHistory")
			fireEvent.click(viewAllButton)

			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "switchTab", tab: "history" })
		} finally {
			consoleErrorSpy.mockRestore()
			consoleWarnSpy.mockRestore()
		}
	})

	it("baseline fallback renders empty state when no groups exist", () => {
		mockUseTaskOrganization.mockImplementation(() => {
			throw new Error("forced organization failure")
		})

		mockUseTaskSearch.mockReturnValue({ ...defaultSearchResult, tasks: [] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			render(<HistoryPreview />)

			// No task groups rendered
			expect(screen.queryByTestId(/task-group-/)).not.toBeInTheDocument()
		} finally {
			consoleErrorSpy.mockRestore()
			consoleWarnSpy.mockRestore()
		}
	})

	it("renders autoGroup targets with subtasks correctly", () => {
		const parentTask = mockTasks[0]
		const subtask: HistoryItem = {
			id: "task-1-sub",
			number: 1,
			task: "Subtask",
			ts: 550,
			tokensIn: 50,
			tokensOut: 25,
			totalCost: 0.005,
			workspace: "/test/workspace",
		}

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [parentTask, subtask],
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [createGroupWithSubtasks(parentTask, [subtask])],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		expect(screen.getByTestId("task-group-task-1")).toBeInTheDocument()
	})

	it("filters pins by workspace visibility", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			pins: [
				{ target: { kind: "task", taskId: "task-1" }, pinnedAt: 100 },
				{ target: { kind: "task", taskId: "task-other-ws" }, pinnedAt: 200 }, // not in current tasks
			],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: () => false,
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: [mockTasks[0]], // Only task-1 in workspace
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: [createMockGroups(mockTasks)[0]],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		// Only task-1 pin should be visible
		expect(screen.getByTestId("preview-pinned-unit-task-1")).toBeInTheDocument()
		expect(screen.queryByTestId("preview-pinned-unit-task-other-ws")).not.toBeInTheDocument()
	})

	it("renders mixed content with pins, folders, and unfiled groups", () => {
		const orgState: TaskOrganizationStateV1 = {
			...createEmptyOrganizationState(),
			folders: [
				{
					folderId: "folder-1",
					name: "Folder A",
					taskIds: ["task-1"],
					createdAt: 1,
					updatedAt: 1,
				},
			],
			pins: [{ target: { kind: "task", taskId: "task-5" }, pinnedAt: 100 }],
		}

		mockUseTaskOrganization.mockReturnValue({
			organization: orgState,
			isPinned: (target: any) => target.kind === "task" && target.taskId === "task-5",
			canPin: true,
			togglePin: vi.fn(),
			createFolder: vi.fn(),
			renameFolder: vi.fn(),
			deleteFolder: vi.fn(),
			moveToFolder: vi.fn(),
			removeFromFolder: vi.fn(),
		})

		mockUseTaskSearch.mockReturnValue({
			...defaultSearchResult,
			tasks: mockTasks,
		})
		mockUseGroupedTasks.mockReturnValue({
			groups: createMockGroups(mockTasks),
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryPreview />)

		// All sections present
		expect(screen.getByTestId("preview-pinned-section")).toBeInTheDocument()
		expect(screen.getByTestId("preview-folder-folder-1")).toBeInTheDocument()
		// Unfiled groups rendered
		expect(screen.getByTestId("task-group-task-2")).toBeInTheDocument()
	})
})
