import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"

// Wrap the real fs/promises so a test can pause inside the per-file lock
// while every call still runs against the real filesystem.
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readFile: vi.fn(actual.readFile) }
})

type WriteTaskFile = (item: HistoryItem, delta?: Partial<HistoryItem>) => Promise<HistoryItem>

interface WriteBarrier {
	arrivals(): number
	dispose(): void
}

function synchronizeNextWrites(stores: TaskHistoryStore[], timeoutMs = 2_000): WriteBarrier {
	let arrivals = 0
	let release!: () => void
	let rejectBarrier!: (error: Error) => void
	let settled = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const barrier = new Promise<void>((resolve, reject) => {
		rejectBarrier = reject
		release = () => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			resolve()
		}
		timer = setTimeout(() => {
			if (settled) return
			settled = true
			reject(new Error(`Only ${arrivals}/${stores.length} stores reached writeTaskFile within ${timeoutMs}ms`))
		}, timeoutMs)
	})
	void barrier.catch(() => {})

	for (const store of stores) {
		const value: unknown = Reflect.get(store, "writeTaskFile")
		if (typeof value !== "function") throw new Error("TaskHistoryStore.writeTaskFile is unavailable")
		const original = value.bind(store) as WriteTaskFile
		Reflect.set(store, "writeTaskFile", async (historyItem: HistoryItem, delta?: Partial<HistoryItem>) => {
			arrivals++
			if (arrivals === stores.length) release()
			await barrier
			return original(historyItem, delta)
		})
	}

	return {
		arrivals: () => arrivals,
		dispose: () => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			rejectBarrier(new Error("Write barrier disposed before all stores arrived"))
		},
	}
}

function item(id: string): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
	}
}

function createAction(actionId: string, message: string) {
	return {
		kind: "create_subtask" as const,
		actionId,
		approvalText: "{}",
		mode: "code",
		message,
		todos: [],
	}
}

