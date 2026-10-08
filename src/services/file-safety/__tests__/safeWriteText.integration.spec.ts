import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteText } from "../safeWriteText"

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

	// The commit-rename failure mode is covered deterministically in safeWriteText.spec.ts
	// ('a failed commit does not move the target, so nothing has to be rolled back'): on a real
	// filesystem there is no portable way to make only the rename fail - the ESM fs namespace
	// cannot be spied, and read-only-parent / sticky-bit / cross-device setups are not portable.
	it("publishes the new bytes and leaves no staging or backup residue", async () => {
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")

		// No platform override: the real platform's own durability and ACL steps run.
		// A failed icacls restore in a throwaway temp directory is reported, not thrown,
		// so the publish still lands.
		await safeWriteText(targetPath, "new bytes", { backup: true })

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("leaves the target bytes untouched when the backup copy cannot be made", async () => {
		// A regular file cannot be renamed over a directory, so the step-3 backup copy fails
		// on a real filesystem with no mocking. Note what this case does NOT cover: the commit
		// rename is never reached, because the backup failure aborts the write first.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow()

		// The directory and its content are exactly as they were, and no backup copy
		// or staging directory was left behind next to them.
		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})
})
