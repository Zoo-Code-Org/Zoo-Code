// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import { execFile } from "child_process"

import * as os from "os"
import path from "path"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"

// The Windows DACL helpers shell out to icacls, which cannot run under a sandboxed test host:
// every write would fail the restore check and roll back. Stub that one boundary, the same way
// safeWriteText.spec.ts does. The DACL semantics are asserted there, where the runner is the
// subject under test; here it only has to not explode.
vi.mock("child_process", () => ({
	execFile: vi.fn((cmd, args, opts, cb) => {
		if (typeof cb === "function") cb(null)
	}),
}))

vi.mock("../fileLock", () => ({
	acquireFileLock: vi.fn(async () => async () => {}),
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, realpath: vi.fn(), lstat: vi.fn(), readlink: vi.fn() }
})

const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedAcquireFileLock = vi.mocked(acquireFileLock)

const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })

// Each test creates a real temp directory so the real fs calls still work.
// doubles between tests so an implementation from one test cannot carry over.
const createdDirs: string[] = []
async function makeDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	createdDirs.push(dir)
	return dir
}

beforeEach(() => {
	mockedRealpath.mockReset()
	mockedLstat.mockReset()
	mockedReadlink.mockReset()
	mockedAcquireFileLock.mockReset()
})

afterEach(async () => {
	for (const dir of createdDirs) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
	}
	createdDirs.length = 0
})

// Only isSymbolicLink() is consulted by the guard, so the double carries just
// that method. The mocks reject asynchronously: a synchronous throw would bypass
// resolvePublishTarget's catch and skip the ENOENT/symlink branch under test.
const symlinkStat = (target: unknown) =>
	({
		isSymbolicLink: () => target === currentLink,
		// The staging-path check in safeWriteText also asks whether the path is a
		// regular file, so the double carries that predicate as well.
		isFile: () => target !== currentLink,
	}) as unknown as BigIntStats
let currentLink = ""

describe("safeWriteJson lock key under a peer commit", () => {
	it("waits for the peer instead of rejecting, and locks the referent", async () => {
		const order: string[] = []
		const dir = await makeDir("lockkey-")
		const referent = path.join(dir, "history_item.json")
		currentLink = path.join(dir, "link.json")

		// The peer writer has renamed the referent away and has not committed yet,
		// so the first resolution fails with ENOENT while lstat still reports a
		// symbolic link. A strict resolve here rejects the caller before it can ever
		// queue behind the peer, and the caller's delta write is lost.
		mockedRealpath
			.mockImplementationOnce(async () => {
				order.push("resolve-failed")
				throw enoent
			})
			.mockImplementation(async (target) => {
				order.push("resolve")
				// The second call happens under the lock, where the peer has committed.
				return target === currentLink ? referent : String(target)
			})
		mockedLstat.mockImplementation(async (target) => {
			order.push("lstat")
			return symlinkStat(target)
		})
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		// A confined writer is the one that publishes through the referent, and therefore the one that
		// locks it; an unscoped write replaces the link and locks the link path instead.
		await safeWriteJson(currentLink, { id: "task-1" }, { confineTo: dir })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// Exactly one lock: a confined caller publishes through the referent, so the referent lock is
		// the one that serializes it, and a second lock would name an identity it does not replace.
		expect(mockedAcquireFileLock).toHaveBeenCalledTimes(1)
		// The two trailing lstat calls are safeWriteText's staging-path checks: the
		// regular-file check on the temp file this write created, and the identity check
		// that the staging path is not the target. Both run after the key was resolved
		// and the lock was taken, so neither changes which lock the caller queued behind.
		// A write that declares no confinement scope no longer resolves the publish target at all,
		// so the two post-lock resolutions this used to record are gone; the lock key still comes
		// from the referent, which is what the test is about.
		expect(order.slice(0, 2)).toEqual(["resolve-failed", "lstat"])
		const lockAt = order.indexOf("lock")
		expect(order.slice(0, lockAt)).toContain("resolve")
		// A confined writer resolves its scope root on both sides of the lock, so how many times
		// the resolution ran is not what this test is about: the caller queued behind the peer on
		// the referent's lock, and safeWriteText's two staging checks still come last.
		expect(order.slice(lockAt).filter((entry) => entry === "lstat")).toHaveLength(2)
		expect(order[order.length - 1]).toBe("lstat")
		// A confined writer publishes through the referent, which is the file it locked: the bytes
		// land on the referent and the link keeps pointing at them.
		expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ id: "task-1" })
	})

	it("releases the lock when the resolution under the lock rejects", async () => {
		const order: string[] = []
		let released = false
		const dir = await makeDir("lockkey-")
		const referent = path.join(dir, "history_item.json")
		currentLink = path.join(dir, "link.json")

		// A real dangling link: the walk tolerates it so the caller can queue behind
		// the peer, but once the lock is held the strict rejection still applies. A
		// rejection outside the protected block would leave the lock held until the
		// stale timeout for every other writer to the same file.
		mockedRealpath.mockImplementation(async () => {
			throw enoent
		})
		mockedLstat.mockImplementation(async (target) => {
			order.push("lstat")
			return symlinkStat(target)
		})
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {
				order.push("release")
				released = true
			}
		})

		// The in-lock resolution only happens for a caller that declared a scope, so the scope is
		// declared here: what this test pins is that a rejection inside the protected block still
		// releases the lock, and that path is reached through the confined resolution.
		await expect(safeWriteJson(currentLink, { id: "task-1" }, { confineTo: dir })).rejects.toThrow(enoent)
		expect(released).toBe(true)
		// The strict rejection is reached through the ENOENT + symlink branch, not
		// through a synchronous throw that skips it.
		expect(order).toEqual(["lstat", "lock", "lstat", "release"])
	})

	it("canonicalizes the parent directory when the file itself is not there yet", async () => {
		// fs.realpath canonicalizes every component, including a symlinked ancestor
		// directory or a Windows 8.3 short name. If the fallback returns the alias
		// directory, the key depends on whether the file exists at the moment the key
		// is computed, and a writer that resolved the canonical directory takes a
		// different lock for the same file.
		const aliasDir = path.join(os.tmpdir(), "alias-dir")
		const canonicalDir = path.join(os.tmpdir(), "canonical-dir")
		const file = path.join(aliasDir, "history_item.json")
		mockedRealpath.mockImplementation(async (target) => {
			if (target === file) throw enoent
			return canonicalDir
		})
		mockedLstat.mockImplementation(
			async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
		)

		expect(await resolveLockKey(file)).toBe(path.join(canonicalDir, "history_item.json"))
	})
})

