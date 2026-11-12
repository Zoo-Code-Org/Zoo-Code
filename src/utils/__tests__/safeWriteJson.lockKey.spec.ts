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
		// The extra resolves are the post-lock passes: the publish target is resolved, the lock key
		// is re-derived from the alias, and every derivation canonicalizes through realpath. The final
		// stability check no longer looks the alias up a second time: it canonicalizes the directory
		// of the target that was stored under the lock, so the flow makes one fewer realpath than
		// it did while that check re-derived from the alias. All of them run after the lock was
		// taken, so they do not change the lock the caller queued behind. The two trailing lstat
		// calls belonged to the delegation flow's staging-path checks; the replacement protocol
		// stages the temp itself and checks no identity beside it, so they are gone with the
		// delegation.
		expect(order).toEqual([
			"resolve-failed",
			"lstat",
			"resolve",
			"resolve",
			"lock",
			"resolve",
			"resolve",
			"resolve",
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

	it("releases the first referent lock and acquires the new referent lock when the alias moves under the lock", async () => {
		const order: string[] = []
		const dir = await makeDir("lockswitch-")
		const referentA = path.join(dir, "history_item_a.json")
		const referentB = path.join(dir, "history_item_b.json")
		currentLink = path.join(dir, "link.json")
		await fs.writeFile(referentA, JSON.stringify({ id: "a" }), "utf8")
		await fs.writeFile(referentB, JSON.stringify({ id: "b" }), "utf8")

		// The alias points at A when the lock key is computed and at B by the time that lock is held.
		// A writer that keeps A's lock merges into B while a second writer queues behind A, so one side
		// of the update is lost. The reacquisition pass must release A and take B before reading for
		// the merge. A mock that always returned one referent could not tell that apart from skipping
		// the pass, so this row drives the change under the lock.
		let aliasTarget = referentA
		mockedRealpath.mockImplementation(async (target) =>
			String(target) === currentLink ? aliasTarget : String(target),
		)
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? aliasTarget : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async (key) => {
			order.push("acquire:" + (key === referentA ? "A" : "B"))
			if (key === referentA) {
				aliasTarget = referentB
			}
			return async () => {
				order.push("release:" + (key === referentA ? "A" : "B"))
			}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		expect(mockedAcquireFileLock.mock.calls.map((call) => call[0])).toEqual([referentA, referentB])
		expect(order).toEqual(["acquire:A", "release:A", "acquire:B", "release:B"])
		expect(JSON.parse(await fs.readFile(referentB, "utf8"))).toEqual({ id: "task-1" })
		expect(JSON.parse(await fs.readFile(referentA, "utf8"))).toEqual({ id: "a" })
	})
	it("refuses to publish when the captured target sits under a different lock than the one held", async () => {
		const order: string[] = []
		const dir = await makeDir("captured-")
		const referentA = path.join(dir, "history_item_a.json")
		const referentB = path.join(dir, "history_item_b.json")
		currentLink = path.join(dir, "link.json")
		await fs.writeFile(referentA, JSON.stringify({ id: "a" }), "utf8")
		await fs.writeFile(referentB, JSON.stringify({ id: "b" }), "utf8")

		// A peer retargets the alias from A to B while this writer is taking A's lock, and moves it back
		// to A before the flow recomputes the key under that lock. The recomputation therefore agrees
		// with the key held, the loop that would move the lock to the current referent breaks on its
		// first pass, and the only thing standing between this write and the commit rename is the
		// target it captured while the alias pointed at B. A check that re-derives that target from a
		// second lookup of the alias sees A, agrees with the key it holds, and renames B's contents
		// away while still holding A's lock. A check that canonicalizes the captured target sees B,
		// disagrees with the key A, and refuses. The alias lookups below record the A to B to A rather
		// than narrating it, so the row shows the sequence it depends on.
		const aliasLookups: string[] = []
		mockedRealpath.mockImplementation(async (target) => {
			const spelling = String(target)
			if (spelling !== currentLink) {
				return spelling
			}
			const referent = aliasLookups.length === 1 ? referentB : referentA
			aliasLookups.push(referent)
			return referent
		})
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referentA : Promise.reject(new Error("not a link")),
		)
		mockedAcquireFileLock.mockImplementation(async (key) => {
			order.push(key === referentA ? "acquire:A" : "acquire:other")
			return async () => {
				order.push(key === referentA ? "release:A" : "release:other")
			}
		})

		await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toThrow(
			"the resolved target kept changing while acquiring the lock",
		)

		// The alias moved A to B while the lock was taken and back to A before the key recomputation.
		// The mismatch belongs to the captured target, not to the alias, which is why the guard has to
		// read the target this write is about to rename onto instead of looking the alias up again.
		expect(aliasLookups).toEqual([referentA, referentB, referentA])
		// The recomputation agreed with the held key, so no lock was moved: A is the only lock this
		// write acquired, and it is the lock the finally released.
		expect(order).toEqual(["acquire:A", "release:A"])
		expect(mockedAcquireFileLock.mock.calls.map((call) => call[0])).toEqual([referentA])
		// Refused before the merge read and before staging, so nothing was written beside either target.
		const left = await fs.readdir(dir)
		expect(left.filter((entry) => entry.includes(".new_") || entry.includes(".bak_"))).toEqual([])
		// Both targets still hold the bytes they had before this write tried.
		expect(JSON.parse(await fs.readFile(referentA, "utf8"))).toEqual({ id: "a" })
		expect(JSON.parse(await fs.readFile(referentB, "utf8"))).toEqual({ id: "b" })
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
