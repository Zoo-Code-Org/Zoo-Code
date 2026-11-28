import path from "path"
import { fileExistsAtPath } from "../../utils/fs"
import fs from "fs/promises"
import fsSync from "fs"
import ignore, { Ignore } from "ignore"
import * as vscode from "vscode"

export const LOCK_TEXT_SYMBOL = "\u{1F512}"

/**
 * Controls LLM access to files by enforcing ignore patterns.
 * Designed to be instantiated once in Cline.ts and passed to file manipulation services.
 * Uses the 'ignore' library to support standard .gitignore syntax in .rooignore files.
 */
export class RooIgnoreController {
	private cwd: string
	private ignoreInstance: Ignore
	private readonly roots: string[]
	private readonly otherRootIgnores = new Map<string, { content: string; instance: Ignore }>()
	private disposables: vscode.Disposable[] = []
	rooIgnoreContent: string | undefined

	constructor(cwd: string) {
		this.cwd = cwd
		this.roots = [cwd, ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [])].filter(
			(root, index, roots) =>
				roots.findIndex((candidate) => path.resolve(candidate) === path.resolve(root)) === index,
		)
		this.ignoreInstance = ignore()
		this.rooIgnoreContent = undefined
		// Set up file watcher for .rooignore
		for (const root of this.roots) this.setupFileWatcher(root)
	}

	/**
	 * Initialize the controller by loading custom patterns
	 * Must be called after construction and before using the controller
	 */
	async initialize(): Promise<void> {
		await Promise.all(this.roots.map((root) => this.loadRooIgnore(root)))
	}

	/**
	 * Set up the file watcher for .rooignore changes
	 */
	private setupFileWatcher(root: string): void {
		const rooignorePattern = new vscode.RelativePattern(root, ".rooignore")
		const fileWatcher = vscode.workspace.createFileSystemWatcher(rooignorePattern)

		// Watch for changes and updates
		this.disposables.push(
			fileWatcher.onDidChange(() => {
				void this.loadRooIgnore(root)
			}),
			fileWatcher.onDidCreate(() => {
				void this.loadRooIgnore(root)
			}),
			fileWatcher.onDidDelete(() => {
				void this.loadRooIgnore(root)
			}),
		)

		// Add fileWatcher itself to disposables
		this.disposables.push(fileWatcher)
	}

	/**
	 * Load custom patterns from .rooignore if it exists
	 */
	private async loadRooIgnore(root: string): Promise<void> {
		try {
			const instance = ignore()
			const ignorePath = path.join(root, ".rooignore")
			if (await fileExistsAtPath(ignorePath)) {
				const content = await fs.readFile(ignorePath, "utf8")
				instance.add(content)
				instance.add(".rooignore")
				if (root === this.cwd) {
					this.rooIgnoreContent = content
					this.ignoreInstance = instance
				} else this.otherRootIgnores.set(root, { content, instance })
			} else {
				if (root === this.cwd) {
					this.rooIgnoreContent = undefined
					this.ignoreInstance = instance
				} else this.otherRootIgnores.delete(root)
			}
		} catch (error) {
			// Should never happen: reading file failed even though it exists
			console.error("Unexpected error loading .rooignore:", error)
		}
	}

	/**
	 * Check if a file should be accessible to the LLM
	 * Automatically resolves symlinks
	 * @param filePath - Path to check (relative to cwd)
	 * @returns true if file is accessible, false if ignored
	 */
	validateAccess(filePath: string): boolean {
		// Always allow access if .rooignore does not exist
		if (!this.rooIgnoreContent && this.otherRootIgnores.size === 0) {
			return true
		}
		try {
			const absolutePath = path.resolve(this.cwd, filePath)

			// Follow symlinks to get the real path
			let realPath: string
			try {
				realPath = fsSync.realpathSync(absolutePath)
			} catch {
				// If realpath fails (file doesn't exist, broken symlink, etc.),
				// use the original path
				realPath = absolutePath
			}

			// The target is canonical. Compare canonical roots too, or a workspace
			// opened through a symlink would bypass its own ignore rules.
			const root = this.roots
				.map((root) => {
					try {
						return { root, canonical: fsSync.realpathSync(root) }
					} catch {
						return { root, canonical: root }
					}
				})
				.sort((a, b) => b.canonical.length - a.canonical.length)
				.find((candidate) => {
					const relative = path.relative(candidate.canonical, realPath)
					return (
						relative === "" ||
						(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
					)
				})
			if (!root) return true
			const rule =
				root.root === this.cwd
					? this.rooIgnoreContent && this.ignoreInstance
					: this.otherRootIgnores.get(root.root)?.instance
			return rule ? !rule.ignores(path.relative(root.canonical, realPath).toPosix()) : true
		} catch {
			// Allow access to files outside cwd or on errors (backward compatibility)
			return true
		}
	}

	/**
	 * Check if a terminal command should be allowed to execute based on file access patterns
	 * @param command - Terminal command to validate
	 * @returns path of file that is being accessed if it is being accessed, undefined if command is allowed
	 */
	validateCommand(command: string): string | undefined {
		// Always allow if no .rooignore exists
		if (!this.rooIgnoreContent && this.otherRootIgnores.size === 0) {
			return undefined
		}

		// Split command into parts and get the base command
		const parts = command.trim().split(/\s+/)
		const baseCommand = parts[0].toLowerCase()

		// Commands that read file contents
		const fileReadingCommands = [
			// Unix commands
			"cat",
			"less",
			"more",
			"head",
			"tail",
			"grep",
			"awk",
			"sed",
			// PowerShell commands and aliases
			"get-content",
			"gc",
			"type",
			"select-string",
			"sls",
		]

		if (fileReadingCommands.includes(baseCommand)) {
			// Check each argument that could be a file path
			for (let i = 1; i < parts.length; i++) {
				const arg = parts[i]
				// Skip command flags/options (both Unix and PowerShell style)
				if (arg.startsWith("-") || arg.startsWith("/")) {
					continue
				}
				// Ignore PowerShell parameter names
				if (arg.includes(":")) {
					continue
				}
				// Validate file access
				if (!this.validateAccess(arg)) {
					return arg
				}
			}
		}

		return undefined
	}

	/**
	 * Filter an array of paths, removing those that should be ignored
	 * @param paths - Array of paths to filter (relative to cwd)
	 * @returns Array of allowed paths
	 */
	filterPaths(paths: string[]): string[] {
		try {
			return paths
				.map((p) => ({
					path: p,
					allowed: this.validateAccess(p),
				}))
				.filter((x) => x.allowed)
				.map((x) => x.path)
		} catch (error) {
			console.error("Error filtering paths:", error)
			return [] // Fail closed for security
		}
	}

	/**
	 * Clean up resources when the controller is no longer needed
	 */
	dispose(): void {
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
	}

	/**
	 * Get formatted instructions about the .rooignore file for the LLM
	 * @returns Formatted instructions or undefined if .rooignore doesn't exist
	 */
	getInstructions(): string | undefined {
		if (!this.rooIgnoreContent && this.otherRootIgnores.size === 0) {
			return undefined
		}

		const rules = this.roots.flatMap((root) => {
			const content = root === this.cwd ? this.rooIgnoreContent : this.otherRootIgnores.get(root)?.content
			return content ? [`## ${root}/.rooignore\n${content}\n.rooignore`] : []
		})
		return `# .rooignore\n\n(The following root-level rules identify files and directories that should not be accessed. When using list_files, you'll notice a ${LOCK_TEXT_SYMBOL} next to files that are blocked. Attempting to read them will fail.)\n\n${rules.join("\n\n")}`
	}
}
