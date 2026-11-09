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

	// The two rows above reach the lock through withFileLock, which calls canonicalLockPath and
	// _lockCanonicalKey directly and never passes through acquireFileLock. A fallback added only to
	// that exported entry point - canonicalize, and on any failure lock the caller's own spelling -
	// would leave both of them green while a direct caller (safeWriteJson, task-history deletion)
	// started taking a lock no peer was contending for. Same rejections, direct entry point.
	test("propagates an EACCES realpath failure through the acquireFileLock entry point", async () => {
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(
			Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
		)
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await expect(acquireFileLock(callerPath)).rejects.toMatchObject({ code: "EACCES" })

		// Nothing was locked, so nothing ran under a key no peer was contending for.
		expect(lockfile.lock).not.toHaveBeenCalled()
	}) // end acquireFileLock EACCES row

	test("propagates a code-less realpath failure through the acquireFileLock entry point", async () => {
		vi.mocked(fsPromises.realpath).mockRejectedValueOnce(new Error("unknown failure"))
		const callerPath = path.join(STORE, "aliasDir", "task.json")

		await expect(acquireFileLock(callerPath)).rejects.toThrow("unknown failure")

		expect(lockfile.lock).not.toHaveBeenCalled()
	}) // end acquireFileLock code-less row

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
	// Exactly the budget, not merely under it: eight hops per frame, eight frames left by the
	// recursion, so 64 asks. A frame that walks nine hops, and a recursion that hands the next
	// frame no budget, both keep a cycle green under `<= 64`; one of them also stops eight links
	// short of the referent the lock is supposed to name.
	expect(vi.mocked(fsPromises.readlink).mock.calls.length).toBe(64)

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
	// Each acquisition and the one release are logged into ONE list around the same 30 ms
	// hold, and the callback logs into it too, so the row can pin one order end to end instead of
	// only the keys and a callback count. The release double throws away the second release on
	// purpose: only the first acquisition's lock is still held when the retarget happens, and the
	// row is about the order, not about releasing a lock the helper already dropped.
	const events: string[] = []
	vi.mocked(lockfile.lock).mockImplementation(async () => {
		const acquiredAs = ++acquisitions
		events.push("acquire:" + acquiredAs + ":started")
		if (acquiredAs === 1) resolvedDir = "realDirTwo"
		await new Promise<void>((resolve) => setTimeout(resolve, 30))
		events.push("acquire:" + acquiredAs + ":completed")
		return async () => {
			if (acquiredAs !== 1) {
				return
			}
			events.push("release:started")
			await new Promise<void>((resolve) => setTimeout(resolve, 30))
			events.push("release:completed")
		}
	})

	const seen: string[] = []
	await withFileLock(aliasPath, async (absoluteFilePath) => {
		seen.push(absoluteFilePath)
		events.push("callback")
	})

	const keys = vi.mocked(lockfile.lock).mock.calls.map((call) => String(call[0]))
	expect(keys).toEqual([path.join(STORE, "realDirOne", "task.json"), path.join(STORE, "realDirTwo", "task.json")])
	// The callback still receives the caller's own spelling, and it ran exactly once, after the
	// retarget - not under the key that had already become stale.
	expect(seen).toEqual([aliasPath])
	// The order is the assertion this row was raised about. The stale key's release has to finish
	// before the replacement is asked for, and the callback has to run only once the replacement is
	// held: either half regressing on its own used to pass here with the key list and the callback
	// count both unchanged, because the old double logged nothing.
	expect(events).toEqual([
		"acquire:1:started",
		"acquire:1:completed",
		"release:started",
		"release:completed",
		"acquire:2:started",
		"acquire:2:completed",
		"callback",
	])
})

