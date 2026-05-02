import * as path from "path"

// Use vi.hoisted to ensure mocks are available during hoisting
const { mockStat, mockReadFile, mockHomedir, mockExecuteRipgrep } = vi.hoisted(() => ({
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockHomedir: vi.fn(),
	mockExecuteRipgrep: vi.fn(),
}))

// Mock fs/promises module
vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
	},
}))

// Mock os module
vi.mock("os", () => ({
	homedir: mockHomedir,
}))

// Mock executeRipgrep from search service
vi.mock("../../search/file-search", () => ({
	executeRipgrep: mockExecuteRipgrep,
}))

import {
	getCanonicalGlobalConfigDirectory,
	getLegacyGlobalConfigDirectory,
	getGlobalRooDirectory,
	resolveGlobalConfigDirectory,
	getGlobalAgentsDirectory,
	getCanonicalProjectConfigDirectoryForCwd,
	getLegacyProjectConfigDirectoryForCwd,
	getProjectRooDirectoryForCwd,
	resolveProjectConfigDirectoryForCwd,
	getCanonicalProjectCustomModesFileForCwd,
	getLegacyProjectCustomModesFileForCwd,
	resolveProjectCustomModesFileForCwd,
	getCanonicalProjectIgnoreFileForCwd,
	getLegacyProjectIgnoreFileForCwd,
	resolveProjectIgnoreFileForCwd,
	getProjectAgentsDirectoryForCwd,
	getConfigDirectoriesForCwd,
	getAllConfigDirectoriesForCwd,
	directoryExists,
	fileExists,
	readFileIfExists,
	getRooDirectoriesForCwd,
	getAllRooDirectoriesForCwd,
	getAgentsDirectoriesForCwd,
	discoverSubfolderConfigDirectories,
	discoverSubfolderRooDirectories,
	loadConfiguration,
} from "../index"

function createFsError(code: string) {
	const error = new Error(code) as any
	error.code = code
	return error
}

function mockExistingPaths({ directories = [], files = [] }: { directories?: string[]; files?: string[] }) {
	mockStat.mockImplementation(async (targetPath: string) => {
		if (directories.includes(targetPath)) {
			return { isDirectory: () => true, isFile: () => false } as any
		}

		if (files.includes(targetPath)) {
			return { isDirectory: () => false, isFile: () => true } as any
		}

		throw createFsError("ENOENT")
	})
}

