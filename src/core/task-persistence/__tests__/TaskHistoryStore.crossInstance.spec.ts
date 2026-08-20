// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.crossInstance.spec.ts

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore, DeltaRejectedError } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
		return defaultPath
	}),
}))

// Mock safeWriteJson to use plain fs writes but honor the merge callback.
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi
		.fn()
		.mockImplementation(
			async (
				filePath: string,
				data: unknown,
				options?: { merge?: (existing: unknown, incoming: unknown) => unknown },
			) => {
				await fs.mkdir(path.dirname(filePath), { recursive: true })
				if (options?.merge) {
					let existing: unknown = null
					try {
						const raw = await fs.readFile(filePath, "utf8")
						existing = JSON.parse(raw)
					} catch {
						// File does not exist or is corrupt
					}
					data = options.merge(existing, data)
				}
				await fs.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8")
			},
		),
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

describe("TaskHistoryStore cross-instance safety", () => {
	let tmpDir: string
	let storeA: TaskHistoryStore
	let storeB: TaskHistoryStore

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-cross-"))
		// Two stores pointing at the same globalStoragePath (simulating two VS Code windows)
		storeA = new TaskHistoryStore(tmpDir)
		storeB = new TaskHistoryStore(tmpDir)
	})

	afterEach(async () => {
		storeA.dispose()
		storeB.dispose()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("two instances can write different tasks without conflict", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A writes task-a
		await storeA.upsert(makeHistoryItem({ id: "task-a", task: "Task from instance A" }))

		// Instance B writes task-b
		await storeB.upsert(makeHistoryItem({ id: "task-b", task: "Task from instance B" }))

		// Each instance sees its own task
		expect(storeA.get("task-a")).toBeDefined()
		expect(storeB.get("task-b")).toBeDefined()

		// After reconciliation, instance A should see task-b and vice versa
		await storeA.reconcile()
		await storeB.reconcile()

		expect(storeA.get("task-b")).toBeDefined()
		expect(storeB.get("task-a")).toBeDefined()

		expect(storeA.getAll()).toHaveLength(2)
		expect(storeB.getAll()).toHaveLength(2)
	})

	it("reconciliation in instance B detects a task created by instance A", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A creates a task
		const item = makeHistoryItem({ id: "cross-task", task: "Created by A" })
		await storeA.upsert(item)

		// Instance B doesn't know about it yet
		expect(storeB.get("cross-task")).toBeUndefined()

		// Reconciliation picks it up
		await storeB.reconcile()

		expect(storeB.get("cross-task")).toBeDefined()
		expect(storeB.get("cross-task")!.task).toBe("Created by A")
	})

	it("delete by instance A is detected by instance B reconciliation", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Both instances have a task
		const item = makeHistoryItem({ id: "shared-task" })
		await storeA.upsert(item)
		await storeB.reconcile() // B picks it up

		expect(storeB.get("shared-task")).toBeDefined()

		// Instance A deletes the task (per-task file + directory would be removed)
		await storeA.delete("shared-task")

		// Remove the task directory to simulate full deletion (deleteTaskWithId removes the dir)
		const taskDir = path.join(tmpDir, "tasks", "shared-task")
		await fs.rm(taskDir, { recursive: true, force: true })

		// Instance B still has it in cache
		expect(storeB.get("shared-task")).toBeDefined()

		// After reconciliation, instance B sees it's gone
		await storeB.reconcile()
		expect(storeB.get("shared-task")).toBeUndefined()
	})

	it("delete by instance A is detected even when the task directory remains", async () => {
		await storeA.initialize()
		await storeB.initialize()

		const item = makeHistoryItem({ id: "file-only-delete" })
		await storeA.upsert(item)
		await storeB.reconcile()

		expect(storeB.get("file-only-delete")).toBeDefined()

		// delete() unlinks history_item.json but leaves the task directory.
		await storeA.delete("file-only-delete")

		// Directory still exists (other files like ui_messages.json may remain).
		const taskDir = path.join(tmpDir, "tasks", "file-only-delete")
		await expect(fs.access(taskDir)).resolves.toBeUndefined()

		await storeB.reconcile()
		expect(storeB.get("file-only-delete")).toBeUndefined()
	})

	it("per-task file updates by one instance are visible to another after invalidation", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Instance A creates a task
		const item = makeHistoryItem({ id: "update-task", tokensIn: 100 })
		await storeA.upsert(item)

		// Instance B picks it up via reconciliation
		await storeB.reconcile()
		expect(storeB.get("update-task")!.tokensIn).toBe(100)

		// Instance A updates the task
		await storeA.upsert({ ...item, tokensIn: 500 })

		// Instance B invalidates and re-reads
		await storeB.invalidate("update-task")
		expect(storeB.get("update-task")!.tokensIn).toBe(500)
	})

	it("concurrent writes to different tasks from two instances produce correct final state", async () => {
		await storeA.initialize()
		await storeB.initialize()

		// Write alternating tasks from each instance
		const promises = []
		for (let i = 0; i < 5; i++) {
			promises.push(storeA.upsert(makeHistoryItem({ id: `a-task-${i}`, ts: 1000 + i })))
			promises.push(storeB.upsert(makeHistoryItem({ id: `b-task-${i}`, ts: 2000 + i })))
		}

		await Promise.all(promises)

		// After reconciliation, both should see all 10 tasks
		await storeA.reconcile()
		await storeB.reconcile()

		expect(storeA.getAll().length).toBe(10)
		expect(storeB.getAll().length).toBe(10)
	})

	/**
	 * Host B completes a task on disk while host A's cache still has it
	 * active. Host A's next save updates only totalCost (a full-object
	 * upsert — the realistic production shape). The diff-delta merge
	 * preserves B's status because status did not change in A's cache.
	 */
	it("per-task diff-delta preserves a peer's status change on full-object upsert", async () => {
		await storeA.initialize()

		// Base item with an explicit status — mirrors real production items.
		const base = makeHistoryItem({ id: "shared-task", status: "active", totalCost: 0.01, ts: 1000 })
		await storeA.upsert(base)

		// Host B completes the task on disk; A's cache still has "active".
		const filePath = path.join(tmpDir, "tasks", "shared-task", GlobalFileNames.historyItem)
		const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"))
		onDisk.status = "completed"
		onDisk.completionResultSummary = "done by host B"
		await fs.writeFile(filePath, JSON.stringify(onDisk), "utf8")

		// Host A does a full-object upsert (the realistic path — spread the
		// cached item and change one field). The cached item has status: "active".
		await storeA.upsert({ ...storeA.get("shared-task")!, totalCost: 9.99 })

		const final = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem
		expect(final.totalCost).toBe(9.99)
		// Status is preserved from disk because A's delta does not include
		// status — it was unchanged relative to A's cache.
		expect(final.status).toBe("completed")
		expect(final.completionResultSummary).toBe("done by host B")

		// Cache reflects the caller's totalCost change and the peer's status.
		expect(storeA.get("shared-task")!.totalCost).toBe(9.99)
		expect(storeA.get("shared-task")!.status).toBe("completed")
		expect(storeA.get("shared-task")!.completionResultSummary).toBe("done by host B")
	})

	/**
	 * Regression: a stale host whose cache says "active" tries to write
	 * status: "delegated" after a peer already wrote "completed" to disk.
	 * The merge must reject the entire delta (including companion fields)
	 * to prevent an internally-inconsistent record.
	 */
	it("merge rejects an invalid status transition against disk and throws DeltaRejectedError", async () => {
		await storeA.initialize()

		const base = makeHistoryItem({ id: "guarded-task", status: "active", totalCost: 0.01, ts: 1000 })
		await storeA.upsert(base)

		// Peer writes terminal "completed" directly to disk.
		const filePath = path.join(tmpDir, "tasks", "guarded-task", GlobalFileNames.historyItem)
		const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"))
		onDisk.status = "completed"
		onDisk.completionResultSummary = "done by peer"
		await fs.writeFile(filePath, JSON.stringify(onDisk), "utf8")

		// Host A's cache still has "active". It tries to delegate (active → delegated
		// passes the cache check, but completed → delegated is invalid on disk).
		const staleItem = storeA.get("guarded-task")!
		await expect(
			storeA.upsert({
				...staleItem,
				status: "delegated",
				awaitingChildId: "child-99",
				delegatedToId: "child-99",
			}),
		).rejects.toThrow(DeltaRejectedError)

		const final = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem
		// Terminal status must survive — disk is untouched.
		expect(final.status).toBe("completed")
		expect(final.completionResultSummary).toBe("done by peer")
		// Companion fields from the rejected delta must NOT be applied.
		expect(final.awaitingChildId).toBeUndefined()
		expect(final.delegatedToId).toBeUndefined()

		// Cache must reflect the disk state, not the stale delta.
		expect(storeA.get("guarded-task")!.status).toBe("completed")
	})

	/**
	 * When both hosts change the same field, the last writer wins.
	 * This is expected — true conflict resolution requires application
	 * semantics that a generic merge cannot provide.
	 */
	it("same-field changes from both hosts are last-writer-wins", async () => {
		await storeA.initialize()
		await storeB.initialize()

		const base = makeHistoryItem({ id: "shared-task", status: "active", totalCost: 0.01, ts: 1000 })
		await storeA.upsert(base)
		await storeB.reconcile()

		// Both hosts change totalCost.
		await storeA.upsert({ ...storeA.get("shared-task")!, totalCost: 1.0 })
		await storeB.upsert({ ...storeB.get("shared-task")!, totalCost: 2.0 })

		const filePath = path.join(tmpDir, "tasks", "shared-task", GlobalFileNames.historyItem)
		const final = JSON.parse(await fs.readFile(filePath, "utf8")) as HistoryItem
		// B wrote last, so B's value wins.
		expect(final.totalCost).toBe(2.0)
	})
})
