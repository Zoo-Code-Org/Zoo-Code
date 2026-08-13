import * as vscode from "vscode"
import * as path from "path"
import { promises as fs } from "fs"
import { exec, execFile } from "child_process"
import { promisify } from "util"

import type { GitRepositoryInfo, GitCommit } from "@roo-code/types"

import { truncateOutput } from "../integrations/misc/extract-text"

const execAsync = promisify(exec)

// Used for the commit-context commands: arguments are passed as an array, so no shell is
// involved and paths never need quoting.
const execFileAsync = promisify(execFile)

const GIT_OUTPUT_LINE_LIMIT = 500

// A line limit alone is not a bound: one minified or generated file can be a single line of
// several megabytes. This caps the payload regardless of how it is distributed across lines.
const GIT_OUTPUT_CHARACTER_LIMIT = 100 * 1024

// Node's default `exec` buffer is 1MB, which real-world diffs routinely exceed.
const GIT_DIFF_MAX_BUFFER = 10 * 1024 * 1024

// A commit message needs to know what changed, not every line of how. One line of surrounding
// context per hunk is enough to tell the model where an edit landed, and shrinking the prompt is
// the one latency factor we control without affecting the model's output.
const COMMIT_DIFF_ARGS = ["--unified=1"]

const RECENT_COMMIT_COUNT = 5

/**
 * Extracts git repository information from the workspace's .git directory
 * @param workspaceRoot The root path of the workspace
 * @returns Git repository information or empty object if not a git repository
 */
export async function getGitRepositoryInfo(workspaceRoot: string): Promise<GitRepositoryInfo> {
	try {
		const gitDir = path.join(workspaceRoot, ".git")

		// Check if .git directory exists
		try {
			await fs.access(gitDir)
		} catch {
			// Not a git repository
			return {}
		}

		const gitInfo: GitRepositoryInfo = {}

		// Try to read git config file
		try {
			const configPath = path.join(gitDir, "config")
			const configContent = await fs.readFile(configPath, "utf8")

			// Very simple approach - just find any URL line
			const urlMatch = configContent.match(/url\s*=\s*(.+?)(?:\r?\n|$)/m)

			if (urlMatch && urlMatch[1]) {
				const url = urlMatch[1].trim()
				// Sanitize the URL and convert to HTTPS format for telemetry
				gitInfo.repositoryUrl = convertGitUrlToHttps(sanitizeGitUrl(url))
				const repositoryName = extractRepositoryName(url)
				if (repositoryName) {
					gitInfo.repositoryName = repositoryName
				}
			}

			// Extract default branch (if available)
			const branchMatch = configContent.match(/\[branch "([^"]+)"\]/i)
			if (branchMatch && branchMatch[1]) {
				gitInfo.defaultBranch = branchMatch[1]
			}
		} catch (error) {
			// Ignore config reading errors
		}

		// Try to read HEAD file to get current branch
		if (!gitInfo.defaultBranch) {
			try {
				const headPath = path.join(gitDir, "HEAD")
				const headContent = await fs.readFile(headPath, "utf8")
				const branchMatch = headContent.match(/ref: refs\/heads\/(.+)/)
				if (branchMatch && branchMatch[1]) {
					gitInfo.defaultBranch = branchMatch[1].trim()
				}
			} catch (error) {
				// Ignore HEAD reading errors
			}
		}

		return gitInfo
	} catch (error) {
		// Return empty object on any error
		return {}
	}
}

/**
 * Converts a git URL to HTTPS format
 * @param url The git URL to convert
 * @returns The URL in HTTPS format, or the original URL if conversion is not possible
 */
export function convertGitUrlToHttps(url: string): string {
	try {
		// Already HTTPS, just return it
		if (url.startsWith("https://")) {
			return url
		}

		// Handle SSH format: git@github.com:user/repo.git -> https://github.com/user/repo.git
		if (url.startsWith("git@")) {
			const match = url.match(/git@([^:]+):(.+)/)
			if (match && match.length === 3) {
				const [, host, path] = match
				return `https://${host}/${path}`
			}
		}

		// Handle SSH with protocol: ssh://git@github.com/user/repo.git -> https://github.com/user/repo.git
		if (url.startsWith("ssh://")) {
			const match = url.match(/ssh:\/\/(?:git@)?([^\/]+)\/(.+)/)
			if (match && match.length === 3) {
				const [, host, path] = match
				return `https://${host}/${path}`
			}
		}

		// Return original URL if we can't convert it
		return url
	} catch {
		// If parsing fails, return original
		return url
	}
}

