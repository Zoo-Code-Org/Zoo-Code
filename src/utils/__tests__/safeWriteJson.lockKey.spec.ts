// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import * as os from "os"
import path from "path"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"

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

// A real readlink answers with a code. ENOENT is the answer for a path that is not there -
// which is the state both peer-commit rows below describe, because the peer writer has renamed
// the referent away - and EINVAL is the answer for a path that exists and is not a link
// (measured with node 22.23.4 on win32). resolveLockKey ends its walk on either, and propagates
// anything else: a rejection that names no code says nothing about whether the path is a link,
// and keying the writer to the alias on that answer is how two writers end up holding two locks
// for one file.

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
			target === currentLink ? referent : Promise.reject(enoent),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// The trailing lstat calls are safeWriteText's staging-path checks (the regular-file
		// check on the temp file and the identity check that staging is not the target), and
		// the final resolve re-checks the commit target immediately before the rename. All run
		// after the key was resolved and the lock was taken, so they do not change the lock.
		expect(order).toEqual([
			"resolve-failed",
			"lstat",
			"resolve",
			"resolve",
			"lock",
			"resolve",
			"resolve",
			"lstat",
			"lstat",
			"resolve",
		])
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
			target === currentLink ? referent : Promise.reject(enoent),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {
				order.push("release")
				released = true
			}
		})

		await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toThrow(enoent)
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

	it("propagates a non-ENOENT resolution failure instead of keying on the alias", async () => {
		// EACCES from realpath is not a dangling link: falling back to the walk
		// would key this writer to the alias path while a writer reaching the
		// referent directly keys the referent, and the two writers would take
		// different locks for the same file.
		const aliasDir = path.join(os.tmpdir(), "alias-dir")
		const file = path.join(aliasDir, "history_item.json")
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		mockedRealpath.mockImplementation(async () => {
			throw eacces
		})
		await expect(resolveLockKey(file)).rejects.toBe(eacces)
	})

	it("propagates a parent-directory error instead of joining the referent onto the spelled parent", async () => {
		// The link's parent is itself a directory link and its realpath answers EACCES while the referent
		// is relative and dangling. Joining the referent onto the spelled parent names dir/aliasdir/other
		// - a key no writer that reached the referent uses - and those two writers then hold two locks for
		// one file. Only ENOENT, the chain simply not being there, may fall back to that join.
		const dir = await makeDir("lockkey-")
		const spelledParent = path.join(dir, "aliasdir", "notes")
		const link = path.join(spelledParent, "link.json")
		currentLink = link
		const referent = "../other/x.json"
		const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (p === link) {
				throw enoent // peer mid-commit: the referent is renamed away from this name
			}
			if (p === spelledParent) {
				throw eacces // this directory link cannot be canonicalized right now
			}
			return p
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			String(target) === link ? referent : Promise.reject(enoent),
		)

		await expect(resolveLockKey(link)).rejects.toBe(eacces)
	})

	it("keys the file a chain lands on exactly at its bound", async () => {
		// A peer that pulls the referent away mid-EPERM-fallback can leave this writer walking a chain
		// it only finishes at the bound. Eight links land on the file, and the bound has to name that
		// file - not whichever link the walk happened to stop on - or the write fails where waiting for
		// the peer would have committed.
		const dir = await makeDir("lockkey-")
		const spelling = (n: number) => path.join(dir, "l" + n + ".json")
		currentLink = spelling(0)
		const hops = new Map<string, string>()
		for (let n = 0; n < 8; n++) {
			hops.set(spelling(n), spelling(n + 1))
		}
		const einval = Object.assign(new Error("EINVAL: invalid argument"), { code: "EINVAL" })
		mockedRealpath.mockImplementation(async (target) =>
			String(target) === currentLink ? Promise.reject(enoent) : String(target),
		)
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) => {
			const hop = hops.get(String(target))
			// l8 is a regular file: a real readlink answers EINVAL for it (measured with node 22.23.4
			// on win32), which is the answer that ends the walk.
			return hop === undefined ? Promise.reject(einval) : hop
		})

		expect(await resolveLockKey(spelling(0))).toBe(spelling(8))
	})

	it("rejects a chain that runs past its bound instead of naming whichever link it stopped on", async () => {
		// The other side of the same bound: nine links name no file this writer can lock, and the
		// caller has to be told rather than handed l8, which two writers entering the chain from
		// opposite ends would not both name.
		const dir = await makeDir("lockkey-")
		const spelling = (n: number) => path.join(dir, "l" + n + ".json")
		currentLink = spelling(0)
		const hops = new Map<string, string>()
		for (let n = 0; n < 9; n++) {
			hops.set(spelling(n), spelling(n + 1))
		}
		mockedRealpath.mockImplementation(async (target) =>
			String(target) === currentLink ? Promise.reject(enoent) : String(target),
		)
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) => {
			const hop = hops.get(String(target))
			return hop === undefined ? Promise.reject(new Error("readlink answered no code")) : hop
		})

		await expect(resolveLockKey(spelling(0))).rejects.toThrow(/deeper than 8 links/)
	})

	it("keys a relative referent through the link's real parent, not the spelled one", async () => {
		// The link lives under a directory that is itself a link and its referent is relative.
		// `..` names the referent's parent, so joining the referent onto the spelling the caller
		// arrived with keys dir/aliasdir/other - a different file from the one a writer that
		// reached the referent through dir/realdir/elsewhere keys, and those two writers then
		// hold two locks for one file.
		const dir = await makeDir("lockkey-")
		const spelledParent = path.join(dir, "aliasdir", "notes")
		const realParent = path.join(dir, "realdir", "elsewhere")
		const link = path.join(spelledParent, "link.json")
		currentLink = link
		const referent = "../other/x.json"
		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (p === link) {
				throw enoent // peer mid-commit: the referent is renamed away from this name
			}
			if (p === spelledParent) {
				return realParent // "notes" is itself a directory link
			}
			return p
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			String(target) === link ? referent : Promise.reject(enoent),
		)

		const key = await resolveLockKey(link)
		expect(key).toBe(path.join(dir, "realdir", "other", "x.json"))
	})

	it("refuses a lock key when an ancestor exists but cannot be canonicalized", async () => {
		// ENOTDIR is what fs.realpath answers when a component of the path is a regular file:
		// the ancestor was inspected and it says this spelling is not the canonical one. A
		// swallowed realpath failure handed back the literal path, which is a key no other
		// writer uses for this file.
		const dir = await makeDir("lockkey-")
		const link = path.join(dir, "aliasdir", "link.json")
		currentLink = link
		const referent = path.join(dir, "package", "sub", "x.json")
		const enotdir = Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" })
		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (p === link) {
				throw enoent
			}
			if (p === path.join(dir, "package", "sub")) {
				throw enotdir // "package" is a file, so this chain is not a directory
			}
			return p
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			String(target) === link ? referent : Promise.reject(enoent),
		)

		await expect(resolveLockKey(link)).rejects.toBe(enotdir)
	})

	it("keys the same file the same way before and after its parent directory appears", async () => {
		// A missing parent directory is walked over and re-joined onto the nearest ancestor that
		// exists, because the writer that arrives before the mkdir has to take the lock of the
		// writer that arrives after it. Under a directory link the literal spelling is not that
		// key. The two calls below are the two moments a real mkdir separates.
		const realDir = await makeDir("lockkey-")
		const aliasDir = path.join(realDir, "alias")
		const missingDir = path.join(aliasDir, "state")
		const file = path.join(missingDir, "history_item.json")
		currentLink = ""
		const canonicalParent = path.join(realDir, "referent-of-alias")
		mockedLstat.mockImplementation(
			async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
		)

		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (p === file || p === missingDir) {
				throw enoent // neither the file nor its parent directory is there yet
			}
			if (p === aliasDir) {
				return canonicalParent // "alias" is a directory link
			}
			return p
		})
		const beforeCreation = await resolveLockKey(file)

		// The directory exists by now, which is the only difference the later writer sees.
		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (p === file) {
				throw enoent
			}
			if (p === missingDir) {
				return path.join(canonicalParent, "state")
			}
			if (p === aliasDir) {
				return canonicalParent
			}
			return p
		})
		const afterCreation = await resolveLockKey(file)

		expect(beforeCreation).toBe(path.join(canonicalParent, "state", "history_item.json"))
		expect(afterCreation).toBe(beforeCreation)
	})
})

