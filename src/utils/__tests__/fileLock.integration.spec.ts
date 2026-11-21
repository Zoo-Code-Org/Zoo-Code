import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import { lockArtefactSpelling } from "../fileLock"

// No fs mock in this file. The function's whole answer comes from what the volume reports
// for the nearest existing ancestor, so a mocked realpath proves only that the code reads
// the mock. This is the case the canonicalization exists for: a caller that reaches the
// directory through a link must contend on the same artefact as a caller that reaches it
// directly.
describe("lockArtefactSpelling against a real filesystem", () => {
	let dir: string

	beforeEach(() => {
		dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "file-lock-int-"))
	})

	afterEach(() => {
		fsSync.rmSync(dir, { recursive: true, force: true })
	})

	it("names the canonical ancestor when the caller reaches it through a link", () => {
		const realDir = path.join(dir, "real-dir")
		fsSync.mkdirSync(realDir)
		const linkDir = path.join(dir, "link-dir")
		// A junction on Windows and a directory symlink elsewhere: both are reinterpreted by
		// realpathSync.native, and neither needs elevated privileges.
		fsSync.symlinkSync(realDir, linkDir, process.platform === "win32" ? "junction" : "dir")

		const target = path.join(linkDir, "missing-component", "history_item.json")
		const canonicalRealDir = fsSync.realpathSync.native(realDir)

		expect(lockArtefactSpelling(target)).toBe(
			path.join(canonicalRealDir, "missing-component", "history_item.json") + ".lock",
		)
		// The link name must not survive into the artefact, or the two spellings take two
		// lock files and the writers never see each other.
		expect(lockArtefactSpelling(target)).not.toContain(path.basename(linkDir))
	})
})
