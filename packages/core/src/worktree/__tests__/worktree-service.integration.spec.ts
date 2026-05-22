import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { WorktreeService } from "../worktree-service.js"

const execFileAsync = promisify(execFile)

async function execGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" })
	return stdout
}

describe.sequential("WorktreeService integration", () => {
	let service: WorktreeService
	let tempDir: string
	let repoDir: string
	let baseBranch: string

	beforeEach(async () => {
		service = new WorktreeService()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-service-integration-test-"))
		repoDir = path.join(tempDir, "repo")
		await fs.mkdir(repoDir, { recursive: true })

		await execGit(repoDir, ["init"])
		await execGit(repoDir, ["config", "user.name", "Test User"])
		await execGit(repoDir, ["config", "user.email", "test@example.com"])
		await fs.writeFile(path.join(repoDir, "README.md"), "base")
		await execGit(repoDir, ["add", "README.md"])
		await execGit(repoDir, ["commit", "-m", "init"])

		baseBranch = (await execGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
	})

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	it("should create and delete a worktree for a new branch", async () => {
		const worktreePath = path.join(tempDir, "feature-worktree")

		const createResult = await service.createWorktree(repoDir, {
			path: worktreePath,
			branch: "feature/integration",
			baseBranch,
			createNewBranch: true,
		})

		expect(createResult.success).toBe(true)
		const worktrees = await service.listWorktrees(repoDir)
		const createdWorktree = worktrees.find((worktree) => worktree.branch === "feature/integration")

		expect(createdWorktree?.branch).toBe("feature/integration")

		const readmeExists = await fs
			.access(path.join(worktreePath, "README.md"))
			.then(() => true)
			.catch(() => false)
		expect(readmeExists).toBe(true)

		expect(worktrees.some((worktree) => worktree.branch === "feature/integration")).toBe(true)

		const deleteResult = await service.deleteWorktree(repoDir, worktreePath)

		expect(deleteResult.success).toBe(true)

		const deletedWorktreeExists = await fs
			.access(worktreePath)
			.then(() => true)
			.catch(() => false)
		expect(deletedWorktreeExists).toBe(false)

		const remainingWorktrees = await service.listWorktrees(repoDir)
		expect(remainingWorktrees.some((worktree) => worktree.branch === "feature/integration")).toBe(false)
	}, 30_000)

	it("should exclude worktree branches from available branches unless requested", async () => {
		const worktreePath = path.join(tempDir, "feature-worktree")

		const createResult = await service.createWorktree(repoDir, {
			path: worktreePath,
			branch: "feature/excluded",
			baseBranch,
			createNewBranch: true,
		})

		expect(createResult.success).toBe(true)

		const availableBranches = await service.getAvailableBranches(repoDir)
		expect(availableBranches.localBranches).not.toContain("feature/excluded")

		const allBranches = await service.getAvailableBranches(repoDir, true)
		expect(allBranches.localBranches).toContain("feature/excluded")
	}, 30_000)
})