/**
 * Sanitizes a git URL to remove sensitive information like tokens
 * @param url The original git URL
 * @returns Sanitized URL
 */
export function sanitizeGitUrl(url: string): string {
	try {
		// Remove credentials from HTTPS URLs
		if (url.startsWith("https://")) {
			const urlObj = new URL(url)
			// Remove username and password
			urlObj.username = ""
			urlObj.password = ""
			return urlObj.toString()
		}

		// For SSH URLs, return as-is (they don't contain sensitive tokens)
		if (url.startsWith("git@") || url.startsWith("ssh://")) {
			return url
		}

		// For other formats, return as-is but remove any potential tokens
		return url.replace(/:[a-f0-9]{40,}@/gi, "@")
	} catch {
		// If URL parsing fails, return original (might be SSH format)
		return url
	}
}

/**
 * Extracts repository name from a git URL
 * @param url The git URL
 * @returns Repository name or undefined
 */
export function extractRepositoryName(url: string): string {
	try {
		// Handle different URL formats
		const patterns = [
			// HTTPS: https://github.com/user/repo.git -> user/repo
			/https:\/\/[^\/]+\/([^\/]+\/[^\/]+?)(?:\.git)?$/,
			// SSH: git@github.com:user/repo.git -> user/repo
			/git@[^:]+:([^\/]+\/[^\/]+?)(?:\.git)?$/,
			// SSH with user: ssh://git@github.com/user/repo.git -> user/repo
			/ssh:\/\/[^\/]+\/([^\/]+\/[^\/]+?)(?:\.git)?$/,
		]

		for (const pattern of patterns) {
			const match = url.match(pattern)
			if (match && match[1]) {
				return match[1].replace(/\.git$/, "")
			}
		}

		return ""
	} catch {
		return ""
	}
}

/**
 * Gets git repository information for the current VSCode workspace
 * @returns Git repository information or empty object if not available
 */
export async function getWorkspaceGitInfo(): Promise<GitRepositoryInfo> {
	const workspaceFolders = vscode.workspace.workspaceFolders
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return {}
	}

	// Use the first workspace folder.
	const workspaceRoot = workspaceFolders[0].uri.fsPath
	return getGitRepositoryInfo(workspaceRoot)
}

async function checkGitRepo(cwd: string): Promise<boolean> {
	try {
		await execAsync("git rev-parse --git-dir", { cwd })
		return true
	} catch (error) {
		return false
	}
}

/**
 * Checks if Git is installed on the system by attempting to run git --version
 * @returns {Promise<boolean>} True if Git is installed and accessible, false otherwise
 * @example
 * const isGitInstalled = await checkGitInstalled();
 * if (!isGitInstalled) {
 *   console.log("Git is not installed");
 * }
 */
export async function checkGitInstalled(): Promise<boolean> {
	try {
		await execAsync("git --version")
		return true
	} catch (error) {
		return false
	}
}

export async function searchCommits(query: string, cwd: string): Promise<GitCommit[]> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			console.error("Git is not installed")
			return []
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			console.error("Not a git repository")
			return []
		}

		// Search commits by hash or message, limiting to 10 results
		const { stdout } = await execAsync(
			`git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short ` + `--grep="${query}" --regexp-ignore-case`,
			{ cwd },
		)

		let output = stdout
		if (!output.trim() && /^[a-f0-9]+$/i.test(query)) {
			// If no results from grep search and query looks like a hash, try searching by hash
			const { stdout: hashStdout } = await execAsync(
				`git log -n 10 --format="%H%n%h%n%s%n%an%n%ad" --date=short ` + `--author-date-order ${query}`,
				{ cwd },
			).catch(() => ({ stdout: "" }))

			if (!hashStdout.trim()) {
				return []
			}

			output = hashStdout
		}

		const commits: GitCommit[] = []
		const lines = output
			.trim()
			.split("\n")
			.filter((line) => line !== "--")

		for (let i = 0; i < lines.length; i += 5) {
			commits.push({
				hash: lines[i],
				shortHash: lines[i + 1],
				subject: lines[i + 2],
				author: lines[i + 3],
				date: lines[i + 4],
			})
		}

		return commits
	} catch (error) {
		console.error("Error searching commits:", error)
		return []
	}
}

