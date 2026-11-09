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
 * The artefact spelling is caller-owned: a writer that renames the leaf as part of its own write
 * captures the spelling once, before the first rename, and hands it back per acquisition, because
 * re-deriving it after the rename names a different artefact for one file. The two carried fileLock
 * specs name the `.lock` suffix but never pass or assert a spelling, so the leg in `_lockCanonicalKey`
 * that consumes `artefactSpelling` would ship untested. These acquisitions are two-sided: dropping
 * the caller's spelling in favour of the derived one fails the first test, and deriving nothing
 * fails the second.
 *
 * Nothing here spells a path by hand. `canonicalLockPath` canonicalizes with `fs.promises.realpath`
 * while `lockArtefactSpelling` canonicalizes with `fsSync.realpathSync.native`, and on the windows
 * runner those two routes answer with different spellings of the same directory - the profile temp
 * directory came back as the 8.3 short form from one and as the long form from the other, which is
 * what made the first version of this spec fail on platform-unit-test (windows-latest) while
 * passing locally. So the canonical key, the derived artefact and the parent the caller-supplied
 * spelling is built under are all read back from the code's own first acquisition: what stays
 * asserted is the behaviour - the string handed in reaches the library verbatim, both acquisitions
 * take the same key, and the derived artefact differs from the supplied one and repeats exactly.
 */
const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "filelock-artefact-spelling-"))
const target = path.join(dir, "task.json")

fsSync.writeFileSync(target, "{}")

afterAll(() => {
	fsSync.rmSync(dir, { force: true, recursive: true })
})

beforeEach(() => {
	vi.mocked(lockfile.lock).mockReset()
})

/** One acquisition with no spelling handed in, which is where the code spells both the key and the artefact. */
async function acquireOnceAndReadBack(): Promise<{ canonicalKey: string; derivedArtefact: string }> {
	const releaseLock = await acquireFileLock(target)
	const call = vi.mocked(lockfile.lock).mock.calls[0]
	const canonicalKey = String(call?.[0])
	const derivedArtefact = String(call?.[1]?.lockfilePath)
	await releaseLock()

	return { canonicalKey, derivedArtefact }
}

describe("acquireFileLock artefact spelling", () => {
	test("uses a caller-supplied spelling verbatim as the artefact", async () => {
		const { canonicalKey, derivedArtefact } = await acquireOnceAndReadBack()
		const supplied = path.join(path.dirname(canonicalKey), "captured-before-the-rename.json.lock")

		const releaseLock = await acquireFileLock(target, { artefactSpelling: supplied })

		expect(lockfile.lock).toHaveBeenCalledTimes(2)
		expect(lockfile.lock).toHaveBeenNthCalledWith(
			2,
			// the same key the spelling-free acquisition took: one file, one key, whatever the volume spells it as
			canonicalKey,
			expect.objectContaining({ lockfilePath: supplied, realpath: false }),
		)

		await releaseLock()

		expect(derivedArtefact.endsWith(".lock")).toBe(true)
		expect(path.basename(derivedArtefact)).toBe("task.json.lock")
		expect(path.basename(supplied)).toBe("captured-before-the-rename.json.lock")
		expect(supplied).not.toBe(derivedArtefact)
	})

	test("derives its own artefact when no spelling is handed in, and the two differ", async () => {
		const { canonicalKey, derivedArtefact } = await acquireOnceAndReadBack()
		const supplied = path.join(path.dirname(canonicalKey), "captured-before-the-rename.json.lock")

		// the artefact the library was handed is the exported helper applied to the key the code locked,
		// which is what makes a caller-supplied spelling comparable with a derived one
		expect(derivedArtefact).toBe(lockArtefactSpelling(canonicalKey))

		const callerSpelled = await acquireFileLock(target, { artefactSpelling: supplied })
		await callerSpelled()
		const derivedSpelled = await acquireFileLock(target)
		await derivedSpelled()
		const derivedAgain = await acquireFileLock(target)
		await derivedAgain()

		const artefacts = vi
			.mocked(lockfile.lock)
			.mock.calls.slice(1)
			.map((call) => String(call[1]?.lockfilePath))
		expect(artefacts).toEqual([supplied, derivedArtefact, derivedArtefact])
	})
})
