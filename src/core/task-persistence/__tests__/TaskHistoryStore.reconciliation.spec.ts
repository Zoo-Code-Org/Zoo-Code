// pnpm --filter zoo-code test core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore, assertValidTransition } from "../TaskHistoryStore"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: any) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
	}),
}))

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

		it("delegated → active", () => {
			expect(() => assertValidTransition("delegated", "active")).not.toThrow()
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
		store = new TaskHistoryStore(tmpDir)
	})

	afterEach(async () => {
		store.dispose()
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

	it("leaves delegated parent alone when child is still active", async () => {
		const child = makeItem({ id: "child-4", status: "active" })
		const parent = makeItem({ id: "parent-4", status: "delegated", awaitingChildId: "child-4" })
		await seedItems([parent, child])

		await store.initialize()

		const unchanged = store.get("parent-4")
		expect(unchanged?.status).toBe("delegated")
		expect(unchanged?.awaitingChildId).toBe("child-4")
	})

	it("repairs invalid delegation: delegated parent with no awaitingChildId → active (clears delegatedToId and awaitingChildId)", async () => {
		// awaitingChildId is falsy but explicitly set (empty string), delegatedToId is stale
		const parent = makeItem({
			id: "parent-5",
			status: "delegated",
			delegatedToId: "stale-child",
			awaitingChildId: "",
		} as any)
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

	it("handles chained delegation (A→B→C): repairs B first, then A sees B as active and is left delegated", async () => {
		// C doesn't exist (orphaned). B is delegated waiting for C → repaired to active.
		// A is delegated waiting for B → left delegated (B is now active, resumable by user).
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
		// A stays delegated: its child (B) is now active, which is a valid state
		expect(store.get("parent-a-chain")?.status).toBe("delegated")
		expect(store.get("parent-a-chain")?.awaitingChildId).toBe("parent-b-chain")
	})

	it("is idempotent: running initialize twice produces the same result", async () => {
		const child = makeItem({ id: "child-6", status: "completed", completionResultSummary: "Done" })
		const parent = makeItem({ id: "parent-6", status: "delegated", awaitingChildId: "child-6" })
		await seedItems([parent, child])

		await store.initialize()
		const afterFirst = { ...store.get("parent-6") }

		store.dispose()
		const store2 = new TaskHistoryStore(tmpDir)
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
		store = new TaskHistoryStore(tmpDir, { onWrite })

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
		const child = makeItem({ id: "child-guard-2", status: "active" })
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
		delete (item as any).status
		await seedItems([item])
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
