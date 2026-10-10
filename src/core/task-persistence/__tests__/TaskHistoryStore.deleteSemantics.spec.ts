// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryStore.deleteSemantics.spec.ts
//
// Best-effort deletion semantics for `delete()` and `deleteMany()`.
// Lock, unlink, and fs behavior stay real by default; individual tests force
// one lock or unlink failure through the wrappers below.

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryDeleteError, TaskHistoryStore } from "../TaskHistoryStore"
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

// The lock key is canonicalized through the parent directory, so the expected key is
// the canonical directory plus the basename rather than the path built from
// os.tmpdir(), which can be an 8.3 short path on the Windows runner.
async function canonicalKey(filePath: string): Promise<string> {
	return path.join(await actualFs.realpath(path.dirname(filePath)), path.basename(filePath))
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
		vi.mocked(withFileLock).mockClear()
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

			// The lock key is the resolved publish target, so the expected key is
			// captured through realpath before the delete: on Windows os.tmpdir()
			// can be an 8.3 short path (C:\Users\RUNNER~1) that realpath expands
			// to the long form, and the file is gone after the unlink.
			const lockKey = await fs.realpath(historyFilePath(storagePath, "locked-delete"))

			await expect(store.delete("locked-delete")).resolves.toBeUndefined()

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(lockKey, expect.any(Function))
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

		it("keeps the item and reports a lock acquisition failure instead of evicting it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-fail" }))
			onWrite.mockClear()

			// Snapshot what the store holds before the failing deletion so the test can
			// assert that nothing was evicted.
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("lock-fail")
			const hadMtime = internals.taskFileMtimes.has("lock-fail")
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			await expect(store.delete("lock-fail")).rejects.toThrow(TaskHistoryDeleteError)

			// The unlink never ran, so nothing was evicted and nothing was written through: the
			// store still matches the file on disk instead of reporting a deletion that
			// reconciliation would undo.
			await expect(fs.access(historyFilePath(storagePath, "lock-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-fail")).toBe(hadCache)
			expect(taskFileMtimes.has("lock-fail")).toBe(hadMtime)
			expect(store.get("lock-fail")).toBeDefined()
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("keeps the item and reports a non-ENOENT unlink failure, and a retry then deletes it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "perm-fail" }))
			onWrite.mockClear()

			// Snapshot what the store holds before the failing deletion so the test can
			// assert that nothing was evicted.
			const internals = storeInternals(store)
			const hadCache = internals.cache.has("perm-fail")
			const hadMtime = internals.taskFileMtimes.has("perm-fail")
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" }),
			)

			await expect(store.delete("perm-fail")).rejects.toThrow(TaskHistoryDeleteError)

			// The file survived, so the item survived with it: no eviction, no write-through.
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).resolves.toBeUndefined()
			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("perm-fail")).toBe(hadCache)
			expect(taskFileMtimes.has("perm-fail")).toBe(hadMtime)
			expect(onWrite).not.toHaveBeenCalled()

			// The per-file lock was released: a retry without the injected failure deletes the
			// file, evicts, and writes through once.
			await expect(store.delete("perm-fail")).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "perm-fail"))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(cache.has("perm-fail")).toBe(false)
			expect(taskFileMtimes.has("perm-fail")).toBe(false)
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("treats a missing file as a completed deletion", async () => {
			const store = createStore()
			await store.initialize()
			onWrite.mockClear()

			await expect(store.delete("never-existed")).resolves.toBeUndefined()
			expect(store.get("never-existed")).toBeUndefined()
			expect(onWrite).toHaveBeenCalledTimes(1)
		})

		it("locks the resolved publish target while unlinking the path it was given", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-del" }))
			const aliasPath = historyFilePath(storagePath, "alias-del")
			const referentPath = path.join(storagePath, "tasks", "alias-del", "referent-history.json")

			// Real symlinks are unavailable in this CI lane, so the alias is
			// simulated through realpath, as in the safeWriteJson lock test.
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				await expect(store.delete("alias-del")).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
			}

			// One lock for the underlying file, keyed by the referent; the unlink
			// still targets the path the store named.
			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			// Assert the unlink target itself: locking the referent while unlinking the
			// referent instead of the alias would keep the dangling link in place.
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
			expect(vi.mocked(fs.unlink)).not.toHaveBeenCalledWith(referentPath)
		})

		it("waits on the peer's lock at the referent when the link is dangling", async () => {
			// delete() must resolve the chain itself: resolvePublishTarget refuses a
			// dangling link, and the old code treated that rejection as "already deleted"
			// so the link was never removed.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-dangling" }))
			const aliasPath = historyFilePath(storagePath, "alias-dangling")
			const referentPath = path.join(storagePath, "tasks", "alias-dangling", "referent-history.json")
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
				if (target === aliasPath) throw enoent
				return actualFs.realpath(String(target))
			})
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await expect(store.delete("alias-dangling")).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
		})

		it("keeps the item when the lock key cannot be resolved, instead of calling it deleted", async () => {
			// The canonicalization inside resolveLockKey fails, so no lock key exists and no lock is
			// ever attempted. Whatever the errno says, this call has not touched the file, and the
			// item must stay in the store with a reason that names the stage that failed.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-unresolvable" }))
			const aliasPath = historyFilePath(storagePath, "alias-unresolvable")
			const dirPath = path.dirname(aliasPath)
			// The unlink, lock and write-through mocks are shared across cases, and the upsert
			// above wrote through once, so clear them to make the assertions below about this delete.
			vi.mocked(fs.unlink).mockClear()
			vi.mocked(withFileLock).mockClear()
			onWrite.mockClear()
			// Not ENOENT: canonicalDirKey walks up to the nearest existing ancestor for a
			// missing directory, so "not there" is a key it can still compute. Any other failure says
			// nothing about the canonical form and is propagated, which is the resolution failure this
			// path has to report rather than read as a deletion.
			const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" })
			const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
				const targetPath = String(target)
				if (targetPath === aliasPath || targetPath === dirPath) throw eacces
				return actualFs.realpath(targetPath)
			})
			let rejection: unknown
			try {
				await store.delete("alias-unresolvable")
			} catch (error: unknown) {
				rejection = error
			} finally {
				realpathSpy.mockRestore()
			}

			expect(rejection).toBeInstanceOf(TaskHistoryDeleteError)
			// No lock key, so no lock and no unlink: nothing this call did can account for the file
			// being gone, and the reported reason has to say which stage failed.
			expect(vi.mocked(withFileLock)).not.toHaveBeenCalled()
			expect(fs.unlink).not.toHaveBeenCalled()
			expect((rejection as TaskHistoryDeleteError).reason).toContain("lock key could not be resolved")
			// The entry and its write-through state stay put: a later reconcile still sees the file.
			expect(storeInternals(store).cache.has("alias-unresolvable")).toBe(true)
			expect(onWrite).not.toHaveBeenCalled()
			expect((rejection as TaskHistoryDeleteError).taskIds).toEqual(["alias-unresolvable"])
		})

		it("does not treat an ENOENT from lock acquisition as a completed deletion", async () => {
			// proper-lockfile creates <key>.lock with mkdir and reports ENOENT when the directory
			// that would hold it is missing. That is a failure to take the lock, not a report about
			// the task file, so the named file has to be asked directly before anything is evicted.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-enoent" }))
			vi.mocked(fs.unlink).mockClear()
			onWrite.mockClear()
			// Once, not for good: mockClear() does not reset implementations, and this test only needs
			// the next lock attempt to fail - a mock still rejecting would decide later tests for us.
			vi.mocked(withFileLock).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

			await expect(store.delete("lock-enoent")).rejects.toThrow(TaskHistoryDeleteError)

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(storeInternals(store).cache.has("lock-enoent")).toBe(true)
			expect(onWrite).not.toHaveBeenCalled()
		})
	})

	describe("reconcile()", () => {
		it("keeps a cached task live when its file is absent but the lock is held at the resolved referent", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-live" }))
			const aliasPath = historyFilePath(storagePath, "alias-live")
			const referentPath = path.join(storagePath, "tasks", "alias-live", "referent-history.json")

			// Real symlinks are unavailable in this CI lane, so the alias is
			// simulated through realpath, as in the safeWriteJson lock test.
			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				// The rename window: the referent is momentarily missing, so the cached
				// file cannot be stat'd while the peer holds the lock at the key it locks.
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
			}

			// The probe must look at the same key the writer locks, otherwise a live
			// task is evicted from the cache while its write is still in progress.
			expect(storeInternals(store).cache.has("alias-live")).toBe(true)
		})

		it("keeps a cached task live when the alias is dangling during the rename window", async () => {
			// resolvePublishTarget refuses a dangling link because a writer must not publish
			// through the link path, but this probe runs exactly in that window, so it reads
			// the link one level itself to find the lock the writer holds at the referent.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "dangling-live" }))
			const aliasPath = historyFilePath(storagePath, "dangling-live")
			const referentPath = path.join(storagePath, "tasks", "dangling-live", "referent-history.json")

			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			// A relative link target, so the probe must resolve it against the link's
			// directory rather than the process working directory.
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("dangling-live")).toBe(true)
		})

		it("follows the whole link chain to the key the writer locked", async () => {
			// realpath resolves the whole chain, so it fails when the final referent is
			// momentarily renamed to its backup. The probe must walk the chain, not just
			// its first link, or it looks for a lock the writer never took.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "chain-live" }))
			const aliasPath = historyFilePath(storagePath, "chain-live")
			const dir = path.dirname(aliasPath)
			const referentPath = path.join(dir, "referent-history.json")
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aliasPath) return "nested-link.json"
				if (p === path.join(dir, "nested-link.json")) return "referent-history.json"
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aliasPath, { force: true })
				await actualFs.writeFile(referentPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("chain-live")).toBe(true)
		})

		it("probes the key the bounded walk actually reached on a long chain", async () => {
			// A chain longer than the hop limit: the walk stops at the limit, so the probe
			// must look at the key it reached, not at the far end of the chain.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "long-chain" }))
			const startPath = historyFilePath(storagePath, "long-chain")
			const dir = path.dirname(startPath)
			const hops = Array.from({ length: 9 }, (_, index) => path.join(dir, "h" + (index + 1) + ".json"))
			const reachedPath = hops[7]
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				const index = [startPath, ...hops].indexOf(String(p))
				if (index === -1 || index === hops.length) throw new Error("not a symbolic link")
				return hops[index]
			})
			try {
				await actualFs.rm(startPath, { force: true })
				await actualFs.writeFile(reachedPath + ".lock", "")
				await store.reconcile()
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			expect(storeInternals(store).cache.has("long-chain")).toBe(true)
		})

		it("terminates on a link cycle instead of holding the store lock forever", async () => {
			// Two links that point at each other: every readlink succeeds, so an unbounded
			// walk would never release the store lock.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "cycle-live" }))
			const aPath = historyFilePath(storagePath, "cycle-live")
			const bPath = path.join(path.dirname(aPath), "b.json")
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			const lstatSpy = vi
				.spyOn(fs, "lstat")
				.mockResolvedValue({ isSymbolicLink: () => true } as unknown as import("fs").Stats)
			const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation(async (p) => {
				if (p === aPath) return "b.json"
				// Point back to the real alias basename so the walk actually loops; returning
				// a name that is not the alias stops the walk after two hops and never reaches
				// the hop limit this test is about.
				if (p === bPath) return path.basename(aPath)
				throw new Error("not a symbolic link")
			})
			try {
				await actualFs.rm(aPath, { force: true })
				await store.reconcile()
				// Assert inside the try: mockRestore() clears the call counts, so checking after
				// the finally block would read zero. Eight hops means the walk looped on the
				// cycle instead of stopping at the first non-link.
				expect(readlinkSpy).toHaveBeenCalledTimes(8)
			} finally {
				realpathSpy.mockRestore()
				lstatSpy.mockRestore()
				readlinkSpy.mockRestore()
			}

			// The walk is bounded, so reconcile returned; the probe looked at the key it
			// reached after the bounded hops, found no lock there, and evicted the task.
			expect(storeInternals(store).cache.has("cycle-live")).toBe(false)
		})
	})

	describe("deleteMany()", () => {
		it("keeps the failed item, continues the batch, and reports the failure after one write-through", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "batch-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "batch-b", ts: 2000 }))
			await store.upsert(makeHistoryItem({ id: "batch-c", ts: 3000 }))
			onWrite.mockClear()

			const internalsBefore = storeInternals(store)
			const hadCache = internalsBefore.cache.has("batch-b")
			const hadMtime = internalsBefore.taskFileMtimes.has("batch-b")
			vi.mocked(fs.unlink).mockImplementation(async (p) => {
				if (p === historyFilePath(storagePath, "batch-b")) {
					throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" })
				}
				return actualFs.unlink(p)
			})

			const failure = await store
				.deleteMany(["batch-a", "batch-b", "batch-c"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["batch-b"])

			// batch-b failed but the batch continued around it.
			await expect(fs.access(historyFilePath(storagePath, "batch-a"))).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.access(historyFilePath(storagePath, "batch-b"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "batch-c"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("batch-a")).toBe(false)
			expect(cache.has("batch-b")).toBe(hadCache)
			expect(cache.has("batch-c")).toBe(false)
			expect(taskFileMtimes.has("batch-a")).toBe(false)
			expect(taskFileMtimes.has("batch-b")).toBe(hadMtime)
			expect(taskFileMtimes.has("batch-c")).toBe(false)
			expect(store.get("batch-b")).toBeDefined()

			// One write-through, after the whole batch, still carrying the item that survived.
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual(["batch-b"])
		})

		it("keeps the item whose lock failed, finishes the batch, and reports it", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "lock-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "lock-b", ts: 2000 }))
			onWrite.mockClear()

			const internalsBefore = storeInternals(store)
			const hadCache = internalsBefore.cache.has("lock-a")
			const hadMtime = internalsBefore.taskFileMtimes.has("lock-a")
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))

			const failure = await store
				.deleteMany(["lock-a", "lock-b"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["lock-a"])

			// The first item’s lock failed before its unlink; the second item still completed.
			await expect(fs.access(historyFilePath(storagePath, "lock-a"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "lock-b"))).rejects.toMatchObject({ code: "ENOENT" })

			const { cache, taskFileMtimes } = storeInternals(store)
			expect(cache.has("lock-a")).toBe(hadCache)
			expect(cache.has("lock-b")).toBe(false)
			expect(taskFileMtimes.has("lock-a")).toBe(hadMtime)
			expect(taskFileMtimes.has("lock-b")).toBe(false)

			// The write-through reflects what actually happened: lock-b gone, lock-a kept.
			expect(onWrite).toHaveBeenCalledTimes(1)
			const writtenIds = (onWrite.mock.calls[0][0] as HistoryItem[]).map((item) => item.id)
			expect(writtenIds).toEqual(["lock-a"])
		})

		it("reports every id, keeps every entry and file, and skips the write-through when the whole batch failed", async () => {
			// deletedAny stays false when nothing was removed: the store must not write a state
			// it did not change, and every requested id has to be reported - a partial report
			// would let the caller forget ids that are still on disk.
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "all-a", ts: 1000 }))
			await store.upsert(makeHistoryItem({ id: "all-b", ts: 2000 }))
			onWrite.mockClear()

			storeInternals(store).taskFileMtimes.set("all-a", 1000)
			storeInternals(store).taskFileMtimes.set("all-b", 2000)
			// One id fails at the lock, the other at the unlink: both outcomes count as
			// "not deleted", and neither may be treated as gone.
			vi.mocked(withFileLock).mockRejectedValueOnce(new Error("lock acquisition timed out"))
			vi.mocked(fs.unlink).mockRejectedValueOnce(
				Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }),
			)

			const failure = await store
				.deleteMany(["all-a", "all-b"])
				.then(() => null)
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(TaskHistoryDeleteError)
			expect((failure as TaskHistoryDeleteError).taskIds).toEqual(["all-a", "all-b"])

			const { cache, taskFileMtimes } = storeInternals(store)
			// storeInternals returns the live maps, so comparing them against 'before' compared
			// a map with itself and passed no matter what deleteMany did. A failed delete must
			// leave both ids in both maps, so assert that directly.
			// The cache is the store's own view: a failed delete must leave both ids in it.
			expect(cache.has("all-a")).toBe(true)
			expect(cache.has("all-b")).toBe(true)
			// taskFileMtimes is only populated by the reconcile path (external-change
			// detection), so a store that never reconciled has an empty map here - asserting
			// presence without seeding it would assert something that was never true. That is what
			// the two set() calls above the delete are for: they seed the map through the same
			// internals the store uses. What is asserted here is only that a failed delete left
			// that seeding alone.
			expect(taskFileMtimes.has("all-a")).toBe(true)
			expect(taskFileMtimes.has("all-b")).toBe(true)
			await expect(fs.access(historyFilePath(storagePath, "all-a"))).resolves.toBeUndefined()
			await expect(fs.access(historyFilePath(storagePath, "all-b"))).resolves.toBeUndefined()

			// Nothing was deleted, so nothing was written through.
			expect(onWrite).not.toHaveBeenCalled()
		})

		it("locks the resolved publish target for every item while unlinking the given paths", async () => {
			const store = createStore()
			await store.initialize()
			await store.upsert(makeHistoryItem({ id: "alias-batch", ts: 1000 }))
			const aliasPath = historyFilePath(storagePath, "alias-batch")
			const referentPath = path.join(storagePath, "tasks", "alias-batch", "referent-history.json")

			// Only the file resolves through the alias; the directory is canonicalized by the
			// the real fs exactly as in production, so the key matches the canonical directory
			const realpathSpy = vi
				.spyOn(fs, "realpath")
				.mockImplementation(async (target) =>
					target === aliasPath ? referentPath : actualFs.realpath(String(target)),
				)
			try {
				await expect(store.deleteMany(["alias-batch"])).resolves.toBeUndefined()
			} finally {
				realpathSpy.mockRestore()
			}

			expect(vi.mocked(withFileLock)).toHaveBeenCalledWith(await canonicalKey(referentPath), expect.any(Function))
			expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(aliasPath)
		})
	})
})
