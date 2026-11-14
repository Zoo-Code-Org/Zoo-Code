// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import { existsSync } from "fs"
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
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// The last resolve is this module's own publish-target resolution under the lock:
		// the commit rename needs the referent, and the staging path is derived from it.
		// Nothing here consults a delegated writer any more - this module performs the
		// commit rename itself - so the operation list is shorter than it was under
		// delegation. Every entry still runs after the lock key was resolved and after
		// the lock was taken, so none of them changes which lock the caller queued behind.
		// The recovery pass resolves the publish target before it scans, so one more resolution
		// runs inside the lock: it is what makes the scan look beside the referent instead of
		// beside the link. The pinned entries still say nothing ran before the lock key was
		// resolved and nothing ran while the lock was unheld, which is the claim of this case.
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

		await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toThrow(enoent)
		expect(released).toBe(true)
		// The strict rejection is reached through the ENOENT + symlink branch, not
		// through a synchronous throw that skips it.
		// Same extra in-lock resolution as the case above: the recovery scan resolves the publish
		// target before scanning for leftovers. The claim this case pins - the strict rejection
		// happens inside the protected block, so the lock is released - is unchanged: the entry
		// after "lock" is still a resolution that rejects, and "release" still follows it.
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
			return next === undefined ? Promise.reject(new Error("not a link")) : next
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
		mockedRealpath.mockImplementation(async (target) => {
			if (!existsSync(referent)) {
				throw enoent
			}
			return String(target) === currentLink ? referent : String(target)
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(new Error("not a link")),
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

	// Only the original failure is reported.
	expect(consoleError).toHaveBeenCalledTimes(1)

	renameSpy.mockRestore()
	unlinkSpy.mockRestore()
	consoleError.mockRestore()
})
