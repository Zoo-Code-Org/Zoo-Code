// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskOrganizationStore.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"
import { createEmptyTaskOrganizationState, MAX_PINNED_TARGETS } from "@roo-code/types"

import { TaskOrganizationStore } from "../TaskOrganizationStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
		return defaultPath
	}),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: unknown) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
	safeUpdateJson: vi.fn().mockImplementation(async (filePath: string, updater: (current: unknown) => unknown) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		let current: unknown
		try {
			current = JSON.parse(await fs.readFile(filePath, "utf8"))
		} catch {
			current = undefined
		}
		const updated = updater(current)
		await fs.writeFile(filePath, JSON.stringify(updated, null, "\t"), "utf8")
		return updated
	}),
}))

function makeHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/test/workspace",
		...overrides,
	}
}

class MockTaskHistory {
	private readonly items = new Map<string, HistoryItem>()

	add(item: HistoryItem): void {
		this.items.set(item.id, item)
	}

	get(taskId: string): HistoryItem | undefined {
		return this.items.get(taskId)
	}

	getAll(): HistoryItem[] {
		return Array.from(this.items.values())
	}

	delete(taskId: string): void {
		this.items.delete(taskId)
	}
}

describe("TaskOrganizationStore", () => {
	let tmpDir: string
	let store: TaskOrganizationStore
	let history: MockTaskHistory

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-org-test-"))
		history = new MockTaskHistory()
		store = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	describe("initialize()", () => {
		it("loads an empty state when no file exists", async () => {
			await store.initialize()
			expect(store.getState()).toEqual(createEmptyTaskOrganizationState(() => 1000))
		})

		it("loads a previously saved state", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A folder",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)

			const fresh = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
			await fresh.initialize()
			expect(fresh.getState().folders).toHaveLength(1)
			expect(fresh.getState().folders[0].name).toBe("A folder")
			fresh.dispose()
		})

		it("quarantines and recovers from malformed JSON", async () => {
			const tasksDir = path.join(tmpDir, "tasks")
			await fs.mkdir(tasksDir, { recursive: true })
			await fs.writeFile(path.join(tasksDir, GlobalFileNames.taskOrganization), "not json", "utf8")

			await store.initialize()

			expect(store.getState()).toEqual(createEmptyTaskOrganizationState(() => 1000))
			const quarantineFiles = (await fs.readdir(tasksDir)).filter((name) =>
				name.startsWith("_taskOrganization.json.corrupt_"),
			)
			expect(quarantineFiles).toHaveLength(1)
		})

		it("preserves a future schema version without overwriting", async () => {
			const tasksDir = path.join(tmpDir, "tasks")
			await fs.mkdir(tasksDir, { recursive: true })
			await fs.writeFile(
				path.join(tasksDir, GlobalFileNames.taskOrganization),
				JSON.stringify({ schemaVersion: 99, revision: 1, folders: [], pins: [], updatedAt: 1 }),
				"utf8",
			)

			await store.initialize()

			expect(store.getState().schemaVersion).toBe(99)
			const result = await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				1,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/FUTURE_SCHEMA/007")
		})
	})

	describe("mutate() createFolder", () => {
		it("creates a folder with two task targets", async () => {
			await store.initialize()
			const result = await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "New Folder",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)

			expect(result.success).toBe(true)
			expect(result.committedRevision).toBe(1)
			const state = store.getState()
			expect(state.folders).toHaveLength(1)
			expect(state.folders[0].name).toBe("New Folder")
			expect(state.folders[0].taskIds).toEqual(["t1", "t2"])
		})

		it("rejects an empty folder name", async () => {
			await store.initialize()
			const result = await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "   ",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/VALIDATION/001")
		})

		it("rejects a stale revision", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-2",
					name: "B",
					source: { kind: "task", taskId: "t3" },
					destination: { kind: "task", taskId: "t4" },
				},
				0,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/CONFLICT/002")
		})
	})

	describe("mutate() moveToFolder", () => {
		it("moves a unit into a folder", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{ kind: "moveToFolder", source: { kind: "task", taskId: "t3" }, folderId: "folder-1" },
				1,
			)
			expect(result.success).toBe(true)
			expect(store.getState().folders[0].taskIds).toEqual(["t1", "t2", "t3"])
		})

		it("removes the unit from the previous folder", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-2",
					name: "B",
					source: { kind: "task", taskId: "t3" },
					destination: { kind: "task", taskId: "t4" },
				},
				1,
			)
			await store.mutate(
				{ kind: "moveToFolder", source: { kind: "task", taskId: "t3" }, folderId: "folder-1" },
				2,
			)
			const state = store.getState()
			expect(state.folders[0].taskIds).toEqual(["t1", "t2", "t3"])
			expect(state.folders[1].taskIds).toEqual(["t4"])
		})
	})

	describe("mutate() removeFromFolder", () => {
		it("removes a unit from its folder", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{ kind: "removeFromFolder", source: { kind: "task", taskId: "t1" }, folderId: "folder-1" },
				1,
			)
			expect(result.success).toBe(true)
			expect(store.getState().folders[0].taskIds).toEqual(["t2"])
		})
	})

	describe("mutate() renameFolder", () => {
		it("renames a folder", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate({ kind: "renameFolder", folderId: "folder-1", name: "Renamed" }, 1)
			expect(result.success).toBe(true)
			expect(store.getState().folders[0].name).toBe("Renamed")
		})

		it("rejects a missing folder", async () => {
			await store.initialize()
			const result = await store.mutate({ kind: "renameFolder", folderId: "missing", name: "Renamed" }, 0)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/NOT_FOUND/004")
		})
	})

	describe("mutate() createFolderFromSelection", () => {
		it("creates a folder from multiple task targets preserving source order", async () => {
			await store.initialize()
			const result = await store.mutate(
				{
					kind: "createFolderFromSelection",
					folderId: "folder-sel",
					name: "Selection",
					targets: [
						{ kind: "task", taskId: "t3" },
						{ kind: "task", taskId: "t1" },
						{ kind: "task", taskId: "t2" },
					],
				},
				0,
			)
			expect(result.success).toBe(true)
			expect(result.committedRevision).toBe(1)
			const state = store.getState()
			expect(state.folders).toHaveLength(1)
			expect(state.folders[0].taskIds).toEqual(["t3", "t1", "t2"])
			expect(state.revision).toBe(1)
		})

		it("de-duplicates parent/child closures when autoGroup and child overlap", async () => {
			const parent = makeHistoryItem({ id: "parent" })
			const child = makeHistoryItem({ id: "child", parentTaskId: "parent" })
			history.add(parent)
			history.add(child)

			await store.initialize()
			const result = await store.mutate(
				{
					kind: "createFolderFromSelection",
					folderId: "folder-dedup",
					name: "Dedup",
					targets: [
						{ kind: "autoGroup", rootTaskId: "parent" },
						{ kind: "task", taskId: "child" },
						{ kind: "task", taskId: "t-x" },
					],
				},
				0,
			)
			expect(result.success).toBe(true)
			const ids = store.getState().folders[0].taskIds
			expect(ids).toEqual(["parent", "child", "t-x"])
			expect(new Set(ids).size).toBe(ids.length)
		})

		it("removes selected units from previous folders atomically", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-a",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{
					kind: "createFolderFromSelection",
					folderId: "folder-b",
					name: "B",
					targets: [
						{ kind: "task", taskId: "t2" },
						{ kind: "task", taskId: "t3" },
					],
				},
				1,
			)
			expect(result.success).toBe(true)
			const state = store.getState()
			expect(state.folders).toHaveLength(2)
			expect(state.folders[0].taskIds).toEqual(["t1"])
			expect(state.folders[1].taskIds).toEqual(["t2", "t3"])
			expect(state.revision).toBe(2)
		})

		it("rejects when fewer than two canonical units remain after de-duplication", async () => {
			const parent = makeHistoryItem({ id: "p" })
			history.add(parent)

			await store.initialize()
			const result = await store.mutate(
				{
					kind: "createFolderFromSelection",
					folderId: "folder-few",
					name: "Few",
					targets: [
						{ kind: "autoGroup", rootTaskId: "p" },
						{ kind: "task", taskId: "p" },
					],
				},
				0,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/VALIDATION/001")
			expect(store.getState().folders).toHaveLength(0)
			expect(store.getState().revision).toBe(0)
		})

		it("rejects when the folder ID already exists", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{
					kind: "createFolderFromSelection",
					folderId: "folder-1",
					name: "Dup",
					targets: [
						{ kind: "task", taskId: "t3" },
						{ kind: "task", taskId: "t4" },
					],
				},
				1,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/VALIDATION/001")
			expect(store.getState().folders).toHaveLength(1)
			expect(store.getState().revision).toBe(1)
		})
	})

	describe("mutate() deleteFolders", () => {
		it("deletes multiple folders atomically and removes matching pins", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "f1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "f2",
					name: "B",
					source: { kind: "task", taskId: "t3" },
					destination: { kind: "task", taskId: "t4" },
				},
				1,
			)
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "f3",
					name: "C",
					source: { kind: "task", taskId: "t5" },
					destination: { kind: "task", taskId: "t6" },
				},
				2,
			)
			await store.mutate({ kind: "setPinned", target: { kind: "folder", folderId: "f1" }, pinned: true }, 3)
			await store.mutate({ kind: "setPinned", target: { kind: "folder", folderId: "f2" }, pinned: true }, 4)
			const result = await store.mutate({ kind: "deleteFolders", folderIds: ["f1", "f2"] }, 5)
			expect(result.success).toBe(true)
			const state = store.getState()
			expect(state.folders).toHaveLength(1)
			expect(state.folders[0].folderId).toBe("f3")
			expect(state.pins).toHaveLength(0)
			expect(state.revision).toBe(6)
		})

		it("is all-or-nothing when any folder is missing", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "f1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate({ kind: "deleteFolders", folderIds: ["f1", "missing"] }, 1)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/NOT_FOUND/004")
			const state = store.getState()
			expect(state.folders).toHaveLength(1)
			expect(state.revision).toBe(1)
		})

		it("leaves state unchanged on a stale revision", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "f1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate({ kind: "deleteFolders", folderIds: ["f1"] }, 0)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/CONFLICT/002")
			expect(store.getState().folders).toHaveLength(1)
			expect(store.getState().revision).toBe(1)
		})
	})

	describe("mutate() deleteFolder", () => {
		it("deletes a folder and removes its pin", async () => {
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			await store.mutate({ kind: "setPinned", target: { kind: "folder", folderId: "folder-1" }, pinned: true }, 1)
			const result = await store.mutate({ kind: "deleteFolder", folderId: "folder-1" }, 2)
			expect(result.success).toBe(true)
			const state = store.getState()
			expect(state.folders).toHaveLength(0)
			expect(state.pins).toHaveLength(0)
		})
	})

	describe("mutate() setPinned", () => {
		it("pins a task", async () => {
			await store.initialize()
			const result = await store.mutate(
				{ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true },
				0,
			)
			expect(result.success).toBe(true)
			expect(store.getState().pins).toHaveLength(1)
		})

		it("unpins a task", async () => {
			await store.initialize()
			await store.mutate({ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true }, 0)
			const result = await store.mutate(
				{ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: false },
				1,
			)
			expect(result.success).toBe(true)
			expect(store.getState().pins).toHaveLength(0)
		})

		it("rejects a fourth pin", async () => {
			await store.initialize()
			for (let i = 0; i < MAX_PINNED_TARGETS; i++) {
				await store.mutate({ kind: "setPinned", target: { kind: "task", taskId: `t${i}` }, pinned: true }, i)
			}
			const result = await store.mutate(
				{ kind: "setPinned", target: { kind: "task", taskId: "overflow" }, pinned: true },
				MAX_PINNED_TARGETS,
			)
			expect(result.success).toBe(false)
			expect(result.error?.code).toBe("TASK_ORG/PIN_LIMIT/003")
			expect(store.getState().pins).toHaveLength(MAX_PINNED_TARGETS)
		})

		it("prevents duplicate pins", async () => {
			await store.initialize()
			await store.mutate({ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true }, 0)
			const result = await store.mutate(
				{ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true },
				1,
			)
			expect(result.success).toBe(true)
			expect(store.getState().pins).toHaveLength(1)
		})
	})

	describe("automatic group resolution", () => {
		it("resolves a child drag to its root group and moves all members", async () => {
			const parent = makeHistoryItem({ id: "parent" })
			const child = makeHistoryItem({ id: "child", parentTaskId: "parent" })
			history.add(parent)
			history.add(child)

			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			const result = await store.mutate(
				{ kind: "moveToFolder", source: { kind: "task", taskId: "child" }, folderId: "folder-1" },
				1,
			)
			expect(result.success).toBe(true)
			expect(store.getState().folders[0].taskIds).toEqual(["t1", "t2", "parent", "child"])
		})
	})

	describe("reconcile()", () => {
		it("prunes missing task pins", async () => {
			const item = makeHistoryItem({ id: "t1" })
			history.add(item)
			await store.initialize()
			await store.mutate({ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true }, 0)
			history.delete("t1")
			await store.reconcile()
			expect(store.getState().pins).toHaveLength(0)
		})

		it("retains an empty folder after reconciliation", async () => {
			const item = makeHistoryItem({ id: "t1" })
			history.add(item)
			await store.initialize()
			await store.mutate(
				{
					kind: "createFolder",
					folderId: "folder-1",
					name: "A",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				},
				0,
			)
			history.delete("t1")
			history.delete("t2")
			await store.reconcile()
			expect(store.getState().folders).toHaveLength(1)
			expect(store.getState().folders[0].taskIds).toEqual([])
		})
	})

	describe("concurrent mutations", () => {
		it("serializes concurrent mutations so revisions are sequential", async () => {
			await store.initialize()
			const promises = Array.from({ length: 5 }, (_, i) =>
				store.mutate(
					{
						kind: "createFolder",
						folderId: `folder-${i}`,
						name: `Folder ${i}`,
						source: { kind: "task", taskId: `s${i}` },
						destination: { kind: "task", taskId: `d${i}` },
					},
					i,
				),
			)
			const results = await Promise.all(promises)
			const successful = results.filter((r) => r.success)
			// Only the first mutation can succeed because each uses the previous revision.
			expect(successful).toHaveLength(1)
			expect(successful[0].committedRevision).toBe(1)
		})
	})
})
