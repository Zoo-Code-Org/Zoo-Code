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

// The ancestor walk inside `lockArtefactSpelling` had no test at all: every row here locks a leaf
// that already exists, so the one realpathSync.native call answered on the first cursor and the
// walk-up, the re-join below it and the volume-root guard were never executed. The handler answers
// the walk cursor by cursor - including a canonical spelling no volume on this host would give -
// and defaults to the platform's own answer for the two rows above.
let nativeHandler: ((cursor: string) => string) | undefined

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	const realpathSyncShim = Object.assign(
		(target: string, options?: Parameters<typeof actual.realpathSync>[1]) => actual.realpathSync(target, options),
		{
			native: (target: string, options?: Parameters<typeof actual.realpathSync>[1]) =>
				nativeHandler ? nativeHandler(target) : actual.realpathSync.native(target, options),
		},
	)

	return { ...actual, realpathSync: realpathSyncShim }
})
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
	afterEach(() => {
		nativeHandler = undefined
	})

	// The walk stops at the nearest ancestor the volume can spell and re-joins what the caller
	// spelled below it, in order. `reverse()` is the ordering, `missing.push` is the existence,
	// and taking the canonical answer at all is the difference between an artefact a peer that
	// reached the same file through the canonical path also takes and one only this caller takes.
	test("re-joins the missing components in the caller order under the canonicalized ancestor", () => {
		const anchor = path.resolve(path.join("store", "anchor"))
		const canonicalAnchor = path.resolve(path.join("store", "anchor-on-volume"))
		nativeHandler = (cursor: string) => {
			if (cursor === anchor) return canonicalAnchor
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		}

		const spelled = lockArtefactSpelling(path.join(anchor, "aa", "bb", "task.json"))

		expect(spelled).toBe(path.join(canonicalAnchor, "aa", "bb", "task.json") + ".lock")
	})

	// Nothing inspectable anywhere on the path: the conservative answer is the caller's own
	// spelling plus the suffix, which is the artefact that writer already takes.
	test("falls back to the caller spelling when nothing on the path can be inspected", () => {
		nativeHandler = () => {
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		}
		const nowhere = path.resolve(path.join("store", "gone", "deeper", "task.json"))

		expect(lockArtefactSpelling(nowhere)).toBe(nowhere + ".lock")
	})

	// The root is the one cursor the walk must not step past: `path.dirname` answers with the same
	// string, so that guard is what ends the loop. The handler answers the root only on a second
	// visit, which is what a guard that keeps walking reaches - turning a hang into an artefact this
	// assertion can see.
	test("stops the ancestor walk at the volume root instead of stepping past it", () => {
		const nowhere = path.resolve(path.join("store", "gone", "task.json"))
		const root = path.parse(nowhere).root
		let rootVisits = 0
		nativeHandler = (cursor: string) => {
			if (cursor === root && ++rootVisits > 1) return path.join(root, "root-on-volume")
			throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
		}

		expect(lockArtefactSpelling(nowhere)).toBe(nowhere + ".lock")
		// one ask of the root, and the walk is over; a second visit is the loop the guard prevents
		expect(rootVisits).toBe(1)
	})
})
