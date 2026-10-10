import fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "node:os"

const mockHome = vi.hoisted(() => ({ path: "" }))

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		homedir: () => mockHome.path,
	}
})

import { getCommand, getCommands } from "../commands"

/**
 * Real-filesystem tests for listing/execution consistency. getCommands() (the
 * listing) must surface exactly what getCommand() (execution) can resolve:
 * direct .md files and file symlinks in the commands directory. Directory
 * symlinks are not followed by either path.
 */
describe("command listing and execution consistency for symlinks", () => {
	let tempDir: string
	let cwd: string
	let globalCommandsDir: string

	const dirLinkType = process.platform === "win32" ? "junction" : "dir"

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(tmpdir(), "zoo-command-symlink-"))
		mockHome.path = path.join(tempDir, "home")
		cwd = path.join(tempDir, "workspace")
		globalCommandsDir = path.join(mockHome.path, ".roo", "commands")
		await fs.mkdir(globalCommandsDir, { recursive: true })
		await fs.mkdir(cwd, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("selects the built-in command in both listing and execution when a global directory symlink collides with it", async () => {
		const sharedDir = path.join(tempDir, "shared")
		await fs.mkdir(sharedDir, { recursive: true })
		await fs.writeFile(path.join(sharedDir, "init.md"), "# Global Init via directory symlink")
		await fs.symlink(sharedDir, path.join(globalCommandsDir, "shared-link"), dirLinkType)

		const listed = (await getCommands(cwd)).filter((command) => command.name === "init")
		expect(listed).toHaveLength(1)
		expect(listed[0].source).toBe("built-in")

		const executed = await getCommand(cwd, "init")
		expect(executed?.source).toBe("built-in")

		// Listing and execution must select the same command.
		expect(listed[0].content).toBe(executed?.content)
		expect(listed[0].filePath).toBe(executed?.filePath)
	})

	it("does not list or execute a command that is only reachable through a directory symlink", async () => {
		const sharedDir = path.join(tempDir, "shared")
		await fs.mkdir(sharedDir, { recursive: true })
		await fs.writeFile(path.join(sharedDir, "nested.md"), "# Nested Command")
		await fs.symlink(sharedDir, path.join(globalCommandsDir, "shared-link"), dirLinkType)

		const listed = await getCommands(cwd)
		expect(listed.find((command) => command.name === "nested")).toBeUndefined()

		expect(await getCommand(cwd, "nested")).toBeUndefined()
	})

	it.skipIf(process.platform === "win32")("lists and executes file symlinks at the commands directory root", async () => {
		const sharedDir = path.join(mockHome.path, ".roo", "shared")
		await fs.mkdir(sharedDir, { recursive: true })
		await fs.writeFile(path.join(sharedDir, "aliased-target.md"), "# Aliased Command")
		await fs.symlink(path.join(sharedDir, "aliased-target.md"), path.join(globalCommandsDir, "aliased.md"), "file")

		const listed = (await getCommands(cwd)).filter((command) => command.name === "aliased")
		expect(listed).toHaveLength(1)
		expect(listed[0].content).toContain("Aliased Command")

		const executed = await getCommand(cwd, "aliased")
		expect(executed?.content).toContain("Aliased Command")
	})
})
