import * as path from "path"
import * as os from "os"
import fs from "fs/promises"

const ZOO_CONFIG_DIRECTORY_NAME = ".zoo"
const ROO_CONFIG_DIRECTORY_NAME = ".roo"
const ZOO_CUSTOM_MODES_FILENAME = ".zoomodes"
const ROO_CUSTOM_MODES_FILENAME = ".roomodes"
const ZOO_IGNORE_FILENAME = ".zooignore"
const ROO_IGNORE_FILENAME = ".rooignore"
const MCP_SETTINGS_FILENAME = "mcp.json"

type ZooPathEntityType = "directory" | "file"

export interface ZooPathResolution {
	canonicalPath: string
	legacyPath: string
	activePath: string
	canonicalExists: boolean
	legacyExists: boolean
	activeExists: boolean
	shouldBootstrapCanonicalFromLegacy: boolean
}

async function pathExistsForEntity(pathToCheck: string, entityType: ZooPathEntityType): Promise<boolean> {
	return entityType === "directory" ? directoryExists(pathToCheck) : fileExists(pathToCheck)
}

async function resolveZooPathPair(
	canonicalPath: string,
	legacyPath: string,
	entityType: ZooPathEntityType,
): Promise<ZooPathResolution> {
	const [canonicalExists, legacyExists] = await Promise.all([
		pathExistsForEntity(canonicalPath, entityType),
		pathExistsForEntity(legacyPath, entityType),
	])

	const activePath = !canonicalExists && legacyExists ? legacyPath : canonicalPath
	const shouldBootstrapCanonicalFromLegacy = !canonicalExists && legacyExists

	return {
		canonicalPath,
		legacyPath,
		activePath,
		canonicalExists,
		legacyExists,
		activeExists: canonicalExists || legacyExists,
		shouldBootstrapCanonicalFromLegacy,
	}
}

/**
 * Gets the canonical global Zoo configuration directory path based on the current platform.
 */
export function getCanonicalGlobalConfigDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ZOO_CONFIG_DIRECTORY_NAME)
}

/**
 * Gets the legacy global Roo configuration directory path based on the current platform.
 *
 * Preserved as the backward-compatible meaning behind older Roo-named helpers.
 */
export function getLegacyGlobalConfigDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ROO_CONFIG_DIRECTORY_NAME)
}

/**
 * Resolves the active global configuration directory using Zoo-first / Roo-fallback semantics.
 */
export async function resolveGlobalConfigDirectory(): Promise<ZooPathResolution> {
	return resolveZooPathPair(getCanonicalGlobalConfigDirectory(), getLegacyGlobalConfigDirectory(), "directory")
}

/**
 * Gets the legacy global .roo directory path based on the current platform
 *
 * @returns The absolute path to the global .roo directory
 *
 * @example Platform-specific paths:
 * ```
 * // macOS/Linux: ~/.roo/
 * // Example: /Users/john/.roo
 *
 * // Windows: %USERPROFILE%\.roo\
 * // Example: C:\Users\john\.roo
 * ```
 *
 * @example Usage:
 * ```typescript
 * const globalDir = getGlobalRooDirectory()
 * // Returns: "/Users/john/.roo" (on macOS/Linux)
 * // Returns: "C:\\Users\\john\\.roo" (on Windows)
 * ```
 */
export const getGlobalRooDirectory = getLegacyGlobalConfigDirectory

/**
 * Gets the global .agents directory path based on the current platform.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @returns The absolute path to the global .agents directory
 *
 * @example Platform-specific paths:
 * ```
 * // macOS/Linux: ~/.agents/
 * // Example: /Users/john/.agents
 *
 * // Windows: %USERPROFILE%\.agents\
 * // Example: C:\Users\john\.agents
 * ```
 *
 * @example Usage:
 * ```typescript
 * const globalAgentsDir = getGlobalAgentsDirectory()
 * // Returns: "/Users/john/.agents" (on macOS/Linux)
 * // Returns: "C:\\Users\\john\\.agents" (on Windows)
 * ```
 */
export function getGlobalAgentsDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ".agents")
}

/**
 * Gets the project-local .agents directory path for a given cwd.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @param cwd - Current working directory (project path)
 * @returns The absolute path to the project-local .agents directory
 *
 * @example
 * ```typescript
 * const projectAgentsDir = getProjectAgentsDirectoryForCwd('/Users/john/my-project')
 * // Returns: "/Users/john/my-project/.agents"
 * ```
 */
export function getProjectAgentsDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ".agents")
}

/**
 * Gets the canonical project-local Zoo configuration directory path for a given cwd.
 */
export function getCanonicalProjectConfigDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ZOO_CONFIG_DIRECTORY_NAME)
}

/**
 * Gets the legacy project-local Roo configuration directory path for a given cwd.
 */
