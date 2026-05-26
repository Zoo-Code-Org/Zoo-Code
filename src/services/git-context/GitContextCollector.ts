import * as path from "path"
import { promises as fs } from "fs"
import { spawn } from "child_process"
import type {
	GitContextCollection,
	GitContextCollectorOptions,
	GitChange,
	GitDiffContextOptions,
	GitContextOptions,
	GitRecentCommitContextOptions,
	GitContextResult,
	GitStatus,
} from "./types"

const DEFAULT_RECENT_COMMIT_COUNT = 5
const DEFAULT_RECENT_COMMIT_DIFF_COUNT = 1

/** Collects Git status, diff, and repository metadata for commit-message generation. */
export class GitContextCollector {
	/** Creates a collector scoped to one workspace repository root. */
	constructor(private workspaceRoot: string) {}

	/** Returns changed files from staged or unstaged Git state. */
	public async gatherChanges(options: GitContextCollectorOptions): Promise<GitChange[]> {
		const statusOutput = await this.getStatus(options)
		if (!statusOutput) {
			return []
		}

		return options.staged ? this.parseNameStatus(statusOutput, true) : this.parsePorcelainStatus(statusOutput)
	}

	/** Gathers changes and formats their Git context in one call. */
	public async collect(options: GitContextCollectorOptions, specificFiles?: string[]): Promise<GitContextCollection> {
		const changes = await this.gatherChanges(options)
		const result = await this.collectContext(changes, options, specificFiles)

		return { ...result, changes }
	}

