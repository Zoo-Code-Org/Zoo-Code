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
	mockedLstat.mockImplementation(async () => ({ isSymbolicLink: () => false }) as unknown as BigIntStats)
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
})