describe("RooConfigService", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockHomedir.mockReturnValue("/mock/home")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("getGlobalRooDirectory", () => {
		it("should return correct path for global .roo directory", () => {
			const result = getGlobalRooDirectory()
			expect(result).toBe(path.join("/mock/home", ".roo"))
		})

		it("should handle different home directories", () => {
			mockHomedir.mockReturnValue("/different/home")
			const result = getGlobalRooDirectory()
			expect(result).toBe(path.join("/different/home", ".roo"))
		})
	})

	describe("Zoo/Roo path resolution helpers", () => {
		it("should return canonical and legacy global config directory paths", () => {
			expect(getCanonicalGlobalConfigDirectory()).toBe(path.join("/mock/home", ".zoo"))
			expect(getLegacyGlobalConfigDirectory()).toBe(path.join("/mock/home", ".roo"))
		})

		it("should prefer canonical global config directory when both canonical and legacy exist", async () => {
			const canonicalPath = path.join("/mock/home", ".zoo")
			const legacyPath = path.join("/mock/home", ".roo")
			mockExistingPaths({ directories: [canonicalPath, legacyPath] })

			await expect(resolveGlobalConfigDirectory()).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: canonicalPath,
				canonicalExists: true,
				legacyExists: true,
				activeExists: true,
				shouldBootstrapCanonicalFromLegacy: false,
			})
		})

		it("should fall back to legacy global config directory when canonical does not exist", async () => {
			const canonicalPath = path.join("/mock/home", ".zoo")
			const legacyPath = path.join("/mock/home", ".roo")
			mockExistingPaths({ directories: [legacyPath] })

			await expect(resolveGlobalConfigDirectory()).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: legacyPath,
				canonicalExists: false,
				legacyExists: true,
				activeExists: true,
				shouldBootstrapCanonicalFromLegacy: true,
			})
		})

		it("should return canonical global config directory when neither path exists", async () => {
			const canonicalPath = path.join("/mock/home", ".zoo")
			const legacyPath = path.join("/mock/home", ".roo")
			mockExistingPaths({})

			await expect(resolveGlobalConfigDirectory()).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: canonicalPath,
				canonicalExists: false,
				legacyExists: false,
				activeExists: false,
				shouldBootstrapCanonicalFromLegacy: false,
			})
		})

		it("should return canonical and legacy project config directory paths", () => {
			const cwd = "/custom/project/path"

			expect(getCanonicalProjectConfigDirectoryForCwd(cwd)).toBe(path.join(cwd, ".zoo"))
			expect(getLegacyProjectConfigDirectoryForCwd(cwd)).toBe(path.join(cwd, ".roo"))
		})

		it("should fall back to legacy project config directory when canonical does not exist", async () => {
			const cwd = "/custom/project/path"
			const canonicalPath = path.join(cwd, ".zoo")
			const legacyPath = path.join(cwd, ".roo")
			mockExistingPaths({ directories: [legacyPath] })

			await expect(resolveProjectConfigDirectoryForCwd(cwd)).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: legacyPath,
				canonicalExists: false,
				legacyExists: true,
				activeExists: true,
				shouldBootstrapCanonicalFromLegacy: true,
			})
		})

		it("should return canonical and legacy project custom modes file paths", () => {
			const cwd = "/custom/project/path"

			expect(getCanonicalProjectCustomModesFileForCwd(cwd)).toBe(path.join(cwd, ".zoomodes"))
			expect(getLegacyProjectCustomModesFileForCwd(cwd)).toBe(path.join(cwd, ".roomodes"))
		})

		it("should resolve project custom modes file with legacy fallback", async () => {
			const cwd = "/custom/project/path"
			const canonicalPath = path.join(cwd, ".zoomodes")
			const legacyPath = path.join(cwd, ".roomodes")
			mockExistingPaths({ files: [legacyPath] })

			await expect(resolveProjectCustomModesFileForCwd(cwd)).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: legacyPath,
				canonicalExists: false,
				legacyExists: true,
				activeExists: true,
				shouldBootstrapCanonicalFromLegacy: true,
			})
		})

		it("should return canonical and legacy project ignore file paths", () => {
			const cwd = "/custom/project/path"

			expect(getCanonicalProjectIgnoreFileForCwd(cwd)).toBe(path.join(cwd, ".zooignore"))
			expect(getLegacyProjectIgnoreFileForCwd(cwd)).toBe(path.join(cwd, ".rooignore"))
		})

		it("should resolve project ignore file with canonical preference", async () => {
			const cwd = "/custom/project/path"
			const canonicalPath = path.join(cwd, ".zooignore")
			const legacyPath = path.join(cwd, ".rooignore")
			mockExistingPaths({ files: [canonicalPath, legacyPath] })

			await expect(resolveProjectIgnoreFileForCwd(cwd)).resolves.toEqual({
				canonicalPath,
				legacyPath,
				activePath: canonicalPath,
				canonicalExists: true,
				legacyExists: true,
				activeExists: true,
				shouldBootstrapCanonicalFromLegacy: false,
			})
		})
	})

	describe("getProjectRooDirectoryForCwd", () => {
		it("should return correct path for given cwd", () => {
			const cwd = "/custom/project/path"
			const result = getProjectRooDirectoryForCwd(cwd)
			expect(result).toBe(path.join(cwd, ".roo"))
		})
	})

	describe("getGlobalAgentsDirectory", () => {
		it("should return correct path for global .agents directory", () => {
			const result = getGlobalAgentsDirectory()
			expect(result).toBe(path.join("/mock/home", ".agents"))
		})

		it("should handle different home directories", () => {
			mockHomedir.mockReturnValue("/different/home")
			const result = getGlobalAgentsDirectory()
			expect(result).toBe(path.join("/different/home", ".agents"))
		})
	})

	describe("getProjectAgentsDirectoryForCwd", () => {
		it("should return correct path for given cwd", () => {
			const cwd = "/custom/project/path"
			const result = getProjectAgentsDirectoryForCwd(cwd)
			expect(result).toBe(path.join(cwd, ".agents"))
		})
	})

	describe("directoryExists", () => {
		it("should return true for existing directory", async () => {
			mockStat.mockResolvedValue({ isDirectory: () => true } as any)

			const result = await directoryExists("/some/path")

			expect(result).toBe(true)
			expect(mockStat).toHaveBeenCalledWith("/some/path")
		})

		it("should return false for non-existing path", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockStat.mockRejectedValue(error)

			const result = await directoryExists("/non/existing/path")

			expect(result).toBe(false)
		})

		it("should return false for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockStat.mockRejectedValue(error)

			const result = await directoryExists("/not/a/directory")

			expect(result).toBe(false)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockStat.mockRejectedValue(error)

			await expect(directoryExists("/permission/denied")).rejects.toThrow("Permission denied")
		})

		it("should return false for files", async () => {
			mockStat.mockResolvedValue({ isDirectory: () => false } as any)

			const result = await directoryExists("/some/file.txt")

			expect(result).toBe(false)
		})
	})

	describe("fileExists", () => {
		it("should return true for existing file", async () => {
			mockStat.mockResolvedValue({ isFile: () => true } as any)

			const result = await fileExists("/some/file.txt")

			expect(result).toBe(true)
			expect(mockStat).toHaveBeenCalledWith("/some/file.txt")
		})

		it("should return false for non-existing file", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockStat.mockRejectedValue(error)

			const result = await fileExists("/non/existing/file.txt")

			expect(result).toBe(false)
		})

		it("should return false for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockStat.mockRejectedValue(error)

			const result = await fileExists("/not/a/directory/file.txt")

			expect(result).toBe(false)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockStat.mockRejectedValue(error)

			await expect(fileExists("/permission/denied/file.txt")).rejects.toThrow("Permission denied")
		})

		it("should return false for directories", async () => {
			mockStat.mockResolvedValue({ isFile: () => false } as any)

			const result = await fileExists("/some/directory")

			expect(result).toBe(false)
		})
	})

	describe("readFileIfExists", () => {
		it("should return file content for existing file", async () => {
			mockReadFile.mockResolvedValue("file content")

			const result = await readFileIfExists("/some/file.txt")

			expect(result).toBe("file content")
			expect(mockReadFile).toHaveBeenCalledWith("/some/file.txt", "utf-8")
		})

		it("should return null for non-existing file", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/non/existing/file.txt")

			expect(result).toBe(null)
		})

		it("should return null for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/not/a/directory/file.txt")

			expect(result).toBe(null)
		})

		it("should return null for EISDIR error", async () => {
			const error = new Error("EISDIR") as any
			error.code = "EISDIR"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/is/a/directory")

			expect(result).toBe(null)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockReadFile.mockRejectedValue(error)

			await expect(readFileIfExists("/permission/denied/file.txt")).rejects.toThrow("Permission denied")
		})
	})

	describe("getRooDirectoriesForCwd", () => {
		it("should return directories for given cwd", () => {
			const cwd = "/custom/project/path"

			const result = getRooDirectoriesForCwd(cwd)

			expect(result).toEqual([path.join("/mock/home", ".roo"), path.join(cwd, ".roo")])
		})
	})

	describe("loadConfiguration", () => {
		it("should load global configuration only when project does not exist", async () => {
			mockExistingPaths({
				directories: [path.join("/mock/home", ".zoo")],
			})
			mockReadFile.mockResolvedValueOnce("global content").mockRejectedValueOnce(createFsError("ENOENT"))

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: "global content",
				project: null,
				merged: "global content",
			})
		})

		it("should load project configuration only when global does not exist", async () => {
			mockExistingPaths({
				directories: [path.join("/project/path", ".zoo")],
			})
			mockReadFile.mockRejectedValueOnce(createFsError("ENOENT")).mockResolvedValueOnce("project content")

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: null,
				project: "project content",
				merged: "project content",
			})
		})

		it("should merge global and project configurations with project overriding global", async () => {
			mockExistingPaths({
				directories: [path.join("/mock/home", ".zoo"), path.join("/project/path", ".zoo")],
			})
			mockReadFile.mockResolvedValueOnce("global content").mockResolvedValueOnce("project content")

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: "global content",
				project: "project content",
				merged: "global content\n\n# Project-specific rules (override global):\n\nproject content",
			})
		})

		it("should return empty merged content when neither exists", async () => {
			mockExistingPaths({})
			mockReadFile.mockRejectedValueOnce(createFsError("ENOENT")).mockRejectedValueOnce(createFsError("ENOENT"))

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: null,
				project: null,
				merged: "",
			})
		})

		it("should propagate unexpected errors from global file read", async () => {
			mockExistingPaths({
				directories: [path.join("/mock/home", ".zoo")],
			})
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockReadFile.mockRejectedValueOnce(error)

			await expect(loadConfiguration("rules/rules.md", "/project/path")).rejects.toThrow("Permission denied")
		})

		it("should propagate unexpected errors from project file read", async () => {
			mockExistingPaths({
				directories: [path.join("/project/path", ".zoo")],
			})
			const globalError = createFsError("ENOENT")
			const projectError = new Error("Permission denied") as any
			projectError.code = "EACCES"

			mockReadFile.mockRejectedValueOnce(globalError).mockRejectedValueOnce(projectError)

			await expect(loadConfiguration("rules/rules.md", "/project/path")).rejects.toThrow("Permission denied")
		})

		it("should use canonical Zoo file paths when no legacy fallback is needed", async () => {
			mockExistingPaths({
				directories: [path.join("/mock/home", ".zoo"), path.join("/project/path", ".zoo")],
			})
			mockReadFile.mockResolvedValue("content")

			await loadConfiguration("rules/rules.md", "/project/path")

			expect(mockReadFile).toHaveBeenCalledWith(path.join("/mock/home", ".zoo", "rules/rules.md"), "utf-8")
			expect(mockReadFile).toHaveBeenCalledWith(path.join("/project/path", ".zoo", "rules/rules.md"), "utf-8")
		})

		it("should fall back to legacy Roo directories for reads when canonical Zoo directories do not exist", async () => {
			mockExistingPaths({
				directories: [path.join("/mock/home", ".roo"), path.join("/project/path", ".roo")],
			})
			mockReadFile.mockResolvedValue("legacy content")

			await loadConfiguration("rules/rules.md", "/project/path")

			expect(mockReadFile).toHaveBeenCalledWith(path.join("/mock/home", ".roo", "rules/rules.md"), "utf-8")
			expect(mockReadFile).toHaveBeenCalledWith(path.join("/project/path", ".roo", "rules/rules.md"), "utf-8")
		})
	})

	describe("Zoo-first config directory helpers", () => {
		it("should return active global and project config directories with canonical preference", async () => {
			const cwd = "/project/path"
			mockExistingPaths({
				directories: [path.join("/mock/home", ".zoo"), path.join(cwd, ".zoo")],
			})

			await expect(getConfigDirectoriesForCwd(cwd)).resolves.toEqual([
				path.join("/mock/home", ".zoo"),
				path.join(cwd, ".zoo"),
			])
		})

		it("should return active global and project config directories with Roo fallback", async () => {
			const cwd = "/project/path"
			mockExistingPaths({
				directories: [path.join("/mock/home", ".roo"), path.join(cwd, ".roo")],
			})

			await expect(getConfigDirectoriesForCwd(cwd)).resolves.toEqual([
				path.join("/mock/home", ".roo"),
				path.join(cwd, ".roo"),
			])
		})

		it("should discover subfolder config directories with Zoo-first preference", async () => {
			const cwd = "/workspace"
			mockExistingPaths({
				directories: [
					path.join(cwd, "packages/app", ".zoo"),
					path.join(cwd, "packages/app", ".roo"),
					path.join(cwd, "packages/lib", ".roo"),
				],
			})
			mockExecuteRipgrep.mockResolvedValue([
				{ path: "packages/app/.zoo/rules/rules.md" },
				{ path: "packages/app/.roo/rules/rules.md" },
				{ path: "packages/lib/.roo/rules/rules.md" },
			])

			await expect(discoverSubfolderConfigDirectories(cwd)).resolves.toEqual([
				path.join(cwd, "packages/app", ".zoo"),
				path.join(cwd, "packages/lib", ".roo"),
			])
		})

		it("should include active subfolder config directories after global and project directories", async () => {
			const cwd = "/workspace"
			mockExistingPaths({
				directories: [
					path.join("/mock/home", ".zoo"),
					path.join(cwd, ".roo"),
					path.join(cwd, "packages/lib", ".roo"),
				],
			})
			mockExecuteRipgrep.mockResolvedValue([{ path: "packages/lib/.roo/rules/rules.md" }])

			await expect(getAllConfigDirectoriesForCwd(cwd)).resolves.toEqual([
				path.join("/mock/home", ".zoo"),
				path.join(cwd, ".roo"),
				path.join(cwd, "packages/lib", ".roo"),
			])
		})
	})

	describe("discoverSubfolderRooDirectories", () => {
		it("should return empty array when no subfolder .roo directories found", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([])
		})

		it("should discover .roo directories from subfolders", async () => {
			// Find any file inside .roo directories
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.roo/rules/rule.md", type: "file" },
				{ path: "package-b/.roo/rules-code/rule.md", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "package-a", ".roo"),
				path.join("/project/path", "package-b", ".roo"),
			])
		})

		it("should sort discovered directories alphabetically", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "zebra/.roo/rules/rule.md", type: "file" },
				{ path: "apple/.roo/rules/rule.md", type: "file" },
				{ path: "mango/.roo/rules/rule.md", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "apple", ".roo"),
				path.join("/project/path", "mango", ".roo"),
				path.join("/project/path", "zebra", ".roo"),
			])
		})

		it("should exclude root .roo directory", async () => {
			// This would match the root .roo, which should be excluded
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: ".roo/rules/rule.md", type: "file" }, // This is root - should be excluded
				{ path: "subfolder/.roo/rules/rule.md", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			// Should only include subfolder, not root
			expect(result).toEqual([path.join("/project/path", "subfolder", ".roo")])
		})

		it("should handle nested subdirectories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "packages/core/.roo/rules/rule.md", type: "file" },
				{ path: "packages/utils/.roo/rules-code/rule.md", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "packages/core", ".roo"),
				path.join("/project/path", "packages/utils", ".roo"),
			])
		})

		it("should return empty array on ripgrep error", async () => {
			mockExecuteRipgrep.mockRejectedValue(new Error("ripgrep failed"))

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([])
		})

		it("should deduplicate .roo directories from multiple files", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.roo/rules/rule1.md", type: "file" },
				{ path: "package-a/.roo/rules/rule2.md", type: "file" },
				{ path: "package-a/.roo/rules-code/rule3.md", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			// Should only include package-a/.roo once
			expect(result).toEqual([path.join("/project/path", "package-a", ".roo")])
		})

		it("should discover .roo directories with any content", async () => {
			// Should find .roo directories regardless of what's inside them
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.roo/rules/rule.md", type: "file" },
				{ path: "package-b/.roo/rules-code/code-rule.md", type: "file" },
				{ path: "package-c/.roo/rules-architect/arch-rule.md", type: "file" },
				{ path: "package-d/.roo/config/settings.json", type: "file" },
			])

			const result = await discoverSubfolderRooDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "package-a", ".roo"),
				path.join("/project/path", "package-b", ".roo"),
				path.join("/project/path", "package-c", ".roo"),
				path.join("/project/path", "package-d", ".roo"),
			])
		})
	})

	describe("getAllRooDirectoriesForCwd", () => {
		it("should return global, project, and subfolder directories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([{ path: "subfolder/.roo/rules/rule.md", type: "file" }])

			const result = await getAllRooDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				path.join("/mock/home", ".roo"), // global
				path.join("/project/path", ".roo"), // project
				path.join("/project/path", "subfolder", ".roo"), // subfolder
			])
		})

		it("should return only global and project when no subfolders", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await getAllRooDirectoriesForCwd("/project/path")

			expect(result).toEqual([path.join("/mock/home", ".roo"), path.join("/project/path", ".roo")])
		})

		it("should maintain order: global, project, subfolders (alphabetically)", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "zebra/.roo/rules/rule.md", type: "file" },
				{ path: "apple/.roo/rules/rule.md", type: "file" },
			])

			const result = await getAllRooDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				path.join("/mock/home", ".roo"), // global first
				path.join("/project/path", ".roo"), // project second
				path.join("/project/path", "apple", ".roo"), // subfolders alphabetically
				path.join("/project/path", "zebra", ".roo"),
			])
		})
	})

	describe("getAgentsDirectoriesForCwd", () => {
		it("should return root directory and parent directories of subfolder .roo dirs", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([{ path: "package-a/.roo/rules/rule.md", type: "file" }])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				"/project/path", // root
				path.join("/project/path", "package-a"), // parent of .roo
			])
		})

		it("should always include root even when no subfolders", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual(["/project/path"])
		})

		it("should include multiple subfolder parent directories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.roo/rules/rule.md", type: "file" },
				{ path: "package-b/.roo/rules-code/rule.md", type: "file" },
				{ path: "packages/core/.roo/rules/rule.md", type: "file" },
			])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				"/project/path",
				path.join("/project/path", "package-a"),
				path.join("/project/path", "package-b"),
				path.join("/project/path", "packages/core"),
			])
		})
	})
})
