import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import { acquireFileLock, resolveFileLockPath, withFileLock } from "../fileLock"

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
	}
})

describe("resolveFileLockPath", () => {
	it("resolves a symlinked ancestor to the same lock path as the referent", async () => {
		const root = await makeTemporaryDirectory()
		const realDirectory = path.join(root, "real")
		const aliasDirectory = path.join(root, "alias")
		await fs.mkdir(realDirectory)
		// A directory junction needs no elevation on Windows; symlinks are used elsewhere.
		await fs.symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")

		const aliasPath = path.join(aliasDirectory, "settings.json")
		const referentPath = path.join(realDirectory, "settings.json")
		// Compare against the realpath of the ancestor: Windows short (8.3) paths in os.tmpdir()
		// resolve to their long form, so path.resolve(tmp) is not the canonical spelling.
		const expected = path.join(await fs.realpath(realDirectory), "settings.json")

		await expect(resolveFileLockPath(aliasPath)).resolves.toBe(expected)
		await expect(resolveFileLockPath(referentPath)).resolves.toBe(expected)
	})

	it("keeps an ordinary path unchanged", async () => {
		const root = await makeTemporaryDirectory()
		const target = path.join(root, "ordinary.json")
		// The lock path resolves the nearest existing ancestor (the temp root), so short (8.3)
		// Windows temp paths come back in their canonical long form.
		await expect(resolveFileLockPath(target)).resolves.toBe(path.join(await fs.realpath(root), "ordinary.json"))
	})
})

describe("acquireFileLock", () => {
	it("serializes a writer that locks the referent and one that locks the alias", async () => {
		const root = await makeTemporaryDirectory()
		const realDirectory = path.join(root, "real")
		const aliasDirectory = path.join(root, "alias")
		await fs.mkdir(realDirectory)
		await fs.symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir")

		const aliasPath = path.join(aliasDirectory, "settings.json")
		const referentPath = path.join(realDirectory, "settings.json")

		let signalEntered!: () => void
		let releaseOperation!: () => void
		const entered = new Promise<void>((resolve) => {
			signalEntered = resolve
		})
		const release = new Promise<void>((resolve) => {
			releaseOperation = resolve
		})
		const holding = withFileLock(aliasPath, async () => {
			signalEntered()
			await release
		})

		await entered
		await expect(acquireFileLock(referentPath)).rejects.toThrow()
		releaseOperation()
		await holding
	}, 15_000)
})
