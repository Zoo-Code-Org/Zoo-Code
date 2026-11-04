// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.deleteSemantics.spec.ts
//
// Best-effort deletion semantics for `delete()` and `deleteMany()`.
// Lock, unlink, and fs behavior stay real by default; individual tests force
// one lock or unlink failure through the wrappers below.

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
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

function storeInternals(store: TaskHistoryStore): {
	cache: Map<string, HistoryItem>
	taskFileMtimes: Map<string, number>
} {
	return {
		cache: store["cache"],
		taskFileMtimes: store["taskFileMtimes"],
	}
}

describe("TaskHistoryStore best-effort deletion semantics", () => {
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
		it("unlinks under the shared per-file lock, evicts cache and mtime, and writes through once", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "locked-delete" }))
			onWrite.mockClear()

			await expect(store.delete("locked-delete")).resolves.toBeUndefined()

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(
				historyFilePath(storagePath, "locked-delete"),
				expect.any(Function),
			)
			await expect(fs.access(historyFilePath(storagePath, "locked-delete"))).rejects.toMatchObject({
				code: "ENOENT",
			})

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("locked-delete")).toBe(false)
			expect(taskFileMtimes.has("locked-delete")).toBe(false)
			expect(store.get("locked-delete")).toBeUndefined()

			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).not.toContain("locked-delete")
		})

		it("swallows a lock acquisition failure, evicts cache and mtime, and still writes through once", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail" }))
			onWrite.mockClear()

			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			await expect(store.delete("lock-fail")).resolves.toBeUndefined()

			// The unlink never ran, but the in-memory eviction and the single
			// write-through still completed.
			await expect(fs.access(historyFilePath(storagePath, "lock-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-fail")).toBe(false)
			expect(taskFileMtimes.has("lock-fail")).toBe(false)
			expect(store.get("lock-fail")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("swallows a non-ENOENT unlink failure, evicts cache and mtime, and stays deletable afterwards", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "perm-fail" }))
			onWrite.mockClear()

			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" }),
			)

			await expect(store.delete("perm-fail")).resolves.toBeUndefined()

			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("perm-fail")).toBe(false)
			expect(taskFileMtimes.has("perm-fail")).toBe(false)
			expect(onWrite).toHaveBeenCalledTimes(1)

			// The per-file lock was released: a retry without the injected
			// failure deletes the file and writes through again.
			await expect(store.delete("perm-fail")).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(onWrite).toHaveBeenCalledTimes(2)
		})

		it("treats a missing file as a completed deletion", async () => {
			const store = createStore()
			await store.initialize()
			onWrite.mockClear()

			await expect(store.delete("never-existed")).resolves.toBeUndefined()
			expect(store.get("never-existed")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
		})
	})

	describe("deleteMany()", () => {
		it("continues the batch after a failed unlink, evicts every entry, and writes through exactly once", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "batch-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "batch-b", ts: 2000 }))
			await store.upsert(makeHistoryItem({ id: "batch-c", ts: 3000 }))
			onWrite.mockClear()

			vi.mocked(fs.unlink).mockImplementation(async (p) => {
				if (p === historyFilePath(storagePath, "batch-b")) {
					throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" })
				}
				return actualFs.unlink(p)
			})

			await expect(store.deleteMany(["batch-a", "batch-b", "batch-c"])).resolves.toBeUndefined()

			// batch-b failed but the batch continued around it.
			await expect(fs.access(historyFilePath(storagePath, "batch-a"))).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.access(historyFilePath(storagePath, "batch-b"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "batch-c"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("batch-a")).toBe(false)
			expect(cache.has("batch-b")).toBe(false)
			expect(cache.has("batch-c")).toBe(false)
			expect(taskFileMtimes.has("batch-a")).toBe(false)
			expect(taskFileMtimes.has("batch-b")).toBe(false)
			expect(taskFileMtimes.has("batch-c")).toBe(false)
			expect(store.get("batch-b")).toBeUndefined()

			// One write-through, after the whole batch, seeing the final cache.
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual([])
		})

		it("swallows a lock failure for one item and continues the batch with one write-through", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "lock-b", ts: 2000 }))
			onWrite.mockClear()

			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			await expect(store.deleteMany(["lock-a", "lock-b"])).resolves.toBeUndefined()

			// The first item's lock failed before its unlink; the second item
			// still completed.
			await expect(fs.access(historyFilePath(storagePath, "lock-a"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "lock-b"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-a")).toBe(false)
			expect(cache.has("lock-b")).toBe(false)
			expect(taskFileMtimes.has("lock-a")).toBe(false)
			expect(taskFileMtimes.has("lock-b")).toBe(false)

			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual([])
		})
	})
})
