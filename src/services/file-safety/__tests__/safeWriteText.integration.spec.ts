import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"

import { safeWriteText } from "../safeWriteText"

/**
 * Every other suite in this directory mocks fs/promises and fs, so nothing there proves the real
 * open/write/fsync/rename sequence produces a file on disk. This suite uses a real temporary
 * directory and no mocks at all: it asserts the outcome (bytes on disk) and the absence of residue
 * (staging directory, temp file, backup).
 */
describe("safeWriteText against a real filesystem", () => {
	let dir: string

	beforeEach(() => {
		dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "safe-write-it-"))
	})

	afterEach(() => {
		fsSync.rmSync(dir, { recursive: true, force: true })
	})

	function _leftovers(): string[] {
		return fsSync.readdirSync(dir).filter((name) => name.includes(".file-safety-staging") || name.includes(".new_") || name.includes(".bak"))
	}

	it("creates a new file with the requested bytes and leaves no residue", async () => {
		const target = path.join(dir, "brand-new.txt")

		await safeWriteText(target, "first content")

		expect(fsSync.readFileSync(target, "utf8")).toBe("first content")
		expect(_leftovers()).toEqual([])
	})

	it("replaces an existing file and leaves no residue", async () => {
		const target = path.join(dir, "existing.txt")
		fsSync.writeFileSync(target, "old")

		await safeWriteText(target, "replacement")

		expect(fsSync.readFileSync(target, "utf8")).toBe("replacement")
		expect(_leftovers()).toEqual([])
	})
}) 