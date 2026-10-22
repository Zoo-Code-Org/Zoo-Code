// npx vitest run integrations/editor/__tests__/atomicWrite.spec.ts

import fs from "fs/promises"
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
