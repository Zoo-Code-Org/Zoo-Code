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

describe("TaskHistoryStore cross-instance delegation", () => {
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

			await store.invalidate("parent")
			expect(store.get("parent")).toMatchObject({
				status: "delegated",
				awaitingChildId: "child",
				delegatedToId: "child",
			})
			expect(store.get("parent")?.completedByChildId).toBeUndefined()
			expect(store.get("parent")?.childIds).toEqual([])
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

			const storeAccess = store as unknown as {
				writeTaskFile: (...args: unknown[]) => Promise<HistoryItem>
			}
			const writeTaskFile = storeAccess.writeTaskFile.bind(store)
			let pairWrite = 0
			vi.spyOn(storeAccess, "writeTaskFile").mockImplementation(async (...args) => {
				pairWrite++
				if (pairWrite === 1) {
					const written = await writeTaskFile(...args)
					const parentFile = path.join(storage, "tasks", "parent", "history_item.json")
					await fs.writeFile(parentFile, JSON.stringify({ ...written, completedByChildId: "peer-child" }))
					return written
				}
				throw new Error("child write failed")
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
						completedByChildId: "child",
					}),
					(child) => ({ ...child, status: "completed" }),
					{ rollbackFirstOnSecondFailure: true },
				),
			).rejects.toBeInstanceOf(AggregateError)

			const persistedParent = JSON.parse(
				await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8"),
			)
			expect(persistedParent.completedByChildId).toBe("peer-child")
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

	it("surfaces rollback failure when the first record disappears after its write", async () => {
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

			const storeAccess = store as unknown as {
				writeTaskFile: (...args: unknown[]) => Promise<HistoryItem>
			}
			const writeTaskFile = storeAccess.writeTaskFile.bind(store)
			let pairWrite = 0
			vi.spyOn(storeAccess, "writeTaskFile").mockImplementation(async (...args) => {
				pairWrite++
				if (pairWrite === 1) {
					const written = await writeTaskFile(...args)
					await fs.unlink(path.join(storage, "tasks", "parent", "history_item.json"))
					return written
				}
				throw new Error("child write failed")
			})

			await expect(
				store.atomicUpdatePair(
					"parent",
					"child",
					(parent) => ({ ...parent, status: "active", awaitingChildId: undefined }),
					(child) => ({ ...child, status: "completed" }),
					{ rollbackFirstOnSecondFailure: true },
				),
			).rejects.toMatchObject({
				name: "AggregateError",
				message: expect.stringContaining("second write and first-record rollback failed"),
			})
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
})