export async function getCommitInfo(hash: string, cwd: string): Promise<string> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			return "Git is not installed"
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			return "Not a git repository"
		}

		// Get commit info, stats, and diff separately
		const { stdout: info } = await execAsync(`git show --format="%H%n%h%n%s%n%an%n%ad%n%b" --no-patch ${hash}`, {
			cwd,
		})
		const [fullHash, shortHash, subject, author, date, body] = info.trim().split("\n")

		const { stdout: stats } = await execAsync(`git show --stat --format="" ${hash}`, { cwd })

		const { stdout: diff } = await execAsync(`git show --format="" ${hash}`, { cwd })

		const summary = [
			`Commit: ${shortHash} (${fullHash})`,
			`Author: ${author}`,
			`Date: ${date}`,
			`\nMessage: ${subject}`,
			body ? `\nDescription:\n${body}` : "",
			"\nFiles Changed:",
			stats.trim(),
			"\nFull Changes:",
		].join("\n")

		const output = summary + "\n\n" + diff.trim()
		return truncateOutput(output, GIT_OUTPUT_LINE_LIMIT)
	} catch (error) {
		console.error("Error getting commit info:", error)
		return `Failed to get commit info: ${error instanceof Error ? error.message : String(error)}`
	}
}

export async function getWorkingState(cwd: string): Promise<string> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			return "Git is not installed"
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			return "Not a git repository"
		}

		// Get status of working directory
		const { stdout: status } = await execAsync("git status --short", { cwd })
		if (!status.trim()) {
			return "No changes in working directory"
		}

		// Get all changes (both staged and unstaged) compared to HEAD
		const { stdout: diff } = await execAsync("git diff HEAD", { cwd })
		const lineLimit = GIT_OUTPUT_LINE_LIMIT
		const output = `Working directory changes:\n\n${status}\n\n${diff}`.trim()
		return truncateOutput(output, lineLimit)
	} catch (error) {
		console.error("Error getting working state:", error)
		return `Failed to get working state: ${error instanceof Error ? error.message : String(error)}`
	}
}

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown"

export interface GitFileChange {
	status: GitFileStatus
	/** Path relative to the repository root, exactly as git reported it. */
	path: string
	/** Where the file came from. Only set for renames and copies. */
	oldPath?: string
}

export interface CommitContext {
	/** Undefined when HEAD is detached. */
	branch?: string
	recentCommits: string[]
	files: GitFileChange[]
	/** The staged diff, truncated to fit a prompt. */
	diff: string
}

export type CommitContextResult =
	| { ok: true; context: CommitContext }
	| { ok: false; reason: "git-missing" | "not-a-repo" | "no-changes" | "nothing-staged" | "failed"; error?: string }

async function runGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: GIT_DIFF_MAX_BUFFER })
	return stdout
}

function toFileStatus(code: string): GitFileStatus {
	switch (code) {
		case "A":
			return "added"
		case "M":
			return "modified"
		case "D":
			return "deleted"
		case "R":
			return "renamed"
		case "C":
			return "copied"
		case "?":
			return "untracked"
		default:
			return "unknown"
	}
}

/**
 * Parses `git diff --name-status -z`: a NUL-terminated status field followed by one path, or -
 * for renames and copies - by two paths, the original first.
 *
 * Copy records appear whenever the user has `diff.renames = copies` configured, so they have to
 * be consumed correctly even though we never ask for copy detection: reading one path where
 * there are two would shift every later record onto the wrong file.
 */
function parseNameStatus(stdout: string): GitFileChange[] {
	const fields = stdout.split("\0")
	const files: GitFileChange[] = []

	for (let index = 0; index < fields.length; index++) {
		const code = fields[index]

		// The final NUL leaves an empty trailing field.
		if (!code) {
			continue
		}

		const status = toFileStatus(code[0])
		const first = fields[++index]

		if (status === "renamed" || status === "copied") {
			const second = fields[++index]

			if (!first || !second) {
				break
			}

			files.push({ status, path: second, oldPath: first })
			continue
		}

		if (!first) {
			break
		}

		files.push({ status, path: first })
	}

	return files
}

/**
 * Parses `git status --porcelain=v1 -z`: `XY<space><path>`, with renames and copies adding the
 * original path as a second NUL-terminated field.
 *
 * Note the field order is the reverse of `git diff --name-status -z` - here the new path comes
 * first. Both formats are NUL-delimited, so paths are emitted verbatim and never quoted.
 */