it("keeps a readlink failure that names no code from keying the writer to the alias", async () => {
	// The peer-commit rows above answer with the code a real readlink uses. This row covers the
	// other answer: a rejection that names nothing. Keying the writer to the alias path would let
	// it hold the alias's lock while a writer that reached the referent held the referent's lock,
	// and the safeWriteJson flow must not reach the lock at all when the key is unknown.
	const dir = await makeDir("lockkey-")
	currentLink = path.join(dir, "link.json")
	const unanswering = new Error("readlink failed without naming a code")
	mockedRealpath.mockImplementation(async () => {
		throw enoent
	})
	mockedLstat.mockImplementation(async (target) => symlinkStat(target))
	mockedReadlink.mockImplementation(async () => Promise.reject(unanswering))
	let locked = false
	mockedAcquireFileLock.mockImplementation(async () => {
		locked = true
		return async () => {}
	})

	await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toBe(unanswering)
	expect(locked).toBe(false)
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

	try {
		await expect(safeWriteJson(target, { id: "task-1" })).rejects.toThrow("commit rename failed")

		// Only the original failure is reported.
		expect(consoleError).toHaveBeenCalledTimes(1)
	} finally {
		// Restore even when an assertion fails: the afterEach cleanup runs fs.rm
		// with these spies still in place otherwise, and later tests inherit a
		// rejecting rename.
		renameSpy.mockRestore()
		unlinkSpy.mockRestore()
		consoleError.mockRestore()
	}
})
