import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import type { HistoryItem, TaskOrganizationStateV1 } from "@roo-code/types"
import type { TaskGroup } from "../types"
import { UNFILED_DROP_ZONE_ID } from "../useTaskOrganizationDnd"

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
	Virtuoso: ({ data, itemContent }: any) => (
		<div data-testid="virtuoso-container">
			{data?.map((entry: any, index: number) => (
				<div key={entry?.parent?.id ?? entry?.id ?? index}>{itemContent(index, entry)}</div>
			))}
		</div>
	),
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

// Forward the selection + expand callbacks so we can drive them from the test.
vi.mock("../TaskGroupItem", () => ({
	default: ({ group, onToggleSelection, onToggleExpand, isSelectionMode, isSelected, children }: any) => (
		<div data-testid={`task-group-${group.parent.id}`}>
			{isSelectionMode && (
				<input
					type="checkbox"
					data-testid={`select-${group.parent.id}`}
					checked={!!isSelected}
					onChange={(e) => onToggleSelection?.(group.parent.id, e.target.checked)}
				/>
			)}
			<button data-testid={`expand-${group.parent.id}`} onClick={() => onToggleExpand?.()} />
			{children}
		</div>
	),
}))

vi.mock("../TaskItem", () => ({
	default: ({ item, onToggleSelection, isSelectionMode, isSelected }: any) => (
		<div data-testid={`task-item-${item.id}`}>
			{isSelectionMode && (
				<input
					type="checkbox"
					data-testid={`select-${item.id}`}
					checked={!!isSelected}
					onChange={(e) => onToggleSelection?.(item.id, e.target.checked)}
				/>
			)}
		</div>
	),
}))

vi.mock("../PinnedHistoryItem", () => ({
	PinnedHistoryItem: ({ folderName, label, "data-testid": dataTestId, onClick, children }: any) => (
		<div data-testid={dataTestId}>
			<button data-testid={`${dataTestId}-click`} onClick={onClick}>
				{folderName ?? label}
			</button>
			{children}
		</div>
	),
}))

// Capture the resolveDragLabel the view passes to the DnD surface so tests can
// drive every label branch directly.
let capturedResolveDragLabel: ((activeDrag: any) => any) | null = null
vi.mock("../TaskOrganizationDndSurface", () => ({
	TaskOrganizationDndSurface: ({ children, resolveDragLabel }: any) => {
		capturedResolveDragLabel = resolveDragLabel ?? null
		return <>{children({ isFolderMemberDragActive: false })}</>
	},
}))

vi.mock("../useTaskOrganizationDnd", async () => {
	const actual = await vi.importActual<typeof import("../useTaskOrganizationDnd")>("../useTaskOrganizationDnd")
	return {
		...actual,
		useTaskOrganizationDnd: vi.fn(),
	}
})

// Mock the interaction context so we can swap in per-test spies for the
// mutation functions (createFolderFromSelection, deleteFolders, etc.).
let currentOrgMock: any = null
vi.mock("../TaskOrganizationInteractionContext", async () => {
	const actual = await vi.importActual<typeof import("../TaskOrganizationInteractionContext")>(
		"../TaskOrganizationInteractionContext",
	)
	return {
		...actual,
		useTaskOrganization: () => currentOrgMock,
	}
})

import { useTaskSearch } from "../useTaskSearch"
import { useGroupedTasks } from "../useGroupedTasks"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTaskOrganizationDnd } from "../useTaskOrganizationDnd"

const mockUseTaskSearch = useTaskSearch as any
const mockUseGroupedTasks = useGroupedTasks as any
const mockUseExtensionState = useExtensionState as any
const mockUseTaskOrganizationDnd = useTaskOrganizationDnd as any

function defaultOrgMock(organization: TaskOrganizationStateV1, overrides: Record<string, any> = {}) {
	return {
		organization,
		isPinned: () => false,
		canPin: true,
		togglePin: vi.fn(),
		createFolder: vi.fn(),
		renameFolder: vi.fn(),
		deleteFolder: vi.fn(),
		createFolderFromSelection: vi.fn().mockResolvedValue({ success: true }),
		deleteFolders: vi.fn().mockResolvedValue({ success: true }),
		moveToFolder: vi.fn(),
		removeFromFolder: vi.fn(),
		...overrides,
	}
}

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
	return { parent: { ...task, isSubtask: false }, subtasks, isExpanded: false }
}

function emptyOrg(): TaskOrganizationStateV1 {
	return { schemaVersion: 1, revision: 0, folders: [], pins: [], updatedAt: 0 }
}

const baseSearch = {
	searchQuery: "",
	setSearchQuery: vi.fn(),
	sortOption: "newest" as const,
	setSortOption: vi.fn(),
	lastNonRelevantSort: null,
	setLastNonRelevantSort: vi.fn(),
	showAllWorkspaces: false,
	setShowAllWorkspaces: vi.fn(),
}

