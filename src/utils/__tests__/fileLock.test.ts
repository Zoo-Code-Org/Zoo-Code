import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import { acquireFileLock, LOCK_STALE_MS, lockPathFor, withFileLock } from "../fileLock"

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
				// The drift guard in safeWriteJson answers "is this the same lock?" by comparing
				// the two artefacts lockPathFor names, which is only sound while this module
				// locks exactly that location.
				lockfilePath: lockPathFor("history.json"),
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

	// The lock artefact sits beside the file it guards, and proper-lockfile's own mkdir of
	// that artefact is not recursive. A write into a directory that did not exist yet failed
	// here with ENOENT - before the publish primitive, and so before any rollback it would
	// have owned - and left the empty tree behind. These rows run against the real filesystem
	// for the directory behaviour; the lock itself stays stubbed because the question here is
	// which directories exist afterwards, not who holds what.
	it("creates the directory the lock artefact needs before taking the lock", async () => {
		const base = await fsp.mkdtemp(path.join(os.tmpdir(), "filelock-chain-"))
		const target = path.join(base, "missing", "nested", "history.json")
		const release = vi.fn(async () => {})
		vi.mocked(lockfile.lock).mockResolvedValue(release)
		try {
			await acquireFileLock(target)
			expect((await fsp.stat(path.join(base, "missing", "nested"))).isDirectory()).toBe(true)
			// The artefact did not move to the ancestor that happened to exist: every writer to
			// this path, arriving before or after the directory, is locking the same location.
			expect(lockfile.lock).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ lockfilePath: lockPathFor(target) }),
			)
			await release()
			// Releasing does not undo the creation: the write the lock was taken for follows it.
			expect((await fsp.stat(path.join(base, "missing", "nested"))).isDirectory()).toBe(true)
		} finally {
			await fsp.rm(base, { recursive: true, force: true })
		}
	})

	it("removes only the directories it created when the lock cannot be acquired", async () => {
		const base = await fsp.mkdtemp(path.join(os.tmpdir(), "filelock-rollback-"))
		const existing = path.join(base, "existing")
		await fsp.mkdir(existing)
		// A directory somebody else already made is not this call's to remove, even though it
		// sits inside the chain this call was walking.
		const madeByAnotherWriter = path.join(existing, "one")
		await fsp.mkdir(madeByAnotherWriter)
		const target = path.join(madeByAnotherWriter, "two", "history.json")
		const lockFailure = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" })
		vi.mocked(lockfile.lock).mockRejectedValue(lockFailure)
		try {
			// A rollback that reported its own failure instead would hide which of the two
			// failures the caller has to act on.
			await expect(acquireFileLock(target)).rejects.toBe(lockFailure)
			expect((await fsp.stat(existing)).isDirectory()).toBe(true)
			expect((await fsp.stat(madeByAnotherWriter)).isDirectory()).toBe(true)
			await expect(fsp.stat(path.join(madeByAnotherWriter, "two"))).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fsp.rm(base, { recursive: true, force: true })
		}
	})
})