function parsePorcelainStatus(stdout: string): GitFileChange[] {
	const records = stdout.split("\0")
	const files: GitFileChange[] = []

	for (let index = 0; index < records.length; index++) {
		const record = records[index]

		// The shortest valid record is two status characters, a space and a single-character path.
		if (record.length < 4) {
			continue
		}

		const indexCode = record[0]
		const worktreeCode = record[1]
		const filePath = record.slice(3)

		// The index takes precedence, since that is what a commit would contain.
		const status = toFileStatus(indexCode === " " ? worktreeCode : indexCode)

		if (status === "renamed" || status === "copied") {
			files.push({ status, path: filePath, oldPath: records[++index] })
			continue
		}

		files.push({ status, path: filePath })
	}

	return files
}

/** Both of these are context, not the payload, so a repository without commits still works. */
async function getCurrentBranch(cwd: string): Promise<string | undefined> {
	const branch = await runGit(["branch", "--show-current"], cwd).catch(() => "")
	return branch.trim() || undefined
}

async function getRecentCommits(cwd: string): Promise<string[]> {
	const log = await runGit(["log", `-n${RECENT_COMMIT_COUNT}`, "--format=%s"], cwd).catch(() => "")
	return log
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

/**
 * Collects the changes to describe in a commit message.
 *
 * Only the index is described, since that is exactly what a commit will contain. An empty index
 * returns `nothing-staged` rather than falling back to the working tree, so the message can never
 * describe changes the commit would not include.
 *
 * Every command runs through `execFile` with an argument array, so no path is ever interpolated
 * into a shell string, and every listing is read in NUL-delimited form.
 *
 * @param cwd The repository root to inspect
 * @returns The collected context, or the reason there is none. Never rejects.
 */
export async function getCommitContext(cwd: string): Promise<CommitContextResult> {
	if (!(await checkGitInstalled())) {
		return { ok: false, reason: "git-missing" }
	}

	if (!(await checkGitRepo(cwd))) {
		return { ok: false, reason: "not-a-repo" }
	}

	try {
		const staged = parseNameStatus(await runGit(["diff", "--cached", "--name-status", "-z"], cwd))

		if (staged.length > 0) {
			const diff = await runGit(["diff", "--cached", ...COMMIT_DIFF_ARGS], cwd)
			return { ok: true, context: await buildContext(cwd, staged, diff) }
		}

		// Only the index is described, so an empty one has nothing to summarize. Whether the
		// working tree is dirty decides which of the two messages the caller shows: "stage
		// something first" is only useful advice when there is in fact something to stage.
		const worktree = parsePorcelainStatus(
			await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd),
		)

		return { ok: false, reason: worktree.length > 0 ? "nothing-staged" : "no-changes" }
	} catch (error) {
		// Failures here are expected rather than exceptional - an oversized diff exceeding
		// `maxBuffer`, a repository in a state git refuses to describe - so the caller gets a
		// reason rather than a rejection.
		return { ok: false, reason: "failed", error: error instanceof Error ? error.message : String(error) }
	}
}

async function buildContext(cwd: string, files: GitFileChange[], diff: string): Promise<CommitContext> {
	return {
		branch: await getCurrentBranch(cwd),
		recentCommits: await getRecentCommits(cwd),
		files,
		diff: truncateOutput(diff.trim(), GIT_OUTPUT_LINE_LIMIT, GIT_OUTPUT_CHARACTER_LIMIT),
	}
}

/**
 * Gets git status output with configurable file limit
 * @param cwd The working directory to check git status in
 * @param maxFiles Maximum number of file entries to include (0 = disabled)
 * @returns Git status string or null if not a git repository
 */
export async function getGitStatus(cwd: string, maxFiles: number = 20): Promise<string | null> {
	try {
		const isInstalled = await checkGitInstalled()
		if (!isInstalled) {
			return null
		}

		const isRepo = await checkGitRepo(cwd)
		if (!isRepo) {
			return null
		}

		// Use porcelain v1 format with branch info
		const { stdout } = await execAsync("git status --porcelain=v1 --branch", { cwd })

		if (!stdout.trim()) {
			return null
		}

		const lines = stdout.trim().split("\n")

		// First line is always branch info (e.g., "## main...origin/main")
		const branchLine = lines[0]
		const fileLines = lines.slice(1)

		// Build output with branch info and limited file entries
		const output: string[] = [branchLine]

		if (maxFiles > 0 && fileLines.length > 0) {
			const filesToShow = fileLines.slice(0, maxFiles)
			output.push(...filesToShow)

			// Add truncation notice if needed
			if (fileLines.length > maxFiles) {
				output.push(`... ${fileLines.length - maxFiles} more files`)
			}
		}

		return output.join("\n")
	} catch (error) {
		console.error("Error getting git status:", error)
		return null
	}
}
