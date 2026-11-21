import { spawn, spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import { createRequire } from "module"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"

import * as lockfile from "proper-lockfile"

import { acquireFileLock, canonicalLockKey, LOCK_STALE_MS, withFileLock } from "../fileLock"
import { safeWriteJson } from "../safeWriteJson"

vi.mock("proper-lockfile", () => ({ lock: vi.fn() }))

type StatSyncOverride = (
	target: string,
	options?: { bigint?: boolean },
) => { dev: number | bigint; ino: number | bigint }

/**
 * A delegating filesystem double, armed only by the inode-precision suite below. Everything else
 * in this file keeps using the real filesystem, because the wrapper forwards to the actual module
 * whenever no override is installed.
 */
let statSyncOverride: StatSyncOverride | null = null

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	const statSync = ((target: string, options?: unknown) =>
		statSyncOverride === null
			? (actual.statSync as (path: string, opts?: unknown) => unknown)(target, options)
			: statSyncOverride(target, options as { bigint?: boolean } | undefined)) as typeof actual.statSync
	return { ...actual, statSync }
})

/**
 * The paths the cross-process child needs in order to load the production module instead of imitating
 * it. This file and the module sit in the same package, so resolving from this file's own address gives
 * absolute paths without guessing the layout, and the loader is the repository's own `tsx`, resolved the
 * same way the child's copy of `proper-lockfile` is resolved below.
 */
const productionModulePath = path.resolve(fileURLToPath(new URL("../fileLock.ts", import.meta.url)))
const leafSpellingModulePath = path.resolve(fileURLToPath(new URL("../lockLeafSpelling.ts", import.meta.url)))
const productionLoaderUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href

describe("file lock protocol", () => {
	beforeEach(() => vi.clearAllMocks())

	it("allows recovery to outwait staleness with bounded constant retries", async () => {
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {})
		await acquireFileLock("history.json", { waitForStaleLock: true })
		expect(lockfile.lock).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				stale: LOCK_STALE_MS,
				update: 10000,
				realpath: false,
				lockfilePath: path.resolve("history.json") + ".lock",
				retries: { retries: 35, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
			}),
		)
	})

	it("releases the lock when the operation fails", async () => {
		const release = vi.fn(async () => {})
		vi.mocked(lockfile.lock).mockResolvedValue(release)
		const error = new Error("operation failed")
		await expect(
			withFileLock("history.json", async () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(release).toHaveBeenCalledOnce()
	})
})

/**
 * 8.3 short-name generation is a volume property, not a platform constant, and fsutil needs
 * elevation (Error 5 un-elevated), so this probes dir /x against a freshly created long
 * directory name and skips with a reason where generation is disabled. Asserting alias
 * unification on a volume with generation off would produce a green that cannot fail, which is
 * worse than a skip that says what it did. Locally the probe found a short name (A-REAL~1 for a
 * 47-character name) and the alias cases below executed and passed; the linux leg does not
 * execute them. The name is deliberately not passed as a dir argument: dir /x <name> lists that
 * directory's contents, whose header line is the only line containing the name, which reads as
 * generation being off when it is not.
 */
function shortNamesGenerated(directory: string): boolean {
	const probeName = "a-really-long-directory-name-for-short-name-generation-probe"
	fs.mkdirSync(path.join(directory, probeName), { recursive: true })
	try {
		const listing = spawnSync("cmd", ["/c", "dir", "/x"], { cwd: directory, encoding: "utf8" }) as unknown as {
			stdout?: string
		}
		const line =
			String(listing.stdout ?? "")
				.split(/\r?\n/)
				.find((entry) => entry.includes(probeName)) ?? ""
		const fields = line.split(/\s+/).filter((field) => field.length > 0)
		return fields.some((field) => /~\d/.test(field))
	} finally {
		fs.rmSync(path.join(directory, probeName), { recursive: true, force: true })
	}
}

/**
 * The 8.3 alias of a path, read from the dir /x listing of its directory. Used by both the
 * key-equality suite and the real-lock suite below, so it lives at module scope: a volume with
 * generation off returns the long path unchanged, which is why every caller gates on
 * shortNamesGenerated first.
 */
function aliasOf(longPath: string): string {
	const directory = path.dirname(longPath)
	const listing = spawnSync("cmd", ["/c", "dir", "/x"], { cwd: directory, encoding: "utf8" }) as unknown as {
		stdout?: string
	}
	const line =
		String(listing.stdout ?? "")
			.split(/\r?\n/)
			.find((entry) => entry.includes(path.basename(longPath))) ?? ""
	const fields = line.split(/\s+/).filter((field) => field.length > 0)
	const short = fields.find((field) => /~\d/.test(field))
	return short ? path.join(directory, short) : longPath
}

/**
 * A temporary root for one suite, created when that suite runs and removed when it ends,
 * including when a test inside it fails. Creating the root in the describe body left one root
 * and its fixtures on disk for every collection of this file, including runs where the suite's
 * tests were skipped.
 */
