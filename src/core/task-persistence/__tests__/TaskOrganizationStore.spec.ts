// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskOrganizationStore.spec.ts

import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as os from "os"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return {
		...actual,
		readFile: vi.fn(actual.readFile),
		writeFile: vi.fn(actual.writeFile),
	}
})

vi.mock("fs", async () => {
	const actualFs = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actualFs,
		watch: vi.fn(actualFs.watch),
	}
})

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

		it("resolves a root drag with children to its full group", async () => {
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
				{ kind: "moveToFolder", source: { kind: "task", taskId: "parent" }, folderId: "folder-1" },
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
		it("captures each concurrent mutation's revision after it acquires the lock", async () => {
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
			expect(successful).toHaveLength(5)
			expect(successful.map((result) => result.committedRevision)).toEqual([1, 2, 3, 4, 5])
		})

		describe("cross-process writes", () => {
			it("rejects a same-revision write from another instance (lost update)", async () => {
				await store.initialize()
				// A second instance sharing the same backing file.
				const other = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				await other.initialize()

				const first = await store.mutate(
					{
						kind: "createFolder",
						folderId: "folder-a",
						name: "A",
						source: { kind: "task", taskId: "t1" },
						destination: { kind: "task", taskId: "t2" },
					},
					0,
				)
				expect(first.success).toBe(true)

				// `other` still holds revision 0 in memory and computes next = 1,
				// the same revision the first instance just committed.
				const second = await other.mutate(
					{
						kind: "createFolder",
						folderId: "folder-b",
						name: "B",
						source: { kind: "task", taskId: "t3" },
						destination: { kind: "task", taskId: "t4" },
					},
					0,
				)
				expect(second.success).toBe(false)
				expect(second.error?.code).toBe("TASK_ORG/PERSISTENCE/005")

				// The first instance's write must survive on disk.
				const raw = JSON.parse(
					await fs.readFile(path.join(tmpDir, "tasks", GlobalFileNames.taskOrganization), "utf8"),
				)
				expect(raw.folders.map((f: { folderId: string }) => f.folderId)).toEqual(["folder-a"])

				other.dispose()
			})
		})

		describe("watcher reload resilience", () => {
			it("keeps in-memory state on transient read errors", async () => {
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
				expect(store.getState().revision).toBe(1)

				// Simulate a transient read failure (e.g. the watcher firing while a
				// temp+rename write replaces the file): swap the file for a
				// directory so readFile rejects with a non-ENOENT error.
				const filePath = path.join(tmpDir, "tasks", GlobalFileNames.taskOrganization)
				await fs.rm(filePath)
				await fs.mkdir(filePath)
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				try {
					await store["reloadFromWatcher"]()
				} finally {
					errorSpy.mockRestore()
					await fs.rmdir(filePath)
				}

				// The loaded state must survive; the next mutation computes from it.
				expect(store.getState().revision).toBe(1)
				expect(store.getState().folders).toHaveLength(1)
				const result = await store.mutate(
					{ kind: "setPinned", target: { kind: "task", taskId: "t9" }, pinned: true },
					1,
				)
				expect(result.success).toBe(true)
				expect(result.committedRevision).toBe(2)
			})

			it("fires onChange when reloaded content differs at the same revision", async () => {
				const onChange = vi.fn()
				const watched = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000, onChange })
				await watched.initialize()
				await watched.mutate(
					{
						kind: "createFolder",
						folderId: "folder-1",
						name: "A",
						source: { kind: "task", taskId: "t1" },
						destination: { kind: "task", taskId: "t2" },
					},
					0,
				)
				onChange.mockClear()

				// Simulate another process overwriting the file with different
				// content at the SAME revision (a lost update).
				const filePath = path.join(tmpDir, "tasks", GlobalFileNames.taskOrganization)
				const diverged = watched.getState()
				diverged.folders = [
					{ folderId: "folder-other", name: "Other", taskIds: ["t9"], createdAt: 1000, updatedAt: 1000 },
				]
				await fs.writeFile(filePath, JSON.stringify(diverged), "utf8")

				await watched["reloadFromWatcher"]()

				expect(onChange).toHaveBeenCalledTimes(1)
				expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }))
				expect(watched.getState().folders[0].folderId).toBe("folder-other")
				watched.dispose()
			})

			it("does not fire onChange when the reloaded content is identical", async () => {
				const onChange = vi.fn()
				const watched = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000, onChange })
				await watched.initialize()
				await watched.mutate({ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true }, 0)
				onChange.mockClear()

				// A watcher reload of unchanged content (e.g. our own write's event)
				// must not notify again.
				await watched["reloadFromWatcher"]()

				expect(onChange).not.toHaveBeenCalled()
				watched.dispose()
			})
		})

		describe("edge cases & uncovered branches", () => {
			it("returns empty state when getState() structuredClone throws", async () => {
				await store.initialize()
				const spy = vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => {
					throw new Error("clone failed")
				})
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				const state = store.getState()
				expect(state.schemaVersion).toBe(1)
				expect(state.folders).toEqual([])
				expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("getState() structuredClone failed"))
				spy.mockRestore()
				consoleSpy.mockRestore()
			})

			it("reconcile returns early if schemaVersion !== 1", async () => {
				const tasksDir = path.join(tmpDir, "tasks")
				await fs.mkdir(tasksDir, { recursive: true })
				await fs.writeFile(
					path.join(tasksDir, GlobalFileNames.taskOrganization),
					JSON.stringify({ schemaVersion: 2, revision: 1, folders: [], pins: [], updatedAt: 1 }),
					"utf8",
				)
				await store.initialize()
				await expect(store.reconcile()).resolves.toBeUndefined()
			})

			it("logs transient read error during load when error is not ENOENT", async () => {
				const filePath = path.join(tmpDir, "tasks", GlobalFileNames.taskOrganization)
				await fs.mkdir(path.dirname(filePath), { recursive: true })
				await fs.writeFile(
					filePath,
					JSON.stringify({ schemaVersion: 1, revision: 0, folders: [], pins: [], updatedAt: 1 }),
				)

				vi.mocked(fs.readFile).mockImplementationOnce(async () => {
					const err = new Error("EACCES") as NodeJS.ErrnoException
					err.code = "EACCES"
					throw err
				})
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await store["load"]()

				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining("Failed to read organization file"),
					expect.any(Error),
				)
				consoleSpy.mockRestore()
			})

			it("logs error when quarantine writeFile fails", async () => {
				vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("quarantine failed"))
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await store["quarantine"]("some-file", "raw content")

				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining("Failed to quarantine corrupted organization file"),
					expect.any(Error),
				)
				consoleSpy.mockRestore()
			})

			it("rejects duplicate folderId in createFolder", async () => {
				await store.initialize()
				await store.mutate(
					{
						kind: "createFolder",
						folderId: "f1",
						name: "Folder 1",
						source: { kind: "task", taskId: "t1" },
						destination: { kind: "task", taskId: "t2" },
					},
					0,
				)

				const res = await store.mutate(
					{
						kind: "createFolder",
						folderId: "f1",
						name: "Folder Dup",
						source: { kind: "task", taskId: "t3" },
						destination: { kind: "task", taskId: "t4" },
					},
					1,
				)

				expect(res.success).toBe(false)
				expect(res.error?.code).toBe("TASK_ORG/VALIDATION/001")
				expect(res.error?.message).toBe("Folder already exists.")
			})

			it("rejects duplicate folderId in createFolderFromSelection", async () => {
				await store.initialize()
				await store.mutate(
					{
						kind: "createFolder",
						folderId: "f1",
						name: "Folder 1",
						source: { kind: "task", taskId: "t1" },
						destination: { kind: "task", taskId: "t2" },
					},
					0,
				)

				const res = await store.mutate(
					{
						kind: "createFolderFromSelection",
						folderId: "f1",
						name: "Folder Dup",
						targets: [
							{ kind: "task", taskId: "t3" },
							{ kind: "task", taskId: "t4" },
						],
					},
					1,
				)

				expect(res.success).toBe(false)
				expect(res.error?.code).toBe("TASK_ORG/VALIDATION/001")
			})

			it("rejects createFolderFromSelection if fewer than 2 units resolved", async () => {
				await store.initialize()
				const res = await store.mutate(
					{
						kind: "createFolderFromSelection",
						folderId: "f2",
						name: "Folder Single",
						targets: [
							{ kind: "task", taskId: "t1" },
							{ kind: "task", taskId: "t1" },
						],
					},
					0,
				)

				expect(res.success).toBe(false)
				expect(res.error?.code).toBe("TASK_ORG/VALIDATION/001")
				expect(res.error?.message).toContain("At least two canonical units are required")
			})

			it("rejects deleteFolders when folderId is not found", async () => {
				await store.initialize()
				const res = await store.mutate(
					{
						kind: "deleteFolders",
						folderIds: ["non-existent-folder"],
					},
					0,
				)

				expect(res.success).toBe(false)
				expect(res.error?.code).toBe("TASK_ORG/NOT_FOUND/004")
			})

			it("unpinning a target that is not pinned is a no-op", async () => {
				await store.initialize()
				const res = await store.mutate(
					{
						kind: "setPinned",
						target: { kind: "task", taskId: "t1" },
						pinned: false,
					},
					0,
				)

				expect(res.success).toBe(true)
				expect(store.getState().pins).toHaveLength(0)
			})

			it("handles unknown mutation kind in applyMutation", async () => {
				await store.initialize()
				const res = await store.mutate(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					{ kind: "unknownMutation" } as any,
					0,
				)

				expect(res.success).toBe(false)
				expect(res.error?.code).toBe("TASK_ORG/VALIDATION/001")
			})

			it("resolves unit correctly for folder target and default fallback", async () => {
				await store.initialize()
				await store.mutate(
					{
						kind: "createFolder",
						folderId: "f1",
						name: "Folder 1",
						source: { kind: "task", taskId: "t1" },
						destination: { kind: "task", taskId: "t2" },
					},
					0,
				)

				// resolveUnit for folder
				const units = store["resolveUnit"]({ kind: "folder", folderId: "f1" })
				expect(units).toEqual(["t1", "t2"])

				// resolveUnit for non-existent folder
				const emptyUnits = store["resolveUnit"]({ kind: "folder", folderId: "f-none" })
				expect(emptyUnits).toEqual([])

				// resolveUnit default branch
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const unknownUnits = store["resolveUnit"]({ kind: "unknown" } as any)
				expect(unknownUnits).toEqual([])
			})

			it("handles default cases in targetsEqual and recomputeFromHistory pin filter", async () => {
				await store.initialize()

				// targetsEqual with unknown kind
				expect(store["targetsEqual"]({ kind: "task", taskId: "a" }, { kind: "folder", folderId: "a" })).toBe(
					false,
				)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				expect(store["targetsEqual"]({ kind: "unknown" } as any, { kind: "unknown" } as any)).toBe(false)

				// recomputeFromHistory with unknown pin target kind
				const customState = store.getState()
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				customState.pins.push({ target: { kind: "unknown" } as any, pinnedAt: 100 })
				const recomputed = store["recomputeFromHistory"](customState)
				expect(
					recomputed.pins.some((p: unknown) => (p as { target: { kind: string } }).target.kind === "unknown"),
				).toBe(true)
			})

			it("tests fsWatcher event handling and startWatcher", async () => {
				await store.initialize()

				// Calling startWatcher when disposed does nothing
				store.dispose()
				store["startWatcher"]()

				// Test fsWatcher callback with non-matching filename
				const instance = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				await instance.initialize()

				// Exercise startWatcher when already disposed inside then
				const pendingInstance = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				pendingInstance.dispose()
				pendingInstance["startWatcher"]()

				instance.dispose()
			})

			it("covers all fsWatcher callback, error, and setup branches", async () => {
				let watchCallback: ((event: string, filename: string) => void) | undefined
				let watcherErrorListener: ((err: Error) => void) | undefined

				const mockWatcher = {
					on: vi.fn((event: string, listener: (err: Error) => void) => {
						if (event === "error") {
							watcherErrorListener = listener
						}
						return mockWatcher
					}),
					close: vi.fn(),
				}

				vi.mocked(fsSync.watch).mockImplementation(((
					_dir: string,
					_options: unknown,
					cb?: (event: string, filename: string) => void,
				) => {
					if (cb) {
						watchCallback = cb
					}
					return mockWatcher as unknown as fsSync.FSWatcher
				}) as typeof fsSync.watch)

				const instance = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				await instance.initialize()
				await new Promise((resolve) => setTimeout(resolve, 20))

				expect(watchCallback).toBeDefined()

				// 1. Non-matching filename
				watchCallback!("change", "other_file.json")

				// 2. Matching filename - sets debounce timer
				vi.useFakeTimers()
				watchCallback!("change", GlobalFileNames.taskOrganization)

				// 3. Matching filename again - clears previous debounce timer
				watchCallback!("change", GlobalFileNames.taskOrganization)

				// Run timer to trigger reloadFromWatcher
				await vi.runAllTimersAsync()
				vi.useRealTimers()

				// 4. Trigger watcher error listener
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				expect(watcherErrorListener).toBeDefined()
				watcherErrorListener!(new Error("watcher emitted error"))
				expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("fs.watch error:"), expect.any(Error))

				// 5. Callback when disposed
				instance.dispose()
				watchCallback!("change", GlobalFileNames.taskOrganization)

				vi.mocked(fsSync.watch).mockRestore()
				consoleSpy.mockRestore()
			})

			it("handles error thrown by fsSync.watch", async () => {
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				vi.mocked(fsSync.watch).mockImplementationOnce(() => {
					throw new Error("watch start failed")
				})

				const instance = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				await instance.initialize()
				await new Promise((resolve) => setTimeout(resolve, 20))

				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining("Failed to start fs.watch:"),
					expect.any(Error),
				)

				instance.dispose()
				consoleSpy.mockRestore()
			})

			it("handles error in getTasksDir during startWatcher", async () => {
				const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				const instance = new TaskOrganizationStore(tmpDir, { taskHistory: history, now: () => 1000 })
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				vi.spyOn(instance as any, "getTasksDir").mockRejectedValueOnce(new Error("getTasksDir failed"))

				instance["startWatcher"]()
				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(consoleSpy).toHaveBeenCalledWith(
					expect.stringContaining("Failed to get tasks dir for watcher:"),
					expect.any(Error),
				)

				instance.dispose()
				consoleSpy.mockRestore()
			})
		})
	})
})
