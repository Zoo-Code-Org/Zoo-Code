import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import { safeWriteText } from "../safeWriteText"

// No fs mocks in this file: the point is to assert what a real filesystem ends up
// holding after a publish attempt, which the mocked spec cannot show. The failure is
// provoked with real filesystem semantics rather than with a stubbed call. The one
// exception is fs/promises lstat below, which is wrapped in a delegating mock so a row
// can perform a replacement at the moment the write looks at the staging name and still
// hand every lookup, including its own, to the real filesystem.
// The holder is hoisted so a row can hand a lookup back to the real implementation instead of to
// the wrapper it is standing in for.
const actualLstat = vi.hoisted(() => ({ fn: undefined as (typeof import("fs/promises"))["lstat"] | undefined }))

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	actualLstat.fn = actual.lstat
	return {
		...actual,
		lstat: vi.fn(actual.lstat),
	}
})
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

		// No platform override: the real platform's own durability and ACL steps run, and this
		// case is the successful restore. A failed restore is best-effort: it is logged and
		// the publish still resolves after the commit rename, so the residue assertions
		// below hold whichever way icacls went on the machine running the test.
		await safeWriteText(targetPath, "new bytes", { backup: true })

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("leaves the target bytes untouched when the commit cannot replace it", async () => {
		// A regular file cannot be renamed over a directory, so the backup copy and
		// the commit both fail on a real filesystem with no mocking at all.
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

	it("cleans up the staging file when the commit rename itself fails", async () => {
		// With backup:false the backup step is skipped, so this is the only shape of
		// this scenario that reaches Step 4: the rename of the staging FILE over the
		// target DIRECTORY fails (EISDIR / ENOTDIR / EPERM depending on platform), and
		// the cleanup must remove the staging file. The backup:true case above bails
		// out in the backup step and never exercises the commit-failure path.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: false })).rejects.toThrow()

		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})
})

// A recorded identity is only worth recording if a real replacement disagrees with it. The
// mocked spec shows which clause fires; these two rows show that the numbers being compared
// are the filesystem's own, and that the second look is what stops a name swapped between the
// permission pass and the commit.
describe("safeWriteText staging identity against a real filesystem", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-text-int-identity-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("publishes through a caller-supplied staging name it re-read from the filesystem", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.tmp")
		// The caller stages the bytes; this write is the one that fsyncs them and publishes them,
		// so the staging name has to carry the content before the call.
		await fs.writeFile(stagingPath, "staged bytes")

		await safeWriteText(targetPath, "staged bytes", { tempPath: stagingPath, backup: false })

		// The recorded dev and ino are the filesystem's own here, so this success is the proof that
		// the re-checks are not comparing an empty record against itself.
		expect(await fs.readFile(targetPath, "utf8")).toBe("staged bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("refuses the commit when a peer replaces the staging name between the two looks", async () => {
		const targetPath = path.join(dir, "target.txt")
		const stagingPath = path.join(dir, "staging.tmp")
		await fs.writeFile(stagingPath, "staged bytes")

		const realLstat = actualLstat.fn!
		const wanted = path.resolve(stagingPath)
		let looks = 0
		vi.mocked(fs.lstat).mockImplementation(async (p) => {
			if (path.resolve(String(p)) === wanted) {
				looks++
				if (looks === 3) {
					// Unlinked and re-created with other bytes: the same spelling now denotes a
					// different inode, which is the one thing the recorded identity can see.
					fsSync.unlinkSync(stagingPath)
					fsSync.writeFileSync(stagingPath, "swapped by a peer")
				}
			}
			return realLstat(p)
		})

		try {
			await expect(
				safeWriteText(targetPath, "staged bytes", { tempPath: stagingPath, backup: false }),
			).rejects.toThrow(/Staging file changed before the commit/)
		} finally {
			vi.mocked(fs.lstat).mockRestore()
		}

		// The swap landed after the permission pass had run on the authorized inode and before the
		// publish: nothing was committed, so the target was never created, and the name this write was
		// told to publish is torn down by the failure path instead of leaving the peer's bytes filed
		// under it. The peer's own inode was never the one this write acted on.
		expect(fsSync.existsSync(stagingPath)).toBe(false)
		expect(fsSync.existsSync(targetPath)).toBe(false)
	})
})
