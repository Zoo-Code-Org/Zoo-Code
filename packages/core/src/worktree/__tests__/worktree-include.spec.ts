import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { WorktreeIncludeService } from "../worktree-include.js"

describe("WorktreeIncludeService", () => {
	let service: WorktreeIncludeService
	let tempDir: string

	beforeEach(async () => {
		service = new WorktreeIncludeService()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-test-"))
	})

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("hasWorktreeInclude", () => {
		it("should return true when .worktreeinclude exists", async () => {
			await fs.writeFile(path.join(tempDir, ".worktreeinclude"), "node_modules")

			const result = await service.hasWorktreeInclude(tempDir)

			expect(result).toBe(true)
		})

		it("should return false when .worktreeinclude does not exist", async () => {
			const result = await service.hasWorktreeInclude(tempDir)

			expect(result).toBe(false)
		})

		it("should return false for non-existent directory", async () => {
			const result = await service.hasWorktreeInclude("/non/existent/path")

			expect(result).toBe(false)
		})
	})

	describe("getStatus", () => {
		it("should return correct status when both files exist", async () => {
			const gitignoreContent = "node_modules\n.env\ndist"
			await fs.writeFile(path.join(tempDir, ".worktreeinclude"), "node_modules")
			await fs.writeFile(path.join(tempDir, ".gitignore"), gitignoreContent)

			const result = await service.getStatus(tempDir)

			expect(result.exists).toBe(true)
			expect(result.hasGitignore).toBe(true)
			expect(result.gitignoreContent).toBe(gitignoreContent)
		})

		it("should return correct status when only .gitignore exists", async () => {
			const gitignoreContent = "node_modules\n.env"
			await fs.writeFile(path.join(tempDir, ".gitignore"), gitignoreContent)

			const result = await service.getStatus(tempDir)

			expect(result.exists).toBe(false)
			expect(result.hasGitignore).toBe(true)
			expect(result.gitignoreContent).toBe(gitignoreContent)
		})

		it("should return correct status when only .worktreeinclude exists", async () => {
			await fs.writeFile(path.join(tempDir, ".worktreeinclude"), "node_modules")

			const result = await service.getStatus(tempDir)

			expect(result.exists).toBe(true)
			expect(result.hasGitignore).toBe(false)
			expect(result.gitignoreContent).toBeUndefined()
		})

		it("should return correct status when neither file exists", async () => {
			const result = await service.getStatus(tempDir)

			expect(result.exists).toBe(false)
			expect(result.hasGitignore).toBe(false)
			expect(result.gitignoreContent).toBeUndefined()
		})
	})

	describe("createWorktreeInclude", () => {
		it("should create .worktreeinclude file with specified content", async () => {
			const content = "node_modules\n.env\ndist"

			await service.createWorktreeInclude(tempDir, content)

			const fileContent = await fs.readFile(path.join(tempDir, ".worktreeinclude"), "utf-8")
			expect(fileContent).toBe(content)
		})

		it("should overwrite existing .worktreeinclude file", async () => {
			await fs.writeFile(path.join(tempDir, ".worktreeinclude"), "old content")
			const newContent = "new content"

			await service.createWorktreeInclude(tempDir, newContent)

			const fileContent = await fs.readFile(path.join(tempDir, ".worktreeinclude"), "utf-8")
			expect(fileContent).toBe(newContent)
		})
	})

	describe("copyWorktreeIncludeFiles", () => {
		let sourceDir: string
		let targetDir: string

		beforeEach(async () => {
			sourceDir = path.join(tempDir, "source")
			targetDir = path.join(tempDir, "target")
			await fs.mkdir(sourceDir, { recursive: true })
			await fs.mkdir(targetDir, { recursive: true })
		})

		it("should return empty array when no .worktreeinclude exists", async () => {
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules")

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toEqual([])
		})

		it("should return empty array when no .gitignore exists", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules")

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toEqual([])
		})

		it("should return empty array when patterns do not match", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), ".env")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toEqual([])
		})

		it("should copy single files", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), ".env.local")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), ".env.local")
			await fs.writeFile(path.join(sourceDir, ".env.local"), "LOCAL_VAR=value")

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toContain(".env.local")
			const copiedContent = await fs.readFile(path.join(targetDir, ".env.local"), "utf-8")
			expect(copiedContent).toBe("LOCAL_VAR=value")
		})
	})
})
