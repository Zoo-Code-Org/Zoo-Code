import { execFileSync } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { DaclRestoreError, safeWriteText } from "../safeWriteText"

// No fs mocks in this file: the point is to assert what a real filesystem ends up
// holding after a publish attempt, which the mocked spec cannot show. The failure is
// provoked with real filesystem semantics rather than with a stubbed call.
describe("safeWriteText against a real filesystem", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-text-int-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("publishes the new bytes and leaves no staging or backup residue", async () => {
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")

		// No platform override: the real platform's own durability and ACL steps run. A failed
		// icacls restore in a throwaway temp directory no longer fails the publish on its own -
		// the committed file is narrowed to a verified restrictive ACL instead - so the publish
		// still lands.
		await safeWriteText(targetPath, "new bytes", { backup: true })

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it.each([false, true])(
		"leaves the target bytes untouched when the publish fails (backup: %s)",
		async (backup) => {
			// backup:false reaches the commit rename, which cannot replace a directory with
			// a regular file (EISDIR on POSIX, EPERM on Windows). backup:true fails earlier,
			// at the copy of the directory made for the backup. Both must leave the target
			// exactly as it was, with no residue.
			const targetPath = path.join(dir, "target-dir")
			await fs.mkdir(targetPath)
			const inside = path.join(targetPath, "payload.txt")
			await fs.writeFile(inside, "original bytes")

			await expect(safeWriteText(targetPath, "new data", { backup })).rejects.toThrow()

			// The directory and its content are exactly as they were, and no backup copy
			// or staging directory was left behind next to them.
			expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
			expect(await fs.readdir(dir)).toEqual(["target-dir"])
		},
	)

	// The row asks for an integration case: what a real icacls leaves on a real file when the
	// saved DACL cannot be reapplied. A throwaway temp directory is exactly where that happens -
	// measured on this host, icacls /restore exits 1300 for every pairing - so this asserts the
	// invariant in terms of the file a caller is left holding, not in terms of icacls calls.
	// The capture half of the row needs no integration case here because a real icacls /save of
	// an existing file succeeds on this host (exit 0, measured); the refusal it triggers when it
	// does not is pinned by the unit tests.
	it.skipIf(process.platform !== "win32")(
		"a real publish never leaves the target under an ACL the caller cannot use",
		async () => {
			const targetPath = path.join(dir, "acl-target.txt")
			await fs.writeFile(targetPath, "old bytes")
			const identity = os.userInfo().username

			let published = true
			try {
				await safeWriteText(targetPath, "new bytes", { backup: true })
			} catch (error: unknown) {
				// The only acceptable failure here is the ACL one, and it must have rolled back.
				expect(error).toBeInstanceOf(DaclRestoreError)
				published = false
				expect(await fs.readFile(targetPath, "utf8")).toBe("old bytes")
			}

			if (!published) {
				return
			}

			// The caller can still read what it wrote: the narrowing grants the current user full
			// control, and a restored DACL keeps whatever the file had before.
			expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
			const acl = execFileSync("icacls", [targetPath], { encoding: "utf8" })
			if (!acl.includes("(I)")) {
				// A narrowing was accepted instead of a restore; then it must be the verified one.
				expect(acl.toLowerCase()).toContain(identity.toLowerCase())
				expect(acl).toContain("(F)")
			}
			// No dump or backup residue survives either outcome.
			expect((await fs.readdir(dir)).filter((n) => !n.endsWith(".txt"))).toEqual([])
		},
	)
})