it("does not log a cleanup error when the safety net finds the temp file already gone", async () => {
	// safeWriteText removes its own temp file on failure, so the safety net in
	// safeWriteJson normally finds it gone. That is the expected outcome, not a
	// second failure, and it must not be logged as one.
	const dir = await makeDir("cleanup-")
	const target = path.join(dir, "history_item.json")
	currentLink = ""
	mockedRealpath.mockImplementation(async (t) => String(t))
	mockedLstat.mockImplementation(async (t) => symlinkStat(t))

	const renameSpy = vi.spyOn(fs, "rename").mockRejectedValue(new Error("commit rename failed"))
	const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(enoent)
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

	await expect(safeWriteJson(target, { id: "task-1" })).rejects.toThrow("commit rename failed")

	// The safety net really ran, and ran on the staged .new_ file it was supposed to remove.
	// The safety net really ran, and ran on the staged .new_ file it was supposed to remove.
	// Two unlinks of that path are expected: safeWriteText cleans up the tempPath it was
	// handed, and then safeWriteJson runs its own safety net on the same path. Dropping the
	// net would leave one, which is exactly what this checks.
	const stagedUnlinks = unlinkSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(".new_"))
	expect(stagedUnlinks).toHaveLength(2)
	// Only the original failure is reported.
	expect(consoleError).toHaveBeenCalledTimes(1)

	renameSpy.mockRestore()
	unlinkSpy.mockRestore()
	consoleError.mockRestore()
})
it("locks the link path and the referent when the caller declared no confinement scope", async () => {
	// The lock key must name the file this write replaces. An unscoped write publishes over the
	// link, so locking the referent alone would let it run beside another writer that locked the
	// link - two locks for one publish target, and the lost update the lock exists to prevent.
	// The referent lock is kept alongside it rather than replaced: while the link exists, that is
	// the lock serializing this alias against a writer that names the referent directly.
	const dir = await makeDir("lockkey-unscoped-")
	const link = path.join(dir, "link.json")
	const referent = path.join(dir, "history_item.json")
	currentLink = link
	// The doubles say the path is a link to a referent, so a key that resolved the referent is
	// distinguishable from the link path itself.
	mockedRealpath.mockImplementation(async (target) => (target === link ? referent : String(target)))
	mockedReadlink.mockImplementation(async (target) =>
		target === link ? referent : Promise.reject(new Error("not a link")),
	)
	mockedLstat.mockImplementation(async (target) => symlinkStat(target))
	const acquired: string[] = []
	mockedAcquireFileLock.mockImplementation(async (key) => {
		acquired.push(String(key))
		return async () => {}
	})

	await safeWriteJson(link, { id: "task-2" })

	expect(acquired).toEqual([referent, link].sort())
})

