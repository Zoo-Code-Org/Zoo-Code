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

	// The pathname is the same and the file is not: that is exactly the case a textual re-check
	// cannot see, because both spellings of the swap land on the same path.
	it("refuses to publish over a different file that took the authorized path", async () => {
		const file = path.join(dir, "target.txt")
		await fs.promises.writeFile(file, "before")
		const authorized = await fs.promises.stat(file)
		await fs.promises.unlink(file)
		await fs.promises.writeFile(file, "someone else's")
		await expect(
			safeWriteText(file, "after", { authorizedTarget: { dev: authorized.dev, ino: authorized.ino } }),
		).rejects.toThrow(/changed identity after it was authorized/)
		expect(await fs.promises.readFile(file, "utf8")).toBe("someone else's")
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
