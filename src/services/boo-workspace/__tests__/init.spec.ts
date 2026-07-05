import * as path from "path"
import assert from "node:assert"

const { mockWriteFile, mockMkdir, mockStat, mockReadFile, mockExec, mockUserInfo } = vi.hoisted(() => ({
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockExec: vi.fn(),
	mockUserInfo: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		writeFile: mockWriteFile,
		mkdir: mockMkdir,
		stat: mockStat,
		readFile: mockReadFile,
	},
}))

// exec uses a callback: exec(cmd, callback) — promisify wraps this
vi.mock("node:child_process", () => ({
	exec: mockExec,
}))

vi.mock("os", () => ({
	userInfo: mockUserInfo,
}))

import { initWorkspace } from "../init"

const ROOT = "/test/my-novel"

function nothingExists(): void {
	mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
}

function fileExistsAt(p: string): void {
	mockStat.mockImplementation(async (target: string) => {
		if (target === p) return { isFile: () => true, isDirectory: () => false }
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})
}

describe("initWorkspace", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMkdir.mockResolvedValue(undefined)
		mockWriteFile.mockResolvedValue(undefined)
		// Default: git config succeeds with a username
		mockExec.mockImplementation((_cmd: string, callback: (err: null, result: { stdout: string }) => void) => {
			callback(null, { stdout: "Test User\n" })
		})
		mockUserInfo.mockReturnValue({ username: "testuser" })
		mockReadFile.mockResolvedValue("customModes:\n  - slug: outline\n")
	})

	it("scaffolds all expected files and directories when nothing exists", async () => {
		nothingExists()
		const generateDescription = vi.fn().mockResolvedValue("A novel about adventures.")

		await initWorkspace(ROOT, generateDescription)

		const mkdirPaths = mockMkdir.mock.calls.map((c: any[]) => c[0])
		expect(mkdirPaths).toContain(path.join(ROOT, ".boo"))
		expect(mkdirPaths).toContain(path.join(ROOT, "knowledge"))
		expect(mkdirPaths).toContain(path.join(ROOT, "components"))

		const writeFilePaths = mockWriteFile.mock.calls.map((c: any[]) => c[0])
		expect(writeFilePaths).toContain(path.join(ROOT, "workspace.boo.md"))
		expect(writeFilePaths).toContain(path.join(ROOT, ".boo", "style.md"))
		expect(writeFilePaths).toContain(path.join(ROOT, ".boo", "instructions.md"))
		expect(writeFilePaths).toContain(path.join(ROOT, ".boo", "settings.json"))
		expect(writeFilePaths).toContain(path.join(ROOT, "knowledge", "knowledge.boo.md"))
	})

	it("skips writing workspace.boo.md if it already exists", async () => {
		fileExistsAt(path.join(ROOT, "workspace.boo.md"))
		const generateDescription = vi.fn()

		await initWorkspace(ROOT, generateDescription)

		const writeFilePaths = mockWriteFile.mock.calls.map((c: any[]) => c[0])
		expect(writeFilePaths).not.toContain(path.join(ROOT, "workspace.boo.md"))
		expect(generateDescription).not.toHaveBeenCalled()
	})

	it("uses folder name as fallback when generateDescription rejects", async () => {
		nothingExists()
		const generateDescription = vi.fn().mockRejectedValue(new Error("no provider"))

		await initWorkspace(ROOT, generateDescription)

		const manifestCall = mockWriteFile.mock.calls.find((c: any[]) => c[0] === path.join(ROOT, "workspace.boo.md"))
		assert(manifestCall !== undefined, "workspace.boo.md should have been written")
		expect(manifestCall[1]).toContain("my-novel")
	})

	it("uses AI-generated description in workspace.boo.md body", async () => {
		nothingExists()
		const generateDescription = vi.fn().mockResolvedValue("A haunting tale of loss.")

		await initWorkspace(ROOT, generateDescription)

		const manifestCall = mockWriteFile.mock.calls.find((c: any[]) => c[0] === path.join(ROOT, "workspace.boo.md"))
		assert(manifestCall !== undefined, "workspace.boo.md should have been written")
		expect(manifestCall[1]).toContain("A haunting tale of loss.")
	})

	describe("agents.yaml template", () => {
		const EXTENSION_PATH = "/extension"

		it("copies the shipped agents.yaml template into .boo/ when an extension path is given", async () => {
			nothingExists()
			const generateDescription = vi.fn().mockResolvedValue("A novel about adventures.")

			await initWorkspace(ROOT, generateDescription, EXTENSION_PATH)

			expect(mockReadFile).toHaveBeenCalledWith(
				path.join(EXTENSION_PATH, "assets", "boo-workspace", "agents.yaml"),
				"utf-8",
			)
			const writeCall = mockWriteFile.mock.calls.find(
				(c: any[]) => c[0] === path.join(ROOT, ".boo", "agents.yaml"),
			)
			assert(writeCall !== undefined, ".boo/agents.yaml should have been written")
			expect(writeCall[1]).toContain("outline")
		})

		it("does not touch .boo/agents.yaml when no extension path is given", async () => {
			nothingExists()
			const generateDescription = vi.fn().mockResolvedValue("A novel about adventures.")

			await initWorkspace(ROOT, generateDescription)

			expect(mockReadFile).not.toHaveBeenCalled()
			const writeFilePaths = mockWriteFile.mock.calls.map((c: any[]) => c[0])
			expect(writeFilePaths).not.toContain(path.join(ROOT, ".boo", "agents.yaml"))
		})

		it("does not overwrite an existing .boo/agents.yaml", async () => {
			fileExistsAt(path.join(ROOT, ".boo", "agents.yaml"))
			const generateDescription = vi.fn().mockResolvedValue("A novel about adventures.")

			await initWorkspace(ROOT, generateDescription, EXTENSION_PATH)

			expect(mockReadFile).not.toHaveBeenCalled()
			const writeFilePaths = mockWriteFile.mock.calls.map((c: any[]) => c[0])
			expect(writeFilePaths).not.toContain(path.join(ROOT, ".boo", "agents.yaml"))
		})
	})
})
