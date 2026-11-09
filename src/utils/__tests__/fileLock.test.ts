import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as lockfile from "proper-lockfile"

import { acquireFileLock, canonicalLockKey, LOCK_STALE_MS, withFileLock } from "../fileLock"

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
})
