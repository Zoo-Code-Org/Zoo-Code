import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"
import { ABSENT_TASK_FILE_PREIMAGE, INVALID_TASK_FILE_PREIMAGE, type TaskFilePreImage } from "@roo-code/core"

import { lockJsonFile, safeWriteJson, type JsonFileLock } from "../../../utils/safeWriteJson"
import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

const safeWriteJsonActuals = vi.hoisted(() => ({
	lockJsonFile: undefined as typeof import("../../../utils/safeWriteJson").lockJsonFile | undefined,
	safeWriteJson: undefined as typeof import("../../../utils/safeWriteJson").safeWriteJson | undefined,
}))

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async (defaultPath: string) => defaultPath),
}))

vi.mock("../../../utils/safeWriteJson", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/safeWriteJson")>()
	safeWriteJsonActuals.lockJsonFile = actual.lockJsonFile
	safeWriteJsonActuals.safeWriteJson = actual.safeWriteJson
	return { ...actual, lockJsonFile: vi.fn(actual.lockJsonFile), safeWriteJson: vi.fn(actual.safeWriteJson) }
})

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
	options?: { heldLock?: JsonFileLock; capturePreImage?: (preImage: TaskFilePreImage) => void },
) => Promise<HistoryItem>

const getWriteTaskFile = (store: TaskHistoryStore): WriteTaskFile => {
	const writeTaskFile: unknown = Reflect.get(store, "writeTaskFile")
	if (typeof writeTaskFile !== "function") throw new TypeError("TaskHistoryStore.writeTaskFile is not callable")
	return (item, delta, diskGuard, options) => Reflect.apply(writeTaskFile, store, [item, delta, diskGuard, options])
}

type RestoreTaskFilePreImage = (
	taskId: string,
	preImage: TaskFilePreImage,
	expectedWritten: readonly HistoryItem[],
	heldLock?: JsonFileLock,
) => Promise<void>

const getRestoreTaskFilePreImage = (store: TaskHistoryStore): RestoreTaskFilePreImage => {
	const restoreTaskFilePreImage: unknown = Reflect.get(store, "restoreTaskFilePreImage")
	if (typeof restoreTaskFilePreImage !== "function") {
		throw new TypeError("TaskHistoryStore.restoreTaskFilePreImage is not callable")
	}
	return (taskId, preImage, expectedWritten, heldLock) =>
		Reflect.apply(restoreTaskFilePreImage, store, [taskId, preImage, expectedWritten, heldLock])
}

const completePairWithFailingCallback = (store: TaskHistoryStore, callbackError: Error) =>
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
			rollbackBothOnCallbackFailure: true,
			whileFirstFileLocked: async () => {
				throw callbackError
			},
		},
	)