it("does not merge from a symlink an unscoped write is not going to publish through", async () => {
	// The merge reads the path the caller named. When that path is a link and the write declares
	// no confinement scope, the publish replaces the link, so reading through the link would copy
	// JSON from outside the requested path into the replacement file.
	const dir = await makeDir("merge-link-")
	const link = path.join(dir, "link.json")
	currentLink = link
	// A real document sits at the path, and the doubles report it as a symlink: reading through
	// the link would hand the merge that document, which is what this forbids.
	await fs.writeFile(link, JSON.stringify({ had: "referent content" }), "utf8")
	mockedRealpath.mockImplementation(async (target) => String(target))
	mockedLstat.mockImplementation(async (target) =>
		target === link
			? ({ isSymbolicLink: () => true, isFile: () => false } as unknown as BigIntStats)
			: symlinkStat(target),
	)
	mockedAcquireFileLock.mockImplementation(async () => async () => {})
	const merge = vi.fn((existing: unknown, next: unknown) => ({ had: existing !== null, next }))

	await safeWriteJson(link, { id: "task-3" }, { merge })

	expect(merge).toHaveBeenCalledWith(null, { id: "task-3" })
})
it("serializes a writer that names the referent directly while the link still exists", async () => {
	// The finding this covers, quoted: "Do not replace the referent lock with only the link-path
	// lock, because the existing contract serializes symlink aliases with direct referent writers
	// while the link exists." An unscoped write replaces the link, so the link-path lock is the one
	// that names the inode it replaces - but a writer that opens the referent by name takes the
	// referent lock, and with only the link-path lock held the two writes overlap and their merge
	// reads overwrite each other.
	const dir = await makeDir("lockkey-referent-")
	const link = path.join(dir, "link.json")
	const referent = path.join(dir, "history_item.json")
	currentLink = link
	await fs.writeFile(referent, JSON.stringify({ had: "referent content" }), "utf8")
	// The link itself has to exist for real: the DACL capture only runs over an existing target, and
	// asserting the stub was called is what proves stubbing icacls did not skip the capture.
	await fs.writeFile(link, JSON.stringify({ had: "link content" }), "utf8")

	const acquired: string[] = []
	const released: string[] = []
	mockedRealpath.mockImplementation(async (target) => (target === link ? referent : String(target)))
	mockedReadlink.mockImplementation(async (target) =>
		target === link ? referent : Promise.reject(new Error("not a link")),
	)
	mockedLstat.mockImplementation(async (target) => symlinkStat(target))
	mockedAcquireFileLock.mockImplementation(async (key) => {
		acquired.push(String(key))
		return async () => {
			released.push(String(key))
		}
	})

	await safeWriteJson(link, { id: "task-4" })

	// Both identities, in sorted key order, so two writers approaching the pair from opposite sides
	// cannot each hold one and wait for the other; both released, in reverse.
	expect(acquired).toEqual([referent, link].sort())
	expect(released).toEqual([...acquired].reverse())

	// The DACL boundary is still exercised on the file this write replaces: stubbing icacls to keep
	// the sandboxed host from failing the restore must not skip the capture/restore calls themselves.
	expect(execFile).toHaveBeenCalledWith(
		"icacls",
		expect.arrayContaining([link, "/save"]),
		expect.anything(),
		expect.any(Function),
	)

	// Taking the extra lock must not move the publish target: the bytes land on the link, and the
	// referent keeps the content its own writer put there.
	expect(JSON.parse(await fs.readFile(link, "utf8"))).toEqual({ id: "task-4" })
	expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ had: "referent content" })
})
