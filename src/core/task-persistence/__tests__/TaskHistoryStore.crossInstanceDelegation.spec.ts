import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async (defaultPath: string) => defaultPath),
}))

const makeHistoryItem = (id: string, overrides: Partial<HistoryItem>): HistoryItem => ({
	id,
	number: 1,
	ts: Date.now(),
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: "/test/workspace",
	...overrides,
})

type WriteTaskFile = (
	item: HistoryItem,
	delta?: Partial<HistoryItem>,
	diskGuard?: (current: HistoryItem) => void,
	options?: { mergeChildIds?: boolean; lockAcquired?: boolean },
) => Promise<HistoryItem>

const getWriteTaskFile = (store: TaskHistoryStore): WriteTaskFile => {
	const writeTaskFile: unknown = Reflect.get(store, "writeTaskFile")
	if (typeof writeTaskFile !== "function") throw new TypeError("TaskHistoryStore.writeTaskFile is not callable")
	return (item, delta, diskGuard, options) => Reflect.apply(writeTaskFile, store, [item, delta, diskGuard, options])
}

type RestoreTaskFilePreImage = (
	taskId: string,
	preImage: HistoryItem,
	expectedWritten: HistoryItem,
	lockAcquired: boolean,
) => Promise<void>

const getRestoreTaskFilePreImage = (store: TaskHistoryStore): RestoreTaskFilePreImage => {
	const restoreTaskFilePreImage: unknown = Reflect.get(store, "restoreTaskFilePreImage")
	if (typeof restoreTaskFilePreImage !== "function") {
		throw new TypeError("TaskHistoryStore.restoreTaskFilePreImage is not callable")
	}
	return (taskId, preImage, expectedWritten, lockAcquired) =>
		Reflect.apply(restoreTaskFilePreImage, store, [taskId, preImage, expectedWritten, lockAcquired])
}

