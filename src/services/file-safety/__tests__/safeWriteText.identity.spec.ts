import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { safeWriteText } from "../safeWriteText"

// `rename` has no conditional form: there is no way to ask it to fire only if the file under the
// destination pathname is still the file an authorization was made about. The guard below is
// therefore a comparison, made as late as it can be made, between the identity the caller handed
// in and the identity of the path about to be written - and it refuses rather than publishing
// when they disagree or when the identity cannot be read at all. These rows run against the real
// filesystem, with no stubbing of fs.stat, because the assertion that matters is about what the
// path actually is at the moment of the commit.
describe("safeWriteText authorized identity", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "safe-write-identity-"))
	})
	afterEach(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true })
	})

	it("publishes when the target is still the file the caller authorized", async () => {
		const file = path.join(dir, "target.txt")
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file)
		await safeWriteText(file, "after", { authorizedTarget: { dev: authorized.dev, ino: authorized.ino } })
		expect(await fs.promises.readFile(file, "utf8")).toBe("after")
	})

	// Two live files on one filesystem have different inodes unless they are hard links of each
	// other, so the guard is asked about an identity that provably is not the target's. The first
	// draft of this row unlinked the target and wrote a different file to the same pathname, which
	// passed on Windows and failed on the ubuntu runner: the freshly freed inode came back, so the
	// swapped-in file answered with the authorized identity and the guard correctly accepted it.
	// A test that asserts what a filesystem does with an inode it just released is not a test of
	// this guard.
	it("refuses to publish when the target is not the file whose identity was authorized", async () => {
		const file = path.join(dir, "target.txt")
		const other = path.join(dir, "other.txt")
		await fs.promises.writeFile(file, "before")
		await fs.promises.writeFile(other, "someone else's")
		const otherIdentity = await fs.promises.stat(other)
		await expect(
			safeWriteText(file, "after", { authorizedTarget: { dev: otherIdentity.dev, ino: otherIdentity.ino } }),
		).rejects.toThrow(/changed identity after it was authorized/)
		expect(await fs.promises.readFile(file, "utf8")).toBe("before")
		expect(await fs.promises.readFile(other, "utf8")).toBe("someone else's")
	})

	// Failing closed: an unreadable identity is not the authorized file either, so the write refuses
	// instead of letting a raw stat failure escape as something else.
	it("refuses rather than reporting a raw stat failure when the authorized file is gone", async () => {
		const file = path.join(dir, "target.txt")
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file)
		await fs.promises.unlink(file)
		await expect(
			safeWriteText(file, "after", { authorizedTarget: { dev: authorized.dev, ino: authorized.ino } }),
		).rejects.toThrow(/changed identity after it was authorized/)
		await expect(fs.promises.access(file)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
