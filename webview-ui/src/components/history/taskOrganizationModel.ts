import type { HistoryItem, TaskOrganizationStateV1, TaskOrganizationTargetV1 } from "@roo-code/types"

import type {
	GroupedFolderProjection,
	GroupedOrganizationProjection,
	ResolvedTaskUnit,
	TaskGroup,
	VirtualDisplayEntry,
	RecentTaskSlot,
} from "./types"

/**
 * Pure helpers that build a display projection over task organization state
 * and the existing grouped-task output.
 *
 * This module intentionally has no React dependency so it can be tested in
 * isolation and reused between the full History view and Recent Tasks.
 */

/**
 * Recursively collects all descendant IDs of a root task that exist in the
 * provided task map. Cycles are terminated by a visited set.
 */
function collectDescendants(rootId: string, taskMap: Map<string, HistoryItem>, visited: Set<string>): string[] {
	const result: string[] = []
	const stack: string[] = [rootId]

	while (stack.length > 0) {
		const current = stack.pop()!
		if (visited.has(current)) {
			continue
		}
		visited.add(current)

		const task = taskMap.get(current)
		if (!task) {
			continue
		}

		result.push(current)

		const childIds = task.childIds
		if (childIds && childIds.length > 0) {
			for (let i = childIds.length - 1; i >= 0; i--) {
				const childId = childIds[i]
				if (!visited.has(childId) && taskMap.has(childId)) {
					stack.push(childId)
				}
			}
		}
	}

	return result
}

/**
 * Finds the highest known ancestor of a task ID in the current task map.
 * If the task itself is unknown, returns the provided id.
 */
function findRootTaskId(taskId: string, taskMap: Map<string, HistoryItem>): string {
	let current = taskId
	const visited = new Set<string>()

	while (!visited.has(current)) {
		visited.add(current)
		const task = taskMap.get(current)
		if (!task) {
			return current
		}
		const parentId = task.parentTaskId
		if (parentId && taskMap.has(parentId)) {
			current = parentId
		}
	}

	return current
}

/**
 * Builds a resolved task unit from a single task or automatic group root.
 * If the task has descendants in taskMap, the unit represents the whole
 * automatic group; otherwise it represents a standalone task.
 */
function buildTaskUnit(rootId: string, taskMap: Map<string, HistoryItem>, visited: Set<string>): ResolvedTaskUnit {
	const closure = collectDescendants(rootId, taskMap, visited)
	const target: TaskOrganizationTargetV1 =
		closure.length > 1 ? { kind: "autoGroup", rootTaskId: rootId } : { kind: "task", taskId: rootId }

	return {
		target,
		rootTaskId: rootId,
		closureTaskIds: closure,
	}
}

/**
 * Resolves any task or auto-group ID to its root task ID using the current
 * task map, then returns a ResolvedTaskUnit covering the full closure.
 */
export function resolveOrganizationUnit(taskId: string, tasks: HistoryItem[]): ResolvedTaskUnit {
	const taskMap = buildTaskMap(tasks)
	const rootId = findRootTaskId(taskId, taskMap)
	return buildTaskUnit(rootId, taskMap, new Set())
}

/**
 * Normalizes a task or child ID to the canonical parent task ID of its
 * automatic group. Returns the root task ID.
 */
export function buildCanonicalTarget(taskId: string, groupedTasks: TaskGroup[]): string {
	for (const group of groupedTasks) {
		if (group.parent.id === taskId) {
			return group.parent.id
		}
		const found = findSubtaskId(group.parent.id, group.subtasks, taskId)
		if (found) {
			return group.parent.id
		}
	}
	return taskId
}

function findSubtaskId(
	parentId: string,
	subtasks: import("./types").SubtaskTreeNode[],
	targetId: string,
): string | null {
	for (const node of subtasks) {
		if (node.item.id === targetId) {
			return parentId
		}
		const found = findSubtaskId(parentId, node.children, targetId)
		if (found) {
			return found
		}
	}
	return null
}

function buildTaskMap(tasks: HistoryItem[]): Map<string, HistoryItem> {
	const map = new Map<string, HistoryItem>()
	for (const task of tasks) {
		map.set(task.id, task)
	}
	return map
}