export function getLegacyProjectConfigDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ROO_CONFIG_DIRECTORY_NAME)
}

/**
 * Resolves the active project configuration directory using Zoo-first / Roo-fallback semantics.
 */
export async function resolveProjectConfigDirectoryForCwd(cwd: string): Promise<ZooPathResolution> {
	return resolveZooPathPair(
		getCanonicalProjectConfigDirectoryForCwd(cwd),
		getLegacyProjectConfigDirectoryForCwd(cwd),
		"directory",
	)
}

/**
 * Gets the canonical project-local custom modes file path for a given cwd.
 */
export function getCanonicalProjectCustomModesFileForCwd(cwd: string): string {
	return path.join(cwd, ZOO_CUSTOM_MODES_FILENAME)
}

/**
 * Gets the legacy project-local custom modes file path for a given cwd.
 */
export function getLegacyProjectCustomModesFileForCwd(cwd: string): string {
	return path.join(cwd, ROO_CUSTOM_MODES_FILENAME)
}

/**
 * Resolves the active project custom modes file using Zoo-first / Roo-fallback semantics.
 */
export async function resolveProjectCustomModesFileForCwd(cwd: string): Promise<ZooPathResolution> {
	return resolveZooPathPair(
		getCanonicalProjectCustomModesFileForCwd(cwd),
		getLegacyProjectCustomModesFileForCwd(cwd),
		"file",
	)
}

/**
 * Gets the canonical project-local ignore file path for a given cwd.
 */
export function getCanonicalProjectIgnoreFileForCwd(cwd: string): string {
	return path.join(cwd, ZOO_IGNORE_FILENAME)
}

/**
 * Gets the legacy project-local ignore file path for a given cwd.
 */
export function getLegacyProjectIgnoreFileForCwd(cwd: string): string {
	return path.join(cwd, ROO_IGNORE_FILENAME)
}

/**
 * Resolves the active project ignore file using Zoo-first / Roo-fallback semantics.
 */
export async function resolveProjectIgnoreFileForCwd(cwd: string): Promise<ZooPathResolution> {
	return resolveZooPathPair(getCanonicalProjectIgnoreFileForCwd(cwd), getLegacyProjectIgnoreFileForCwd(cwd), "file")
}

/**
 * Gets the canonical project-local MCP settings file path for a given cwd.
 */
export function getCanonicalProjectMcpFileForCwd(cwd: string): string {
	return path.join(getCanonicalProjectConfigDirectoryForCwd(cwd), MCP_SETTINGS_FILENAME)
}

/**
 * Gets the legacy project-local MCP settings file path for a given cwd.
 */
export function getLegacyProjectMcpFileForCwd(cwd: string): string {
	return path.join(getLegacyProjectConfigDirectoryForCwd(cwd), MCP_SETTINGS_FILENAME)
}

/**
 * Resolves the active project MCP settings file using Zoo-first / Roo-fallback semantics.
 */
export async function resolveProjectMcpFileForCwd(cwd: string): Promise<ZooPathResolution> {
	return resolveZooPathPair(getCanonicalProjectMcpFileForCwd(cwd), getLegacyProjectMcpFileForCwd(cwd), "file")
}

/**
 * Gets the project-local .roo directory path for a given cwd
 *
 * @param cwd - Current working directory (project path)
 * @returns The absolute path to the project-local .roo directory
 *
 * @example
 * ```typescript
 * const projectDir = getProjectRooDirectoryForCwd('/Users/john/my-project')
 * // Returns: "/Users/john/my-project/.roo"
 *
 * const windowsProjectDir = getProjectRooDirectoryForCwd('C:\\Users\\john\\my-project')
 * // Returns: "C:\\Users\\john\\my-project\\.roo"
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/my-project/
 * ├── .roo/                    # Project-local configuration directory
 * │   ├── rules/
 * │   │   └── rules.md
 * │   ├── custom-instructions.md
 * │   └── config/
 * │       └── settings.json
 * ├── src/
 * │   └── index.ts
 * └── package.json
 * ```
 */
export const getProjectRooDirectoryForCwd = getLegacyProjectConfigDirectoryForCwd

/**
 * Checks if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dirPath)
		return stat.isDirectory()
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath)
		return stat.isFile()
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Reads a file safely, returning null if it doesn't exist
 */
export async function readFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") {
			return null
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Discovers all .roo directories in subdirectories of the workspace
 *
 * @param cwd - Current working directory (workspace root)
 * @returns Array of absolute paths to .roo directories found in subdirectories,
 *          sorted alphabetically. Does not include the root .roo directory.
 *
 * @example
 * ```typescript
 * const subfolderRoos = await discoverSubfolderRooDirectories('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/monorepo/package-a/.roo',
 * //   '/Users/john/monorepo/package-b/.roo',
 * //   '/Users/john/monorepo/packages/shared/.roo'
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/monorepo/
 * ├── .roo/                    # Root .roo (NOT included - use getProjectRooDirectoryForCwd)
 * ├── package-a/
 * │   └── .roo/                # Included
 * │       └── rules/
 * ├── package-b/
 * │   └── .roo/                # Included
 * │       └── rules-code/
 * └── packages/
 *     └── shared/
 *         └── .roo/            # Included (nested)
 *             └── rules/
 * ```
 */