describe("TaskHistoryStore cross-instance delegation", () => {
	beforeEach(() => {
		vi.mocked(lockJsonFile).mockReset().mockImplementation(safeWriteJsonActuals.lockJsonFile!)
		vi.mocked(safeWriteJson).mockReset().mockImplementation(safeWriteJsonActuals.safeWriteJson!)
	})

	it("restores explicit absence under an owned record lock", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-restore-absence-"))
		const store = new TaskHistoryStore(storage)
		const release = Object.assign(
			vi.fn(async () => {}),
			{ getCompromiseError: () => undefined },
		)

		try {
			await store.initialize()
			const item = makeHistoryItem("task", { status: "active" })
			await store.upsert(item)
			const taskFile = path.join(storage, "tasks", "task", "history_item.json")
			const written = JSON.parse(await fs.readFile(taskFile, "utf8"))
			vi.mocked(lockJsonFile).mockResolvedValueOnce(release)

			await getRestoreTaskFilePreImage(store)("task", ABSENT_TASK_FILE_PREIMAGE, [written])

			await expect(fs.readFile(taskFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
			expect(store.get("task")).toBeUndefined()
			expect(release).toHaveBeenCalledOnce()

			const secondRelease = Object.assign(
				vi.fn(async () => {}),
				{ getCompromiseError: () => undefined },
			)
			vi.mocked(lockJsonFile).mockResolvedValueOnce(secondRelease)
			await getRestoreTaskFilePreImage(store)("task", ABSENT_TASK_FILE_PREIMAGE, [written])
			expect(secondRelease).toHaveBeenCalledOnce()

			const heldLock = Object.assign(
				vi.fn(async () => {}),
				{ getCompromiseError: () => undefined },
			)
			await getRestoreTaskFilePreImage(store)("task", ABSENT_TASK_FILE_PREIMAGE, [written], heldLock)
			expect(heldLock).not.toHaveBeenCalled()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("keeps an invalid current file while restoring explicit absence", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-invalid-absence-"))
		const store = new TaskHistoryStore(storage)
		const release = Object.assign(
			vi.fn(async () => {}),
			{ getCompromiseError: () => undefined },
		)

		try {
			await store.initialize()
			const item = makeHistoryItem("task", { status: "active" })
			await store.upsert(item)
			const taskFile = path.join(storage, "tasks", "task", "history_item.json")
			await fs.writeFile(taskFile, "{invalid")
			vi.mocked(lockJsonFile).mockResolvedValueOnce(release)

			await expect(getRestoreTaskFilePreImage(store)("task", ABSENT_TASK_FILE_PREIMAGE, [item])).rejects.toThrow(
				"cannot restore absent task task from invalid state",
			)

			expect(await fs.readFile(taskFile, "utf8")).toBe("{invalid")
			expect(store.get("task")).toBeUndefined()
			expect(release).toHaveBeenCalledOnce()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("reports an invalid pre-image without replacing the current record", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-invalid-preimage-direct-"))
		const store = new TaskHistoryStore(storage)

		try {
			await store.initialize()
			const item = makeHistoryItem("task", { status: "active" })
			await store.upsert(item)

			await expect(getRestoreTaskFilePreImage(store)("task", INVALID_TASK_FILE_PREIMAGE, [item])).rejects.toThrow(
				"cannot compensate task: pre-image was invalid",
			)
			expect(store.get("task")).toEqual(item)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("unions changed child IDs and preserves them for unrelated updates", async () => {
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

			await fs.writeFile(taskFile, JSON.stringify({ ...task, childIds: ["preserved-child"] }))
			const unrelatedUpdate = await writeTaskFile({ ...task, tokensIn: 2 }, { id: task.id, tokensIn: 2 })
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
						rollbackBothOnCallbackFailure: true,
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

	it("accepts the valid second pre-image when its write fails before commit", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-precommit-second-failure-"))
		const store = new TaskHistoryStore(storage)
		const writeError = new Error("child write failed before commit")

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
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			const childBefore = JSON.parse(await fs.readFile(childFile, "utf8"))
			vi.mocked(safeWriteJson).mockImplementation(async (filePath, data, options) => {
				if (filePath === childFile && (data as HistoryItem).status === "completed") {
					options?.merge?.(childBefore, data)
					throw writeError
				}
				return safeWriteJsonActuals.safeWriteJson!(filePath, data, options)
			})

			await expect(
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
					{ rollbackBothOnCallbackFailure: true },
				),
			).rejects.toBe(writeError)

			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(JSON.parse(await fs.readFile(childFile, "utf8"))).toEqual(childBefore)
			expect(store.get("parent")).toEqual(parentBefore)
			expect(store.get("child")).toEqual(childBefore)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("restores both records when the second commit succeeds but reports an unlock failure", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-ambiguous-second-commit-"))
		const store = new TaskHistoryStore(storage)
		const unlockError = new Error("second record unlock failed")

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
			vi.mocked(safeWriteJson).mockImplementation(async (filePath, data, options) => {
				await safeWriteJsonActuals.safeWriteJson!(filePath, data, options)
				if (filePath === childFile && (data as HistoryItem).status === "completed") throw unlockError
			})

			await expect(
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
					{ rollbackBothOnCallbackFailure: true },
				),
			).rejects.toBe(unlockError)

			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(JSON.parse(await fs.readFile(childFile, "utf8"))).toEqual(childBefore)
			expect(store.get("parent")).toEqual(parentBefore)
			expect(store.get("child")).toEqual(childBefore)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("restores an absent second record without serializing null after callback failure", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-absent-preimage-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion callback failed")

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
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			await fs.unlink(childFile)

			await expect(completePairWithFailingCallback(store, callbackError)).rejects.toBe(callbackError)

			await expect(fs.readFile(childFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(store.get("parent")).toEqual(parentBefore)
			expect(store.get("child")).toBeUndefined()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it.each([
		["malformed JSON", (child: HistoryItem) => `{${child.id}`],
		["a mismatched task ID", (child: HistoryItem) => JSON.stringify({ ...child, id: "other-child" })],
	])("leaves the new second record intact when its pre-image contains %s", async (_name, invalidContents) => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-invalid-preimage-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion callback failed")

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
				}),
			)
			const child = makeHistoryItem("child", { status: "active", parentTaskId: "parent" })
			await store.upsert(child)
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			await fs.writeFile(childFile, invalidContents(child))

			let caught: unknown
			try {
				await completePairWithFailingCallback(store, callbackError)
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(AggregateError)
			expect((caught as AggregateError).errors[0]).toBe(callbackError)
			const persistedChild = JSON.parse(await fs.readFile(childFile, "utf8"))
			expect(persistedChild).toMatchObject({ id: "child", status: "completed" })
			expect(store.get("child")).toEqual(persistedChild)
			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(store.get("parent")).toEqual(parentBefore)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("does not delete a concurrent replacement while restoring an absent second record", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-absent-replaced-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion callback failed")

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
				}),
			)
			const child = makeHistoryItem("child", { status: "active", parentTaskId: "parent" })
			await store.upsert(child)
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			const replacement = { ...child, tokensIn: 777 }
			await fs.unlink(childFile)
			vi.mocked(lockJsonFile).mockImplementation(async (filePath) => {
				if (path.resolve(filePath) === path.resolve(childFile)) {
					await fs.writeFile(childFile, JSON.stringify(replacement))
				}
				return safeWriteJsonActuals.lockJsonFile!(filePath)
			})

			const caught = await completePairWithFailingCallback(store, callbackError).catch((error: unknown) => error)
			expect(caught).toBeInstanceOf(AggregateError)
			expect((caught as AggregateError).errors[1]).toMatchObject({
				message: "cannot restore absent task child after concurrent update",
			})

			expect(JSON.parse(await fs.readFile(childFile, "utf8"))).toEqual(replacement)
			expect(store.get("child")).toEqual(replacement)
			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(store.get("parent")).toEqual(parentBefore)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("does not delete the new second record after compensation lock ownership is compromised", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-absent-compromised-"))
		const store = new TaskHistoryStore(storage)
		const callbackError = new Error("completion callback failed")
		const compromiseError = new Error("compensation lock compromised")

		try {
			await store.initialize()
			await store.upsert(
				makeHistoryItem("parent", {
					status: "delegated",
					awaitingChildId: "child",
					delegatedToId: "child",
				}),
			)
			const child = makeHistoryItem("child", { status: "active", parentTaskId: "parent" })
			await store.upsert(child)
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const childFile = path.join(storage, "tasks", "child", "history_item.json")
			const parentBefore = JSON.parse(await fs.readFile(parentFile, "utf8"))
			await fs.unlink(childFile)
			vi.mocked(lockJsonFile).mockImplementation(async (filePath) => {
				const release = await safeWriteJsonActuals.lockJsonFile!(filePath)
				if (path.resolve(filePath) !== path.resolve(childFile)) return release
				return Object.assign(async () => release(), { getCompromiseError: () => compromiseError })
			})

			let caught: unknown
			try {
				await completePairWithFailingCallback(store, callbackError)
			} catch (error) {
				caught = error
			}

			expect(caught).toBeInstanceOf(AggregateError)
			expect((caught as AggregateError).errors).toEqual([callbackError, compromiseError])
			const persistedChild = JSON.parse(await fs.readFile(childFile, "utf8"))
			expect(persistedChild).toMatchObject({ id: "child", status: "completed" })
			expect(store.get("child")).toEqual(persistedChild)
			expect(JSON.parse(await fs.readFile(parentFile, "utf8"))).toEqual(parentBefore)
			expect(store.get("parent")).toEqual(parentBefore)
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
		let hostBParentLockAttempted!: () => void
		const hostBReachedParentLock = new Promise<void>((resolve) => {
			hostBParentLockAttempted = resolve
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
			const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
			const lockJsonFileMock = vi.mocked(lockJsonFile)
			const realLockJsonFile = lockJsonFileMock.getMockImplementation()
			if (!realLockJsonFile) throw new TypeError("lockJsonFile mock has no real implementation")
			lockJsonFileMock.mockClear()
			lockJsonFileMock.mockImplementationOnce((filePath) => {
				const acquisition = realLockJsonFile(filePath)
				if (filePath === parentFile) hostBParentLockAttempted()
				return acquisition
			})
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

			await hostBReachedParentLock
			expect(lockJsonFileMock).toHaveBeenCalledTimes(1)
			expect(lockJsonFileMock).toHaveBeenCalledWith(parentFile)
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
				compensationLockStates.push([args[0], Boolean(args[3])])
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
				message: "Pair compensation failed",
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
			expect((aggregate as AggregateError).message).toBe("Pair compensation failed")
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
			await hostA.withTaskFileLock("parent", async (fileLock) => {
				expect(hostA.get("parent")?.tokensIn).toBe(2)
				await hostA.atomicReadAndUpdate(
					"parent",
					(parent) => ({ ...parent, status: "delegated", awaitingChildId: "child" }),
					{ fileLock, storeLockAcquired: true },
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
				{ rollbackBothOnCallbackFailure: true },
			)
			await expect(result).rejects.toMatchObject({
				name: "AggregateError",
				message: "Task pair rollback failed",
				errors: [
					expect.objectContaining({ message: "child write failed" }),
					expect.objectContaining({
						message: "cannot compensate parent after concurrent update",
					}),
				],
			})

			const persistedParent = JSON.parse(
				await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8"),
			)
			expect(persistedParent.completedByChildId).toBe("peer-child")
			expect(store.get("parent")).toMatchObject({ status: "active", completedByChildId: "peer-child" })
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

			await store.withTaskFileLock("parent", (firstFileLock) =>
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
						firstFileLock,
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

	it("surfaces caller-held lock compromise without changing disk or cache", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-held-lock-compromise-"))
		const store = new TaskHistoryStore(storage)
		const compromised = new Error("caller-held lock compromised")
		let compromiseError: Error | undefined
		const release = Object.assign(
			vi.fn(async () => {
				if (compromiseError) throw compromiseError
			}),
			{ getCompromiseError: () => compromiseError },
		)

		try {
			await store.initialize()
			const original = makeHistoryItem("parent", { status: "active", tokensIn: 1 })
			await store.upsert(original)
			const taskFile = path.join(storage, "tasks", "parent", "history_item.json")
			vi.mocked(lockJsonFile).mockResolvedValueOnce(release)

			await expect(
				store.withTaskFileLock("parent", (fileLock) =>
					store.atomicReadAndUpdate(
						"parent",
						(current) => {
							compromiseError = compromised
							return { ...current, tokensIn: 99 }
						},
						{ fileLock, storeLockAcquired: true },
					),
				),
			).rejects.toBe(compromised)

			expect(JSON.parse(await fs.readFile(taskFile, "utf8"))).toMatchObject({ tokensIn: 1 })
			expect(store.get("parent")).toMatchObject({ tokensIn: 1 })
			expect(release).toHaveBeenCalledOnce()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("reconciles cache when compromise is reported while releasing a caller-held lock", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-release-compromise-"))
		const store = new TaskHistoryStore(storage)
		const compromised = new Error("release reported compromise")
		let compromiseError: Error | undefined

		try {
			await store.initialize()
			const original = makeHistoryItem("parent", { status: "active", tokensIn: 1 })
			await store.upsert(original)
			const taskFile = path.join(storage, "tasks", "parent", "history_item.json")
			const peer = { ...original, tokensIn: 7 }
			const taskFileMtimes = Reflect.get(store, "taskFileMtimes") as Map<string, number>
			taskFileMtimes.set("parent", 123)
			const release = Object.assign(
				vi.fn(async () => {
					await fs.writeFile(taskFile, JSON.stringify(peer))
					compromiseError = compromised
					throw compromised
				}),
				{ getCompromiseError: () => compromiseError },
			)
			vi.mocked(lockJsonFile).mockResolvedValueOnce(release)

			await expect(
				store.withTaskFileLock("parent", (fileLock) =>
					store.atomicReadAndUpdate("parent", (current) => ({ ...current, tokensIn: 3 }), {
						fileLock,
						storeLockAcquired: true,
					}),
				),
			).rejects.toBe(compromised)

			expect(JSON.parse(await fs.readFile(taskFile, "utf8"))).toMatchObject({ tokensIn: 7 })
			expect(store.get("parent")).toMatchObject({ tokensIn: 7 })
			expect(taskFileMtimes.has("parent")).toBe(false)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("clears cache when a compromised release leaves no authoritative task file", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-release-missing-"))
		const store = new TaskHistoryStore(storage)
		const compromised = new Error("release removed task file")
		let compromiseError: Error | undefined

		try {
			await store.initialize()
			const original = makeHistoryItem("parent", { status: "active", tokensIn: 1 })
			await store.upsert(original)
			const taskFile = path.join(storage, "tasks", "parent", "history_item.json")
			const release = Object.assign(
				vi.fn(async () => {
					await fs.unlink(taskFile)
					compromiseError = compromised
					throw compromised
				}),
				{ getCompromiseError: () => compromiseError },
			)
			vi.mocked(lockJsonFile).mockResolvedValueOnce(release)

			await expect(store.withTaskFileLock("parent", async () => undefined)).rejects.toBe(compromised)
			expect(store.get("parent")).toBeUndefined()
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
					{ rollbackBothOnCallbackFailure: true },
				)
				await expect(result).rejects.toMatchObject({
					name: "AggregateError",
					message: "Task pair rollback failed",
					errors: [
						expect.objectContaining({ message: "child write failed" }),
						expect.objectContaining({
							message: "[TaskHistoryStore] atomicUpdatePair: parent missing during compensation",
						}),
					],
				})
				expect(store.get("parent")).toBeUndefined()
			} finally {
				store.dispose()
				await fs.rm(storage, { recursive: true, force: true })
			}
		},
	)
})
