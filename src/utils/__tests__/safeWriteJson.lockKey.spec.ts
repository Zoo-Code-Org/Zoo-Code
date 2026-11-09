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
		// A real readlink reports a non-link by rejecting with code EINVAL (measured with
		// node 22.23.4 on win32; linux reports the same code), and the lock-key walk ends the
		// walk on exactly that code, so the double carries it.
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink
				? referent
				: Promise.reject(Object.assign(new Error("not a link"), { code: "EINVAL" })),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// The one resolve after the lock is the publish target, and staging plus every
		// rename site then name that same resolved string, so there is no second resolution
		// left to diverge on. (The chain's delegation resolved again inside safeWriteText and
		// ran two staging-path lstat checks; this protocol resolves once under the lock, which
		// is why two lstat entries and one resolve are gone rather than reordered.)
		expect(order).toEqual(["resolve-failed", "lstat", "resolve", "resolve", "lock", "resolve"])
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
		// Non-link answers carry EINVAL, the code a real readlink reports (see the row above).
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink
				? referent
				: Promise.reject(Object.assign(new Error("not a link"), { code: "EINVAL" })),
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
})

it("recovers an interrupted write beside the referent the lock key names, not beside the spelling the caller arrived with", async () => {
	// The interrupted writer staged its files beside the publish target it resolved. A writer
	// that arrives through a differently named alias finds them only by looking beside the
	// referent, which is where the lock key points; keyed to the caller's own spelling it scans
	// a different directory, leaves the orphaned backup where it is, and stages beside the alias.
	// A directory link cannot expose this on either platform - both spellings enumerate the same
	// entries - so this is proved the way the rest of the key is proved here: a mocked resolution
	// over a real filesystem, plus the path the recovery call was actually handed.
	const realDir = await makeDir("recovery-real-")
	const aliasDir = await makeDir("recovery-alias-")
	const referent = path.join(realDir, "history_item.json")
	const alias = path.join(aliasDir, "history_item.json")
	const leftover = `.history_item.json.bak_${Date.now()}_fedcba.tmp`
	await fs.writeFile(path.join(realDir, leftover), JSON.stringify({ previous: "content" }), "utf8")

	mockedRealpath.mockImplementation(async (target) =>
		path.resolve(String(target)) === path.resolve(alias) ? referent : String(target),
	)
	const realLstat = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).lstat
	mockedLstat.mockImplementation(async (target) => realLstat(String(target)))
	mockedAcquireFileLock.mockImplementation(async () => async () => {})

	const recoveryModule = await import("../jsonFileRecovery")
	// Captured before the spy is installed: calling the namespace property from inside the
	// implementation would recurse through the spy itself.
	const realRecover = recoveryModule.recoverInterruptedReplacement
	const recovered: string[] = []
	const recoverySpy = vi.spyOn(recoveryModule, "recoverInterruptedReplacement").mockImplementation(async (target) => {
		recovered.push(path.resolve(String(target)))
		return realRecover(target)
	})

	try {
		await safeWriteJson(alias, { id: "task-1" })
	} finally {
		recoverySpy.mockRestore()
	}

	// Recovery ran against the key, so it scanned the directory beside the referent.
	expect(recovered).toEqual([path.resolve(referent)])
	// The orphaned backup was found and restored, and the write then published the caller's
	// content over it. (The write's own backup step leaves a fresh .bak_ file beside the
	// target; the name asserted here is the one this fixture planted.)
	expect((await fs.readdir(realDir)).filter((entry) => entry === leftover)).toEqual([])
	expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ id: "task-1" })
	// Nothing was staged beside the alias.
	expect(await fs.readdir(aliasDir)).toEqual([])
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
