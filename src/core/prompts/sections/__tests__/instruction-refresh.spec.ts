import fs from "fs/promises"
import path from "path"
import { addCustomInstructions, loadRuleFiles, type InstructionFailureCollector } from "../custom-instructions"

vi.mock("fs/promises", () => ({
	default: { stat: vi.fn(), lstat: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), readlink: vi.fn() },
}))
vi.mock("../../../../services/roo-config", () => ({
	getRooDirectoriesForCwd: (cwd: string) => [path.join(cwd, ".roo")],
	getAllRooDirectoriesForCwd: async (cwd: string) => [path.join(cwd, ".roo"), path.join(cwd, "child", ".roo")],
	getAgentsDirectoriesForCwd: async (cwd: string) => [cwd, path.join(cwd, "child")],
}))

const workspace = path.resolve("workspace")
const missing = { code: "ENOENT" }
const fileStats = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
const directoryStats = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }

beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(fs.stat).mockRejectedValue(missing)
	vi.mocked(fs.lstat).mockRejectedValue(missing)
	vi.mocked(fs.readFile).mockRejectedValue(missing)
	vi.mocked(fs.readdir).mockResolvedValue([])
})

function build(failures?: InstructionFailureCollector, mode = "code", cwd = workspace) {
	return addCustomInstructions("mode saved", "global saved", cwd, mode, {
		language: "en",
		failures,
	})
}

