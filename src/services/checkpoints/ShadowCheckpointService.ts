import fs from "fs/promises"
import os from "os"
import * as path from "path"
import crypto from "crypto"
import EventEmitter from "events"

import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { executeRipgrep } from "../../services/search/file-search"
import { t } from "../../i18n"

import { CheckpointDiff, CheckpointResult, CheckpointEventMap } from "./types"
import { getExcludePatterns } from "./excludes"

// Stored in the commit itself so an interrupted sidecar write cannot look like a legacy checkpoint.
const IGNORED_RECORD_HEADER = "Zoo-Checkpoint-Ignored: v1"

/**
 * Environment variables stripped before passing the env to simple-git.
 *
 * Two categories:
 *  - Location-override vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 *    GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CEILING_DIRECTORIES): redirect git operations to
 *    unintended repositories or limit where git searches.
 *  - Code-execution vectors blocked by simple-git ≥3.36's blockUnsafeOperationsPlugin when
 *    passed via .env(): GIT_EDITOR, GIT_SSH_COMMAND, GIT_PAGER, PREFIX, etc.
 *
 * Stripping GIT_CONFIG_COUNT also neutralises the entire GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
 * family — git ignores those per-key entries when the count key is absent.
 */
export const BLOCKED_ENV_KEYS = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_TEMPLATE_DIR",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
	"GIT_ASKPASS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_PAGER",
	"GIT_PROXY_COMMAND",
	"GIT_EXEC_PATH",
	"GIT_EXTERNAL_DIFF",
	"GIT_CONFIG",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_COUNT",
	"PREFIX",
	"EDITOR",
	"PAGER",
	"SSH_ASKPASS",
])

// Lowercase set for case-insensitive lookup — the plugin uses toLowerCase() internally,
// so a var like Git_Editor would bypass an exact-match check on Linux.
const BLOCKED_ENV_KEYS_LOWER = new Set([...BLOCKED_ENV_KEYS].map((k) => k.toLowerCase()))

/**
 * Creates a SimpleGit instance with sanitized environment variables to prevent
 * interference from inherited git environment variables like GIT_DIR and GIT_WORK_TREE.
 * This ensures checkpoint operations always target the intended shadow repository.
 *
 * @param baseDir - The directory where git operations should be executed
 * @returns A SimpleGit instance with sanitized environment
 */
function createSanitizedGit(baseDir: string): SimpleGit {
	const sanitizedEnv: Record<string, string> = {}
	const removedKeys: string[] = []

	for (const [key, value] of Object.entries(process.env)) {
		if (BLOCKED_ENV_KEYS_LOWER.has(key.toLowerCase())) {
			removedKeys.push(key)
			continue
		}

		if (value !== undefined) {
			sanitizedEnv[key] = value
		}
	}

	// Log which git env vars were removed (helps with debugging Dev Container issues)
	if (removedKeys.length > 0) {
		console.log(
			`[createSanitizedGit] Removed git environment variables for checkpoint isolation: ${removedKeys.join(", ")}`,
		)
	}

	const options: Partial<SimpleGitOptions> = {
		baseDir,
		config: [],
		// --template="" stops git copying hooks/templates into the shadow repo (axis 1).
		// GIT_TEMPLATE_DIR is stripped from the env above to block the env-var path (axis 2).
		// allowUnsafeTemplateDir opts out of simple-git ≥3.36's blockUnsafeOperationsPlugin
		// so the --template arg is not rejected before reaching git.
		unsafe: { allowUnsafeTemplateDir: true },
	}

	// Create git instance and set the sanitized environment
	const git = simpleGit(options)

	// Use the .env() method to set the complete sanitized environment
	// This replaces the inherited environment with our sanitized version
	git.env(sanitizedEnv)

	console.log(`[createSanitizedGit] Created git instance for baseDir: ${baseDir}`)

	return git
}

export abstract class ShadowCheckpointService extends EventEmitter {
	public readonly taskId: string
	public readonly checkpointsDir: string
	public readonly workspaceDir: string

	protected _checkpoints: string[] = []
	protected _baseHash?: string

	protected readonly dotGitDir: string
	protected git?: SimpleGit
	protected readonly log: (message: string) => void
	protected shadowGitConfigWorktree?: string

	public get baseHash() {
		return this._baseHash
	}

	protected set baseHash(value: string | undefined) {
		this._baseHash = value
	}

	public get isInitialized() {
		return !!this.git
	}

	public getCheckpoints(): string[] {
		return this._checkpoints.slice()
	}

