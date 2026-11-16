// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import * as os from "os"
import path from "path"
import { existsSync } from "fs"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"
import { resolveLockKey } from "../../services/file-safety/safeWritePrimitives"

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
		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// Choreography under the merged protocol: the pre-lock resolution is tolerant (a link the
		// peer has not committed yet must not reject the caller), and the strict resolution runs
		// after the recovery pass so an interrupted publish that recovery restores still resolves.
		// That is one resolution more than a single strict resolve under the lock would cost, and
		// staging plus every rename site then name the string that strict step returned, so
		// nothing is left to diverge on afterwards.
		expect(order).toEqual(["resolve-failed", "lstat", "resolve", "resolve", "lock", "resolve", "resolve"])
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
		// The strict rejection is reached through the ENOENT + symlink branch of the resolution
		// that runs after the recovery pass, not through a synchronous throw that skips it, and the
		// second lstat entry is that branch consulting lstat before refusing.
		expect(order).toEqual(["lstat", "lock", "lstat", "lstat", "release"])
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

// Blocks carried across the merge from the side that landed this module on the writers unit (pull
// 2452). The merged module keeps that side's guarantees, so its evidence travels with them.
// They are appended in their own describe so this file's own setup stays readable.
describe("guarantees carried from the writers unit (2452)", () => {
	it("follows a chain of nine links to the file it ends at", async () => {
		// Nine links, dangling at the far end. A walk that stops at eight leaves the key naming
		// an intermediate link, so a writer that named the file through this chain queued on a
		// different lock from a writer standing at the file itself - two locks for one file,
		// reached by chain length instead of by spelling.
		const chain = [
			"a0.json",
			"a1.json",
			"a2.json",
			"a3.json",
			"a4.json",
			"a5.json",
			"a6.json",
			"a7.json",
			"a8.json",
		]
		const referent = path.resolve("/tmp/chain-dir", "history_item.json")
		const targets = new Map<string, string>()
		chain.forEach((name, index) => {
			targets.set(
				path.resolve("/tmp/chain-dir", name),
				index + 1 < chain.length ? path.resolve("/tmp/chain-dir", chain[index + 1]) : referent,
			)
		})
		mockedRealpath.mockRejectedValue(enoent)
		mockedLstat.mockImplementation(
			async (target) =>
				({
					isSymbolicLink: () => targets.has(String(target)),
					isFile: () => !targets.has(String(target)),
				}) as unknown as BigIntStats,
		)
		mockedReadlink.mockImplementation(async (target) => {
			const next = targets.get(String(target))
			return next === undefined
				? Promise.reject(Object.assign(new Error("not a link"), { code: "EINVAL" }))
				: next
		})

		const viaChain = await resolveLockKey(path.resolve("/tmp/chain-dir", chain[0]))

		// One readlink per link, all nine, plus the probe that finds a non-link at the far end:
		// the key names the file, not a link part-way down the chain.
		expect(mockedReadlink).toHaveBeenCalledTimes(chain.length + 1)
		expect(viaChain).toBe(referent)
	})

	it("heals the interrupted publish beside the referent while the alias dangles", async () => {
		const linkDir = await makeDir("lockkey-link-")
		const referentDir = await makeDir("lockkey-referent-")
		const referent = path.join(referentDir, "history_item.json")
		currentLink = path.join(linkDir, "link.json")
		// An interrupted two-step replacement: the previous write renamed the committed file to
		// its backup and never landed the replacement, so the committed content sits in a
		// backup beside the referent while the referent itself is absent. The link was renamed
		// away too, so the alias resolves nowhere.
		const backupPath = path.join(referentDir, ".history_item.json.bak_previous.tmp")
		await fs.writeFile(backupPath, JSON.stringify({ version: "committed" }))
		// Neither spelling resolves while the referent is missing, which is what a dangling
		// link looks like to realpath. Recovery restores the referent, and from then on both
		// spellings resolve again.
		// Only the two spellings of the missing file fail to resolve; directory components answer with
		// their own path, which is what a real filesystem does while the referent is away, and the
		// canonical key walk has to resolve them to find the nearest real ancestor.
		mockedRealpath.mockImplementation(async (target) => {
			const p = String(target)
			if (!existsSync(referent) && (p === referent || p === currentLink)) {
				throw enoent
			}
			return p === currentLink ? referent : p
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink
				? referent
				: Promise.reject(Object.assign(new Error("not a link"), { code: "EINVAL" })),
		)
		mockedAcquireFileLock.mockResolvedValue(async () => {})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the referent's key, and recovery looked beside the referent as well,
		// so the interrupted publish's committed state was restored before this write decided
		// what the file holds. Named at the dangling alias, this write queued on the referent's
		// lock and healed the referent's leftovers instead of failing every retry.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ id: "task-1" })
		expect(await fs.readdir(referentDir)).toEqual(["history_item.json"])
		expect(await fs.readdir(linkDir)).toEqual([])
	})
})