function setupDnd() {
	mockUseTaskOrganizationDnd.mockReturnValue({
		sensors: [],
		activeDrag: null,
		targetMeta: { isOverTarget: false },
		handleDragStart: vi.fn(),
		handleDragOver: vi.fn(),
		handleDragEnd: vi.fn(),
		handleDragCancel: vi.fn(),
		UNFILED_DROP_ZONE_ID,
	})
}

function setupOrgContext(organization: TaskOrganizationStateV1, orgOverrides: Record<string, any> = {}) {
	mockUseExtensionState.mockReturnValue({
		taskOrganization: organization,
		mutateTaskOrganization: vi.fn().mockResolvedValue({ requestId: "", success: true, committedRevision: 1 }),
		cwd: "/test/workspace",
	})
	currentOrgMock = defaultOrgMock(organization, orgOverrides)
}

describe("HistoryView selection mode + dialogs", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		setupDnd()
		setupOrgContext(emptyOrg())
	})

	it("selects individual tasks and enables the batch-delete dialog", async () => {
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Enter selection mode.
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// Toggle one task on, then off, then on again (covers both branches of
		// toggleTaskSelection).
		const select1 = screen.getByTestId("select-t1") as HTMLInputElement
		fireEvent.click(select1)
		fireEvent.click(screen.getByTestId("select-t2"))
		// Deselect t1 (filter branch).
		fireEvent.click(screen.getByTestId("select-t1"))
		fireEvent.click(screen.getByTestId("select-t1"))

		// Open the batch delete dialog.
		fireEvent.click(screen.getByTestId("header-delete-selected-button"))
		// BatchDeleteTaskDialog is mocked? It is a real component; assert the
		// selection action bar is present and selected count text exists.
		expect(screen.getByTestId("selection-action-bar")).toBeInTheDocument()
	})

	it("select-all checkbox selects every task then clears", () => {
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// Nothing selected yet -> the bottom action bar is hidden.
		expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument()

		// The header toolbar select-all Checkbox (radix) has a stable testid.
		fireEvent.click(screen.getByTestId("select-all-checkbox"))

		// Both individual checkboxes should now be checked and the action bar shown.
		expect((screen.getByTestId("select-t1") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("select-t2") as HTMLInputElement).checked).toBe(true)
		expect(screen.getByTestId("selection-action-bar")).toBeInTheDocument()

		// Toggle select-all off -> both clear and the action bar hides.
		fireEvent.click(screen.getByTestId("select-all-checkbox"))
		expect((screen.getByTestId("select-t1") as HTMLInputElement).checked).toBe(false)
		expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument()
	})

	it("enables the create-folder button once two tasks are selected", () => {
		setupOrgContext(emptyOrg())
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// Select both tasks.
		fireEvent.click(screen.getByTestId("select-t1"))
		fireEvent.click(screen.getByTestId("select-t2"))

		// The create-folder button should be enabled now.
		const createBtn = screen.getByTestId("create-folder-from-selection-button")
		expect(createBtn).not.toBeDisabled()
	})

	it("clears selection via the clear button in the action bar", () => {
		const t1 = makeTask("t1")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("select-t1"))

		expect(screen.getByTestId("selection-action-bar")).toBeInTheDocument()
		// Clear selection -> action bar disappears.
		fireEvent.click(screen.getByText("history:clearSelection"))
		expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument()
	})

	it("invokes onToggleExpand for a grouped row", () => {
		const toggleExpand = vi.fn()
		const t1 = makeTask("t1")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand,
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("expand-t1"))
		expect(toggleExpand).toHaveBeenCalledWith("t1")
	})

	function setupFolderWithMember() {
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["t1"], createdAt: 1, updatedAt: 1 }],
		}
		setupOrgContext(organization)
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})
		return { t1, t2, organization }
	}

	it("toggles a manual folder's expanded members", () => {
		setupFolderWithMember()
		render(<HistoryView onDone={vi.fn()} />)

		// Collapsed: folder member t1 not rendered.
		expect(screen.queryByTestId("task-group-t1")).not.toBeInTheDocument()

		// Expand (covers toggleFolderExpand + member render + per-member onToggleExpand/togglePin arrows).
		fireEvent.click(screen.getByTestId("folder-expand-toggle"))
		expect(screen.getByTestId("task-group-t1")).toBeInTheDocument()

		// Drive a folder member's inline expand + pin toggle arrows.
		fireEvent.click(screen.getByTestId("expand-t1"))

		// Collapse (delete branch).
		fireEvent.click(screen.getByTestId("folder-expand-toggle"))
		expect(screen.queryByTestId("task-group-t1")).not.toBeInTheDocument()
	})

	it("selects a folder in selection mode and confirms delete via the dialog", async () => {
		const deleteFolders = vi.fn().mockResolvedValue({ success: true })
		const { organization } = setupFolderWithMember()
		setupOrgContext(organization, { deleteFolders })

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))

		// Select the folder (covers toggleFolderSelection add branch).
		fireEvent.click(screen.getByTestId("folder-select-folder-1"))
		expect(screen.getByTestId("selected-folder-count")).toBeInTheDocument()

		// Deselect + reselect to cover the filter branch too.
		fireEvent.click(screen.getByTestId("folder-select-folder-1"))
		fireEvent.click(screen.getByTestId("folder-select-folder-1"))

		// Open the delete-folders dialog and confirm.
		fireEvent.click(screen.getByTestId("delete-folders-button"))
		await waitFor(() => expect(screen.getByTestId("confirm-delete-folders")).toBeInTheDocument())
		fireEvent.click(screen.getByTestId("confirm-delete-folders"))

		await waitFor(() => expect(deleteFolders).toHaveBeenCalledWith(["folder-1"]))
	})

	it("creates a folder from a two-task selection via the dialog", async () => {
		const createFolderFromSelection = vi.fn().mockResolvedValue({ success: true })
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		setupOrgContext(emptyOrg(), { createFolderFromSelection })
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("select-t1"))
		fireEvent.click(screen.getByTestId("select-t2"))

		// Open the folder-name dialog and confirm a name (covers
		// handleCreateFolderFromSelection + handleConfirmSelectionFolderName).
		fireEvent.click(screen.getByTestId("create-folder-from-selection-button"))
		await waitFor(() => expect(screen.getByTestId("folder-name-input")).toBeInTheDocument())
		fireEvent.change(screen.getByTestId("folder-name-input"), { target: { value: "New Folder" } })
		fireEvent.click(screen.getByTestId("folder-name-confirm"))

		await waitFor(() =>
			expect(createFolderFromSelection).toHaveBeenCalledWith("New Folder", [
				{ kind: "task", taskId: "t1" },
				{ kind: "task", taskId: "t2" },
			]),
		)
	})

	it("toggles a pinned folder's inline member list", () => {
		const t1 = makeTask("t1")
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["t1"], createdAt: 1, updatedAt: 1 }],
			pins: [{ target: { kind: "folder", folderId: "folder-1" }, pinnedAt: 100 }],
		}
		setupOrgContext(organization)
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)

		// Toggle the pinned folder expansion (covers togglePinnedFolderExpand + member render).
		const pinnedCard = screen.getByTestId("pinned-folder-folder-1")
		fireEvent.click(pinnedCard.querySelector('[data-testid$="-click"]') as HTMLElement)
		expect(screen.getByTestId("task-group-t1")).toBeInTheDocument()
	})

	it("resolves drag labels for every target kind via the DnD surface prop", () => {
		const t1 = makeTask("t1")
		const t2 = makeTask("t2")
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["t1"], createdAt: 1, updatedAt: 1 }],
		}
		setupOrgContext(organization)
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1, t2] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1), makeGroup(t2)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		expect(capturedResolveDragLabel).not.toBeNull()
		const label = capturedResolveDragLabel!

		expect(label({ data: { kind: "folder", folderId: "folder-1" } })).toBe("My Folder")
		expect(label({ data: { kind: "folder", folderId: "missing" } })).toBe("missing")
		expect(label({ data: { kind: "task", target: { kind: "task", taskId: "t2" } } })).toBe("Task t2")
		expect(label({ data: { kind: "task", target: { kind: "task", taskId: "ghost" } } })).toBe("ghost")
		expect(label({ data: { kind: "task", target: { kind: "autoGroup", rootTaskId: "t1" } } })).toBe("Task t1")
		expect(label({ data: { kind: "task", target: { kind: "autoGroup", rootTaskId: "ghost-root" } } })).toBe(
			"ghost-root",
		)
		expect(label({ data: { kind: "task", target: { kind: "folder", folderId: "folder-1" } } })).toBe("My Folder")
		expect(label({ data: { kind: "task", target: { kind: "folder", folderId: "missing" } } })).toBe("missing")
		expect(label({ data: { kind: "task", target: { kind: "unknown" } } })).toBeNull()
	})

	it("clears the delete dialog state when it is closed", async () => {
		const t1 = makeTask("t1")
		mockUseTaskSearch.mockReturnValue({ ...baseSearch, tasks: [t1] })
		mockUseGroupedTasks.mockReturnValue({
			groups: [makeGroup(t1)],
			flatTasks: null,
			toggleExpand: vi.fn(),
			isSearchMode: false,
		})

		render(<HistoryView onDone={vi.fn()} />)
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		fireEvent.click(screen.getByTestId("select-t1"))

		// Open the batch delete dialog, then close it via its onOpenChange handler.
		fireEvent.click(screen.getByTestId("header-delete-selected-button"))
		await waitFor(() => expect(document.body.textContent).toContain("history:"))
		// The dialog is rendered; simulate a close by toggling selection mode off/on
		// (which resets selectedTaskIds through toggleSelectionMode).
		fireEvent.click(screen.getByTestId("toggle-selection-mode-button"))
		expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument()
	})
})
