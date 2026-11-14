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

	test("propagates a realpath failure that is not ENOENT instead of locking a guessed key", async () => {
		// A permission failure says nothing about the path's identity, which is exactly the
		// problem: the caller spelling is then a key we cannot prove anyone else is taking, and a
		// writer that reaches the same file through the referent holds a DIFFERENT lock. The stack
		// already refuses to guess in safeWriteText.resolveLockKey for the same reason; the lock
		// path has to refuse too rather than let two writers run at once.
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(
			Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
		)
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await expect(
			withFileLock(callerPath, async (absoluteFilePath) => {
				expect(absoluteFilePath).toBe(callerPath)
			}),
		).rejects.toMatchObject({ code: "EACCES" })

		// Nothing was locked, so nothing ran under a key no peer was contending for.
		expect(lockfile.lock).not.toHaveBeenCalled()
	})

	// The rule keys off the codes that mean "nothing is here yet". An error that carries no code
	// at all is not evidence of absence, so it propagates on the same rule as EACCES.
	test("propagates a realpath failure that carries no error code", async () => {
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(new Error("unknown failure"))
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await expect(
			withFileLock(callerPath, async (absoluteFilePath) => {
				expect(absoluteFilePath).toBe(callerPath)
			}),
		).rejects.toThrow("unknown failure")

		expect(lockfile.lock).not.toHaveBeenCalled()
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

test("locks the canonicalized referent of a file symlink whose target is temporarily absent", async () => {
	// A backup-mode commit renames the referent away and back. During that window the
	// link is dangling, realpath fails, and a naive fallback re-appends the LINK's
	// basename onto the canonical parent - a different key from the one safeWriteJson
	// holds through resolveLockKey, so the two writers stop excluding each other.
	// The referent sits under aliasDir and under a component the realpath double reports as
	// absent, so this row actually walks the missing-referent path: realpath of the link and of
	// the referent both report ENOENT, and the answer has to come back as the deepest
	// canonicalized ancestor plus the components that are missing - not the link's own name.
	const aliasDir = path.join(STORE, "aliasDir")
	const linkPath = path.join(aliasDir, "link.json")
	const referent = path.join(aliasDir, "missingReferent.json")
	vi.mocked(fsPromises.readlink).mockImplementation(async (p: unknown) => {
		if (String(p) === linkPath) return referent
		throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
	})

	const releaseLock = await acquireFileLock(linkPath)

	expect(lockfile.lock).toHaveBeenCalledWith(
		path.join(STORE, "realDir", "missingReferent.json"),
		expect.objectContaining({ realpath: false }),
	)

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

	// Terminated with exactly one lock acquisition on a cycle member, and the
	// total hop budget held across all frames.
	expect(lockfile.lock).toHaveBeenCalledTimes(1)
	expect(vi.mocked(fsPromises.readlink).mock.calls.length).toBeLessThanOrEqual(64)

	await releaseLock()
})

test("resolves a relative link target from the canonical parent, not from the caller's spelling", async () => {
	// A link under a symlinked directory that points "../referent.json": the referent is a
	// sibling of the REAL parent, so joining the referent lexically onto aliasDir names a
	// different file. The writer through the alias would then hold a lock the writer through
	// the referent never contends for. The mock canonicalizes aliasDir to a directory at a
	// different depth, so the two answers are distinguishable instead of both landing on the
	// same store/referent.json.
	vi.mocked(lockfile.lock).mockClear()
	vi.mocked(fsPromises.readlink).mockClear()
	vi.mocked(fsPromises.realpath).mockClear()
	const aliasParent = path.join(STORE, "aliasDir")
	const linkPath = path.join(aliasParent, "link.json")
	vi.mocked(fsPromises.readlink).mockImplementation(async (p: unknown) => {
		if (String(p) === linkPath) return "../referent.json"
		throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
	})
	vi.mocked(fsPromises.realpath).mockImplementation(async (target: unknown) => {
		const asString = String(target)
		if (asString === aliasParent) return path.resolve("/tmp/outer/real")
		return asString
	})

	const releaseLock = await acquireFileLock(linkPath)

	expect(lockfile.lock).toHaveBeenCalledWith(
		path.resolve("/tmp/outer/referent.json"),
		expect.objectContaining({ realpath: false }),
	)

	await releaseLock()
})

test("retakes the lock when the canonical key moves while the callback waits to run", async () => {
	// A directory component can be swapped while this call waits for the lock, leaving it
	// holding the OLD canonical key while a peer reaching the file through the NEW one takes a
	// different lock. withFileLock re-derives the key before running the callback and, on a
	// change, releases, retakes for the current key, and only then runs. The double below flips
	// the canonical parent inside the first acquisition, which is that swap.
	vi.mocked(lockfile.lock).mockClear()
	vi.mocked(fsPromises.readlink).mockClear()
	vi.mocked(fsPromises.realpath).mockClear()
	const aliasPath = path.join(STORE, "aliasDir", "task.json")
	let resolvedDir = "realDirOne"
	let acquisitions = 0
	vi.mocked(fsPromises.realpath).mockImplementation(async (target: unknown) =>
		String(target).replace("aliasDir", resolvedDir),
	)
	// Every event below is logged by the double at the moment the corresponding step starts or
	// completes, and both the stale release and the second acquisition hold for 30 ms before
	// completing. The holds are what turn the assertions into await claims rather than call-order
	// claims: a release that is merely called puts "acquire:2" before "release:completed", and a
	// callback that runs while the second acquisition is still settling puts "callback" before
	// "acquire:2:completed".
	const events: string[] = []
	vi.mocked(lockfile.lock).mockImplementation(async () => {
		const acquiredAs = ++acquisitions
		events.push("acquire:" + acquiredAs + ":started")
		if (acquiredAs === 1) resolvedDir = "realDirTwo"
		await new Promise<void>((resolve) => setTimeout(resolve, 30))
		events.push("acquire:" + acquiredAs + ":completed")
		return async () => {
			// Both releases are recorded. The first one is the stale key's release, which the
			// ordering above is about; the second is the retargeted key's release, which runs
			// after the callback, and an unrecorded second release is the hole this row has
			// to close: without its own events the test still passes if withFileLock skips it.
			const tag = acquiredAs === 1 ? "" : ":" + acquiredAs
			events.push("release" + tag + ":started")
			await new Promise<void>((resolve) => setTimeout(resolve, 30))
			events.push("release" + tag + ":completed")
		}
	})

	const seen: string[] = []
	await withFileLock(aliasPath, async (absoluteFilePath) => {
		// The callback is recorded in the same event list as the acquisitions, so "it ran only after
		// the second acquisition completed" is one ordering claim rather than two unrelated ones.
		events.push("callback")
		seen.push(absoluteFilePath)
	})

	// Both halves of the ordering are claims about awaits, not about call order: the first (stale)
	// key is released to completion before the second acquisition is asked for, and the callback
	// runs only after that second acquisition completes. Retargeting ahead of a completed release
	expect(events).toEqual([
		"acquire:1:started",
		"acquire:1:completed",
		"release:started",
		"release:completed",
		"acquire:2:started",
		"acquire:2:completed",
		"callback",
		"release:2:started",
		"release:2:completed",
	])
	const keys = vi.mocked(lockfile.lock).mock.calls.map((call) => String(call[0]))
	expect(keys).toEqual([path.join(STORE, "realDirOne", "task.json"), path.join(STORE, "realDirTwo", "task.json")])
	// would run the callback while the old lock still blocks peers; running it during a settling
	// acquisition would run it under a key no peer is contending for. The callback still receives
	// the caller's own spelling, and it ran exactly once - not under the key that had already
	// become stale.
	expect(seen).toEqual([aliasPath])
})

test("propagates a lock-key recheck failure instead of running under a key it could not confirm", async () => {
	// The re-derivation at fileLock.ts line 206 is what proves the key this call holds is the key a
	// peer reaching the same file by another spelling is taking. When the inspection itself fails
	// the canonical key is unknown, and an unknown key is not the same fact as an unchanged key:
	// canonicalLockPath already refuses to invent a key for exactly this reason on its first call,
	// and a walk that fails after the lock is held has to refuse on the same rule rather than let
	// the mutation run under a lock no peer is contending for.
	vi.mocked(lockfile.lock).mockClear()
	vi.mocked(fsPromises.readlink).mockClear()
	vi.mocked(fsPromises.realpath).mockClear()
	const callerPath = path.join(STORE, "aliasDir", "task.json")
	const events: string[] = []
	let inspections = 0
	vi.mocked(fsPromises.realpath).mockImplementation(async (target: unknown) => {
		inspections += 1
		if (inspections > 1) {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		}
		return String(target).replace("aliasDir", "realDir")
	})
	vi.mocked(lockfile.lock).mockImplementation(async () => {
		events.push("acquire")
		return async () => {
			events.push("release")
		}
	})

	let ranCallback = false
	const thrown = await withFileLock(callerPath, async () => {
		ranCallback = true
		events.push("callback")
	}).catch((error: unknown) => error)

	expect(thrown).toMatchObject({ code: "EACCES" })
	// Held, then given up: the callback never ran, so nothing mutated under a key whose canonical
	// form this call could not confirm.
	expect(events).toEqual(["acquire", "release"])
	expect(ranCallback).toBe(false)
})

test("reports a release failure on the retarget path instead of swallowing it", async () => {
	// The first acquisition below holds the key that goes stale mid-call, and its release now
	// fails. Dropping that failure means a peer keeps waiting on a lock this call believes it gave
	// up, with nothing recorded about which key or why. The success path and the error path in this
	// same function both report a release failure, so the retarget path reporting nothing is an
	// inconsistency rather than a decision.
	vi.mocked(lockfile.lock).mockClear()
	vi.mocked(fsPromises.readlink).mockClear()
	vi.mocked(fsPromises.realpath).mockClear()
	const aliasPath = path.join(STORE, "aliasDir", "task.json")
	let resolvedDir = "realDirOne"
	let acquisitions = 0
	const releaseFailure = Object.assign(new Error("EBUSY: lock file still held"), { code: "EBUSY" })
	const events: string[] = []
	vi.mocked(fsPromises.realpath).mockImplementation(async (target: unknown) =>
		String(target).replace("aliasDir", resolvedDir),
	)
	vi.mocked(lockfile.lock).mockImplementation(async () => {
		const acquiredAs = ++acquisitions
		events.push("acquire:" + acquiredAs)
		if (acquiredAs === 1) {
			resolvedDir = "realDirTwo"
		}
		return async () => {
			if (acquiredAs === 1) {
				events.push("release:1:failed")
				throw releaseFailure
			}
			events.push("release:2")
		}
	})

	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	const seen: string[] = []
	await withFileLock(aliasPath, async (absoluteFilePath) => {
		events.push("callback")
		seen.push(absoluteFilePath)
	})
	const reports = errorSpy.mock.calls.map((call) => String(call[0]))
	const carried = errorSpy.mock.calls.map((call) => call[1])
	errorSpy.mockRestore()

	// The retarget still happened and the callback still ran, under the new key.
	expect(events).toEqual(["acquire:1", "release:1:failed", "acquire:2", "callback", "release:2"])
	expect(seen).toEqual([aliasPath])
	// The failure is reported once, naming the key that failed to release, and carrying the error
	// object itself rather than a paraphrase of it.
	expect(reports.length).toBe(1)
	expect(reports[0]).toContain(path.join(STORE, "realDirOne", "task.json"))
	expect(carried[0]).toBe(releaseFailure)
})