export async function discoverSubfolderRooDirectories(cwd: string): Promise<string[]> {
	try {
		// Dynamic import to avoid vscode dependency at module load time
		// This is necessary because file-search.ts imports vscode, which is not
		// available in the webview context
		const { executeRipgrep } = await import("../search/file-search")

		// Use ripgrep to find any file inside any .roo directory
		// This efficiently discovers all .roo folders regardless of their content
		const args = [
			"--files",
			"--hidden",
			"--follow",
			"-g",
			"**/.roo/**",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			cwd,
		]

		const results = await executeRipgrep({ args, workspacePath: cwd })

		// Extract unique .roo directory paths
		const rooDirs = new Set<string>()
		const rootRooDir = path.join(cwd, ".roo")

		for (const result of results) {
			// Match paths like "subfolder/.roo/anything" or "subfolder/nested/.roo/anything"
			// Handle both forward slashes (Unix) and backslashes (Windows)
			const match = result.path.match(/^(.+?)[/\\]\.roo[/\\]/)
			if (match) {
				const rooDir = path.join(cwd, match[1], ".roo")
				// Exclude the root .roo directory (already handled by getProjectRooDirectoryForCwd)
				if (rooDir !== rootRooDir) {
					rooDirs.add(rooDir)
				}
			}
		}

		// Return sorted alphabetically
		return Array.from(rooDirs).sort()
	} catch (error) {
		// If discovery fails (e.g., ripgrep not available), return empty array
		return []
	}
}

/**
 * Discovers active configuration directories in subdirectories of the workspace
 * using Zoo-first / Roo-fallback semantics.
 */
export async function discoverSubfolderConfigDirectories(cwd: string): Promise<string[]> {
	try {
		const { executeRipgrep } = await import("../search/file-search")

		const args = [
			"--files",
			"--hidden",
			"--follow",
			"-g",
			"**/.zoo/**",
			"-g",
			"**/.roo/**",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			cwd,
		]

		const results = await executeRipgrep({ args, workspacePath: cwd })
		const directoryTypeByParent = new Map<string, "zoo" | "roo">()

		for (const result of results) {
			const match = result.path.match(/^(.+?)[/\\]\.(zoo|roo)[/\\]/)
			if (match) {
				const parentDir = path.join(cwd, match[1])
				const configType = match[2] as "zoo" | "roo"

				if (configType === "zoo" || !directoryTypeByParent.has(parentDir)) {
					directoryTypeByParent.set(parentDir, configType)
				}
			}
		}

		return Array.from(directoryTypeByParent.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([parentDir, configType]) => path.join(parentDir, configType === "zoo" ? ".zoo" : ".roo"))
	} catch (error) {
		return []
	}
}

/**
 * Gets the ordered list of active configuration directories to check (global first, then project-local)
 * using Zoo-first / Roo-fallback semantics.
 */
export async function getConfigDirectoriesForCwd(cwd: string): Promise<string[]> {
	const [globalResolution, projectResolution] = await Promise.all([
		resolveGlobalConfigDirectory(),
		resolveProjectConfigDirectoryForCwd(cwd),
	])

	return [globalResolution.activePath, projectResolution.activePath]
}

/**
 * Gets the ordered list of all active configuration directories including subdirectories.
 */
export async function getAllConfigDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories = await getConfigDirectoriesForCwd(cwd)
	const subfolderDirectories = await discoverSubfolderConfigDirectories(cwd)

	return [...directories, ...subfolderDirectories]
}

/**
 * Gets the ordered list of .roo directories to check (global first, then project-local)
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths to check in order [global, project-local]
 *
 * @example
 * ```typescript
 * // For a project at /Users/john/my-project
 * const directories = getRooDirectoriesForCwd('/Users/john/my-project')
 * // Returns:
 * // [
 * //   '/Users/john/.roo',           // Global directory
 * //   '/Users/john/my-project/.roo' // Project-local directory
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/
 * ├── .roo/                    # Global configuration
 * │   ├── rules/
 * │   │   └── rules.md
 * │   └── custom-instructions.md
 * └── my-project/
 *     ├── .roo/                # Project-specific configuration
 *     │   ├── rules/
 *     │   │   └── rules.md     # Overrides global rules
 *     │   └── project-notes.md
 *     └── src/
 *         └── index.ts
 * ```
 */
