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
		mockedAcquireFileLock.mockImplementation(async (key) => {
			// Record which identity each lock was taken on, not just that a lock was taken.
			order.push(path.basename(String(key)))
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The referent is the key every other writer that names this file uses, so the caller
		// queued behind the peer instead of failing before the lock. The link path is locked as
		// well, because this is a default write and the identity it replaces is the link: after
		// this commit, resolveLockKey names the link, so a writer that queues behind must not be
		// able to overlap with the one that queued behind the referent.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(currentLink)
		// The two trailing lstat calls are safeWriteText's staging-path checks: the
		// regular-file check on the temp file this write created, and the identity check
		// that the staging path is not the target. Both run after the key was resolved
		// and the lock was taken, so neither changes which lock the caller queued behind.
		// A write that declares no confinement scope no longer resolves the publish target at all,
		// so the two post-lock resolutions this used to record are gone; the lock key still comes
		// from the referent, which is what the test is about. The two extra resolutions before the
		// keys are the fold that decides whether the referent and the link are one lock: both run
		// before any lock is taken, so the comparison cannot observe a filesystem that moved
		// between the two acquisitions.
		expect(order).toEqual([
			"resolve-failed",
			"lstat",
			"resolve",
			"resolve",
			"resolve",
			"resolve",
			"history_item.json",
			"link.json",
			"lstat",
			"lstat",
		])
		// The bytes replaced the link rather than travelling through it to the referent: nobody
		// authorized the referent here, because no scope was declared.
		expect(JSON.parse(await fs.readFile(currentLink, "utf8"))).toEqual({ id: "task-1" })
		await expect(fs.readFile(referent, "utf8")).rejects.toThrow()
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

		// The in-lock resolution only happens for a caller that declared a scope, so the scope is
		// declared here: what this test pins is that a rejection inside the protected block still
		// releases the lock, and that path is reached through the confined resolution.
		await expect(safeWriteJson(currentLink, { id: "task-1" }, { confineTo: dir })).rejects.toThrow(enoent)
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

	// Windows canonicalisation is case-insensitive, so fs.realpath can hand back the very same file
	// under a different spelling - the drive letter's case is the common one. Comparing the two lock
	// identities case-sensitively then treats one file as two, and proper-lockfile answers the second
	// acquisition with "Lock file is already being held": a write that should simply succeed fails,
	// and it fails only on Windows. The double below answers that way for a key already taken under
	// ANY spelling, which is what a case-insensitive filesystem does.
	it.runIf(process.platform === "win32")(
		"takes one lock when canonicalisation differs from the requested path only by case",
		async () => {
			const dir = await makeDir("lockkey-case-")
			const target = path.join(dir, "history_item.json")
			const lowerDrive = (p: string) => (/^[A-Za-z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p)

			mockedRealpath.mockImplementation(async (p) => lowerDrive(String(p)))
			// The target does not exist yet (a create), which is what leaves the resolver's spelling as
			// the only thing to compare. Anything else this call lstats - the staging file among them -
			// is the regular file it is, so the double answers for that too instead of failing every probe.
			mockedLstat.mockImplementation(async (probe) => {
				if (String(probe).toLowerCase() === target.toLowerCase()) {
					throw enoent
				}
				return { isSymbolicLink: () => false, isFile: () => true } as unknown as BigIntStats
			})
			const held = new Set<string>()
			mockedAcquireFileLock.mockImplementation(async (key) => {
				const identity = lowerDrive(String(key)).toLowerCase()
				if (held.has(identity)) {
					throw new Error("Lock file is already being held")
				}
				held.add(identity)
				return async () => {
					held.delete(identity)
				}
			})

			await expect(safeWriteJson(target, { mcpServers: {} })).resolves.toBeUndefined()
			expect(mockedAcquireFileLock).toHaveBeenCalledTimes(1)
		},
	)

	// The second win32 folding a string comparison cannot do: a path component may be spelled as
	// its 8.3 short name (RUNNER~1 for a long user directory, which is what a CI runner hands
	// out). The filesystem folds that to the same directory entry, and the lock manager - which
	// locks `<path>.lock` with realpath:false - therefore places both spellings in ONE lock
	// directory. Asking twice is a collision with one's own lock, answered as 'Lock file is
	// already being held' after the retries are spent.
	it.runIf(process.platform === "win32")(
		"takes one lock when the requested path names the referent directory by its 8.3 short name",
		async () => {
			const dir = await makeDir("lockkey-short-")
			const referent = path.join(dir, "history_item.json")
			currentLink = path.join(dir, "link.json")
			const shortDir = path.join(path.dirname(dir), "LOCKKE~1")

			// The link is named through the short spelling; the canonical form is the real one.
			const linkViaShort = path.join(shortDir, "link.json")
			mockedRealpath.mockImplementation(async (probe) => {
				const p = String(probe)
				if (p.toLowerCase() === shortDir.toLowerCase()) {
					return dir
				}
				return p
			})
			// Nothing here is a symlink and everything the write touches exists, so the probe only
			mockedLstat.mockImplementation(
				async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
			)
			const held = new Set<string>()
			mockedAcquireFileLock.mockImplementation(async (key) => {
				const identity = String(key).toLowerCase()
				if (held.has(identity)) {
					throw new Error("Lock file is already being held")
				}
				held.add(identity)
				return async () => {
					held.delete(identity)
				}
			})

			await expect(safeWriteJson(linkViaShort, { mcpServers: {} })).resolves.toBeUndefined()
			expect(mockedAcquireFileLock).toHaveBeenCalledTimes(1)
		},
	)

	// The fallback is the common path, not an edge: on a create the target's parent may not exist
	// yet, so realpath fails and the resolved spelling is all there is. Case folding still has to
	// apply to that spelling, or the two keys of one not-yet-existing file collide the same way.
	it.runIf(process.platform === "win32")(
		"takes one lock when the parent does not exist yet and the two spellings differ by case",
		async () => {
			const dir = await makeDir("lockkey-create-")
			const missing = path.join(dir, "not-yet", "history_item.json")
			const otherSpelling = path.join(path.dirname(dir), path.basename(dir).toUpperCase(), "history_item.json")
			mockedRealpath.mockRejectedValue(enoent)
			// The parent is absent, which is what makes realpath fail above; the file itself is
			// whatever the write is about to create, so the probe answers as a regular file.
			mockedLstat.mockImplementation(
				async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
			)
			const held = new Set<string>()
			mockedAcquireFileLock.mockImplementation(async (key) => {
				const identity = String(key).toLowerCase()
				if (held.has(identity)) {
					throw new Error("Lock file is already being held")
				}
				held.add(identity)
				return async () => {
					held.delete(identity)
				}
			})

			await expect(safeWriteJson(otherSpelling, { mcpServers: {} })).resolves.toBeUndefined()
			expect(mockedAcquireFileLock).toHaveBeenCalledTimes(1)
		},
	)

	// The mixed case the CI runner hit, and the reason folding cannot stop at the immediate parent:
	// an ancestor that exists and is spelled as its 8.3 short name, with a tail that does not exist
	// yet - a create into a directory that is about to be made. resolveLockKey canonicalises through
	// the highest ancestor it can reach, so a fold that only asks for the immediate parent falls
	// back to the short spelling while the referent key is already canonical: two unequal keys,
	// one .lock directory, and the second acquisition collides with the first.
	it.runIf(process.platform === "win32")(
		"takes one lock when an existing ancestor is spelled short and the tail does not exist",
		async () => {
			const realDir = await makeDir("lockkey-mixed-")
			const shortDir = path.join(path.dirname(realDir), "LOCKKE~2")
			const requested = path.join(shortDir, "not-yet", "history_item.json")
			const canonical = path.join(realDir, "not-yet", "history_item.json")

			// One filesystem rule, not a list of paths: the short spelling of the existing directory
			// resolves to the real one, and nothing below it exists yet, so every deeper probe
			// rejects exactly as it would on a host where the create has not happened.
			mockedRealpath.mockImplementation(async (probe) => {
				const norm = String(probe).toLowerCase().replace(/\\/g, "/")
				const short = shortDir.toLowerCase().replace(/\\/g, "/")
				const real = realDir.toLowerCase().replace(/\\/g, "/")
				if (norm === short) {
					return realDir
				}
				if (norm === real || norm.startsWith(real + "/")) {
					return String(probe)
				}
				throw enoent
			})
			mockedLstat.mockImplementation(
				async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
			)
			const acquired: string[] = []
			mockedAcquireFileLock.mockImplementation(async (key) => {
				const identity = String(key).toLowerCase()
				if (acquired.map((k) => k.toLowerCase()).includes(identity)) {
					throw new Error("Lock file is already being held")
				}
				acquired.push(String(key))
				return async () => {}
			})

			await expect(safeWriteJson(requested, { mcpServers: {} })).resolves.toBeUndefined()
			expect(acquired).toHaveLength(1)
			// One lock, naming one entry. Which spelling it carries is the implementation's choice
			// (it keeps the requested one when the two fold together); what must hold is that the
			// spelling is the SAME ENTRY the canonical path names, so a writer arriving by the real
			// path queues behind this one rather than beside it.
			const entryOf = (probe: string) => {
				const norm = probe.toLowerCase().replace(/\\/g, "/")
				const short = shortDir.toLowerCase().replace(/\\/g, "/")
				const real = realDir.toLowerCase().replace(/\\/g, "/")
				return norm.startsWith(short) ? real + norm.slice(short.length) : norm
			}
			expect(entryOf(acquired[0])).toBe(entryOf(canonical))
		},
	)
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

it("releases both locks when a default write over a symlink completes", async () => {
	const dir = await makeDir("lockkey-")
	const referent = path.join(dir, "history_item.json")
	currentLink = path.join(dir, "link.json")
	const acquired: string[] = []
	const released: string[] = []

	mockedRealpath.mockImplementation(async (target) => (target === currentLink ? referent : String(target)))
	mockedLstat.mockImplementation(async (target) => symlinkStat(target))
	mockedReadlink.mockImplementation(async (target) =>
		target === currentLink ? referent : Promise.reject(new Error("not a link")),
	)
	mockedAcquireFileLock.mockImplementation(async (key) => {
		acquired.push(String(key))
		return async () => {
			released.push(String(key))
		}
	})

	await safeWriteJson(currentLink, { id: "task-1" })

	// Deterministic order: the two keys sorted, so two writers approaching the same pair from
	// opposite sides cannot each hold one and wait for the other.
	expect(acquired).toEqual([referent, currentLink].sort())
	// Every lock taken is released, in the reverse of the order they were taken.
	expect(released).toEqual([...acquired].reverse())
})

it("locks only the referent when the caller declared a confinement scope", async () => {
	const dir = await makeDir("lockkey-")
	const referent = path.join(dir, "history_item.json")
	currentLink = path.join(dir, "link.json")
	const acquired: string[] = []

	// A confined caller publishes through the referent, so the referent lock is the one that
	// serializes it - including against writers that name the referent directly. Adding the
	// link-path lock here would be a second lock for an identity this call does not replace.
	await fs.writeFile(referent, "{}", "utf8")
	mockedRealpath.mockImplementation(async (target) => (target === currentLink ? referent : String(target)))
	mockedLstat.mockImplementation(async (target) => symlinkStat(target))
	mockedReadlink.mockImplementation(async (target) =>
		target === currentLink ? referent : Promise.reject(new Error("not a link")),
	)
	mockedAcquireFileLock.mockImplementation(async (key) => {
		acquired.push(String(key))
		return async () => {}
	})

	await safeWriteJson(currentLink, { id: "task-1" }, { confineTo: dir })

	expect(acquired).toEqual([referent])
})
