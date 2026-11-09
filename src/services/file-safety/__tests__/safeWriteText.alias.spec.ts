import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { safeWriteText, StagingPathError } from "../safeWriteText"

// NTFS hands an 8.3 alias to every component whose name is longer than eight characters, so one
// directory answers to two spellings. The hosted Windows runner is the case that matters: its
// temp directory arrives in the short form under the profile while the writer's resolved target
// arrives in the long spelling, and the staging file created beside that target carries whichever
// spelling the caller's canonicalisation produced. A textual comparison of the two directories then
// rejects a staging file that really is beside the target - that is the StagingPathError the
// windows job reports at the staging guard.
//
// The alias cannot be invented where 8.3 names are not generated, so this file asks cmd for the
// short spelling of a directory it just created and skips the suite where no alias appears: on any
// platform that is not win32, where cmd.exe does not exist and no alias could exist either, and on
// a win32 volume that has 8.3 name generation switched off. The probe has to answer that question
// without throwing: until now the probe ran while the module was being imported, so a worker with no
// cmd.exe failed the import and vitest recorded a failed suite instead of skipping the suite.
// What node 22.23.4 - the version .tool-versions and engines pin -
// does with those two spellings is asserted below rather than assumed: path.resolve preserves
// whichever spelling it is handed, fs.realpath preserves it too, and fs.stat reports one identity
// for both. The guard compares identities for exactly that reason.

const IS_WINDOWS = process.platform === "win32"
const SHORT_NAME_MARKER = "~1"
const SHORT_NAME_PROBE_BIN = "cmd.exe"

// Total: every failure mode answers null so that the caller skips instead of dying. A non-win32
// worker has neither cmd.exe nor 8.3 aliases and is answered without spawning anything; a cmd that
// is missing, refuses the query, or answers without an alias means no alias to test against.
function shortPathOf(directory: string): string | null {
	if (!IS_WINDOWS) {
		return null
	}
	try {
		// The directory has to reach cmd quoted. cmd's `for ... in (set)` splits an unquoted set
		// on spaces, so a directory named "...has a space inside it" becomes six items and cmd
		// echoes one line per item, each resolved against cmd's own working directory (measured
		// with node 22.23.4: the unquoted form answers six lines for one directory). Quoting the
		// item is not enough by itself: quoting argv entries that contain spaces leaves cmd a value
		// whose quotes are part of the name, so %~sA hands back the long spelling wrapped in quotes
		// and the probe reports no alias at all (measured: three rows skipped, none run).
		// windowsVerbatimArguments hands cmd exactly the string written here, which is the only
		// measured form that answers a single short path for a directory with a space. It is a
		// spawnSync option in the node typings - execFileSync's typed options do not carry it
		// (tsc reports TS2769 there), so the probe runs through the API that documents the flag.
		// Both measure the same answer in all four quoting combinations (measured with node 22.23.4
		// on win32), so the switch changes the typing, not the behaviour.
		const probe = spawnSync(SHORT_NAME_PROBE_BIN, ["/c", 'for %A in ("' + directory + '") do @echo %~sA'], {
			encoding: "utf8",
			windowsVerbatimArguments: true,
		})
		// The typings say `error: Error | null`; spawnSync actually leaves it undefined on a
		// successful run, and a `!== null` test would reject every healthy probe - which is how
		// the whole suite ends up silently skipped rather than run.
		if (probe.error || probe.status !== 0 || probe.stdout === null) {
			return null
		}
		const out = probe.stdout.trim()
		return out.includes(SHORT_NAME_MARKER) ? out : null
	} catch {
		return null
	}
}

// Answered once at import so that it.runIf can decide before any test body runs. Never allowed to
// throw: a throwing probe is a failed import, which vitest reports as a failed suite that no skip
// condition can rescue.
function probeGeneratesEightThreeNames(): boolean {
	if (!IS_WINDOWS) {
		return false
	}
	let probeBase: string | undefined
	try {
		probeBase = fs.mkdtempSync(path.join(os.tmpdir(), "safe-write-alias-probe-"))
		const probeDir = path.join(probeBase, "EightThreeNameProbe")
		fs.mkdirSync(probeDir)
		return shortPathOf(probeDir) !== null
	} catch {
		return false
	} finally {
		// Cleanup must not decide the answer. `force` swallows a missing directory but not the
		// EPERM/EBUSY Windows reports while a handle is still being released, and a throw from this
		// finally block escapes the function at module import time - the failed-suite-with-no-skip-
		// that-vitest-can-rescue case this probe exists to avoid.
		if (probeBase !== undefined) {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					fs.rmSync(probeBase, { recursive: true, force: true })
					break
				} catch {
					if (attempt === 1) break
				}
			}
		}
	}
}

const EIGHT_THREE_NAMES_ARE_GENERATED = probeGeneratesEightThreeNames()

