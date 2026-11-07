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

	describe("setTitleIfUnset", () => {
		it("keeps a manual title that another instance wrote after this cache was loaded", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-task", task: "Original prompt" }))
			await storeB.reconcile()
			expect(storeB.get("title-task")?.title).toBeUndefined()

			// Instance A still caches no title when B renames the task on disk.
			await storeB.atomicReadAndUpdate("title-task", (item) => ({ ...item, title: "Manual title" }))
			expect(storeA.get("title-task")?.title).toBeUndefined()

			await expect(storeA.setTitleIfUnset("title-task", "Auto title")).resolves.toBe("conflict")

			expect(storeA.get("title-task")?.title).toBe("Manual title")
			await storeB.reconcile()
			expect(storeB.get("title-task")?.title).toBe("Manual title")
		})

		it("does not recreate a task that another instance deleted", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-deleted", task: "Original prompt" }))
			await storeB.reconcile()

			await storeB.delete("title-deleted")
			expect(storeA.get("title-deleted")).toBeDefined()

			await expect(storeA.setTitleIfUnset("title-deleted", "Auto title")).resolves.toBe("conflict")

			expect(storeA.get("title-deleted")).toBeUndefined()
			await storeB.reconcile()
			expect(storeB.get("title-deleted")).toBeUndefined()
		})

		it("applies the title when no instance has set one", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-free", task: "Original prompt" }))

			await expect(storeA.setTitleIfUnset("title-free", "Auto title")).resolves.toBe("applied")

			expect(storeA.get("title-free")).toMatchObject({ title: "Auto title", task: "Original prompt" })
		})

		it("persists the title to disk so reloading from storage preserves it", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "persist-check", task: "Original task prompt" }))

			await expect(storeA.setTitleIfUnset("persist-check", "Persisted title")).resolves.toBe("applied")

			// Reload a fresh store instance pointing to the same disk directory
			const storeReloaded = new TaskHistoryStore(tmpDir)
			await storeReloaded.initialize()

			const diskItem = storeReloaded.get("persist-check")
			expect(diskItem).toBeDefined()
			expect(diskItem?.title).toBe("Persisted title")
			expect(diskItem?.task).toBe("Original task prompt")
			storeReloaded.dispose()
		})

		it("reports missing when the task is not in the cache", async () => {
			await storeA.initialize()
			await expect(storeA.setTitleIfUnset("missing-id", "Auto title")).resolves.toBe("missing")
		})

		it("reports conflict for a malformed disk record without rewriting it", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-malformed", task: "Prompt" }))
			const filePath = path.join(tmpDir, "tasks", "title-malformed", GlobalFileNames.historyItem)
			// Valid JSON that fails the canonical task-history schema: id must be a string.
			const malformed = JSON.stringify({ id: 123 })
			await fs.writeFile(filePath, malformed, "utf8")

			await expect(storeA.setTitleIfUnset("title-malformed", "Auto title")).resolves.toBe("conflict")

			// The stale cache entry is dropped and the unusable record stays untouched.
			expect(storeA.get("title-malformed")).toBeUndefined()
			expect(await fs.readFile(filePath, "utf8")).toBe(malformed)
		})

		it("reports conflict when the disk record belongs to a different task", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-mismatched", task: "Prompt" }))
			const filePath = path.join(tmpDir, "tasks", "title-mismatched", GlobalFileNames.historyItem)
			const otherTask = JSON.stringify(makeHistoryItem({ id: "other-task" }), null, "\t")
			await fs.writeFile(filePath, otherTask, "utf8")

			await expect(storeA.setTitleIfUnset("title-mismatched", "Auto title")).resolves.toBe("conflict")

			expect(storeA.get("title-mismatched")).toBeUndefined()
			// The other task's record is never merged into this task or overwritten.
			expect(await fs.readFile(filePath, "utf8")).toBe(otherTask)
		})

		it("keeps a manual clear that another instance persisted", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-cleared", task: "Original prompt" }))
			await storeB.reconcile()

			// Instance B clears the title (rename with an empty name) on disk.
			await storeB.atomicReadAndUpdate("title-cleared", (item) => ({
				...item,
				title: undefined,
				titleCleared: true,
			}))

			await expect(storeA.setTitleIfUnset("title-cleared", "Auto title")).resolves.toBe("conflict")

			expect(storeA.get("title-cleared")?.title).toBeUndefined()
			await storeB.reconcile()
			expect(storeB.get("title-cleared")?.title).toBeUndefined()
		})

		it("returns conflict immediately when cached item already has a title", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "already-titled", title: "Existing", task: "Prompt" }))
			await expect(storeA.setTitleIfUnset("already-titled", "New title")).resolves.toBe("conflict")
		})

		it("notifies onWrite callback when title is successfully applied", async () => {
			const onWriteSpy = vi.fn().mockResolvedValue(undefined)
			const storeWithOnWrite = new TaskHistoryStore(tmpDir, { onWrite: onWriteSpy })
			await storeWithOnWrite.initialize()
			await storeWithOnWrite.upsert(makeHistoryItem({ id: "title-onwrite", task: "Prompt" }))
			onWriteSpy.mockClear()

			await expect(storeWithOnWrite.setTitleIfUnset("title-onwrite", "Notified title")).resolves.toBe("applied")
			expect(onWriteSpy).toHaveBeenCalledWith(
				expect.arrayContaining([expect.objectContaining({ id: "title-onwrite", title: "Notified title" })]),
			)
			storeWithOnWrite.dispose()
		})

		it("preserves fields written by another extension version when applying a title", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-extra-fields", task: "Prompt" }))
			const filePath = path.join(tmpDir, "tasks", "title-extra-fields", GlobalFileNames.historyItem)
			const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"))
			// A field this version does not know about, written by another build.
			onDisk.futureField = "kept"
			await fs.writeFile(filePath, JSON.stringify(onDisk), "utf8")

			await expect(storeA.setTitleIfUnset("title-extra-fields", "Auto title")).resolves.toBe("applied")

			const final = JSON.parse(await fs.readFile(filePath, "utf8"))
			expect(final.title).toBe("Auto title")
			expect(final.futureField).toBe("kept")
		})

		it("re-throws unexpected errors from safeWriteJson", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "title-io-err", task: "Prompt" }))

			const { safeWriteJson } = await import("../../../utils/safeWriteJson")
			const mockedSafeWrite = vi.mocked(safeWriteJson)
			mockedSafeWrite.mockRejectedValueOnce(new Error("disk IO error"))

			await expect(storeA.setTitleIfUnset("title-io-err", "Auto title")).rejects.toThrow("disk IO error")
		})
	})

	describe("setTitleManually", () => {
		it("removes a title another instance wrote even when this cache has none", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-clear", task: "Prompt" }))
			await storeB.reconcile()

			// Instance B renames the task on disk; instance A's cache still has no title.
			await storeB.atomicReadAndUpdate("manual-clear", (item) => ({ ...item, title: "Manual title" }))
			expect(storeA.get("manual-clear")?.title).toBeUndefined()

			// A clear from instance A must remove the disk title, not just the cached one.
			await expect(storeA.setTitleManually("manual-clear", undefined)).resolves.toMatchObject({
				id: "manual-clear",
				titleCleared: true,
			})

			const filePath = path.join(tmpDir, "tasks", "manual-clear", GlobalFileNames.historyItem)
			const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"))
			expect(onDisk.title).toBeUndefined()
			expect(onDisk.titleCleared).toBe(true)
		})

		it("keeps a manual title that commits while the automatic title is generating", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-wins", task: "Prompt" }))
			await storeB.reconcile()

			await storeB.setTitleManually("manual-wins", "Manual title")
			// The generating host still has the untitled record cached.
			expect(storeA.get("manual-wins")?.title).toBeUndefined()

			await expect(storeA.setTitleIfUnset("manual-wins", "Auto title")).resolves.toBe("conflict")
			expect(storeA.get("manual-wins")?.title).toBe("Manual title")
		})

		it("returns undefined for a task that is not in the cache", async () => {
			await storeA.initialize()
			await expect(storeA.setTitleManually("missing-id", "Manual title")).resolves.toBeUndefined()
		})

		it("drops the cache entry for a malformed disk record without rewriting it", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-malformed", task: "Prompt" }))
			const filePath = path.join(tmpDir, "tasks", "manual-malformed", GlobalFileNames.historyItem)
			const malformed = JSON.stringify({ id: 123 })
			await fs.writeFile(filePath, malformed, "utf8")

			await expect(storeA.setTitleManually("manual-malformed", "Manual title")).resolves.toBeUndefined()

			expect(storeA.get("manual-malformed")).toBeUndefined()
			expect(await fs.readFile(filePath, "utf8")).toBe(malformed)
		})

		it("drops the cache entry when the disk record belongs to another task", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-mismatched", task: "Prompt" }))
			const filePath = path.join(tmpDir, "tasks", "manual-mismatched", GlobalFileNames.historyItem)
			const otherTask = JSON.stringify(makeHistoryItem({ id: "other-task" }), null, "\t")
			await fs.writeFile(filePath, otherTask, "utf8")

			await expect(storeA.setTitleManually("manual-mismatched", "Manual title")).resolves.toBeUndefined()

			expect(storeA.get("manual-mismatched")).toBeUndefined()
			expect(await fs.readFile(filePath, "utf8")).toBe(otherTask)
		})

		it("re-throws unexpected errors from safeWriteJson", async () => {
			await storeA.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-io-err", task: "Prompt" }))
			const { safeWriteJson } = await import("../../../utils/safeWriteJson")
			vi.mocked(safeWriteJson).mockRejectedValueOnce(new Error("disk IO error"))

			await expect(storeA.setTitleManually("manual-io-err", "Manual title")).rejects.toThrow("disk IO error")
		})

		it("notifies onWrite when a manual title is applied", async () => {
			const onWriteSpy = vi.fn().mockResolvedValue(undefined)
			const storeWithOnWrite = new TaskHistoryStore(tmpDir, { onWrite: onWriteSpy })
			await storeWithOnWrite.initialize()
			await storeWithOnWrite.upsert(makeHistoryItem({ id: "manual-onwrite", task: "Prompt" }))
			onWriteSpy.mockClear()

			await expect(storeWithOnWrite.setTitleManually("manual-onwrite", "Notified title")).resolves.toMatchObject({
				id: "manual-onwrite",
				title: "Notified title",
			})
			expect(onWriteSpy).toHaveBeenCalledWith(
				expect.arrayContaining([expect.objectContaining({ id: "manual-onwrite", title: "Notified title" })]),
			)
			storeWithOnWrite.dispose()
		})

		it("writes a title on a record this cache has never seen the latest fields of", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-set", task: "Prompt", tokensIn: 1 }))
			await storeB.reconcile()

			await storeB.atomicReadAndUpdate("manual-set", (item) => ({ ...item, tokensIn: 99 }))
			await storeA.setTitleManually("manual-set", "Manual title")

			const filePath = path.join(tmpDir, "tasks", "manual-set", GlobalFileNames.historyItem)
			const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"))
			expect(onDisk).toMatchObject({ title: "Manual title", tokensIn: 99 })
		})

		it("drops the task when another instance deleted it", async () => {
			await storeA.initialize()
			await storeB.initialize()
			await storeA.upsert(makeHistoryItem({ id: "manual-deleted", task: "Prompt" }))
			await storeB.reconcile()
			await storeB.delete("manual-deleted")

			await expect(storeA.setTitleManually("manual-deleted", "Manual title")).resolves.toBeUndefined()
			expect(storeA.get("manual-deleted")).toBeUndefined()
		})
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

	it("preserves the cached record when rejected-action settlement fails with an unrelated lock error", async () => {
		await storeA.initialize()
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			mode: "code",
			message: "action A",
			todos: [],
		}
		const cached = makeHistoryItem({ id: "settlement-error-task", pendingAction })
		await storeA.upsert(cached)

		const { safeWriteJson } = await import("../../../utils/safeWriteJson")
		const lockError = Object.assign(new Error("lock acquisition failed"), { code: "ELOCKED" })
		vi.mocked(safeWriteJson).mockRejectedValueOnce(lockError)

		await expect(storeA.clearPendingActionIfMatching(cached.id, pendingAction.actionId)).rejects.toBe(lockError)
		expect(storeA.get(cached.id)).toEqual(cached)
	})

	it("evicts stale cache state when the disk record is invalid without recreating it", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			mode: "code",
			message: "action A",
			todos: [],
		}
		const cached = makeHistoryItem({ id: "invalid-settlement-task", pendingAction })
		const filePath = path.join(tmpDir, "tasks", cached.id, GlobalFileNames.historyItem)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, "{invalid", "utf8")
		const storeState = storeA as unknown as {
			cache: Map<string, HistoryItem>
			taskFileMtimes: Map<string, number>
		}
		storeState.cache.set(cached.id, cached)
		storeState.taskFileMtimes.set(cached.id, Date.now())

		await expect(storeA.clearPendingActionIfMatching(cached.id, pendingAction.actionId)).rejects.toThrow(
			`task ${cached.id} not found in cache`,
		)
		expect(storeA.get(cached.id)).toBeUndefined()
		expect(storeState.taskFileMtimes.has(cached.id)).toBe(false)
		expect(await fs.readFile(filePath, "utf8")).toBe("{invalid")
	})

	it("fails settlement closed for a malformed disk record without rewriting it", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			mode: "code",
			message: "action A",
			todos: [],
		}
		const cached = makeHistoryItem({ id: "malformed-settlement-task", pendingAction })
		const filePath = path.join(tmpDir, "tasks", cached.id, GlobalFileNames.historyItem)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		// Valid JSON that fails the canonical task-history schema: id must
		// be a string and the required history fields are absent.
		const malformed = JSON.stringify({ id: 123, pendingAction })
		await fs.writeFile(filePath, malformed, "utf8")
		const storeState = storeA as unknown as {
			cache: Map<string, HistoryItem>
			taskFileMtimes: Map<string, number>
		}
		storeState.cache.set(cached.id, cached)
		storeState.taskFileMtimes.set(cached.id, Date.now())

		await expect(storeA.clearPendingActionIfMatching(cached.id, pendingAction.actionId)).rejects.toThrow(
			`task ${cached.id} has an invalid disk record`,
		)
		expect(storeA.get(cached.id)).toBeUndefined()
		expect(storeState.taskFileMtimes.has(cached.id)).toBe(false)
		// The malformed record stays on disk untouched.
		expect(await fs.readFile(filePath, "utf8")).toBe(malformed)
	})

	it("fails settlement closed when the disk record carries a different task id", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "action-a",
			approvalText: "{}",
			mode: "code",
			message: "action A",
			todos: [],
		}
		const cached = makeHistoryItem({ id: "mismatch-settlement-task", pendingAction })
		const other = makeHistoryItem({ id: "other-task" })
		const filePath = path.join(tmpDir, "tasks", cached.id, GlobalFileNames.historyItem)
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		const mismatched = JSON.stringify(other, null, "\t")
		await fs.writeFile(filePath, mismatched, "utf8")
		const storeState = storeA as unknown as {
			cache: Map<string, HistoryItem>
			taskFileMtimes: Map<string, number>
		}
		storeState.cache.set(cached.id, cached)
		storeState.taskFileMtimes.set(cached.id, Date.now())

		await expect(storeA.clearPendingActionIfMatching(cached.id, pendingAction.actionId)).rejects.toThrow(
			`task ${cached.id} has a disk record with mismatched id other-task`,
		)
		expect(storeA.get(cached.id)).toBeUndefined()
		expect(storeState.taskFileMtimes.has(cached.id)).toBe(false)
		// The other task's record stays on disk untouched.
		expect(await fs.readFile(filePath, "utf8")).toBe(mismatched)
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
