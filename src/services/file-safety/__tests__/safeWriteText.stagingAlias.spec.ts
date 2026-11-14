import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteText, StagingPathError } from "../safeWriteText"

// Regression coverage for the caller-supplied staging guard (row 4507642578). The guard used to
// compare the supplied staging file's directory with the target's directory as two strings, and a
// directory alias makes those two strings differ for one directory: canonicalDirKey canonicalizes
// through fs.realpath, so a write whose target is reached via an alias root gets dirPath in the
// referent's spelling while the caller still holds its own, and the string compare refused a
// staging file that was physically inside the target's directory.

// The alias is created with whatever primitive the platform provides, so the hosted Windows lane
// and the hosted Linux lane both run this file: a junction on win32 (a reparse point that Node can
// create without developer-mode privileges), a symlinked directory on POSIX. Both produce the same
// divergence, because realpath resolves either one.
const ALIAS_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir"

function createAlias(referent: string, alias: string): void {
	fsSync.symlinkSync(referent, alias, ALIAS_TYPE)
}

// Removing the alias must not follow it: rmdir drops a junction without touching what it points at,
// and unlink drops a symlink.
function removeAlias(alias: string): void {
	if (process.platform === "win32") {
		fsSync.rmdirSync(alias)
	} else {
		fsSync.unlinkSync(alias)
	}
}

interface AliasFixture {
	root: string
	referent: string
	alias: string
	target: string
}

function makeFixture(initialContent: string): AliasFixture {
	const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "fws-alias-"))
	const referent = path.join(root, "referent")
	const alias = path.join(root, "alias")
	fsSync.mkdirSync(referent)
	fsSync.writeFileSync(path.join(referent, "settings.json"), initialContent, "utf8")
	createAlias(referent, alias)
	return { root, referent, alias, target: path.join(alias, "settings.json") }
}

function disposeFixture(fixture: AliasFixture): void {
	try {
		removeAlias(fixture.alias)
	} catch {
		// The alias is already gone; nothing to release.
	}
	fsSync.rmSync(fixture.root, { recursive: true, force: true })
}

describe("caller-supplied staging path through a directory alias (" + ALIAS_TYPE + ")", () => {
	it("accepts a staging file spelled through the alias of the target's directory", async () => {
		const fixture = makeFixture("initial")
		try {
			// The staging file sits in the alias spelling of the directory the write resolves to the
			// referent of. Identity says one directory, and the guard has to agree.
			const stagingPath = path.join(fixture.alias, ".staged.json")
			await fs.writeFile(stagingPath, "aliased staging", "utf8")
			await safeWriteText(fixture.target, "aliased staging", { tempPath: stagingPath })
			const published = await fs.readFile(path.join(fixture.referent, "settings.json"), "utf8")
			expect(published).toBe("aliased staging")
			// The commit consumed the staging file: it is the target now, wherever it is spelled.
			const stagingRemains = await fs
				.stat(stagingPath)
				.then(() => true)
				.catch(() => false)
			expect(stagingRemains).toBe(false)
		} finally {
			disposeFixture(fixture)
		}
	}, 120000)

	it("still refuses a staging file that sits in a different directory", async () => {
		const fixture = makeFixture("initial")
		try {
			const elsewhere = path.join(fixture.root, "elsewhere")
			fsSync.mkdirSync(elsewhere)
			const stagingPath = path.join(elsewhere, "unrelated.json")
			await fs.writeFile(stagingPath, "unrelated payload", "utf8")
			await expect(safeWriteText(fixture.target, "new content", { tempPath: stagingPath })).rejects.toThrow(
				StagingPathError,
			)
			// The guard still guards: containment was relaxed for aliases, not for distance, and an
			// unrelated file must not be published onto the target.
			const targetContent = await fs.readFile(path.join(fixture.referent, "settings.json"), "utf8")
			expect(targetContent).toBe("initial")
			const unrelatedContent = await fs.readFile(stagingPath, "utf8")
			expect(unrelatedContent).toBe("unrelated payload")
		} finally {
			disposeFixture(fixture)
		}
	}, 120000)

	it("names the target's directory when it refuses", async () => {
		const fixture = makeFixture("initial")
		try {
			const elsewhere = path.join(fixture.root, "elsewhere")
			fsSync.mkdirSync(elsewhere)
			const stagingPath = path.join(elsewhere, "unrelated.json")
			await fs.writeFile(stagingPath, "unrelated payload", "utf8")
			// A resolved write is the failure this row is about, so the error is collected rather than
			// awaited into a union of "nothing" and "the guard's error".
			let failure: StagingPathError | undefined
			try {
				await safeWriteText(fixture.target, "new content", { tempPath: stagingPath })
			} catch (error: unknown) {
				failure = error as StagingPathError
			}
			expect(failure).toBeInstanceOf(StagingPathError)
			// The message quotes the referent spelling, which is the directory the write resolves to -
			// the reason the old compare read an alias as containment failure. The directory is
			// canonicalized before it is compared, because the row is about which directory the
			// message names, not about which spelling the operating system handed the test: on the
			// hosted Windows runner os.tmpdir() is an 8.3 short name (C:\Users\RUNNER~1\AppData\
			// Local\Temp) while canonicalDirKey reports the long spelling through realpath, and the
			// two spellings name one directory. Comparing the raw mkdtemp output against the message
			// made that row fail on a spelling.
			expect(String(failure?.message)).toContain(await fs.realpath(fixture.referent))
			expect(failure?.stagingPath).toBe(path.resolve(stagingPath))
		} finally {
			disposeFixture(fixture)
		}
	}, 120000)
})
