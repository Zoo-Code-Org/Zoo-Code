// pnpm --filter zoo-code test core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

const writeJson = async (filePath: string, data: unknown): Promise<void> => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
}

const safeWriteJsonMock = vi.hoisted(() => vi.fn())

vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: safeWriteJsonMock }))

safeWriteJsonMock.mockImplementation(writeJson)

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: `task-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

function makeRepairIntent(parent: HistoryItem, child: HistoryItem): object {
	return {
		version: 1,
		operationId: "delegation-repair-test",
		parentTaskId: parent.id,
		childTaskId: child.id,
		expected: {
			parent: {
				status: "delegated",
				awaitingChildId: child.id,
				delegatedToId: parent.delegatedToId,
			},
			child: {
				status: "active",
				parentTaskId: child.parentTaskId,
				rootTaskId: child.rootTaskId,
			},
		},
		target: { childStatus: "interrupted", parentStatus: "active" },
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// assertValidTransition — pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe("assertValidTransition", () => {
	describe("valid transitions", () => {
		it("active → delegated", () => {
			expect(() => assertValidTransition("active", "delegated")).not.toThrow()
		})

		it("active → completed", () => {
			expect(() => assertValidTransition("active", "completed")).not.toThrow()
		})

		it("active → interrupted", () => {
			expect(() => assertValidTransition("active", "interrupted")).not.toThrow()
		})

		it("delegated → active", () => {
			expect(() => assertValidTransition("delegated", "active")).not.toThrow()
		})

		it("interrupted → completed", () => {
			expect(() => assertValidTransition("interrupted", "completed")).not.toThrow()
		})

		it("undefined (implicit active) → delegated", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})

		it("undefined (implicit active) → completed", () => {
			expect(() => assertValidTransition(undefined, "completed")).not.toThrow()
		})
	})

	describe("invalid transitions — throw", () => {
		it("delegated → completed", () => {
			expect(() => assertValidTransition("delegated", "completed")).toThrow(
				"Invalid task status transition: delegated → completed",
			)
		})

		it("delegated → delegated (self-loop)", () => {
			expect(() => assertValidTransition("delegated", "delegated")).toThrow(
				"Invalid task status transition: delegated → delegated",
			)
		})

		it("completed → active", () => {
			expect(() => assertValidTransition("completed", "active")).toThrow(
				"Invalid task status transition: completed → active",
			)
		})

		it("completed → delegated", () => {
			expect(() => assertValidTransition("completed", "delegated")).toThrow(
				"Invalid task status transition: completed → delegated",
			)
		})

		it("interrupted → active", () => {
			expect(() => assertValidTransition("interrupted", "active")).toThrow(
				"Invalid task status transition: interrupted → active",
			)
		})

		it("active → active (self-loop)", () => {
			expect(() => assertValidTransition("active", "active")).toThrow(
				"Invalid task status transition: active → active",
			)
		})

		it("undefined (implicit active) → delegated is valid", () => {
			expect(() => assertValidTransition(undefined, "delegated")).not.toThrow()
		})
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// reconcileDelegationState — integration tests via initialize()
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore reconcileDelegationState", () => {
	let tmpDir: string
	let store: TaskHistoryStore
	const disposables = new Set<TaskHistoryStore>()

	function registerStore(nextStore: TaskHistoryStore): TaskHistoryStore {
		disposables.add(nextStore)
		return nextStore
	}

	async function seedItems(items: HistoryItem[]): Promise<void> {
		const tasksDir = path.join(tmpDir, "tasks")
		await fs.mkdir(tasksDir, { recursive: true })
		for (const item of items) {
			const taskDir = path.join(tasksDir, item.id)
			await fs.mkdir(taskDir, { recursive: true })
			await fs.writeFile(path.join(taskDir, "history_item.json"), JSON.stringify(item))
		}
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-test-"))
		store = registerStore(new TaskHistoryStore(tmpDir))
	})

	afterEach(async () => {
		safeWriteJsonMock.mockImplementation(writeJson)
		for (const disposable of disposables) disposable.dispose()
		disposables.clear()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("repairs orphaned delegation: delegated parent whose child does not exist → active", async () => {
		const parent = makeItem({ id: "parent-1", status: "delegated", awaitingChildId: "missing-child" })
		await seedItems([parent])

		await store.initialize()

		const repaired = store.get("parent-1")
		expect(repaired?.status).toBe("active")
		expect(repaired?.awaitingChildId).toBeUndefined()
		expect(repaired?.delegatedToId).toBeUndefined()
	})

	it("repairs interrupted handoff: delegated parent with completed child → active", async () => {
		const child = makeItem({
			id: "child-2",
			status: "completed",
			completionResultSummary: "Child result",
		})
		const parent = makeItem({
			id: "parent-2",
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
		})
		await seedItems([parent, child])

		await store.initialize()

		const repaired = store.get("parent-2")
		expect(repaired?.status).toBe("active")
		expect(repaired?.awaitingChildId).toBeUndefined()
		expect(repaired?.delegatedToId).toBeUndefined()
		expect(repaired?.completedByChildId).toBe("child-2")
		expect(repaired?.completionResultSummary).toBe("Child result")
	})

	it("uses fallback summary when child has no completionResultSummary", async () => {
		const child = makeItem({ id: "child-3", status: "completed" })
		const parent = makeItem({ id: "parent-3", status: "delegated", awaitingChildId: "child-3" })
		await seedItems([parent, child])

		await store.initialize()

		const repaired = store.get("parent-3")
		expect(repaired?.completionResultSummary).toBe("Task completed (recovered after interruption)")
	})

	it("repairs a delegated parent with an active orphaned child", async () => {
		const child = makeItem({
			id: "child-4",
			status: "active",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		const parent = makeItem({
			id: "parent-4",
			status: "delegated",
			awaitingChildId: "child-4",
			delegatedToId: "child-4",
			childIds: ["child-4"],
		})
		await seedItems([parent, child])

		await store.initialize()

		const repairedParent = store.get("parent-4")
		const repairedChild = store.get("child-4")
		expect(repairedChild).toMatchObject({
			id: "child-4",
			status: "interrupted",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		expect(repairedParent).toMatchObject({
			id: "parent-4",
			status: "active",
			childIds: ["child-4"],
		})
		expect(repairedParent?.awaitingChildId).toBeUndefined()
		expect(repairedParent?.delegatedToId).toBeUndefined()

		const tasksDir = path.join(tmpDir, "tasks")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tasksDir, "child-4", "history_item.json"), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tasksDir, "parent-4", "history_item.json"), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({
			id: "child-4",
			status: "interrupted",
			parentTaskId: "parent-4",
			rootTaskId: "parent-4",
			childIds: ["grandchild-4"],
		})
		expect(persistedParent).toMatchObject({ id: "parent-4", status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("repairs a delegated child with an omitted status as implicit active", async () => {
		const child = makeItem({
			id: "child-implicit-active",
			parentTaskId: "parent-implicit-active",
			rootTaskId: "parent-implicit-active",
		})
		const parent = makeItem({
			id: "parent-implicit-active",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])

		await store.initialize()

		expect(store.get(child.id)).toMatchObject({ id: child.id, status: "interrupted" })
		expect(store.get(parent.id)).toMatchObject({ id: parent.id, status: "active" })
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		expect(store.get(parent.id)?.delegatedToId).toBeUndefined()

		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild.status).toBe("interrupted")
	})

	it("replays an intent after a child-only write and removes it after completion", async () => {
		const child = makeItem({ id: "child-replay", status: "active", parentTaskId: "parent-replay" })
		const parent = makeItem({
			id: "parent-replay",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		await fs.writeFile(
			path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem),
			JSON.stringify({ ...child, status: "interrupted" }),
		)

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("replays an intent after a failure before the child write", async () => {
		const child = makeItem({
			id: "child-fault-before-child",
			status: "active",
			parentTaskId: "parent-fault-before-child",
		})
		const parent = makeItem({
			id: "parent-fault-before-child",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			if (filePath.includes(child.id) && filePath.endsWith(GlobalFileNames.historyItem))
				throw new Error("fault before child write")
			await writeJson(filePath, data)
		})
		await expect(store.initialize()).resolves.toBeUndefined()
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("replays an intent after a failure before the parent write", async () => {
		const child = makeItem({
			id: "child-fault-before-parent",
			status: "active",
			parentTaskId: "parent-fault-before-parent",
		})
		const parent = makeItem({
			id: "parent-fault-before-parent",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			if (filePath.includes(parent.id) && filePath.endsWith(GlobalFileNames.historyItem))
				throw new Error("fault before parent write")
			await writeJson(filePath, data)
		})
		await expect(store.initialize()).resolves.toBeUndefined()
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
	})

	it("retains an intent when the callback fails after both writes", async () => {
		const child = makeItem({ id: "child-fault-cleanup", status: "active", parentTaskId: "parent-fault-cleanup" })
		const parent = makeItem({
			id: "parent-fault-cleanup",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		store.dispose()
		store = registerStore(
			new TaskHistoryStore(tmpDir, { onWrite: vi.fn().mockRejectedValue(new Error("fault before cleanup")) }),
		)
		await expect(store.initialize()).resolves.toBeUndefined()
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		expect(await fs.readFile(intentPath, "utf8")).toContain(child.id)
		store.dispose()
		safeWriteJsonMock.mockImplementation(writeJson)
		const replayedStore = registerStore(new TaskHistoryStore(tmpDir))
		await replayedStore.initialize()
		expect(replayedStore.get(child.id)?.status).toBe("interrupted")
		expect(replayedStore.get(parent.id)?.status).toBe("active")
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("replays a both-at-target intent without writing task files", async () => {
		const child = makeItem({ id: "child-at-target", status: "interrupted", parentTaskId: "parent-at-target" })
		const parent = makeItem({ id: "parent-at-target", status: "active" })
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(
			intentPath,
			JSON.stringify(makeRepairIntent({ ...parent, status: "delegated", awaitingChildId: child.id }, child)),
		)

		const writeCalls: string[] = []
		safeWriteJsonMock.mockImplementation(async (filePath, data) => {
			writeCalls.push(filePath)
			await writeJson(filePath, data)
		})
		await store.initialize()

		expect(writeCalls.filter((filePath) => filePath.endsWith(GlobalFileNames.historyItem))).toEqual([])
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("removes the repair-intent file after successful replay", async () => {
		const child = makeItem({ id: "child-deferred-index", status: "active", parentTaskId: "parent-deferred-index" })
		const parent = makeItem({
			id: "parent-deferred-index",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))
		await store.reconcile({ forceRefresh: true })

		const storeInternals = store as unknown as {
			replayDelegationRepairIntent: () => Promise<void>
		}

		await storeInternals.replayDelegationRepairIntent()

		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines malformed and stale intents without blocking unrelated startup", async () => {
		const unrelated = makeItem({ id: "unrelated-startup", status: "active" })
		await seedItems([unrelated])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify({ malformed: true }))

		await store.initialize()

		expect(store.get(unrelated.id)?.status).toBe("active")
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent with a missing task record without changing unrelated startup", async () => {
		const unrelated = makeItem({ id: "unrelated-missing-intent", status: "active" })
		const missingChild = makeItem({ id: "missing-intent-child", status: "active" })
		const parent = makeItem({ id: "missing-intent-parent", status: "delegated", awaitingChildId: missingChild.id })
		await seedItems([unrelated])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, missingChild)))

		await store.initialize()

		expect(store.get(unrelated.id)?.status).toBe("active")
		expect(store.get(parent.id)).toBeUndefined()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent when the parent no longer matches its repair guard", async () => {
		const child = makeItem({
			id: "mismatched-intent-child",
			status: "interrupted",
			parentTaskId: "mismatched-intent-parent",
		})
		const parent = makeItem({
			id: "mismatched-intent-parent",
			status: "completed",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent({ ...parent, status: "delegated" }, child)))
		const childPath = path.join(tasksDir, child.id, GlobalFileNames.historyItem)
		const parentPath = path.join(tasksDir, parent.id, GlobalFileNames.historyItem)
		const beforeChild = await fs.readFile(childPath, "utf8")
		const beforeParent = await fs.readFile(parentPath, "utf8")

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("interrupted")
		expect(store.get(parent.id)?.status).toBe("completed")
		expect(await fs.readFile(childPath, "utf8")).toBe(beforeChild)
		expect(await fs.readFile(parentPath, "utf8")).toBe(beforeParent)
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("quarantines an intent when the child no longer matches its repair guard", async () => {
		const child = makeItem({
			id: "child-mismatched-intent",
			status: "completed",
			parentTaskId: "mismatched-child-parent",
		})
		const parent = makeItem({
			id: "parent-mismatched-child-intent",
			status: "active",
		})
		await seedItems([parent, child])
		const tasksDir = path.join(tmpDir, "tasks")
		const intentPath = path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(
			intentPath,
			JSON.stringify(
				makeRepairIntent(
					{ ...parent, status: "delegated", awaitingChildId: child.id, delegatedToId: child.id },
					{ ...child, status: "active" },
				),
			),
		)
		const childPath = path.join(tasksDir, child.id, GlobalFileNames.historyItem)
		const parentPath = path.join(tasksDir, parent.id, GlobalFileNames.historyItem)
		const beforeChild = await fs.readFile(childPath, "utf8")
		const beforeParent = await fs.readFile(parentPath, "utf8")

		await store.initialize()

		expect(store.get(child.id)?.status).toBe("completed")
		expect(store.get(parent.id)?.status).toBe("active")
		expect(await fs.readFile(childPath, "utf8")).toBe(beforeChild)
		expect(await fs.readFile(parentPath, "utf8")).toBe(beforeParent)
		await expect(fs.access(intentPath)).rejects.toThrow()
		expect(
			(await fs.readdir(tasksDir)).some((name) =>
				name.startsWith(`${GlobalFileNames.delegationRepairIntent}.quarantine-`),
			),
		).toBe(true)
	})

	it("repairs invalid delegation: delegated parent with no awaitingChildId → active (clears delegatedToId and awaitingChildId)", async () => {
		// awaitingChildId is falsy but explicitly set (empty string), delegatedToId is stale
		const parent = makeItem({
			id: "parent-5",
			status: "delegated",
			delegatedToId: "stale-child",
			awaitingChildId: "",
		})
		await seedItems([parent])

		await store.initialize()

		const repaired = store.get("parent-5")
		expect(repaired?.status).toBe("active")
		expect(repaired?.delegatedToId).toBeUndefined()
		// Fix #4: falsy awaitingChildId must also be cleared
		expect(repaired?.awaitingChildId).toBeUndefined()
	})

	it("does not touch active or completed tasks", async () => {
		const active = makeItem({ id: "task-active", status: "active" })
		const completed = makeItem({ id: "task-completed", status: "completed" })
		await seedItems([active, completed])

		await store.initialize()

		expect(store.get("task-active")?.status).toBe("active")
		expect(store.get("task-completed")?.status).toBe("completed")
	})

	it("repairs multiple delegated parents in a single initialize()", async () => {
		const childA = makeItem({ id: "child-a", status: "completed" })
		const parentA = makeItem({ id: "parent-a", status: "delegated", awaitingChildId: "child-a" })
		const parentB = makeItem({ id: "parent-b", status: "delegated", awaitingChildId: "missing-b" })
		await seedItems([childA, parentA, parentB])

		await store.initialize()

		expect(store.get("parent-a")?.status).toBe("active")
		expect(store.get("parent-b")?.status).toBe("active")
	})

	it("repairs an orphaned link in a chained delegation without repairing its grandparent", async () => {
		// C doesn't exist (orphaned). B is delegated waiting for C → repaired to active.
		// A sees B as delegated in the persisted startup snapshot and remains delegated.
		const parentA = makeItem({ id: "parent-a-chain", status: "delegated", awaitingChildId: "parent-b-chain" })
		const parentB = makeItem({
			id: "parent-b-chain",
			status: "delegated",
			awaitingChildId: "missing-child-chain",
		})
		await seedItems([parentA, parentB])

		await store.initialize()

		// B is repaired: its child (C) was missing
		expect(store.get("parent-b-chain")?.status).toBe("active")
		// A stays delegated: B was repaired from delegated to active and remains
		// resumable rather than being mistaken for an active orphan from disk.
		expect(store.get("parent-a-chain")?.status).toBe("delegated")
		expect(store.get("parent-a-chain")?.awaitingChildId).toBe("parent-b-chain")
		expect(store.get("parent-b-chain")?.status).toBe("active")
		expect(store.get("parent-b-chain")?.awaitingChildId).toBeUndefined()
	})

	it("does not repair a grandparent when replay repairs the middle node", async () => {
		const grandparent = makeItem({
			id: "grandparent-replay-chain",
			status: "delegated",
			awaitingChildId: "parent-replay-chain",
			delegatedToId: "parent-replay-chain",
		})
		const parent = makeItem({
			id: "parent-replay-chain",
			status: "delegated",
			awaitingChildId: "child-replay-chain",
			delegatedToId: "child-replay-chain",
			parentTaskId: grandparent.id,
			rootTaskId: grandparent.id,
		})
		const child = makeItem({
			id: "child-replay-chain",
			status: "active",
			parentTaskId: parent.id,
			rootTaskId: grandparent.id,
		})
		await seedItems([grandparent, parent, child])
		const intentPath = path.join(tmpDir, "tasks", GlobalFileNames.delegationRepairIntent)
		await fs.writeFile(intentPath, JSON.stringify(makeRepairIntent(parent, child)))

		await store.initialize()

		// Replay repairs B/C, but B was delegated at the persisted startup snapshot.
		// A must remain delegated to the now-interrupted/resumable B.
		expect(store.get(grandparent.id)).toMatchObject({
			id: grandparent.id,
			status: "delegated",
			awaitingChildId: parent.id,
			delegatedToId: parent.id,
		})
		expect(store.get(parent.id)).toMatchObject({ id: parent.id, status: "active" })
		expect(store.get(parent.id)?.awaitingChildId).toBeUndefined()
		expect(store.get(parent.id)?.delegatedToId).toBeUndefined()
		expect(store.get(child.id)).toMatchObject({ id: child.id, status: "interrupted" })

		const persistedGrandparent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", grandparent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedParent = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", parent.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		const persistedChild = JSON.parse(
			await fs.readFile(path.join(tmpDir, "tasks", child.id, GlobalFileNames.historyItem), "utf8"),
		) as HistoryItem
		expect(persistedGrandparent).toMatchObject({
			id: grandparent.id,
			status: "delegated",
			awaitingChildId: parent.id,
			delegatedToId: parent.id,
		})
		expect(persistedParent).toMatchObject({ id: parent.id, status: "active" })
		expect(persistedParent.awaitingChildId).toBeUndefined()
		expect(persistedParent.delegatedToId).toBeUndefined()
		expect(persistedChild).toMatchObject({ id: child.id, status: "interrupted" })
		await expect(fs.access(intentPath)).rejects.toThrow()
	})

	it("is idempotent when recovering an active child", async () => {
		const child = makeItem({ id: "child-active-idempotent", status: "active" })
		const parent = makeItem({
			id: "parent-active-idempotent",
			status: "delegated",
			awaitingChildId: child.id,
			delegatedToId: child.id,
		})
		await seedItems([parent, child])

		await store.initialize()
		const afterFirstParent = { ...store.get(parent.id) }
		const afterFirstChild = { ...store.get(child.id) }

		store.dispose()
		const store2 = registerStore(new TaskHistoryStore(tmpDir))
		await store2.initialize()
		const afterSecondParent = { ...store2.get(parent.id) }
		const afterSecondChild = { ...store2.get(child.id) }
		store2.dispose()

		expect(afterFirstParent).toMatchObject({ status: "active" })
		expect(afterSecondParent).toEqual(afterFirstParent)
		expect(afterFirstChild).toMatchObject({ status: "interrupted" })
		expect(afterSecondChild).toEqual(afterFirstChild)
	})

	it("is idempotent: running initialize twice produces the same result", async () => {
		const child = makeItem({ id: "child-6", status: "completed", completionResultSummary: "Done" })
		const parent = makeItem({ id: "parent-6", status: "delegated", awaitingChildId: "child-6" })
		await seedItems([parent, child])

		await store.initialize()
		const afterFirst = { ...store.get("parent-6") }

		store.dispose()
		const store2 = registerStore(new TaskHistoryStore(tmpDir))
		await store2.initialize()
		const afterSecond = { ...store2.get("parent-6") }
		store2.dispose()

		expect(afterFirst.status).toBe("active")
		expect(afterSecond.status).toBe("active")
		expect(afterSecond.completedByChildId).toBe(afterFirst.completedByChildId)
		expect(afterSecond.completionResultSummary).toBe(afterFirst.completionResultSummary)
	})

	it("logs repairs to console.warn", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const parent = makeItem({ id: "parent-log", status: "delegated", awaitingChildId: "nonexistent" })
		await seedItems([parent])

		await store.initialize()

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Reconciled orphaned delegation"))
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("parent-log"))

		warnSpy.mockRestore()
	})

	it("invokes onWrite callback after startup repairs", async () => {
		const onWrite = vi.fn().mockResolvedValue(undefined)
		store.dispose()
		store = registerStore(new TaskHistoryStore(tmpDir, { onWrite }))

		const parent = makeItem({ id: "parent-onwrite", status: "delegated", awaitingChildId: "nonexistent-child" })
		await seedItems([parent])

		await store.initialize()

		// The startup repair writes the repaired item, which must trigger onWrite
		expect(onWrite).toHaveBeenCalled()
		// The final state passed to onWrite must contain the repaired item
		const lastCall = onWrite.mock.calls[onWrite.mock.calls.length - 1][0] as HistoryItem[]
		const repaired = lastCall.find((i) => i.id === "parent-onwrite")
		expect(repaired?.status).toBe("active")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// migrateFromGlobalState — reconciliation runs after migration
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore migrateFromGlobalState reconciliation", () => {
	let tmpDir: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-migrate-test-"))
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("repairs a delegated parent introduced by migrateFromGlobalState on the same startup", async () => {
		// Simulate a first-upgrade scenario: the child task file exists on disk
		// (from a pre-migration run) but the parent arrives via migrateFromGlobalState
		// with status "delegated" and an awaitingChildId whose task dir is also present.
		// The child's history_item.json does NOT exist yet — it too will be migrated.
		const tasksDir = path.join(tmpDir, "tasks")
		const childId = "migrate-child-1"
		const parentId = "migrate-parent-1"

		// Create task directories (simulating existing task folders)
		await fs.mkdir(path.join(tasksDir, childId), { recursive: true })
		await fs.mkdir(path.join(tasksDir, parentId), { recursive: true })

		const child = makeItem({ id: childId, status: "completed", completionResultSummary: "Done" })
		const parent = makeItem({ id: parentId, status: "delegated", awaitingChildId: childId, delegatedToId: childId })

		// Migrate both — parent is delegated with a completed child
		await store.migrateFromGlobalState([child, parent])

		// The parent should be repaired to active by the post-migration reconciliation
		const repairedParent = store.get(parentId)
		expect(repairedParent?.status).toBe("active")
		expect(repairedParent?.awaitingChildId).toBeUndefined()
		expect(repairedParent?.delegatedToId).toBeUndefined()
		expect(repairedParent?.completedByChildId).toBe(childId)
		expect(repairedParent?.completionResultSummary).toBe("Done")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// upsert — transition guard enforcement at the write boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("TaskHistoryStore upsert transition guard", () => {
	let tmpDir: string
	let store: TaskHistoryStore

	async function seedItems(items: HistoryItem[]): Promise<void> {
		const tasksDir = path.join(tmpDir, "tasks")
		await fs.mkdir(tasksDir, { recursive: true })
		for (const item of items) {
			const taskDir = path.join(tasksDir, item.id)
			await fs.mkdir(taskDir, { recursive: true })
			await fs.writeFile(path.join(taskDir, "history_item.json"), JSON.stringify(item))
		}
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "upsert-guard-test-"))
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("rejects completed → active transition, preserving the completed status", async () => {
		const item = makeItem({ id: "task-guard-1", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Fire-and-forget late save: tries to write status: "active" over "completed"
		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: completed → active",
		)

		// The completed status must be preserved in the cache
		expect(store.get("task-guard-1")?.status).toBe("completed")
	})

	it("rejects delegated → completed transition", async () => {
		// Must include a live active child so reconciliation doesn't repair the parent to active
		const child = makeItem({ id: "child-guard-2", status: "interrupted" })
		const item = makeItem({ id: "task-guard-2", status: "delegated", awaitingChildId: "child-guard-2" })
		await seedItems([child, item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Confirm reconciliation left the delegated status alone
		expect(store.get("task-guard-2")?.status).toBe("delegated")

		await expect(store.upsert({ ...item, status: "completed" })).rejects.toThrow(
			"Invalid task status transition: delegated → completed",
		)

		expect(store.get("task-guard-2")?.status).toBe("delegated")
	})

	it("allows valid active → completed transition", async () => {
		const item = makeItem({ id: "task-guard-3", status: "active" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-3")?.status).toBe("completed")
	})

	it("rejects interrupted → active transition, preserving the interrupted status", async () => {
		const item = makeItem({ id: "task-guard-interrupted", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).rejects.toThrow(
			"Invalid task status transition: interrupted → active",
		)
		expect(store.get("task-guard-interrupted")?.status).toBe("interrupted")
	})

	it("allows valid interrupted → completed transition", async () => {
		const item = makeItem({ id: "task-guard-interrupted-complete", status: "interrupted" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "completed" })).resolves.toBeDefined()
		expect(store.get("task-guard-interrupted-complete")?.status).toBe("completed")
	})

	it("allows first insert with status: active (no prior record to transition from)", async () => {
		const item = makeItem({ id: "task-guard-new", status: "active" })
		// Do NOT seed — this is the very first write for this task
		await expect(store.upsert(item)).resolves.toBeDefined()
		expect(store.get("task-guard-new")?.status).toBe("active")
	})

	it("allows writing status: active over a legacy item with status: undefined (implicit active → active no-op)", async () => {
		// Legacy items pre-dating the status field have status: undefined, which normalizes
		// to "active". Writing status: "active" must not throw as an invalid self-loop.
		const item = makeItem({ id: "task-guard-legacy" })
		const { status: _status, ...legacyItem } = item
		await seedItems([legacyItem])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		await expect(store.upsert({ ...item, status: "active" })).resolves.toBeDefined()
		expect(store.get("task-guard-legacy")?.status).toBe("active")
	})

	it("allows upsert without a status field (no-op on status)", async () => {
		const item = makeItem({ id: "task-guard-4", status: "completed" })
		await seedItems([item])
		store.dispose()
		store = new TaskHistoryStore(tmpDir)
		await store.initialize()

		// Omitting status entirely — no transition should be validated
		const { status: _omit, ...noStatus } = item
		await expect(store.upsert(noStatus as HistoryItem)).resolves.toBeDefined()
		// Status is preserved from the existing cache entry
		expect(store.get("task-guard-4")?.status).toBe("completed")
	})

	it("atomicReadAndUpdate enforces the upsertCore transition guard on status changes", async () => {
		// atomicReadAndUpdate now flows through upsertCore without skipTransitionCheck,
		// so invalid transitions are rejected at the store boundary.
		const item = makeItem({ id: "task-atomic-guard", status: "active" })
		await store.upsert(item)

		// active → delegated via atomicReadAndUpdate — valid, must succeed
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "delegated" as const,
				awaitingChildId: "some-child",
			})),
		).resolves.toBeDefined()
		expect(store.get("task-atomic-guard")?.status).toBe("delegated")

		// delegated → completed via atomicReadAndUpdate — invalid, must throw
		await expect(
			store.atomicReadAndUpdate("task-atomic-guard", (current) => ({
				...current,
				status: "completed" as const,
			})),
		).rejects.toThrow("Invalid task status transition: delegated → completed")
	})
})