	constructor(taskId: string, checkpointsDir: string, workspaceDir: string, log: (message: string) => void) {
		super()

		const homedir = os.homedir()
		const desktopPath = path.join(homedir, "Desktop")
		const documentsPath = path.join(homedir, "Documents")
		const downloadsPath = path.join(homedir, "Downloads")
		const protectedPaths = [homedir, desktopPath, documentsPath, downloadsPath]

		if (protectedPaths.includes(workspaceDir)) {
			throw new Error(`Cannot use checkpoints in ${workspaceDir}`)
		}

		this.taskId = taskId
		this.checkpointsDir = checkpointsDir
		this.workspaceDir = workspaceDir

		this.dotGitDir = path.join(this.checkpointsDir, ".git")
		this.log = log
	}

	public async initShadowGit(onInit?: () => Promise<void>) {
		if (this.git) {
			throw new Error("Shadow git repo already initialized")
		}

		const nestedGitPath = await this.getNestedGitRepository()

		if (nestedGitPath) {
			// Show persistent error message with the offending path
			const relativePath = path.relative(this.workspaceDir, nestedGitPath)
			const message = t("common:errors.nested_git_repos_warning", { path: relativePath })
			vscode.window.showErrorMessage(message)

			throw new Error(
				`Checkpoints are disabled because a nested git repository was detected at: ${relativePath}. ` +
					"Please remove or relocate nested git repositories to use the checkpoints feature.",
			)
		}

		await fs.mkdir(this.checkpointsDir, { recursive: true })
		const git = createSanitizedGit(this.checkpointsDir)
		const gitVersion = await git.version()
		this.log(`[${this.constructor.name}#create] git = ${gitVersion}`)

		let created = false
		const startTime = Date.now()

		if (await fileExistsAtPath(this.dotGitDir)) {
			this.log(`[${this.constructor.name}#initShadowGit] shadow git repo already exists at ${this.dotGitDir}`)
			const worktree = await this.getShadowGitConfigWorktree(git)

			if (!worktree) {
				throw new Error("Checkpoints require core.worktree to be set in the shadow git config")
			}

			const worktreeTrimmed = worktree.trim()

			if (!arePathsEqual(worktreeTrimmed, this.workspaceDir)) {
				throw new Error(
					`Checkpoints can only be used in the original workspace: ${worktreeTrimmed} !== ${this.workspaceDir}`,
				)
			}

			await this.writeExcludeFile()
			this.baseHash = await git.revparse(["HEAD"])
		} else {
			this.log(`[${this.constructor.name}#initShadowGit] creating shadow git repo at ${this.checkpointsDir}`)
			await git.init({ "--template": "" })
			await git.addConfig("core.worktree", this.workspaceDir) // Sets the working tree to the current workspace.
			await git.addConfig("commit.gpgSign", "false") // Disable commit signing for shadow repo.
			await git.addConfig("user.name", "Roo Code")
			await git.addConfig("user.email", "noreply@example.com")
			await this.writeExcludeFile()
			await this.stageAll(git)
			const { commit } = await git.commit(`initial commit\n\n${IGNORED_RECORD_HEADER}`, { "--allow-empty": null })
			this.baseHash = commit
			await this.recordIgnoredPaths(git, commit)
			created = true
		}

		const duration = Date.now() - startTime

		this.log(
			`[${this.constructor.name}#initShadowGit] initialized shadow repo with base commit ${this.baseHash} in ${duration}ms`,
		)

		this.git = git

		await onInit?.()

		this.emit("initialize", {
			type: "initialize",
			workspaceDir: this.workspaceDir,
			baseHash: this.baseHash,
			created,
			duration,
		})

		return { created, duration }
	}

	// Add basic excludes directly in git config, while respecting any
	// .gitignore in the workspace.
	// .git/info/exclude is local to the shadow git repo, so it's not
	// shared with the main repo - and won't conflict with user's
	// .gitignore.
	protected async writeExcludeFile() {
		await fs.mkdir(path.join(this.dotGitDir, "info"), { recursive: true })
		const patterns = await getExcludePatterns(this.workspaceDir)
		await fs.writeFile(path.join(this.dotGitDir, "info", "exclude"), patterns.join("\n"))
	}

