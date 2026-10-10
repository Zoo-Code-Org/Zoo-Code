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
		// The two trailing lstat calls are safeWriteText's staging-path checks: the
		// regular-file check on the temp file this write created, and the identity check
		// that the staging path is not the target. Both run after the key was resolved
		// and the lock was taken, so neither changes which lock the caller queued behind.
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