describe("safeWriteText staging guard against a second spelling of the target directory", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "safeWriteText-alias-"))
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function createTargetDirectory(): { longPath: string; shortPath: string | null } {
		const longPath = path.join(tempDir, "LONGTARGETDIRECTORYNAME")
		fs.mkdirSync(longPath)
		return { longPath, shortPath: shortPathOf(longPath) }
	}

	it.runIf(EIGHT_THREE_NAMES_ARE_GENERATED)(
		"publishes a staging file spelled through the target directory own 8.3 alias",
		async () => {
			const { longPath, shortPath } = createTargetDirectory()
			if (shortPath === null) {
				return
			}
			const targetPath = path.join(longPath, "target.txt")
			fs.writeFileSync(targetPath, "committed", "utf8")
			// The staging file sits beside the target but is spelled through the directory's 8.3
			// alias, which is what a caller's own canonicalisation hands the guard.
			const stagingPath = path.join(shortPath, ".new_target.txt_1_x.tmp")
			fs.writeFileSync(stagingPath, "staged", "utf8")

			// Preconditions, asserted rather than assumed: the two directory spellings differ as text
			// and this runtime's fs.realpath does not unify them...
			expect(path.dirname(stagingPath)).not.toBe(path.dirname(targetPath))
			const realViaAlias = fs.realpathSync(path.dirname(stagingPath))
			const realViaTarget = fs.realpathSync(path.dirname(targetPath))
			expect(realViaAlias).not.toBe(realViaTarget)
			// ...while fs.stat reports the same directory for both spellings. That identity is what
			// the guard compares, and it is why a rename from here onto the target cannot be EXDEV.
			const statViaAlias = fs.statSync(path.dirname(stagingPath), { bigint: true })
			const statViaTarget = fs.statSync(path.dirname(targetPath), { bigint: true })
			expect(statViaAlias.dev).toBe(statViaTarget.dev)
			expect(statViaAlias.ino).toBe(statViaTarget.ino)

			await safeWriteText(targetPath, "", { tempPath: stagingPath, backup: false })

			expect(fs.readFileSync(targetPath, "utf8")).toBe("staged")
			expect(fs.existsSync(stagingPath)).toBe(false)
		},
	)

	// The probe above is the harness for every row in this file, so a command that quotes the directory
	// badly answers null for the probe directory and it.runIf skips the whole file: the suite cannot tell
	// "this volume generates no 8.3 names" from "our cmd command broke". This row asks its own question,
	// about its own directory, and skips only on the platform that has no cmd.exe to ask.
	it.runIf(IS_WINDOWS)("checks alias discovery without going through the capability flag", () => {
		const spacedDir = path.join(tempDir, "SELF CHECKING TARGET DIRECTORY")
		fs.mkdirSync(spacedDir)
		// The same command shortPathOf runs, with the answer kept instead of collapsed to null.
		const query = 'for %A in ("' + spacedDir + '") do @echo %~sA'
		const raw = spawnSync(SHORT_NAME_PROBE_BIN, ["/c", query], {
			encoding: "utf8",
			windowsVerbatimArguments: true,
		})
		const answers = raw.stdout.trim().split(/\r?\n/)
		// One answer, not one answer per word of the directory name.
		expect(answers).toHaveLength(1)
		expect(fs.existsSync(answers[0])).toBe(true)
		expect(fs.statSync(answers[0]).isDirectory()).toBe(true)
		// Where this volume really does hand out an alias - the answer carries the short-name marker - the
		// production probe has to answer it for the same directory. A command that lost its quotes answers
		// one line per word here and fails this row, where the flag above would only have skipped it.
		if (answers[0].includes(SHORT_NAME_MARKER)) {
			const short = shortPathOf(spacedDir)
			expect(short).not.toBeNull()
			expect(short).toBe(answers[0])
		}
	})

	// The probe is the harness for both rows below, and its own answer is what breaks when the
	// directory is quoted badly: a space in a directory name is not exotic on Windows - every
	// profile path under "Documents and Settings" has one - and an unquoted for-set turns one
	// directory into one line per word of its name.
	it.runIf(IS_WINDOWS && EIGHT_THREE_NAMES_ARE_GENERATED)(
		"answers one short path for a directory whose name contains a space",
		() => {
			const spacedDir = path.join(tempDir, "SPACE CONTAINING TARGET DIRECTORY")
			fs.mkdirSync(spacedDir)
			const short = shortPathOf(spacedDir)
			expect(short).not.toBeNull()
			if (short === null) {
				return
			}
			// One answer, not one answer per word of the name.
			expect(short.split(/\r?\n/)).toHaveLength(1)
			// And the answer is a directory that exists, not a token of the name resolved
			// against the probe's own working directory.
			expect(fs.existsSync(short)).toBe(true)
			expect(fs.statSync(short).isDirectory()).toBe(true)
			const viaShort = fs.statSync(short, { bigint: true })
			const viaLong = fs.statSync(spacedDir, { bigint: true })
			expect([String(viaShort.dev), String(viaShort.ino)]).toEqual([String(viaLong.dev), String(viaLong.ino)])
		},
	)

	it.runIf(EIGHT_THREE_NAMES_ARE_GENERATED)(
		"still rejects a staging file spelled through another directory 8.3 alias",
		async () => {
			const { longPath } = createTargetDirectory()
			const otherPath = path.join(tempDir, "OTHERTARGETDIRECTORYNAME")
			fs.mkdirSync(otherPath)
			const otherShort = shortPathOf(otherPath)
			if (otherShort === null) {
				return
			}
			const targetPath = path.join(longPath, "target.txt")
			fs.writeFileSync(targetPath, "committed", "utf8")
			const stagingPath = path.join(otherShort, ".new_target.txt_1_x.tmp")
			fs.writeFileSync(stagingPath, "staged", "utf8")

			// Same alias mechanism, different directory. Accepting the target directory's alias must
			// not become accepting any directory, or a caller could publish an unrelated file onto the
			// target through a name the guard was written to refuse.
			await expect(safeWriteText(targetPath, "", { tempPath: stagingPath, backup: false })).rejects.toThrow(
				StagingPathError,
			)
			expect(fs.readFileSync(targetPath, "utf8")).toBe("committed")
			expect(fs.existsSync(stagingPath)).toBe(true)
		},
	)
})
