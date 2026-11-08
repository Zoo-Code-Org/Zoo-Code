import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"

// Capture the actual implementation before the mock factory wraps it, so a wrapped realpath can
// delegate to the real one - and run a real filesystem side effect at the moment the guard asks -
// without recursing into itself.
// Typed by the hoisted callback's return type rather than by a cast on undefined: the target type
// is an overloaded function type, and casting undefined straight to it is what tsc rejects (TS2352).
const actuals = vi.hoisted((): { realpath?: (typeof import("fs/promises"))["realpath"] } => ({
	realpath: undefined,
}))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	actuals.realpath = actual.realpath
	// Only realpath is wrapped. The staging guard does not consult stat at all: a probe that cannot
	// answer is not an answer, and nothing here has to stub stat for the guard to do its job.
	return { ...actual, realpath: vi.fn(actual.realpath) }
})

import * as fs from "fs/promises"

/**
 * Controls on the staging-directory drift guard in safeWriteJson: the re-verification that runs
 * between approving a staging directory beside the publish target and streaming into it. The guard
 * may act on one thing only - a re-resolution that succeeds and lands on a different directory -
 * and it must not reject an ordinary write because a probe could not answer, because the approved
 * path is spelled differently from the way the same directory is reported, or because a directory
 * that really is gone is reported as missing. The alias below is the portable form of the Windows
 * case that broke the windows test:misc lane: on a GitHub runner the temp root arrives spelled with
 * its 8.3 short name (C:\Users\RUNNER~1\AppData\Local\Temp), resolvePublishTarget returns that
 * lexical path for a target that does not exist yet, and realpath reports the long name for that
 * very same directory.
 */
/**
 * safeWriteJson stages as .<basename>.new_<timestamp>_<random>.tmp - createTempFilePath at
 * safeWriteJson.ts:192-197, the template main carries at its :54 - so a staged leftover never
 * starts with ".new_": it starts with the target's own name. Matching the infix is what lets
 * the "nothing left staged" assertions below see a leak at all; the startsWith form matches
 * only safeWriteText's own ".new_<ts>_<rand>.tmp" names (safeWriteText.ts:92-94), which this
 * file never stages. safeWriteJson.interruption.test.ts:196 already filters by infix.
 */
const stagedFile = (name: string): boolean => name.includes(".new_")