	private async stageAll(git: SimpleGit) {
		try {
			await git.add([".", "--ignore-errors"])
		} catch (error) {
			this.log(
				`[${this.constructor.name}#stageAll] failed to add files to git: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	// Ignore rules are read from the live workspace, so a .gitignore changed after a checkpoint
	// would make `git clean` delete files that were ignored (and so never checkpointed) at the
	// time (#1832). Each checkpoint therefore records the paths ignored when it was saved.
	private ignoredRecordPath(commitHash: string) {
		return path.join(this.dotGitDir, "zoo-checkpoint-ignored", commitHash)
	}

	private async listIgnoredPaths(git: SimpleGit): Promise<string[]> {
		// --directory collapses fully ignored directories (e.g. node_modules/) to one entry.
		const output = await git.raw(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
		return output.split("\0").filter(Boolean)
	}

	private async readIgnoredRecord(commitHash: string, required = false): Promise<string[] | undefined> {
		let content: string
		try {
			content = await fs.readFile(this.ignoredRecordPath(commitHash), "utf8")
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT" && !required) return undefined
			throw error
		}
		const prefix = `${IGNORED_RECORD_HEADER}\n`
		if (content.startsWith(prefix)) {
			const paths: unknown = JSON.parse(content.slice(prefix.length))
			if (
				!Array.isArray(paths) ||
				!paths.every((entry): entry is string => typeof entry === "string" && !!entry)
			) {
				throw new Error(`Invalid ignored-path record for checkpoint ${commitHash}`)
			}
			return paths
		}
		if (required) throw new Error(`Invalid ignored-path record for checkpoint ${commitHash}`)
		// Records from the first implementation were NUL-delimited, without a commit marker.
		return content.split("\0").filter(Boolean)
	}

	/** Publish protection before reporting success; preserve the previous record on failure. */
	private async recordIgnoredPaths(git: SimpleGit, commitHash: string, requireExisting = false) {
		const recordPath = this.ignoredRecordPath(commitHash)
		const tempPath = `${recordPath}.${crypto.randomUUID()}.tmp`
		try {
			const ignored = new Set([
				...((await this.readIgnoredRecord(commitHash, requireExisting)) ?? []),
				...(await this.listIgnoredPaths(git)),
			])
			await fs.mkdir(path.dirname(recordPath), { recursive: true })
			// A no-change save reuses the same commit. Never truncate its existing protection.
			await fs.writeFile(tempPath, `${IGNORED_RECORD_HEADER}\n${JSON.stringify([...ignored])}`, { flush: true })
			await fs.rename(tempPath, recordPath)
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => {})
		}
	}

	/**
	 * Removes untracked files like `git clean -f -d -f`, but only those ignored by neither the
	 * current rules nor the rules recorded when the checkpoint was saved.
	 */
	private async removeUntrackedFiles(git: SimpleGit, ignoredAtCheckpoint: string[]) {
		const ignoredEntries = new Set([...ignoredAtCheckpoint, ...(await this.listIgnoredPaths(git))])
		const ignoredDirs = [...ignoredEntries].filter((entry) => entry.endsWith("/"))
		const wasIgnored = (relPath: string) =>
			ignoredEntries.has(relPath) || ignoredDirs.some((dir) => relPath.startsWith(dir))

		// --exclude-standard applies the current rules; nested repositories are listed as "dir/".
		const output = await git.raw(["ls-files", "--others", "--exclude-standard", "-z"])
		for (const relPath of output.split("\0").filter(Boolean)) {
			if (wasIgnored(relPath)) {
				continue
			}
			const absPath = path.join(this.workspaceDir, relPath)
			await fs.rm(absPath, { force: true, recursive: relPath.endsWith("/") })
		}

		// --directory includes paths that never contained files. Walk these bottom-up,
		// using only rmdir so a directory containing protected files is never deleted.
		const removeEmptyDirectories = async (relDir: string): Promise<void> => {
			if (wasIgnored(relDir)) return
			const absDir = path.join(this.workspaceDir, relDir)
			for (const entry of await fs.readdir(absDir, { withFileTypes: true })) {
				if (entry.isDirectory()) await removeEmptyDirectories(`${relDir}${entry.name}/`)
			}
			await fs.rmdir(absDir).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST" && error.code !== "ENOENT") throw error
			})
		}
		const directories = await git.raw(["ls-files", "--others", "--exclude-standard", "--directory", "-z"])
		for (const relPath of directories.split("\0").filter((entry) => entry.endsWith("/"))) {
			await removeEmptyDirectories(relPath)
		}
	}

	private async getNestedGitRepository(): Promise<string | null> {
		try {
			// Find all .git/HEAD files that are not at the root level.
			const args = ["--files", "--hidden", "--follow", "-g", "**/.git/HEAD", this.workspaceDir]

			const gitPaths = await executeRipgrep({ args, workspacePath: this.workspaceDir })

			// Filter to only include nested git directories (not the root .git).
			// Since we're searching for HEAD files, we expect type to be "file"
			const nestedGitPaths = gitPaths.filter(({ type, path: filePath }) => {
				// Check if it's a file and is a nested .git/HEAD (not at root)
				if (type !== "file") return false

				// Ensure it's a .git/HEAD file and not the root one
				const normalizedPath = filePath.replace(/\\/g, "/")
				return (
					normalizedPath.includes(".git/HEAD") &&
					!normalizedPath.startsWith(".git/") &&
					normalizedPath !== ".git/HEAD"
				)
			})

			if (nestedGitPaths.length > 0) {
				// Get the first nested git repository path
				// Remove .git/HEAD from the path to get the repository directory
				const headPath = nestedGitPaths[0].path

				// Use path module to properly extract the repository directory
				// The HEAD file is at .git/HEAD, so we need to go up two directories
				const gitDir = path.dirname(headPath) // removes HEAD, gives us .git
				const repoDir = path.dirname(gitDir) // removes .git, gives us the repo directory

				const absolutePath = path.join(this.workspaceDir, repoDir)

				this.log(
					`[${this.constructor.name}#getNestedGitRepository] found ${nestedGitPaths.length} nested git repositories, first at: ${repoDir}`,
				)
				return absolutePath
			}

			return null
		} catch (error) {
			this.log(
				`[${this.constructor.name}#getNestedGitRepository] failed to check for nested git repos: ${error instanceof Error ? error.message : String(error)}`,
			)

			// If we can't check, assume there are no nested repos to avoid blocking the feature.
			return null
		}
	}