function buildChildrenMap(tasks: HistoryItem[]): Map<string, string[]> {
	const childrenMap = new Map<string, string[]>()
	for (const task of tasks) {
		const parentId = task.parentTaskId
		if (parentId) {
			const siblings = childrenMap.get(parentId) || []
			siblings.push(task.id)
			childrenMap.set(parentId, siblings)
		}
	}
	return childrenMap
}

/**
 * Builds a map of every task ID that belongs to a folder to that folder's ID.
 * A task is mapped only to its first folder occurrence (folders are not nested,
 * but this also guards against duplicate membership on corrupt data).
 */
export function buildFolderMembershipMap(folders: TaskOrganizationStateV1["folders"]): Map<string, string> {
	const membership = new Map<string, string>()
	for (const folder of folders) {
		for (const taskId of folder.taskIds) {
			if (!membership.has(taskId)) {
				membership.set(taskId, folder.folderId)
			}
		}
	}
	return membership
}

function targetKey(target: TaskOrganizationTargetV1): string {
	switch (target.kind) {
		// Task and auto-group targets share the same canonical unit key so that
		// pinning a standalone task and its automatic group root are treated as
		// one unique pin.
		case "task":
			return `unit:${target.taskId}`
		case "autoGroup":
			return `unit:${target.rootTaskId}`
		case "folder":
			return `folder:${target.folderId}`
	}
}

/**
 * Builds the pinned-section projection: each canonical pin target is resolved
 * against current task history and grouped tasks.
 */
export function buildPinnedProjection(
	state: TaskOrganizationStateV1,
	groupedTasks: TaskGroup[],
	tasks: HistoryItem[],
): VirtualDisplayEntry[] {
	const taskMap = buildTaskMap(tasks)
	const childrenMap = buildChildrenMap(tasks)
	const pinnedKeys = new Set<string>()
	const result: VirtualDisplayEntry[] = []

	for (let i = 0; i < state.pins.length; i++) {
		const pin = state.pins[i]
		const target = pin.target
		const key = targetKey(target)
		if (pinnedKeys.has(key)) {
			continue
		}
		pinnedKeys.add(key)

		if (target.kind === "folder") {
			const folder = state.folders.find((f) => f.folderId === target.folderId)
			if (!folder) {
				continue
			}
			result.push({
				id: `pinned-folder-${folder.folderId}`,
				category: "pinned",
				folderId: folder.folderId,
				folderName: folder.name,
				isPinned: true,
				pinIndex: i,
			})
			continue
		}

		const rootId =
			target.kind === "autoGroup" ? target.rootTaskId : buildCanonicalTarget(target.taskId, groupedTasks)
		const unit = resolveTaskUnitFromMaps(rootId, taskMap, childrenMap)
		if (!unit) {
			continue
		}

		result.push({
			id: `pinned-unit-${unit.rootTaskId}`,
			category: "pinned",
			unit,
			isPinned: true,
			pinIndex: i,
		})
	}

	return result
}

/**
 * Resolves a root task ID to a ResolvedTaskUnit using pre-built maps.
 * Returns undefined if the root task no longer exists.
 */
function resolveTaskUnitFromMaps(
	rootId: string,
	taskMap: Map<string, HistoryItem>,
	childrenMap: Map<string, string[]>,
): ResolvedTaskUnit | undefined {
	if (!taskMap.has(rootId)) {
		return undefined
	}
	const visited = new Set<string>()
	const closure = collectDescendantsWithMaps(rootId, taskMap, childrenMap, visited)
	const target: TaskOrganizationTargetV1 =
		closure.length > 1 ? { kind: "autoGroup", rootTaskId: rootId } : { kind: "task", taskId: rootId }
	return {
		target,
		rootTaskId: rootId,
		closureTaskIds: closure,
	}
}

function collectDescendantsWithMaps(
	rootId: string,
	taskMap: Map<string, HistoryItem>,
	childrenMap: Map<string, string[]>,
	visited: Set<string>,
): string[] {
	const result: string[] = []
	const stack: string[] = [rootId]

	while (stack.length > 0) {
		const current = stack.pop()!
		if (visited.has(current)) {
			continue
		}
		visited.add(current)

		if (!taskMap.has(current)) {
			continue
		}

		result.push(current)

		const children = childrenMap.get(current) || []
		for (let i = children.length - 1; i >= 0; i--) {
			const childId = children[i]
			if (!visited.has(childId) && taskMap.has(childId)) {
				stack.push(childId)
			}
		}
	}

	return result
}

