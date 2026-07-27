import type { HistoryItem, TaskOrganizationStateV1 } from "@roo-code/types"

function createEmptyTaskOrganizationState(): TaskOrganizationStateV1 {
	return {
		schemaVersion: 1,
		revision: 0,
		folders: [],
		pins: [],
		updatedAt: Date.now(),
	}
}

import type { SubtaskTreeNode, TaskGroup } from "../types"
import {
	buildCanonicalTarget,
	buildFolderMembershipMap,
	buildGroupedOrganizationProjection,
	buildPinnedProjection,
	buildFlattenedVirtualEntries,
	buildRecentTasksProjection,
	filterByWorkspace,
	resolveOrganizationUnit,
} from "../taskOrganizationModel"

const tsBase = new Date("2024-01-01T00:00:00Z").getTime()

function makeTask(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "task-1",
		number: 1,
		task: "Task",
		ts: tsBase,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/workspace/project",
		...overrides,
	}
}

function makeGroup(parent: HistoryItem, subtasks: SubtaskTreeNode[] = []): TaskGroup {
	return {
		parent: parent as import("../types").DisplayHistoryItem,
		subtasks,
		isExpanded: true,
	}
}

function makeSubtaskNode(item: HistoryItem, children: SubtaskTreeNode[] = []): SubtaskTreeNode {
	return {
		item: item as import("../types").DisplayHistoryItem,
		children,
		isExpanded: true,
	}
}

