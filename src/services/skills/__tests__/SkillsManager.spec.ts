import * as path from "path"

// Use vi.hoisted to ensure mocks are available during hoisting
const {
	mockReadlink,
	mockStat,
	mockReadFile,
	mockReaddir,
	mockHomedir,
	mockDirectoryExists,
	mockFileExists,
	mockRealpath,
	mockMkdir,
	mockWriteFile,
	mockRm,
	mockRename,
	mockRmdir,
	mockCp,
	mockLstat,
} = vi.hoisted(() => ({
	mockReadlink: vi.fn(),
	mockCp: vi.fn(),
	mockLstat: vi.fn(),
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn(),
	mockHomedir: vi.fn(),
	mockDirectoryExists: vi.fn(),
	mockFileExists: vi.fn(),
	mockRealpath: vi.fn(),
	mockMkdir: vi.fn(),
	mockWriteFile: vi.fn(),
	mockRm: vi.fn(),
	mockRename: vi.fn(),
	mockRmdir: vi.fn(),
}))

// Platform-agnostic test paths
// Use forward slashes for consistency, then normalize with path.normalize
const HOME_DIR = process.platform === "win32" ? "C:\\Users\\testuser" : "/home/user"
const PROJECT_DIR = process.platform === "win32" ? "C:\\test\\project" : "/test/project"
const SHARED_DIR = process.platform === "win32" ? "C:\\shared\\skills" : "/shared/skills"

// Helper to create platform-appropriate paths
const p = (...segments: string[]) => path.join(...segments)

// Make fs.lstat report the given paths as symlinks
const mockSymlinks = (...paths: string[]) =>
	mockLstat.mockImplementation(async (pathArg: string) => ({ isSymbolicLink: () => paths.includes(pathArg) }))

// A real not-found error, as fs throws for a missing path or broken symlink
const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })

// Mock fs/promises module
vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
		readdir: mockReaddir,
		realpath: mockRealpath,
		mkdir: mockMkdir,
		writeFile: mockWriteFile,
		rm: mockRm,
		rename: mockRename,
		rmdir: mockRmdir,
		cp: mockCp,
		lstat: mockLstat,
		readlink: mockReadlink,
	},
	stat: mockStat,
	readFile: mockReadFile,
	readdir: mockReaddir,
	realpath: mockRealpath,
	mkdir: mockMkdir,
	writeFile: mockWriteFile,
	rm: mockRm,
	rename: mockRename,
	rmdir: mockRmdir,
	cp: mockCp,
	lstat: mockLstat,
	readlink: mockReadlink,
}))

// Mock os module
vi.mock("os", () => ({
	homedir: mockHomedir,
}))

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	RelativePattern: vi.fn(),
}))

// Global roo directory - computed once
const GLOBAL_ROO_DIR = p(HOME_DIR, ".roo")
const GLOBAL_AGENTS_DIR = p(HOME_DIR, ".agents")

// Mock roo-config
vi.mock("../../roo-config", () => ({
	getGlobalRooDirectory: () => GLOBAL_ROO_DIR,
	getGlobalAgentsDirectory: () => GLOBAL_AGENTS_DIR,
	getProjectAgentsDirectoryForCwd: (cwd: string) => p(cwd, ".agents"),
	directoryExists: mockDirectoryExists,
	fileExists: mockFileExists,
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, any>) => {
		const translations: Record<string, string> = {
			"skills:errors.name_length": `Skill name must be 1-${params?.maxLength} characters (got ${params?.length})`,
			"skills:errors.name_format":
				"Skill name must be lowercase letters/numbers/hyphens only (no leading/trailing hyphen, no consecutive hyphens)",
			"skills:errors.description_length": `Skill description must be 1-1024 characters (got ${params?.length})`,
			"skills:errors.no_workspace": "Cannot create project skill: no workspace folder is open",
			"skills:errors.already_exists": `Skill "${params?.name}" already exists at ${params?.path}`,
			"skills:errors.not_found": `Skill "${params?.name}" not found in ${params?.source}${params?.modeInfo}`,
		}
		return translations[key] || key
	},
}))

import * as vscode from "vscode"
import { SkillsManager } from "../SkillsManager"
import { ClineProvider } from "../../../core/webview/ClineProvider"

