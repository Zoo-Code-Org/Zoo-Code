// npx vitest run integrations/editor/__tests__/atomicWrite.spec.ts

import fs from "fs/promises"
import { constants as fsConstants } from "fs"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { writeFileAtomically } from "../atomicWrite"

describe("writeFileAtomically", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("creates a new file with the complete content and no staging leftovers", async () => {
		const target = path.join(dir, "new.txt")

		await writeFileAtomically(target, "hello")

		expect(await fs.readFile(target, "utf8")).toBe("hello")
		expect(await fs.readdir(dir)).toEqual(["new.txt"])
	})

	// Windows only maps the read-only attribute onto chmod, so POSIX mode bits are
	// not observable there; the ubuntu lane covers this regression.
	const posixOnly = it.skipIf(process.platform === "win32")

	posixOnly("preserves the destination mode for an executable file", async () => {
		const target = path.join(dir, "script.sh")
		await fs.writeFile(target, "old", "utf8")
		await fs.chmod(target, 0o755)

		await writeFileAtomically(target, "new")

		expect(await fs.readFile(target, "utf8")).toBe("new")
		const stat = await fs.stat(target)
		expect(stat.mode & 0o777).toBe(0o755)
	})

	// The compatibility case rename(2) skips: it needs write permission on the directory,
	// not on the destination, so a read-only destination must still fail the way the
	// direct write this helper replaced failed. POSIX reports EACCES for that, Windows
	// maps the read-only attribute onto EPERM, and a root-run container can ignore
	// mode bits altogether, which is why the case checks its own premise.
	it("refuses a read-only destination and leaves the previous bytes and no leftovers", async () => {
		const target = path.join(dir, "locked.txt")
		await fs.writeFile(target, "old", "utf8")
		await fs.chmod(target, 0o444)

		let destinationWritable = true
		try {
			await fs.access(target, fsConstants.W_OK)
		} catch {
			// access(2) refused the 0444 destination: that is the premise this case needs.
			destinationWritable = false
		}
		if (destinationWritable) {
			// Where access(2) ignores mode bits the premise is absent; the case then
			// reports nothing rather than asserting the wrong thing.
			await fs.chmod(target, 0o644)
			return
		}

		await expect(writeFileAtomically(target, "new")).rejects.toMatchObject({
			code: process.platform === "win32" ? "EPERM" : "EACCES",
		})

		expect(await fs.readFile(target, "utf8")).toBe("old")
		expect(await fs.readdir(dir)).toEqual(["locked.txt"])
		await fs.chmod(target, 0o644)
	})

	posixOnly("updates a symlink through its target without replacing the symlink", async () => {
		const target = path.join(dir, "real.txt")
		const link = path.join(dir, "link.txt")
		await fs.writeFile(target, "old", "utf8")
		try {
			await fs.symlink(target, link)
		} catch (error) {
			// Creating symlinks needs Developer Mode or admin rights on Windows.
			if ((error as NodeJS.ErrnoException).code === "EPERM") return
			throw error
		}

		await writeFileAtomically(link, "new")

		expect(await fs.readFile(target, "utf8")).toBe("new")
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
	})
})
