import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import { abandonDelegatedChild, delegateTaskToChild, LifecycleTransitionError } from "../taskLifecycle"
import { acquireFileLock } from "../../../utils/fileLock"

// Wrap the real fs/promises so a test can pause inside the per-file lock
// while every call still runs against the real filesystem.
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) }
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
			await expect(store.resumeInterruptedTask("missing")).rejects.toThrow(LifecycleTransitionError)
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
				const rejection = store.resumeInterruptedTask("child")
				await expect(rejection).rejects.toThrow(LifecycleTransitionError)
				await expect(rejection).rejects.toThrow("task child has no valid disk record")
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

	it("rejects resume after a competing host re-delegates the parent", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-redelegated-parent-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await storeA.initialize()
			await storeA.upsert(parent)
			await storeA.upsert(child)
			await storeB.initialize()

			await storeB.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
				delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
			)

			await expect(storeA.resumeInterruptedTask("child", "parent")).rejects.toThrow(
				"parent parent no longer awaits it",
			)
			await storeA.invalidate("child")
			await storeA.invalidate("parent")
			expect(storeA.get("child")?.status).toBe("interrupted")
			expect(storeA.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child-b" })
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("rejects re-delegation after a competing host resumed the awaited child", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "redelegation-resumed-child-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await storeA.initialize()
			await storeA.upsert(parent)
			await storeA.upsert(child)
			await storeB.initialize()

			await storeA.resumeInterruptedTask("child", "parent")
			expect(storeA.get("child")?.status).toBe("active")

			await expect(
				storeB.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
					delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
				),
			).rejects.toThrow("not interrupted")

			await storeB.invalidate("parent")
			await storeB.invalidate("child")
			expect(storeB.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
			expect(storeB.get("child")?.status).toBe("active")
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("reads the awaited child's disk record at lock time even when the cache is stale", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "redelegation-stale-cache-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await storeA.initialize()
			await storeA.upsert(parent)
			await storeA.upsert(child)
			// storeB's cache captures the pre-resume state and never refreshes.
			await storeB.initialize()
			expect(storeB.get("child")?.status).toBe("interrupted")

			await storeA.resumeInterruptedTask("child", "parent")

			await expect(
				storeB.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
					delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
				),
			).rejects.toThrow("not interrupted")

			await storeB.invalidate("parent")
			expect(storeB.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("waits for the awaited child's file lock while a peer write hides the record", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "redelegation-child-lock-window-"))
		const store = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await store.initialize()
			await store.upsert(parent)
			await store.upsert(child)

			// A peer safeWriteJson holds the child file lock and has renamed
			// the record to its backup, so the target is missing until the
			// commit rename. The delegation must wait for the lock instead of
			// rejecting the hidden record as missing.
			const childFilePath = path.join(storagePath, "tasks", "child", "history_item.json")
			const releaseChildLock = await acquireFileLock(childFilePath)
			await fs.unlink(childFilePath)

			const originalRead = store["readValidatedTaskFile"].bind(store)
			let markParentRecordRead!: () => void
			const parentRecordRead = new Promise<void>((resolve) => {
				markParentRecordRead = resolve
			})
			store["readValidatedTaskFile"] = async (taskId: string) => {
				if (taskId === "parent") markParentRecordRead()
				return originalRead(taskId)
			}

			let settled = false
			const delegation = store
				.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
					delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
				)
				.then(
					() => {
						settled = true
					},
					() => {
						settled = true
					},
				)
			// The parent record is read first. After the flush, an unlocked
			// child read would already have rejected the hidden record, while
			// the locked read cannot settle before the release below.
			await parentRecordRead
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(settled).toBe(false)

			// The peer commit makes the still-interrupted record visible again.
			await fs.writeFile(childFilePath, JSON.stringify(child), "utf8")
			await releaseChildLock()
			await delegation

			await store.invalidate("parent")
			expect(store.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child-b" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("re-reads the awaited child behind its lock and rejects a peer write that resumed it", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "redelegation-child-lock-resumed-"))
		const store = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await store.initialize()
			await store.upsert(parent)
			await store.upsert(child)

			// The peer commits a resumed (active) child during the hidden
			// window. The locked re-read must observe that committed record
			// and reject the re-delegation.
			const childFilePath = path.join(storagePath, "tasks", "child", "history_item.json")
			const releaseChildLock = await acquireFileLock(childFilePath)
			await fs.unlink(childFilePath)

			const originalRead = store["readValidatedTaskFile"].bind(store)
			let markParentRecordRead!: () => void
			const parentRecordRead = new Promise<void>((resolve) => {
				markParentRecordRead = resolve
			})
			store["readValidatedTaskFile"] = async (taskId: string) => {
				if (taskId === "parent") markParentRecordRead()
				return originalRead(taskId)
			}

			const delegation = store.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
				delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
			)
			// The parent record is read first. After the flush, an unlocked
			// child read would already have rejected with a missing-record
			// error, while the locked read waits for the release below.
			await parentRecordRead
			await new Promise((resolve) => setTimeout(resolve, 20))
			await fs.writeFile(childFilePath, JSON.stringify({ ...child, status: "active" }), "utf8")
			await releaseChildLock()

			await expect(delegation).rejects.toThrow("not interrupted")

			await store.invalidate("parent")
			expect(store.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
		} finally {
			store.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("commits a first delegation through the same lock-held parent write", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-first-lock-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)

		try {
			await storeA.initialize()
			await storeA.upsert(item("parent"))
			await storeB.initialize()

			await storeB.atomicUpdateParentDelegation("parent", (diskParent) =>
				delegateTaskToChild(diskParent, "child-b", undefined),
			)

			await storeA.invalidate("parent")
			expect(storeA.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child-b",
				delegatedToId: "child-b",
				childIds: ["child-b"],
			})
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("keeps the persisted delegation when a stale cached parent already shows the new status", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-stale-status-delta-"))
		const storeA = new TaskHistoryStore(storagePath)
		const storeB = new TaskHistoryStore(storagePath)
		const parent = {
			...item("parent"),
			status: "delegated" as const,
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		}
		const child = { ...item("child"), status: "interrupted" as const, parentTaskId: "parent", rootTaskId: "parent" }

		try {
			await storeA.initialize()
			await storeA.upsert(parent)
			await storeA.upsert(child)
			// storeB caches the delegated parent and never refreshes it.
			await storeB.initialize()
			expect(storeB.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })

			// Another host abandons the awaited child, so the disk parent
			// becomes active with no delegation pointers.
			const abandonedParent = storeA.get("parent")
			const abandonedChild = storeA.get("child")
			if (!abandonedParent || !abandonedChild) {
				throw new Error("abandon setup records are missing from store A")
			}
			await storeA.atomicUpdatePair(
				"child",
				"parent",
				(childRecord) => abandonDelegatedChild(abandonedParent, childRecord).child,
				(parentRecord) => abandonDelegatedChild(parentRecord, abandonedChild).parent,
			)
			await storeA.invalidate("parent")
			const parentAfterAbandon = storeA.get("parent")
			expect(parentAfterAbandon?.status).toBe("active")
			expect(parentAfterAbandon?.awaitingChildId).toBeUndefined()

			// storeB re-delegates from its stale cache. The builder runs on the
			// disk parent (active), but the cached parent already shows the new
			// status, so the delta must be computed against the disk record.
			await storeB.atomicUpdateParentDelegation("parent", (diskParent, awaitedChildDiskStatus) =>
				delegateTaskToChild(diskParent, "child-b", awaitedChildDiskStatus),
			)

			await storeB.invalidate("parent")
			expect(storeB.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child-b",
				delegatedToId: "child-b",
			})
		} finally {
			storeA.dispose()
			storeB.dispose()
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("keeps the prior task record recoverable when resume persistence fails both renames", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "resume-partial-failure-"))
		const store = new TaskHistoryStore(storagePath)
		const taskDir = path.join(storagePath, "tasks", "child")
		const renameMock = vi.mocked(fs.rename)
		const originalRename = renameMock.getMockImplementation()

		try {
			await store.initialize()
			await store.upsert({ ...item("child"), status: "interrupted" })

			let renameCall = 0
			renameMock.mockImplementation(async (oldPath, newPath) => {
				renameCall++
				if (renameCall === 2) throw new Error("Primary rename failed")
				if (renameCall === 3) throw new Error("Rollback rename failed")
				return originalRename
					? originalRename(oldPath, newPath)
					: (fs.rename as unknown as typeof import("fs/promises").rename)(oldPath, newPath)
			})

			await expect(store.resumeInterruptedTask("child")).rejects.toThrow("Primary rename failed")

			// The commit rename removed the target and the rollback rename
			// failed. The surviving backup holds the only copy of the prior
			// interrupted record. The store kept that record in its cache.
			const files = await fs.readdir(taskDir)
			const backupName = files.find((name) => name.includes(".bak_"))
			expect(backupName).toBeDefined()
			const backupRecord = JSON.parse(await fs.readFile(path.join(taskDir, backupName!), "utf8"))
			expect(backupRecord).toMatchObject({ id: "child", status: "interrupted" })
			expect(store.get("child")?.status).toBe("interrupted")

			// Recovery: restore the backup and the record is readable again.
			await fs.rename(path.join(taskDir, backupName!), path.join(taskDir, "history_item.json"))
			await store.invalidate("child")
			expect(store.get("child")).toMatchObject({ id: "child", status: "interrupted" })
		} finally {
			if (originalRename) renameMock.mockImplementation(originalRename)
			store.dispose()
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

	describe("upsertPreservingLineage", () => {
		const detachedItem = (id: string): HistoryItem => {
			const record = { ...item(id), status: "interrupted" as const }
			delete (record as Partial<HistoryItem>).parentTaskId
			delete (record as Partial<HistoryItem>).rootTaskId
			return record
		}

		it("keeps a linked record linked through a stale message save", async () => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "preserve-lineage-linked-"))
			const store = new TaskHistoryStore(storagePath)
			const filePath = path.join(storagePath, "tasks", "child", "history_item.json")

			try {
				await store.initialize()
				await store.upsert({
					...item("child"),
					status: "interrupted",
					parentTaskId: "parent",
					rootTaskId: "root",
				})

				// A rehydrated task saves messages without holding lineage
				// authority, and another host has refreshed nothing here.
				const staleSave: HistoryItem = {
					...item("child"),
					status: "interrupted",
					task: "Updated",
					tokensOut: 7,
				}
				await expect(store.upsertPreservingLineage(staleSave)).resolves.toBeDefined()

				const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
				expect(persisted.parentTaskId).toBe("parent")
				expect(persisted.rootTaskId).toBe("root")
				expect(persisted.task).toBe("Updated")
				expect(store.get("child")).toMatchObject({ parentTaskId: "parent", rootTaskId: "root" })
			} finally {
				store.dispose()
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		})

		it("keeps a detached record detached when the local cache still holds stale links", async () => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "preserve-lineage-detached-"))
			const store = new TaskHistoryStore(storagePath)
			const filePath = path.join(storagePath, "tasks", "child", "history_item.json")

			try {
				await store.initialize()
				await store.upsert({
					...item("child"),
					status: "interrupted",
					parentTaskId: "parent",
					rootTaskId: "root",
				})

				// Another host detaches the record directly on disk; this
				// host's cache still shows the removed links.
				await fs.writeFile(filePath, JSON.stringify(detachedItem("child")), "utf8")

				const staleSave: HistoryItem = {
					...item("child"),
					status: "interrupted",
					task: "Updated",
					parentTaskId: "parent",
					rootTaskId: "root",
				}
				await store.upsertPreservingLineage(staleSave)

				const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
				expect(persisted).not.toHaveProperty("parentTaskId")
				expect(persisted).not.toHaveProperty("rootTaskId")
				expect(persisted.task).toBe("Updated")
				expect(store.get("child")).not.toHaveProperty("parentTaskId")
			} finally {
				store.dispose()
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		})

		it("recreates a deleted record without lineage when a stale save writes it", async () => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "preserve-lineage-deleted-"))
			const store = new TaskHistoryStore(storagePath)
			const filePath = path.join(storagePath, "tasks", "child", "history_item.json")

			try {
				await store.initialize()
				await store.upsert({
					...item("child"),
					status: "interrupted",
					parentTaskId: "parent",
					rootTaskId: "root",
				})

				// Another host removed the whole task record; the local
				// cache still holds the linked item.
				await fs.rm(path.dirname(filePath), { recursive: true, force: true })

				const staleSave: HistoryItem = {
					...item("child"),
					status: "interrupted",
					task: "Updated",
					parentTaskId: "parent",
					rootTaskId: "root",
				}
				await store.upsertPreservingLineage(staleSave)

				const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
				expect(persisted).not.toHaveProperty("parentTaskId")
				expect(persisted).not.toHaveProperty("rootTaskId")
				expect(persisted.status).toBe("interrupted")
				expect(store.get("child")).not.toHaveProperty("parentTaskId")
			} finally {
				store.dispose()
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		})
	})
})
