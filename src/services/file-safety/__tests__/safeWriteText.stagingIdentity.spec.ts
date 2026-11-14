import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { vi } from "vitest"

import { PublishedEntryMismatchError, safeWriteText } from "../safeWriteText"

// The window this finding is about sits between the descriptor checks and the commit call, so the
// substitution has to land inside the commit itself. The write path reaches link and rename through
// the fs/promises namespace, so those two calls are wrapped here and nothing else is: the hook runs
// immediately before the real call, and every other member of the namespace, including the stat
// and unlink calls the write path and the assertions below use, is the real implementation. The hook
// itself only performs real filesystem operations, so no case here runs against a stubbed filesystem.
let substituteBeforeCommit: ((stagingPath: string) => void) | null = null

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		link: (oldPath: string, newPath: string): Promise<void> => {
			if (substituteBeforeCommit !== null) {
				substituteBeforeCommit(oldPath)
			}
			return actual.link(oldPath, newPath)
		},
		rename: (oldPath: string, newPath: string): Promise<void> => {
			if (substituteBeforeCommit !== null) {
				substituteBeforeCommit(oldPath)
			}
			return actual.rename(oldPath, newPath)
		},
	}
})

describe("safeWriteText commits the file its own descriptor opened", () => {
	const SUBSTITUTED = "bytes from another process"
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-text-descriptor-"))
		substituteBeforeCommit = null
	})

	afterEach(async () => {
		substituteBeforeCommit = null
		await fs.rm(dir, { recursive: true, force: true })
	})

	// Removes the staged name and creates a different file under it, so the entry the commit then
	// publishes has an inode of its own rather than the one this write opened, wrote and fsynced.
	function substituteWithAnotherFile(content: string): void {
		substituteBeforeCommit = function (staged: string): void {
			// Pin the original inode under a second name before the staged name is removed. Without this
			// the substitute can take back the inode number the unlink just freed, which Linux does readily
			// and NTFS does not do that fast, and then dev:ino agree and nothing is a mismatch.
			fsSync.linkSync(staged, staged + ".orig")
			fsSync.rmSync(staged, { force: true })
			fsSync.writeFileSync(staged, content)
		}
	}

	async function namesIn(directory: string): Promise<string[]> {
		return (await fs.readdir(directory)).sort()
	}

	it("reports the substitution instead of publishing it silently when the commit replaces the target", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.txt")
		await fs.writeFile(targetPath, "old bytes")
		await fs.writeFile(stagingPath, "new bytes")
		substituteWithAnotherFile(SUBSTITUTED)

		await expect(
			safeWriteText(targetPath, "ignored by the caller-staged path", { tempPath: stagingPath }),
		).rejects.toBeInstanceOf(PublishedEntryMismatchError)

		// A commit that leaves no second name still reports, because the reference is the identity the
		// write's own descriptor reported before the rename and not something read back from a name. The
		// other process's file is what arrived, and it stays there: the entry under the target is not this
		// write's to remove.
		expect(await fs.readFile(targetPath, "utf8")).toBe(SUBSTITUTED)
		expect(await namesIn(dir)).toEqual(["staging.txt.orig", "target.txt"])
	})

	it("reports the substitution completed before a no-replace commit, where the two names agree on it", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.txt")
		await fs.writeFile(stagingPath, "new bytes")
		substituteWithAnotherFile(SUBSTITUTED)

		await expect(
			safeWriteText(targetPath, "ignored by the caller-staged path", {
				tempPath: stagingPath,
				failIfExist: true,
			}),
		).rejects.toBeInstanceOf(PublishedEntryMismatchError)

		// link(2) linked whatever the staged name held at that instant, so after the commit both names
		// report the substituted inode and comparing the two names against each other passes. Neither name
		// is removed, because the staged name may be the only path to a file another process owns.
		expect(await fs.readFile(targetPath, "utf8")).toBe(SUBSTITUTED)
		expect(await namesIn(dir)).toEqual(["staging.txt", "staging.txt.orig", "target.txt"])
	})

	it("publishes the staged bytes when the staged name gains a second link but keeps its inode", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.txt")
		await fs.writeFile(stagingPath, "new bytes")
		substituteBeforeCommit = function (staged: string): void {
			fsSync.linkSync(staged, staged + ".dup")
		}

		// The staged entry is reachable under two names and is still the same file, which is a publish
		// and not a substitution: the guard compares identities, so it must stay silent here.
		await safeWriteText(targetPath, "ignored by the caller-staged path", {
			tempPath: stagingPath,
			failIfExist: true,
		})

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await namesIn(dir)).toEqual(["staging.txt.dup", "target.txt"])
	})

	it("publishes the staged bytes with nothing reported when the staged name is never substituted", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.txt")
		await fs.writeFile(stagingPath, "new bytes")

		// The wrapper is installed for this case too, so a clean run here is what rules out the wrapper
		// itself as the source of the reports above.
		await safeWriteText(targetPath, "ignored by the caller-staged path", {
			tempPath: stagingPath,
			failIfExist: true,
		})

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await namesIn(dir)).toEqual(["target.txt"])
	})
})
