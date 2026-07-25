import type { HistoryItem, TaskOrganizationTargetV1, TaskOrganizationStateV1 } from "@roo-code/types"

/**
 * Extended HistoryItem with display-related fields for search highlighting and subtask indication
 */
export interface DisplayHistoryItem extends HistoryItem {
	/** HTML string with search match highlighting */
	highlight?: string
	/** Whether this task is a subtask (has a parent in the current task list) */
	isSubtask?: boolean
}

/**
 * A node in the subtask tree, representing a task and its recursively nested children.
 */
export interface SubtaskTreeNode {
	/** The task at this tree node */
	item: DisplayHistoryItem
	/** Recursively nested child subtasks */
	children: SubtaskTreeNode[]
	/** Whether this node's children are expanded in the UI */
	isExpanded: boolean
}

/**
 * Recursively counts all subtasks in a tree of SubtaskTreeNodes.
 */
export function countAllSubtasks(nodes: SubtaskTreeNode[]): number {
	let count = 0
	for (const node of nodes) {
		count += 1 + countAllSubtasks(node.children)
	}
	return count
}

/**
 * A group of tasks consisting of a parent task and its nested subtask tree
 */
export interface TaskGroup {
	/** The parent task */
	parent: DisplayHistoryItem
	/** Tree of subtasks (supports arbitrary nesting depth) */
	subtasks: SubtaskTreeNode[]
	/** Whether the subtask list is expanded */
	isExpanded: boolean
}

/**
 * Result from the useGroupedTasks hook
 */
export interface GroupedTasksResult {
	/** Groups of tasks (parent + subtasks) - used in normal view */
	groups: TaskGroup[]
	/** Flat list of tasks with isSubtask flag - used in search mode */
	flatTasks: DisplayHistoryItem[] | null
	/** Function to toggle expand/collapse state of a group */
	toggleExpand: (taskId: string) => void
	/** Whether search mode is active */
	isSearchMode: boolean
}

/**
 * Display categories for virtual history entries.
 */
export type DisplayCategory = "pinned" | "manualFolder" | "unfiled"

/**
 * A canonical task unit that has been resolved from its automatic group.
 */
export interface ResolvedTaskUnit {
	/** The kind of organization target this unit represents */
	target: TaskOrganizationTargetV1
	/** The root task ID (same as taskId for standalone tasks) */
	rootTaskId: string
	/** All task IDs belonging to the unit, including descendants for auto groups */
	closureTaskIds: string[]
}

/**
 * A single flattened row shown by the virtualized history list.
 */
export interface VirtualDisplayEntry {
	/** Stable unique key for the row */
	id: string
	/** Rendering category */
	category: DisplayCategory
	/** For folder rows, the folder identifier */
	folderId?: string
	/** For folder rows, the display name */
	folderName?: string
	/** For rows representing an organization unit inside a folder or unfiled */
	unit?: ResolvedTaskUnit
	/** True when this entry is a pinned shortcut */
	isPinned?: boolean
	/** Pin order index, stable across sections */
	pinIndex?: number
}

/**
 * Projection used by the Recent Tasks preview: up to four compact slots.
 */
export interface RecentTaskSlot {
	/** The kind of slot */
	category: DisplayCategory
	/** The pinned target or folder/unit to render */
	unit?: ResolvedTaskUnit
	/** For folder slots, the folder identifier */
	folderId?: string
	/** For folder slots, the display name */
	folderName?: string
}

/**
 * UI-local projection of one manual folder as a list of TaskGroup members.
 *
 * Members preserve the original TaskGroup object identity and the folder's
 * taskIds insertion order. A canonical root appears in at most one folder.
 */
export interface GroupedFolderProjection {
	/** Folder identifier */
	folderId: string
	/** Folder display name */
	folderName: string
	/** TaskGroup members in folder taskIds insertion order */
	members: TaskGroup[]
	/**
	 * Number of member groups hidden by Current Workspace filtering.
	 * Zero when no workspace filter is active.
	 */
	hiddenCount: number
}

/**
 * UI-local grouped projection of the manual organization state.
 *
 * Folders and unfiled groups both reference the original TaskGroup objects
 * from useGroupedTasks; no re-grouping or flattening is performed. Each
 * canonical root appears in exactly one location (a folder or unfiledGroups).
 */
export interface GroupedOrganizationProjection {
	/** Folder projections in folder creation order (newest first) */
	folderProjections: GroupedFolderProjection[]
	/** Groups not assigned to any folder, preserving groupedTasks order */
	unfiledGroups: TaskGroup[]
	/** Canonical root task IDs that are pinned (shortcut rendering hint) */
	pinnedRootIds: Set<string>
}

/**
 * Read-only input consumed by the task organization display model.
 */
export interface TaskOrganizationDisplayInput {
	/** Current organization aggregate from the extension host */
	organization: TaskOrganizationStateV1
	/** Grouped tasks from useGroupedTasks */
	groupedTasks: TaskGroup[]
	/** Flat task list (used for workspace filtering and closure resolution) */
	tasks: HistoryItem[]
	/** Whether to show tasks from all workspaces */
	showAllWorkspaces: boolean
	/** Current workspace directory */
	cwd: string | undefined
}

/**
 * Complete display model produced by buildTaskOrganizationDisplayModel.
 */
export interface TaskOrganizationDisplayModel {
	/** Flat virtualized entries for the full History view */
	entries: VirtualDisplayEntry[]
	/** Recent Tasks four-slot projection */
	recentSlots: RecentTaskSlot[]
}
