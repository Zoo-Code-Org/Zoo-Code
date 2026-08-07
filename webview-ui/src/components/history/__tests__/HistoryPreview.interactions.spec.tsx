import { render, screen, fireEvent } from "@/utils/test-utils"
import React from "react"
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

// Capture the resolveDragLabel the preview passes to the DnD surface so we can
// drive every label branch directly. When `isFolderMemberDragActive` is true
// the UnfiledDropZone body renders too.
let capturedResolveDragLabel: ((activeDrag: any) => React.ReactNode) | null = null
vi.mock("../TaskOrganizationDndSurface", () => ({
	TaskOrganizationDndSurface: ({
		children,
		resolveDragLabel,
	}: {
		children: (args: { isFolderMemberDragActive: boolean }) => React.ReactNode
		resolveDragLabel?: (activeDrag: any) => React.ReactNode
	}) => {
		capturedResolveDragLabel = resolveDragLabel ?? null
		return <>{children({ isFolderMemberDragActive: true })}</>
	},
}))

vi.mock("../TaskOrganizationInteractionContext", async () => {
	const actual = await vi.importActual<typeof import("../TaskOrganizationInteractionContext")>(
		"../TaskOrganizationInteractionContext",
	)
	return {
		...actual,
		useTaskOrganization: vi.fn(),
	}
})

import { useTaskSearch } from "../useTaskSearch"
import { useGroupedTasks } from "../useGroupedTasks"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useTaskOrganization } from "../TaskOrganizationInteractionContext"

const mockUseTaskSearch = useTaskSearch as any
const mockUseGroupedTasks = useGroupedTasks as any
const mockUseExtensionState = useExtensionState as any
const mockUseTaskOrganization = useTaskOrganization as any

function emptyOrg(): TaskOrganizationStateV1 {
	return { schemaVersion: 1, revision: 0, folders: [], pins: [], updatedAt: 0 }
}

function makeTask(id: string): HistoryItem {
	return {
		id,
		number: 1,
		task: `Task ${id}`,
		ts: 100,
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
	}
}

function makeGroups(tasks: HistoryItem[]): TaskGroup[] {
	return tasks.map((task) => ({ parent: { ...task, isSubtask: false }, subtasks: [], isExpanded: false }))
}

function setup(tasks: HistoryItem[], organization: TaskOrganizationStateV1) {
	mockUseExtensionState.mockReturnValue({
		taskOrganization: organization,
		mutateTaskOrganization: vi.fn().mockResolvedValue({ requestId: "", success: true, committedRevision: 1 }),
		cwd: "/test/workspace",
	})
	mockUseTaskOrganization.mockReturnValue({
		organization,
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
		tasks,
		searchQuery: "",
		setSearchQuery: vi.fn(),
		sortOption: "newest",
		setSortOption: vi.fn(),
		lastNonRelevantSort: null,
		setLastNonRelevantSort: vi.fn(),
		showAllWorkspaces: false,
		setShowAllWorkspaces: vi.fn(),
	})
	mockUseGroupedTasks.mockReturnValue({
		groups: makeGroups(tasks),
		flatTasks: null,
		toggleExpand: vi.fn(),
		isSearchMode: false,
	})
}

describe("HistoryPreview interactions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturedResolveDragLabel = null
	})

	it("renders the unfiled drop-zone body while a folder member drag is active", () => {
		const tasks = [makeTask("task-1")]
		setup(tasks, emptyOrg())
		render(<HistoryPreview />)

		expect(screen.getByTestId("unfiled-drop-zone")).toBeInTheDocument()
	})

	it("toggles a manual folder's expanded member list", () => {
		const tasks = [makeTask("task-1"), makeTask("task-2")]
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["task-1"], createdAt: 1, updatedAt: 1 }],
		}
		setup(tasks, organization)
		render(<HistoryPreview />)

		// Initially collapsed: member is not rendered.
		expect(screen.queryByTestId("task-group-task-1")).not.toBeInTheDocument()

		// Expand -> member list appears (toggleFolderExpand add branch).
		fireEvent.click(screen.getByTestId("folder-expand-toggle"))
		expect(screen.getByTestId("task-group-task-1")).toBeInTheDocument()

		// Collapse -> member list is removed (toggleFolderExpand delete branch).
		fireEvent.click(screen.getByTestId("folder-expand-toggle"))
		expect(screen.queryByTestId("task-group-task-1")).not.toBeInTheDocument()
	})

	it("toggles a pinned folder's inline member list", () => {
		const tasks = [makeTask("task-1"), makeTask("task-2")]
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["task-1"], createdAt: 1, updatedAt: 1 }],
			pins: [{ target: { kind: "folder", folderId: "folder-1" }, pinnedAt: 100 }],
		}
		setup(tasks, organization)
		render(<HistoryPreview />)

		const pinnedCard = screen.getByTestId("preview-pinned-folder-folder-1")

		// Pinned folder starts collapsed: no member rows.
		expect(screen.queryByTestId("task-group-task-1")).not.toBeInTheDocument()

		// Expand via the pinned card's label button (togglePinnedFolderExpand add branch).
		fireEvent.click(pinnedCard.querySelector('[data-testid="pinned-item-label"]') as HTMLElement)
		expect(screen.getByTestId("task-group-task-1")).toBeInTheDocument()

		// Collapse (delete branch).
		fireEvent.click(pinnedCard.querySelector('[data-testid="pinned-item-label"]') as HTMLElement)
		expect(screen.queryByTestId("task-group-task-1")).not.toBeInTheDocument()
	})

	it("resolves drag labels for folder, task, autoGroup, and unknown targets", () => {
		const tasks = [makeTask("task-1"), makeTask("task-2")]
		const organization: TaskOrganizationStateV1 = {
			...emptyOrg(),
			folders: [{ folderId: "folder-1", name: "My Folder", taskIds: ["task-1"], createdAt: 1, updatedAt: 1 }],
		}
		setup(tasks, organization)
		render(<HistoryPreview />)

		expect(capturedResolveDragLabel).not.toBeNull()
		const label = capturedResolveDragLabel!

		// data.kind === "folder" with a known folder -> folder name.
		expect(label({ data: { kind: "folder", folderId: "folder-1" } })).toBe("My Folder")
		// data.kind === "folder" with an unknown folder -> falls back to the id.
		expect(label({ data: { kind: "folder", folderId: "missing" } })).toBe("missing")
		// target.kind === "task" with a known task -> task text.
		expect(label({ data: { kind: "task", target: { kind: "task", taskId: "task-2" } } })).toBe("Task task-2")
		// target.kind === "task" unknown -> falls back to the id.
		expect(label({ data: { kind: "task", target: { kind: "task", taskId: "ghost" } } })).toBe("ghost")
		// target.kind === "autoGroup" known -> task text of the root.
		expect(label({ data: { kind: "task", target: { kind: "autoGroup", rootTaskId: "task-1" } } })).toBe(
			"Task task-1",
		)
		// target.kind === "autoGroup" unknown -> root id.
		expect(label({ data: { kind: "task", target: { kind: "autoGroup", rootTaskId: "ghost-root" } } })).toBe(
			"ghost-root",
		)
		// target.kind === "folder" known -> folder name.
		expect(label({ data: { kind: "task", target: { kind: "folder", folderId: "folder-1" } } })).toBe("My Folder")
		// target.kind === "folder" unknown -> folder id.
		expect(label({ data: { kind: "task", target: { kind: "folder", folderId: "missing" } } })).toBe("missing")
	})
})