	/** Runs a Git subprocess in the workspace root and returns stdout. */
	private async runGit(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", args, {
				cwd: this.workspaceRoot,
				stdio: ["ignore", "pipe", "pipe"],
			})
			let stdout = ""
			let stderr = ""

			child.stdout.setEncoding("utf8")
			child.stderr.setEncoding("utf8")
			child.stdout.on("data", (chunk) => (stdout += chunk))
			child.stderr.on("data", (chunk) => (stderr += chunk))
			child.on("error", reject)
			child.on("close", (code) => {
				if (code === 0) {
					resolve(stdout)
					return
				}

				reject(new Error(`Git command failed (${args.join(" ")}): ${stderr.trim() || `exit code ${code}`}`))
			})
		})
	}

	/** Builds full diff text for tracked, untracked, and binary changes. */
	private async getDiffForChanges(changes: GitChange[], options: GitContextCollectorOptions): Promise<string> {
		options.onProgress?.(0)
		if (changes.length === 0) {
			options.onProgress?.(100)
			return ""
		}

		const binaryChanges = await this.findBinaryChanges(changes, options.staged)
		options.onProgress?.(25)
		const diffableChanges = changes.filter((change) => change.status !== "?" && !binaryChanges.has(change.filePath))
		const untrackedFiles = changes.filter((change) => change.status === "?")
		const parts: string[] = []

		if (diffableChanges.length > 0) {
			const diffArgs = this.buildDiffArgs(options.staged, diffableChanges, [], options.diff)
			const diff = await this.runGit(diffArgs)
			if (diff.trim()) {
				parts.push(diff)
			}
		}
		options.onProgress?.(65)

		if (untrackedFiles.length > 0) {
			parts.push(await this.getUntrackedFileDiffs(untrackedFiles))
		}
		options.onProgress?.(85)

		if (binaryChanges.size > 0) {
			parts.push(
				changes
					.filter((change) => binaryChanges.has(change.filePath))
					.map(
						(change) =>
							`Binary file ${this.getReadableStatus(change.status).toLowerCase()}: ${this.getRelativePath(change.filePath)}`,
					)
					.join("\n"),
			)
		}

		options.onProgress?.(100)
		return parts.join("\n")
	}

	/** Builds diff-stat text for tracked changes and synthesized untracked files. */
	private async getDiffStats(changes: GitChange[], options: GitContextCollectorOptions): Promise<string> {
		const trackedChanges = changes.filter((change) => change.status !== "?")
		const untrackedChanges = changes.filter((change) => change.status === "?")
		const parts: string[] = []

		if (trackedChanges.length > 0) {
			const args = this.buildDiffArgs(options.staged, trackedChanges, ["--stat"])
			const stats = await this.runGit(args)
			if (stats.trim()) {
				parts.push(stats.trim())
			}
		}

		for (const change of untrackedChanges) {
			parts.push(await this.getUntrackedFileStat(change))
		}

		return parts.join("\n")
	}

	/** Returns a Git-style stat summary for an untracked working-tree file. */
	private async getUntrackedFileStat(change: GitChange): Promise<string> {
		const relativePath = this.getRelativePath(change.filePath)
		if (await this.isProbablyBinaryFile(change.filePath)) {
			return `${relativePath} | Bin 0 -> ${await this.getFileSize(change.filePath)} bytes`
		}

		const content = await fs.readFile(change.filePath, "utf8")
		const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
		const lineCount = this.countTextLines(normalizedContent)
		return `${relativePath} | ${lineCount} ${"+".repeat(Math.min(lineCount, 60))}`
	}

	/** Returns the byte size for a file on disk. */
	private async getFileSize(filePath: string): Promise<number> {
		return (await fs.stat(filePath)).size
	}

	/** Detects binary tracked changes with a single numstat invocation. */
	private async findBinaryChanges(changes: GitChange[], staged: boolean): Promise<Set<string>> {
		const binaryFiles = new Set<string>()
		const trackedChanges = changes.filter((change) => change.status !== "?")
		if (trackedChanges.length === 0) {
			return binaryFiles
		}

		const args = this.buildNumstatArgs(staged, trackedChanges)
		const output = await this.runGit(args)
		const binaryRelativePaths = output
			.split("\n")
			.map((line) => line.split("\t"))
			.filter(([added, deleted, filePath]) => added === "-" && deleted === "-" && Boolean(filePath))
			.map(([, , ...filePathParts]) => filePathParts.join("\t"))

		for (const change of trackedChanges) {
			const relativePath = this.getRelativePath(change.filePath)
			if (binaryRelativePaths.includes(relativePath)) {
				binaryFiles.add(change.filePath)
			}
		}

		return binaryFiles
	}

	/** Builds path-limited numstat arguments for binary detection. */
	private buildNumstatArgs(staged: boolean, changes: GitChange[]): string[] {
		const args = staged ? ["diff", "--cached", "--numstat"] : ["diff", "--numstat"]
		return [...args, "--", ...changes.map((change) => this.getRelativePath(change.filePath))]
	}

	/** Checks the first bytes of a file for NUL bytes. */
	private async isProbablyBinaryFile(filePath: string): Promise<boolean> {
		const fileHandle = await fs.open(filePath, "r")
		try {
			const buffer = Buffer.alloc(8000)
			const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0)
			return buffer.subarray(0, bytesRead).includes(0)
		} finally {
			await fileHandle.close()
		}
	}

	/** Builds synthesized diff text for untracked files. */
	private async getUntrackedFileDiffs(changes: GitChange[]): Promise<string> {
		const diffs: string[] = []

		for (const change of changes) {
			if (await this.isProbablyBinaryFile(change.filePath)) {
				diffs.push(`Binary file added: ${this.getRelativePath(change.filePath)}`)
				continue
			}

			diffs.push(await this.createNewFileDiff(change.filePath))
		}

		return diffs.join("\n")
	}

	/** Creates a unified new-file diff from working-tree file content. */
	private async createNewFileDiff(filePath: string): Promise<string> {
		const relativePath = this.getRelativePath(filePath)
		const content = await fs.readFile(filePath, "utf8")
		const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

		if (normalizedContent.length === 0) {
			return [
				`diff --git a/${relativePath} b/${relativePath}`,
				"new file mode 100644",
				"--- /dev/null",
				`+++ b/${relativePath}`,
			].join("\n")
		}

		const hasTrailingNewline = normalizedContent.endsWith("\n")
		const lines = (hasTrailingNewline ? normalizedContent.slice(0, -1) : normalizedContent).split("\n")
		const diffLines = [
			`diff --git a/${relativePath} b/${relativePath}`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ b/${relativePath}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`),
		]

		if (!hasTrailingNewline) {
			diffLines.push("\\ No newline at end of file")
		}

		return diffLines.join("\n")
	}

	/** Returns raw Git status output for staged or unstaged collection. */
	private async getStatus(options: GitContextOptions): Promise<string> {
		return options.staged
			? this.runGit(["diff", "--name-status", "--cached", "-z"])
			: this.runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
	}

	/** Returns the currently checked-out branch name. */
	private async getCurrentBranch(): Promise<string> {
		return this.runGit(["branch", "--show-current"])
	}

	/** Returns recent commit summaries and optional stats or patch context. */
	private async getRecentCommits(options: GitRecentCommitContextOptions): Promise<string> {
		const count = this.clampNumber(options.count, 1, 20, DEFAULT_RECENT_COMMIT_COUNT)
		const args = options.includeBodies
			? ["log", `-${count}`, "--format=commit %h%nSubject: %s%nBody:%n%b"]
			: ["log", "--oneline", `-${count}`]

		if (options.includeStats) {
			args.push("--stat")
		}

		const parts = [await this.runGit(args)]

		if (options.includeDiffs) {
			const diffCount = this.clampNumber(options.diffCount, 1, 5, DEFAULT_RECENT_COMMIT_DIFF_COUNT)
			const hashes = (await this.runGit(["log", `-${diffCount}`, "--format=%H"]))
				.split("\n")
				.map((hash) => hash.trim())
				.filter(Boolean)

			for (const hash of hashes) {
				parts.push(await this.runGit(["show", "--format=commit %h%nSubject: %s%n%b", "--patch", hash]))
			}
		}

		return parts.join("\n")
	}

	/** Formats collected changes as Markdown context for prompt input. */
	public async collectContext(
		changes: GitChange[],
		options: GitContextCollectorOptions,
		specificFiles?: string[],
	): Promise<GitContextResult> {
		const { includeBranch = false, recentCommits } = options
		let context = "## Git Context\n\n"
		const warnings: string[] = []

		const targetChanges = this.filterChanges(changes, specificFiles)
		const fileInfo = specificFiles ? ` (${specificFiles.length} selected files)` : ""
		const allStaged = targetChanges.every((change) => change.staged)
		const allUnstaged = targetChanges.every((change) => !change.staged)
		const changeDescriptor = allStaged ? "Staged" : allUnstaged ? "Unstaged" : "Selected"

		if (options.diff?.includeStats) {
			const stats = await this.getDiffStats(targetChanges, options)
			if (stats.trim()) {
				context += `### Diff Stats${fileInfo}\n\`\`\`\n${stats.trim()}\n\`\`\`\n\n`
			}
		}

		const diff = await this.getDiffForChanges(targetChanges, options)
		context += `### Full Diff of ${changeDescriptor} Changes${fileInfo}\n\`\`\`diff\n${diff}\n\`\`\`\n\n`

		if (targetChanges.length > 0) {
			const summaryLines = targetChanges.map((change) => {
				const relativePath = this.getRelativePath(change.filePath)
				const scope = change.staged ? "staged" : "unstaged"
				const status = this.getReadableStatus(change.status)

				if (change.oldFilePath) {
					const oldRelativePath = this.getRelativePath(change.oldFilePath)
					return `${status} (${scope}): ${oldRelativePath} -> ${relativePath}`
				}

				return `${status} (${scope}): ${relativePath}`
			})

			context += "### Change Summary\n```\n" + summaryLines.join("\n") + "\n```\n\n"
		} else {
			context += "### Change Summary\n```\n(No changes matched selection)\n```\n\n"
		}

		if (includeBranch || recentCommits?.include) {
			context += "### Repository Context\n\n"
		}

		if (includeBranch) {
			try {
				const currentBranch = await this.getCurrentBranch()
				if (currentBranch) {
					context += "**Current branch:** `" + currentBranch.trim() + "`\n\n"
				}
			} catch (error) {
				warnings.push(`Current branch unavailable: ${this.getErrorMessage(error)}`)
			}
		}

		if (recentCommits?.include) {
			try {
				const recentCommitContext = await this.getRecentCommits(recentCommits)
				if (recentCommitContext) {
					context += "**Recent commits:**\n```\n" + recentCommitContext + "\n```\n"
				}
			} catch (error) {
				warnings.push(`Recent commits unavailable: ${this.getErrorMessage(error)}`)
			}
		}

		if (warnings.length > 0) {
			context += "\n### Git Context Warnings\n```\n" + warnings.join("\n") + "\n```\n"
		}

		return { context, warnings }
	}

	/** Formats collected changes and returns only the Markdown context body. */
	public async getContext(
		changes: GitChange[],
		options: GitContextCollectorOptions,
		specificFiles?: string[],
	): Promise<string> {
		return (await this.collectContext(changes, options, specificFiles)).context
	}

	/** Normalizes unknown thrown values into displayable error messages. */
	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}

	/** Parses NUL-delimited git diff --name-status output. */
	private parseNameStatus(output: string, staged: boolean): GitChange[] {
		const fields = this.splitNullDelimited(output)
		const changes: GitChange[] = []

		for (let index = 0; index < fields.length; index++) {
			const statusCode = fields[index]
			const status = this.getChangeStatusFromCode(statusCode)

			if (status === "R" || status === "C") {
				if (index + 2 >= fields.length) {
					break
				}

				const oldFilePath = fields[++index]
				const filePath = fields[++index]
				if (oldFilePath && filePath) {
					changes.push({
						filePath: path.join(this.workspaceRoot, filePath),
						oldFilePath: path.join(this.workspaceRoot, oldFilePath),
						status,
						staged,
					})
				}
				continue
			}

			if (index + 1 >= fields.length) {
				break
			}

			const filePath = fields[++index]
			if (filePath) {
				changes.push({
					filePath: path.join(this.workspaceRoot, filePath),
					status,
					staged,
				})
			}
		}

		return changes
	}

	/** Parses NUL-delimited git status --porcelain=v1 output for unstaged changes. */
	private parsePorcelainStatus(output: string): GitChange[] {
		const fields = this.splitNullDelimited(output)
		const changes: GitChange[] = []

		for (let index = 0; index < fields.length; index++) {
			const entry = fields[index]
			if (entry.length < 4) {
				continue
			}

			const indexStatus = entry.charAt(0)
			const workingStatus = entry.charAt(1)
			const isUntracked = indexStatus === "?" && workingStatus === "?"
			const worktreeStatus = workingStatus.trim()
			if (!isUntracked && !worktreeStatus) {
				continue
			}

			const statusCode = isUntracked ? "?" : worktreeStatus
			const status = this.getChangeStatusFromCode(statusCode)
			const filePath = entry.substring(3)

			if (status === "R" || status === "C") {
				const oldFilePath = index + 1 < fields.length ? fields[++index] : undefined
				changes.push({
					filePath: path.join(this.workspaceRoot, filePath),
					oldFilePath: oldFilePath ? path.join(this.workspaceRoot, oldFilePath) : undefined,
					status,
					staged: false,
				})
				continue
			}

			changes.push({
				filePath: path.join(this.workspaceRoot, filePath),
				status,
				staged: false,
			})
		}

		return changes
	}

	/** Splits NUL-delimited Git output and drops the trailing empty field. */
	private splitNullDelimited(output: string): string[] {
		return output.split("\0").filter(Boolean)
	}

	/** Applies exact path or basename-only file selection to collected changes. */
	private filterChanges(changes: GitChange[], specificFiles?: string[]): GitChange[] {
		if (!specificFiles || specificFiles.length === 0) {
			return changes
		}

		return changes.filter((change) => {
			const absolutePath = this.normalizePath(change.filePath)
			const relativePath = this.getRelativePath(change.filePath)
			return specificFiles.some((file) => {
				const normalizedFile = path.normalize(file).replace(/\\/g, "/")
				const absoluteFile = this.normalizePath(
					path.isAbsolute(file) ? file : path.join(this.workspaceRoot, file),
				)
				const isBasenameOnly = !normalizedFile.includes("/")

				return (
					absoluteFile === absolutePath ||
					relativePath === normalizedFile ||
					// Basename-only matching is intentional for SCM selections that pass only file names.
					(isBasenameOnly && path.basename(relativePath) === normalizedFile)
				)
			})
		})
	}

	/** Builds path-limited diff arguments for the requested change set. */
	private buildDiffArgs(
		staged: boolean,
		changes: GitChange[],
		extraArgs: string[] = [],
		diffOptions?: GitDiffContextOptions,
	): string[] {
		const args = staged ? ["diff", "--cached"] : ["diff"]
		const contextLines =
			!extraArgs.includes("--stat") && diffOptions?.contextLines !== undefined
				? [`--unified=${this.clampNumber(diffOptions.contextLines, 0, 20, 3)}`]
				: []
		const paths = Array.from(
			new Set(
				changes.flatMap((change) =>
					[change.filePath, change.oldFilePath]
						.filter((filePath): filePath is string => Boolean(filePath))
						.map((filePath) => this.getRelativePath(filePath)),
				),
			),
		)

		return paths.length > 0 ? [...args, ...extraArgs, ...contextLines, "--", ...paths] : [...args, ...extraArgs]
	}

	/** Clamps a numeric option to an integer range with fallback handling. */
	private clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return fallback
		}

		return Math.min(Math.max(Math.trunc(value), min), max)
	}

	/** Converts an absolute file path to a slash-normalized repository-relative path. */
	private getRelativePath(filePath: string): string {
		return path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/")
	}

	/** Converts a Git status code into the collector's status enum. */
	private getChangeStatusFromCode(code: string): GitStatus {
		const status = code.charAt(0)
		switch (status) {
			case "M":
			case "A":
			case "D":
			case "R":
			case "C":
			case "U":
			case "?":
				return status as GitStatus
			default:
				return "Unknown"
		}
	}

	/** Converts a status enum to a human-readable label. */
	private getReadableStatus(status: GitStatus): string {
		switch (status) {
			case "M":
				return "Modified"
			case "A":
				return "Added"
			case "D":
				return "Deleted"
			case "R":
				return "Renamed"
			case "C":
				return "Copied"
			case "U":
				return "Updated"
			case "?":
				return "Untracked"
			case "Unknown":
			default:
				return "Unknown"
		}
	}

	/** Keeps collector cleanup compatible with provider lifecycle hooks. */
	public dispose(): void {}

	/** Counts text lines while preserving blank lines and ignoring a final newline terminator. */
	private countTextLines(content: string): number {
		if (content.length === 0) {
			return 0
		}

		return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n").length
	}

	/** Normalizes absolute paths for platform-independent comparisons. */
	private normalizePath(filePath: string): string {
		return path.normalize(filePath).replace(/\\/g, "/")
	}
}