describe("safeWriteJson staging directory drift", () => {
	let tmpRoot = ""

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swj-staging-drift-"))
	})

	afterEach(async () => {
		vi.mocked(fs.realpath).mockReset()
		vi.mocked(fs.realpath).mockImplementation(async (...args) => await actuals.realpath!(...args))
		if (tmpRoot) {
			await fs.rm(tmpRoot, { recursive: true, force: true })
			tmpRoot = ""
		}
	})

	/**
	 * Run a real filesystem side effect at the guard's second reading of the approved directory. The
	 * guard canonicalizes the approved directory and then re-resolves that canonical path; every
	 * other realpath this write performs is passed the file itself or the alias spelling, because the
	 * lock key and the staging directory are both derived from the directory as the caller spelled
	 * it. So "the argument is already the canonical referent" identifies the second reading without
	 * counting calls. Returns whether the effect ever ran, which every case asserts so a guard that
	 * stopped asking is caught rather than silently passed.
	
 * What the guard may act on is a single signal: the re-resolution of the approved directory
 * succeeds and lands on a different directory. A probe that cannot answer - ENOENT, EACCES, EPERM,
 * ELOOP, or an fs double that reports the path as missing - carries no information about
 * replacement, so it must not reject the write; a directory that really is gone then fails at the
 * staging write itself, which is still fail-closed with nothing created outside the approved
 * directory.
 */
	function actAtRewalk(canonicalReferent: string, act: () => Promise<void>): () => boolean {
		let acted = false
		vi.mocked(fs.realpath).mockImplementation(async (...args) => {
			const lexical = path.resolve(String(args[0]))
			if (!acted && lexical === canonicalReferent) {
				acted = true
				await act()
			}
			return await actuals.realpath!(...args)
		})
		return () => acted
	}

	it("writes through an alias directory when the target does not exist yet", async () => {
		const referent = path.join(tmpRoot, "referent-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const target = path.join(alias, "settings.json")

		await safeWriteJson(target, { preserved: true })

		const written = await fs.readFile(path.join(referent, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
		// Nothing may be left staged on either spelling of the same directory.
		expect((await fs.readdir(referent)).filter(stagedFile)).toEqual([])
		expect((await fs.readdir(alias)).filter(stagedFile)).toEqual([])
	})

	it("stages anyway when the guard's probe cannot answer", async () => {
		// A probe that cannot answer is not an answer. The filesystem refuses to canonicalize the
		// directory this write was approved for - here with EACCES, which is the failure the walk
		// cannot absorb into a retry from an existing ancestor - and refusal says nothing about the
		// directory having been replaced, so the write proceeds. This is the case that reddens when
		// the narrowing is reverted: without it the guard is back to treating "I could not look" as
		// evidence of drift, and an ordinary write into a directory it cannot stat is rejected.
		const referent = path.join(tmpRoot, "referent-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const referentReal = await actuals.realpath!(referent)
		const target = path.join(alias, "settings.json")
		const acted = actAtRewalk(referentReal, async () => {
			const refused = new Error("EACCES: permission denied, realpath") as NodeJS.ErrnoException
			refused.code = "EACCES"
			throw refused
		})

		await safeWriteJson(target, { preserved: true })

		expect(acted()).toBe(true) // the guard really asked, and really was not answered
		const written = await fs.readFile(path.join(referent, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
		expect((await fs.readdir(referent)).filter(stagedFile)).toEqual([])
	})

	it("stages anyway under the task persistence suite's blanket missing stat", async () => {
		// The shape that made CI red: core/task/__tests__/Task.spec.ts mocks fs/promises with
		// stat: vi.fn().mockRejectedValue({ code: "ENOENT" }) for every path, and its task directory
		// (a Windows temp path under \\test-storage\\tasks\\, created moments earlier by
		// fsReal.mkdirSync) demonstrably existed at the instant the guard asked - both directory
		// resolutions returned it and the unmocked fs.statSync reported the same inode. Measured on
		// the old guard, exactly one fs.stat call was enough to reject that write as drift. Here the
		// same blanket double sits over a write whose directory really is there: the guard must not
		// consult it about the directory, and this case reddens if it ever starts to; the one stat call
		// the write is allowed to make is its own publish-target mode read, counted below.
		const referent = path.join(tmpRoot, "referent-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const target = path.join(alias, "settings.json")
		let statPaths: string[] = []
		const statSpy = vi.spyOn(fs, "stat").mockRejectedValue({ code: "ENOENT" })
		let failure: unknown
		try {
			await safeWriteJson(target, { preserved: true })
		} catch (error) {
			failure = error
		} finally {
			statPaths = statSpy.mock.calls.map((call) => String(call[0]))
			statSpy.mockRestore()
		}
		expect(failure).toBeUndefined()
		// Nothing asked fs.stat about the approved directory, which is the question this row pins. The
		// one call that was made named the publish target: it is the mode read (_readPublishTargetMode
		// in safeWriteJson.ts) that row 4507642592 added, and the same blanket double answers it here
		// with "not there", which the mode read reads as "no mode to carry over" rather than as a
		// reason to refuse the write.
		const directoryQuestions = statPaths.filter((p) => path.basename(p) !== "settings.json")
		expect(directoryQuestions.length).toBe(0)
		expect(statPaths.length).toBe(1)
		const written = await fs.readFile(path.join(referent, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
	})

	it("stages anyway when the re-walk reports the directory missing mid-replacement", async () => {
		// The other reading of "cannot answer": the directory is there, but a component is being
		// swapped and realpath reports ENOENT for one instant. _resolveScopeRoot already tolerates
		// that - it retries from its nearest existing ancestor and rejoins the same spelling - so
		// this case is absorbed by the walk rather than by the guard, and it is NOT the control for
		// the narrowing: the EACCES case above is, because that failure is the one the walk rethrows.
		const referent = path.join(tmpRoot, "referent-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const referentReal = await actuals.realpath!(referent)
		const target = path.join(alias, "settings.json")
		const acted = actAtRewalk(referentReal, async () => {
			const missing = new Error("ENOENT: no such file or directory, realpath") as NodeJS.ErrnoException
			missing.code = "ENOENT"
			throw missing
		})

		await safeWriteJson(target, { preserved: true })

		expect(acted()).toBe(true)
		const written = await fs.readFile(path.join(referent, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
	})

	it("still rejects when the approved directory is replaced by a junction before staging", async () => {
		// The fail-closed side, decided by a real filesystem rather than by a stubbed answer: the
		// directory the write was approved for is renamed aside and a junction is planted in its place
		// pointing at a different directory, at the instant the guard takes its second reading of it.
		// The junction is the portable twin of the POSIX symlink case (a Windows runner cannot create
		// symlinks in an unprivileged checkout but can create junctions, and the first case above
		// already plants one). realpath is left real: the wrapper decides only WHEN the plant happens,
		// and the answer the guard reads comes from the OS.
		const referent = path.join(tmpRoot, "approved-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const elsewhere = path.join(tmpRoot, "elsewhere")
		await fs.mkdir(elsewhere, { recursive: true })
		const referentReal = await actuals.realpath!(referent)
		const elsewhereReal = await actuals.realpath!(elsewhere)
		const moved = path.join(tmpRoot, "approved-dir-moved")
		const target = path.join(alias, "settings.json")
		const acted = actAtRewalk(referentReal, async () => {
			await fs.rename(referent, moved)
			await fs.symlink(elsewhereReal, referent, process.platform === "win32" ? "junction" : "dir")
		})

		await expect(safeWriteJson(target, { preserved: true })).rejects.toThrow(/Refusing to stage/)

		expect(acted()).toBe(true)
		// Rejected before staging: the planted destination got nothing, and the directory this write
		// was approved for - now spelled by where it was moved to - got no staged file and no published
		// target. (Its advisory lock directory is still there: the lock lives beside the target, and the
		// plant moved the target out from under the held lock, which is the state this case creates.)
		expect(await fs.readdir(elsewhere)).toEqual([])
		expect((await fs.readdir(moved)).filter((name) => name === "settings.json" || stagedFile(name))).toEqual([])
	})

	it("fails as a failed write when the approved directory is really gone", async () => {
		// The case the removed stat probe used to decide by asserting drift: the directory is deleted
		// for real at the guard's second reading. Nothing is created outside the directory the write
		// was approved for and nothing is published, so the write is still fail-closed - it simply
		// fails as the failed write it is instead of claiming to be evidence of replacement. This case
		// is NOT a control for the narrowing: the deletion is keyed to the guard's second reading, so
		// the old guard had already cleared its existence probe before the directory went, and it
		// passes on both guards. The two cannot-answer cases above are the load-bearing controls.
		const referent = path.join(tmpRoot, "doomed-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const referentReal = await actuals.realpath!(referent)
		const target = path.join(alias, "settings.json")
		const acted = actAtRewalk(referentReal, async () => {
			await fs.rm(referent, { recursive: true, force: true })
		})

		await expect(safeWriteJson(target, { preserved: true })).rejects.toThrow(/ENOENT/)

		expect(acted()).toBe(true)
		// The alias now dangles, nothing was published through it, and the only thing left under the
		// temp root is the alias itself: no staged file, no lock directory, no stray destination.
		const published = await fs.readFile(target, "utf8").catch(() => null)
		expect(published).toBeNull()
		expect((await fs.readdir(tmpRoot)).sort()).toEqual(["alias-dir"])
	})
	it("follows the approved pathname when the directory is replaced before the guard reads it", async () => {
		// The ordering this guard cannot see, recorded rather than wished away: the approved directory
		// is renamed aside and replaced by a junction onto a different directory BEFORE the guard
		// takes its first reading, so both readings agree on the foreign directory and the drift
		// signal stays silent. Neither layer rejects the write - not the drift guard (both readings
		// land on the same place) and not safeWriteText's beside-the-target check (its tempPath and
		// its re-resolved publish target are both spelled through the same alias, and
		// resolvePublishTarget returns the path it was given while the target file is still absent).
		// The write therefore completes at wherever the approved pathname now points, with no staged
		// file left anywhere: measured identical before and after the narrowing, so this is a property
		// of the guard's design, not a change in behavior. What it does mean is that the file can be
		// published into a directory the writer's lock - which stayed with the renamed directory -
		// does not name, the same hazard the lock-key drift check covers for a target alias that
		// moves, and a reader who wants that ordering rejected has to reject it in safeWriteText.
		const referent = path.join(tmpRoot, "approved-dir")
		await fs.mkdir(referent, { recursive: true })
		const alias = path.join(tmpRoot, "alias-dir")
		await fs.symlink(referent, alias, process.platform === "win32" ? "junction" : "dir")
		const elsewhere = path.join(tmpRoot, "elsewhere")
		await fs.mkdir(elsewhere, { recursive: true })
		const elsewhereReal = await actuals.realpath!(elsewhere)
		const moved = path.join(tmpRoot, "approved-dir-moved")
		const aliasSpelling = path.resolve(alias)
		const target = path.join(alias, "settings.json")
		let readings = 0
		let planted = false
		vi.mocked(fs.realpath).mockImplementation(async (...args) => {
			const lexical = path.resolve(String(args[0]))
			// Readings 1 and 2 are the lock-key canonicalization before and after the lock; reading 3
			// is the guard's approval of the staging directory, and the swap is planted as that reading
			// is taken, so the approval already sees the foreign directory.
			if (lexical === aliasSpelling) {
				readings += 1
				if (readings === 3 && !planted) {
					planted = true
					await fs.rename(referent, moved)
					await fs.symlink(elsewhereReal, referent, process.platform === "win32" ? "junction" : "dir")
				}
			}
			return await actuals.realpath!(...args)
		})

		await safeWriteJson(target, { preserved: true })

		expect(readings).toBe(3)
		expect(planted).toBe(true)
		const written = await fs.readFile(path.join(elsewhere, "settings.json"), "utf8")
		expect(JSON.parse(written)).toEqual({ preserved: true })
		// Nothing stranded: the renamed directory holds only the advisory lock directory that lives
		// beside the target, and neither spelling of it nor the new location holds a staged file.
		expect((await fs.readdir(moved)).filter((name) => name === "settings.json" || stagedFile(name))).toEqual([])
		expect((await fs.readdir(elsewhere)).filter(stagedFile)).toEqual([])
	})
})