describe("TaskHistoryStore cross-instance delegation", () => {
	it("unions child IDs by default and replaces them only when explicitly requested", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-child-id-merge-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			const task = makeHistoryItem("parent", { childIds: ["cached-child"], tokensIn: 1 })
			await store.upsert(task)
			const taskFile = path.join(storage, "tasks", "parent", "history_item.json")
			const writeTaskFile = getWriteTaskFile(store)

			await fs.writeFile(taskFile, JSON.stringify({ ...task, childIds: ["peer-child"] }))
			const unioned = await writeTaskFile(
				{ ...task, childIds: ["local-child"] },
				{ id: task.id, childIds: ["local-child"] },
			)
			expect(unioned.childIds).toEqual(["peer-child", "local-child"])
			expect(JSON.parse(await fs.readFile(taskFile, "utf8")).childIds).toEqual(["peer-child", "local-child"])

			await fs.writeFile(taskFile, JSON.stringify({ ...task, childIds: ["new-peer-child"] }))
			const replaced = await writeTaskFile(
				{ ...task, childIds: ["replacement-child"] },
				{ id: task.id, childIds: ["replacement-child"] },
				undefined,
				{ mergeChildIds: false },
			)
			expect(replaced.childIds).toEqual(["replacement-child"])

			await fs.writeFile(taskFile, JSON.stringify({ ...task, childIds: ["preserved-child"] }))
			const unrelatedUpdate = await writeTaskFile(
				{ ...task, tokensIn: 2 },
				{ id: task.id, tokensIn: 2 },
				undefined,
				{ mergeChildIds: false },
			)
			expect(unrelatedUpdate).toMatchObject({ tokensIn: 2, childIds: ["preserved-child"] })
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("rejects a stale child completion before either delegation record is written", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-delegation-"))
		const hostA = new TaskHistoryStore(storage)
		const hostB = new TaskHistoryStore(storage)
		const staleDelegationError = new Error("stale delegation")

		try {
			await hostA.initialize()
			await hostB.initialize()
			await hostA.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child-old",
					delegatedToId: "child-old",
					childIds: ["child-old"],
				}),
			)
			await hostA.upsert(makeHistoryItem("child-old", { status: "active", parentTaskId: "parent" }))
			await hostB.reconcile({ forceRefresh: true })

			await hostB.atomicReadAndUpdate("child-old", (child) => ({ ...child, status: "interrupted" }))
			await hostB.atomicReadAndUpdate("parent", (parent) => ({
				...parent,
				status: "active",
				awaitingChildId: undefined,
				delegatedToId: undefined,
			}))
			await hostB.upsert(makeHistoryItem("child-new", { status: "active", parentTaskId: "parent" }))
			await hostB.atomicReadAndUpdate("parent", (parent) => ({
				...parent,
				status: "delegated",
				awaitingChildId: "child-new",
				delegatedToId: "child-new",
				childIds: [...(parent.childIds ?? []), "child-new"],
			}))

			const assertStillAwaitingOldChild = (parent: HistoryItem) => {
				if (parent.awaitingChildId !== "child-old") throw staleDelegationError
			}

			await expect(
				hostA.atomicUpdatePair(
					"parent",
					"child-old",
					(parent) => {
						assertStillAwaitingOldChild(parent)
						assertValidTransition(parent.status, "active")
						return {
							...parent,
							status: "active",
							awaitingChildId: undefined,
							delegatedToId: undefined,
							completedByChildId: "child-old",
						}
					},
					(child) => ({ ...child, status: "completed" }),
					{ firstDiskGuard: assertStillAwaitingOldChild },
				),
			).rejects.toBe(staleDelegationError)

			await hostB.invalidate("parent")
			await hostB.invalidate("child-old")
			await hostB.invalidate("child-new")

			expect(hostB.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child-new",
				delegatedToId: "child-new",
			})
			expect(hostB.get("child-old")?.status).toBe("interrupted")
			expect(hostB.get("child-new")).toMatchObject({ status: "active", parentTaskId: "parent" })
		} finally {
			hostA.dispose()
			hostB.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("restores the parent delegation when completing the child cannot be persisted", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-rollback-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
					childIds: [],
				}),
			)
			await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const persistedParentBeforeFailure = JSON.parse(await fs.readFile(parentFile, "utf8"))
			await fs.writeFile(parentFile, JSON.stringify({ ...persistedParentBeforeFailure, tokensIn: 99 }))

			const childDirectory = path.join(storage, "tasks", "child")
			await fs.rm(childDirectory, { recursive: true })
			await fs.writeFile(childDirectory, "blocks child history writes", "utf8")

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({
						...parent,
						status: "active",
						awaitingChildId: undefined,
						delegatedToId: undefined,
						completedByChildId: "child",
						childIds: [...(parent.childIds ?? []), "child"],
					}),
					(child) => ({ ...child, status: "completed" }),
					{
						firstDiskGuard: (parent) => {
							if (parent.awaitingChildId !== "child") throw new Error("stale delegation")
						},
						rollbackFirstOnSecondFailure: true,
					},
				),
			).rejects.toThrow()

			expect(store.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			})
			expect(store.get("parent")?.completedByChildId).toBeUndefined()
			expect(store.get("parent")?.childIds).toEqual([])
			expect(store.get("parent")?.tokensIn).toBe(99)
			const persistedParent = JSON.parse(await fs.readFile(parentFile, "utf8"))
			expect(persistedParent).toEqual(store.get("parent"))
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("holds the parent lock through both writes and finite handoff work", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-lock-scope-"))
		const hostA = new TaskHistoryStore(storage)
		const hostB = new TaskHistoryStore(storage)
		let releaseHandoff!: () => void
		const handoffCanFinish = new Promise<void>((resolve) => {
			releaseHandoff = resolve
		})
		let handoffStarted!: () => void
		const handoffDidStart = new Promise<void>((resolve) => {
			handoffStarted = resolve
		})
		const order: string[] = []

		try {
			await hostA.initialize()
			await hostB.initialize()
			await hostA.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child-old",
					delegatedToId: "child-old",
					childIds: ["child-old"],
				}),
			)
			await hostA.upsert(makeHistoryItem("child-old", { status: "active", parentTaskId: "parent" }))
			await hostB.reconcile({ forceRefresh: true })
			await hostB.upsert(makeHistoryItem("child-new", { status: "active", parentTaskId: "parent" }))

			const completion = hostA.atomicUpdatePair(
				"parent",
				"child-old",
				(parent) => ({
					...parent,
					status: "active",
					awaitingChildId: undefined,
					delegatedToId: undefined,
					completedByChildId: "child-old",
				}),
				(child) => ({ ...child, status: "completed" }),
				{
					firstDiskGuard: (parent) => {
						if (parent.awaitingChildId !== "child-old") throw new Error("stale delegation")
					},
					whileFirstFileLocked: async () => {
						order.push("handoff-start")
						handoffStarted()
						await handoffCanFinish
						order.push("handoff-end")
					},
				},
			)

			await handoffDidStart
			let redelegationSettled = false
			const redelegation = hostB
				.atomicReadAndUpdate("parent", (parent) => ({
					...parent,
					status: "delegated",
					awaitingChildId: "child-new",
					delegatedToId: "child-new",
					childIds: [...(parent.childIds ?? []), "child-new"],
				}))
				.then(() => {
					redelegationSettled = true
					order.push("redelegation-end")
				})

			await Promise.resolve()
			expect(redelegationSettled).toBe(false)

			releaseHandoff()
			await Promise.all([completion, redelegation])

			expect(order).toEqual(["handoff-start", "handoff-end", "redelegation-end"])
			await hostA.invalidate("parent")
			await hostA.invalidate("child-old")
			expect(hostA.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child-new",
				delegatedToId: "child-new",
			})
			expect(hostA.get("child-old")?.status).toBe("completed")
		} finally {
			hostA.dispose()
			hostB.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("restores both authoritative records and write-through state when the lock-scoped callback fails", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-callback-compensation-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite })
		const callbackError = new Error("completion handoff failed")

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
					childIds: ["child"],
				}),
			)
			await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			const childBefore = JSON.parse(await fs.readFile(childFile, "utf8"))
			const restoreTaskFilePreImage = getRestoreTaskFilePreImage(store)
			const compensationLockStates: Array<[string, boolean]> = []
			Reflect.set(store, "restoreTaskFilePreImage", async (...args: Parameters<RestoreTaskFilePreImage>) => {
				compensationLockStates.push([args[0], args[3]])
				await restoreTaskFilePreImage(...args)
			})
			onWrite.mockClear()

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({
						...parent,
						status: "active",
						awaitingChildId: undefined,
						delegatedToId: undefined,
						completedByChildId: "child",
					}),
					(child) => ({ ...child, status: "completed" }),
					{
						rollbackBothOnCallbackFailure: true,
						whileFirstFileLocked: async () => {
							throw callbackError
						},
					},
				),
			).rejects.toBe(callbackError)

			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(JSON.parse(await fs.readFile(childFile, "utf8"))).toEqual(childBefore)
			expect(store.get("parent")).toEqual(parentBefore)
			expect(store.get("child")).toEqual(childBefore)
			expect(compensationLockStates).toEqual([
				["child", false],
				["parent", true],
			])
			expect(onWrite).toHaveBeenCalledTimes(2)
			expect(onWrite.mock.calls[0][0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "parent", status: "active" }),
					expect.objectContaining({ id: "child", status: "completed" }),
				]),
			)
			expect(onWrite.mock.calls[1][0]).toEqual(expect.arrayContaining([parentBefore, childBefore]))
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("compensates when write-through rejects and preserves the original error", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-onwrite-compensation-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite })
		const callbackError = new Error("write-through failed")

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated" }))
			await store.upsert(makeHistoryItem("child", { status: "active" }))
			onWrite.mockClear()
			onWrite.mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined)

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active" }),
					(child) => ({ ...child, status: "completed" }),
					{ rollbackBothOnCallbackFailure: true },
				),
			).rejects.toBe(callbackError)

			expect(store.get("parent")?.status).toBe("delegated")
			expect(store.get("child")?.status).toBe("active")
			expect(onWrite).toHaveBeenCalledTimes(2)
			expect(onWrite.mock.calls[1][0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "parent", status: "delegated" }),
					expect.objectContaining({ id: "child", status: "active" }),
				]),
			)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("aggregates callback and guarded compensation failures while reconciling partial cache state", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-compensation-guard-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const hostA = new TaskHistoryStore(storage, { onWrite })
		const hostB = new TaskHistoryStore(storage)
		const callbackError = new Error("completion handoff failed")
		const writeThroughError = new Error("compensated write-through failed")

		try {
			await hostA.initialize()
			await hostB.initialize()
			await hostA.upsert(makeHistoryItem("parent", { status: "delegated", awaitingChildId: "child" }))
			await hostA.upsert(makeHistoryItem("child", { status: "active", tokensIn: 1 }))
			await hostB.reconcile({ forceRefresh: true })
			onWrite.mockClear()
			onWrite.mockResolvedValueOnce(undefined).mockRejectedValueOnce(writeThroughError)

			const result = hostA.atomicUpdatePair(
				"parent",
				"child",
				(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
				(child) => ({ ...child, status: "completed" }),
				{
					rollbackBothOnCallbackFailure: true,
					whileFirstFileLocked: async () => {
						await hostB.atomicReadAndUpdate("child", (child) => ({ ...child, tokensIn: 9 }))
						throw callbackError
					},
				},
			)

			await expect(result).rejects.toMatchObject({
				name: "AggregateError",
				message: "[TaskHistoryStore] atomicUpdatePair: callback and compensation failed",
				errors: [
					callbackError,
					expect.objectContaining({ message: expect.stringContaining("concurrent update") }),
					writeThroughError,
				],
			})
			expect(hostA.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "child" })
			expect(hostA.get("child")).toMatchObject({ status: "completed", tokensIn: 9 })
			expect(onWrite.mock.calls.at(-1)?.[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "parent", status: "delegated" }),
					expect.objectContaining({ id: "child", status: "completed", tokensIn: 9 }),
				]),
			)
		} finally {
			hostA.dispose()
			hostB.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it.each([
		["missing", undefined],
		["primitive", 42],
		["object without an id", { status: "completed" }],
	] as const)("rejects compensation when the second record is %s", async (_description, invalidRecord) => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-invalid-compensation-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion handoff failed")

		try {
			await store.initialize()
			const parent = makeHistoryItem("parent", {
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			})
			const child = makeHistoryItem("child", { status: "active", parentTaskId: "parent" })
			await store.upsert(parent)
			await store.upsert(child)
			const childFile = path.join(storage, "tasks", "child", "history_item.json")

			const result = store.atomicUpdatePair(
				"parent",
				"child",
				(current) => ({ ...current, status: "active", awaitingChildId: undefined, delegatedToId: undefined }),
				(current) => ({ ...current, status: "completed" }),
				{
					rollbackBothOnCallbackFailure: true,
					whileFirstFileLocked: async () => {
						if (invalidRecord === undefined) {
							await fs.unlink(childFile)
						} else {
							await fs.writeFile(childFile, JSON.stringify(invalidRecord))
						}
						throw callbackError
					},
				},
			)

			const aggregate = await result.catch((error: unknown) => error)
			expect(aggregate).toBeInstanceOf(AggregateError)
			expect((aggregate as AggregateError).message).toBe(
				"[TaskHistoryStore] atomicUpdatePair: callback and compensation failed",
			)
			expect((aggregate as AggregateError).errors[0]).toBe(callbackError)
			expect((aggregate as AggregateError).errors[1]).toMatchObject({
				message: "[TaskHistoryStore] atomicUpdatePair: child missing during compensation",
			})
			expect(store.get("parent")).toEqual(parent)
			expect(store.get("child")).toBeUndefined()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("reports failures from compensating both records and refreshes both cache entries", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-double-compensation-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion handoff failed")

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated", awaitingChildId: "child" }))
			await store.upsert(makeHistoryItem("child", { status: "active", tokensIn: 1 }))
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")

			const result = store.atomicUpdatePair(
				"parent",
				"child",
				(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
				(child) => ({ ...child, status: "completed" }),
				{
					rollbackBothOnCallbackFailure: true,
					whileFirstFileLocked: async () => {
						const persistedParent = JSON.parse(await fs.readFile(parentFile, "utf8"))
						const persistedChild = JSON.parse(await fs.readFile(childFile, "utf8"))
						await fs.writeFile(parentFile, JSON.stringify({ ...persistedParent, tokensOut: 8 }))
						await fs.writeFile(childFile, JSON.stringify({ ...persistedChild, tokensIn: 9 }))
						throw callbackError
					},
				},
			)

			await expect(result).rejects.toMatchObject({
				name: "AggregateError",
				errors: [
					callbackError,
					expect.objectContaining({ message: expect.stringContaining("cannot compensate child") }),
					expect.objectContaining({ message: expect.stringContaining("cannot compensate parent") }),
				],
			})
			expect(store.get("parent")).toMatchObject({ status: "active", tokensOut: 8 })
			expect(store.get("child")).toMatchObject({ status: "completed", tokensIn: 9 })
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("keeps both writes committed when callback compensation was not requested", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-no-callback-compensation-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("handoff failed without compensation")

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated" }))
			await store.upsert(makeHistoryItem("child", { status: "active" }))

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active" }),
					(child) => ({ ...child, status: "completed" }),
					{
						whileFirstFileLocked: async () => {
							throw callbackError
						},
					},
				),
			).rejects.toBe(callbackError)
			expect(store.get("parent")?.status).toBe("active")
			expect(store.get("child")?.status).toBe("completed")
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("recreates a missing first record when no disk guard or rollback was requested", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-unguarded-create-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated" }))
			await store.upsert(makeHistoryItem("child", { status: "active" }))
			await fs.unlink(path.join(storage, "tasks", "parent", "history_item.json"))

			await store.atomicUpdatePair(
				"parent",
				"child",
				(parent) => ({ ...parent, status: "active" }),
				(child) => ({ ...child, status: "completed" }),
			)

			const persistedParent = JSON.parse(
				await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8"),
			)
			expect(persistedParent).toMatchObject({ id: "parent", status: "active" })
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("preserves a write-through error without options and leaves both writes committed", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-onwrite-no-options-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite })
		const writeThroughError = new Error("write-through failed without options")

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated" }))
			await store.upsert(makeHistoryItem("child", { status: "active" }))
			onWrite.mockRejectedValueOnce(writeThroughError)

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active" }),
					(child) => ({ ...child, status: "completed" }),
				),
			).rejects.toBe(writeThroughError)
			expect(store.get("parent")?.status).toBe("active")
			expect(store.get("child")?.status).toBe("completed")
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("keeps the first write committed when only a disk guard was requested", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-guard-without-rollback-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "delegated", awaitingChildId: "child" }))
			await store.upsert(makeHistoryItem("child", { status: "active" }))
			const writeTaskFile = getWriteTaskFile(store)
			let writeCount = 0
			Reflect.set(store, "writeTaskFile", async (...args: Parameters<WriteTaskFile>) => {
				writeCount++
				if (writeCount === 2) throw new Error("child write failed")
				return writeTaskFile(...args)
			})

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
					(child) => ({ ...child, status: "completed" }),
					{ firstDiskGuard: () => {} },
				),
			).rejects.toThrow("child write failed")
			expect(store.get("parent")?.status).toBe("active")
			expect(store.get("parent")?.awaitingChildId).toBeUndefined()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("refreshes stale parent state before a lock-scoped update without re-entering either lock", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-lock-refresh-"))
		const hostA = new TaskHistoryStore(storage)
		const hostB = new TaskHistoryStore(storage)

		try {
			await hostA.initialize()
			await hostB.initialize()
			await hostA.upsert(makeHistoryItem("parent", { status: "active", tokensIn: 1 }))
			await hostB.reconcile({ forceRefresh: true })
			await hostB.atomicReadAndUpdate("parent", (parent) => ({ ...parent, tokensIn: 2 }))

			expect(hostA.get("parent")?.tokensIn).toBe(1)
			await hostA.withTaskFileLock("parent", async () => {
				expect(hostA.get("parent")?.tokensIn).toBe(2)
				await hostA.atomicReadAndUpdate(
					"parent",
					(parent) => ({ ...parent, status: "delegated", awaitingChildId: "child" }),
					{ fileLockAcquired: true, storeLockAcquired: true },
				)
			})

			await hostB.invalidate("parent")
			expect(hostB.get("parent")).toMatchObject({
				tokensIn: 2,
				status: "delegated",
				awaitingChildId: "child",
			})
		} finally {
			hostA.dispose()
			hostB.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("refuses to roll back the parent over an intervening first-record change", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-rollback-guard-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
					childIds: ["child"],
				}),
			)
			await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))

			const writeTaskFile = getWriteTaskFile(store)
			let pairWrite = 0
			const replacement: WriteTaskFile = async (item, delta, diskGuard, options) => {
				pairWrite++
				if (pairWrite === 1) {
					const written = await writeTaskFile(item, delta, diskGuard, options)
					const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
					await fs.writeFile(parentFile, JSON.stringify({ ...written, completedByChildId: "peer-child" }))
					return written
				}
				throw new Error("child write failed")
			}
			Reflect.set(store, "writeTaskFile", replacement)

			const result = store.atomicUpdatePair(
				"parent",
				"child",
				(parent) => ({
					...parent,
					status: "active",
					awaitingChildId: undefined,
					delegatedToId: undefined,
					completedByChildId: "child",
				}),
				(child) => ({ ...child, status: "completed" }),
				{ rollbackFirstOnSecondFailure: true },
			)
			await expect(result).rejects.toMatchObject({
				name: "AggregateError",
				message: "[TaskHistoryStore] atomicUpdatePair: second write and first-record rollback failed",
				errors: [
					expect.objectContaining({ message: "child write failed" }),
					expect.objectContaining({
						message:
							"[TaskHistoryStore] atomicUpdatePair: cannot roll back parent after a concurrent update",
					}),
				],
			})

			const persistedParent = JSON.parse(
				await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8"),
			)
			expect(persistedParent.completedByChildId).toBe("peer-child")
			expect(store.get("parent")).toMatchObject({ status: "active", completedByChildId: "child" })
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("rejects a guarded pair update when the authoritative parent record disappeared", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missing-parent-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
				}),
			)
			await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))
			await fs.unlink(path.join(storage, "tasks", "parent", "history_item.json"))

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
					(child) => ({ ...child, status: "completed" }),
					{ firstDiskGuard: () => {} },
				),
			).rejects.toThrow("guarded write: task parent not found on disk")
			expect(store.get("parent")?.status).toBe("delegated")
			expect(store.get("child")?.status).toBe("active")
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("rejects an atomic updater that changes the task identity", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-id-guard-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "active" }))

			await expect(
				store.atomicReadAndUpdate("parent", (parent) => ({ ...parent, id: "replacement" })),
			).rejects.toThrow("changed id from parent to replacement")
			expect(store.get("parent")?.id).toBe("parent")
			expect(store.get("replacement")).toBeUndefined()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("rejects an atomic update for a task missing from the local cache", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missing-cache-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await expect(store.atomicReadAndUpdate("missing", (item) => item)).rejects.toThrow(
				"task missing not found in cache",
			)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("recreates a missing task file from cached state and publishes the update", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-cached-fallback-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite })

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "active", tokensIn: 1 }))
			await fs.unlink(path.join(storage, "tasks", "parent", "history_item.json"))
			onWrite.mockClear()

			await store.atomicReadAndUpdate("parent", (parent) => ({ ...parent, tokensIn: 2 }))

			expect(onWrite).toHaveBeenCalledTimes(1)
			expect(store.get("parent")?.tokensIn).toBe(2)
			const persisted = JSON.parse(
				await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8"),
			)
			expect(persisted).toMatchObject({ id: "parent", tokensIn: 2 })
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("keeps the cached snapshot available when a locked task file is missing", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missing-locked-file-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: "active", tokensIn: 3 }))
			await fs.unlink(path.join(storage, "tasks", "parent", "history_item.json"))

			const tokensIn = await store.withTaskFileLock("parent", async () => store.get("parent")?.tokensIn)

			expect(tokensIn).toBe(3)
			expect(store.get("parent")?.tokensIn).toBe(3)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("treats a legacy missing status as active during an atomic transition", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-legacy-status-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			await store.upsert(makeHistoryItem("parent", { status: undefined }))

			await store.atomicReadAndUpdate("parent", (parent) => ({
				...parent,
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			}))

			expect(store.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			})
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("runs pair write-through inside an already-held parent transition lock", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-held-pair-lock-"))
		const onWrite = vi.fn().mockResolvedValue(undefined)
		const store = new TaskHistoryStore(storage, { onWrite })

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
				}),
			)
			await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))
			onWrite.mockClear()

			await store.withTaskFileLock("parent", () =>
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({
						...parent,
						status: "active",
						awaitingChildId: undefined,
						delegatedToId: undefined,
					}),
					(child) => ({ ...child, status: "completed" }),
					{
						firstDiskGuard: (parent) => {
							expect(parent.awaitingChildId).toBe("child")
						},
						firstFileLockAcquired: true,
						storeLockAcquired: true,
					},
				),
			)

			expect(onWrite).toHaveBeenCalledTimes(1)
			expect(store.get("parent")?.status).toBe("active")
			expect(store.get("child")?.status).toBe("completed")
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it.each([
		["disappears", undefined],
		["becomes a primitive", 42],
		["loses its id", { status: "active" }],
	] as const)(
		"surfaces rollback failure when the first record %s after its write",
		async (_description, invalidRecord) => {
			const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-missing-rollback-"))
			const store = new TaskHistoryStore(storage)

			try {
				await store.initialize()
				await store.upsert(
					makeHistoryItem("parent", {
						status: "delegated",
						awaitingChildId: "child",
						delegatedToId: "child",
					}),
				)
				await store.upsert(makeHistoryItem("child", { status: "active", parentTaskId: "parent" }))

				const writeTaskFile = getWriteTaskFile(store)
				let pairWrite = 0
				const replacement: WriteTaskFile = async (item, delta, diskGuard, options) => {
					pairWrite++
					if (pairWrite === 1) {
						const written = await writeTaskFile(item, delta, diskGuard, options)
						const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
						if (invalidRecord === undefined) {
							await fs.unlink(parentFile)
						} else {
							await fs.writeFile(parentFile, JSON.stringify(invalidRecord))
						}
						return written
					}
					throw new Error("child write failed")
				}
				Reflect.set(store, "writeTaskFile", replacement)

				const result = store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
					(child) => ({ ...child, status: "completed" }),
					{ rollbackFirstOnSecondFailure: true },
				)
				await expect(result).rejects.toMatchObject({
					name: "AggregateError",
					message: "[TaskHistoryStore] atomicUpdatePair: second write and first-record rollback failed",
					errors: [
						expect.objectContaining({ message: "child write failed" }),
						expect.objectContaining({
							message: "[TaskHistoryStore] atomicUpdatePair: parent missing during rollback",
						}),
					],
				})
				expect(store.get("parent")?.status).toBe("active")
			} finally {
				store.dispose()
				await fs.rm(storage, { recursive: true, force: true })
			}
		},
	)
})