/**
 * Filters display entries by workspace. For folders, visible members are kept
 * in Current Workspace mode; folders with no visible members are hidden unless
 * pinned. Genuinely empty folders remain visible.
 */
export function filterByWorkspace(
	entries: VirtualDisplayEntry[],
	tasks: HistoryItem[],
	cwd: string | undefined,
): VirtualDisplayEntry[] {
	if (!cwd) {
		return entries
	}

	const taskMap = buildTaskMap(tasks)
	const result: VirtualDisplayEntry[] = []
	let currentFolderId: string | undefined
	let currentFolderHeader: VirtualDisplayEntry | undefined
	let visibleMembers: VirtualDisplayEntry[] = []
	let totalMemberCount = 0

	const flushFolder = () => {
		if (currentFolderHeader) {
			const isGenuinelyEmpty = totalMemberCount === 0
			const hasVisibleMembers = visibleMembers.length > 0
			if (hasVisibleMembers || currentFolderHeader.isPinned || isGenuinelyEmpty) {
				result.push(currentFolderHeader)
				result.push(...visibleMembers)
			}
		}
		currentFolderId = undefined
		currentFolderHeader = undefined
		visibleMembers = []
		totalMemberCount = 0
	}

	for (const entry of entries) {
		if (entry.category === "manualFolder" && entry.folderId !== undefined) {
			flushFolder()
			currentFolderId = entry.folderId
			currentFolderHeader = entry
			continue
		}

		if (currentFolderId !== undefined) {
			totalMemberCount++
			if (
				entry.unit &&
				entry.unit.closureTaskIds.some((taskId) => taskBelongsToWorkspace(taskMap.get(taskId), cwd))
			) {
				visibleMembers.push(entry)
			}
			continue
		}

		if (
			entry.unit &&
			!entry.unit.closureTaskIds.some((taskId) => taskBelongsToWorkspace(taskMap.get(taskId), cwd))
		) {
			continue
		}

		result.push(entry)
	}

	flushFolder()
	return result
}

function taskBelongsToWorkspace(task: HistoryItem | undefined, cwd: string): boolean {
	if (!task) {
		return false
	}
	const workspace = task.workspace || ""
	// Normalize separators for Windows paths so comparisons work across environments.
	const normalizedWorkspace = workspace.replace(/\\/g, "/")
	const normalizedCwd = cwd.replace(/\\/g, "/")
	return normalizedWorkspace === normalizedCwd || normalizedWorkspace.endsWith(`/${normalizedCwd}`)
}

/**
 * Produces the full flat display list for the History view.
 *
 * Order: pinned shortcuts, manual folders (newest first), unfiled automatic
 * groups and standalone tasks preserving the grouped-task order.
 */
export function buildFlattenedVirtualEntries(
	state: TaskOrganizationStateV1,
	groupedTasks: TaskGroup[],
	tasks: HistoryItem[],
): VirtualDisplayEntry[] {
	const result: VirtualDisplayEntry[] = []
	const pinnedEntries = buildPinnedProjection(state, groupedTasks, tasks)
	result.push(...pinnedEntries)

	const pinnedUnitKeys = new Set<string>()
	const pinnedFolderIds = new Set<string>()
	for (const entry of pinnedEntries) {
		if (entry.folderId) {
			pinnedFolderIds.add(entry.folderId)
		} else if (entry.unit) {
			pinnedUnitKeys.add(entry.unit.rootTaskId)
		}
	}

	const taskMap = buildTaskMap(tasks)
	const childrenMap = buildChildrenMap(tasks)
	const membershipMap = buildFolderMembershipMap(state.folders)
	const assignedTaskIds = new Set<string>()

	// Manual folders, sorted by creation time descending (newest first).
	const sortedFolders = state.folders.slice().sort((a, b) => b.createdAt - a.createdAt)

	for (const folder of sortedFolders) {
		const isPinned = pinnedFolderIds.has(folder.folderId)
		result.push({
			id: `folder-${folder.folderId}`,
			category: "manualFolder",
			folderId: folder.folderId,
			folderName: folder.name,
			isPinned,
		})

		for (const taskId of folder.taskIds) {
			const rootId = findRootTaskId(taskId, taskMap)
			if (assignedTaskIds.has(rootId)) {
				continue
			}
			assignedTaskIds.add(rootId)
			const unit = resolveTaskUnitFromMaps(rootId, taskMap, childrenMap)
			if (!unit) {
				continue
			}
			result.push({
				id: `folder-${folder.folderId}-unit-${unit.rootTaskId}`,
				category: "manualFolder",
				unit,
			})
		}
	}

	// Unfiled groups and standalone tasks, preserving groupedTasks order.
	for (const group of groupedTasks) {
		const rootId = group.parent.id
		if (membershipMap.has(rootId)) {
			continue
		}
		if (pinnedUnitKeys.has(rootId)) {
			continue
		}
		if (assignedTaskIds.has(rootId)) {
			continue
		}

		const unit = resolveTaskUnitFromMaps(rootId, taskMap, childrenMap)
		if (!unit) {
			continue
		}
		result.push({
			id: `unfiled-unit-${unit.rootTaskId}`,
			category: "unfiled",
			unit,
		})
	}

	return result
}