export function getRooDirectoriesForCwd(cwd: string): string[] {
	const directories: string[] = []

	// Add global directory first
	directories.push(getLegacyGlobalConfigDirectory())

	// Add project-local directory second
	directories.push(getLegacyProjectConfigDirectoryForCwd(cwd))

	return directories
}

/**
 * Gets the ordered list of all .roo directories including subdirectories
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths in order: [global, project-local, ...subfolders (alphabetically)]
 *
 * @example
 * ```typescript
 * // For a monorepo at /Users/john/monorepo with .roo in subfolders
 * const directories = await getAllRooDirectoriesForCwd('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/.roo',                    // Global directory
 * //   '/Users/john/monorepo/.roo',           // Project-local directory
 * //   '/Users/john/monorepo/package-a/.roo', // Subfolder (alphabetical)
 * //   '/Users/john/monorepo/package-b/.roo'  // Subfolder (alphabetical)
 * // ]
 * ```
 */
export async function getAllRooDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories: string[] = []

	// Add global directory first
	directories.push(getLegacyGlobalConfigDirectory())

	// Add project-local directory second
	directories.push(getLegacyProjectConfigDirectoryForCwd(cwd))

	// Discover and add subfolder .roo directories
	const subfolderDirs = await discoverSubfolderRooDirectories(cwd)
	directories.push(...subfolderDirs)

	return directories
}

/**
 * Gets parent directories containing .roo folders, in order from root to subfolders
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of parent directory paths (not .roo paths) containing AGENTS.md or .roo
 *
 * @example
 * ```typescript
 * const dirs = await getAgentsDirectoriesForCwd('/Users/john/monorepo')
 * // Returns: ['/Users/john/monorepo', '/Users/john/monorepo/package-a', ...]
 * ```
 */
export async function getAgentsDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories: string[] = []

	// Always include the root directory
	directories.push(cwd)

	// Get all subfolder active configuration directories
	const subfolderRooDirs = await discoverSubfolderConfigDirectories(cwd)

	// Extract parent directories (remove .roo from path)
	for (const rooDir of subfolderRooDirs) {
		const parentDir = path.dirname(rooDir)
		directories.push(parentDir)
	}

	return directories
}

/**
 * Loads configuration from multiple .roo directories with project overriding global
 *
 * @param relativePath - The relative path within each .roo directory (e.g., 'rules/rules.md')
 * @param cwd - Current working directory (project path)
 * @returns Object with global and project content, plus merged content
 *
 * @example
 * ```typescript
 * // Load rules configuration for a project
 * const config = await loadConfiguration('rules/rules.md', '/Users/john/my-project')
 *
 * // Returns:
 * // {
 * //   global: "Global rules content...",     // From ~/.roo/rules/rules.md
 * //   project: "Project rules content...",   // From /Users/john/my-project/.roo/rules/rules.md
 * //   merged: "Global rules content...\n\n# Project-specific rules (override global):\n\nProject rules content..."
 * // }
 * ```
 *
 * @example File paths resolved:
 * ```
 * relativePath: 'rules/rules.md'
 * cwd: '/Users/john/my-project'
 *
 * Reads from:
 * - Global: /Users/john/.roo/rules/rules.md
 * - Project: /Users/john/my-project/.roo/rules/rules.md
 *
 * Other common relativePath examples:
 * - 'custom-instructions.md'
 * - 'config/settings.json'
 * - 'templates/component.tsx'
 * ```
 *
 * @example Merging behavior:
 * ```
 * // If only global exists:
 * { global: "content", project: null, merged: "content" }
 *
 * // If only project exists:
 * { global: null, project: "content", merged: "content" }
 *
 * // If both exist:
 * {
 *   global: "global content",
 *   project: "project content",
 *   merged: "global content\n\n# Project-specific rules (override global):\n\nproject content"
 * }
 * ```
 */
export async function loadConfiguration(
	relativePath: string,
	cwd: string,
): Promise<{
	global: string | null
	project: string | null
	merged: string
}> {
	const globalDir = (await resolveGlobalConfigDirectory()).activePath
	const projectDir = (await resolveProjectConfigDirectoryForCwd(cwd)).activePath

	const globalFilePath = path.join(globalDir, relativePath)
	const projectFilePath = path.join(projectDir, relativePath)

	// Read global configuration
	const globalContent = await readFileIfExists(globalFilePath)

	// Read project-local configuration
	const projectContent = await readFileIfExists(projectFilePath)

	// Merge configurations - project overrides global
	let merged = ""

	if (globalContent) {
		merged += globalContent
	}

	if (projectContent) {
		if (merged) {
			merged += "\n\n# Project-specific rules (override global):\n\n"
		}
		merged += projectContent
	}

	return {
		global: globalContent,
		project: projectContent,
		merged: merged || "",
	}
}

// Export with backward compatibility alias
export const loadRooConfiguration: typeof loadConfiguration = loadConfiguration
