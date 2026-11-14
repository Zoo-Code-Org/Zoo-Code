// npx vitest run utils/__tests__/safeWriteJson.lockKey.spec.ts

import * as os from "os"
import path from "path"
import { type BigIntStats, closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "fs"
import * as fs from "fs/promises"
import { acquireFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"
import { lockPathFor } from "../fileLock"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"
import { getErrorCode } from "../errorCode"

vi.mock("../fileLock", async () => {
	// The drift guard asks whether two keys name one lock, which is a question about the
	// artefact location lockPathFor describes. Mocking this module must not replace that
	// one pure function, or a row would be comparing a location of its own invention.
	const actual = await vi.importActual<typeof import("../fileLock")>("../fileLock")
	return { ...actual, acquireFileLock: vi.fn(async () => async () => {}) }
})

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return {
		...actual,
		realpath: vi.fn(),
		lstat: vi.fn(),
		readlink: vi.fn(),
		// stat stays a pass-through by default. The acceptance rows read the artefact identity back
		// through it, and the one row that overrides it puts this back when it finishes.
		stat: vi.fn(actual.stat),
	}
})
const mockedRealpath = vi.mocked(fs.realpath)
const mockedLstat = vi.mocked(fs.lstat)
const mockedReadlink = vi.mocked(fs.readlink)
const mockedAcquireFileLock = vi.mocked(acquireFileLock)
const mockedStat = vi.mocked(fs.stat)

const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })

// "Not a link" is not a bare error. readlink reports it as EINVAL, and the lock-key walk now has
// to tell that answer apart from a refusal, so the double carries the code the real call carries.
// It used not to, and nothing noticed: the walk swallowed every readlink failure, so a codeless
// rejection read the same as the answer "this is not a link".
const notALink = (): Error => Object.assign(new Error("EINVAL: invalid argument, not a symlink"), { code: "EINVAL" })

// Whether this volume answers a name with a different spelling than the one its directory stores.
// The gate further down needs the capability rather than the platform label, so it is measured
// from a real directory: write one file, ask whether a differently-cased name opens, and require
// the directory to list exactly one spelling of it. A failure that is not "not there" throws and
// stops the file from collecting - a probe that defaulted on an unexpected error would report the
// capability as absent and turn the gated row into a skip that reads like a pass. The row that
// gates on this value re-measures the same property at run time through the promise surface and
// compares, so a wrong answer here fails loudly rather than quietly reducing coverage.
const CASE_FOLDING_VOLUME = (() => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lockkey-foldprobe-"))
	try {
		const stored = path.join(dir, "probe.json")
		writeFileSync(stored, "{}")
		// The probe's own easy question first: a volume that will not open the file under the name it
		// was written with is not in a position to answer the hard one.
		closeSync(openSync(stored, "r"))
		const listed = readdirSync(dir)
		if (listed.length !== 1) {
			throw new Error("case-folding probe directory holds " + String(listed.length) + " entries, expected 1")
		}
		let opensUnderOtherCase = false
		try {
			closeSync(openSync(path.join(dir, "PROBE.JSON"), "r"))
			opensUnderOtherCase = true
		} catch (error: unknown) {
			const code = getErrorCode(error)
			// "Not there" is the verdict this gate wants: a volume that stores one spelling and does
			// not find the other is case-sensitive. Anything else is a question the filesystem refused
			// to answer, which is not an answer.
			if (code !== "ENOENT") {
				throw new Error("case-folding probe could not ask the filesystem: " + String(code ?? error))
			}
		}
		return opensUnderOtherCase
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})()

// Each test creates a real temp directory so the real fs calls still work,
// and clears the module-level doubles between tests so an implementation from one test cannot carry over.
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

/**
 * safeWriteJson stages as .<basename>.new_<timestamp>_<random>.tmp - createTempFilePath at
 * safeWriteJson.ts:192-197, the template main carries at its :54 - so a staged leftover never
 * starts with ".new_": it starts with the target's own name. Matching the infix is what lets
 * the "nothing left staged" assertions below see a leak at all; the startsWith form matches
 * only safeWriteText's own ".new_<ts>_<rand>.tmp" names (safeWriteText.ts:92-94), which this
 * file never stages. safeWriteJson.interruption.test.ts:196 already filters by infix.
 */
