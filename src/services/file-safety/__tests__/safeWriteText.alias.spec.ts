import { execFileSync } from "child_process"
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
		const out = execFileSync(SHORT_NAME_PROBE_BIN, ["/c", "for %A in (" + directory + ") do @echo %~sA"], {
			encoding: "utf8",
		}).trim()
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
		if (probeBase !== undefined) {
			fs.rmSync(probeBase, { recursive: true, force: true })
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