function useTemporaryRoot(prefix: string): () => string {
	let root = ""
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	})
	afterAll(() => {
		if (root) {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
	return () => root
}

describe("one lock per file, not one lock per spelling", () => {
	const root = useTemporaryRoot("fileLock-key-")
	let generatesShortNames = false
	// proper-lockfile is mocked, so exclusivity here is a test-side lock table keyed by the exact
	// key acquireFileLock asks for: a key already held rejects with ELOCKED, and immediate: true
	// means retries 0. The property under test is whether two spellings of one file arrive as
	// one key or as two, which is exactly what that table can decide.
	const held: string[] = []
	beforeAll(() => {
		generatesShortNames = process.platform === "win32" && shortNamesGenerated(root())
	})
	beforeEach(() => {
		held.length = 0
		vi.mocked(lockfile.lock).mockImplementation(async (target: unknown) => {
			// The table keys on the key acquireFileLock hands the library: the file's identity, not
			// either spelling. Two spellings of one file therefore arrive as one key, which is what
			// this table can decide; whether they also land on one on-disk artefact is asserted
			// separately, against the real library.
			const key = String(target)
			if (held.indexOf(key) >= 0) {
				throw Object.assign(new Error("ELOCKED: " + key), { code: "ELOCKED" })
			}
			held.push(key)
			return async () => {
				const at = held.indexOf(key)
				if (at >= 0) {
					held.splice(at, 1)
				}
			}
		})
	})
	// The volume probe runs in beforeAll, so the gate is decided when the suite runs rather than
	// when it is collected, and the alias tests skip with a reason instead of disappearing.
	const itAlias = (name: string, fn: () => Promise<void>) =>
		it(name, async (context) => {
			if (!generatesShortNames) {
				return context.skip()
			}
			await fn()
		})
	itAlias("takes one lock for an 8.3 alias and its long form, not a second one", async () => {
		const longDir = path.join(root(), "a-really-long-directory-name-for-alias-lock-testing")
		fs.mkdirSync(longDir, { recursive: true })
		const file = path.join(longDir, "history.json")
		fs.writeFileSync(file, "{}", "utf8")
		const aliasFile = path.join(aliasOf(longDir), "history.json")
		expect(fs.statSync(aliasFile).ino).toBe(fs.statSync(file).ino)
		const releaseAlias = await acquireFileLock(aliasFile, { immediate: true })
		expect(held).toHaveLength(1)
		await expect(acquireFileLock(file, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		expect(canonicalLockKey(aliasFile)).toBe(canonicalLockKey(file))
		await releaseAlias()
	})

	// The portable half of the leaf-spelling coverage. The 8.3 row above needs a volume that hands
	// back two spellings of one entry and the real-library link rows below need a filesystem that
	// lets a leaf be a link; this one needs neither. It substitutes the spelling the volume reports
	// and asserts the artefact acquireFileLock asks the library to create, so dropping the
	// substitution fails here on every platform, not only where a second spelling exists by luck.
	it("names the artefact by the spelling the volume reports for the leaf, not by the caller's", async () => {
		const directory = path.join(root(), "substituted-leaf-lock")
		fs.mkdirSync(directory, { recursive: true })
		const callerPath = path.join(directory, "history-item.json")
		const volumePath = path.join(directory, "HISTORY-ITEM.JSON")
		fs.writeFileSync(callerPath, "{}", "utf8")
		// fs's namespace types these properties read-only, and the module double forwards to the real
		// realpathSync object, so the substitution is installed by reading the callable through a
		// mutable view of it and restoring the original function in the finally below.
		const realpathModule: { native: (target: string) => string } = fs.realpathSync
		const actualNative = realpathModule.native
		try {
			realpathModule.native = (target: string) =>
				target === path.resolve(callerPath) ? volumePath : actualNative(target)
			const release = await acquireFileLock(callerPath, { immediate: true })
			try {
				const call = vi.mocked(lockfile.lock).mock.calls.at(-1)
				expect(call?.[1]?.lockfilePath).toBe(path.join(directory, "HISTORY-ITEM.JSON.lock"))
				expect(String(call?.[0])).toBe(canonicalLockKey(path.resolve(callerPath)))
				expect(fs.existsSync(path.join(directory, "HISTORY-ITEM.JSON.lock"))).toBe(false)
				expect(fs.existsSync(path.join(directory, "history-item.json.lock"))).toBe(false)
			} finally {
				await release()
			}
		} finally {
			realpathModule.native = actualNative
		}
		const after = await acquireFileLock(callerPath, { immediate: true })
		await after()
		expect(vi.mocked(lockfile.lock).mock.calls.at(-1)?.[1]?.lockfilePath).toBe(
			path.join(directory, "history-item.json.lock"),
		)
	})
	itAlias("hands each caller back its own spelling rather than the canonicalised one", async () => {
		const longDir = path.join(root(), "a-really-long-directory-name-for-spelling-control")
		fs.mkdirSync(longDir, { recursive: true })
		const file = path.join(longDir, "history.json")
		fs.writeFileSync(file, "{}", "utf8")
		const aliasFile = path.join(aliasOf(longDir), "history.json")
		expect(fs.statSync(aliasFile).ino).toBe(fs.statSync(file).ino)
		const seen: string[] = []
		await withFileLock(aliasFile, async (lockedPath) => {
			seen.push(lockedPath)
		})
		await withFileLock(file, async (lockedPath) => {
			seen.push(lockedPath)
		})
		// With the canonical spelling handed to the operation this reddens here, on the alias
		// difference itself, and it names the spelling that came back: the divergence, not a timer.
		expect(seen[0]).toBe(path.resolve(aliasFile))
		expect(seen[1]).toBe(path.resolve(file))
		expect(seen[0]).not.toBe(seen[1])
	})
	it("takes separate locks for two different files in one directory", async () => {
		const a = path.join(root(), "a.json")
		const b = path.join(root(), "b.json")
		fs.writeFileSync(a, "{}", "utf8")
		fs.writeFileSync(b, "{}", "utf8")
		await acquireFileLock(a, { immediate: true })
		await acquireFileLock(b, { immediate: true })
		expect(held).toHaveLength(2)
	})
	it("takes one lock for one not-yet-existing path and a different one for another name", async () => {
		const missingA = path.join(root(), "missing-a.json")
		const missingB = path.join(root(), "missing-b.json")
		await acquireFileLock(missingA, { immediate: true })
		await expect(acquireFileLock(missingA, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		await acquireFileLock(missingB, { immediate: true })
		expect(held).toHaveLength(2)
	})
})

/**
 * A link is the portable member of the same class as an 8.3 alias: two spellings of one
 * directory, one referent. Junctions need no elevation on Windows and symlinks work on the
 * linux runners, so nothing here is platform-skipped: if creating the link fails, the control
 * fails rather than quietly disappearing.
 */
describe("two spellings of one referent share one key", () => {
	const root = useTemporaryRoot("fileLock-link-")
	let real = ""
	let link = ""
	beforeAll(() => {
		real = path.join(root(), "real")
		link = path.join(root(), "link")
		fs.mkdirSync(real, { recursive: true })
		fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir")
	})

	it("keys both spellings of a written file to one identity", () => {
		const file = path.join(real, "history.json")
		fs.writeFileSync(file, "{}", "utf8")
		expect(canonicalLockKey(file)).toBe(canonicalLockKey(path.join(link, "history.json")))
	})

	it("keys both spellings of a path that does not exist yet to one identity", () => {
		const missing = path.join("deep", "history.json")
		expect(canonicalLockKey(path.join(real, missing))).toBe(canonicalLockKey(path.join(link, missing)))
	})

	it("hands each spelling back to its own caller unchanged", async () => {
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {})
		const seen: string[] = []
		await withFileLock(path.join(link, "history.json"), async (lockedPath) => {
			seen.push(lockedPath)
		})
		await withFileLock(path.join(real, "history.json"), async (lockedPath) => {
			seen.push(lockedPath)
		})
		expect(seen[0]).toBe(path.resolve(path.join(link, "history.json")))
		expect(seen[1]).toBe(path.resolve(path.join(real, "history.json")))
	})
})

/**
 * The mocked suites above decide key equality and nothing else: the mock keys on the string
 * acquireFileLock hands it and never looks at lockfilePath, so a change that gave two spellings
 * two different on-disk artefacts would have left them green. These delegate the mock to the
 * real library, the way the McpHub settings-creation integration spec does, so the outcome is
 * decided by the artefact the filesystem resolves - which is the mutual-exclusion claim the
 * alias-keyed fix actually makes.
 */
describe("two spellings contend with the real library", () => {
	const root = useTemporaryRoot("fileLock-real-")
	let generatesShortNames = false
	let actualLock: typeof lockfile.lock
	beforeAll(async () => {
		actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
		generatesShortNames = process.platform === "win32" && shortNamesGenerated(root())
	})
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockImplementation((target, options) => actualLock(target, options))
	})

	// Both spellings name one directory once the filesystem resolves them, so the artefacts are
	// one directory and the library refuses the second caller. Asserting that the artefacts
	// share an inode is what pins this down: a placement keyed on the spelling would land two
	// directories here, the second acquire would succeed, and the suite above would stay green.
	async function expectOneLockAcrossSpellings(firstPath: string, secondPath: string): Promise<void> {
		fs.mkdirSync(path.dirname(firstPath), { recursive: true })
		fs.writeFileSync(firstPath, "{}", "utf8")
		const release = await acquireFileLock(firstPath, { immediate: true })
		try {
			expect(fs.existsSync(secondPath + ".lock")).toBe(true)
			expect(fs.statSync(secondPath + ".lock").ino).toBe(fs.statSync(firstPath + ".lock").ino)
			await expect(acquireFileLock(secondPath, { immediate: true })).rejects.toMatchObject({
				code: "ELOCKED",
			})
		} finally {
			await release()
		}
		const released = await acquireFileLock(secondPath, { immediate: true })
		await released()
		expect(fs.existsSync(firstPath + ".lock")).toBe(false)
	}

	it("blocks the other spelling of a junction path while one holds the real lock", async () => {
		const real = path.join(root(), "real")
		const link = path.join(root(), "link")
		fs.mkdirSync(real, { recursive: true })
		fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir")
		await expectOneLockAcrossSpellings(path.join(link, "history.json"), path.join(real, "history.json"))
	})

	it("blocks the other spelling of an 8.3 alias while one holds the real lock", async (context) => {
		if (!generatesShortNames) {
			return context.skip()
		}
		const longDir = path.join(root(), "a-really-long-directory-name-for-real-lock-alias-testing")
		fs.mkdirSync(longDir, { recursive: true })
		const file = path.join(longDir, "history.json")
		fs.writeFileSync(file, "{}", "utf8")
		const aliasFile = path.join(aliasOf(longDir), "history.json")
		expect(fs.statSync(aliasFile).ino).toBe(fs.statSync(file).ino)
		await expectOneLockAcrossSpellings(aliasFile, file)
	})

	// The two rows above alias a directory: once the filesystem resolves the two spellings the
	// artefacts are one directory no matter what the artefact is named by. These two spellings differ
	// in the final component only, so the spelling the artefact name is built from is what decides
	// whether the callers contend. A placement that concatenates the caller's own leaf spelling lands
	// two artefacts here, lets the second caller through, and leaves every mocked suite above green -
	// which is why this one delegates to the real library and asserts the artefact directory too.
	it("blocks the other spelling of an 8.3 alias of the leaf while one holds the real lock", async (context) => {
		if (!generatesShortNames) {
			return context.skip()
		}
		const directory = path.join(root(), "leaf-alias-lock")
		fs.mkdirSync(directory, { recursive: true })
		const longLeaf = path.join(directory, "task-history-leaf-for-alias-lock-testing.json")
		fs.writeFileSync(longLeaf, "{}", "utf8")
		const aliasLeaf = aliasOf(longLeaf)
		expect(aliasLeaf).not.toBe(longLeaf)
		expect(fs.statSync(aliasLeaf).ino).toBe(fs.statSync(longLeaf).ino)
		const release = await acquireFileLock(aliasLeaf, { immediate: true })
		try {
			expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([
				"task-history-leaf-for-alias-lock-testing.json.lock",
			])
			await expect(acquireFileLock(longLeaf, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		} finally {
			await release()
		}
		const released = await acquireFileLock(longLeaf, { immediate: true })
		await released()
		expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([])
	})

	// The rows above alias a directory, and on ext4 a case variant is a different file and an 8.3 alias
	// does not exist, so the only way the final component is spelled more than one way on the linux arm
	// is a leaf that is itself a link. These two rows are the linux arm's version of the two rows above,
	// gated the other way round: they run where the 8.3 rows skip and skip where they run.
	const itPosixLeaf = (name: string, fn: () => Promise<void>) =>
		it(name, async (context) => {
			if (process.platform === "win32") {
				return context.skip()
			}
			await fn()
		})

	itPosixLeaf(
		"blocks the target of a link while the link holds the real lock, on one artefact named by the target",
		async () => {
			const directory = path.join(root(), "link-leaf-lock")
			fs.mkdirSync(directory, { recursive: true })
			const target = path.join(directory, "history.json")
			fs.writeFileSync(target, "{}", "utf8")
			const link = path.join(directory, "history-link.json")
			fs.symlinkSync("history.json", link)
			expect(fs.statSync(link).ino).toBe(fs.statSync(target).ino)
			const release = await acquireFileLock(link, { immediate: true })
			try {
				expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([
					"history.json.lock",
				])
				await expect(acquireFileLock(target, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
			} finally {
				await release()
			}
			const released = await acquireFileLock(target, { immediate: true })
			await released()
			expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([])
		},
	)

	itPosixLeaf("keeps a link's artefact in the caller's directory when its target lives elsewhere", async () => {
		const directory = path.join(root(), "far-link-lock")
		const elsewhere = path.join(root(), "far-link-target")
		fs.mkdirSync(directory, { recursive: true })
		fs.mkdirSync(elsewhere, { recursive: true })
		const target = path.join(elsewhere, "history.json")
		fs.writeFileSync(target, "{}", "utf8")
		const link = path.join(directory, "history-link.json")
		fs.symlinkSync(target, link)
		const release = await acquireFileLock(link, { immediate: true })
		try {
			expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual(["history.json.lock"])
			expect(fs.readdirSync(elsewhere).filter((name) => name.endsWith(".lock"))).toEqual([])
			const besideTarget = await acquireFileLock(target, { immediate: true })
			await besideTarget()
		} finally {
			await release()
		}
		expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([])
		expect(fs.readdirSync(elsewhere).filter((name) => name.endsWith(".lock"))).toEqual([])
	})

	// The row above proves the artefact lands in the caller's directory. It does not prove what
	// happens when the caller's own directory already holds a file with the target's name, and that
	// collision is not hypothetical - it is what the lock does. The sibling is a different inode with
	// its own content and its own canonical key, and it still contends on the one artefact name the
	// volume spelling hands both of them.
	itPosixLeaf("contends an unrelated sibling named like the link target against the link's lock", async () => {
		const directory = path.join(root(), "sibling-collision")
		const elsewhere = path.join(root(), "sibling-target")
		fs.mkdirSync(directory, { recursive: true })
		fs.mkdirSync(elsewhere, { recursive: true })
		const target = path.join(elsewhere, "history.json")
		fs.writeFileSync(target, JSON.stringify({ writer: "target" }), "utf8")
		const link = path.join(directory, "history-link.json")
		fs.symlinkSync(target, link)
		const sibling = path.join(directory, "history.json")
		fs.writeFileSync(sibling, JSON.stringify({ writer: "sibling" }), "utf8")
		expect(fs.realpathSync.native(link)).toBe(fs.realpathSync.native(target))
		expect(fs.statSync(sibling).ino).not.toBe(fs.statSync(link).ino)
		expect(canonicalLockKey(link)).not.toBe(canonicalLockKey(sibling))
		const release = await acquireFileLock(link, { immediate: true })
		try {
			expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual(["history.json.lock"])
			await expect(acquireFileLock(sibling, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		} finally {
			await release()
		}
		const afterRelease = await acquireFileLock(sibling, { immediate: true })
		await afterRelease()
		expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([])
		expect(fs.readdirSync(elsewhere).filter((name) => name.endsWith(".lock"))).toEqual([])
	})

	// A leaf link replaced while a second writer queues is the case the persistence-integrity check
	// asked for. The contract it has to assert is the one the filesystem offers: convergence happens
	// inside one directory, so the artefact directory does not follow the target. Both artefacts are
	// named here, the queue is observed at the caller-named one, and the merged content is read back
	// from both coexisting targets - constructed as two live files with two live caller paths, and the
	// replacement is an atomic rename of a freshly created link over the old one, so no recycled inode
	// is load-bearing.
	itPosixLeaf(
		"keeps a waiting writer at the caller-named artefact across a leaf-link replacement, and merges into the referent that answers when it proceeds",
		async () => {
			const readMerged = (target: string): { merge: string; writer?: string } =>
				JSON.parse(fs.readFileSync(target, "utf8")) as { merge: string; writer?: string }
			const callerDir = path.join(root(), "retarget-caller")
			const targetDir = path.join(root(), "retarget-target")
			fs.mkdirSync(callerDir, { recursive: true })
			fs.mkdirSync(targetDir, { recursive: true })
			const firstTarget = path.join(targetDir, "history.json")
			fs.writeFileSync(firstTarget, JSON.stringify({ merge: "first" }), "utf8")
			const secondTarget = path.join(callerDir, "history-content.json")
			fs.writeFileSync(secondTarget, JSON.stringify({ merge: "second" }), "utf8")
			const callerPath = path.join(callerDir, "history.json")
			fs.symlinkSync(firstTarget, callerPath)
			const callerArtefact = path.join(callerDir, "history.json.lock")
			const targetArtefact = path.join(targetDir, "history.json.lock")
			let releaseFirst: (() => Promise<void>) | null = null
			let releaseSecond: (() => Promise<void>) | null = null
			let waitingSeen = "not started"
			try {
				releaseFirst = await acquireFileLock(callerPath, { immediate: true })
				const firstBase = readMerged(callerPath)
				fs.writeFileSync(callerPath, JSON.stringify({ ...firstBase, writer: "first" }), "utf8")
				expect(fs.existsSync(callerArtefact)).toBe(true)
				const throughTarget = await acquireFileLock(firstTarget, { immediate: true })
				expect(fs.existsSync(targetArtefact)).toBe(true)
				await throughTarget()
				const waitingWriter = acquireFileLock(callerPath)
				waitingSeen = await Promise.race([
					waitingWriter.then(() => "settled while the first writer still held"),
					new Promise<string>((resolve) => {
						setTimeout(() => resolve("still queued"), 300)
					}),
				])
				const replacement = path.join(callerDir, "history.json.next")
				fs.symlinkSync(secondTarget, replacement)
				fs.renameSync(replacement, callerPath)
				await releaseFirst()
				releaseFirst = null
				releaseSecond = await waitingWriter
				expect(fs.readdirSync(callerDir).filter((name) => name.endsWith(".lock"))).toEqual([
					"history.json.lock",
				])
				const secondBase = readMerged(callerPath)
				fs.writeFileSync(callerPath, JSON.stringify({ ...secondBase, writer: "second" }), "utf8")
			} finally {
				if (releaseFirst !== null) {
					await releaseFirst()
				}
				if (releaseSecond !== null) {
					await releaseSecond()
				}
			}
			expect(waitingSeen).toBe("still queued")
			expect(fs.existsSync(callerArtefact)).toBe(false)
			expect(fs.existsSync(targetArtefact)).toBe(false)
			expect(readMerged(firstTarget)).toEqual({ merge: "first", writer: "first" })
			expect(readMerged(secondTarget)).toEqual({ merge: "second", writer: "second" })
		},
	)

	// The third pre-merge row asks about overlapping acquisitions and releases, and about one library key
	// owning two different artefacts at once. Measured before asserting: an acquisition that arrives at an
	// artefact another key already holds rejects ELOCKED - on this volume the artefact carries the lock, so
	// a second key cannot fork a second lock onto it - and a release called a second time, after another
	// writer has taken the artefact, rejects ERELEASED and leaves that writer's artefact where it is. Each
	// writer then releases through the function it was handed, and neither directory is left holding one.
	itPosixLeaf("refuses a second key on a held artefact, and a late release from the writer that let go", async () => {
		const directory = path.join(root(), "release-order")
		const elsewhere = path.join(root(), "release-target")
		fs.mkdirSync(directory, { recursive: true })
		fs.mkdirSync(elsewhere, { recursive: true })
		const target = path.join(elsewhere, "history.json")
		fs.writeFileSync(target, JSON.stringify({ writer: "target" }), "utf8")
		const link = path.join(directory, "history-link.json")
		fs.symlinkSync(target, link)
		const sibling = path.join(directory, "history.json")
		fs.writeFileSync(sibling, JSON.stringify({ writer: "sibling" }), "utf8")
		expect(canonicalLockKey(link)).not.toBe(canonicalLockKey(sibling))
		// Ownership is tracked before anything is acquired: if the assertion below fails between
		// taking the link lock and releasing it, the release still has to run, because teardown
		// removes the lock directory and a renewal timer still armed on it raises ECOMPROMISED
		// inside some later row.
		let releaseLink: (() => Promise<void>) | null = null
		let linkReleased = false
		let releaseSibling: (() => Promise<void>) | null = null
		try {
			releaseLink = await acquireFileLock(link, { immediate: true })
			await expect(acquireFileLock(sibling, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
			const queued = acquireFileLock(sibling)
			await releaseLink()
			linkReleased = true
			releaseSibling = await queued
			await expect(releaseLink()).rejects.toMatchObject({ code: "ERELEASED" })
			expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual(["history.json.lock"])
		} finally {
			if (releaseSibling !== null) {
				await releaseSibling()
			}
			if (releaseLink !== null && !linkReleased) {
				await releaseLink()
			}
		}
		expect(fs.readdirSync(directory).filter((name) => name.endsWith(".lock"))).toEqual([])
		expect(fs.readdirSync(elsewhere).filter((name) => name.endsWith(".lock"))).toEqual([])
	})
})

/**
 * The identity is a string built from device and inode, and node hands those over as plain numbers
 * unless asked otherwise. Above 2^53 an inode is no longer a distinct number - 17451448568457636
 * and 17451448568457637 are adjacent integers and one double - so the identity has to be read with
 * `{ bigint: true }` or two neighbouring directories collapse into one key and one lock.
 *
 * The double is the row: it answers a plain stat with **rounded numbers**, the way node does, and
 * hands back BigInts only when the caller asks for them. A double that returned BigInts
 * unconditionally would read green before the fix and prove nothing about the numeric path.
 */
describe("identity keeps inodes above 2^53 distinct", () => {
	const inodeLow = 17451448568457636n
	const inodeHigh = 17451448568457637n
	const dev = 7n
	// Two existing directories one inode apart, each holding a file of the same name, so the only
	// thing that can separate the two keys is the inode the identity is built from. These paths are
	// synthetic - the fake statSync answers for them - so nothing is created on disk.
	const precisionRoot = path.resolve("zoo-identity-precision")
	const directoryLow = path.join(precisionRoot, "a")
	const directoryHigh = path.join(precisionRoot, "b")

	let statCalls: Array<{ target: string; bigintRequested: boolean }> = []
	beforeEach(() => {
		statCalls = []
		statSyncOverride = (target, options) => {
			const bigintRequested = options?.bigint === true
			statCalls.push({ target, bigintRequested })
			const ino = target === directoryLow ? inodeLow : target === directoryHigh ? inodeHigh : 1n
			// Fidelity: BigInts only when they were asked for, rounded numbers otherwise.
			return bigintRequested ? { dev, ino } : { dev: Number(dev), ino: Number(ino) }
		}
	})
	afterEach(() => {
		statSyncOverride = null
	})

	it("pairs the adjacent inodes named by the precision loss", () => {
		expect(Number(inodeLow)).toBe(Number(inodeHigh))
		expect(String(inodeLow)).not.toBe(String(inodeHigh))
	})

	it("keys two directories one inode apart above 2^53 by different identities", () => {
		const low = canonicalLockKey(path.join(directoryLow, "history.json"))
		const high = canonicalLockKey(path.join(directoryHigh, "history.json"))
		expect(low).not.toBe(high)
	})

	it("asks the filesystem for the identity in bigint form", () => {
		canonicalLockKey(path.join(directoryLow, "history.json"))
		expect(statCalls.some((call) => call.bigintRequested)).toBe(true)
	})

	// The identity and the surviving components are joined with a separator, and a separator is only
	// decoration until two widths concatenate alike: device 1 inode 23 and device 12 inode 3 build the
	// same digit run, and device 1 inode 2 followed by a file named 3history.json builds the same run as
	// device 1 inode 23 followed by history.json. These paths are synthetic - the fake statSync answers
	// for them - and the doubles return plain numbers for both spellings because the row is about widths,
	// not about the bigint read the row above already pins, so the only thing that can keep the three
	// keys apart is the separator the unit composes them with.
	it("keeps identities whose digits concatenate alike apart", () => {
		const directoryWide = path.join(precisionRoot, "wide")
		const directoryWideConcat = path.join(precisionRoot, "wide-concat")
		const directoryShift = path.join(precisionRoot, "shift")
		statSyncOverride = (target) => {
			const fabricated: Record<string, { dev: number; ino: number }> = {
				[directoryWide]: { dev: 1, ino: 23 },
				[directoryWideConcat]: { dev: 12, ino: 3 },
				[directoryShift]: { dev: 1, ino: 2 },
			}
			return fabricated[path.resolve(target)] ?? { dev: 1, ino: 99 }
		}
		const wide = canonicalLockKey(path.join(directoryWide, "history.json"))
		const sameConcat = canonicalLockKey(path.join(directoryWideConcat, "history.json"))
		const shifted = canonicalLockKey(path.join(directoryShift, "3history.json"))
		expect(wide).not.toBe(sameConcat)
		expect(wide).not.toBe(shifted)
		expect(sameConcat).not.toBe(shifted)
	})

	// Every ancestor missing is the fall-through at the end of nearestExistingDirectory, and that is the
	// only way to reach the fallback that hands back the caller's own path: with no identity anywhere the
	// key has to be the resolved path, because nothing on the filesystem has answered with an identity to
	// build one from. Mutating that fall-through's return to an empty object is equivalent here - an
	// undefined directory statSyncs to null and lands on the same fallback - so this row covers the line
	// without killing that mutant, and says so rather than claiming a kill.
	it("falls back to the caller's own path when no ancestor has an identity", () => {
		statSyncOverride = () => {
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		}
		const uncreated = path.resolve(path.join(precisionRoot, "uncreated", "nested", "history.json"))
		expect(canonicalLockKey(uncreated)).toBe(uncreated)
	})
})
/**
 * A second OS process contending for the same artefact, run by the suite below against the real lock
 * library with no mocks. The mocked suites above can only model contention inside one process: they
 * hand `proper-lockfile` a function of the test's making, so a second caller is refused because a
 * table says so, not because a directory on disk already exists. What is under test here is whether
 * the module and another process land on one and the same path, since the library implements mutual
 * exclusion by `mkdir` on `lockfilePath` and reports `ELOCKED` when that path is already there, so
 * two spellings that produced two artefacts would let both writers in and no assertion in this file
 * would notice.
 *
 * The child is a script inside a template literal that the parent runs through the repository's own
 * TypeScript loader, `node --input-type=module --import <tsx> -e <script>`, and it then imports the
 * production `fileLock.ts` and calls its `acquireFileLock`. Plain node cannot load that file from a
 * child: it fails with ERR_MODULE_NOT_FOUND on the extensionless
 * `../core/task-persistence/persistenceTrace` import, which is the module's own import chain. Measured
 * at this head with the loader registered, the import resolves, so the staleness window, the retry
 * shape, the lock key and the artefact spelling all come from the module rather than from this script,
 * and the artefact the child reports is the one produced by the same `canonicalLeafSpelling` call the
 * module makes. The negative control below deliberately opts out with `DSH_LOCK_NAIVE`, drives the
 * library itself and names the artefact by the caller's own spelling, which is the behaviour that
 * control exists to show.
 *
 * The handshake is a trace file the child appends to synchronously, not its stdout. Node writes to a
 * piped stdout asynchronously, including on Windows, so a child that ends the process can lose the
 * lines it wrote a moment before: that is what the first version of this suite did, and it failed on
 * an empty buffer rather than on the lock. `appendFileSync` cannot be truncated that way, and the
 * child sets `process.exitCode` instead of calling `process.exit`, so nothing is cut off at all.
 * The exported `lock` of proper-lockfile 4.1.2 is its promise wrapper, measured at this head in
 * `index.js`: `module.exports = lock` over `async function lock(file, options)`, which takes no callback,
 * so a callback passed as a third argument is dropped without a word and the child would sit forever
 * holding a lock it never told anyone about. The child therefore awaits it, which is the same shape
 * `fileLock.ts` itself awaits, and it awaits the module's `acquireFileLock` the same way.
 */
const HOLDER_SCRIPT = `import { pathToFileURL } from "url"
const fs = await import("fs")
const path = await import("path")
const { createRequire } = await import("module")
const spelling = process.env.DSH_LOCK_SPELLING
const trace = process.env.DSH_LOCK_TRACE
const holdMs = Number(process.env.DSH_LOCK_HOLD_MS || 0)
const retries = Number(process.env.DSH_LOCK_RETRIES || 0)
const retryMs = Number(process.env.DSH_LOCK_RETRY_MS || 250)
const doneFile = process.env.DSH_LOCK_DONE_FILE || ""
const baseMode = process.env.DSH_LOCK_BASE
const writeKey = process.env.DSH_LOCK_WRITE_KEY || ""
const naive = process.env.DSH_LOCK_NAIVE === "1"
function traceLine(line) {
	fs.appendFileSync(trace, line + "\\n", "utf8")
}
function readBody(target) {
	try {
		return JSON.parse(fs.readFileSync(target, "utf8"))
	} catch {
		return {}
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
// The production module, loaded through the loader the parent registered, so the staleness window, the
// lock key and the artefact spelling are the module's and not this script's. The naive control is the
// one shape that must not import it: it names the artefact by the caller's own spelling and drives the
// library directly, which is the behaviour that control exists to show.
const leafSpelling = naive ? null : await import(pathToFileURL(process.env.DSH_LOCK_SPELLING_MODULE_TS).href)
const production = naive ? null : await import(pathToFileURL(process.env.DSH_LOCK_MODULE_TS).href)
const absolute = path.resolve(spelling)
let artefact
if (naive) {
	artefact = path.join(path.dirname(spelling), path.basename(spelling)) + ".lock"
} else {
	const canonical = leafSpelling.canonicalLeafSpelling(absolute)
	artefact = path.join(path.dirname(canonical), path.basename(canonical)) + ".lock"
}
traceLine("ARTEFACT " + artefact)
const staleBase = baseMode === "before" ? readBody(spelling) : null
if (baseMode === "before") {
	traceLine("BASE-BEFORE " + JSON.stringify(staleBase))
}
async function naiveAcquire() {
	const requireFromChild = createRequire(path.join(path.dirname(trace), "holder.cjs"))
	const lockfile = requireFromChild(process.env.DSH_LOCK_MODULE)
	const releaseNaive = await lockfile.lock(process.env.DSH_LOCK_KEY, {
		lockfilePath: artefact,
		stale: Number(process.env.DSH_LOCK_STALE_MS),
		update: 10000,
		realpath: false,
		retries: 0,
	})
	if (typeof releaseNaive !== "function") {
		const notARelease = new Error("the library resolved to something other than a release function")
		notARelease.code = "no-release-function"
		throw notARelease
	}
	return releaseNaive
}
let release = null
let attempt = 0
let refusal = ""
while (release === null) {
	attempt += 1
	traceLine("ATTEMPT " + attempt)
	try {
		release = naive ? await naiveAcquire() : await production.acquireFileLock(absolute, { immediate: true })
	} catch (error) {
		refusal = String(error && error.code)
		traceLine("REFUSED " + refusal)
		if (attempt > retries) {
			traceLine("OUTCOME failed " + refusal)
			process.exitCode = 1
			break
		}
		await sleep(retryMs)
	}
}
if (release !== null) {
	traceLine("OUTCOME held")
	if (writeKey) {
		const base = baseMode === "before" ? staleBase : readBody(spelling)
		traceLine(baseMode === "before" ? "BASE-USED " + JSON.stringify(base) : "BASE-UNDER-LOCK " + JSON.stringify(base))
		const merged = Object.assign({}, base)
		merged[writeKey] = 1
		fs.writeFileSync(spelling, JSON.stringify(merged), "utf8")
		traceLine("WROTE " + JSON.stringify(readBody(spelling)))
	}
	const startedAt = Date.now()
	if (holdMs > 0 || doneFile !== "") {
		traceLine("HOLDING " + String(holdMs))
		// Either the parent signals that its assertions are finished, or the ceiling it was handed runs
		// out, and the trace names which of the two let go.
		for (;;) {
			if (doneFile !== "" && fs.existsSync(doneFile)) {
				traceLine("ASSERTIONS-DONE " + String(Date.now() - startedAt))
				break
			}
			if (holdMs > 0 && Date.now() - startedAt >= holdMs) {
				traceLine("HOLD-EXPIRED " + String(Date.now() - startedAt))
				break
			}
			await sleep(25)
		}
	}
	try {
		await release()
		traceLine("RELEASED")
	} catch (releaseError) {
		traceLine("RELEASE-FAILED " + String(releaseError.code))
		process.exitCode = 1
	}
}`
interface HolderHandle {
	pid: number | undefined
	tracePath: string
	donePath: string
	childOutput: () => string
	/** Tell the child its lock may go; it waits for this file to appear before releasing. */
	signalRelease: () => void
	waitForExit: () => Promise<number | null>
}

interface HolderOptions {
	/** Milliseconds to hold before releasing; overrides the mode default, and with waitForAssertions
	 * it is the ceiling the child falls back on rather than the moment it lets go. */
	holdMs?: number
	/** A key the child merges into the file under its own lock; empty means no write. */
	writeKey?: string
	/** Where the child reads the base it merges into: after admission, or before it ever tried. */
	baseMode?: "under" | "before"
	/** Attempts the child makes before reporting the lock refused, so it can be the writer that has to wait. */
	retries?: number
	/** Milliseconds between the child's attempts. */
	retryMs?: number
	/** Keep the lock until this process calls signalRelease, so the assertions run under the other
	 * process's lock rather than under a timeout this row happened to win. */
	waitForAssertions?: boolean
}

/**
 * Start the other process. `mode: "try"` asks it to take the lock and end, which is what a contention
 * assertion needs; `mode: "hold"` makes it hold for six seconds so the suite can assert from this
 * process that a live foreign holder is enough to keep the module out. The options turn the same child
 * into the two shapes the persistence and lifecycle rows need: a writer that lands while others queue,
 * and a writer that has to queue behind a lock this process is holding. With waitForAssertions the
 * child keeps its own lock until this process signals, so an assertion in a row below runs while the
 * foreign holder still holds rather than after a timer released it.
 */
function startLockHolder(
	spelling: string,
	mode: "try" | "hold",
	lockModule: string,
	directory: string,
	traceName: string,
	naive = false,
	options: HolderOptions = {},
): HolderHandle {
	const tracePath = path.join(directory, traceName)
	const donePath = path.join(directory, traceName + ".done")
	// The loader argument is what makes the production import resolvable in a child at all; without it
	// the module's extensionless import chain fails before the child can call anything.
	const child = spawn(
		process.execPath,
		["--input-type=module", "--import", productionLoaderUrl, "-e", HOLDER_SCRIPT],
		{
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				NO_COLOR: "1",
				DSH_LOCK_MODULE: lockModule,
				DSH_LOCK_MODULE_TS: productionModulePath,
				DSH_LOCK_SPELLING_MODULE_TS: leafSpellingModulePath,
				DSH_LOCK_STALE_MS: String(LOCK_STALE_MS),
				DSH_LOCK_SPELLING: spelling,
				DSH_LOCK_TRACE: tracePath,
				DSH_LOCK_HOLD_MS: String(options.holdMs ?? (mode === "hold" ? 6000 : 0)),
				DSH_LOCK_RETRIES: String(options.retries ?? 0),
				DSH_LOCK_RETRY_MS: String(options.retryMs ?? 250),
				DSH_LOCK_BASE: options.baseMode ?? "under",
				DSH_LOCK_WRITE_KEY: options.writeKey ?? "",
				DSH_LOCK_NAIVE: naive ? "1" : "0",
				DSH_LOCK_KEY: canonicalLockKey(path.resolve(spelling)),
				DSH_LOCK_DONE_FILE: options.waitForAssertions === true ? donePath : "",
			},
		},
	)
	let output = ""
	const note = (chunk: string): void => {
		output += chunk
	}
	if (child.stdout) {
		child.stdout.setEncoding("utf8")
		child.stdout.on("data", note)
	}
	if (child.stderr) {
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", note)
	}
	return {
		pid: child.pid,
		tracePath,
		donePath,
		childOutput: () => (output.length > 400 ? output.slice(-400) : output),
		signalRelease: () => {
			fs.writeFileSync(donePath, "", "utf8")
		},
		waitForExit: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) {
					resolve(child.exitCode)
					return
				}
				child.once("close", (code) => resolve(code))
			}),
	}
}

/** Read one line of the child's trace file, waiting at most `timeoutMs` for it to appear. */
async function readHolderTrace(
	tracePath: string,
	marker: string,
	timeoutMs: number,
	childOutput: () => string,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		let content = ""
		try {
			content = fs.readFileSync(tracePath, "utf8")
		} catch {
			content = ""
		}
		const hit = content.split("\n").find((line) => line.startsWith(marker))
		if (hit) {
			return hit.trim()
		}
		if (Date.now() > deadline) {
			throw new Error(
				`no "${marker}" in ${tracePath} within ${timeoutMs} ms; trace was ${JSON.stringify(content)} and the child said ${JSON.stringify(childOutput())}`,
			)
		}
		await new Promise((sleep) => setTimeout(sleep, 25))
	}
}

function traceArtefact(traceLineText: string): string {
	const hit = traceLineText.match(/ARTEFACT (.+)/)
	if (!hit) {
		throw new Error(`the child never reported an artefact path; trace line was ${JSON.stringify(traceLineText)}`)
	}
	return hit[1].trim()
}

function traceOutcome(traceLineText: string): string {
	const hit = traceLineText.match(/OUTCOME (\S+)(?: (\S+))?/)
	if (!hit) {
		throw new Error(`the child never reported an acquire outcome; trace line was ${JSON.stringify(traceLineText)}`)
	}
	return hit[2] ? hit[1] + " " + hit[2] : hit[1]
}

function artefactsOf(directory: string): string[] {
	return fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(".lock"))
		.sort()
}

describe("another process contends for the same artefact", () => {
	const root = useTemporaryRoot("fileLock-crossproc-")
	let actualLock: typeof lockfile.lock
	let lockModule = ""
	let generatesShortNames = false
	let traceIndex = 0
	beforeAll(async () => {
		actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
		// The child requires the library by path: it runs with no module resolution context of its own.
		lockModule = createRequire(import.meta.url).resolve("proper-lockfile")
		generatesShortNames = process.platform === "win32" && shortNamesGenerated(root())
	})
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockImplementation((target, options) => actualLock(target, options))
	})

	function scenario(name: string): { directory: string; target: string } {
		const directory = path.join(root(), name)
		fs.mkdirSync(directory, { recursive: true })
		const target = path.join(directory, "history.json")
		fs.writeFileSync(target, "{}", "utf8")
		return { directory, target }
	}

	function nextTraceName(): string {
		traceIndex += 1
		return `holder-trace-${traceIndex}.txt`
	}

	it(
		"refuses a second process that arrives by the same spelling while the module holds",
		{ timeout: 30000 },
		async () => {
			const { directory, target } = scenario("same-spelling-held")
			const release = await acquireFileLock(target, { immediate: true })
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			const holder = startLockHolder(target, "try", lockModule, directory, nextTraceName())
			const artefactLine = await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceArtefact(artefactLine)).toBe(path.join(directory, "history.json.lock"))
			expect(traceOutcome(outcomeLine)).toBe("failed ELOCKED")
			expect(await holder.waitForExit()).toBe(1)
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			await release()
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	it(
		"keeps this process out while another process holds, and admits it once that process ends",
		{ timeout: 30000 },
		async () => {
			const { directory, target } = scenario("same-spelling-free")
			const holder = startLockHolder(target, "hold", lockModule, directory, nextTraceName())
			await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceOutcome(outcomeLine)).toBe("held")
			if (typeof holder.pid !== "number") {
				throw new Error(
					`the holder child never reported a pid; it said ${JSON.stringify(holder.childOutput())}`,
				)
			}
			expect(process.kill(holder.pid, 0)).toBe(true)
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			await expect(acquireFileLock(target, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
			expect(await holder.waitForExit()).toBe(0)
			const traceNow = fs.readFileSync(holder.tracePath, "utf8")
			expect(traceNow.split("\n")).toContain("RELEASED")
			expect(artefactsOf(directory)).toEqual([])
			const admitted = await acquireFileLock(target, { immediate: true })
			await admitted()
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	const itWindowsLeafAlias = (name: string, fn: () => Promise<void>) =>
		it(name, { timeout: 30000 }, async (context) => {
			if (!generatesShortNames) {
				return context.skip()
			}
			await fn()
		})

	itWindowsLeafAlias(
		"refuses a second process arriving by the 8.3 alias of the leaf while the module holds the alias",
		async () => {
			const directory = path.join(root(), "leaf-alias-crossproc")
			fs.mkdirSync(directory, { recursive: true })
			const longLeaf = path.join(directory, "task-history-leaf-for-crossproc-alias-testing.json")
			fs.writeFileSync(longLeaf, "{}", "utf8")
			const aliasLeaf = aliasOf(longLeaf)
			expect(aliasLeaf).not.toBe(longLeaf)
			const release = await acquireFileLock(aliasLeaf, { immediate: true })
			const placed = ["task-history-leaf-for-crossproc-alias-testing.json.lock"]
			expect(artefactsOf(directory)).toEqual(placed)
			const holder = startLockHolder(aliasLeaf, "try", lockModule, directory, nextTraceName())
			const artefactLine = await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceArtefact(artefactLine)).toBe(path.join(directory, placed[0]))
			expect(traceOutcome(outcomeLine)).toBe("failed ELOCKED")
			expect(await holder.waitForExit()).toBe(1)
			expect(artefactsOf(directory)).toEqual(placed)
			await release()
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	// The negative control for the alias case above. Name the artefact by the caller's own spelling, the
	// way a module that never consulted the volume would, and this same pair of writers lands on two
	// artefacts and both get in. That is the shape the bots described, and it is the spelling rule that
	// keeps it out of the suite; if the module ever fell back to the caller's spelling the case below would
	// go red rather than pass for the wrong reason.
	itWindowsLeafAlias(
		"lets a second process in when the artefact is named by the caller's spelling instead of the volume's",
		async () => {
			const directory = path.join(root(), "leaf-alias-crossproc-control")
			fs.mkdirSync(directory, { recursive: true })
			const longLeaf = path.join(directory, "task-history-leaf-for-crossproc-control-testing.json")
			fs.writeFileSync(longLeaf, "{}", "utf8")
			const aliasLeaf = aliasOf(longLeaf)
			expect(aliasLeaf).not.toBe(longLeaf)
			const release = await acquireFileLock(aliasLeaf, { immediate: true })
			expect(artefactsOf(directory)).toEqual(["task-history-leaf-for-crossproc-control-testing.json.lock"])
			// Hold, rather than take-and-release, so that both artefacts are on disk at the moment of looking.
			const holder = startLockHolder(aliasLeaf, "hold", lockModule, directory, nextTraceName(), true)
			const artefactLine = await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			const callerNamed = (path.basename(aliasLeaf) + ".lock").toLowerCase()
			const moduleNamed = "task-history-leaf-for-crossproc-control-testing.json.lock"
			expect(traceArtefact(artefactLine).toLowerCase()).toBe(path.join(directory, callerNamed).toLowerCase())
			expect(callerNamed).not.toBe(moduleNamed)
			expect(traceOutcome(outcomeLine)).toBe("held")
			expect(
				artefactsOf(directory)
					.map((name) => name.toLowerCase())
					.sort(),
			).toEqual([callerNamed, moduleNamed].sort())
			expect(await holder.waitForExit()).toBe(0)
			expect(fs.readFileSync(holder.tracePath, "utf8").split("\n")).toContain("RELEASED")
			await release()
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	const itPosixLeaf = (name: string, fn: () => Promise<void>) =>
		it(name, { timeout: 30000 }, async (context) => {
			if (process.platform === "win32") {
				return context.skip()
			}
			await fn()
		})

	itPosixLeaf(
		"refuses a second process arriving by the target of a link while the module holds the link",
		async () => {
			const directory = path.join(root(), "link-leaf-crossproc")
			fs.mkdirSync(directory, { recursive: true })
			const target = path.join(directory, "history.json")
			fs.writeFileSync(target, "{}", "utf8")
			const link = path.join(directory, "history-link.json")
			fs.symlinkSync("history.json", link)
			const release = await acquireFileLock(link, { immediate: true })
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			const holder = startLockHolder(link, "try", lockModule, directory, nextTraceName())
			const artefactLine = await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceArtefact(artefactLine)).toBe(path.join(directory, "history.json.lock"))
			expect(traceOutcome(outcomeLine)).toBe("failed ELOCKED")
			expect(await holder.waitForExit()).toBe(1)
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			await release()
			expect(artefactsOf(directory)).toEqual([])
		},
	)
})

/**
 * A shallow merge of two decoded JSON bodies: the shape every merge callback below hands
 * `safeWriteJson`, and the shape the child script performs with `Object.assign`. The one assertion is
 * the step the guard cannot make for TypeScript - an `unknown` that passed `typeof value === "object"`
 * is still not a record, and an array would spread into numeric keys rather than into nothing.
 */
const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const mergeRecords = (existing: unknown, incoming: unknown): unknown => ({
	...asRecord(existing),
	...asRecord(incoming),
})

/** Merge one key into a JSON file, onto whatever the file holds at the moment of writing. */
function writeMergedKey(filePath: string, key: string): void {
	const base = asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")))
	fs.writeFileSync(filePath, JSON.stringify({ ...base, [key]: 1 }), "utf8")
}

function readJsonBody(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
}

/** The JSON payload of one line the child traced. */
function tracePayload(traceLineText: string, marker: string): Record<string, unknown> {
	const hit = traceLineText.trim().match(new RegExp("^" + marker + " (.+)$"))
	if (!hit) {
		throw new Error(`no "${marker}" payload in the trace line ${JSON.stringify(traceLineText)}`)
	}
	return JSON.parse(hit[1]) as Record<string, unknown>
}

interface TimerLedger {
	armed(): number
	cancelled(): number
	outstanding(): number
	delays: number[]
	restore(): void
	cancelOutstanding(): void
}

/**
 * Count the timers proper-lockfile arms and the ones it cancels, attributed by the stack of the call
 * that armed them. The obvious instrument is not available here: the library hands its renewal timer to
 * `unref()` at `lib/lockfile.js:180-181`, and an un-ref-ed timer drops out of
 * `process.getActiveResourcesInfo()` - measured on this box, one live `setInterval` counts 1 and the
 * same timer after `unref()` counts 0 - so the renewal has to be watched where it is created, by
 * wrapping `setTimeout` and `clearTimeout` for the length of one row and counting only the calls whose
 * stack names the library. Every other timer in the process gets back exactly what it asked for.
 *
 * The assertions below are load-bearing rather than decorative: on this platform `setTimeout` and
 * `clearTimeout` are overload unions, and a wrapper that hands the callback, the delay and any further
 * arguments through unchanged cannot be written without asserting past the union. vitest and node both
 * arm timers with extra arguments, so dropping them here would change the run instead of only watching
 * it, which is the difference between an instrument and a disturbance.
 */
function watchLibraryTimers(): TimerLedger {
	const setOriginal = globalThis.setTimeout as unknown as (...callArguments: unknown[]) => unknown
	const clearOriginal = globalThis.clearTimeout as unknown as (handle: unknown) => void
	const armedHandles = new Set<unknown>()
	const delays: number[] = []
	let armed = 0
	let cancelled = 0
	globalThis.setTimeout = ((callback: unknown, ms?: unknown, ...rest: unknown[]): unknown => {
		const stack = new Error().stack ?? ""
		const handle = setOriginal(callback, ms, ...rest)
		if (stack.includes("proper-lockfile")) {
			armed += 1
			delays.push(Number(ms))
			armedHandles.add(handle)
		}
		return handle
	}) as typeof globalThis.setTimeout
	globalThis.clearTimeout = ((handle: unknown): void => {
		if (armedHandles.delete(handle)) {
			cancelled += 1
		}
		clearOriginal(handle)
	}) as typeof globalThis.clearTimeout
	return {
		armed: () => armed,
		cancelled: () => cancelled,
		outstanding: () => armed - cancelled,
		delays,
		cancelOutstanding: () => {
			// Handles that were cancelled on their own are already out of the set, so what is left here is
			// exactly the renewals still armed, and each of them counts as cancelled when this clears it.
			for (const handle of armedHandles) {
				clearOriginal(handle)
				cancelled += 1
			}
			armedHandles.clear()
		},
		restore: () => {
			globalThis.setTimeout = setOriginal as typeof globalThis.setTimeout
			globalThis.clearTimeout = clearOriginal as typeof globalThis.clearTimeout
		},
	}
}

/**
 * The reviewer-bot's "Regression Evidence" row asks for a real-library test that holds the link and
 * unrelated sibling locks concurrently while keeping the alias contention. Two thirds of that already
 * has a name in this file: the two 8.3 alias rows and the junction row in the suite above run against
 * the unmocked library, and so does "contends an unrelated sibling named like the link target against
 * the link's lock", which proves the collision a *similarly named* sibling causes. What none of them
 * proves is the coexistence half - that a sibling with its own name and its own inode takes its own
 * artefact and that both writers then hold locks at the same time - nor that a held lock is a directory
 * on a volume rather than a table entry in this process, which only a second process can show. The
 * middle row is the control that tells those two statements apart: the same launcher, the same
 * directory, the same trace assertions, and opposite outcomes for the alias of the held leaf and for
 * the unrelated sibling, so no row here can be green because the harness refused everything or admitted
 * everything.
 */
describe("an unrelated lock and a held leaf coexist while the alias contends", () => {
	const root = useTemporaryRoot("fileLock-coheld-")
	let actualLock: typeof lockfile.lock
	let lockModule = ""
	let generatesShortNames = false
	let traceIndex = 0
	let heldAliasLeaf: (() => Promise<void>) | null = null
	let heldAliasSibling: (() => Promise<void>) | null = null
	let heldLinkLock: (() => Promise<void>) | null = null
	let heldLinkSibling: (() => Promise<void>) | null = null
	let forcedDirectory: string | null = null
	let forcedTarget: string | null = null
	let cleanupDirectory: string | null = null
	let cleanupError: unknown = null

	// The same hole the guard of commit 36ad6819342e covers for the merge rows is here in three
	// rows, and the
	// finding on row 4555925401 names the clearest of them: this block acquires a leaf lock, releases it
	// inline, and a row that fails before that line leaves the lock held by this process while its
	// renewal timer keeps the artefact fresh. Row by row guards would mean three of them, so the guard
	// goes on the block in the same shape, releasing only what has not been released and clearing the
	// record before awaiting, so a release that lands late cannot be released twice and the row that
	// failed still reports its own assertion. A refusal at one release is kept for the row after this
	// block rather than thrown, because the timer rows of this file already state that a throw out of
	// a cleanup release replaces whatever the row itself failed at and leaves the runner printing only
	// the release frame, so every record is attempted and each release sits inside its own try.
	afterEach(async () => {
		if (heldAliasLeaf !== null) {
			const give = heldAliasLeaf
			heldAliasLeaf = null
			try {
				await give()
			} catch (thrown) {
				// The library reports a refused release as an error carrying a code on the error object,
				// which the Error type does not declare, so the guard records whatever came out and the
				// assertion in the row after this block names the code it carries.
				if (cleanupError === null) {
					cleanupError = thrown
				}
			}
		}
		if (heldAliasSibling !== null) {
			const give = heldAliasSibling
			heldAliasSibling = null
			try {
				await give()
			} catch (thrown) {
				if (cleanupError === null) {
					cleanupError = thrown
				}
			}
		}
		if (heldLinkLock !== null) {
			const give = heldLinkLock
			heldLinkLock = null
			try {
				await give()
			} catch (thrown) {
				if (cleanupError === null) {
					cleanupError = thrown
				}
			}
		}
		if (heldLinkSibling !== null) {
			const give = heldLinkSibling
			heldLinkSibling = null
			try {
				await give()
			} catch (thrown) {
				if (cleanupError === null) {
					cleanupError = thrown
				}
			}
		}
	})
	beforeAll(async () => {
		actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
		lockModule = createRequire(import.meta.url).resolve("proper-lockfile")
		generatesShortNames = process.platform === "win32" && shortNamesGenerated(root())
	})
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockImplementation((target, options) => actualLock(target, options))
	})

	function scenario(name: string, leafName: string): { directory: string; target: string } {
		const directory = path.join(root(), name)
		fs.mkdirSync(directory, { recursive: true })
		const target = path.join(directory, leafName)
		fs.writeFileSync(target, '{"pre":1}', "utf8")
		return { directory, target }
	}

	function nextTraceName(): string {
		traceIndex += 1
		return `coheld-trace-${traceIndex}.txt`
	}

	// The ceiling handed to a child that waits for this process is the timeout of the row that
	// launched it, taken from the same const, so the child cannot let go before the row can finish.
	const volumeAliasTimeoutMs = 30000
	const itVolumeAlias = (name: string, fn: () => Promise<void>) =>
		it(name, { timeout: volumeAliasTimeoutMs }, async (context) => {
			if (!generatesShortNames) {
				return context.skip()
			}
			await fn()
		})

	const itPosixLeaf = (name: string, fn: () => Promise<void>) =>
		it(name, { timeout: 30000 }, async (context) => {
			if (process.platform === "win32") {
				return context.skip()
			}
			await fn()
		})

	itVolumeAlias(
		"holds the leaf lock and an unrelated sibling lock at once and still refuses the alias of the held leaf",
		async () => {
			const { directory, target } = scenario("coheld-alias", "task-history-leaf-for-coheld-lock-testing.json")
			const sibling = path.join(directory, "state-sidecar-leaf-for-coheld-lock-testing.json")
			fs.writeFileSync(sibling, '{"pre":1}', "utf8")
			const aliasLeaf = aliasOf(target)
			expect(aliasLeaf).not.toBe(target)
			const releaseLeaf = await acquireFileLock(target, { immediate: true })
			heldAliasLeaf = releaseLeaf
			// The coexistence half: a sibling with its own name and its own inode has to get in.
			const releaseSibling = await acquireFileLock(sibling, { immediate: true })
			heldAliasSibling = releaseSibling
			const bothPlaced = [
				"state-sidecar-leaf-for-coheld-lock-testing.json.lock",
				"task-history-leaf-for-coheld-lock-testing.json.lock",
			].sort()
			expect(artefactsOf(directory)).toEqual(bothPlaced)
			expect(canonicalLockKey(target)).not.toBe(canonicalLockKey(sibling))
			expect(artefactsOf(directory)[0]).not.toBe(artefactsOf(directory)[1])
			// The alias half inside the same row: a foreign process arriving by the 8.3 spelling of the
			// held leaf is refused on the long-name artefact, which is the point the row on #1395 holds open.
			const aliasProbe = startLockHolder(aliasLeaf, "try", lockModule, directory, nextTraceName())
			const aliasArtefact = await readHolderTrace(aliasProbe.tracePath, "ARTEFACT", 15000, aliasProbe.childOutput)
			const aliasOutcome = await readHolderTrace(aliasProbe.tracePath, "OUTCOME", 15000, aliasProbe.childOutput)
			expect(traceArtefact(aliasArtefact)).toBe(
				path.join(directory, "task-history-leaf-for-coheld-lock-testing.json.lock"),
			)
			expect(traceOutcome(aliasOutcome)).toBe("failed ELOCKED")
			expect(await aliasProbe.waitForExit()).toBe(1)
			// And the sibling's lock is a directory on a volume rather than bookkeeping in this process:
			// a foreign process arriving at the sibling is refused too, on the sibling's own artefact.
			const siblingProbe = startLockHolder(sibling, "try", lockModule, directory, nextTraceName())
			const siblingArtefact = await readHolderTrace(
				siblingProbe.tracePath,
				"ARTEFACT",
				15000,
				siblingProbe.childOutput,
			)
			const siblingOutcome = await readHolderTrace(
				siblingProbe.tracePath,
				"OUTCOME",
				15000,
				siblingProbe.childOutput,
			)
			expect(traceArtefact(siblingArtefact)).toBe(
				path.join(directory, "state-sidecar-leaf-for-coheld-lock-testing.json.lock"),
			)
			expect(traceOutcome(siblingOutcome)).toBe("failed ELOCKED")
			expect(await siblingProbe.waitForExit()).toBe(1)
			expect(artefactsOf(directory)).toEqual(bothPlaced)
			await releaseLeaf()
			heldAliasLeaf = null
			await releaseSibling()
			heldAliasSibling = null
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	itVolumeAlias("admits a second process locking the unrelated sibling while the leaf lock is held", async () => {
		const { directory, target } = scenario("coheld-sibling-free", "task-history-leaf-for-sibling-admission.json")
		const sibling = path.join(directory, "state-sidecar-leaf-for-sibling-admission.json")
		fs.writeFileSync(sibling, '{"pre":1}', "utf8")
		const releaseLeaf = await acquireFileLock(target, { immediate: true })
		heldAliasLeaf = releaseLeaf
		const holder = startLockHolder(sibling, "hold", lockModule, directory, nextTraceName(), false, {
			holdMs: volumeAliasTimeoutMs,
			waitForAssertions: true,
		})
		try {
			await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceOutcome(outcomeLine)).toBe("held")
			// Armed, and the trace says so: the child holds until this process tells it otherwise.
			await readHolderTrace(holder.tracePath, "HOLDING", 15000, holder.childOutput)
			expect(artefactsOf(directory)).toEqual([
				"state-sidecar-leaf-for-sibling-admission.json.lock",
				"task-history-leaf-for-sibling-admission.json.lock",
			])
			// The release is this process's to start. Everything above ran while the other process still held
			// the sibling lock, and the trace has to name the signal rather than the six-second ceiling the
			// child was handed as a backstop: a row that passed because the child timed out would leave
			// HOLD-EXPIRED in the trace and reddens here.
			holder.signalRelease()
			expect(await holder.waitForExit()).toBe(0)
			const traceLines = fs.readFileSync(holder.tracePath, "utf8").split("\n")
			expect(traceLines).toContain("RELEASED")
			expect(traceLines.some((line) => line.startsWith("ASSERTIONS-DONE "))).toBe(true)
			expect(traceLines.some((line) => line.startsWith("HOLD-EXPIRED "))).toBe(false)
			await releaseLeaf()
			heldAliasLeaf = null
			expect(artefactsOf(directory)).toEqual([])
		} finally {
			// Always this process to end it: an assertion failure above must not leave the child
			// holding until its ceiling, and the process has to be reaped either way.
			holder.signalRelease()
			await holder.waitForExit()
		}
	})

	itPosixLeaf(
		"holds a link lock and an unrelated sibling lock at once and refuses a process arriving at the target",
		async () => {
			const directory = path.join(root(), "coheld-link")
			fs.mkdirSync(directory, { recursive: true })
			const target = path.join(directory, "history.json")
			fs.writeFileSync(target, '{"pre":1}', "utf8")
			const link = path.join(directory, "history-link.json")
			fs.symlinkSync("history.json", link)
			const sibling = path.join(directory, "state-sidecar.json")
			fs.writeFileSync(sibling, '{"pre":1}', "utf8")
			expect(fs.statSync(link).ino).toBe(fs.statSync(target).ino)
			const releaseLink = await acquireFileLock(link, { immediate: true })
			heldLinkLock = releaseLink
			const releaseSibling = await acquireFileLock(sibling, { immediate: true })
			heldLinkSibling = releaseSibling
			expect(artefactsOf(directory)).toEqual(["history.json.lock", "state-sidecar.json.lock"])
			expect(canonicalLockKey(link)).not.toBe(canonicalLockKey(sibling))
			const probe = startLockHolder(target, "try", lockModule, directory, nextTraceName())
			const probeArtefact = await readHolderTrace(probe.tracePath, "ARTEFACT", 15000, probe.childOutput)
			const probeOutcome = await readHolderTrace(probe.tracePath, "OUTCOME", 15000, probe.childOutput)
			expect(traceArtefact(probeArtefact)).toBe(path.join(directory, "history.json.lock"))
			expect(traceOutcome(probeOutcome)).toBe("failed ELOCKED")
			expect(await probe.waitForExit()).toBe(1)
			expect(artefactsOf(directory)).toEqual(["history.json.lock", "state-sidecar.json.lock"])
			await releaseLink()
			heldLinkLock = null
			await releaseSibling()
			heldLinkSibling = null
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	it("leaves the leaf lock held when a row fails before its release", { timeout: 30000 }, async () => {
		const { directory, target } = scenario("coheld-forced-failure", "task-history-leaf-for-forced-failure.json")
		forcedDirectory = directory
		forcedTarget = target
		heldAliasLeaf = await acquireFileLock(target, { immediate: true })
		let forced = ""
		try {
			// The failure the finding names, forced on purpose so that the letting go is what is
			// tested: an assertion that lands while this process still holds the leaf lock, before
			// any release line in this block would have run.
			expect(artefactsOf(directory)).toEqual([])
		} catch (thrown) {
			forced = String(thrown).slice(0, 40)
		}
		expect(forced).not.toBe("")
		// What that failure leaves at the instant it lands, before any block guard can run: the
		// artefact still sitting under this process. The row after this one is the assertion about
		// the guard, because a hook cannot run inside the row that failed.
		expect(artefactsOf(directory)).toEqual(["task-history-leaf-for-forced-failure.json.lock"])
	})

	it("gives back the leaf lock that a failed row left held", { timeout: 30000 }, async () => {
		if (forcedDirectory === null || forcedTarget === null) {
			throw new Error("the forced failure row recorded no objects to check")
		}
		// Running here, after the guard of this block, is the point: what is asserted is what the
		// guard left, namely no artefact under this process and the same path acquirable again by
		// an immediate call that refuses rather than waits.
		expect(artefactsOf(forcedDirectory)).toEqual([])
		heldAliasLeaf = await acquireFileLock(forcedTarget, { immediate: true })
		await heldAliasLeaf()
		heldAliasLeaf = null
		expect(artefactsOf(forcedDirectory)).toEqual([])
	})

	it("gives back every recorded lock when one recorded release is refused", { timeout: 30000 }, async () => {
		const { directory, target } = scenario("coheld-cleanup-refusal", "task-history-leaf-for-cleanup-refusal.json")
		const sibling = path.join(directory, "state-sidecar-leaf-for-cleanup-refusal.json")
		fs.writeFileSync(sibling, '{"pre":1}', "utf8")
		cleanupDirectory = directory
		const giveLeaf = await acquireFileLock(target, { immediate: true })
		heldAliasLeaf = giveLeaf
		const giveSibling = await acquireFileLock(sibling, { immediate: true })
		heldAliasSibling = giveSibling
		expect(artefactsOf(directory)).toEqual([
			"state-sidecar-leaf-for-cleanup-refusal.json.lock",
			"task-history-leaf-for-cleanup-refusal.json.lock",
		])
		// Both records stay set on purpose. The leaf is let go before the row returns, so the guard
		// attempt at the leaf is the second release of the same in-process record, which is the
		// refusal the timer rows of this file already name, and the sibling record is still set when
		// that refusal lands.
		await giveLeaf()
		expect(artefactsOf(directory)).toEqual(["state-sidecar-leaf-for-cleanup-refusal.json.lock"])
	})

	it("keeps the refusal visible and gives the sibling back anyway", { timeout: 30000 }, async () => {
		if (cleanupDirectory === null) {
			throw new Error("the cleanup refusal row recorded no directory to check")
		}
		// Running here, after the guard of this block, is the point: what is asserted is what the guard
		// left. The refusal is kept rather than swallowed, the sibling artefact is gone because its
		// release was attempted anyway, and nothing under this process holds a lock in that directory.
		const refusal = cleanupError
		expect(refusal).toBeInstanceOf(Error)
		// The guard attempt is the second call to the release function this row received when it
		// acquired the leaf, and proper-lockfile 4.1.2 answers that branch before touching the
		// filesystem: lib/lockfile.js line 255 tests the released flag on the lock record the
		// closure captured and line 257 rejects Lock is already released carrying code ERELEASED,
		// which is what the run of this file on windows printed for this row. The other release
		// refusal in this library, ENOTACQUIRED at lib/lockfile.js line 285, means the key is not
		// acquired or owned by this process at all, which is exactly what a guard that released a
		// record it never owned would show. This file already pins ERELEASED for a second call to a
		// release closure in the 8.3 alias block, and pins ENOTACQUIRED for the replaced record in
		// the row titled a replaced link target shares one record, so admitting that code here too
		// would let an ownership regression in the guard pass while the sibling still came back.
		expect((refusal as NodeJS.ErrnoException).code).toBe("ERELEASED")
		expect(artefactsOf(cleanupDirectory)).toEqual([])
		cleanupError = null
		cleanupDirectory = null
	})
})

/**
 * The "Persistence Integrity" row asks for a cross-process test with a waiting writer and concurrent
 * safeWriteJson merge writes. The cross-process suite above proves admission and refusal but no writer
 * in it ever wrote a body through the lock, and the merge rows above never leave this process. These
 * three rows put a writer in another process with a queue in front of it. The first lands a foreign
 * writer and this process's two concurrent merge writers onto one file through one artefact. The second
 * and third are one scenario told twice with a single flag between them: a process that has to wait
 * behind a lock this process is holding, which either re-reads the file after it is admitted or merges
 * into the copy it read before it ever tried. The second keeps the key that landed while it waited, the
 * third loses it. Without the third row the second only proves that nothing was lost, which is not the
 * same as proving that the re-read under the lock is the thing that kept it.
 */
describe("a writer that had to wait merges into what landed while it waited", () => {
	const root = useTemporaryRoot("fileLock-merge-wait-")
	let actualLock: typeof lockfile.lock
	let lockModule = ""
	let traceIndex = 0
	beforeAll(async () => {
		actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
		lockModule = createRequire(import.meta.url).resolve("proper-lockfile")
	})
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockImplementation((target, options) => actualLock(target, options))
	})
	let heldRelease: (() => Promise<void>) | null = null
	let liveWaiter: HolderHandle | null = null
	let forcedDirectory: string | null = null
	let forcedTarget: string | null = null
	let forcedTrace: string | null = null

	// The hole the three rows above share: a row that gives up part way, at an assertion between its
	// acquire and its release, leaves this process holding the lock and the writer it launched still
	// contending for it, because every release and every reap in those rows sits inline and an
	// assertion that lands skips the lines after it. This guard takes the shape the row named for
	// letting go of both locks and the renewal timer already uses, releasing only what has not been
	// released yet, and it sits on the block rather than inside one row because the same hole is in
	// all three of them here.
	afterEach(async () => {
		if (heldRelease !== null) {
			await heldRelease()
			heldRelease = null
		}
		if (liveWaiter !== null) {
			// Releasing first is what lets the writer finish on its own: it is refused while this
			// process still holds, and it writes, releases and exits once the artefact is gone.
			await liveWaiter.waitForExit()
			liveWaiter = null
		}
	})

	// The queue this module builds when the artefact belongs to someone else: for a plain call
	// fileLock.ts:119-125 hands the library five retries after the first attempt, capped at 1000 ms
	// each, so attempts land at about 0, 100, 300, 700, 1500 and 2500 ms and a queued writer gives up
	// after roughly 2.5 seconds. Two consequences shape the rows below: a foreign hold has to end
	// inside that horizon or the queued writers of this process would fail rather than wait, and a row
	// that sits behind another process gets a minute of row budget rather than the fifteen seconds the
	// faster rows here get.
	function scenario(name: string): { directory: string; target: string } {
		const directory = path.join(root(), name)
		fs.mkdirSync(directory, { recursive: true })
		const target = path.join(directory, "history.json")
		fs.writeFileSync(target, '{"pre":1}', "utf8")
		return { directory, target }
	}

	function nextTraceName(): string {
		traceIndex += 1
		return "merge-trace-" + traceIndex + ".txt"
	}

	// The attempts a waiting child needs are set by the two barrier polls that run while this process
	// still holds the lock, 15000 ms each at lines 1576 and 1579 and at lines 1610 and 1614, so the
	// ceiling is their sum of 30000 ms rather than the 25000 ms poll for the OUTCOME line, which
	// starts after the release and cannot bind the child. 121 attempts at 250 ms is 30250 ms, 250 ms
	// above that ceiling, and 100 attempts was 5000 ms below it.
	const waiterAttemptsForOutcomeBudget = 121
	it(
		"lands two concurrent merge writers and a foreign writer into one file through one artefact",
		{ timeout: 60000 },
		async () => {
			const { directory, target } = scenario("merge-three-writers")
			// One second, which is inside the 2.5 s the two merge writers below are willing to wait, so
			// they are admitted on their third or fourth attempt instead of exhausting the budget.
			const holder = startLockHolder(target, "hold", lockModule, directory, nextTraceName(), false, {
				holdMs: 1000,
				writeKey: "child",
				baseMode: "under",
			})
			liveWaiter = holder
			const artefactLine = await readHolderTrace(holder.tracePath, "ARTEFACT", 15000, holder.childOutput)
			const outcomeLine = await readHolderTrace(holder.tracePath, "OUTCOME", 15000, holder.childOutput)
			expect(traceArtefact(artefactLine)).toBe(path.join(directory, "history.json.lock"))
			expect(traceOutcome(outcomeLine)).toBe("held")
			// The foreign writer read its base after it was admitted, which is the only reason its key is
			// still in the file at the end of the row.
			const foreignBase = await readHolderTrace(holder.tracePath, "BASE-UNDER-LOCK", 15000, holder.childOutput)
			expect(tracePayload(foreignBase, "BASE-UNDER-LOCK")).toEqual({ pre: 1 })
			// Both of these arrive at a file another process holds, so both take the retry path described
			// above, and neither resolves until its own write has landed under its own lock. A rejection
			// here fails the row, so awaiting them is the assertion that both got in.
			await Promise.all([
				safeWriteJson(target, { writerA: 1 }, { merge: mergeRecords }),
				safeWriteJson(target, { writerB: 1 }, { merge: mergeRecords }),
			])
			expect(await holder.waitForExit()).toBe(0)
			liveWaiter = null
			expect(readJsonBody(target)).toEqual({ pre: 1, child: 1, writerA: 1, writerB: 1 })
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	it(
		"re-reads under the lock when the process that had to wait is admitted after another key landed",
		{ timeout: 60000 },
		async () => {
			const { directory, target } = scenario("merge-waiter-under")
			const release = await acquireFileLock(target, { immediate: true })
			heldRelease = release
			const waiter = startLockHolder(target, "hold", lockModule, directory, nextTraceName(), false, {
				holdMs: 0,
				writeKey: "child",
				baseMode: "under",
				retries: waiterAttemptsForOutcomeBudget,
				retryMs: 250,
			})
			liveWaiter = waiter
			await readHolderTrace(waiter.tracePath, "ARTEFACT", 15000, waiter.childOutput)
			// Observed rather than assumed: the waiter attempted while this process still held the lock and
			// was refused, so the row cannot pass with a writer that merely ran after the write below.
			const refusedLine = await readHolderTrace(waiter.tracePath, "REFUSED", 15000, waiter.childOutput)
			expect(refusedLine).toBe("REFUSED ELOCKED")
			// Measured rather than assumed: this process wrote while the other one had still not been
			// admitted, which is what makes it a waiting writer at all rather than a second writer that
			// merely ran later.
			expect(fs.readFileSync(waiter.tracePath, "utf8")).not.toContain("OUTCOME held")
			writeMergedKey(target, "writerA")
			await release()
			heldRelease = null
			const outcomeLine = await readHolderTrace(waiter.tracePath, "OUTCOME", 25000, waiter.childOutput)
			expect(traceOutcome(outcomeLine)).toBe("held")
			const baseLine = await readHolderTrace(waiter.tracePath, "BASE-UNDER-LOCK", 15000, waiter.childOutput)
			expect(tracePayload(baseLine, "BASE-UNDER-LOCK")).toEqual({ pre: 1, writerA: 1 })
			expect(await waiter.waitForExit()).toBe(0)
			liveWaiter = null
			expect(readJsonBody(target)).toEqual({ pre: 1, writerA: 1, child: 1 })
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	it(
		"loses the key that landed while it waited when the waiting process merges against a base read before it tried",
		{ timeout: 60000 },
		async () => {
			const { directory, target } = scenario("merge-waiter-before")
			const release = await acquireFileLock(target, { immediate: true })
			heldRelease = release
			const waiter = startLockHolder(target, "hold", lockModule, directory, nextTraceName(), false, {
				holdMs: 0,
				writeKey: "child",
				baseMode: "before",
				retries: waiterAttemptsForOutcomeBudget,
				retryMs: 250,
			})
			liveWaiter = waiter
			const beforeLine = await readHolderTrace(waiter.tracePath, "BASE-BEFORE", 15000, waiter.childOutput)
			expect(tracePayload(beforeLine, "BASE-BEFORE")).toEqual({ pre: 1 })
			// The base was read before the attempt, and the attempt then happened and was refused; both are
			// in the trace before this process touches the file, which is the barrier this row was missing.
			const refusedLine = await readHolderTrace(waiter.tracePath, "REFUSED", 15000, waiter.childOutput)
			expect(refusedLine).toBe("REFUSED ELOCKED")
			expect(fs.readFileSync(waiter.tracePath, "utf8")).not.toContain("OUTCOME held")
			writeMergedKey(target, "writerA")
			await release()
			heldRelease = null
			const outcomeLine = await readHolderTrace(waiter.tracePath, "OUTCOME", 25000, waiter.childOutput)
			expect(traceOutcome(outcomeLine)).toBe("held")
			const usedLine = await readHolderTrace(waiter.tracePath, "BASE-USED", 15000, waiter.childOutput)
			expect(tracePayload(usedLine, "BASE-USED")).toEqual({ pre: 1 })
			expect(await waiter.waitForExit()).toBe(0)
			liveWaiter = null
			const content = readJsonBody(target)
			expect(content).toEqual({ pre: 1, child: 1 })
			expect(content).not.toHaveProperty("writerA")
			expect(artefactsOf(directory)).toEqual([])
		},
	)

	it(
		"leaves the lock held and the waiting writer refused when a row fails between the two",
		{ timeout: 60000 },
		async () => {
			const { directory, target } = scenario("merge-waiter-forced-failure")
			forcedDirectory = directory
			forcedTarget = target
			heldRelease = await acquireFileLock(target, { immediate: true })
			liveWaiter = startLockHolder(target, "hold", lockModule, directory, nextTraceName(), false, {
				holdMs: 0,
				writeKey: "child",
				baseMode: "under",
				retries: waiterAttemptsForOutcomeBudget,
				retryMs: 250,
			})
			forcedTrace = liveWaiter.tracePath
			await readHolderTrace(liveWaiter.tracePath, "REFUSED", 15000, liveWaiter.childOutput)
			let forced = ""
			try {
				// The failure these rows can hit, forced on purpose so that the letting go is what is
				// tested and not the merge: an assertion that lands while this process still holds the
				// lock and while the writer it launched is still being refused.
				expect(artefactsOf(directory)).toEqual([])
			} catch (thrown) {
				forced = String(thrown).slice(0, 40)
			}
			expect(forced).not.toBe("")
			// What that failure leaves at the moment it lands, before this block guard runs: the
			// artefact still under this process and the writer still short of its outcome line. The
			// next row is the assertion about the guard, because a hook cannot run inside the row that
			// failed.
			expect(artefactsOf(directory)).toEqual(["history.json.lock"])
			expect(fs.readFileSync(forcedTrace ?? "", "utf8")).not.toContain("OUTCOME")
		},
	)

	it(
		"gives back the lock and reaps the waiting writer that a failed row left behind",
		{ timeout: 60000 },
		async () => {
			if (forcedDirectory === null || forcedTarget === null || forcedTrace === null) {
				throw new Error("the forced failure row recorded no objects to check")
			}
			// Running here, after the guard of this block, is the point: what is asserted is what the
			// guard left, namely no artefact under this process, the writer admitted once the lock was
			// free having written, let go and exited, and the same path acquirable again.
			expect(artefactsOf(forcedDirectory)).toEqual([])
			expect(fs.readFileSync(forcedTrace, "utf8")).toContain("RELEASED")
			heldRelease = await acquireFileLock(forcedTarget, { immediate: true })
			await heldRelease()
			heldRelease = null
			expect(artefactsOf(forcedDirectory)).toEqual([])
		},
	)
})

/**
 * The "Lifecycle Resource Cleanup" row asks for a regression test that acquires after replacement while
 * the first lock is still held, and then checks both releases and the timer cleanup. The posix row that
 * holds two locks on one referent after the directory it lived in was replaced already covers
 * acquire-after-replacement and the disappearance of both artefacts, and it names the compromised-lock
 * hazard the renewal can hit; what none of the existing rows does is look at the renewal timer at all,
 * and the acquire-after-replacement row never runs on the platform this suite is being run on. These
 * rows put the replacement and the renewal in one row where the row executes. The second row is the
 * control that makes the first row's arithmetic mean something: it shows a renewal timer sitting
 * outstanding while a lock is held, shows an attempt that never owned the artefact adding nothing
 * outstanding, and shows the release being the thing that cancels it, so a row that ends balanced is
 * balanced because the release let go and not because nothing was ever armed.
 */
describe("a replaced referent lets go both locks and the renewal timer", () => {
	const root = useTemporaryRoot("fileLock-timer-")
	let actualLock: typeof lockfile.lock
	beforeAll(async () => {
		actualLock = (await vi.importActual<typeof import("proper-lockfile")>("proper-lockfile")).lock
	})
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockImplementation((target, options) => actualLock(target, options))
	})

	function scenario(name: string, leafName: string): { directory: string; target: string } {
		const directory = path.join(root(), name)
		fs.mkdirSync(directory, { recursive: true })
		const target = path.join(directory, leafName)
		fs.writeFileSync(target, '{"pre":1}', "utf8")
		return { directory, target }
	}

	it(
		"lets go both locks and the renewal timer when the referent is replaced under a held lock",
		{ timeout: 30000 },
		async () => {
			const { directory, target } = scenario("timer-replaced-referent", "history.json")
			const ledger = watchLibraryTimers()
			let releaseFirst: (() => Promise<void>) | null = null
			let releaseSecond: (() => Promise<void>) | null = null
			try {
				releaseFirst = await acquireFileLock(target, { immediate: true })
				expect(artefactsOf(directory)).toEqual(["history.json.lock"])
				// The renewal the library armed for this lock: fileLock.ts asks for update 10000 at
				// fileLock.ts:108, the library clamps it against the staleness window at
				// lib/lockfile.js:220-221, and lib/lockfile.js:109 is where the timer is armed.
				expect(ledger.armed()).toBeGreaterThanOrEqual(1)
				expect(ledger.outstanding()).toBe(1)
				expect(ledger.delays).toContain(10000)
				const replacement = path.join(directory, "history.json.next")
				fs.writeFileSync(replacement, '{"replaced":1}', "utf8")
				fs.renameSync(replacement, target)
				expect(readJsonBody(target)).toEqual({ replaced: 1 })
				// The half the row is named for: an acquisition attempted after the referent was replaced,
				// while the first lock is still held. The leaf name survived the replacement, so the volume
				// still spells the file the same way, so this is refused on the artefact the first one
				// armed rather than quietly taking a second lock beside it.
				await expect(acquireFileLock(target, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
				expect(ledger.outstanding()).toBe(1)
				await releaseFirst()
				releaseFirst = null
				// The release is what cancels the renewal: lib/lockfile.js:288 clears the update timeout
				// before it removes the artefact, and the artefact going is the other half of the same call.
				expect(ledger.cancelled()).toBe(ledger.armed())
				expect(ledger.outstanding()).toBe(0)
				expect(artefactsOf(directory)).toEqual([])
				releaseSecond = await acquireFileLock(target, { immediate: true })
				expect(ledger.outstanding()).toBe(1)
				writeMergedKey(target, "writer")
				await releaseSecond()
				releaseSecond = null
				expect(ledger.outstanding()).toBe(0)
				expect(artefactsOf(directory)).toEqual([])
				expect(readJsonBody(target)).toEqual({ replaced: 1, writer: 1 })
			} finally {
				ledger.restore()
				if (releaseFirst !== null) {
					await releaseFirst()
				}
				if (releaseSecond !== null) {
					await releaseSecond()
				}
			}
		},
	)

	it(
		"keeps a renewal timer outstanding until the lock that armed it is let go, and arms none for an attempt that never owned the artefact",
		{ timeout: 30000 },
		async () => {
			const { directory, target } = scenario("timer-outstanding", "history.json")
			const ledger = watchLibraryTimers()
			let release: (() => Promise<void>) | null = null
			try {
				release = await acquireFileLock(target, { immediate: true })
				expect(ledger.armed()).toBeGreaterThanOrEqual(1)
				expect(ledger.outstanding()).toBe(1)
				const armedBeforeAttempt = ledger.armed()
				await expect(acquireFileLock(target, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
				expect(ledger.armed()).toBe(armedBeforeAttempt)
				expect(ledger.outstanding()).toBe(1)
				expect(artefactsOf(directory)).toEqual(["history.json.lock"])
				await release()
				release = null
				expect(ledger.cancelled()).toBe(ledger.armed())
				expect(ledger.outstanding()).toBe(0)
				expect(artefactsOf(directory)).toEqual([])
			} finally {
				ledger.restore()
				if (release !== null) {
					await release()
				}
			}
		},
	)

	const itPosixLeaf = (name: string, fn: () => Promise<void>) =>
		it(name, { timeout: 30000 }, async (context) => {
			if (process.platform === "win32") {
				return context.skip()
			}
			await fn()
		})

	itPosixLeaf(
		"a replaced link target shares one record, so the second release lands and the first throws ENOTACQUIRED",
		async () => {
			const directory = path.join(root(), "timer-link-replaced")
			fs.mkdirSync(directory, { recursive: true })
			const target = path.join(directory, "history.json")
			fs.writeFileSync(target, '{"pre":1}', "utf8")
			const link = path.join(directory, "history-link.json")
			fs.symlinkSync("history.json", link)
			const ledger = watchLibraryTimers()
			// What the key consults, and what it does not, because the two part company here and that is the
			// behaviour this row states. canonicalLockKey walks the path by basename and keys on dev:ino of the
			// nearest directory that exists, so the leaf rides along as the string the caller wrote and the
			// referent a link points at never enters the key. lockArtefactPath does consult the referent: it names
			// the artefact by fs.realpathSync.native of the leaf, re-spelling only the final component. Replacing
			// the link target therefore moves the artefact name and leaves the key where it was. The library keeps
			// one in-process record per key - it assigns locks[file] with no guard at lockfile.js:243 and deletes
			// it unconditionally at :290 - so the second arrival, arriving on the same spelling the first caller
			// wrote, replaces the first holder's record instead of taking a second one. The artefacts really are
			// two, as the rows below measure; the records are not, and this group's title holds only for the
			// plain-file case above, where one referent means one record and both releases land.
			let releaseFirst: (() => Promise<void>) | null = null
			let releaseSecond: (() => Promise<void>) | null = null
			// Releases are wrapped, and that is not cosmetics. A throw inside finally replaces the error already
			// propagating, and at the head this row replaces an unwrapped release here threw ENOTACQUIRED over
			// whatever the body had failed at, so the runner printed only the release frame at line 1669 and the
			// first failure never appeared. Wrapped, the body's own failure is what a runner reports.
			const releaseQuietly = async (release: () => Promise<void>): Promise<Error | null> => {
				try {
					await release()
					return null
				} catch (releaseError) {
					return releaseError instanceof Error ? releaseError : new Error(String(releaseError))
				}
			}
			try {
				releaseFirst = await acquireFileLock(link, { immediate: true })
				expect(artefactsOf(directory)).toEqual(["history.json.lock"])
				expect(ledger.outstanding()).toBe(1)
				expect(ledger.delays).toContain(10000)
				const nextTarget = path.join(directory, "history.json.next")
				fs.writeFileSync(nextTarget, '{"replaced":1}', "utf8")
				const nextLink = path.join(directory, "history-link.json.next")
				fs.symlinkSync("history.json.next", nextLink)
				fs.renameSync(nextLink, link)
				expect(fs.realpathSync(link)).toBe(nextTarget)
				// The volume now spells the leaf differently, so a second arrival is admitted on its own artefact
				// while the first holder's artefact is still there.
				releaseSecond = await acquireFileLock(link, { immediate: true })
				expect(artefactsOf(directory)).toEqual(["history.json.lock", "history.json.next.lock"])
				expect(ledger.outstanding()).toBe(2)
				// The second lock is a directory on a volume, not bookkeeping: a third arrival at the new target
				// itself is refused on the artefact the second lock armed. Probed through `nextTarget`, because
				// `target` names the first holder's artefact, and asking there measures a refusal this row is not
				// claiming.
				await expect(acquireFileLock(nextTarget, { immediate: true })).rejects.toMatchObject({
					code: "ELOCKED",
				})
				// The record names the second arrival, so the second release is the one that lands.
				expect(await releaseQuietly(releaseSecond)).toBeNull()
				releaseSecond = null
				expect(artefactsOf(directory)).toEqual(["history.json.lock"])
				// The first holder has an artefact left on a volume it can no longer name to the library: its
				// record was replaced by the second arrival and deleted by the second release, so its own release
				// is refused with ENOTACQUIRED before it can clear its renewal timer, which is why one renewal is
				// still outstanding after both holders have tried to let go.
				const firstReleaseError = await releaseQuietly(releaseFirst)
				expect(firstReleaseError).toMatchObject({ code: "ENOTACQUIRED" })
				expect(ledger.outstanding()).toBe(1)
				expect(artefactsOf(directory)).toEqual(["history.json.lock"])
				releaseFirst = null
			} finally {
				ledger.restore()
				if (releaseFirst !== null) {
					await releaseQuietly(releaseFirst)
				}
				if (releaseSecond !== null) {
					await releaseQuietly(releaseSecond)
				}
				// The refused release never reached the clearTimeout at lockfile.js:288, so its renewal timer is
				// still armed and would fire after this row ends, utimes a deleted artefact and be reported
				// compromised by a callback that rethrows outside any test. Cancelled here rather than left to the
				// 10 second renewal to find out.
				ledger.cancelOutstanding()
			}
		},
	)
})