/**
 * Builds the Recent Tasks four-slot projection.
 *
 * Pins are included first in pin order, then folders in creation order, then
 * recent unfiled groups until all four slots are filled. A top-level pinned
 * folder or unfiled group is de-duplicated from the secondary slots.
 */
export function buildRecentTasksProjection(
	state: TaskOrganizationStateV1,
	groupedTasks: TaskGroup[],
	tasks: HistoryItem[],
	maxSlots: number = 4,
): RecentTaskSlot[] {
	if (maxSlots <= 0) {
		return []
	}

	const result: RecentTaskSlot[] = []
	const usedKeys = new Set<string>()
	const taskMap = buildTaskMap(tasks)
	const childrenMap = buildChildrenMap(tasks)
	const membershipMap = buildFolderMembershipMap(state.folders)

	// 1. Valid pins first, in pin order.
	for (const pin of state.pins) {
		if (result.length >= maxSlots) {
			break
		}

		const target = pin.target
		if (target.kind === "folder") {
			const folder = state.folders.find((f) => f.folderId === target.folderId)
			if (!folder) {
				continue
			}
			const key = `folder:${folder.folderId}`
			if (usedKeys.has(key)) {
				continue
			}
			usedKeys.add(key)
			result.push({
				category: "pinned",
				folderId: folder.folderId,
				folderName: folder.name,
			})
			continue
		}

		const rootId =
			target.kind === "autoGroup" ? target.rootTaskId : buildCanonicalTarget(target.taskId, groupedTasks)
		const unit = resolveTaskUnitFromMaps(rootId, taskMap, childrenMap)
		if (!unit) {
			continue
		}
		const key = `unit:${unit.rootTaskId}`
		if (usedKeys.has(key)) {
			continue
		}
		usedKeys.add(key)
		result.push({
			category: "pinned",
			unit,
		})
	}

	// 2. Fill remaining slots from manual folders in creation order (newest first).
	const sortedFolders = state.folders.slice().sort((a, b) => b.createdAt - a.createdAt)
	for (const folder of sortedFolders) {
		if (result.length >= maxSlots) {
			break
		}
		const key = `folder:${folder.folderId}`
		if (usedKeys.has(key)) {
			continue
		}
		usedKeys.add(key)
		result.push({
			category: "manualFolder",
			folderId: folder.folderId,
			folderName: folder.name,
		})
	}

	// 3. Fill remaining slots from recent unfiled groups.
	for (const group of groupedTasks) {
		if (result.length >= maxSlots) {
			break
		}
		const rootId = group.parent.id
		if (membershipMap.has(rootId)) {
			continue
		}
		const key = `unit:${rootId}`
		if (usedKeys.has(key)) {
			continue
		}
		usedKeys.add(key)
		const unit = resolveTaskUnitFromMaps(rootId, taskMap, childrenMap)
		if (!unit) {
			continue
		}
		result.push({
			category: "unfiled",
			unit,
		})
	}

	return result
}

