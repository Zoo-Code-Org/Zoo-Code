// npx vitest run core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts

import type { Mock } from "vitest"

import * as path from "path"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { RooIgnoreController } from "../RooIgnoreController"
import { fileExistsAtPath } from "../../../utils/fs"

vi.mock("fs/promises")
vi.mock("../../../utils/fs")
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
			dispose: vi.fn(),
		})),
	},
	RelativePattern: vi.fn().mockImplementation((base, pattern) => ({ base, pattern })),
}))

describe("RooIgnoreController Zoo migration", () => {
	const TEST_CWD = "/test/path"
	const zooIgnorePath = path.join(TEST_CWD, ".zooignore")
	const rooIgnorePath = path.join(TEST_CWD, ".rooignore")

	let controller: RooIgnoreController
	let mockFileExists: Mock<typeof fileExistsAtPath>
	let mockReadFile: Mock<typeof fs.readFile>
	let existingPaths: Set<string>
	let fileContents: Record<string, string>

	beforeEach(() => {
		vi.clearAllMocks()

		mockFileExists = fileExistsAtPath as Mock<typeof fileExistsAtPath>
		mockReadFile = fs.readFile as Mock<typeof fs.readFile>

		existingPaths = new Set()
		fileContents = {}

		mockFileExists.mockImplementation(async (filePath: string) => existingPaths.has(filePath))
		mockReadFile.mockImplementation(async (filePath) => {
			const normalizedPath = filePath.toString()
			const content = fileContents[normalizedPath]
			if (content === undefined) {
				throw new Error("File not found")
			}
			return content
		})

		controller = new RooIgnoreController(TEST_CWD)
	})

	it("watches both [.zooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:28) and [.rooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:29)", () => {
		const patterns = (vscode.workspace.createFileSystemWatcher as Mock).mock.calls.map(
			([pattern]) => pattern.pattern,
		)

		expect(patterns).toEqual([".zooignore", ".rooignore"])
	})

	it("prefers [.zooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:28) when both ignore files exist", async () => {
		existingPaths.add(zooIgnorePath)
		existingPaths.add(rooIgnorePath)
		fileContents[zooIgnorePath] = "zoo-only/**"
		fileContents[rooIgnorePath] = "roo-only/**"

		await controller.initialize()

		expect(controller.validateAccess("zoo-only/secret.txt")).toBe(false)
		expect(controller.validateAccess("roo-only/secret.txt")).toBe(true)
		expect(controller.getInstructions()).toContain("# .zooignore")
	})

	it("falls back to [.rooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:29) when [.zooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:28) is absent", async () => {
		existingPaths.add(rooIgnorePath)
		fileContents[rooIgnorePath] = "roo-only/**"

		await controller.initialize()

		expect(controller.validateAccess("roo-only/secret.txt")).toBe(false)
		expect(controller.getInstructions()).toContain("# .rooignore")
	})

	it("switches to canonical [.zooignore](src/core/ignore/__tests__/RooIgnoreController.zooMigration.spec.ts:28) after it appears", async () => {
		existingPaths.add(rooIgnorePath)
		fileContents[rooIgnorePath] = "legacy-only/**"

		await controller.initialize()
		expect(controller.validateAccess("legacy-only/file.txt")).toBe(false)

		existingPaths.add(zooIgnorePath)
		fileContents[zooIgnorePath] = "canonical-only/**"

		await controller.initialize()

		expect(controller.validateAccess("canonical-only/file.txt")).toBe(false)
		expect(controller.validateAccess("legacy-only/file.txt")).toBe(true)
		expect(controller.getInstructions()).toContain("# .zooignore")
	})
})