describe("instruction refresh failure collection", () => {
	it.each(["ENOENT", "ENOTDIR", "EISDIR"])("does not report absent %s sources", async (code) => {
		vi.mocked(fs.stat).mockRejectedValue({ code })
		vi.mocked(fs.lstat).mockRejectedValue({ code })
		vi.mocked(fs.readFile).mockRejectedValue({ code })
		const failures: InstructionFailureCollector = []
		await build(failures)
		expect(failures).toEqual([])
	})

	it.each([{ code: "EACCES" }, {}, { code: 42 }, null])(
		"continues past unreadable legacy sources: %j",
		async (error) => {
			const preferred = path.join(workspace, ".roorules")
			vi.mocked(fs.readFile).mockImplementation(async (filename) => {
				if (filename === preferred) throw error
				if (filename === path.join(workspace, ".clinerules")) return "legacy fallback"
				throw missing
			})
			const failures: InstructionFailureCollector = []
			expect(await build(failures)).toContain("legacy fallback")
			expect(failures).toEqual([{ sourcePath: preferred, code: error?.code === "EACCES" ? "EACCES" : "UNKNOWN" }])
		},
	)

	it("preserves ordinary legacy read errors", async () => {
		vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }))
		await expect(build()).rejects.toThrow("denied")
	})

	it.each(["stat", "readdir", "readFile"] as const)(
		"falls back when generic and active-mode directory %s fails",
		async (operation) => {
			const ruleDirectories = [path.join(workspace, ".roo", "rules"), path.join(workspace, ".roo", "rules-code")]
			vi.mocked(fs.stat).mockImplementation(async (filename) => {
				if (ruleDirectories.includes(String(filename))) {
					if (operation === "stat") throw { code: "EACCES" }
					return directoryStats as never
				}
				return fileStats as never
			})
			vi.mocked(fs.readdir).mockImplementation(async (directory) => {
				if (operation === "readdir") throw { code: "EPERM" }
				return [{ name: "rule.md", parentPath: String(directory), isFile: () => true }] as never
			})
			vi.mocked(fs.readFile).mockImplementation(async (filename) => {
				if (String(filename).endsWith("rule.md")) throw { code: "EIO" }
				if (String(filename).endsWith(".roorules-code")) return "mode fallback"
				if (String(filename).endsWith(".roorules")) return "generic fallback"
				throw missing
			})
			const failures: InstructionFailureCollector = []
			const refreshed = await build(failures)
			expect(refreshed).toContain("mode fallback")
			expect(refreshed).toContain("generic fallback")
			expect(refreshed).toBe(await build())
			expect(failures).toHaveLength(2)
			expect(failures.map(({ code }) => code)).toEqual(
				Array(2).fill({ stat: "EACCES", readdir: "EPERM", readFile: "EIO" }[operation]),
			)
		},
	)

	it("reports a directory file stat failure and discards the entry", async () => {
		const rulesDirectory = path.join(workspace, ".roo", "rules")
		const sourcePath = path.join(rulesDirectory, "rule.md")
		vi.mocked(fs.stat).mockImplementation(async (filename) => {
			if (filename === rulesDirectory) return directoryStats as never
			if (filename === sourcePath) throw { code: "EIO" }
			throw missing
		})
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "rule.md", parentPath: rulesDirectory, isFile: () => true },
		] as never)
		const failures: InstructionFailureCollector = []
		await loadRuleFiles(workspace, false, failures)
		expect(failures).toEqual([{ sourcePath, code: "EIO" }])
	})

	it("reports agent metadata and content failures while preserving alternative selection", async () => {
		vi.mocked(fs.lstat).mockImplementation(async (filename) => {
			if (String(filename).endsWith("AGENTS.local.md")) throw { code: "EPERM" }
			return fileStats as never
		})
		vi.mocked(fs.readFile).mockImplementation(async (filename) => {
			if (String(filename).endsWith("AGENTS.md")) throw { code: "EACCES" }
			if (String(filename).endsWith("AGENT.md")) return "agent fallback"
			throw missing
		})
		const failures: InstructionFailureCollector = []
		expect(await build(failures)).toContain("agent fallback")
		expect(failures).toEqual([
			{ sourcePath: path.join(workspace, "AGENTS.md"), code: "EACCES" },
			{ sourcePath: path.join(workspace, "AGENTS.local.md"), code: "EPERM" },
		])
	})

	it.each(["readlink", "stat", "readdir"] as const)("reports symlink %s failures", async (operation) => {
		const linkPath = path.join(workspace, "AGENTS.md")
		const targetPath = path.join(workspace, "target")
		vi.mocked(fs.lstat).mockImplementation(async (filename) => {
			if (filename === linkPath) return { isSymbolicLink: () => true } as never
			throw missing
		})
		vi.mocked(fs.readlink).mockImplementation(async () => {
			if (operation === "readlink") throw { code: "ELOOP" }
			return "target"
		})
		vi.mocked(fs.stat).mockImplementation(async (filename) => {
			if (filename !== targetPath) throw missing
			if (operation === "stat") throw { code: "EACCES" }
			return directoryStats as never
		})
		vi.mocked(fs.readdir).mockRejectedValue({ code: "EIO" })
		const failures: InstructionFailureCollector = []
		await build(failures)
		expect(failures).toEqual([
			{
				sourcePath: operation === "readlink" ? linkPath : targetPath,
				code: { readlink: "ELOOP", stat: "EACCES", readdir: "EIO" }[operation],
			},
		])
	})

	it("reloads edits, removals, saved clears and current scope without duplicates", async () => {
		const sources = new Map([
			[path.join(workspace, ".roorules-code"), "active mode"],
			[path.join(workspace, ".roorules-ask"), "inactive mode"],
			[path.join(workspace, ".roorules"), "old generic"],
			[path.join(workspace, "AGENTS.md"), "agent guidance"],
		])
		vi.mocked(fs.lstat).mockResolvedValue(fileStats as never)
		vi.mocked(fs.readFile).mockImplementation(async (filename) => {
			const content = sources.get(String(filename))
			if (content === undefined) throw missing
			return content
		})
		expect(await build([])).toContain("old generic")
		sources.set(path.join(workspace, ".roorules"), "new generic")
		sources.delete(path.join(workspace, ".roorules-code"))
		const failures: InstructionFailureCollector = []
		const refreshed = await addCustomInstructions("", "", workspace, "code", {
			failures,
			settings: {
				useAgentRules: false,
				enableSubfolderRules: false,
				todoListEnabled: true,
				newTaskRequireTodos: false,
			},
		})
		expect(refreshed).toContain("new generic")
		for (const excluded of ["old generic", "active mode", "inactive mode", "agent guidance", "saved"])
			expect(refreshed).not.toContain(excluded)
		expect(refreshed).toBe(
			await addCustomInstructions("", "", workspace, "code", {
				failures: [],
				settings: {
					useAgentRules: false,
					enableSubfolderRules: false,
					todoListEnabled: true,
					newTaskRequireTodos: false,
				},
			}),
		)
		expect(await build([], "code", path.resolve("other-workspace"))).not.toContain("new generic")
		expect(failures).toEqual([])
	})
})