const stagedFile = (name: string): boolean => name.includes(".new_")

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
			target === currentLink ? referent : Promise.reject(notALink()),
		)
		mockedAcquireFileLock.mockImplementation(async () => {
			order.push("lock")
			return async () => {}
		})

		await safeWriteJson(currentLink, { id: "task-1" })

		// The lock key is the key every other writer to this file uses, so the caller
		// queued behind the peer instead of failing before the lock.
		expect(mockedAcquireFileLock).toHaveBeenCalledWith(referent)
		// Before the lock the key walk fails once (the peer has the referent renamed away), reports the
		// link by lstat and canonicalizes the parent, and the caller queues on the referent. After the
		// lock the publish target is resolved strictly, the agreement check resolves it and canonicalizes
		// its directory, and the staging directory is resolved twice - the approval and the
		// re-verification. The two staging-path lstat checks this row used to count are not reached:
		// with the key spelled as the resolved target, the approved directory and the target's parent are
		// one canonical directory from the first reading, so safeWriteText has no divergence to measure.
		// None of these readings changes which lock the caller queued behind.
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
			"resolve",
		])
		expect(JSON.parse(await fs.readFile(referent, "utf8"))).toEqual({ id: "task-1" })
	})

	it("refuses a resolution that lands in another directory even when its lock artefact is reachable", async () => {
		const dir = await makeDir("lockkey-diralias-")
		const referent = await makeDir("lockkey-referent-")
		const alias = path.join(dir, "alias")
		const peerFile = path.join(referent, "settings.json")
		await fs.mkdir(alias)
		const target = path.join(alias, "settings.json")

		// realpath and lstat delegate to the real filesystem: the two directories below are
		// directories the operating system created, which is the only way to show the guard
		// refusing a destination that is genuinely elsewhere.
		const real = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		mockedRealpath.mockImplementation(async (p) => await real.realpath(String(p)))
		mockedLstat.mockImplementation(async (p) => await real.lstat(String(p), { bigint: true }))
		mockedReadlink.mockRejectedValue(enoent)

		let acquiredKey: string | undefined
		mockedAcquireFileLock.mockImplementation(async (file) => {
			acquiredKey = String(file)
			// This writer holds the lock for the key it computed, at the artefact
			// acquireFileLock creates for it. The peer publishes the file under its own lock in
			// another directory, moves the directory this writer's key names out of the way, and
			// re-keys that name onto the peer's directory. The writer's artefact spelling now
			// resolves through the alias onto the PEER's artefact: an identity match there would
			// name a lock this writer never took.
			await fs.mkdir(lockPathFor(String(file)), { recursive: true })
			await fs.writeFile(peerFile, JSON.stringify({ mcpServers: { peer: true } }))
			await fs.mkdir(lockPathFor(peerFile), { recursive: true })
			await fs.rename(alias, path.join(dir, "stale"))
			await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
			return async () => {}
		})

		const error = await safeWriteJson(target, { mcpServers: { mine: true } }).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		)
		expect(String(error && error.name)).toBe("LockKeyDriftError")
		expect(String(acquiredKey)).toContain(path.join("alias", "settings.json"))
		// Nothing staged or published: the referent directory holds only the peer's file and
		// its own artefact, and the moved-aside directory holds only this writer's.
		expect((await fs.readdir(referent)).sort()).toEqual(["settings.json", "settings.json.lock"])
		expect(JSON.parse(await fs.readFile(peerFile, "utf8"))).toEqual({ mcpServers: { peer: true } })
		expect((await fs.readdir(path.join(dir, "stale"))).sort()).toEqual(["settings.json.lock"])
	})

	it("accepts the name the filesystem itself answers for the spelling the key was computed from", async () => {
		const dir = await makeDir("lockkey-casefold-")
		// The fixture's own geometry, recorded during acquisition rather than assumed: the key the product
		// hands to acquireFileLock is the spelling its pre-lock resolution answered with, and whether the
		// writer's own spelling exists by the time acquisition returns is the far half of the divergence the
		// guard is then asked about. Both rows assert these before asserting anything about the guard, so a
		// platform that stops building the pair fails here instead of somewhere harder to read.
		const acquisitionFacts: Array<{ key: string; spellingPresentDuringAcquisition: boolean }> = []
		const lower = path.join(dir, "settings.json")
		const upper = path.join(dir, "SETTINGS.JSON")
		const real = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		// The reviewer's case turns on realpath handing back the name a directory stores rather
		// than the spelling it was given - which is what NTFS's GetFinalPathNameByHandle does.
		// This double models exactly that, and is the identity function wherever the two already
		// agree. Where the filesystem does the restating and where the double does it is what the
		// probe below measures, because the subject of this row is a pair that differs by basename
		// case inside one directory, and _locksAreOneLock (safeWriteJson.ts:119-:124) puts its
		// question to no other pair. A case-only pair is something only a case-folding filesystem
		// produces on its own; on ext4 the two spellings are two entries and the guard is inert
		// there by design, so the double supplies the restating and the row asserts the identity
		// and propagation half of what the code promises on that platform.
		const restatingRealpath = async (target: string): Promise<string> => {
			const resolved = await real.realpath(target)
			const parent = path.dirname(resolved)
			const name = path.basename(resolved)
			const listed = await real.readdir(parent).catch(() => [] as string[])
			// Prefer the entry whose name differs from the request in case alone. On a folding
			// filesystem that is the one name the directory stores; on a case-sensitive one the
			// directory holds both spellings and the match has to be pinned to the other one, or the
			// divergence this row is built on would depend on readdir order.
			const stored = listed.find((entry: string) => entry !== name && entry.toLowerCase() === name.toLowerCase())
			return stored === undefined ? resolved : path.join(parent, stored)
		}
		const probeLower = path.join(dir, "probe.json")
		await real.writeFile(probeLower, "{}")
		const foldsCase = await restatingRealpath(path.join(dir, "PROBE.JSON")).then(
			async (resolved: string) => path.basename(resolved) === path.basename(probeLower),
			() => false,
		)
		await real.rm(probeLower, { force: true })
		mockedRealpath.mockImplementation(async (p) => await restatingRealpath(String(p)))
		mockedLstat.mockImplementation(async (p) => await real.lstat(String(p), { bigint: true }))
		mockedReadlink.mockImplementation(async (p) => await real.readlink(String(p)))

		mockedAcquireFileLock.mockImplementation(async (file) => {
			// The key was computed from the upper-case spelling while nothing of that name existed,
			// so it kept the literal spelling. The file this write publishes to appears during
			// acquisition, under the name the filesystem reports.
			const ownArtefact = lockPathFor(String(file))
			await fs.writeFile(ownArtefact, "")
			await fs.writeFile(lower, JSON.stringify({ mcpServers: { peer: true } }))
			if (!foldsCase) {
				// A case-sensitive filesystem cannot produce the name pair on its own, so the entry in
				// the writer's spelling is made here and the two artefact names are joined by a hard
				// link. Hard link rather than symlink, deliberately: a hard link is one object under
				// two names on NTFS and on ext4 alike, it asks for no privilege on either hosted lane,
				// and the thing the guard answers from is object identity, which a hard link supplies
				// and a link that resolves somewhere else only imitates.
				await fs.link(lower, upper)
				await fs.link(ownArtefact, lockPathFor(lower))
			}
			acquisitionFacts.push({
				key: String(file),
				spellingPresentDuringAcquisition: await fs.lstat(upper).then(
					() => true,
					() => false,
				),
			})
			return async () => {}
		})

		const error = await safeWriteJson(upper, { mcpServers: { mine: true } }).then(
			() => undefined,
			(caught: unknown) => caught as Error,
		)
		// The claim is the guard's answer, and it is the same claim on either filesystem: the two
		// names reach one artefact, so this writer holds the lock the other spelling would take and
		// the write is not refused. Where the two platforms differ is in how many names exist, which
		// is a property of the directory and not of the guard, so only the counts branch.
		// Geometry before verdict.
		expect(
			acquisitionFacts.map((fact: { key: string }) => path.basename(fact.key)),
			"the lock key handed to acquisition was not this writer's spelling, so no divergence reached the guard",
		).toEqual(["SETTINGS.JSON"])
		expect(
			acquisitionFacts.map(
				(fact: { spellingPresentDuringAcquisition: boolean }) => fact.spellingPresentDuringAcquisition,
			),
			"the writer's spelling never appeared during acquisition, so the under-lock resolution had nothing to restate",
		).toEqual([true])
		expect(String(error && error.name)).toBe("undefined")
		// The commit rename lands on the target the under-lock resolution named, which is the name
		// the filesystem reported during acquisition. On the case-folding filesystem the two
		// spellings are one entry, so reading either reports this writer's content. On the
		// case-sensitive one the rename replaces only that reported name: the other entry keeps the
		// peer's content under the spelling the caller was given, exactly as the hard-link pair was
		// laid out.
		expect(JSON.parse(await fs.readFile(lower, "utf8"))).toEqual({ mcpServers: { mine: true } })
		if (!foldsCase) {
			expect(JSON.parse(await fs.readFile(upper, "utf8"))).toEqual({ mcpServers: { peer: true } })
		}
		const entries = await fs.readdir(dir)
		// A case-folding filesystem holds one file and one artefact under the two spellings, so it
		// lists two entries; a case-sensitive one holds two distinct files and two distinct
		// artefacts, and lists four. Names are compared case-insensitively because on a folding
		// filesystem the commit rename itself restates which spelling the file carries.
		expect(entries.map((name: string) => name.toLowerCase()).sort()).toEqual(
			foldsCase
				? ["settings.json", "settings.json.lock"]
				: ["settings.json", "settings.json", "settings.json.lock", "settings.json.lock"],
		)
		expect(entries.length).toBe(foldsCase ? 2 : 4)
		// The guard answered from object identity, so the identity is read back off the filesystem
		// rather than taken on trust from the fixture: two names, one artefact, on either platform.
		const ownArtefactRead = await fs.stat(lockPathFor(upper))
		const peerArtefactRead = await fs.stat(lockPathFor(lower))
		expect(peerArtefactRead.dev).toBe(ownArtefactRead.dev)
		expect(peerArtefactRead.ino).toBe(ownArtefactRead.ino)
	})

	it("does not stage or publish while the lock acquisition has not returned", async () => {
		const dir = await makeDir("lockkey-pending-")
		const target = path.join(dir, "settings.json")

		// Staging uses the .<name>.new_<ts>_<rand>.tmp infix and the publish renames
		// onto the target, both inside this directory, so the directory listing taken
		// while acquisition is pending is the whole proof.
		// .<name>.new_<ts>_<rand>.tmp infix and the publish renames onto the target,
		// both inside this directory, so an empty directory is the whole proof.
		mockedRealpath.mockImplementation(async (t) => String(t))
		mockedLstat.mockRejectedValue(enoent)
		mockedReadlink.mockRejectedValue(notALink())

		let acquiredKey: string | undefined
		let duringAcquisition: string[] | undefined
		let releaseAcquisition: () => void = () => {}
		const acquisition = new Promise<void>((resolve) => {
			releaseAcquisition = resolve
		})
		mockedAcquireFileLock.mockImplementation(async (file) => {
			acquiredKey = String(file)
			// The acquisition has been called and has not returned. Let the caller run
			// in that window: if it stages or publishes before holding the lock, that
			// work lands in this directory and the snapshot below catches it. A caller
			// that waits for the lock has nothing to do here but wait.
			await new Promise((resolve) => setTimeout(resolve, 25))
			duringAcquisition = await fs.readdir(dir)
			await acquisition
			return async () => {}
		})

		const write = safeWriteJson(target, { mcpServers: {} })
		releaseAcquisition()
		await write

		expect(acquiredKey).toBe(target)
		expect(duringAcquisition).toEqual([])
		expect(await fs.readdir(dir)).toEqual(["settings.json"])
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ mcpServers: {} })
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
			target === currentLink ? referent : Promise.reject(notALink()),
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

	it("refuses to publish through a lock that no longer names the target", async () => {
		const order: string[] = []
		let released = false
		const dir = await makeDir("lockkey-")
		const keyedFile = path.join(dir, "history_item.json")
		const movedFile = path.join(dir, "elsewhere.json")
		currentLink = path.join(dir, "link.json")

		// The key is resolved from the alias as it looks before the lock; the publish target is
		// resolved again under it. Repoint the alias in between - a peer committing, or a planted
		// link swap - and this writer would commit onto a file whose lock it never took, while
		// another writer can hold that file's lock and commit onto it too.
		let referent = keyedFile
		mockedRealpath.mockImplementation(async (target) => (target === currentLink ? referent : String(target)))
		mockedLstat.mockImplementation(async (target) => symlinkStat(target))
		mockedReadlink.mockImplementation(async (target) =>
			target === currentLink ? referent : Promise.reject(notALink()),
		)
		mockedAcquireFileLock.mockImplementation(async (lockedPath) => {
			order.push("lock:" + path.basename(lockedPath))
			referent = movedFile
			return async () => {
				order.push("release")
				released = true
			}
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(safeWriteJson(currentLink, { id: "task-1" })).rejects.toThrow("the advisory lock was taken for")

		expect(order).toEqual(["lock:history_item.json", "release"])
		expect(released).toBe(true)
		// Nothing was staged or published: neither the keyed file nor the file the alias moved to.
		for (const candidate of [keyedFile, movedFile]) {
			const present = await fs.access(candidate).then(
				() => true,
				() => false,
			)
			expect(present).toBe(false)
		}
		consoleError.mockRestore()
	})

	it("refuses to stage when the target's parent no longer names that directory", async () => {
		let released = false
		const dir = await makeDir("lockkey-")
		const target = path.join(dir, "history_item.json")
		const outside = path.join(dir, "elsewhere")
		currentLink = ""

		// The staging location is chosen from the parent directory resolved under the lock, and the
		// staged file is written here in safeWriteJson before safeWriteText runs. Replace that directory
		// with a link pointing outside it between the guard's approval of it and its re-verification,
		// and the staged JSON lands outside the directory this write was approved for - safeWriteText
		// can still reject the publish, but the stray file already exists. Canonicalizing the parent is
		// the only thing that can see the swap, and it sees it as the re-verification landing somewhere
		// the approval did not. (A swap planted before the first reading is invisible to this guard by
		// construction: both readings then agree, and safeWriteText's own beside-the-target check is
		// what rejects it.)
		let readings = 0
		mockedRealpath.mockImplementation(async (t) => {
			const key = String(t)
			if (key !== dir) {
				return key
			}
			// Readings 1 and 2 are the lock-key canonicalization before and after the lock, reading 3
			// is the guard approving the directory as it currently resolves, and reading 4 is the guard
			// re-verifying it - the one a planted swap has to move. This case used to pass off the guard's
			// separate existence probe instead: its stub named a path that never existed, so the guard's
			// fs.stat of the resolution failed and the write was rejected for "no existing directory",
			// which was never evidence about a re-point. The readings below are what make it evidence.
			readings += 1
			return readings <= 3 ? dir : outside
		})
		mockedLstat.mockImplementation(
			async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
		)
		mockedAcquireFileLock.mockImplementation(async () => async () => {
			released = true
		})
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await expect(safeWriteJson(target, { id: "task-1" })).rejects.toThrow(
			"the directory this write was approved for",
		)
		expect(readings).toBe(4) // the guard really did take its second reading of the approved directory

		expect(released).toBe(true)
		// Nothing was staged: no target, and no .new_*.tmp left behind in the directory.
		await expect(fs.readFile(target, "utf8")).rejects.toThrow()
		expect((await fs.readdir(dir)).filter(stagedFile)).toEqual([])
		consoleError.mockRestore()
	})

	it("locks and publishes the same file when the alias does not move", async () => {
		// The guard has to stay quiet on the normal path: key and publish target resolve through
		// the same alias, and the write goes ahead under one lock.
		const dir = await makeDir("lockkey-")
		const target = path.join(dir, "history_item.json")
		currentLink = ""
		mockedRealpath.mockImplementation(async (t) => String(t))
		mockedLstat.mockImplementation(
			async () => ({ isSymbolicLink: () => false, isFile: () => true }) as unknown as BigIntStats,
		)
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

		await safeWriteJson(target, { id: "task-1" })

		expect(mockedAcquireFileLock).toHaveBeenCalledWith(target)
		expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ id: "task-1" })
		consoleError.mockRestore()
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
	it("measures the same case-folding answer at run time that the collection-time probe reported", async () => {
		// This row is the probe's control rather than another assertion about the writer. The gate on
		// the row below skips work on the strength of a value computed while this file was collected,
		// and a probe that reported the capability as absent would turn that row into a skip that
		// reads like a pass. Re-measuring at run time, through the promise surface, in a directory
		// this row creates, means a wrong probe answer shows up here as a failure instead of as an
		// absence. Its own control is hard-coding CASE_FOLDING_VOLUME to false at collection time:
		// on a folding volume this row reddens, which is the direction that could otherwise go quiet.
		const dir = await makeDir("lockkey-foldcheck-")
		const real = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const stored = path.join(dir, "probe.json")
		await real.writeFile(stored, "{}")
		const ownName = await real.open(stored, "r").catch(() => undefined)
		await ownName?.close()
		expect(ownName, "the file this row created did not open under its own name").not.toBeUndefined()
		expect(await real.readdir(dir)).toHaveLength(1)
		const otherCase = await real.open(path.join(dir, "PROBE.JSON"), "r").then(
			async (opened: Awaited<ReturnType<typeof real.open>>) => {
				await opened.close()
				return true
			},
			(error: unknown) => {
				const code = getErrorCode(error)
				// Same rule the probe follows: absence is an answer, anything else is a measurement
				// that did not happen and must not be recorded as one.
				if (code !== "ENOENT") {
					throw new Error(
						"run-time case-folding check could not ask the filesystem: " + String(code ?? error),
					)
				}
				return false
			},
		)
		expect(otherCase, "the run-time measurement and the collection-time probe disagree about this volume").toBe(
			CASE_FOLDING_VOLUME,
		)
	})

	// The gate below is a measured capability rather than a platform label: this row can only drive
	// the guard's identity question on a volume where one file answers under two spellings, and
	// that is a property of the volume, not of the runner's name. CASE_FOLDING_VOLUME is computed
	// at collection time from a real directory and throws when the measurement cannot be trusted,
	// instead of defaulting, because a probe that quietly answered "no" would make this row a skip
	// that reads like a pass. What the gate does not claim: on a case-sensitive volume the artefact
	// the acquisition builds and the artefact the guard computes from the key are one name, so
	// there is no divergence for the guard to ask about and no artefact stat to fail. The gate
	// skips a row that cannot drive the guard there; it does not skip a question about EACCES
	// propagation, because on such a volume there is no such propagation to cover.
	it.runIf(CASE_FOLDING_VOLUME)(
		"propagates a lock-artefact stat that fails for a reason other than the artefact being absent",
		async () => {
			const dir = await makeDir("lockkey-artefactstat-")
			const lower = path.join(dir, "settings.json")
			const upper = path.join(dir, "SETTINGS.JSON")
			const real = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			// fs.stat is overloaded - bigint stats are their own overload - so the pass-through and the
			// injected variant are built from one rest signature here instead of being asserted at each
			// use. Arguments and results go straight through in both directions.
			const realStatPassThrough = async (
				...args: Parameters<typeof fs.stat>
			): Promise<Awaited<ReturnType<typeof real.stat>>> => await real.stat(...args)
			const injectArtefactStat =
				(fail: () => never) =>
				async (...args: Parameters<typeof fs.stat>): Promise<Awaited<ReturnType<typeof real.stat>>> => {
					if (String(args[0]).endsWith(".lock")) {
						fail()
					}
					return await real.stat(...args)
				}
			const restatingRealpath = async (target: string): Promise<string> => {
				const resolved = await real.realpath(target)
				const parent = path.dirname(resolved)
				const name = path.basename(resolved)
				const listed = await real.readdir(parent).catch(() => [] as string[])
				// Prefer the entry whose name differs from the request in case alone. On a folding
				// filesystem that is the one name the directory stores; on a case-sensitive one the
				// directory holds both spellings and the match has to be pinned to the other one, or the
				// divergence this row is built on would depend on readdir order.
				const stored = listed.find(
					(entry: string) => entry !== name && entry.toLowerCase() === name.toLowerCase(),
				)
				return stored === undefined ? resolved : path.join(parent, stored)
			}
			const probeLower = path.join(dir, "probe.json")
			await real.writeFile(probeLower, "{}")
			const foldsCase = await restatingRealpath(path.join(dir, "PROBE.JSON")).then(
				async (resolved: string) => path.basename(resolved) === path.basename(probeLower),
				() => false,
			)
			await real.rm(probeLower, { force: true })

			// The instrument this row owes its reader. It used to install its own fs and fileLock mocks with
			// vi.doMock and re-import safeWriteJson through vi.resetModules, and it was green on a
			// case-folding filesystem while reporting zero artefact stats on a case-sensitive one. The
			// reason was neither the guard nor the platform: asserted from inside the acquisition double it
			// thought it had installed, the capture came back empty, which means the re-import never used
			// that double and the row was being served by this file's module-level doubles - NTFS's own
			// case restating supplying the divergence, and a real stat supplying the zeros. A row that
			// injects a seam has to assert that the seam ran, because a green row that measures nothing is
			// indistinguishable from a passing test, and that is what happened here. The doubles are the
			// module-level ones now, re-armed for this row, with no resetModules and no re-import, and the
			// capture is asserted first below so a scoping regression cannot go silent again.
			const acquisitionFacts: Array<{ key: string; artefactBuilt: boolean }> = []
			let statCalls = 0
			const refusal = Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" })
			mockedRealpath.mockImplementation(
				async (target: Parameters<typeof fs.realpath>[0]) => await restatingRealpath(String(target)),
			)
			// lstat and readlink pass through for this row. resolvePublishTarget follows aliases through
			// them, and an un-armed double would answer undefined where this row needs the real answer.
			// They reject the way the filesystem rejects, which is the half the comment at the top of this
			// module warns about.
			mockedLstat.mockImplementation(
				async (target: Parameters<typeof fs.lstat>[0]) => await real.lstat(String(target)),
			)
			mockedReadlink.mockImplementation(
				async (target: Parameters<typeof fs.readlink>[0]) => await real.readlink(String(target)),
			)
			mockedAcquireFileLock.mockImplementation(async (file) => {
				// The divergence the guard is asked about, reached the way a writer reaches it: this writer's
				// key keeps the spelling it was computed from, the name the canonicalizer answers for the
				// file appears under it while the lock is held, and the two artefact names are one object by
				// hard link on either lane, so the stat below has a comparison to fail from on either lane.
				// Hard link rather than symlink, for the reason given in the acceptance row above: one object
				// under two names on NTFS and on ext4 alike, with no privilege asked for.
				const ownArtefact = lockPathFor(String(file))
				await real.writeFile(ownArtefact, "")
				await real.writeFile(lower, JSON.stringify({ mcpServers: { peer: true } }))
				if (!foldsCase) {
					await real.link(lower, upper)
					await real.link(ownArtefact, lockPathFor(lower))
				}
				acquisitionFacts.push({
					key: String(file),
					artefactBuilt: await real.stat(ownArtefact).then(
						() => true,
						() => false,
					),
				})
				return async () => {}
			})
			// Only a lock artefact fails, so the EACCES this row reports is the guard's comparison and
			// nowhere else: the write path's own stat calls, which preserve the target mode, keep working.
			mockedStat.mockImplementation(
				injectArtefactStat(() => {
					statCalls++
					throw refusal
				}),
			)

			let error: Error | undefined
			try {
				error = await safeWriteJson(upper, { mcpServers: { mine: true } }).then(
					() => undefined,
					(caught: unknown) => caught as Error,
				)
			} finally {
				// Restored whatever the row concludes, so the injected failure cannot reach another row.
				mockedStat.mockImplementation(realStatPassThrough)
				mockedRealpath.mockReset()
				mockedLstat.mockReset()
				mockedReadlink.mockReset()
				mockedAcquireFileLock.mockReset()
			}

			// The seam ran, and it was handed this writer's spelling. Both facts are about the fixture
			// rather than about the guard, which is why they come before the guard's answer: if a later
			// change stops this row from driving acquisition, it has to say so here instead of turning
			// the count back into a zero that reads like a verdict about the code. On a case-folding
			// filesystem the key arrives restated by the filesystem itself and the writer's spelling is the
			// name the directory already stores; on a case-sensitive one the key keeps the spelling this
			// writer asked in with, and the peer's file is what sits under the other name.
			expect(
				acquisitionFacts.length,
				"the acquisition seam this row injects never ran, so nothing below it was driven by the fixture",
			).toBe(1)
			expect(acquisitionFacts[0].artefactBuilt).toBe(true)
			expect(
				acquisitionFacts.map((fact: { key: string }) => path.basename(fact.key)),
				"acquisition was not asked to lock this writer's spelling, so no divergence reached the guard",
			).toEqual([path.basename(upper)])
			expect(
				statCalls,
				"the guard never put its identity question to the filesystem on this platform",
			).toBeGreaterThan(0)
			expect(String(error && (error as { code?: string }).code)).toBe("EACCES")
			expect(String(error && error.name)).not.toBe("LockKeyDriftError")
			// Fail closed: the writer published nothing, and the file it would have replaced still
			// holds the peer's content.
			expect(JSON.parse(await real.readFile(lower, "utf8"))).toEqual({ mcpServers: { peer: true } })
			expect((await real.readdir(dir)).length).toBe(foldsCase ? 2 : 4)
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
