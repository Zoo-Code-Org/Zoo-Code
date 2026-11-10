// npx vitest run utils/__tests__/fileLock.canonicalKey.spec.ts

import path from "path"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import * as lockfile from "proper-lockfile"
import { withFileLock } from "../fileLock"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
	unlock: vi.fn(async () => {}),
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, realpath: vi.fn(), lstat: vi.fn(), readlink: vi.fn() }
})

const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedLock = vi.mocked(lockfile.lock)

const dir = path.resolve(path.join(path.sep + "work", "history"))
const referent = path.join(dir, "item.json")
const alias = path.join(dir, "alias.json")

beforeEach(() => {
	mockedRealpath.mockReset()
	mockedLstat.mockReset()
	mockedReadlink.mockReset()
	mockedLock.mockReset()
	// alias.json is a symlink to item.json; everything else resolves to itself.
	mockedRealpath.mockImplementation(async (target) => (target === alias ? referent : String(target)))
	// fs/promises types lstat as returning BigIntStats and this mock only ever needs
	// isSymbolicLink(), so the assertion is single-step and names the subset the double
	// actually fakes. AGENTS.md asks for a reason next to a cast a typed API cannot
	// express: no test in this file reads a bigint field, so no bigint field is faked.
	mockedLstat.mockImplementation(async () => ({ isSymbolicLink: () => false }) as BigIntStats)
	mockedReadlink.mockRejectedValue(Object.assign(new Error("not a link"), { code: "EINVAL" }))
})

describe("withFileLock lock-key canonicalization", () => {
	it("locks the canonical referent that safeWriteJson locks, not the raw alias", async () => {
		// The compound-atomicity contract of task-history deletion is that an
		// unlink under this helper and a safeWriteJson read-modify-write on the
		// same file serialize. That holds only while both compute ONE key:
		// safeWriteJson locks resolveLockKey(target), so withFileLock must too.
		// Locking the raw alias here would watch a different lock file and let
		// the deletion interleave with the merge write.
		await withFileLock(alias, async () => undefined)

		expect(mockedLock).toHaveBeenCalledTimes(1)
		expect(mockedLock.mock.calls[0][0]).toBe(referent)
		// The shared-key contract stated directly: whatever safeWriteJson would
		// lock for the same path is exactly what this helper locked.
		expect(mockedLock.mock.calls[0][0]).toBe(await resolveLockKey(alias))
	})

	it("hands the operation the caller's own path so its unlink keeps alias semantics", async () => {
		// unlink(alias) removes the link; unlink(referent) removes the target
		// file. Deletion must act on the path the caller named, even though the
		// lock is taken on the canonical key.
		const seen: string[] = []
		await withFileLock(alias, async (absoluteFilePath) => {
			seen.push(absoluteFilePath)
		})
		expect(seen).toEqual([alias])
	})
	it("pins the deliberate divergence: an ancestor realpath failure rejects the key but not the lock", async () => {
		// Requirement quoted from comment 4525695084 on the CodeRabbit review of PR 2383,
		// ASCII-normalised (the original uses typographic apostrophes and a bullet list):
		//   1. make an ancestor realpath fail with EACCES, and
		//   2. assert that resolveLockKey(target) rejects while withFileLock still takes the
		//      lock at the lexical path.
		// The divergence is the contract, not an accident: resolveLockKey canonicalizes the
		// parent through canonicalDirKey, which rethrows a non-ENOENT realpath failure so a
		// read-modify-write never guesses which lock it is on, while canonicalLockPath returns
		// the lexical path on the same failure so task-history deletion still serialises on
		// something. This test is the pin: if either half changes, the divergence has to be
		// re-decided on purpose instead of discovered in review.
		vi.mocked(mockedRealpath).mockImplementation(async (_target) => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		})

		await expect(resolveLockKey(alias)).rejects.toThrow("EACCES")
		await withFileLock(alias, async () => undefined)
		expect(mockedLock).toHaveBeenCalledTimes(1)
		expect(mockedLock.mock.calls[0][0]).toBe(alias)
	})
})
