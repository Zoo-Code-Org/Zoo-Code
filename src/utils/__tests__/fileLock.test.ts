import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import * as lockfile from "proper-lockfile"

import { acquireFileLock, canonicalLockPath, LOCK_STALE_MS, withFileLock } from "../fileLock"

vi.mock("proper-lockfile", () => ({ lock: vi.fn() }))

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
 * 47-character name) and the alias case below executed and passed; the linux leg does not
 * execute it. The name is deliberately not passed as a dir argument: dir /x <name> lists that
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

describe("one lock per file, not one lock per spelling", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileLock-key-"))
	const generatesShortNames = process.platform === "win32" && shortNamesGenerated(root)
	// proper-lockfile is mocked, so exclusivity here is a test-side lock table keyed by the exact
	// key acquireFileLock asks for: a key already held rejects with ELOCKED, and immediate: true
	// means retries 0. The property under test is whether two spellings of one file arrive as
	// one key or as two, which is exactly what that table can decide.
	const held: string[] = []
	beforeEach(() => {
		held.length = 0
		vi.mocked(lockfile.lock).mockImplementation(async (target: unknown) => {
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
	const aliasOf = (longPath: string): string => {
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
	const itAlias = generatesShortNames ? it : it.skip
	itAlias("takes one lock for an 8.3 alias and its long form, not a second one", async () => {
		const longDir = path.join(root, "a-really-long-directory-name-for-alias-lock-testing")
		fs.mkdirSync(longDir, { recursive: true })
		const file = path.join(longDir, "history.json")
		fs.writeFileSync(file, "{}", "utf8")
		const aliasFile = path.join(aliasOf(longDir), "history.json")
		expect(fs.statSync(aliasFile).ino).toBe(fs.statSync(file).ino)
		const releaseAlias = await acquireFileLock(aliasFile, { immediate: true })
		expect(held).toHaveLength(1)
		await expect(acquireFileLock(file, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		expect(held[0]).toBe(canonicalLockPath(file))
		await releaseAlias()
	})
	it("takes separate locks for two different files in one directory", async () => {
		const a = path.join(root, "a.json")
		const b = path.join(root, "b.json")
		fs.writeFileSync(a, "{}", "utf8")
		fs.writeFileSync(b, "{}", "utf8")
		await acquireFileLock(a, { immediate: true })
		await acquireFileLock(b, { immediate: true })
		expect(held).toHaveLength(2)
	})
	it("takes one lock for one not-yet-existing path and a different one for another name", async () => {
		const missingA = path.join(root, "missing-a.json")
		const missingB = path.join(root, "missing-b.json")
		await acquireFileLock(missingA, { immediate: true })
		await expect(acquireFileLock(missingA, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
		await acquireFileLock(missingB, { immediate: true })
		expect(held).toHaveLength(2)
	})
})