describe("taskOrganizationModel", () => {
	describe("buildCanonicalTarget", () => {
		it("normalizes a parent drag to its own id", () => {
			const parent = makeTask({ id: "parent-1" })
			const group = makeGroup(parent)
			expect(buildCanonicalTarget("parent-1", [group])).toBe("parent-1")
		})

		it("normalizes a child drag to its group parent id", () => {
			const parent = makeTask({ id: "parent-1" })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const group = makeGroup(parent, [makeSubtaskNode(child)])
			expect(buildCanonicalTarget("child-1", [group])).toBe("parent-1")
		})

		it("normalizes a nested descendant drag to the group parent id", () => {
			const parent = makeTask({ id: "parent-1" })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const grandchild = makeTask({ id: "grandchild-1", parentTaskId: "child-1" })
			const group = makeGroup(parent, [makeSubtaskNode(child, [makeSubtaskNode(grandchild)])])
			expect(buildCanonicalTarget("grandchild-1", [group])).toBe("parent-1")
		})

		it("returns the provided id for unknown tasks", () => {
			const parent = makeTask({ id: "parent-1" })
			const group = makeGroup(parent)
			expect(buildCanonicalTarget("unknown", [group])).toBe("unknown")
		})
	})

	describe("resolveOrganizationUnit", () => {
		it("resolves a standalone task to a single-id closure", () => {
			const task = makeTask({ id: "solo" })
			const unit = resolveOrganizationUnit("solo", [task])
			expect(unit.target.kind).toBe("task")
			expect(unit.closureTaskIds).toEqual(["solo"])
		})

		it("resolves a child id to its full auto group closure", () => {
			const parent = makeTask({ id: "parent-1", childIds: ["child-1"] })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const unit = resolveOrganizationUnit("child-1", [parent, child])
			expect(unit.target.kind).toBe("autoGroup")
			expect(unit.rootTaskId).toBe("parent-1")
			expect(unit.closureTaskIds).toEqual(["parent-1", "child-1"])
		})

		it("terminates cycles using the visited set", () => {
			const a = makeTask({ id: "a", parentTaskId: "c", childIds: ["b"] })
			const b = makeTask({ id: "b", parentTaskId: "a", childIds: ["c"] })
			const c = makeTask({ id: "c", parentTaskId: "b", childIds: ["a"] })
			const unit = resolveOrganizationUnit("a", [a, b, c])
			expect(unit.closureTaskIds.length).toBe(3)
		})
	})

	describe("buildFolderMembershipMap", () => {
		it("maps task ids to their containing folder id", () => {
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [
					{ folderId: "f1", name: "Folder 1", taskIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 },
					{ folderId: "f2", name: "Folder 2", taskIds: ["t3"], createdAt: 2, updatedAt: 2 },
				],
			}
			const map = buildFolderMembershipMap(state.folders)
			expect(map.get("t1")).toBe("f1")
			expect(map.get("t2")).toBe("f1")
			expect(map.get("t3")).toBe("f2")
		})

		it("ignores duplicate membership after the first occurrence", () => {
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [
					{ folderId: "f1", name: "Folder 1", taskIds: ["t1", "t2"], createdAt: 1, updatedAt: 1 },
					{ folderId: "f2", name: "Folder 2", taskIds: ["t1"], createdAt: 2, updatedAt: 2 },
				],
			}
			const map = buildFolderMembershipMap(state.folders)
			expect(map.get("t1")).toBe("f1")
		})

		it("returns an empty map for no folders", () => {
			const map = buildFolderMembershipMap([])
			expect(map.size).toBe(0)
		})
	})

	describe("buildPinnedProjection", () => {
		it("produces pin entries in pin order", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [
					{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 },
					{ target: { kind: "task", taskId: "t2" }, pinnedAt: 200 },
				],
			}
			const pins = buildPinnedProjection(state, [makeGroup(t1), makeGroup(t2)], [t1, t2])
			expect(pins).toHaveLength(2)
			expect(pins[0].unit?.rootTaskId).toBe("t1")
			expect(pins[0].pinIndex).toBe(0)
			expect(pins[1].unit?.rootTaskId).toBe("t2")
			expect(pins[1].pinIndex).toBe(1)
		})

		it("renders a pinned nested task as its root group shortcut", () => {
			const parent = makeTask({ id: "parent-1", childIds: ["child-1"] })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [{ target: { kind: "task", taskId: "child-1" }, pinnedAt: 100 }],
			}
			const pins = buildPinnedProjection(state, [makeGroup(parent, [makeSubtaskNode(child)])], [parent, child])
			expect(pins).toHaveLength(1)
			expect(pins[0].unit?.rootTaskId).toBe("parent-1")
			expect(pins[0].unit?.closureTaskIds).toEqual(["parent-1", "child-1"])
		})

		it("renders a pinned folder as a folder shortcut", () => {
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [{ folderId: "f1", name: "Pinned Folder", taskIds: [], createdAt: 1, updatedAt: 1 }],
				pins: [{ target: { kind: "folder", folderId: "f1" }, pinnedAt: 100 }],
			}
			const pins = buildPinnedProjection(state, [], [])
			expect(pins).toHaveLength(1)
			expect(pins[0].folderId).toBe("f1")
			expect(pins[0].folderName).toBe("Pinned Folder")
		})

		it("de-duplicates duplicate pin targets by key", () => {
			const t1 = makeTask({ id: "t1" })
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [
					{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 },
					{ target: { kind: "autoGroup", rootTaskId: "t1" }, pinnedAt: 200 },
				],
			}
			const pins = buildPinnedProjection(state, [makeGroup(t1)], [t1])
			expect(pins).toHaveLength(1)
		})

		it("omits pins whose tasks no longer exist", () => {
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [{ target: { kind: "task", taskId: "missing" }, pinnedAt: 100 }],
			}
			const pins = buildPinnedProjection(state, [], [])
			expect(pins).toHaveLength(0)
		})
	})

	describe("buildFlattenedVirtualEntries", () => {
		it("keeps unfiled groups in original order when no organization exists", () => {
			const t1 = makeTask({ id: "t1", ts: tsBase + 1000 })
			const t2 = makeTask({ id: "t2", ts: tsBase + 2000 })
			const state = createEmptyTaskOrganizationState()
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(t1), makeGroup(t2)], [t1, t2])
			expect(entries.map((e) => e.category)).toEqual(["unfiled", "unfiled"])
			expect(entries.map((e) => e.unit?.rootTaskId)).toEqual(["t1", "t2"])
		})

		it("places pinned entries before folders and unfiled groups", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const folder = { folderId: "f1", name: "Folder", taskIds: ["t2"], createdAt: 1, updatedAt: 1 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
				pins: [{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 }],
			}
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(t1), makeGroup(t2)], [t1, t2])
			expect(entries[0].category).toBe("pinned")
			expect(entries[0].unit?.rootTaskId).toBe("t1")
			expect(entries[1].category).toBe("manualFolder")
		})

		it("de-duplicates a pinned unfiled unit from the unfiled section", () => {
			const t1 = makeTask({ id: "t1" })
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 }],
			}
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(t1)], [t1])
			const unfiled = entries.filter((e) => e.category === "unfiled")
			expect(unfiled).toHaveLength(0)
		})

		it("expands folder members in stored order and removes duplicates inside a folder", () => {
			const parent = makeTask({ id: "parent-1", childIds: ["child-1"] })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const folder = {
				folderId: "f1",
				name: "Folder",
				taskIds: ["child-1", "parent-1"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const entries = buildFlattenedVirtualEntries(
				state,
				[makeGroup(parent, [makeSubtaskNode(child)])],
				[parent, child],
			)
			const folderUnits = entries.filter((e) => e.category === "manualFolder" && e.unit)
			expect(folderUnits).toHaveLength(1)
			expect(folderUnits[0].unit?.rootTaskId).toBe("parent-1")
		})

		it("keeps empty folders visible", () => {
			const folder = { folderId: "f1", name: "Empty", taskIds: [], createdAt: 1, updatedAt: 1 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const entries = buildFlattenedVirtualEntries(state, [], [])
			expect(entries).toHaveLength(1)
			expect(entries[0].category).toBe("manualFolder")
			expect(entries[0].folderId).toBe("f1")
		})

		it("sorts folders by creation time descending", () => {
			const f1 = { folderId: "f1", name: "Old", taskIds: [], createdAt: 100, updatedAt: 100 }
			const f2 = { folderId: "f2", name: "New", taskIds: [], createdAt: 200, updatedAt: 200 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [f1, f2],
			}
			const entries = buildFlattenedVirtualEntries(state, [], [])
			const folderNames = entries.filter((e) => e.category === "manualFolder").map((e) => e.folderName)
			expect(folderNames).toEqual(["New", "Old"])
		})
	})

	describe("filterByWorkspace", () => {
		it("returns all entries when cwd is undefined", () => {
			const t1 = makeTask({ id: "t1", workspace: "/workspace/project" })
			const entries = buildFlattenedVirtualEntries(createEmptyTaskOrganizationState(), [makeGroup(t1)], [t1])
			expect(filterByWorkspace(entries, [t1], undefined)).toHaveLength(entries.length)
		})

		it("filters unfiled units outside the current workspace", () => {
			const local = makeTask({ id: "local", workspace: "/workspace/project" })
			const other = makeTask({ id: "other", workspace: "/workspace/other" })
			const entries = buildFlattenedVirtualEntries(
				createEmptyTaskOrganizationState(),
				[makeGroup(local), makeGroup(other)],
				[local, other],
			)
			const filtered = filterByWorkspace(entries, [local, other], "/workspace/project")
			expect(filtered.map((e) => e.unit?.rootTaskId)).toEqual(["local"])
		})

		it("keeps a folder pinned even when all members are in another workspace", () => {
			const other = makeTask({ id: "other", workspace: "/workspace/other" })
			const folder = {
				folderId: "f1",
				name: "Other Folder",
				taskIds: ["other"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
				pins: [{ target: { kind: "folder", folderId: "f1" }, pinnedAt: 100 }],
			}
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(other)], [other])
			const filtered = filterByWorkspace(entries, [other], "/workspace/project")
			expect(filtered.map((e) => e.category)).toEqual(["pinned", "manualFolder"])
		})

		it("shows only visible members inside a folder in current workspace mode", () => {
			const local = makeTask({ id: "local", workspace: "/workspace/project" })
			const other = makeTask({ id: "other", workspace: "/workspace/other" })
			const folder = {
				folderId: "f1",
				name: "Mixed",
				taskIds: ["local", "other"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(local), makeGroup(other)], [local, other])
			const filtered = filterByWorkspace(entries, [local, other], "/workspace/project")
			const folderEntries = filtered.filter((e) => e.category === "manualFolder")
			expect(folderEntries.map((e) => e.unit?.rootTaskId)).toEqual([undefined, "local"])
		})

		it("hides a non-pinned folder whose members are all in another workspace", () => {
			const other = makeTask({ id: "other", workspace: "/workspace/other" })
			const folder = {
				folderId: "f1",
				name: "Hidden",
				taskIds: ["other"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const entries = buildFlattenedVirtualEntries(state, [makeGroup(other)], [other])
			const filtered = filterByWorkspace(entries, [other], "/workspace/project")
			expect(filtered).toHaveLength(0)
		})
	})

	describe("buildRecentTasksProjection", () => {
		it("fills remaining slots with unfiled groups when no pins or folders exist", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const t3 = makeTask({ id: "t3" })
			const t4 = makeTask({ id: "t4" })
			const slots = buildRecentTasksProjection(
				createEmptyTaskOrganizationState(),
				[makeGroup(t1), makeGroup(t2), makeGroup(t3), makeGroup(t4)],
				[t1, t2, t3, t4],
			)
			expect(slots).toHaveLength(4)
			expect(slots.every((s) => s.category === "unfiled")).toBe(true)
		})

		it("places pins first and fills remaining slots with folders", () => {
			const t1 = makeTask({ id: "t1" })
			const folder = { folderId: "f1", name: "F", taskIds: [], createdAt: 1, updatedAt: 1 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
				pins: [{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 }],
			}
			const slots = buildRecentTasksProjection(state, [makeGroup(t1)], [t1])
			expect(slots[0].category).toBe("pinned")
			expect(slots[0].unit?.rootTaskId).toBe("t1")
			expect(slots[1].category).toBe("manualFolder")
		})

		it("stops at maxSlots", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const slots = buildRecentTasksProjection(
				createEmptyTaskOrganizationState(),
				[makeGroup(t1), makeGroup(t2)],
				[t1, t2],
				1,
			)
			expect(slots).toHaveLength(1)
		})

		it("de-duplicates a pinned unit from the unfiled fill", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const t3 = makeTask({ id: "t3" })
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [{ target: { kind: "task", taskId: "t1" }, pinnedAt: 100 }],
			}
			const slots = buildRecentTasksProjection(state, [makeGroup(t1), makeGroup(t2), makeGroup(t3)], [t1, t2, t3])
			const roots = slots.map((s) => s.unit?.rootTaskId).filter(Boolean)
			expect(new Set(roots).size).toBe(roots.length)
		})
	})

	describe("buildGroupedOrganizationProjection", () => {
		it("returns identity projection when no organization state exists", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const g1 = makeGroup(t1)
			const g2 = makeGroup(t2)
			const projection = buildGroupedOrganizationProjection(
				createEmptyTaskOrganizationState(),
				[g1, g2],
				[t1, t2],
			)
			expect(projection.folderProjections).toHaveLength(0)
			expect(projection.unfiledGroups).toEqual([g1, g2])
			expect(projection.pinnedRootIds.size).toBe(0)
		})

		it("resolves canonical child membership to the group parent", () => {
			const parent = makeTask({ id: "parent-1" })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const group = makeGroup(parent, [makeSubtaskNode(child)])
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["child-1"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [group], [parent, child])
			expect(projection.folderProjections).toHaveLength(1)
			expect(projection.folderProjections[0].members).toEqual([group])
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("never places the same canonical root in two folders", () => {
			const t1 = makeTask({ id: "t1" })
			const group = makeGroup(t1)
			const folderA = { folderId: "fa", name: "A", taskIds: ["t1"], createdAt: 1, updatedAt: 1 }
			const folderB = { folderId: "fb", name: "B", taskIds: ["t1"], createdAt: 2, updatedAt: 2 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folderA, folderB],
			}
			const projection = buildGroupedOrganizationProjection(state, [group], [t1])
			// folderB (newest) wins; folderA is empty.
			expect(projection.folderProjections[0].folderId).toBe("fb")
			expect(projection.folderProjections[0].members).toEqual([group])
			expect(projection.folderProjections[1].folderId).toBe("fa")
			expect(projection.folderProjections[1].members).toEqual([])
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("preserves folder taskIds insertion order for members", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const t3 = makeTask({ id: "t3" })
			const g1 = makeGroup(t1)
			const g2 = makeGroup(t2)
			const g3 = makeGroup(t3)
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["t3", "t1", "t2"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [g1, g2, g3], [t1, t2, t3])
			expect(projection.folderProjections[0].members).toEqual([g3, g1, g2])
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("keeps empty folders as projections with zero members", () => {
			const t1 = makeTask({ id: "t1" })
			const g1 = makeGroup(t1)
			const folder = { folderId: "f1", name: "Empty", taskIds: [], createdAt: 1, updatedAt: 1 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [g1], [t1])
			expect(projection.folderProjections).toHaveLength(1)
			expect(projection.folderProjections[0].members).toEqual([])
			expect(projection.folderProjections[0].hiddenCount).toBe(0)
			expect(projection.unfiledGroups).toEqual([g1])
		})

		it("skips missing folder task IDs and unknown groups silently", () => {
			const t1 = makeTask({ id: "t1" })
			const g1 = makeGroup(t1)
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["ghost-1", "t1", "ghost-2"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [g1], [t1])
			expect(projection.folderProjections[0].members).toEqual([g1])
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("filters unfiled groups and counts hidden folder members by workspace", () => {
			const inWs = makeTask({ id: "in", workspace: "/workspace/project" })
			const outWs = makeTask({ id: "out", workspace: "/workspace/other" })
			const gIn = makeGroup(inWs)
			const gOut = makeGroup(outWs)
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["in", "out"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(
				state,
				[gIn, gOut],
				[inWs, outWs],
				"/workspace/project",
			)
			expect(projection.folderProjections[0].members).toEqual([gIn])
			expect(projection.folderProjections[0].hiddenCount).toBe(1)
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("skips folders whose members are all in another workspace when cwd is provided", () => {
			const outWs = makeTask({ id: "out", workspace: "/workspace/other" })
			const gOut = makeGroup(outWs)
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["out"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [gOut], [outWs], "/workspace/project")
			// Folder with only cross-workspace members should be skipped entirely.
			expect(projection.folderProjections).toHaveLength(0)
			expect(projection.unfiledGroups).toHaveLength(0)
		})

		it("preserves genuinely empty folders even when cwd is provided", () => {
			const local = makeTask({ id: "local", workspace: "/workspace/project" })
			const gLocal = makeGroup(local)
			const folder = {
				folderId: "f-empty",
				name: "Empty",
				taskIds: [],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [gLocal], [local], "/workspace/project")
			// Genuinely empty folder (zero taskIds) should still appear.
			expect(projection.folderProjections).toHaveLength(1)
			expect(projection.folderProjections[0].folderId).toBe("f-empty")
			expect(projection.folderProjections[0].members).toHaveLength(0)
		})

		it("skips folders with cross-workspace members when cwd is empty string", () => {
			// Simulates "no workspace open": cwd is "" and groups only contains
			// tasks whose workspace is "" (filtered by useTaskSearch upstream).
			// A folder whose taskIds reference tasks from another workspace
			// should NOT leak into the no-workspace view.
			const noWs = makeTask({ id: "no-ws", workspace: "" })
			const gNoWs = makeGroup(noWs)
			const outWs = makeTask({ id: "out", workspace: "/workspace/other" })
			const gOut = makeGroup(outWs)
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["out"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [gNoWs, gOut], [noWs, outWs], "")
			// Folder with only cross-workspace members should be skipped.
			expect(projection.folderProjections).toHaveLength(0)
			// The no-workspace task should appear as unfiled.
			expect(projection.unfiledGroups).toEqual([gNoWs])
		})

		it("preserves genuinely empty folders when cwd is empty string", () => {
			const noWs = makeTask({ id: "no-ws", workspace: "" })
			const gNoWs = makeGroup(noWs)
			const folder = {
				folderId: "f-empty",
				name: "Empty",
				taskIds: [],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [gNoWs], [noWs], "")
			// Genuinely empty folder (zero taskIds) should still appear.
			expect(projection.folderProjections).toHaveLength(1)
			expect(projection.folderProjections[0].folderId).toBe("f-empty")
			expect(projection.folderProjections[0].members).toHaveLength(0)
		})

		it("treats automatic groups as indivisible when a child is placed in a folder", () => {
			const parent = makeTask({ id: "parent-1" })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const grandchild = makeTask({ id: "grandchild-1", parentTaskId: "child-1" })
			const group = makeGroup(parent, [makeSubtaskNode(child, [makeSubtaskNode(grandchild)])])
			const folder = {
				folderId: "f1",
				name: "F",
				taskIds: ["grandchild-1"],
				createdAt: 1,
				updatedAt: 1,
			}
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [group], [parent, child, grandchild])
			// Whole group (root parent-1) becomes the single folder member.
			expect(projection.folderProjections[0].members).toEqual([group])
			expect(projection.unfiledGroups).toHaveLength(0)
			// The same root must not also appear in unfiledGroups.
			const allRoots = [
				...projection.folderProjections.flatMap((f) => f.members.map((g) => g.parent.id)),
				...projection.unfiledGroups.map((g) => g.parent.id),
			]
			expect(new Set(allRoots).size).toBe(allRoots.length)
		})

		it("collects pinned canonical root ids for task and autoGroup pins", () => {
			const parent = makeTask({ id: "parent-1" })
			const child = makeTask({ id: "child-1", parentTaskId: "parent-1" })
			const standalone = makeTask({ id: "solo-1" })
			const gParent = makeGroup(parent, [makeSubtaskNode(child)])
			const gSolo = makeGroup(standalone)
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				pins: [
					{ target: { kind: "task", taskId: "child-1" }, pinnedAt: 1 },
					{ target: { kind: "autoGroup", rootTaskId: "solo-1" }, pinnedAt: 2 },
					{ target: { kind: "folder", folderId: "fx" }, pinnedAt: 3 },
				],
			}
			const projection = buildGroupedOrganizationProjection(state, [gParent, gSolo], [parent, child, standalone])
			expect(projection.pinnedRootIds.has("parent-1")).toBe(true)
			expect(projection.pinnedRootIds.has("solo-1")).toBe(true)
			expect(projection.pinnedRootIds.has("fx")).toBe(false)
		})

		it("keeps TaskGroup object identity between input and projection output", () => {
			const t1 = makeTask({ id: "t1" })
			const t2 = makeTask({ id: "t2" })
			const g1 = makeGroup(t1)
			const g2 = makeGroup(t2)
			const folder = { folderId: "f1", name: "F", taskIds: ["t1"], createdAt: 1, updatedAt: 1 }
			const state: TaskOrganizationStateV1 = {
				...createEmptyTaskOrganizationState(),
				folders: [folder],
			}
			const projection = buildGroupedOrganizationProjection(state, [g1, g2], [t1, t2])
			expect(projection.folderProjections[0].members[0]).toBe(g1)
			expect(projection.unfiledGroups[0]).toBe(g2)
		})
	})
})