// The rows below exist because the mutation run named lines in this module with no test behind
// them. Each one says which mutant it is there to kill, so the disposition list on the PR has an
// executable answer behind every line it names.
describe("fileLock - retarget bound, fail-closed recheck and release failures", () => {
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockReset()
		vi.mocked(fsPromises.realpath).mockReset()
		vi.mocked(fsPromises.readlink).mockReset()
	})

	// The fail-closed rule has two codes. Every carried test walks an ENOENT ancestor, so
	// emptying the ENOTDIR string changed nothing anybody executed. A parent that is a file is
	// how a real volume answers, and the climb has to continue past it.
	test("keeps climbing past a parent that is a file instead of failing closed on ENOTDIR", async () => {
		vi.mocked(fsPromises.realpath).mockImplementation(async (target: unknown) => {
			const asString = String(target)
			if (asString.includes("fileLike")) {
				throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" })
			}
			return asString
		})
		const target = path.join(STORE, "fileLike", "nested", "task.json")

		const releaseLock = await acquireFileLock(target)

		expect(lockfile.lock).toHaveBeenCalledWith(target, expect.objectContaining({ realpath: false }))
		await releaseLock()
	})

	// The hop budget was only ever exercised by a cycle, and a cycle spends it whatever the frame
	// looks like. A chain that ends on its own names the key it has to land on, so a recursion
	// that hands the next frame no budget stops eight links short of the referent the lock is
	// supposed to name.
	test("walks a 20-link chain to its final referent instead of stopping at a frame boundary", async () => {
		const referents = new Map<string, string>()
		for (let i = 1; i < 20; i++) {
			referents.set(
				path.join(STORE, "chain", "link" + i, "task.json"),
				path.join(STORE, "chain", "link" + (i + 1), "task.json"),
			)
		}
		referents.set(path.join(STORE, "chain", "link20", "task.json"), path.join(STORE, "chainFinal", "task.json"))
		vi.mocked(fsPromises.readlink).mockImplementation(async (target: unknown) => {
			const referent = referents.get(String(target))
			if (referent === undefined) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" })
			return referent
		})
		const firstLink = path.join(STORE, "chain", "link1", "task.json")
		const finalKey = path.join(STORE, "chainFinal", "task.json")

		const releaseLock = await acquireFileLock(firstLink)

		expect(lockfile.lock).toHaveBeenCalledWith(finalKey, expect.objectContaining({ realpath: false }))
		// 20 links answered plus two rejections: the one that says the walk has arrived at a file,
		// and the terminal frame asking its own entry cursor once before it canonicalizes.
		expect(vi.mocked(fsPromises.readlink).mock.calls.length).toBe(22)
		await releaseLock()
	})

	// Nothing asserted on the retarget bound or on its message: `attempt--`, `attempt >` and an
	// emptied error string all kept the carried tests green. The spelling below moves on every
	// derivation until the sixth, so the bound has to fire after three retargets - four locks
	// taken, all four handed back, callback never run.
	test("gives up after three retargets, releases every lock it took and never runs the callback", async () => {
		let derivations = 0
		vi.mocked(fsPromises.realpath).mockImplementation(async () => {
			derivations++
			return path.join(STORE, derivations <= 5 ? "realDir" + derivations : "realDirHeld", "task.json")
		})
		const releases: number[] = []
		let acquisitions = 0
		vi.mocked(lockfile.lock).mockImplementation(async () => {
			const acquiredAs = ++acquisitions
			return async () => {
				releases.push(acquiredAs)
			}
		})
		const aliasPath = path.join(STORE, "aliasDir", "task.json")
		const seen: string[] = []

		await expect(
			withFileLock(aliasPath, async () => {
				seen.push("callback")
			}),
		).rejects.toThrow(/kept moving across 3 retargets/)

		expect(seen).toEqual([])
		expect(acquisitions).toBe(4)
		expect(releases).toEqual([1, 2, 3, 4])
	})

	// No test ever let the recheck reject, which is how the fallback to the caller's spelling
	// survived as a mutant and how the asymmetry against the walk that took the lock stayed
	// unexercised: that walk fails closed on an uninspectable ancestor.
	test("releases the held lock and rethrows when the post-acquisition recheck cannot canonicalize", async () => {
		const release = vi.fn(async () => {})
		vi.mocked(lockfile.lock).mockImplementation(async () => release)
		let derivations = 0
		vi.mocked(fsPromises.realpath).mockImplementation(async () => {
			derivations++
			if (derivations === 1) return path.join(STORE, "realDir", "task.json")
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		})
		const aliasPath = path.join(STORE, "aliasDir", "task.json")
		const seen: string[] = []

		await expect(
			withFileLock(aliasPath, async () => {
				seen.push("callback")
			}),
		).rejects.toMatchObject({ code: "EACCES" })

		expect(seen).toEqual([])
		expect(lockfile.lock).toHaveBeenCalledTimes(1)
		expect(release).toHaveBeenCalledTimes(1)
	})

	// Both release-failure log lines were code no test executed. They disagree about what the caller
	// sees - the operation's own error outranks a failed release, a completed operation is not
	// undone by one - and that difference is what the two assertions below pin.
	test("rethrows the operation error when the release fails too, and logs the release failure", async () => {
		const releaseError = new Error("release failed")
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {
			throw releaseError
		})
		const operationError = new Error("operation failed")
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		const target = path.join(STORE, "plain", "task.json")

		await expect(
			withFileLock(target, async () => {
				throw operationError
			}),
		).rejects.toBe(operationError)

		expect(logged).toHaveBeenCalledTimes(1)
		expect(logged).toHaveBeenCalledWith(`Failed to release lock for ${target}:`, releaseError)
		logged.mockRestore()
	})

	test("returns the result when only the release fails, and logs the release failure", async () => {
		const releaseError = new Error("release failed")
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {
			throw releaseError
		})
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		const target = path.join(STORE, "plain", "task.json")

		const result = await withFileLock(target, async () => "written")

		expect(result).toBe("written")
		expect(logged).toHaveBeenCalledTimes(1)
		expect(logged).toHaveBeenCalledWith(`Failed to release lock for ${target}:`, releaseError)
		logged.mockRestore()
	})
})
