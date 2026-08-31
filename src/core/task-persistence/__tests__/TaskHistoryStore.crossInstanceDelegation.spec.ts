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
})
