// npx vitest run utils/__tests__/fileLock.spec.ts

import * as path from "path"

import * as fsPromises from "fs/promises"

import * as lockfile from "proper-lockfile"

import { acquireFileLock, withFileLock } from "../fileLock"

vi.mock("fs/promises", () => ({
	realpath: vi.fn(async (target: unknown) => {
		const asString = String(target)
		// A path that does not exist yet reports ENOENT, as the real fs does.
		if (asString.includes("missing")) {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
		}
		return asString.replace("aliasDir", "realDir")
	}),
	// A non-link rejects readlink, exactly like the real fs; the link tests
	// override this per path.
	readlink: vi.fn(async () => {
		throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
	}),
}))

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
}))

/**
 * proper-lockfile derives its lock file from the path it is handed, and this module
 * turns off the library's own realpath step because the file may not exist yet. Without
 * a canonical lock key, a writer that reaches a file through a symlinked directory and a
 * deleter that reaches the same file lexically take DIFFERENT locks and silently lose
 * updates against each other - the shape a task file under a symlinked task directory
 * has against a task-history delete.
 */
const STORE = path.resolve("/tmp/store")

describe("fileLock - canonical lock keys", () => {
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockClear()
	})

	test("locks the referent when the path runs through a symlinked directory", async () => {
		const releaseLock = await acquireFileLock(path.join(STORE, "aliasDir", "task.json"))

		expect(lockfile.lock).toHaveBeenCalledWith(
			path.join(STORE, "realDir", "task.json"),
			expect.objectContaining({ realpath: false }),
		)

		await releaseLock()
	})

	test("locks the referent but hands the operation the caller's own path", async () => {
		// The mutex key is canonical; the path the caller works on is left alone. On Windows
		// realpath can answer with the 8.3 short form, and rewriting the path a caller
		// unlinks or compares would change behavior for every caller for no mutex gain.
		const callerPath = path.join(STORE, "aliasDir", "task.json")
		const seen: string[] = []
		await withFileLock(callerPath, async (absoluteFilePath) => {
			seen.push(absoluteFilePath)
		})

		expect(seen).toEqual([callerPath])
		expect(lockfile.lock).toHaveBeenCalledWith(
			path.join(STORE, "realDir", "task.json"),
			expect.objectContaining({ realpath: false }),
		)
	})

	test("falls back to the lexical path when realpath fails with EACCES", async () => {
		// A permission failure says nothing about the path's identity; failing closed to the
		// lexical path keeps the lock key stable instead of inventing a canonical form.
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(
			Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
		)
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await withFileLock(callerPath, async (absoluteFilePath) => {
			expect(absoluteFilePath).toBe(callerPath)
		})

		expect(lockfile.lock).toHaveBeenCalledWith(callerPath, expect.objectContaining({ realpath: false }))
	})

	test("falls back to the lexical path when realpath fails without an error code", async () => {
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(new Error("unknown failure"))
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await withFileLock(callerPath, async (absoluteFilePath) => {
			expect(absoluteFilePath).toBe(callerPath)
		})

		expect(lockfile.lock).toHaveBeenCalledWith(callerPath, expect.objectContaining({ realpath: false }))
	})

	test("canonicalizes the nearest existing ancestor when the file does not exist yet", async () => {
		// The file and its parent are absent, so realpath reports ENOENT for them; the deepest
		// existing ancestor is resolved and the missing components are re-appended.
		const seen: string[] = []
		await withFileLock(path.join(STORE, "aliasDir", "missing", "new.json"), async (absoluteFilePath) => {
			seen.push(absoluteFilePath)
		})

		expect(seen).toEqual([path.join(STORE, "aliasDir", "missing", "new.json")])
		expect(lockfile.lock).toHaveBeenCalledWith(
			path.join(STORE, "realDir", "missing", "new.json"),
			expect.objectContaining({ realpath: false }),
		)
	})
})

test("locks the referent of a file symlink whose target is temporarily absent", async () => {
	// A backup-mode commit renames the referent away and back. During that window the
	// link is dangling, realpath fails, and a naive fallback re-appends the LINK's
	// basename onto the canonical parent - a different key from the one safeWriteJson
	// holds through resolveLockKey, so the two writers stop excluding each other.
	const linkPath = path.join(STORE, "link.json")
	const referent = path.join(STORE, "referent.json")
	vi.mocked(fsPromises.readlink).mockImplementation(async (p: unknown) => {
		if (String(p) === linkPath) return referent
		throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
	})

	const releaseLock = await acquireFileLock(linkPath)

	expect(lockfile.lock).toHaveBeenCalledWith(referent, expect.objectContaining({ realpath: false }))

	await releaseLock()
})
test("terminates on a three-link cycle instead of recursing forever", async () => {
	// a -> b -> c -> a: the cycle length does not divide the per-frame walk bound,
	// so a recursion that restarts its hop budget on every frame never terminates -
	// each frame walks 8 hops, lands on a different cycle member, and recurses.
	// resolveLockKey hands a cycle member to withFileLock, so an unbounded
	// canonicalLockPath hangs every guarded writer on the lock path, not just the
	// walker. The readlink mock yields to a timer so a regression fails on the
	// test timeout instead of starving the event loop.
	// Top-level test: clear the shared doubles so the counts below are this test's own.
	vi.mocked(lockfile.lock).mockClear()
	vi.mocked(fsPromises.readlink).mockClear()
	vi.mocked(fsPromises.realpath).mockClear()

	const a = path.join(STORE, "cyc", "a.json")
	const b = path.join(STORE, "cyc", "b.json")
	const c = path.join(STORE, "cyc", "c.json")
	const cycle: Record<string, string> = { [a]: b, [b]: c, [c]: a }
	vi.mocked(fsPromises.readlink).mockImplementation(async (target: unknown) => {
		await new Promise((resolve) => setTimeout(resolve, 0))
		const referent = cycle[String(target)]
		if (referent === undefined) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
		return referent
	})
	vi.mocked(fsPromises.realpath).mockImplementation(async () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})

	const releaseLock = await acquireFileLock(a)

	// Terminated with exactly one lock acquisition, and the hop accounting is pinned to an
	// exact number instead of an upper bound: eight frames of eight hops spend the 64-hop
	// budget, 64 mod 3 leaves the cursor on the second cycle member, and realpath reports
	// ENOENT all the way to the root, so the lock lands on the lexical second member.
	// An upper bound accepts any walk that stopped early, which is how the per-frame bound
	// mutant and the budget-carry mutant survived: they also terminate, just after a
	// different number of hops and on a different member.
	expect(lockfile.lock).toHaveBeenCalledTimes(1)
	expect(lockfile.lock).toHaveBeenCalledWith(b, expect.objectContaining({ realpath: false }))
	expect(vi.mocked(fsPromises.readlink).mock.calls.length).toBe(64)

	await releaseLock()
})
