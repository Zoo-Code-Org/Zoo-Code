// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.deleteSemantics.spec.ts
//
// Focused fail-closed deletion semantics for `delete()` and `deleteMany()`.
// Lock, unlink, and fs behavior stay real by default; individual tests force
// one lock or unlink failure through the wrappers below.

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore, TaskHistoryPartialDeleteError } from "../TaskHistoryStore"
import { withFileLock } from "../../../utils/fileLock"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

// The default implementation stays the real one, so `safeWriteJson` writes
// and per-file locking behave exactly as in production unless a test forces
// a failure.
vi.mock("../../../utils/fileLock", async () => {
	const actual = await vi.importActual<typeof import("../../../utils/fileLock")>("../../../utils/fileLock")
	return { ...actual, withFileLock: vi.fn(actual.withFileLock) }
})

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, unlink: vi.fn(actual.unlink) }
})

const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
const actualFileLock = await vi.importActual<typeof import("../../../utils/fileLock")>("../../../utils/fileLock")

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

function historyFilePath(storagePath: string, taskId: string): string {
	return path.join(storagePath, "tasks", taskId, GlobalFileNames.historyItem)
}

function epermLike(message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code: "EACCES" })
}

describe("TaskHistoryStore fail-closed deletion semantics", () => {
	let storagePath: string
	let stores: TaskHistoryStore[]
	let onWrite: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-delete-semantics-"))
		stores = []
		onWrite = vi.fn().mockResolvedValue(undefined)
		vi.mocked(withFileLock).mockImplementation(actualFileLock.withFileLock)
		vi.mocked(fs.unlink).mockImplementation(actualFs.unlink)
	})

	afterEach(async () => {
		for (const store of stores) {
			store.dispose()
		}
		await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {})
	})

	function createStore(): TaskHistoryStore {
		const store = new TaskHistoryStore(storagePath, {
			onWrite: onWrite as (items: HistoryItem[]) => Promise<void>,
		})
		stores.push(store)
		return store
	}

	describe("delete()", () => {
		it("propagates a lock acquisition failure, keeps the cache entry and file, and skips write-through", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail" }))
			onWrite.mockClear()

			const lockError = new Error("lock acquisition timed out")
			vi.mocked(withFileLock).mockRejectedValueOnce(lockError)

			await expect(store.delete("lock-fail")).rejects.toBe(lockError)

			// The file stayed on disk, the cache entry survived, and no
			// removal was persisted through onWrite.
			await expect(fs.access(historyFilePath(storagePath, "lock-fail"))).resolves.toBeUndefined()
			expect(store.get("lock-fail")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("propagates a non-ENOENT unlink failure, keeps the cache entry and file, and stays deletable afterwards", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "perm-fail" }))
			onWrite.mockClear()

			const unlinkError = epermLike("EACCES: permission denied, unlink")
			vi.mocked(fs.unlink).mockRejectedValueOnce(unlinkError)

			await expect(store.delete("perm-fail")).rejects.toBe(unlinkError)

			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).resolves.toBeUndefined()
			expect(store.get("perm-fail")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()

			// The per-file lock was released: a retry without the injected
			// failure deletes the file and writes through.
			await expect(store.delete("perm-fail")).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(store.get("perm-fail")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("treats a confirmed ENOENT as a successful deletion", async () => {
			const store = createStore()
			await store.initialize()

			// A task that never existed resolves without throwing.
			await expect(store.delete("never-existed")).resolves.toBeUndefined()

			// A task whose file a peer already removed also deletes cleanly.
			await store.upsert(makeHistoryItem({ id: "peer-removed" }))
			await fs.unlink(historyFilePath(storagePath, "peer-removed"))
			await expect(store.delete("peer-removed")).resolves.toBeUndefined()
			expect(store.get("peer-removed")).toBeUndefined()
			expect(onWrite).toHaveBeenCalled()
		})
	})

	describe("deleteMany()", () => {
		it("stops at the first failure, preserves failed and unattempted cache entries, and writes through completed deletions before rejecting", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "batch-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "batch-b", ts: 2000 }))
			await store.upsert(makeHistoryItem({ id: "batch-c", ts: 3000 }))
			onWrite.mockClear()

			const unlinkError = epermLike("EACCES: permission denied, unlink")
			const events: string[] = []
			onWrite.mockImplementation(async () => {
				events.push("write-through")
			})

			vi.mocked(fs.unlink).mockImplementation(async (p) => {
				if (p === historyFilePath(storagePath, "batch-b")) {
					throw unlinkError
				}
				return actualFs.unlink(p)
			})

			const pending = store.deleteMany(["batch-a", "batch-b", "batch-c"]).catch((error) => {
				events.push("rejected")
				return error
			})
			const partialError = (await pending) as TaskHistoryPartialDeleteError

			// The write-through of completed deletions is awaited before the
			// rejection reaches the caller.
			expect(events).toEqual(["write-through", "rejected"])

			expect(partialError).toBeInstanceOf(TaskHistoryPartialDeleteError)
			expect(partialError.failures).toEqual([{ taskId: "batch-b", reason: unlinkError }])
			expect(partialError.cause).toBe(unlinkError)

			// batch-a completed: file gone, cache evicted.
			await expect(fs.access(historyFilePath(storagePath, "batch-a"))).rejects.toMatchObject({ code: "ENOENT" })
			expect(store.get("batch-a")).toBeUndefined()

			// batch-b failed: file present, cache entry preserved.
			await expect(fs.access(historyFilePath(storagePath, "batch-b"))).resolves.toBeUndefined()
			expect(store.get("batch-b")).toBeDefined()

			// batch-c was never attempted: file present, cache entry preserved.
			await expect(fs.access(historyFilePath(storagePath, "batch-c"))).resolves.toBeUndefined()
			expect(store.get("batch-c")).toBeDefined()

			// The write-through saw the cache after completed deletions only.
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id).sort()
			expect(writtenIds).toEqual(["batch-b", "batch-c"])
		})

		it("preserves the original deletion error when the failure-path write-through also fails", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "batch-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "batch-b", ts: 2000 }))
			onWrite.mockClear()

			const unlinkError = epermLike("EACCES: permission denied, unlink")
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

			vi.mocked(fs.unlink).mockImplementation(async (p) => {
				if (p === historyFilePath(storagePath, "batch-b")) {
					throw unlinkError
				}
				return actualFs.unlink(p)
			})
			onWrite.mockRejectedValue(new Error("write-through boom"))

			try {
				const partialError = (await store
					.deleteMany(["batch-a", "batch-b"])
					.catch((error) => error)) as TaskHistoryPartialDeleteError

				// The original deletion failure stays the reported error.
				expect(partialError).toBeInstanceOf(TaskHistoryPartialDeleteError)
				expect(partialError.failures).toEqual([{ taskId: "batch-b", reason: unlinkError }])
				expect(partialError.cause).toBe(unlinkError)

				// The secondary write-through failure is logged, not thrown.
				expect(consoleError).toHaveBeenCalledWith(
					"[TaskHistoryStore] Write-through after partial deleteMany failed:",
					expect.any(Error),
				)

				// batch-a stays deleted and batch-b stays intact.
				await expect(fs.access(historyFilePath(storagePath, "batch-a"))).rejects.toMatchObject({
					code: "ENOENT",
				})
				await expect(fs.access(historyFilePath(storagePath, "batch-b"))).resolves.toBeUndefined()
				expect(store.get("batch-b")).toBeDefined()
			} finally {
				consoleError.mockRestore()
			}
		})
	})
})