	private async getShadowGitConfigWorktree(git: SimpleGit) {
		if (!this.shadowGitConfigWorktree) {
			try {
				this.shadowGitConfigWorktree = (await git.getConfig("core.worktree")).value || undefined
			} catch (error) {
				this.log(
					`[${this.constructor.name}#getShadowGitConfigWorktree] failed to get core.worktree: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		return this.shadowGitConfigWorktree
	}

	public async saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		try {
			this.log(
				`[${this.constructor.name}#saveCheckpoint] starting checkpoint save (allowEmpty: ${options?.allowEmpty ?? false})`,
			)

			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const startTime = Date.now()
			await this.stageAll(this.git)
			const commitArgs = options?.allowEmpty ? { "--allow-empty": null } : undefined
			const result = await this.git.commit(`${message}\n\n${IGNORED_RECORD_HEADER}`, commitArgs)
			const fromHash = this._checkpoints[this._checkpoints.length - 1] ?? this.baseHash!
			const toHash = result.commit || (await this.git.revparse(["HEAD"]))
			// A no-op save cannot reconstruct missing checkpoint-time protection from today's ignore rules.
			const requireExisting =
				!result.commit &&
				(await this.git.show(["-s", "--format=%B", toHash])).split(/\r?\n/).includes(IGNORED_RECORD_HEADER)
			await this.recordIgnoredPaths(this.git, toHash, requireExisting)
			this._checkpoints.push(toHash)
			const duration = Date.now() - startTime

			if (result.commit) {
				this.emit("checkpoint", {
					type: "checkpoint",
					fromHash,
					toHash,
					duration,
					suppressMessage: options?.suppressMessage ?? false,
				})
			}

			if (result.commit) {
				this.log(
					`[${this.constructor.name}#saveCheckpoint] checkpoint saved in ${duration}ms -> ${result.commit}`,
				)
				return result
			} else {
				this.log(`[${this.constructor.name}#saveCheckpoint] found no changes to commit in ${duration}ms`)
				return undefined
			}
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[${this.constructor.name}#saveCheckpoint] failed to create checkpoint: ${error.message}`)
			this.emit("error", { type: "error", error })
			throw error
		}
	}

	public async restoreCheckpoint(commitHash: string) {
		try {
			this.log(`[${this.constructor.name}#restoreCheckpoint] starting checkpoint restore`)

			// Never use webview input as a path or Git revision expression.
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitHash)) {
				throw new Error("Invalid checkpoint commit hash")
			}
			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const start = Date.now()
			if ((await this.git.raw(["cat-file", "-t", commitHash])).trim() !== "commit") {
				throw new Error("Checkpoint hash does not identify a commit")
			}
			const commitMessage = await this.git.show(["-s", "--format=%B", commitHash])
			const recordRequired = commitMessage.split(/\r?\n/).includes(IGNORED_RECORD_HEADER)
			const ignoredAtCheckpoint = await this.readIgnoredRecord(commitHash, recordRequired)
			if (ignoredAtCheckpoint) {
				await this.removeUntrackedFiles(this.git, ignoredAtCheckpoint)
			} else {
				// Checkpoints saved before ignore records existed keep the previous behavior.
				await this.git.clean("f", ["-d", "-f"])
			}
			await this.git.reset(["--hard", commitHash])

			// Remove all checkpoints after the specified commitHash.
			const checkpointIndex = this._checkpoints.indexOf(commitHash)

			if (checkpointIndex !== -1) {
				this._checkpoints = this._checkpoints.slice(0, checkpointIndex + 1)
			}

			const duration = Date.now() - start
			this.emit("restore", { type: "restore", commitHash, duration })
			this.log(`[${this.constructor.name}#restoreCheckpoint] restored checkpoint ${commitHash} in ${duration}ms`)
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[${this.constructor.name}#restoreCheckpoint] failed to restore checkpoint: ${error.message}`)
			this.emit("error", { type: "error", error })
			throw error
		}
	}

	public async getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}

		const result = []

		if (!from) {
			from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
		}

		// Stage all changes so that untracked files appear in diff summary.
		await this.stageAll(this.git)

		this.log(`[${this.constructor.name}#getDiff] diffing ${to ? `${from}..${to}` : `${from}..HEAD`}`)
		const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

		const cwdPath = (await this.getShadowGitConfigWorktree(this.git)) || this.workspaceDir || ""

		for (const file of files) {
			const relPath = file.file
			const absPath = path.join(cwdPath, relPath)
			const before = await this.git.show([`${from}:${relPath}`]).catch(() => "")

			const after = to
				? await this.git.show([`${to}:${relPath}`]).catch(() => "")
				: await fs.readFile(absPath, "utf8").catch(() => "")

			result.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } })
		}

		return result
	}

	/**
	 * EventEmitter
	 */

	override emit<K extends keyof CheckpointEventMap>(event: K, data: CheckpointEventMap[K]) {
		return super.emit(event, data)
	}

	override on<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.on(event, listener)
	}

	override off<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.off(event, listener)
	}

	override once<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.once(event, listener)
	}

	/**
	 * Storage
	 */

	public static hashWorkspaceDir(workspaceDir: string) {
		return crypto.createHash("sha256").update(workspaceDir).digest("hex").toString().slice(0, 8)
	}

	protected static taskRepoDir({ taskId, globalStorageDir }: { taskId: string; globalStorageDir: string }) {
		return path.join(globalStorageDir, "tasks", taskId, "checkpoints")
	}

	protected static workspaceRepoDir({
		globalStorageDir,
		workspaceDir,
	}: {
		globalStorageDir: string
		workspaceDir: string
	}) {
		return path.join(globalStorageDir, "checkpoints", this.hashWorkspaceDir(workspaceDir))
	}

	public static async deleteTask({
		taskId,
		globalStorageDir,
		workspaceDir,
	}: {
		taskId: string
		globalStorageDir: string
		workspaceDir: string
	}) {
		const workspaceRepoDir = this.workspaceRepoDir({ globalStorageDir, workspaceDir })
		const branchName = `roo-${taskId}`
		const git = createSanitizedGit(workspaceRepoDir)
		const success = await this.deleteBranch(git, branchName)

		if (success) {
			console.log(`[${this.name}#deleteTask.${taskId}] deleted branch ${branchName}`)
		} else {
			console.error(`[${this.name}#deleteTask.${taskId}] failed to delete branch ${branchName}`)
		}
	}

	public static async deleteBranch(git: SimpleGit, branchName: string) {
		const branches = await git.branchLocal()

		if (!branches.all.includes(branchName)) {
			console.error(`[${this.constructor.name}#deleteBranch] branch ${branchName} does not exist`)
			return false
		}

		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])

		if (currentBranch === branchName) {
			const worktree = await git.getConfig("core.worktree")

			try {
				await git.raw(["config", "--unset", "core.worktree"])
				await git.reset(["--hard"])
				await git.clean("f", ["-d"])
				const defaultBranch = branches.all.includes("main") ? "main" : "master"
				await git.checkout([defaultBranch, "--force"])

				await pWaitFor(
					async () => {
						const newBranch = await git.revparse(["--abbrev-ref", "HEAD"])
						return newBranch === defaultBranch
					},
					{ interval: 500, timeout: 2_000 },
				)

				await git.branch(["-D", branchName])
				return true
			} catch (error) {
				console.error(
					`[${this.constructor.name}#deleteBranch] failed to delete branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`,
				)

				return false
			} finally {
				if (worktree.value) {
					await git.addConfig("core.worktree", worktree.value)
				}
			}
		} else {
			await git.branch(["-D", branchName])
			return true
		}
	}
}
