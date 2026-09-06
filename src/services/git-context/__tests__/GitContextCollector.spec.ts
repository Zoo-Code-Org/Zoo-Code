import * as os from "os"
import * as path from "path"
import { EventEmitter } from "events"
import { promises as fs } from "fs"
import { spawn } from "child_process"

import { GitContextCollector } from "../GitContextCollector"

vi.mock("child_process", () => ({
	spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(spawn)
const workspaceRoot = path.resolve("/repo")
const requiredContextOnly = { includeBranch: false, recentCommits: { include: false } }

/** Queues a mocked Git subprocess response for the next spawn call. */
function mockGitCommand(stdout: string, stderr = "", code = 0) {
	mockSpawn.mockImplementationOnce((() => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
			stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
		}

		child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
		child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })

		queueMicrotask(() => {
			if (stdout) {
				child.stdout.emit("data", stdout)
			}

			if (stderr) {
				child.stderr.emit("data", stderr)
			}

			child.emit("close", code)
		})

		return child
	}) as unknown as typeof spawn)
}

describe("GitContextCollector", () => {
	beforeEach(() => {
		mockSpawn.mockReset()
	})

	it("parses staged name-status output including renames and copies", async () => {
		mockGitCommand(
			["M", "src/file.ts", "R100", "src/old.ts", "src/new.ts", "C075", "src/a.ts", "src/b.ts", ""].join("\0"),
		)

		const collector = new GitContextCollector(workspaceRoot)
		const changes = await collector.gatherChanges({ staged: true })

		expect(mockSpawn).toHaveBeenCalledWith(
			"git",
			["diff", "--name-status", "--cached", "-z"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(changes).toEqual([
			{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true },
			{
				filePath: path.join(workspaceRoot, "src/new.ts"),
				oldFilePath: path.join(workspaceRoot, "src/old.ts"),
				status: "R",
				staged: true,
			},
			{
				filePath: path.join(workspaceRoot, "src/b.ts"),
				oldFilePath: path.join(workspaceRoot, "src/a.ts"),
				status: "C",
				staged: true,
			},
		])
	})

	it("parses staged paths with spaces, special characters, and deleted status", async () => {
		mockGitCommand(["M", "src/file with spaces.ts", "D", "src/old'file.ts", ""].join("\0"))

		const collector = new GitContextCollector(workspaceRoot)
		const changes = await collector.gatherChanges({ staged: true })

		expect(mockSpawn).toHaveBeenCalledWith(
			"git",
			["diff", "--name-status", "--cached", "-z"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(changes).toEqual([
			{ filePath: path.join(workspaceRoot, "src/file with spaces.ts"), status: "M", staged: true },
			{ filePath: path.join(workspaceRoot, "src/old'file.ts"), status: "D", staged: true },
		])
	})

	it("requests all untracked files instead of collapsed untracked directories", async () => {
		mockGitCommand(["?? src/new.ts", ""].join("\0"))

		const collector = new GitContextCollector(workspaceRoot)
		const changes = await collector.gatherChanges({ staged: false })

		expect(mockSpawn).toHaveBeenCalledWith(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(changes).toEqual([{ filePath: path.join(workspaceRoot, "src/new.ts"), status: "?", staged: false }])
	})

	it("ignores staged-only entries when gathering unstaged changes", async () => {
		mockGitCommand(["M  src/staged.ts", ""].join("\0"))

		const collector = new GitContextCollector(workspaceRoot)
		const changes = await collector.gatherChanges({ staged: false })

		expect(mockSpawn).toHaveBeenCalledWith(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(changes).toEqual([])
	})

	it("skips malformed staged name-status entries without reading past the output", async () => {
		mockGitCommand(["R100", "src/old.ts", ""].join("\0"))

		const collector = new GitContextCollector(workspaceRoot)
		const changes = await collector.gatherChanges({ staged: true })

		expect(changes).toEqual([])
	})

	it("keeps lockfiles in git context because git state is authoritative", async () => {
		mockGitCommand("1\t1\tpackage-lock.json\n")
		mockGitCommand("diff --git a/package-lock.json b/package-lock.json\n")

		const collector = new GitContextCollector(workspaceRoot)
		const context = await collector.getContext(
			[{ filePath: path.join(workspaceRoot, "package-lock.json"), status: "M", staged: true }],
			{ staged: true, ...requiredContextOnly },
		)

		expect(context).toContain("diff --git a/package-lock.json b/package-lock.json")
		expect(context).toContain("Modified (staged): package-lock.json")
	})

	it("can gather changes and collect context in one reusable call", async () => {
		mockGitCommand(["M", "src/file.ts", ""].join("\0"))
		mockGitCommand("1\t1\tsrc/file.ts\n")
		mockGitCommand("diff --git a/src/file.ts b/src/file.ts\n")

		const collector = new GitContextCollector(workspaceRoot)
		const result = await collector.collect({ staged: true, ...requiredContextOnly })

		expect(result.changes).toEqual([
			{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true },
		])
		expect(result.context).toContain("diff --git a/src/file.ts b/src/file.ts")
		expect(result.warnings).toEqual([])
	})

	it("uses requested diff context lines and includes diff stats", async () => {
		mockGitCommand("src/file.ts | 3 ++-\n")
		mockGitCommand("2\t1\tsrc/file.ts\n")
		mockGitCommand("diff --git a/src/file.ts b/src/file.ts\n")

		const collector = new GitContextCollector(workspaceRoot)
		const context = await collector.getContext(
			[{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true }],
			{ staged: true, ...requiredContextOnly, diff: { contextLines: 0, includeStats: true } },
		)

		expect(mockSpawn).toHaveBeenNthCalledWith(
			3,
			"git",
			["diff", "--cached", "--unified=0", "--", "src/file.ts"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(context).toContain("### Diff Stats")
		expect(context).toContain("src/file.ts | 3 ++-")
	})

	it("batches binary detection for tracked changes", async () => {
		mockGitCommand("-\t-\tsrc/image.png\n1\t1\tsrc/file.ts\n")
		mockGitCommand("diff --git a/src/file.ts b/src/file.ts\n")

		const collector = new GitContextCollector(workspaceRoot)
		const context = await collector.getContext(
			[
				{ filePath: path.join(workspaceRoot, "src/image.png"), status: "M", staged: true },
				{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true },
			],
			{ staged: true, ...requiredContextOnly },
		)

		expect(mockSpawn).toHaveBeenNthCalledWith(
			1,
			"git",
			["diff", "--cached", "--numstat", "--", "src/image.png", "src/file.ts"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(mockSpawn).toHaveBeenCalledTimes(2)
		expect(context).toContain("Binary file modified: src/image.png")
		expect(context).toContain("diff --git a/src/file.ts b/src/file.ts")
	})

	it("matches selected files by exact path or basename without suffix matching", async () => {
		mockGitCommand("1\t1\tsrc/test.ts\n")
		mockGitCommand("diff --git a/src/test.ts b/src/test.ts\n")

		const collector = new GitContextCollector(workspaceRoot)
		const context = await collector.getContext(
			[
				{ filePath: path.join(workspaceRoot, "src/mytest.ts"), status: "M", staged: true },
				{ filePath: path.join(workspaceRoot, "src/test.ts"), status: "M", staged: true },
			],
			{ staged: true, ...requiredContextOnly },
			["test.ts"],
		)

		expect(mockSpawn).toHaveBeenNthCalledWith(
			2,
			"git",
			["diff", "--cached", "--", "src/test.ts"],
			expect.objectContaining({ cwd: workspaceRoot }),
		)
		expect(context).toContain("Modified (staged): src/test.ts")
		expect(context).not.toContain("src/mytest.ts")
	})

	it("includes full new-file diffs for untracked text files", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-git-context-"))
		try {
			const filePath = path.join(tempRoot, "src", "new.ts")
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, "export const value = 1\n")

			const collector = new GitContextCollector(tempRoot)
			const context = await collector.getContext([{ filePath, status: "?", staged: false }], {
				staged: false,
				...requiredContextOnly,
			})

			expect(context).toContain("diff --git a/src/new.ts b/src/new.ts")
			expect(context).toContain("--- /dev/null")
			expect(context).toContain("+export const value = 1")
			expect(context).toContain("Untracked (unstaged): src/new.ts")
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("counts blank lines in untracked text file stats", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-git-context-"))
		try {
			const filePath = path.join(tempRoot, "src", "new.ts")
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, "first\n\nthird\n")

			const collector = new GitContextCollector(tempRoot)
			const context = await collector.getContext([{ filePath, status: "?", staged: false }], {
				staged: false,
				...requiredContextOnly,
				diff: { includeStats: true },
			})

			expect(context).toContain("src/new.ts | 3 +++")
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("summarizes untracked binary files without binary payload", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-git-context-"))
		try {
			const filePath = path.join(tempRoot, "image.bin")
			await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3]))

			const collector = new GitContextCollector(tempRoot)
			const context = await collector.getContext([{ filePath, status: "?", staged: false }], {
				staged: false,
				...requiredContextOnly,
			})

			expect(context).toContain("Binary file added: image.bin")
			expect(context).not.toContain("@@ -0,0")
			expect(context).toContain("Untracked (unstaged): image.bin")
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("fails required diff collection instead of emitting partial context", async () => {
		mockGitCommand("1\t1\tsrc/file.ts\n")
		mockGitCommand("", "fatal: bad revision", 128)

		const collector = new GitContextCollector(workspaceRoot)

		await expect(
			collector.getContext([{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true }], {
				staged: true,
				...requiredContextOnly,
			}),
		).rejects.toThrow("fatal: bad revision")
	})

	it("returns warnings when supplemental repository context is unavailable", async () => {
		mockGitCommand("1\t1\tsrc/file.ts\n")
		mockGitCommand("diff --git a/src/file.ts b/src/file.ts\n")
		mockGitCommand("", "fatal: branch unavailable", 128)
		mockGitCommand("", "fatal: log unavailable", 128)

		const collector = new GitContextCollector(workspaceRoot)
		const result = await collector.collectContext(
			[{ filePath: path.join(workspaceRoot, "src/file.ts"), status: "M", staged: true }],
			{ staged: true, includeBranch: true, recentCommits: { include: true } },
		)

		expect(result.warnings).toEqual([
			expect.stringContaining("Current branch unavailable"),
			expect.stringContaining("Recent commits unavailable"),
		])
		expect(result.context).toContain("### Git Context Warnings")
		expect(result.context).toContain("diff --git a/src/file.ts b/src/file.ts")
	})
})
