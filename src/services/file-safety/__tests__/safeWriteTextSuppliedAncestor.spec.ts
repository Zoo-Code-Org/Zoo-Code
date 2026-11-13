import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { safeWriteText, TargetMovedError, type DirectoryIdentity } from "../safeWriteText"

// The shapes below turn on a directory ancestor appearing as a link after the caller
// authorized the target. A junction stands in for a symlink: on win32 a file symlink
// needs a privilege this machine does not grant, while a directory junction is created
// freely and, like a symlink, makes realpath resolve through it. The asks at these
// coordinates are about directory ancestors, so this is the same hazard class.
const DIRECTORY_LINK: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir"

async function authorize(dir: string): Promise<DirectoryIdentity> {
	const stat = await fs.stat(dir, { bigint: true })
	return { dir, dev: stat.dev, ino: stat.ino, resolvedPath: await fs.realpath(dir) }
}

describe("safeWriteText against an ancestor that arrives after the authorization", () => {
	let root: string
	let outside: string
	let project: string

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-supplied-ancestor-"))
		outside = path.join(root, "outside")
		project = path.join(root, "project")
		await fs.mkdir(outside)
		await fs.mkdir(project)
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 8 })
	})

	// The pin list a caller can honestly build: only the directories it actually walked.
	// An ancestor that was absent at authorization cannot appear in it, which is why the
	// identity recheck cannot be what refuses these two shapes.
	async function walkedAncestors(): Promise<DirectoryIdentity[]> {
		return [await authorize(root), await authorize(project)]
	}

	it("refuses a create whose absent parent arrived as a link and leaves nothing at either location", async () => {
		const target = path.join(project, "supplied", "note.txt")
		const expectedResolvedPath = path.resolve(target)
		const expectedAncestorIdentities = await walkedAncestors()

		await fs.symlink(outside, path.join(project, "supplied"), DIRECTORY_LINK)

		await expect(
			safeWriteText(target, "payload", { backup: false, expectedResolvedPath, expectedAncestorIdentities }),
		).rejects.toBeInstanceOf(TargetMovedError)

		// Nothing reached the location the link resolves to, and the attempt left no
		// staging directory behind there either.
		expect(await fs.readdir(outside)).toEqual([])
	})

	it("refuses a create whose chain was created through an arriving link and removes the directory it created", async () => {
		const target = path.join(project, "supplied", "deeper", "note.txt")
		const expectedResolvedPath = path.resolve(target)
		const expectedAncestorIdentities = await walkedAncestors()

		await fs.symlink(outside, path.join(project, "supplied"), DIRECTORY_LINK)

		await expect(
			safeWriteText(target, "payload", { backup: false, expectedResolvedPath, expectedAncestorIdentities }),
		).rejects.toBeInstanceOf(TargetMovedError)

		// The refusal also takes back the directory this attempt created through the link:
		// the outside location holds neither the published file nor the chain that was made
		// on the way to it.
		expect(await fs.readdir(outside)).toEqual([])
	})

	it("publishes at the arriving link location when the caller supplies no authorized target", async () => {
		const target = path.join(project, "supplied", "note.txt")
		const expectedAncestorIdentities = await walkedAncestors()

		await fs.symlink(outside, path.join(project, "supplied"), DIRECTORY_LINK)

		await safeWriteText(target, "payload", { backup: false, expectedAncestorIdentities })

		// This is the boundary the two refusals above depend on: without the authorized
		// target the primitive has nothing to compare the resolution against, so the
		// write follows the link and lands outside the chain the caller named.
		expect(await fs.readFile(path.join(outside, "note.txt"), "utf8")).toBe("payload")
	})
})
