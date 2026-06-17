import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { WorktreeIncludeService } from "../worktree-include.js"

const execFileAsync = promisify(execFile)

async function execGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" })
	return stdout
}

describe.sequential("WorktreeIncludeService integration", () => {
	let service: WorktreeIncludeService
	let tempDir: string

	beforeEach(async () => {
		service = new WorktreeIncludeService()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-integration-test-"))
	})

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("branchHasWorktreeInclude", () => {
		it("should detect .worktreeinclude on the specified branch", async () => {
			const repoDir = path.join(tempDir, "repo")
			await fs.mkdir(repoDir, { recursive: true })

			await execGit(repoDir, ["init"])
			await execGit(repoDir, ["config", "user.name", "Test User"])
			await execGit(repoDir, ["config", "user.email", "test@example.com"])
			await execGit(repoDir, ["config", "commit.gpgSign", "false"])

			await fs.writeFile(path.join(repoDir, "README.md"), "test")
			await execGit(repoDir, ["add", "README.md"])
			await execGit(repoDir, ["commit", "-m", "init"])

			const baseBranch = (await execGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()

			expect(await service.branchHasWorktreeInclude(repoDir, baseBranch)).toBe(false)

			await execGit(repoDir, ["checkout", "-b", "with-include"])
			await fs.writeFile(path.join(repoDir, ".worktreeinclude"), "node_modules")
			await execGit(repoDir, ["add", ".worktreeinclude"])
			await execGit(repoDir, ["commit", "-m", "add include"])

			expect(await service.branchHasWorktreeInclude(repoDir, "with-include")).toBe(true)
		}, 30_000)
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

		it("should copy files that match both patterns", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })
			await fs.writeFile(path.join(sourceDir, "node_modules", "package.json"), '{"name": "test"}')

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toContain("node_modules")
			const copiedContent = await fs.readFile(path.join(targetDir, "node_modules", "package.json"), "utf-8")
			expect(copiedContent).toBe('{"name": "test"}')
		})

		it("should only copy intersection of patterns", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules\ndist")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules\n.env")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })
			await fs.mkdir(path.join(sourceDir, "dist"), { recursive: true })
			await fs.writeFile(path.join(sourceDir, ".env"), "SECRET=123")
			await fs.writeFile(path.join(sourceDir, "node_modules", "test.txt"), "test")
			await fs.writeFile(path.join(sourceDir, "dist", "main.js"), "console.log('dist')")

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toContain("node_modules")
			expect(result).not.toContain("dist")
			expect(result).not.toContain(".env")

			const nodeModulesExists = await fs
				.access(path.join(targetDir, "node_modules"))
				.then(() => true)
				.catch(() => false)
			expect(nodeModulesExists).toBe(true)

			const distExists = await fs
				.access(path.join(targetDir, "dist"))
				.then(() => true)
				.catch(() => false)
			expect(distExists).toBe(false)
		})

		it("should skip .git directory", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), ".git")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), ".git")
			await fs.mkdir(path.join(sourceDir, ".git"), { recursive: true })
			await fs.writeFile(path.join(sourceDir, ".git", "config"), "[core]")

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).not.toContain(".git")
		})

		it("should ignore comment lines in pattern files", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "# comment\nnode_modules\n# another comment")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toContain("node_modules")
		})

		it("should call progress callback with bytesCopied progress", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules\n.env.local")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules\n.env.local")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })
			await fs.writeFile(path.join(sourceDir, "node_modules", "test.txt"), "test")
			await fs.writeFile(path.join(sourceDir, ".env.local"), "LOCAL_VAR=value")

			const progressCalls: Array<{ bytesCopied: number; itemName: string }> = []
			const onProgress = vi.fn((progress: { bytesCopied: number; itemName: string }) => {
				progressCalls.push({ ...progress })
			})

			await service.copyWorktreeIncludeFiles(sourceDir, targetDir, onProgress)

			expect(onProgress).toHaveBeenCalled()
			expect(progressCalls.length).toBeGreaterThan(0)
			const finalCall = progressCalls[progressCalls.length - 1]
			expect(finalCall?.bytesCopied).toBeGreaterThan(0)
			expect(progressCalls.every((p) => typeof p.itemName === "string")).toBe(true)
		})

		it("should not fail when progress callback is not provided", async () => {
			await fs.writeFile(path.join(sourceDir, ".worktreeinclude"), "node_modules")
			await fs.writeFile(path.join(sourceDir, ".gitignore"), "node_modules")
			await fs.mkdir(path.join(sourceDir, "node_modules"), { recursive: true })

			const result = await service.copyWorktreeIncludeFiles(sourceDir, targetDir)

			expect(result).toContain("node_modules")
		})
	})
})
