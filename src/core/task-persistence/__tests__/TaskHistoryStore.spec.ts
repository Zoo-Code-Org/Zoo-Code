// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
		return defaultPath
	}),
}))

// Mock safeWriteJson to use plain fs writes in tests (avoids proper-lockfile issues)
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: any) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
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

describe("TaskHistoryStore", () => {
	let tmpDir: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-test-"))
		store = new TaskHistoryStore(tmpDir)
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	describe("initialize()", () => {
		it("initializes from empty state (no index, no task dirs)", async () => {
			await store.initialize()
			expect(store.getAll()).toEqual([])
		})

		it("initializes from existing index file", async () => {
			const tasksDir = path.join(tmpDir, "tasks")
			await fs.mkdir(tasksDir, { recursive: true })

			const item1 = makeHistoryItem({ id: "task-1", ts: 1000 })
			const item2 = makeHistoryItem({ id: "task-2", ts: 2000 })

			// Create task directories so reconciliation doesn't remove them
			await fs.mkdir(path.join(tasksDir, "task-1"), { recursive: true })
			await fs.mkdir(path.join(tasksDir, "task-2"), { recursive: true })

			// Write per-task files
			await fs.writeFile(path.join(tasksDir, "task-1", GlobalFileNames.historyItem), JSON.stringify(item1))
			await fs.writeFile(path.join(tasksDir, "task-2", GlobalFileNames.historyItem), JSON.stringify(item2))

			// Write index
			const index = {
				version: 1,
				updatedAt: Date.now(),
				entries: [item1, item2],
			}
			await fs.writeFile(path.join(tasksDir, GlobalFileNames.historyIndex), JSON.stringify(index))

			await store.initialize()

			expect(store.getAll()).toHaveLength(2)
			expect(store.get("task-1")).toBeDefined()
			expect(store.get("task-2")).toBeDefined()
		})
	})

	describe("get()", () => {
		it("returns undefined for non-existent task", async () => {
			await store.initialize()
			expect(store.get("non-existent")).toBeUndefined()
		})

		it("returns the item after upsert", async () => {
			await store.initialize()
			const item = makeHistoryItem({ id: "task-get" })
			await store.upsert(item)
			expect(store.get("task-get")).toMatchObject({ id: "task-get" })
		})
	})

	describe("getAll()", () => {
		it("returns items sorted by ts descending", async () => {
			await store.initialize()

			await store.upsert(makeHistoryItem({ id: "old", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "mid", ts: 2000 }))
			await store.upsert(makeHistoryItem({ id: "new", ts: 3000 }))

			const all = store.getAll()
			expect(all).toHaveLength(3)
			expect(all[0].id).toBe("new")
			expect(all[1].id).toBe("mid")
			expect(all[2].id).toBe("old")
		})
	})

	describe("getByWorkspace()", () => {
		it("filters by workspace path", async () => {
			await store.initialize()

			await store.upsert(makeHistoryItem({ id: "ws-a-1", workspace: "/workspace-a" }))
			await store.upsert(makeHistoryItem({ id: "ws-a-2", workspace: "/workspace-a" }))
			await store.upsert(makeHistoryItem({ id: "ws-b-1", workspace: "/workspace-b" }))

			const wsA = store.getByWorkspace("/workspace-a")
			expect(wsA).toHaveLength(2)
			expect(wsA.every((item) => item.workspace === "/workspace-a")).toBe(true)

			const wsB = store.getByWorkspace("/workspace-b")
			expect(wsB).toHaveLength(1)
			expect(wsB[0].id).toBe("ws-b-1")
		})
	})

	describe("upsert()", () => {
		it("writes per-task file and updates cache", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "upsert-task" })
			const result = await store.upsert(item)

			// Cache should be updated
			expect(store.get("upsert-task")).toBeDefined()
			expect(result.length).toBe(1)

			// Per-task file should exist
			const filePath = path.join(tmpDir, "tasks", "upsert-task", GlobalFileNames.historyItem)
			const raw = await fs.readFile(filePath, "utf8")
			const written = JSON.parse(raw)
			expect(written.id).toBe("upsert-task")
		})

		it("preserves existing metadata on partial updates (delegation fields)", async () => {
			await store.initialize()

			const original = makeHistoryItem({
				id: "delegate-task",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: ["child-1"],
			})
			await store.upsert(original)

			// Partial update that doesn't include delegation fields
			const partialUpdate: HistoryItem = makeHistoryItem({
				id: "delegate-task",
				tokensIn: 500,
				tokensOut: 200,
			})
			await store.upsert(partialUpdate)

			const result = store.get("delegate-task")!
			expect(result.status).toBe("delegated")
			expect(result.delegatedToId).toBe("child-1")
			expect(result.awaitingChildId).toBe("child-1")
			expect(result.childIds).toEqual(["child-1"])
			expect(result.tokensIn).toBe(500)
			expect(result.tokensOut).toBe(200)
		})

		it("returns updated task history array", async () => {
			await store.initialize()

			const item1 = makeHistoryItem({ id: "item-1", ts: 1000 })
			const item2 = makeHistoryItem({ id: "item-2", ts: 2000 })

			await store.upsert(item1)
			const result = await store.upsert(item2)

			expect(result).toHaveLength(2)
			// Should be sorted by ts descending
			expect(result[0].id).toBe("item-2")
			expect(result[1].id).toBe("item-1")
		})
	})

	describe("delete()", () => {
		it("removes per-task file and updates cache", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "del-task" })
			await store.upsert(item)
			expect(store.get("del-task")).toBeDefined()

			await store.delete("del-task")
			expect(store.get("del-task")).toBeUndefined()
			expect(store.getAll()).toHaveLength(0)
		})

		it("handles deleting non-existent task gracefully", async () => {
			await store.initialize()
			await expect(store.delete("non-existent")).resolves.not.toThrow()
		})
	})

	describe("deleteMany()", () => {
		it("removes multiple tasks in batch", async () => {
			await store.initialize()

			await store.upsert(makeHistoryItem({ id: "batch-1" }))
			await store.upsert(makeHistoryItem({ id: "batch-2" }))
			await store.upsert(makeHistoryItem({ id: "batch-3" }))
			expect(store.getAll()).toHaveLength(3)

			await store.deleteMany(["batch-1", "batch-3"])
			expect(store.getAll()).toHaveLength(1)
			expect(store.get("batch-2")).toBeDefined()
		})
	})

	describe("reconcile()", () => {
		it("detects tasks on disk missing from index", async () => {
			await store.initialize()

			// Manually create a task directory with history_item.json
			const tasksDir = path.join(tmpDir, "tasks")
			const taskDir = path.join(tasksDir, "orphan-task")
			await fs.mkdir(taskDir, { recursive: true })

			const item = makeHistoryItem({ id: "orphan-task" })
			await fs.writeFile(path.join(taskDir, GlobalFileNames.historyItem), JSON.stringify(item))

			// Reconcile should pick it up
			await store.reconcile()

			expect(store.get("orphan-task")).toBeDefined()
			expect(store.get("orphan-task")!.id).toBe("orphan-task")
		})

		it("removes tasks from cache that no longer exist on disk", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "removed-task" })
			await store.upsert(item)
			expect(store.get("removed-task")).toBeDefined()

			// Remove the task directory from disk
			const taskDir = path.join(tmpDir, "tasks", "removed-task")
			await fs.rm(taskDir, { recursive: true, force: true })

			// Reconcile should remove it from cache
			await store.reconcile()

			expect(store.get("removed-task")).toBeUndefined()
		})
	})

	describe("concurrent upsert() calls are serialized", () => {
		it("serializes concurrent writes so no entries are lost", async () => {
			await store.initialize()

			// Fire 5 concurrent upserts
			const promises = Array.from({ length: 5 }, (_, i) =>
				store.upsert(makeHistoryItem({ id: `concurrent-${i}`, ts: 1000 + i })),
			)

			await Promise.all(promises)

			const all = store.getAll()
			expect(all).toHaveLength(5)
			const ids = all.map((h) => h.id)
			for (let i = 0; i < 5; i++) {
				expect(ids).toContain(`concurrent-${i}`)
			}
		})

		it("serializes interleaved upsert and delete", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "interleave-test", ts: 1000 })
			await store.upsert(item)

			// Concurrent update and delete of different items
			const promise1 = store.upsert(makeHistoryItem({ id: "survivor", ts: 2000 }))
			const promise2 = store.delete("interleave-test")

			await Promise.all([promise1, promise2])

			expect(store.get("interleave-test")).toBeUndefined()
			expect(store.get("survivor")).toBeDefined()
		})
	})

	describe("migrateFromGlobalState()", () => {
		it("writes history_item.json for tasks with existing directories", async () => {
			await store.initialize()

			const tasksDir = path.join(tmpDir, "tasks")

			// Create task directories (simulating existing tasks)
			await fs.mkdir(path.join(tasksDir, "legacy-1"), { recursive: true })
			await fs.mkdir(path.join(tasksDir, "legacy-2"), { recursive: true })

			const items = [
				makeHistoryItem({ id: "legacy-1", task: "Legacy task 1" }),
				makeHistoryItem({ id: "legacy-2", task: "Legacy task 2" }),
				makeHistoryItem({ id: "legacy-orphan", task: "Orphaned task" }), // No directory
			]

			await store.migrateFromGlobalState(items)

			// Should have migrated 2 items (skipping orphan)
			expect(store.get("legacy-1")).toBeDefined()
			expect(store.get("legacy-2")).toBeDefined()
			expect(store.get("legacy-orphan")).toBeUndefined()
		})

		it("does not overwrite existing per-task files", async () => {
			await store.initialize()

			const tasksDir = path.join(tmpDir, "tasks")
			const taskDir = path.join(tasksDir, "existing-task")
			await fs.mkdir(taskDir, { recursive: true })

			// Write an existing history_item.json with specific data
			const existingItem = makeHistoryItem({
				id: "existing-task",
				task: "Original task text",
				tokensIn: 999,
			})
			await fs.writeFile(path.join(taskDir, GlobalFileNames.historyItem), JSON.stringify(existingItem))

			// Try to migrate with different data
			const migratedItem = makeHistoryItem({
				id: "existing-task",
				task: "Different task text",
				tokensIn: 1,
			})
			await store.migrateFromGlobalState([migratedItem])

			// Existing file should not be overwritten
			const raw = await fs.readFile(path.join(taskDir, GlobalFileNames.historyItem), "utf8")
			const persisted = JSON.parse(raw)
			expect(persisted.task).toBe("Original task text")
			expect(persisted.tokensIn).toBe(999)
		})

		it("is idempotent (can be called multiple times safely)", async () => {
			await store.initialize()

			const tasksDir = path.join(tmpDir, "tasks")
			await fs.mkdir(path.join(tasksDir, "idem-task"), { recursive: true })

			const item = makeHistoryItem({ id: "idem-task" })

			await store.migrateFromGlobalState([item])
			await store.migrateFromGlobalState([item]) // Second call

			expect(store.get("idem-task")).toBeDefined()
		})
	})

	describe("flushIndex()", () => {
		it("writes index to disk on flush", async () => {
			await store.initialize()

			await store.upsert(makeHistoryItem({ id: "flush-task" }))
			await store.flushIndex()

			const indexPath = path.join(tmpDir, "tasks", GlobalFileNames.historyIndex)
			const raw = await fs.readFile(indexPath, "utf8")
			const index = JSON.parse(raw)

			expect(index.version).toBe(1)
			expect(index.entries).toHaveLength(1)
			expect(index.entries[0].id).toBe("flush-task")
		})
	})

	describe("dispose()", () => {
		it("flushes index on dispose", async () => {
			await store.initialize()

			await store.upsert(makeHistoryItem({ id: "dispose-task" }))
			store.dispose()

			// Give the flush a moment to complete
			await new Promise((resolve) => setTimeout(resolve, 100))

			const indexPath = path.join(tmpDir, "tasks", GlobalFileNames.historyIndex)
			const raw = await fs.readFile(indexPath, "utf8")
			const index = JSON.parse(raw)
			expect(index.entries).toHaveLength(1)
		})
	})

	describe("invalidate()", () => {
		it("re-reads a task from disk", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "invalidate-task", tokensIn: 100 })
			await store.upsert(item)

			// Manually update the file on disk
			const filePath = path.join(tmpDir, "tasks", "invalidate-task", GlobalFileNames.historyItem)
			const updated = { ...item, tokensIn: 999 }
			await fs.writeFile(filePath, JSON.stringify(updated))

			await store.invalidate("invalidate-task")

			expect(store.get("invalidate-task")!.tokensIn).toBe(999)
		})

		it("removes item from cache if file no longer exists", async () => {
			await store.initialize()

			const item = makeHistoryItem({ id: "gone-task" })
			await store.upsert(item)

			// Delete the file
			const filePath = path.join(tmpDir, "tasks", "gone-task", GlobalFileNames.historyItem)
			await fs.unlink(filePath)

			await store.invalidate("gone-task")

			expect(store.get("gone-task")).toBeUndefined()
		})
	})

	describe("atomicUpdatePair()", () => {
		it("updates both records and both files are written before lock releases", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-pair", status: "active", ts: 1000 })
			const parent = makeHistoryItem({ id: "parent-pair", status: "delegated", ts: 2000 })
			await store.upsert(child)
			await store.upsert(parent)

			await store.atomicUpdatePair(
				"child-pair",
				"parent-pair",
				(c) => ({ ...c, status: "completed" as const }),
				(p) => ({ ...p, status: "active" as const, awaitingChildId: undefined }),
			)

			expect(store.get("child-pair")?.status).toBe("completed")
			expect(store.get("parent-pair")?.status).toBe("active")
			expect(store.get("parent-pair")?.awaitingChildId).toBeUndefined()

			// Both per-task files must be persisted
			const childFile = path.join(tmpDir, "tasks", "child-pair", GlobalFileNames.historyItem)
			const parentFile = path.join(tmpDir, "tasks", "parent-pair", GlobalFileNames.historyItem)
			const childDisk = JSON.parse(await fs.readFile(childFile, "utf8"))
			const parentDisk = JSON.parse(await fs.readFile(parentFile, "utf8"))
			expect(childDisk.status).toBe("completed")
			expect(parentDisk.status).toBe("active")
		})

		it("a concurrent upsert queued during the pair write sees completed state of both records", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-concurrent", status: "active", ts: 1000 })
			const parent = makeHistoryItem({ id: "parent-concurrent", status: "delegated", ts: 2000 })
			await store.upsert(child)
			await store.upsert(parent)

			// Queue atomicUpdatePair and a follow-up upsert concurrently
			const pairPromise = store.atomicUpdatePair(
				"child-concurrent",
				"parent-concurrent",
				(c) => ({ ...c, status: "completed" as const }),
				(p) => ({ ...p, status: "active" as const }),
			)

			// This upsert is queued while the pair lock is held — it must see the final state
			const followUp = store.upsert({ ...parent, status: "active" as const, tokensOut: 999 })

			await pairPromise
			await followUp

			// Both pair updates landed; follow-up should have merged on top
			expect(store.get("child-concurrent")?.status).toBe("completed")
			expect(store.get("parent-concurrent")?.status).toBe("active")
			expect(store.get("parent-concurrent")?.tokensOut).toBe(999)
		})

		it("throws when first updater returns a different id", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-id-check" })
			const parent = makeHistoryItem({ id: "parent-id-check" })
			await store.upsert(child)
			await store.upsert(parent)

			await expect(
				store.atomicUpdatePair(
					"child-id-check",
					"parent-id-check",
					(c) => ({ ...c, id: "wrong-id" }),
					(p) => p,
				),
			).rejects.toThrow(
				"[TaskHistoryStore] atomicUpdatePair: first updater changed id from child-id-check to wrong-id",
			)
		})

		it("throws when second updater returns a different id", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-id-check2" })
			const parent = makeHistoryItem({ id: "parent-id-check2" })
			await store.upsert(child)
			await store.upsert(parent)

			await expect(
				store.atomicUpdatePair(
					"child-id-check2",
					"parent-id-check2",
					(c) => c,
					(p) => ({ ...p, id: "wrong-id" }),
				),
			).rejects.toThrow(
				"[TaskHistoryStore] atomicUpdatePair: second updater changed id from parent-id-check2 to wrong-id",
			)
		})

		it("throws when first task ID is not in cache", async () => {
			await store.initialize()

			const parent = makeHistoryItem({ id: "parent-missing-child" })
			await store.upsert(parent)

			await expect(
				store.atomicUpdatePair(
					"nonexistent-child",
					"parent-missing-child",
					(c) => c,
					(p) => p,
				),
			).rejects.toThrow("[TaskHistoryStore] atomicUpdatePair: nonexistent-child not found")
		})

		it("throws when second task ID is not in cache", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-missing-parent" })
			await store.upsert(child)

			await expect(
				store.atomicUpdatePair(
					"child-missing-parent",
					"nonexistent-parent",
					(c) => c,
					(p) => p,
				),
			).rejects.toThrow("[TaskHistoryStore] atomicUpdatePair: nonexistent-parent not found")
		})

		it("partial failure: first file write lands, second throws — error surfaces; cache unchanged (known disk/cache divergence)", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-partial", status: "active", ts: 1000 })
			const parent = makeHistoryItem({ id: "parent-partial", status: "delegated", ts: 2000 })
			await store.upsert(child)
			await store.upsert(parent)

			let writeCallCount = 0
			const storeAny = store as any
			const originalWriteTaskFile = storeAny.writeTaskFile.bind(store)
			vi.spyOn(storeAny, "writeTaskFile").mockImplementation(async (...args: unknown[]) => {
				writeCallCount++
				if (writeCallCount === 2) throw new Error("second writeTaskFile failed")
				return originalWriteTaskFile(...args)
			})

			await expect(
				store.atomicUpdatePair(
					"child-partial",
					"parent-partial",
					(c) => ({ ...c, status: "completed" as const }),
					(p) => ({ ...p, status: "active" as const }),
				),
			).rejects.toThrow("second writeTaskFile failed")

			// First file write landed on disk (known limitation — no rollback)
			const childFile = path.join(tmpDir, "tasks", "child-partial", GlobalFileNames.historyItem)
			const childDisk = JSON.parse(await fs.readFile(childFile, "utf8"))
			expect(childDisk.status).toBe("completed")

			// Second file write did not land
			const parentFile = path.join(tmpDir, "tasks", "parent-partial", GlobalFileNames.historyItem)
			const parentDisk = JSON.parse(await fs.readFile(parentFile, "utf8"))
			expect(parentDisk.status).toBe("delegated")

			// Cache was NOT updated (cache set is deferred until after both writes succeed)
			expect(store.get("child-partial")?.status).toBe("active")
			expect(store.get("parent-partial")?.status).toBe("delegated")
		})

		it("invokes onWrite callback once with both records updated", async () => {
			const onWrite = vi.fn().mockResolvedValue(undefined)
			const storeWithCallback = new TaskHistoryStore(tmpDir, { onWrite })
			await storeWithCallback.initialize()

			const child = makeHistoryItem({ id: "child-onwrite", status: "active" })
			const parent = makeHistoryItem({ id: "parent-onwrite", status: "delegated" })
			await storeWithCallback.upsert(child)
			await storeWithCallback.upsert(parent)

			onWrite.mockClear()

			await storeWithCallback.atomicUpdatePair(
				"child-onwrite",
				"parent-onwrite",
				(c) => ({ ...c, status: "completed" as const }),
				(p) => ({ ...p, status: "active" as const }),
			)

			// onWrite called exactly once (not once per record)
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenItems = onWrite.mock.calls[0][0] as HistoryItem[]
			const childWritten = writtenItems.find((i) => i.id === "child-onwrite")
			const parentWritten = writtenItems.find((i) => i.id === "parent-onwrite")
			expect(childWritten?.status).toBe("completed")
			expect(parentWritten?.status).toBe("active")

			storeWithCallback.dispose()
		})

		it("propagates throw from first updater — neither record is written", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-updater-throw", status: "active" })
			const parent = makeHistoryItem({ id: "parent-updater-throw", status: "delegated" })
			await store.upsert(child)
			await store.upsert(parent)

			await expect(
				store.atomicUpdatePair(
					"child-updater-throw",
					"parent-updater-throw",
					(_c) => {
						throw new Error("updater exploded")
					},
					(p) => p,
				),
			).rejects.toThrow("updater exploded")

			// Neither record should have been modified
			expect(store.get("child-updater-throw")?.status).toBe("active")
			expect(store.get("parent-updater-throw")?.status).toBe("delegated")
		})

		it("transition guard in first updater: delegated → completed throws assertValidTransition", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-guard-pair", status: "delegated" })
			const parent = makeHistoryItem({ id: "parent-guard-pair", status: "active" })
			await store.upsert(child)
			await store.upsert(parent)

			await expect(
				store.atomicUpdatePair(
					"child-guard-pair",
					"parent-guard-pair",
					(c) => {
						assertValidTransition(c.status, "completed")
						return { ...c, status: "completed" as const }
					},
					(p) => p,
				),
			).rejects.toThrow("Invalid task status transition: delegated → completed")

			// Original statuses preserved
			expect(store.get("child-guard-pair")?.status).toBe("delegated")
			expect(store.get("parent-guard-pair")?.status).toBe("active")
		})

		it("store-level guard in atomicUpdatePair rejects invalid transition even without explicit updater assertion", async () => {
			await store.initialize()

			const child = makeHistoryItem({ id: "child-store-guard", status: "delegated" })
			const parent = makeHistoryItem({ id: "parent-store-guard", status: "active" })
			await store.upsert(child)
			await store.upsert(parent)

			// Updater returns delegated → completed without calling assertValidTransition.
			// The store's internal guard must still catch this.
			await expect(
				store.atomicUpdatePair(
					"child-store-guard",
					"parent-store-guard",
					(c) => ({ ...c, status: "completed" as const }),
					(p) => p,
				),
			).rejects.toThrow("Invalid task status transition: delegated → completed")

			// Neither record modified
			expect(store.get("child-store-guard")?.status).toBe("delegated")
			expect(store.get("parent-store-guard")?.status).toBe("active")
		})
	})
})
