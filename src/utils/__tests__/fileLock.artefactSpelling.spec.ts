// npx vitest run utils/__tests__/fileLock.artefactSpelling.spec.ts

import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import * as lockfile from "proper-lockfile"

import { acquireFileLock, lockArtefactSpelling } from "../fileLock"

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
	unlock: vi.fn(async () => {}),
}))

/**
 * The artefact spelling is caller-owned: a writer that renames the leaf as part of its own
 * write captures the spelling once, before the first rename, and hands it back per
 * acquisition, because re-deriving it after the rename names a different artefact for one
 * file. The two carried fileLock specs name the `.lock` suffix but never pass or assert a
 * spelling, so the leg in `_lockCanonicalKey` that consumes `artefactSpelling` would ship
 * untested. These acquisitions are two-sided: dropping the caller's spelling in favour of
 * the derived one fails the first test, and deriving nothing fails the second.
 */
const dir = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), "filelock-artefact-spelling-")))
const target = path.join(dir, "task.json")
const supplied = path.join(dir, "captured-before-the-rename.json.lock")

fsSync.writeFileSync(target, "{}")

afterAll(() => {
	fsSync.rmSync(dir, { force: true, recursive: true })
})

beforeEach(() => {
	vi.mocked(lockfile.lock).mockReset()
})

describe("acquireFileLock artefact spelling", () => {
	test("uses a caller-supplied spelling verbatim as the artefact", async () => {
		const releaseLock = await acquireFileLock(target, { artefactSpelling: supplied })

		expect(lockfile.lock).toHaveBeenCalledTimes(1)
		expect(lockfile.lock).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ lockfilePath: supplied, realpath: false }),
		)

		await releaseLock()
	})

	test("derives its own artefact when no spelling is handed in, and the two differ", async () => {
		const derived = lockArtefactSpelling(target)

		expect(derived.endsWith(".lock")).toBe(true)
		expect(derived).not.toBe(supplied)

		const callerSpelled = await acquireFileLock(target, { artefactSpelling: supplied })
		await callerSpelled()
		const derivedSpelled = await acquireFileLock(target)
		await derivedSpelled()
		const derivedAgain = await acquireFileLock(target)
		await derivedAgain()

		const artefacts = vi.mocked(lockfile.lock).mock.calls.map((call) => String(call[1]?.lockfilePath))
		expect(artefacts).toEqual([supplied, derived, derived])
	})
})
