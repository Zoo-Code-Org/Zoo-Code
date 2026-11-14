import * as fsSync from "fs"
import * as path from "path"

import * as lockfile from "proper-lockfile"
import { acquireFileLock, LOCK_STALE_MS, lockArtefactSpelling, withFileLock } from "../fileLock"

vi.mock("proper-lockfile", () => ({ lock: vi.fn() }))

// Only realpathSync.native is replaced, and it is replaced with a stub rather than a fixture:
// the spelling cases below are about how the function composes an answer from whatever the
// volume reports, and the case where the volume really reports something is in
// fileLock.integration.spec.ts. Everything else in "fs" stays the real thing so the module's
// own imports keep working.
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	return { ...actual, realpathSync: Object.assign(vi.fn(), { native: vi.fn() }) }
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

describe("lock artefact spelling", () => {
	beforeEach(() => vi.clearAllMocks())

	// Only the one ancestor below resolves; every deeper component is absent, which is the
	// state the function exists for: the leaf may be mid-rename or missing entirely.
	const _only =
		(existing: string) =>
		(candidate: string | Buffer | URL): string => {
			if (String(candidate) === existing) {
				return existing
			}
			const error = new Error(
				`ENOENT: no such file or directory, realpath '${candidate}'`,
			) as NodeJS.ErrnoException
			error.code = "ENOENT"
			throw error
		}

	it("spells the artefact from the nearest existing ancestor and keeps the missing components in order", () => {
		const existingDir = path.resolve("/tmp/canonical-dir")
		const target = path.join(existingDir, "missing-one", "missing-two", "history_item.json")
		vi.mocked(fsSync.realpathSync.native).mockImplementation(_only(existingDir))

		expect(lockArtefactSpelling(target)).toBe(
			path.join(existingDir, "missing-one", "missing-two", "history_item.json") + ".lock",
		)
	})

	it("keeps the caller's own spelling when nothing on the path resolves", () => {
		vi.mocked(fsSync.realpathSync.native).mockImplementation(_only("/does-not-exist"))
		const target = path.resolve("/tmp/never-created-dir/history_item.json")

		expect(lockArtefactSpelling(target)).toBe(target + ".lock")
	})

	it("hands a caller-captured spelling to lockfile.lock verbatim", async () => {
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {})
		const target = path.resolve("/tmp/canonical-dir/history_item.json")
		const spelling = path.resolve("/tmp/locks/captured.json.lock")

		await acquireFileLock(target, { artefactSpelling: spelling })

		// A writer that renamed the leaf captured this spelling before the rename. Re-deriving
		// the name here would contend with nobody and lock a second artefact.
		expect(lockfile.lock).toHaveBeenCalledWith(target, expect.objectContaining({ lockfilePath: spelling }))
	})

	it("derives the artefact itself when the caller supplies no spelling", async () => {
		vi.mocked(lockfile.lock).mockResolvedValue(async () => {})
		const existingDir = path.resolve("/tmp/canonical-dir")
		const target = path.join(existingDir, "missing-one", "history_item.json")
		vi.mocked(fsSync.realpathSync.native).mockImplementation(_only(existingDir))

		await acquireFileLock(target)

		expect(lockfile.lock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({
				lockfilePath: path.join(existingDir, "missing-one", "history_item.json") + ".lock",
			}),
		)
	})
})