/**
 * Builds a grouped manual-organization projection over the existing
 * grouped-task output without flattening or regrouping.
 *
 * Contract:
 * - Each folder yields one projection preserving its taskIds insertion order.
 * - Folder members reference the original TaskGroup objects (identity kept).
 * - A canonical root appears in at most one folder; otherwise it lands in
 *   unfiledGroups preserving the groupedTasks order.
 * - Empty folders are preserved as projections with zero members.
 * - Unknown folder task IDs and unknown groups are skipped silently.
 * - Automatic groups are indivisible: any folder task ID inside an automatic
 *   group resolves to the group root, so the whole group moves as one unit.
 * - Workspace filtering (when cwd is provided) hides groups whose tasks are
 *   all outside the current workspace; hidden folder members are counted via
 *   hiddenCount, and folders remain present even when every member is hidden.
 *
 * This function intentionally does NOT call or alter
 * buildFlattenedVirtualEntries(); it is a parallel, UI-local projection for
 * the grouped (non-virtualized) rendering path.
 */
export function buildGroupedOrganizationProjection(
	state: TaskOrganizationStateV1,
	groupedTasks: TaskGroup[],
	tasks: HistoryItem[],
	cwd?: string,
): GroupedOrganizationProjection {
	const taskMap = buildTaskMap(tasks)

	// Index groups by their canonical root id (the parent task id).
	const groupByRootId = new Map<string, TaskGroup>()
	for (const group of groupedTasks) {
		groupByRootId.set(group.parent.id, group)
	}

	// Pinned canonical roots (shortcut rendering hint for the UI).
	const pinnedRootIds = new Set<string>()
	for (const pin of state.pins) {
		const target = pin.target
		if (target.kind === "task") {
			pinnedRootIds.add(buildCanonicalTarget(target.taskId, groupedTasks))
		} else if (target.kind === "autoGroup") {
			pinnedRootIds.add(target.rootTaskId)
		}
	}

	const isVisibleInWorkspace = (group: TaskGroup): boolean => {
		if (!cwd) {
			return true
		}
		const rootId = group.parent.id
		const visited = new Set<string>()
		const closure = collectDescendants(rootId, taskMap, visited)
		const idsToCheck = closure.length > 0 ? closure : [rootId]
		return idsToCheck.some((id) => taskBelongsToWorkspace(taskMap.get(id), cwd))
	}

	// Track canonical roots already assigned to a folder so duplicates across
	// folders (or duplicated ids within one folder) never produce two members.
	const assignedRootIds = new Set<string>()

	// Folders in creation order (newest first), matching the flat projection.
	const sortedFolders = state.folders.slice().sort((a, b) => b.createdAt - a.createdAt)

	const folderProjections: GroupedFolderProjection[] = []
	for (const folder of sortedFolders) {
		const members: TaskGroup[] = []
		let hiddenCount = 0

		for (const taskId of folder.taskIds) {
			// Resolve any task id (including automatic-group children) to its
			// canonical root so automatic groups stay indivisible.
			const rootId = buildCanonicalTarget(taskId, groupedTasks)
			if (assignedRootIds.has(rootId)) {
				continue
			}
			const group = groupByRootId.get(rootId)
			if (!group) {
				continue
			}
			assignedRootIds.add(rootId)

			if (!isVisibleInWorkspace(group)) {
				hiddenCount++
				continue
			}
			members.push(group)
		}

		// When workspace filtering is active (cwd provided), skip folders
		// whose members are all hidden (i.e., belong to other workspaces).
		// Genuinely empty folders (zero taskIds) are still preserved.
		if (cwd && members.length === 0 && folder.taskIds.length > 0) {
			continue
		}
		folderProjections.push({
			folderId: folder.folderId,
			folderName: folder.name,
			members,
			hiddenCount,
		})
	}

	// Unfiled groups: preserve groupedTasks order, skip assigned roots, and
	// apply the same workspace filter used for folder members.
	const unfiledGroups: TaskGroup[] = []
	for (const group of groupedTasks) {
		const rootId = group.parent.id
		if (assignedRootIds.has(rootId)) {
			continue
		}
		if (!isVisibleInWorkspace(group)) {
			continue
		}
		unfiledGroups.push(group)
	}

	return {
		folderProjections,
		unfiledGroups,
		pinnedRootIds,
	}
}