describe("SkillsManager", () => {
	let skillsManager: SkillsManager
	let mockProvider: Partial<ClineProvider>

	// Pre-computed paths for tests
	const globalSkillsDir = p(GLOBAL_ROO_DIR, "skills")
	const globalSkillsCodeDir = p(GLOBAL_ROO_DIR, "skills-code")
	const globalSkillsArchitectDir = p(GLOBAL_ROO_DIR, "skills-architect")
	const projectRooDir = p(PROJECT_DIR, ".roo")
	const projectSkillsDir = p(projectRooDir, "skills")
	// .agents directory paths
	const globalAgentsSkillsDir = p(GLOBAL_AGENTS_DIR, "skills")
	const globalAgentsSkillsCodeDir = p(GLOBAL_AGENTS_DIR, "skills-code")
	const projectAgentsDir = p(PROJECT_DIR, ".agents")
	const projectAgentsSkillsDir = p(projectAgentsDir, "skills")

	beforeEach(() => {
		vi.clearAllMocks()
		mockLstat.mockReset()
		mockHomedir.mockReturnValue(HOME_DIR)

		// Create mock provider
		mockProvider = {
			cwd: PROJECT_DIR,
			customModesManager: {
				getCustomModes: vi.fn().mockResolvedValue([]),
			} as any,
		}

		skillsManager = new SkillsManager(mockProvider as ClineProvider)
	})

	afterEach(async () => {
		await skillsManager.dispose()
	})

	describe("discoverSkills", () => {
		it("should discover skills from global directory", async () => {
			const pdfSkillDir = p(globalSkillsDir, "pdf-processing")
			const pdfSkillMd = p(pdfSkillDir, "SKILL.md")

			// Setup mocks
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["pdf-processing"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === pdfSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === pdfSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === pdfSkillMd) {
					return `---
name: pdf-processing
description: Extract text and tables from PDF files
---

# PDF Processing

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("pdf-processing")
			expect(skills[0].description).toBe("Extract text and tables from PDF files")
			expect(skills[0].source).toBe("global")
		})

		it("should discover skills from project directory", async () => {
			const codeReviewDir = p(projectSkillsDir, "code-review")
			const codeReviewMd = p(codeReviewDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === projectSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === projectSkillsDir) {
					return ["code-review"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === codeReviewDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === codeReviewMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === codeReviewMd) {
					return `---
name: code-review
description: Review code for best practices
---

# Code Review

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("code-review")
			expect(skills[0].source).toBe("project")
		})

		it("should discover mode-specific skills", async () => {
			const refactoringDir = p(globalSkillsCodeDir, "refactoring")
			const refactoringMd = p(refactoringDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsCodeDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsCodeDir) {
					return ["refactoring"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === refactoringDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === refactoringMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === refactoringMd) {
					return `---
name: refactoring
description: Refactor code for better maintainability
---

# Refactoring

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("refactoring")
			expect(skills[0].mode).toBe("code")
		})

		it("should skip skills with missing required fields", async () => {
			const invalidSkillDir = p(globalSkillsDir, "invalid-skill")
			const invalidSkillMd = p(invalidSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["invalid-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === invalidSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === invalidSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === invalidSkillMd) {
					return `---
name: invalid-skill
---

# Missing description field`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should skip skills where name doesn't match directory", async () => {
			const mySkillDir = p(globalSkillsDir, "my-skill")
			const mySkillMd = p(mySkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["my-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === mySkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === mySkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === mySkillMd) {
					return `---
name: different-name
description: Name doesn't match directory
---

# Mismatched name`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should skip skills with invalid name formats (spec compliance)", async () => {
			const invalidNames = [
				"PDF-processing", // uppercase
				"-pdf", // leading hyphen
				"pdf-", // trailing hyphen
				"pdf--processing", // consecutive hyphens
			]

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? invalidNames : []))

			mockStat.mockImplementation(async (pathArg: string) => {
				if (invalidNames.some((name) => pathArg === p(globalSkillsDir, name))) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return invalidNames.some((name) => file === p(globalSkillsDir, name, "SKILL.md"))
			})

			mockReadFile.mockImplementation(async (file: string) => {
				const match = invalidNames.find((name) => file === p(globalSkillsDir, name, "SKILL.md"))
				if (!match) throw new Error("File not found")
				return `---
name: ${match}
description: Invalid name format
---

# Invalid Skill`
			})

			await skillsManager.discoverSkills()
			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should skip skills with name longer than 64 characters (spec compliance)", async () => {
			const longName = "a".repeat(65)
			const longDir = p(globalSkillsDir, longName)
			const longMd = p(longDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? [longName] : []))

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === longDir) return { isDirectory: () => true }
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => file === longMd)
			mockReadFile.mockResolvedValue(`---
name: ${longName}
description: Too long name
---

# Long Name Skill`)

			await skillsManager.discoverSkills()
			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should skip skills with empty/whitespace-only description (spec compliance)", async () => {
			const skillDir = p(globalSkillsDir, "valid-name")
			const skillMd = p(skillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["valid-name"] : []))
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === skillDir) return { isDirectory: () => true }
				throw new Error("Not found")
			})
			mockFileExists.mockImplementation(async (file: string) => file === skillMd)
			mockReadFile.mockResolvedValue(`---
name: valid-name
description: "   "
---

# Empty Description`)

			await skillsManager.discoverSkills()
			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should skip skills with too-long descriptions (spec compliance)", async () => {
			const skillDir = p(globalSkillsDir, "valid-name")
			const skillMd = p(skillDir, "SKILL.md")
			const longDescription = "d".repeat(1025)

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["valid-name"] : []))
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === skillDir) return { isDirectory: () => true }
				throw new Error("Not found")
			})
			mockFileExists.mockImplementation(async (file: string) => file === skillMd)
			mockReadFile.mockResolvedValue(`---
name: valid-name
description: ${longDescription}
---

# Too Long Description`)

			await skillsManager.discoverSkills()
			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})

		it("should handle symlinked skills directory", async () => {
			const sharedSkillDir = p(SHARED_DIR, "shared-skill")
			const sharedSkillMd = p(sharedSkillDir, "SKILL.md")

			// Simulate .roo/skills being a symlink to /shared/skills
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			// realpath resolves the symlink to the actual directory
			mockRealpath.mockImplementation(async (pathArg: string) => {
				if (pathArg === globalSkillsDir) {
					return SHARED_DIR
				}
				return pathArg
			})

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === SHARED_DIR) {
					return ["shared-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sharedSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === sharedSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === sharedSkillMd) {
					return `---
name: shared-skill
description: A skill from a symlinked directory
---

# Shared Skill

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("shared-skill")
			expect(skills[0].source).toBe("global")
		})

		it("should handle symlinked skill subdirectory", async () => {
			const myAliasDir = p(globalSkillsDir, "my-alias")
			const myAliasMd = p(myAliasDir, "SKILL.md")

			// Simulate .roo/skills/my-alias being a symlink to /external/actual-skill
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["my-alias"]
				}
				return []
			})

			// fs.stat follows symlinks, so it returns the target directory info
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === myAliasDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === myAliasMd
			})

			// The skill name in frontmatter must match the symlink name (my-alias)
			mockReadFile.mockImplementation(async (file: string) => {
				if (file === myAliasMd) {
					return `---
name: my-alias
description: A skill accessed via symlink
---

# My Alias Skill

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("my-alias")
			expect(skills[0].source).toBe("global")
		})

		it("should discover skills from symlinked container directory with multiple skills", async () => {
			// .roo/skills/skills -> /repo/skills, containing skill-a/ and skill-b/
			const containerDir = p(globalSkillsDir, "skills") // the symlinked container
			const repoSkillsDir = p("/repo", "skills") // the actual target
			const skillADir = p(repoSkillsDir, "skill-a")
			const skillAMd = p(skillADir, "SKILL.md")
			const skillBDir = p(repoSkillsDir, "skill-b")
			const skillBMd = p(skillBDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir || dir === containerDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => {
				if (pathArg === globalSkillsDir) return globalSkillsDir
				if (pathArg === containerDir) return repoSkillsDir
				return pathArg
			})

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["skills"] // the symlinked container entry
				if (dir === repoSkillsDir) return ["skill-a", "skill-b"]
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === containerDir) return { isDirectory: () => true }
				if (pathArg === skillADir) return { isDirectory: () => true }
				if (pathArg === skillBDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockSymlinks(containerDir)

			mockFileExists.mockImplementation(async (file: string) => {
				return file === skillAMd || file === skillBMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === skillAMd) {
					return `---
name: skill-a
description: First skill from symlinked repo
---

# Skill A`
				}
				if (file === skillBMd) {
					return `---
name: skill-b
description: Second skill from symlinked repo
---

# Skill B`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(2)
			const names = skills.map((s) => s.name).sort()
			expect(names).toEqual(["skill-a", "skill-b"])
			expect(skills.every((s) => s.source === "global")).toBe(true)
		})

		it("should not treat ordinary (non-symlinked) nested directories as containers", async () => {
			// .roo/skills/group/nested-skill/SKILL.md where "group" is a real directory
			const groupDir = p(globalSkillsDir, "group")
			const skillDir = p(groupDir, "nested-skill")
			const skillMd = p(skillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["group"]
				if (dir === groupDir) return ["nested-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === groupDir || pathArg === skillDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockFileExists.mockImplementation(async (file: string) => file === skillMd)
			mockReadFile.mockResolvedValue(`---
name: nested-skill
description: A nested skill
---
Instructions`)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills()).toHaveLength(0)
			expect(mockReaddir).not.toHaveBeenCalledWith(groupDir)
		})

		it("should only scan one level into a symlinked container", async () => {
			// .roo/skills/shared -> /shared/skills, which contains another container "inner"
			const containerEntry = p(globalSkillsDir, "shared")
			const innerDir = p(SHARED_DIR, "inner")
			const innerSkillDir = p(innerDir, "inner-skill")
			const innerSkillMd = p(innerSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) =>
				pathArg === containerEntry ? SHARED_DIR : pathArg,
			)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["shared"]
				if (dir === SHARED_DIR) return ["inner"]
				if (dir === innerDir) return ["inner-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if ([containerEntry, innerDir, innerSkillDir].includes(pathArg)) return { isDirectory: () => true }
				throw enoent()
			})
			mockSymlinks(containerEntry, innerDir)
			mockFileExists.mockImplementation(async (file: string) => file === innerSkillMd)
			mockReadFile.mockResolvedValue(`---
name: inner-skill
description: Too deep
---
Instructions`)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills()).toHaveLength(0)
			expect(mockReaddir).not.toHaveBeenCalledWith(innerDir)
		})

		it.each([
			["container listed first", ["a-repo", "my-skill"]],
			["direct skill listed first", ["my-skill", "z-repo"]],
		])(
			"should prefer a direct skill over a container skill with the same identity (%s)",
			async (_label, rootEntries) => {
				const containerName = rootEntries.find((e) => e !== "my-skill")!
				const containerDir = p(globalSkillsDir, containerName)
				const directSkillDir = p(globalSkillsDir, "my-skill")
				const directSkillMd = p(directSkillDir, "SKILL.md")
				const nestedSkillDir = p(containerDir, "my-skill")
				const nestedSkillMd = p(nestedSkillDir, "SKILL.md")

				mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
				mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) return rootEntries
					if (dir === containerDir) return ["my-skill"]
					return []
				})
				mockStat.mockImplementation(async (pathArg: string) => {
					if ([containerDir, directSkillDir, nestedSkillDir].includes(pathArg)) {
						return { isDirectory: () => true }
					}
					throw enoent()
				})
				mockSymlinks(containerDir)
				mockFileExists.mockImplementation(
					async (file: string) => file === directSkillMd || file === nestedSkillMd,
				)
				mockReadFile.mockImplementation(async (file: string) => {
					if (file === directSkillMd || file === nestedSkillMd) {
						return `---
name: my-skill
description: ${file === directSkillMd ? "Direct" : "Nested"} skill
---

# My Skill`
					}
					throw new Error("File not found")
				})

				await skillsManager.discoverSkills()

				const skills = skillsManager.getAllSkills()
				expect(skills).toHaveLength(1)
				expect(skills[0].path).toBe(directSkillMd)
				expect(skills[0].description).toBe("Direct skill")
			},
		)

		it("should prefer the alphabetically first container on collisions regardless of readdir order", async () => {
			const aRepoDir = p(globalSkillsDir, "a-repo")
			const bRepoDir = p(globalSkillsDir, "b-repo")
			const aSkillDir = p(aRepoDir, "my-skill")
			const bSkillDir = p(bRepoDir, "my-skill")
			const aSkillMd = p(aSkillDir, "SKILL.md")
			const bSkillMd = p(bSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["b-repo", "a-repo"]
				if (dir === aRepoDir || dir === bRepoDir) return ["my-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if ([aRepoDir, bRepoDir, aSkillDir, bSkillDir].includes(pathArg)) {
					return { isDirectory: () => true }
				}
				throw enoent()
			})
			mockSymlinks(aRepoDir, bRepoDir)
			mockFileExists.mockImplementation(async (file: string) => file === aSkillMd || file === bSkillMd)
			mockReadFile.mockImplementation(async (file: string) => {
				if (file === aSkillMd || file === bSkillMd) {
					return `---
name: my-skill
description: ${file === aSkillMd ? "From a-repo" : "From b-repo"}
---

# My Skill`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].path).toBe(aSkillMd)
		})

		it("should handle broken symlinks in container directories gracefully", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const containerDir = p(globalSkillsDir, "repo-skills")
			const brokenDir = p(containerDir, "broken-link")
			const validSkillDir = p(containerDir, "valid-skill")
			const validSkillMd = p(validSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["repo-skills"]
				if (dir === containerDir) return ["broken-link", "valid-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === containerDir) return { isDirectory: () => true }
				if (pathArg === brokenDir) throw enoent()
				if (pathArg === validSkillDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockSymlinks(containerDir)
			mockFileExists.mockImplementation(async (file: string) => file === validSkillMd)
			mockReadFile.mockResolvedValue(`---
name: valid-skill
description: A valid skill next to a broken symlink
---

# Valid Skill`)

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("valid-skill")
			expect(consoleErrorSpy).not.toHaveBeenCalledWith(
				expect.stringContaining(`Failed to stat skill entry ${brokenDir}`),
				expect.anything(),
			)
			consoleErrorSpy.mockRestore()
		})

		it("should log an error when a symlinked container cannot be read", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const containerDir = p(globalSkillsDir, "repo-skills")
			const readError = new Error("EACCES: permission denied")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["repo-skills"]
				if (dir === containerDir) throw readError
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === containerDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockSymlinks(containerDir)
			mockFileExists.mockResolvedValue(false)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills()).toHaveLength(0)
			expect(consoleErrorSpy).toHaveBeenCalledWith(`Failed to scan skills container ${containerDir}:`, readError)
			consoleErrorSpy.mockRestore()
		})

		it("should log an error when checking for a symlink fails", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const entryDir = p(globalSkillsDir, "not-a-skill")
			const lstatError = new Error("EIO: i/o error")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["not-a-skill"] : []))
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === entryDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockLstat.mockRejectedValue(lstatError)
			mockFileExists.mockResolvedValue(false)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills()).toHaveLength(0)
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				`Failed to check whether ${entryDir} is a symlink:`,
				lstatError,
			)
			consoleErrorSpy.mockRestore()
		})

		it("should keep scanning the other entries when checking one SKILL.md fails unexpectedly", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			// "a-broken" sorts first, so before the fix its error dropped every later entry
			const brokenDir = p(globalSkillsDir, "a-broken")
			const brokenMd = p(brokenDir, "SKILL.md")
			const validDir = p(globalSkillsDir, "b-valid")
			const validMd = p(validDir, "SKILL.md")
			const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" })

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) =>
				dir === globalSkillsDir ? ["a-broken", "b-valid"] : [],
			)
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === brokenDir || pathArg === validDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockFileExists.mockImplementation(async (file: string) => {
				if (file === brokenMd) throw accessError
				return file === validMd
			})
			mockReadFile.mockResolvedValue(`---
name: b-valid
description: Still discovered
---
Instructions`)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills().map((s) => s.name)).toEqual(["b-valid"])
			expect(consoleErrorSpy).toHaveBeenCalledWith(`Failed to check skill entry ${brokenDir}:`, accessError)
			consoleErrorSpy.mockRestore()
		})

		it("should skip hidden entries such as the staging and trash dirs of a move", async () => {
			const hiddenNames = [".my-skill.moving-1-2-abc", ".my-skill.removing-1-2-abc"]
			const hiddenDirs = hiddenNames.map((name) => p(globalSkillsDir, name))

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? hiddenNames : []))
			mockStat.mockResolvedValue({ isDirectory: () => true })
			mockFileExists.mockResolvedValue(true)
			mockReadFile.mockResolvedValue(`---
name: my-skill
description: A hidden copy
---
Instructions`)

			await skillsManager.discoverSkills()

			expect(skillsManager.getAllSkills()).toHaveLength(0)
			for (const dir of hiddenDirs) {
				expect(mockStat).not.toHaveBeenCalledWith(dir)
			}
		})

		it("should run discovery passes one at a time", async () => {
			let active = 0
			let maxActive = 0
			let releaseFirst: () => void = () => {}
			const firstBlocked = new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			let calls = 0

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir !== globalSkillsDir) return []
				active++
				maxActive = Math.max(maxActive, active)
				calls++
				if (calls === 1) await firstBlocked
				active--
				return []
			})

			const first = skillsManager.discoverSkills()
			const second = skillsManager.discoverSkills()
			// Let the first pass reach the blocked readdir
			await vi.waitFor(() => expect(calls).toBe(1))
			releaseFirst()
			await Promise.all([first, second])

			expect(calls).toBe(2)
			expect(maxActive).toBe(1)
		})

		it("should keep running later passes after a pass fails", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			// Reading the workspace path fails once, so the first pass rejects
			let failNext = true
			Object.defineProperty(mockProvider, "cwd", {
				configurable: true,
				get: () => {
					if (failNext) {
						failNext = false
						throw new Error("boom")
					}
					return PROJECT_DIR
				},
			})

			await expect(skillsManager.discoverSkills()).rejects.toThrow("boom")
			await expect(skillsManager.discoverSkills()).resolves.toBeUndefined()
			expect(mockDirectoryExists).toHaveBeenCalledWith(projectSkillsDir)
		})

		describe("incomplete passes", () => {
			const containerEntry = p(globalSkillsDir, "shared")
			const sharedSkillDir = p(SHARED_DIR, "shared-skill")
			const sharedSkillMd = p(sharedSkillDir, "SKILL.md")
			const directSkillDir = p(globalSkillsDir, "direct-skill")
			const directSkillMd = p(directSkillDir, "SKILL.md")
			const newSkillDir = p(globalSkillsDir, "new-skill")
			const newSkillMd = p(newSkillDir, "SKILL.md")

			let containerReadError: Error | undefined
			let rootEntries: string[]

			beforeEach(() => {
				containerReadError = undefined
				rootEntries = ["direct-skill", "shared"]

				mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
				mockRealpath.mockImplementation(async (pathArg: string) =>
					pathArg === containerEntry ? SHARED_DIR : pathArg,
				)
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) return rootEntries
					if (dir === SHARED_DIR) {
						if (containerReadError) throw containerReadError
						return ["shared-skill"]
					}
					return []
				})
				mockStat.mockImplementation(async (pathArg: string) => {
					if ([containerEntry, sharedSkillDir, directSkillDir, newSkillDir].includes(pathArg)) {
						return { isDirectory: () => true }
					}
					throw enoent()
				})
				mockSymlinks(containerEntry)
				mockFileExists.mockImplementation(async (file: string) =>
					[sharedSkillMd, directSkillMd, newSkillMd].includes(file),
				)
				mockReadFile.mockImplementation(async (file: string) => {
					const name = path.basename(path.dirname(file))
					return `---\nname: ${name}\ndescription: ${name} description\n---\nInstructions`
				})
			})

			const skillNames = () =>
				skillsManager
					.getAllSkills()
					.map((s) => s.name)
					.sort()

			it("should keep the skills that a transient read error hid, until a complete pass", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				// The container can't be read for a moment. Its skill must stay available,
				// and must stay read-only.
				containerReadError = Object.assign(new Error("i/o error"), { code: "EIO" })
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])
				await expect(skillsManager.getSkillContent("shared-skill")).resolves.toMatchObject({
					name: "shared-skill",
				})
				await expect(skillsManager.deleteSkill("shared-skill", "global")).rejects.toThrow(
					"container_skill_read_only",
				)

				// The container is really gone now, so a complete pass drops its skill
				containerReadError = Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill"])
				consoleErrorSpy.mockRestore()
			})

			it("should keep a container skill whose entry can't be inspected, until a complete pass", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				let statError: Error = Object.assign(new Error("i/o error"), { code: "EIO" })
				mockStat.mockImplementation(async (pathArg: string) => {
					if (pathArg === sharedSkillDir) throw statError
					if ([containerEntry, directSkillDir].includes(pathArg)) return { isDirectory: () => true }
					throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				})
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])
				await expect(skillsManager.deleteSkill("shared-skill", "global")).rejects.toThrow(
					"container_skill_read_only",
				)

				// The entry is really gone now (e.g. a broken symlink), so a complete pass drops it
				statError = Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill"])
				consoleErrorSpy.mockRestore()
			})

			it("should keep a skill whose SKILL.md can't be read, until a complete pass", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				let skillMdError: Error = Object.assign(new Error("permission denied"), { code: "EACCES" })
				mockFileExists.mockImplementation(async (file: string) => {
					if (file === sharedSkillMd) throw skillMdError
					return file === directSkillMd
				})
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				// A transient readFile failure is handled the same way
				mockFileExists.mockImplementation(async (file: string) => [sharedSkillMd, directSkillMd].includes(file))
				mockReadFile.mockImplementation(async (file: string) => {
					if (file === sharedSkillMd) throw Object.assign(new Error("i/o error"), { code: "EIO" })
					const name = path.basename(path.dirname(file))
					return `---\nname: ${name}\ndescription: ${name} description\n---\nInstructions`
				})
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				// SKILL.md is really gone now, so a complete pass drops the skill
				skillMdError = Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				mockFileExists.mockImplementation(async (file: string) => {
					if (file === sharedSkillMd) throw skillMdError
					return file === directSkillMd
				})
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["direct-skill"])
				consoleErrorSpy.mockRestore()
			})

			it("should still publish changes found by an incomplete pass", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await skillsManager.discoverSkills()

				containerReadError = Object.assign(new Error("i/o error"), { code: "EIO" })
				rootEntries = ["new-skill", "shared"]
				mockReadFile.mockImplementation(async (file: string) => {
					const name = path.basename(path.dirname(file))
					return `---\nname: ${name}\ndescription: updated ${name}\n---\nInstructions`
				})
				await skillsManager.discoverSkills()

				// New skills appear, and skills removed outside the failed container disappear.
				// Kept skills keep their old metadata, since they weren't re-read.
				expect(skillNames()).toEqual(["new-skill", "shared-skill"])
				expect(skillsManager.getSkill("new-skill", "global")?.description).toBe("updated new-skill")
				expect(skillsManager.getSkill("shared-skill", "global")?.description).toBe("shared-skill description")
				consoleErrorSpy.mockRestore()
			})

			it("should keep the skills of a symlinked root that fails to resolve, until it resolves again", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				const rootTarget = p(SHARED_DIR, "root-target")
				const skillDir = p(rootTarget, "root-skill")
				mockRealpath.mockImplementation(async (pathArg: string) =>
					pathArg === globalSkillsDir ? rootTarget : pathArg,
				)
				mockReaddir.mockImplementation(async (dir: string) => (dir === rootTarget ? ["root-skill"] : []))
				mockStat.mockImplementation(async (pathArg: string) => {
					if (pathArg === skillDir) return { isDirectory: () => true }
					throw enoent()
				})
				mockFileExists.mockImplementation(async (file: string) => file === p(skillDir, "SKILL.md"))

				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["root-skill"])

				const ioError = Object.assign(new Error("i/o error"), { code: "EIO" })
				mockDirectoryExists.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) throw ioError
					return false
				})
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["root-skill"])

				mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
				mockRealpath.mockRejectedValue(ioError)
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual(["root-skill"])

				// The root is really gone now, so a pass that reads it drops the skill
				mockDirectoryExists.mockResolvedValue(false)
				await skillsManager.discoverSkills()
				expect(skillNames()).toEqual([])
				consoleErrorSpy.mockRestore()
			})

			it("should drop a deleted skill while an unrelated entry fails persistently", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				await skillsManager.discoverSkills()

				containerReadError = Object.assign(new Error("permission denied"), { code: "EACCES" })
				mockRm.mockImplementation(async () => {
					rootEntries = ["shared"]
				})
				await skillsManager.deleteSkill("direct-skill", "global")

				expect(skillNames()).toEqual(["shared-skill"])
				consoleErrorSpy.mockRestore()
			})

			it("should keep the published skills visible while a pass is running", async () => {
				await skillsManager.discoverSkills()

				let releaseScan: () => void = () => {}
				const scanBlocked = new Promise<void>((resolve) => {
					releaseScan = resolve
				})
				let blocked = false
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) {
						blocked = true
						await scanBlocked
						return []
					}
					return []
				})

				const run = skillsManager.discoverSkills()
				await vi.waitFor(() => expect(blocked).toBe(true))
				expect(skillNames()).toEqual(["direct-skill", "shared-skill"])

				releaseScan()
				await run
				expect(skillNames()).toEqual([])
			})

			it("should not publish a pass that finishes after dispose", async () => {
				let releaseScan: () => void = () => {}
				const scanBlocked = new Promise<void>((resolve) => {
					releaseScan = resolve
				})
				let blocked = false
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) {
						blocked = true
						await scanBlocked
						return rootEntries
					}
					return dir === SHARED_DIR ? ["shared-skill"] : []
				})

				const run = skillsManager.discoverSkills()
				await vi.waitFor(() => expect(blocked).toBe(true))
				await skillsManager.dispose()
				releaseScan()
				await run

				expect(skillsManager.getAllSkills()).toEqual([])
			})
		})

		describe("container watchers", () => {
			const containerEntry = p(globalSkillsDir, "shared")

			beforeEach(() => {
				// Watchers are disabled under NODE_ENV=test
				vi.stubEnv("NODE_ENV", "development")

				mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
				mockRealpath.mockImplementation(async (pathArg: string) =>
					pathArg === containerEntry ? SHARED_DIR : pathArg,
				)
				mockStat.mockImplementation(async (pathArg: string) => {
					if (pathArg === containerEntry) return { isDirectory: () => true }
					throw enoent()
				})
				mockSymlinks(containerEntry)
				mockFileExists.mockResolvedValue(false)
			})

			afterEach(() => {
				vi.unstubAllEnvs()
			})

			const containerWatcherCalls = () =>
				vi.mocked(vscode.RelativePattern).mock.calls.filter((call) => call[0] === SHARED_DIR)

			it("should watch a discovered container's real path once and dispose it when the container is gone", async () => {
				let linked = true
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) return linked ? ["shared"] : []
					return []
				})

				await skillsManager.discoverSkills()
				await skillsManager.discoverSkills()

				expect(containerWatcherCalls()).toEqual([[SHARED_DIR, "{*,*/SKILL.md}"]])
				const createWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
				const watcherIndex = vi
					.mocked(vscode.RelativePattern)
					.mock.calls.findIndex((call) => call[0] === SHARED_DIR)
				const watcher = createWatcher.mock.results[watcherIndex].value as { dispose: ReturnType<typeof vi.fn> }
				expect(watcher.dispose).not.toHaveBeenCalled()

				linked = false
				await skillsManager.discoverSkills()

				expect(watcher.dispose).toHaveBeenCalledTimes(1)
			})

			it("should keep a container watcher when a later pass can't read the tree", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				let readError: Error | undefined
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir !== globalSkillsDir) return []
					if (readError) throw readError
					return ["shared"]
				})

				await skillsManager.discoverSkills()
				const watcherIndex = vi
					.mocked(vscode.RelativePattern)
					.mock.calls.findIndex((call) => call[0] === SHARED_DIR)
				const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[watcherIndex]
					.value as { dispose: ReturnType<typeof vi.fn> }

				// A transient error hides the container, so its watcher must survive
				readError = Object.assign(new Error("i/o error"), { code: "EIO" })
				await skillsManager.discoverSkills()
				expect(watcher.dispose).not.toHaveBeenCalled()

				// The root is really gone now, so the watcher is disposed
				readError = Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				await skillsManager.discoverSkills()
				expect(watcher.dispose).toHaveBeenCalledTimes(1)
				consoleErrorSpy.mockRestore()
			})

			it("should keep a container's skills and watcher when checking for the symlink fails unexpectedly", async () => {
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
				const sharedSkillDir = p(SHARED_DIR, "shared-skill")
				const sharedSkillMd = p(sharedSkillDir, "SKILL.md")
				mockReaddir.mockImplementation(async (dir: string) => {
					if (dir === globalSkillsDir) return ["shared"]
					if (dir === SHARED_DIR) return ["shared-skill"]
					return []
				})
				mockStat.mockImplementation(async (pathArg: string) => {
					if ([containerEntry, sharedSkillDir].includes(pathArg)) return { isDirectory: () => true }
					throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				})
				mockFileExists.mockImplementation(async (file: string) => file === sharedSkillMd)
				mockReadFile.mockResolvedValue(`---\nname: shared-skill\ndescription: Shared skill\n---\nInstructions`)

				await skillsManager.discoverSkills()
				expect(skillsManager.getAllSkills().map((s) => s.name)).toEqual(["shared-skill"])
				const watcherIndex = vi
					.mocked(vscode.RelativePattern)
					.mock.calls.findIndex((call) => call[0] === SHARED_DIR)
				const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[watcherIndex]
					.value as { dispose: ReturnType<typeof vi.fn> }

				// A transient lstat error hides that the entry is a container
				mockLstat.mockRejectedValue(Object.assign(new Error("i/o error"), { code: "EIO" }))
				await skillsManager.discoverSkills()
				expect(skillsManager.getAllSkills().map((s) => s.name)).toEqual(["shared-skill"])
				expect(watcher.dispose).not.toHaveBeenCalled()

				// The entry is really gone now, so a complete pass drops the skill and the watcher
				mockLstat.mockRejectedValue(Object.assign(new Error("no such file or directory"), { code: "ENOENT" }))
				await skillsManager.discoverSkills()
				expect(skillsManager.getAllSkills()).toEqual([])
				expect(watcher.dispose).toHaveBeenCalledTimes(1)
				consoleErrorSpy.mockRestore()
			})

			it("should not rediscover skills for events on hidden staging or trash paths", async () => {
				mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["shared"] : []))
				await skillsManager.discoverSkills()

				const watcherIndex = vi
					.mocked(vscode.RelativePattern)
					.mock.calls.findIndex((call) => call[0] === SHARED_DIR)
				const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[watcherIndex]
					.value as { onDidCreate: ReturnType<typeof vi.fn> }
				const onCreate = watcher.onDidCreate.mock.calls[0][0] as (uri: { fsPath: string }) => Promise<void>
				const discoverSpy = vi.spyOn(skillsManager, "discoverSkills")

				await onCreate({ fsPath: p(SHARED_DIR, ".my-skill.moving-1-2-abc") })
				await onCreate({ fsPath: p(SHARED_DIR, ".my-skill.removing-1-2-abc", "SKILL.md") })
				expect(discoverSpy).not.toHaveBeenCalled()

				await onCreate({ fsPath: p(SHARED_DIR, "my-skill", "SKILL.md") })
				expect(discoverSpy).toHaveBeenCalledTimes(1)
			})

			it("should dispose container watchers on dispose", async () => {
				mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["shared"] : []))

				await skillsManager.discoverSkills()
				const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[0].value as {
					dispose: ReturnType<typeof vi.fn>
				}

				await skillsManager.dispose()

				expect(watcher.dispose).toHaveBeenCalledTimes(1)
			})
		})

		it("should discover skills from global .agents directory", async () => {
			const agentSkillDir = p(globalAgentsSkillsDir, "agent-skill")
			const agentSkillMd = p(agentSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalAgentsSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalAgentsSkillsDir) {
					return ["agent-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === agentSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === agentSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === agentSkillMd) {
					return `---
name: agent-skill
description: A skill from .agents directory shared across AI coding tools
---

# Agent Skill

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("agent-skill")
			expect(skills[0].description).toBe("A skill from .agents directory shared across AI coding tools")
			expect(skills[0].source).toBe("global")
		})

		it("should discover skills from project .agents directory", async () => {
			const projectAgentSkillDir = p(projectAgentsSkillsDir, "project-agent-skill")
			const projectAgentSkillMd = p(projectAgentSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === projectAgentsSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === projectAgentsSkillsDir) {
					return ["project-agent-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === projectAgentSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === projectAgentSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === projectAgentSkillMd) {
					return `---
name: project-agent-skill
description: A project-level skill from .agents directory
---

# Project Agent Skill

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("project-agent-skill")
			expect(skills[0].source).toBe("project")
		})

		it("should prioritize .roo skills over .agents skills with same name", async () => {
			const agentSkillDir = p(globalAgentsSkillsDir, "common-skill")
			const agentSkillMd = p(agentSkillDir, "SKILL.md")
			const rooSkillDir = p(globalSkillsDir, "common-skill")
			const rooSkillMd = p(rooSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalAgentsSkillsDir || dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalAgentsSkillsDir || dir === globalSkillsDir) {
					return ["common-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === agentSkillDir || pathArg === rooSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === agentSkillMd || file === rooSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === agentSkillMd) {
					return `---
name: common-skill
description: Agent version (should be overridden)
---

# Agent Common Skill`
				}
				if (file === rooSkillMd) {
					return `---
name: common-skill
description: Roo version (should take priority)
---

# Roo Common Skill`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getSkillsForMode("code")
			const commonSkill = skills.find((s) => s.name === "common-skill")
			expect(commonSkill).toBeDefined()
			// .roo should override .agents
			expect(commonSkill?.description).toBe("Roo version (should take priority)")
		})

		it("should discover mode-specific skills from .agents directory", async () => {
			const agentCodeSkillDir = p(globalAgentsSkillsCodeDir, "agent-code-skill")
			const agentCodeSkillMd = p(agentCodeSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalAgentsSkillsCodeDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalAgentsSkillsCodeDir) {
					return ["agent-code-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === agentCodeSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === agentCodeSkillMd
			})

			mockReadFile.mockImplementation(async (file: string) => {
				if (file === agentCodeSkillMd) {
					return `---
name: agent-code-skill
description: A code mode skill from .agents directory
---

# Agent Code Skill

Instructions here...`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(1)
			expect(skills[0].name).toBe("agent-code-skill")
			expect(skills[0].mode).toBe("code")
		})
	})

	describe("getSkillsForMode", () => {
		it("should return skills filtered by mode", async () => {
			const genericSkillDir = p(globalSkillsDir, "generic-skill")
			const codeSkillDir = p(globalSkillsCodeDir, "code-skill")

			// Setup skills for testing
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return [globalSkillsDir, globalSkillsCodeDir].includes(dir)
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["generic-skill"]
				}
				if (dir === globalSkillsCodeDir) {
					return ["code-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === genericSkillDir || pathArg === codeSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockResolvedValue(true)

			mockReadFile.mockImplementation(async (file: string) => {
				if (file.includes("generic-skill")) {
					return `---
name: generic-skill
description: Generic skill
---
Instructions`
				}
				if (file.includes("code-skill")) {
					return `---
name: code-skill
description: Code skill
---
Instructions`
				}
				throw new Error("File not found")
			})

			await skillsManager.discoverSkills()

			const codeSkills = skillsManager.getSkillsForMode("code")

			// Should include both generic and code-specific skills
			expect(codeSkills.length).toBe(2)
			expect(codeSkills.map((s) => s.name)).toContain("generic-skill")
			expect(codeSkills.map((s) => s.name)).toContain("code-skill")
		})

		it("should apply project > global override", async () => {
			const globalSharedSkillDir = p(globalSkillsDir, "shared-skill")
			const projectSharedSkillDir = p(projectSkillsDir, "shared-skill")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return [globalSkillsDir, projectSkillsDir].includes(dir)
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["shared-skill"]
				}
				if (dir === projectSkillsDir) {
					return ["shared-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === globalSharedSkillDir || pathArg === projectSharedSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockResolvedValue(true)

			mockReadFile.mockResolvedValue(`---
name: shared-skill
description: Shared skill
---
Instructions`)

			await skillsManager.discoverSkills()

			const skills = skillsManager.getSkillsForMode("code")
			const sharedSkill = skills.find((s) => s.name === "shared-skill")

			// Project skill should override global
			expect(sharedSkill?.source).toBe("project")
		})

		it("should apply mode-specific > generic override", async () => {
			const genericTestSkillDir = p(globalSkillsDir, "test-skill")
			const codeTestSkillDir = p(globalSkillsCodeDir, "test-skill")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return [globalSkillsDir, globalSkillsCodeDir].includes(dir)
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				if (dir === globalSkillsCodeDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === genericTestSkillDir || pathArg === codeTestSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockResolvedValue(true)

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: Test skill
---
Instructions`)

			await skillsManager.discoverSkills()

			const skills = skillsManager.getSkillsForMode("code")
			const testSkill = skills.find((s) => s.name === "test-skill")

			// Mode-specific should override generic
			expect(testSkill?.mode).toBe("code")
		})

		it("should not include mode-specific skills for other modes", async () => {
			const architectOnlyDir = p(globalSkillsArchitectDir, "architect-only")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsArchitectDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsArchitectDir) {
					return ["architect-only"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === architectOnlyDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockResolvedValue(true)

			mockReadFile.mockResolvedValue(`---
name: architect-only
description: Only for architect mode
---
Instructions`)

			await skillsManager.discoverSkills()

			const codeSkills = skillsManager.getSkillsForMode("code")
			const architectSkill = codeSkills.find((s) => s.name === "architect-only")

			expect(architectSkill).toBeUndefined()
		})
	})

	describe("getSkillContent", () => {
		it("should return full skill content", async () => {
			const testSkillDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(testSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === testSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === testSkillMd
			})

			const skillContent = `---
name: test-skill
description: A test skill
---

# Test Skill

## Instructions

1. Do this
2. Do that`

			mockReadFile.mockResolvedValue(skillContent)

			await skillsManager.discoverSkills()

			const content = await skillsManager.getSkillContent("test-skill")

			expect(content).not.toBeNull()
			expect(content?.name).toBe("test-skill")
			expect(content?.instructions).toContain("# Test Skill")
			expect(content?.instructions).toContain("1. Do this")
		})

		it("should return null for non-existent skill", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])

			await skillsManager.discoverSkills()

			const content = await skillsManager.getSkillContent("non-existent")

			expect(content).toBeNull()
		})
	})

	describe("dispose", () => {
		it("should clean up resources", async () => {
			await skillsManager.dispose()

			const skills = skillsManager.getAllSkills()
			expect(skills).toHaveLength(0)
		})
	})

	describe("getSkillsMetadata", () => {
		it("should return all skills metadata", async () => {
			const testSkillDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(testSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === testSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === testSkillMd
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			await skillsManager.discoverSkills()

			const metadata = skillsManager.getSkillsMetadata()

			expect(metadata).toHaveLength(1)
			expect(metadata[0].name).toBe("test-skill")
			expect(metadata[0].description).toBe("A test skill")
		})
	})

	describe("getSkill", () => {
		it("should return a skill by name, source, and mode", async () => {
			const testSkillDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(testSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === testSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === testSkillMd
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			await skillsManager.discoverSkills()

			const skill = skillsManager.getSkill("test-skill", "global")

			expect(skill).toBeDefined()
			expect(skill?.name).toBe("test-skill")
			expect(skill?.source).toBe("global")
		})

		it("should return undefined for non-existent skill", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])

			await skillsManager.discoverSkills()

			const skill = skillsManager.getSkill("non-existent", "global")

			expect(skill).toBeUndefined()
		})
	})

	describe("createSkill", () => {
		it("should create a new global skill", async () => {
			// Setup: no existing skills
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])
			mockFileExists.mockResolvedValue(false)
			mockMkdir.mockResolvedValue(undefined)
			mockWriteFile.mockResolvedValue(undefined)

			const createdPath = await skillsManager.createSkill("new-skill", "global", "A new skill description")

			expect(createdPath).toBe(p(GLOBAL_ROO_DIR, "skills", "new-skill", "SKILL.md"))
			expect(mockMkdir).toHaveBeenCalledWith(p(GLOBAL_ROO_DIR, "skills", "new-skill"), { recursive: true })
			expect(mockWriteFile).toHaveBeenCalled()

			// Verify the content written
			const writeCall = mockWriteFile.mock.calls[0]
			expect(writeCall[0]).toBe(p(GLOBAL_ROO_DIR, "skills", "new-skill", "SKILL.md"))
			expect(writeCall[1]).toContain("name: new-skill")
			expect(writeCall[1]).toContain("description: A new skill description")
		})

		it("should create a mode-specific skill with modeSlugs array", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])
			mockFileExists.mockResolvedValue(false)
			mockMkdir.mockResolvedValue(undefined)
			mockWriteFile.mockResolvedValue(undefined)

			const createdPath = await skillsManager.createSkill("code-skill", "global", "A code skill", ["code"])

			// Skills are always created in the generic skills directory now; mode info is in frontmatter
			expect(createdPath).toBe(p(GLOBAL_ROO_DIR, "skills", "code-skill", "SKILL.md"))

			// Verify frontmatter contains modeSlugs
			const writeCall = mockWriteFile.mock.calls[0]
			expect(writeCall[1]).toContain("modeSlugs:")
			expect(writeCall[1]).toContain("- code")
		})

		it("should create a project skill", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])
			mockFileExists.mockResolvedValue(false)
			mockMkdir.mockResolvedValue(undefined)
			mockWriteFile.mockResolvedValue(undefined)

			const createdPath = await skillsManager.createSkill("project-skill", "project", "A project skill")

			expect(createdPath).toBe(p(PROJECT_DIR, ".roo", "skills", "project-skill", "SKILL.md"))
		})

		it("should throw error for invalid skill name", async () => {
			await expect(skillsManager.createSkill("Invalid-Name", "global", "Description")).rejects.toThrow(
				"Skill name must be lowercase letters/numbers/hyphens only",
			)
		})

		it("should throw error for skill name that is too long", async () => {
			const longName = "a".repeat(65)
			await expect(skillsManager.createSkill(longName, "global", "Description")).rejects.toThrow(
				"Skill name must be 1-64 characters",
			)
		})

		it("should throw error for skill name starting with hyphen", async () => {
			await expect(skillsManager.createSkill("-invalid", "global", "Description")).rejects.toThrow(
				"Skill name must be lowercase letters/numbers/hyphens only",
			)
		})

		it("should throw error for skill name ending with hyphen", async () => {
			await expect(skillsManager.createSkill("invalid-", "global", "Description")).rejects.toThrow(
				"Skill name must be lowercase letters/numbers/hyphens only",
			)
		})

		it("should throw error for skill name with consecutive hyphens", async () => {
			await expect(skillsManager.createSkill("invalid--name", "global", "Description")).rejects.toThrow(
				"Skill name must be lowercase letters/numbers/hyphens only",
			)
		})

		it("should throw error for empty description", async () => {
			await expect(skillsManager.createSkill("valid-name", "global", "   ")).rejects.toThrow(
				"Skill description must be 1-1024 characters",
			)
		})

		it("should throw error for description that is too long", async () => {
			const longDesc = "d".repeat(1025)
			await expect(skillsManager.createSkill("valid-name", "global", longDesc)).rejects.toThrow(
				"Skill description must be 1-1024 characters",
			)
		})

		it("should throw error if skill already exists", async () => {
			mockFileExists.mockResolvedValue(true)

			await expect(skillsManager.createSkill("existing-skill", "global", "Description")).rejects.toThrow(
				"already exists",
			)
		})

		it("should allow creating a .roo skill when the duplicate lives in the lower-priority .agents root", async () => {
			const agentsSkillDir = p(globalAgentsSkillsDir, "my-skill")
			const agentsSkillMd = p(agentsSkillDir, "SKILL.md")
			const rooSkillMd = p(globalSkillsDir, "my-skill", "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalAgentsSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalAgentsSkillsDir ? ["my-skill"] : []))
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === agentsSkillDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockFileExists.mockImplementation(async (file: string) => file === agentsSkillMd)
			mockReadFile.mockResolvedValue(`---
name: my-skill
description: An agents skill
---
Instructions`)
			mockMkdir.mockResolvedValue(undefined)
			mockWriteFile.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()
			expect(skillsManager.getSkill("my-skill", "global")?.path).toBe(agentsSkillMd)

			const created = await skillsManager.createSkill("my-skill", "global", "Description")

			expect(created).toBe(rooSkillMd)
			expect(mockWriteFile).toHaveBeenCalledWith(rooSkillMd, expect.any(String), "utf-8")
		})
	})

	describe("deleteSkill", () => {
		it("should delete an existing skill", async () => {
			const testSkillDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(testSkillDir, "SKILL.md")

			// Setup: skill exists
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === testSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === testSkillMd
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockRm.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Verify skill exists
			expect(skillsManager.getSkill("test-skill", "global")).toBeDefined()

			// Delete the skill
			await skillsManager.deleteSkill("test-skill", "global")

			expect(mockRm).toHaveBeenCalledWith(testSkillDir, { recursive: true, force: true })
		})

		it("should throw error if skill does not exist", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])

			await skillsManager.discoverSkills()

			await expect(skillsManager.deleteSkill("non-existent", "global")).rejects.toThrow("not found")
		})

		it("should refuse to delete a skill from a symlinked container", async () => {
			const containerEntry = p(globalSkillsDir, "shared")
			const sharedSkillDir = p(SHARED_DIR, "my-skill")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) =>
				pathArg === containerEntry ? SHARED_DIR : pathArg,
			)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["shared"]
				if (dir === SHARED_DIR) return ["my-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === containerEntry || pathArg === sharedSkillDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockSymlinks(containerEntry)
			mockFileExists.mockImplementation(async (file: string) => file === p(sharedSkillDir, "SKILL.md"))
			mockReadFile.mockResolvedValue(`---
name: my-skill
description: A shared skill
---
Instructions`)

			await skillsManager.discoverSkills()
			expect(skillsManager.getSkill("my-skill", "global")).toBeDefined()

			await expect(skillsManager.deleteSkill("my-skill", "global")).rejects.toThrow(
				"skills:errors.container_skill_read_only",
			)
			expect(mockRm).not.toHaveBeenCalled()

			// Changing its modes would rewrite the shared SKILL.md, so that is refused too
			await expect(skillsManager.updateSkillModes("my-skill", "global", ["code"])).rejects.toThrow(
				"skills:errors.container_skill_read_only",
			)
			expect(mockWriteFile).not.toHaveBeenCalled()
		})
	})

	describe("moveSkill", () => {
		it("should report an unreadable source root instead of 'not found'", async () => {
			const sourceDir = p(globalSkillsDir, "test-skill")
			const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" })

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => (dir === globalSkillsDir ? ["test-skill"] : []))
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockFileExists.mockImplementation(async (file: string) => file === p(sourceDir, "SKILL.md"))
			mockReadFile.mockResolvedValue(`---\nname: test-skill\ndescription: A test skill\n---\nInstructions`)

			await skillsManager.discoverSkills()
			mockRealpath.mockRejectedValue(accessError)

			await expect(skillsManager.moveSkill("test-skill", "global", undefined, "code")).rejects.toBe(accessError)
			expect(mockRename).not.toHaveBeenCalled()
		})

		it("should move a skill from generic to mode-specific directory", async () => {
			const sourceDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(GLOBAL_ROO_DIR, "skills-code", "test-skill")
			const destSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")

			// Setup: skill exists in generic skills directory
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in source
				if (file === testSkillMd) return true
				// Skill does not exist in destination
				if (file === p(destDir, "SKILL.md")) return false
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockMkdir.mockResolvedValue(undefined)
			mockRename.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Verify skill exists
			expect(skillsManager.getSkill("test-skill", "global")).toBeDefined()

			// Move the skill to code mode
			await skillsManager.moveSkill("test-skill", "global", undefined, "code")

			expect(mockMkdir).toHaveBeenCalledWith(destSkillsDir, { recursive: true })
			expect(mockRename).toHaveBeenCalledWith(sourceDir, destDir)
		})

		it("should move a skill from one mode to another", async () => {
			const sourceSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")
			const sourceDir = p(sourceSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(GLOBAL_ROO_DIR, "skills-architect", "test-skill")
			const destSkillsDir = p(GLOBAL_ROO_DIR, "skills-architect")

			// Setup: skill exists in code mode directory
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === sourceSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === sourceSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in source
				if (file === testSkillMd) return true
				// Skill does not exist in destination
				if (file === p(destDir, "SKILL.md")) return false
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockMkdir.mockResolvedValue(undefined)
			mockRename.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Verify skill exists with mode
			expect(skillsManager.getSkill("test-skill", "global", "code")).toBeDefined()

			// Move the skill to architect mode
			await skillsManager.moveSkill("test-skill", "global", "code", "architect")

			expect(mockMkdir).toHaveBeenCalledWith(destSkillsDir, { recursive: true })
			expect(mockRename).toHaveBeenCalledWith(sourceDir, destDir)
		})

		it("should move a skill from mode-specific to generic directory", async () => {
			const sourceSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")
			const sourceDir = p(sourceSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(globalSkillsDir, "test-skill")

			// Setup: skill exists in code mode directory
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === sourceSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === sourceSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in source
				if (file === testSkillMd) return true
				// Skill does not exist in destination
				if (file === p(destDir, "SKILL.md")) return false
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockMkdir.mockResolvedValue(undefined)
			mockRename.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Verify skill exists with mode
			expect(skillsManager.getSkill("test-skill", "global", "code")).toBeDefined()

			// Move the skill to generic (no mode)
			await skillsManager.moveSkill("test-skill", "global", "code", undefined)

			expect(mockMkdir).toHaveBeenCalledWith(globalSkillsDir, { recursive: true })
			expect(mockRename).toHaveBeenCalledWith(sourceDir, destDir)
		})

		it("should not do anything when source and destination modes are the same", async () => {
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			const testSkillDir = p(globalSkillsDir, "test-skill")
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === testSkillDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				return file === p(testSkillDir, "SKILL.md")
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			await skillsManager.discoverSkills()

			// Try to move skill to the same mode (undefined -> undefined)
			await skillsManager.moveSkill("test-skill", "global", undefined, undefined)

			// Should not call rename
			expect(mockRename).not.toHaveBeenCalled()
		})

		it("should throw error if skill does not exist", async () => {
			mockDirectoryExists.mockResolvedValue(false)
			mockRealpath.mockImplementation(async (p: string) => p)
			mockReaddir.mockResolvedValue([])

			await skillsManager.discoverSkills()

			await expect(skillsManager.moveSkill("non-existent", "global", undefined, "code")).rejects.toThrow(
				"not found",
			)
		})

		it("should throw error if skill already exists at destination", async () => {
			const sourceDir = p(globalSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(GLOBAL_ROO_DIR, "skills-code", "test-skill")
			const destSkillMd = p(destDir, "SKILL.md")

			// Setup: skill exists in both locations
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === globalSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) {
					return ["test-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in both source and destination
				if (file === testSkillMd) return true
				if (file === destSkillMd) return true
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			await skillsManager.discoverSkills()

			await expect(skillsManager.moveSkill("test-skill", "global", undefined, "code")).rejects.toThrow(
				"already exists",
			)
		})

		it("should clean up empty source skills directory after moving", async () => {
			const sourceSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")
			const sourceDir = p(sourceSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(GLOBAL_ROO_DIR, "skills-architect", "test-skill")
			const destSkillsDir = p(GLOBAL_ROO_DIR, "skills-architect")

			// Setup: skill exists in code mode directory
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === sourceSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			// Track readdir calls - return skill for discovery, empty for cleanup check
			let readdirCallCount = 0
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === sourceSkillsDir) {
					readdirCallCount++
					// First call is for discovery, return the skill
					// Second call is for cleanup check after move, return empty
					if (readdirCallCount === 1) {
						return ["test-skill"]
					}
					return []
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in source
				if (file === testSkillMd) return true
				// Skill does not exist in destination
				if (file === p(destDir, "SKILL.md")) return false
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockMkdir.mockResolvedValue(undefined)
			mockRename.mockResolvedValue(undefined)
			mockRmdir.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Move the skill to architect mode
			await skillsManager.moveSkill("test-skill", "global", "code", "architect")

			// Verify empty directory was cleaned up
			expect(mockRmdir).toHaveBeenCalledWith(sourceSkillsDir)
		})

		it("should not clean up source skills directory if it still has other skills", async () => {
			const sourceSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")
			const sourceDir = p(sourceSkillsDir, "test-skill")
			const testSkillMd = p(sourceDir, "SKILL.md")
			const destDir = p(GLOBAL_ROO_DIR, "skills-architect", "test-skill")
			const destSkillsDir = p(GLOBAL_ROO_DIR, "skills-architect")

			// Setup: skill exists in code mode directory along with another skill
			mockDirectoryExists.mockImplementation(async (dir: string) => {
				return dir === sourceSkillsDir
			})

			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)

			// Track readdir calls - return skill for discovery, non-empty for cleanup check
			let readdirCallCount = 0
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === sourceSkillsDir) {
					readdirCallCount++
					// First call is for discovery
					if (readdirCallCount === 1) {
						return ["test-skill", "another-skill"]
					}
					// Second call for cleanup - still has another skill
					return ["another-skill"]
				}
				return []
			})

			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === sourceDir || pathArg === p(sourceSkillsDir, "another-skill")) {
					return { isDirectory: () => true }
				}
				throw new Error("Not found")
			})

			mockFileExists.mockImplementation(async (file: string) => {
				// Skill exists in source
				if (file === testSkillMd) return true
				if (file === p(sourceSkillsDir, "another-skill", "SKILL.md")) return true
				// Skill does not exist in destination
				if (file === p(destDir, "SKILL.md")) return false
				return false
			})

			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)

			mockMkdir.mockResolvedValue(undefined)
			mockRename.mockResolvedValue(undefined)
			mockRmdir.mockResolvedValue(undefined)

			await skillsManager.discoverSkills()

			// Move the skill to architect mode
			await skillsManager.moveSkill("test-skill", "global", "code", "architect")

			// Verify directory was NOT cleaned up (still has other skills)
			expect(mockRmdir).not.toHaveBeenCalled()
		})

		it("should refuse to move a skill from a symlinked container", async () => {
			const containerDir = p(globalSkillsDir, "repo")
			const nestedSkillDir = p(containerDir, "my-skill")
			const nestedSkillMd = p(nestedSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalSkillsDir)
			mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
			mockReaddir.mockImplementation(async (dir: string) => {
				if (dir === globalSkillsDir) return ["repo"]
				if (dir === containerDir) return ["my-skill"]
				return []
			})
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === containerDir || pathArg === nestedSkillDir) {
					return { isDirectory: () => true }
				}
				throw enoent()
			})
			mockSymlinks(containerDir)
			mockFileExists.mockImplementation(async (file: string) => file === nestedSkillMd)
			mockReadFile.mockResolvedValue(`---
name: my-skill
description: A container skill
---
Instructions`)

			await skillsManager.discoverSkills()
			expect(skillsManager.getSkill("my-skill", "global")?.path).toBe(nestedSkillMd)

			await expect(skillsManager.moveSkill("my-skill", "global", undefined, "code")).rejects.toThrow(
				"skills:errors.container_skill_read_only",
			)
			expect(mockMkdir).not.toHaveBeenCalled()
			expect(mockRename).not.toHaveBeenCalled()
			expect(mockCp).not.toHaveBeenCalled()
		})

		it("should refuse to move a skill that exists only under .agents", async () => {
			const agentsSkillDir = p(globalAgentsSkillsCodeDir, "test-skill")
			const agentsSkillMd = p(agentsSkillDir, "SKILL.md")

			mockDirectoryExists.mockImplementation(async (dir: string) => dir === globalAgentsSkillsCodeDir)
			mockRealpath.mockImplementation(async (pathArg: string) => {
				if (pathArg === p(GLOBAL_ROO_DIR, "skills-code")) {
					throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
				}
				return pathArg
			})
			mockReaddir.mockImplementation(async (dir: string) =>
				dir === globalAgentsSkillsCodeDir ? ["test-skill"] : [],
			)
			mockStat.mockImplementation(async (pathArg: string) => {
				if (pathArg === agentsSkillDir) return { isDirectory: () => true }
				throw enoent()
			})
			mockFileExists.mockImplementation(async (file: string) => file === agentsSkillMd)
			mockReadFile.mockResolvedValue(`---
name: test-skill
description: A shared agents skill
---
Instructions`)

			await skillsManager.discoverSkills()
			expect(skillsManager.getSkill("test-skill", "global", "code")?.path).toBe(agentsSkillMd)

			await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
				"not found",
			)
			expect(mockMkdir).not.toHaveBeenCalled()
			expect(mockRename).not.toHaveBeenCalled()
			expect(mockCp).not.toHaveBeenCalled()
		})

		describe("cross-filesystem and cleanup safety", () => {
			const sourceSkillsDir = p(GLOBAL_ROO_DIR, "skills-code")
			const sourceDir = p(sourceSkillsDir, "test-skill")
			const destDir = p(GLOBAL_ROO_DIR, "skills-architect", "test-skill")

			const setupCodeSkill = () => {
				mockDirectoryExists.mockImplementation(async (dir: string) => dir === sourceSkillsDir)
				mockRealpath.mockImplementation(async (pathArg: string) => pathArg)
				mockReaddir.mockImplementation(async (dir: string) => (dir === sourceSkillsDir ? ["test-skill"] : []))
				mockStat.mockImplementation(async (pathArg: string) => {
					if (pathArg === sourceDir) return { isDirectory: () => true }
					throw enoent()
				})
				mockFileExists.mockImplementation(async (file: string) => file === p(sourceDir, "SKILL.md"))
				mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)
				mockMkdir.mockResolvedValue(undefined)
				mockRm.mockResolvedValue(undefined)
				mockRmdir.mockResolvedValue(undefined)
			}

			const exdevError = () => Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" })
			const enoentError = () => Object.assign(new Error("no such file or directory"), { code: "ENOENT" })

			// Direct rename from source to dest fails across devices; same-device renames succeed.
			const setupExdevRename = () => {
				mockRename.mockImplementation(async (from: string, to: string) => {
					if (from === sourceDir && to === destDir) {
						throw exdevError()
					}
				})
			}

			const getStagingDir = (): string => {
				const call = mockCp.mock.calls[0]
				expect(call).toBeDefined()
				return call[1] as string
			}

			// The hidden dir the source is renamed aside to before promoting the staging copy
			const getTrashDir = (): string => {
				const call = mockRename.mock.calls.find(([from, to]) => from === sourceDir && to !== destDir)
				expect(call).toBeDefined()
				return call![1] as string
			}

			it("should fall back to copy into a staging dir and promote it when rename fails with EXDEV", async () => {
				setupCodeSkill()
				setupExdevRename()
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())

				await skillsManager.discoverSkills()
				await skillsManager.moveSkill("test-skill", "global", "code", "architect")

				expect(mockRename).toHaveBeenCalledWith(sourceDir, destDir)
				const stagingDir = getStagingDir()
				expect(stagingDir).not.toBe(destDir)
				expect(path.dirname(stagingDir)).toBe(path.dirname(destDir))
				expect(mockCp).toHaveBeenCalledWith(sourceDir, stagingDir, {
					recursive: true,
					errorOnExist: true,
					force: false,
					verbatimSymlinks: true,
				})
				const trashDir = getTrashDir()
				expect(path.dirname(trashDir)).toBe(path.dirname(sourceDir))
				expect(path.basename(trashDir).startsWith(".")).toBe(true)

				// The source is moved aside before the staging copy is promoted
				const renameTargets = mockRename.mock.calls.map(([, to]) => to)
				expect(renameTargets.indexOf(trashDir)).toBeLessThan(renameTargets.lastIndexOf(destDir))
				expect(mockRename).toHaveBeenLastCalledWith(stagingDir, destDir)

				expect(mockRm).toHaveBeenCalledWith(trashDir, { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(destDir, expect.anything())
			})

			it("should resolve and keep a single discoverable copy when deleting the old source fails after promotion", async () => {
				setupCodeSkill()
				setupExdevRename()
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())
				mockRm.mockImplementation(async (target: string) => {
					if (target !== getStagingDir()) {
						throw Object.assign(new Error("permission denied"), { code: "EACCES" })
					}
				})
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).resolves.toBe(
					undefined,
				)

				const trashDir = getTrashDir()
				expect(mockRename).toHaveBeenLastCalledWith(getStagingDir(), destDir)
				expect(mockRm).toHaveBeenCalledWith(trashDir, { recursive: true, force: true })
				// The original source path no longer holds the skill, so no duplicate remains
				expect(mockRename).not.toHaveBeenCalledWith(trashDir, sourceDir)
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					expect.stringContaining(trashDir),
					expect.objectContaining({ code: "EACCES" }),
				)
				consoleErrorSpy.mockRestore()
			})

			it("should restore the source when promoting the staging copy fails after moving the source aside", async () => {
				setupCodeSkill()
				mockRename.mockImplementation(async (from: string, to: string) => {
					if (from === sourceDir && to === destDir) {
						throw exdevError()
					}
					if (to === destDir) {
						throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" })
					}
				})
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"directory not empty",
				)

				const trashDir = getTrashDir()
				expect(mockRename).toHaveBeenCalledWith(trashDir, sourceDir)
				expect(mockRm).toHaveBeenCalledWith(getStagingDir(), { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(trashDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(destDir, expect.anything())
			})

			it("should not promote the staging copy when moving the source aside fails", async () => {
				setupCodeSkill()
				mockRename.mockImplementation(async (from: string, to: string) => {
					if (from === sourceDir && to === destDir) {
						throw exdevError()
					}
					if (from === sourceDir) {
						throw Object.assign(new Error("resource busy"), { code: "EBUSY" })
					}
				})
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"resource busy",
				)

				const stagingDir = getStagingDir()
				expect(mockRename).not.toHaveBeenCalledWith(stagingDir, destDir)
				expect(mockRm).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
			})

			it("should not touch an existing destination directory when the EXDEV fallback finds it", async () => {
				setupCodeSkill()
				setupExdevRename()
				mockCp.mockResolvedValue(undefined)
				// destDir exists (e.g., contains unrelated files but no SKILL.md)
				mockLstat.mockResolvedValue({ isDirectory: () => true })

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"Destination already exists",
				)

				const stagingDir = getStagingDir()
				expect(mockRename).not.toHaveBeenCalledWith(stagingDir, destDir)
				expect(mockRm).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(destDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
			})

			it("should clean up only the staging dir when promoting the copy fails", async () => {
				setupCodeSkill()
				mockRename.mockImplementation(async (from: string, to: string) => {
					if (from === sourceDir && to === destDir) {
						throw exdevError()
					}
					if (to === destDir) {
						throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" })
					}
				})
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"directory not empty",
				)

				const stagingDir = getStagingDir()
				expect(mockRm).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(destDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
			})

			it("should not copy when rename succeeds on the same filesystem", async () => {
				setupCodeSkill()
				mockRename.mockResolvedValue(undefined)

				await skillsManager.discoverSkills()
				await skillsManager.moveSkill("test-skill", "global", "code", "architect")

				expect(mockCp).not.toHaveBeenCalled()
				expect(mockRm).not.toHaveBeenCalled()
			})

			it("should remove only the partial staging copy and keep the source when the EXDEV copy fails", async () => {
				setupCodeSkill()
				setupExdevRename()
				mockCp.mockRejectedValue(new Error("copy failed"))

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"copy failed",
				)

				const stagingDir = getStagingDir()
				expect(mockRm).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true })
				expect(mockRm).not.toHaveBeenCalledWith(destDir, expect.anything())
				expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
			})

			// Directory entry for readdir({ withFileTypes: true })
			const dirent = (name: string, kind: "dir" | "link" | "file") => ({
				name,
				isDirectory: () => kind === "dir",
				isSymbolicLink: () => kind === "link",
			})

			// The link lives at <skill>/refs/shared, so these resolve outside the skill dir
			it.each([
				["a parent-relative link", "../../_shared/f"],
				["a link to the skill dir's parent", "../.."],
			])(
				"should fail while the source still exists when the copy has %s escaping the skill",
				async (_label, target) => {
					setupCodeSkill()
					setupExdevRename()
					mockCp.mockResolvedValue(undefined)
					mockLstat.mockRejectedValue(enoentError())
					mockReaddir.mockImplementation(async (dir: string, options?: { withFileTypes?: boolean }) => {
						if (!options?.withFileTypes) return dir === sourceSkillsDir ? ["test-skill"] : []
						if (dir === getStagingDir()) return [dirent("refs", "dir"), dirent("SKILL.md", "file")]
						if (dir === p(getStagingDir(), "refs")) return [dirent("shared", "link")]
						return []
					})
					mockReadlink.mockResolvedValue(target)

					await skillsManager.discoverSkills()
					await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
						"skills:errors.symlink_escapes_skill",
					)

					const stagingDir = getStagingDir()
					expect(mockReadlink).toHaveBeenCalledWith(p(stagingDir, "refs", "shared"))
					// The source is never moved aside and the staging copy is removed
					expect(mockRename).toHaveBeenCalledTimes(1)
					expect(mockRename).not.toHaveBeenCalledWith(stagingDir, destDir)
					expect(mockRm).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true })
					expect(mockRm).not.toHaveBeenCalledWith(sourceDir, expect.anything())
				},
			)

			it("should allow relative links that stay inside the skill and absolute links", async () => {
				setupCodeSkill()
				setupExdevRename()
				mockCp.mockResolvedValue(undefined)
				mockLstat.mockRejectedValue(enoentError())
				mockReaddir.mockImplementation(async (dir: string, options?: { withFileTypes?: boolean }) => {
					if (!options?.withFileTypes) return dir === sourceSkillsDir ? ["test-skill"] : []
					if (dir === getStagingDir()) return [dirent("docs", "dir"), dirent("abs", "link")]
					if (dir === p(getStagingDir(), "docs")) return [dirent("inner", "link")]
					return []
				})
				mockReadlink.mockImplementation(async (link: string) =>
					link.endsWith("abs") ? p(SHARED_DIR, "f") : p("..", "SKILL.md"),
				)

				await skillsManager.discoverSkills()
				await skillsManager.moveSkill("test-skill", "global", "code", "architect")

				expect(mockReadlink).toHaveBeenCalledTimes(2)
				expect(mockRename).toHaveBeenLastCalledWith(getStagingDir(), destDir)
			})

			it("should rethrow non-EXDEV rename errors without copying", async () => {
				setupCodeSkill()
				mockRename.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

				await skillsManager.discoverSkills()
				await expect(skillsManager.moveSkill("test-skill", "global", "code", "architect")).rejects.toThrow(
					"permission denied",
				)

				expect(mockCp).not.toHaveBeenCalled()
			})

			it("should not remove a symlinked skills directory after moving its last skill out", async () => {
				// skills-code -> /shared/skills
				const sharedSkillDir = p(SHARED_DIR, "test-skill")
				mockDirectoryExists.mockImplementation(async (dir: string) => dir === sourceSkillsDir)
				mockRealpath.mockImplementation(async (pathArg: string) =>
					pathArg === sourceSkillsDir ? SHARED_DIR : pathArg,
				)
				let discovering = true
				mockReaddir.mockImplementation(async (dir: string) =>
					dir === SHARED_DIR && discovering ? ["test-skill"] : [],
				)
				mockStat.mockImplementation(async (pathArg: string) => {
					if (pathArg === sharedSkillDir) return { isDirectory: () => true }
					throw enoent()
				})
				mockSymlinks(sourceSkillsDir)
				mockFileExists.mockImplementation(async (file: string) => file === p(sharedSkillDir, "SKILL.md"))
				mockReadFile.mockResolvedValue(`---
name: test-skill
description: A test skill
---
Instructions`)
				mockMkdir.mockResolvedValue(undefined)
				mockRename.mockResolvedValue(undefined)
				mockRmdir.mockResolvedValue(undefined)

				await skillsManager.discoverSkills()
				discovering = false
				await skillsManager.moveSkill("test-skill", "global", "code", "architect")

				expect(mockRename).toHaveBeenCalledWith(sharedSkillDir, destDir)
				expect(mockRmdir).not.toHaveBeenCalled()
			})
		})
	})
})