describe("TaskHistoryStore real cross-host locking", () => {
	it("rejects resume for a task absent from cache without creating a record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-cache-miss-"))
		const store = new TaskHistoryStore(storagePath)
		try {
			await store.initialize()
			await expect(store.resumeInterruptedTask("missing")).rejects.toThrow("task missing not found in cache")
			expect(store.get("missing")).toBeUndefined()
			await expect(
				fs.access(path.join(storagePath, "tasks", "missing", "history_item.json")),
			).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it.each(["missing", "malformed", "schema", "identity"])(
		"rejects %s disk records during resume without overwriting them",
		async (scenario) => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-invalid-"))
			const store = new TaskHistoryStore(storagePath)
			const filePath = path.join(storagePath, "tasks", "child", "history_item.json")
			try {
				await store.initialize()
				await store.upsert({ ...item("child"), status: "interrupted" })
				const contents =
					scenario === "malformed"
						? "{broken"
						: JSON.stringify(scenario === "schema" ? { id: "child" } : item("other"))
				if (scenario === "missing") await fs.unlink(filePath)
				else await fs.writeFile(filePath, contents)
				await expect(store.resumeInterruptedTask("child")).rejects.toThrow(
					"task child has no valid disk record",
				)
				expect(store.get("child")).toBeUndefined()
				expect(store["taskFileMtimes"].has("child")).toBe(false)
				if (scenario === "missing") await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
				else expect(await fs.readFile(filePath, "utf8")).toBe(contents)
			} finally {
				store.dispose()
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		},
	)

	it("resumes from the authoritative interrupted record even when the caller cache is stale", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-resume-lock-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			await storeA.upsert({ ...item("shared-task"), status: "interrupted" })

			expect(storeB.get("shared-task")?.status).toBe("active")
			await expect(storeB.resumeInterruptedTask("shared-task")).resolves.toMatchObject({
				id: "shared-task",
				status: "active",
			})
			await storeA.invalidate("shared-task")
			expect(storeA.get("shared-task")?.status).toBe("active")
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("rejects resume when the authoritative record is no longer interrupted", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-resume-rejected-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			await storeA.upsert({ ...item("shared-task"), status: "completed" })

			await expect(storeB.resumeInterruptedTask("shared-task")).rejects.toThrow(
				"Cannot resume task shared-task with status completed",
			)
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")?.status).toBe("completed")
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves independent stale-cache deltas through the real per-file lock", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-real-lock-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		let writeBarrier: WriteBarrier | undefined

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			writeBarrier = synchronizeNextWrites([storeA, storeB])

			await Promise.all([
				storeA.atomicReadAndUpdate("shared-task", (current) => ({ ...current, mode: "architect" })),
				storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, totalCost: 42 })),
			])

			expect(writeBarrier.arrivals()).toBe(2)
			await storeA.invalidate("shared-task")
			expect(storeA.get("shared-task")).toMatchObject({ mode: "architect", totalCost: 42 })
		} finally {
			writeBarrier?.dispose()
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("reports a bounded error when one store never reaches the write barrier", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missed-barrier-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		let writeBarrier: WriteBarrier | undefined

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()
			writeBarrier = synchronizeNextWrites([storeA, storeB], 50)

			await expect(
				storeA.atomicReadAndUpdate("shared-task", (current) => ({ ...current, mode: "architect" })),
			).rejects.toThrow("Only 1/2 stores reached writeTaskFile within 50ms")
			expect(writeBarrier.arrivals()).toBe(1)
		} finally {
			writeBarrier?.dispose()
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves a replacement pending action when a stale store settles the prior action", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-stale-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")
		const actionB = { ...actionA, actionId: "action-b", message: "action B" }

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			await storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, pendingAction: actionB }))
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionA)

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)
			expect(authoritative.pendingAction).toEqual(actionB)
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionB)
			await storeB.invalidate("shared-task")

			expect(storeB.get("shared-task")?.pendingAction).toEqual(actionB)
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("clears a matching create_subtask action from disk and refreshes the cache", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-compare-clear-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)

			expect(authoritative.pendingAction).toBeUndefined()
			expect(storeA.get("shared-task")?.pendingAction).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")?.pendingAction).toBeUndefined()
			expect(storeB.get("shared-task")).toMatchObject({ id: "shared-task", status: "active" })
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves a matching create_subtask action on a completed record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-completed-settlement-"))
		const store = new TaskHistoryStore(storagePath)
		const pendingAction = createAction("action-a", "action A")
		const completed: HistoryItem = { ...item("shared-task"), status: "completed", pendingAction }
		const filePath = path.join(storagePath, "tasks", completed.id, "history_item.json")

		try {
			await store.initialize()
			await store.upsert(completed)

			const beforeDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem
			expect({ cache: store.get(completed.id), disk: beforeDisk }).toEqual({ cache: completed, disk: completed })

			const returned = await store.clearPendingActionIfMatching(completed.id, pendingAction.actionId)
			const afterDisk = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem

			expect({ returned, disk: afterDisk, cache: store.get(completed.id) }).toEqual({
				returned: completed,
				disk: completed,
				cache: completed,
			})
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("clears a matching action from disk even when the calling store cache is stale", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-disk-compare-clear-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))
			await storeB.initialize()

			await storeB.atomicReadAndUpdate("shared-task", (current) => ({ ...current, pendingAction: actionA }))

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)

			expect(authoritative.pendingAction).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")?.pendingAction).toBeUndefined()
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves a different-kind pending action with the same action ID", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-different-kind-"))
		const storeA = new TaskHistoryStore(storagePath)
		const finishAction = {
			kind: "finish_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			parentTaskId: "parent-1",
			result: "done",
		}

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: finishAction })

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", finishAction.actionId)

			expect(authoritative.pendingAction).toEqual(finishAction)
			expect(storeA.get("shared-task")?.pendingAction).toEqual(finishAction)
		} finally {
			storeA.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("preserves the record when no pending action is persisted", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-no-action-"))
		const storeA = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("shared-task"))

			const authoritative = await storeA.clearPendingActionIfMatching("shared-task", "action-a")

			expect(authoritative.pendingAction).toBeUndefined()
			expect(authoritative).toMatchObject({ id: "shared-task", status: "active" })
		} finally {
			storeA.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("does not recreate a task deleted by another host before settlement", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-deleted-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const actionA = createAction("action-a", "action A")

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: actionA })
			await storeB.initialize()

			await storeB.delete("shared-task")
			expect(storeA.get("shared-task")?.pendingAction).toEqual(actionA)

			await expect(storeA.clearPendingActionIfMatching("shared-task", actionA.actionId)).rejects.toThrow(
				"task shared-task not found",
			)
			expect(storeA.get("shared-task")).toBeUndefined()
			await storeB.invalidate("shared-task")
			expect(storeB.get("shared-task")).toBeUndefined()
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("serializes deletion after settlement reads disk without recreating the record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-delete-during-settlement-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const action = createAction("action-a", "action A")
		const filePath = path.join(storagePath, "tasks", "shared-task", "history_item.json")
		const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		let signalReadComplete!: () => void
		const readComplete = new Promise<void>((resolve) => {
			signalReadComplete = resolve
		})
		let releaseSettlement!: () => void
		const settlementCanContinue = new Promise<void>((resolve) => {
			releaseSettlement = resolve
		})

		try {
			await storeA.initialize()
			await storeA.upsert({ ...item("shared-task"), pendingAction: action })
			await storeB.initialize()

			// Pause settlement inside its locked disk read, then start a
			// deletion from another store so it targets the settlement's
			// read-to-commit window.
			vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
				const result = await actualFs.readFile(...args)
				if (args[0] === filePath) {
					signalReadComplete()
					await settlementCanContinue
				}
				return result
			})

			const settlement = storeA.clearPendingActionIfMatching("shared-task", action.actionId)
			await readComplete
			const deletion = storeB.delete("shared-task")
			let deletionSettled = false
			void deletion.finally(() => {
				deletionSettled = true
			})
			await new Promise((resolve) => setTimeout(resolve, 25))
			// The deletion must stay blocked while settlement holds the
			// per-file lock across its read-to-commit window.
			expect(deletionSettled).toBe(false)

			releaseSettlement()
			await expect(settlement).resolves.toMatchObject({ id: "shared-task", pendingAction: undefined })
			await deletion

			// The settlement committed first and the locked deletion
			// removed the file afterwards, so the record stays deleted
			// instead of being resurrected.
			await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(storeA.clearPendingActionIfMatching("shared-task", action.actionId)).rejects.toThrow(
				"task shared-task not found",
			)
			expect(storeA.get("shared-task")).toBeUndefined()
			expect(storeB.get("shared-task")).toBeUndefined()
		} finally {
			vi.mocked(fs.readFile).mockImplementation(actualFs.readFile)
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("rejects settlement for a task absent from the cache without creating it", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-cache-miss-settlement-"))
		const store = new TaskHistoryStore(storagePath)
		const filePath = path.join(storagePath, "tasks", "missing-task", "history_item.json")

		try {
			await store.initialize()

			await expect(store.clearPendingActionIfMatching("missing-task", "action-a")).rejects.toThrow(
				"task missing-task not found in cache",
			)
			expect(store.get("missing-task")).toBeUndefined()
			await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})
