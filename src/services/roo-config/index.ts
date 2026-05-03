import * as path from "path"
import * as os from "os"
import { constants as fsConstants } from "fs"
import fs from "fs/promises"
import type {
	ZooMigrationCopyOnlyResult,
	ZooMigrationCopyOnlySkippedReason,
	ZooMigrationCopyOnlySurfaceResult,
	ZooMigrationSurfaceId,
} from "@roo-code/types"

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

export type ZooMigrationActiveSource = "canonical" | "legacy" | "none"

export type ZooBootstrapSkippedReason = "canonical-exists" | "legacy-missing"

export interface ZooBootstrapResult {
	before: ZooPathResolution
	after: ZooPathResolution
	copied: boolean
	copySourcePath: string | null
	copyDestinationPath: string | null
	skippedReason: ZooBootstrapSkippedReason | null
}

export interface ZooMigrationSurfaceState extends ZooPathResolution {
	activeSource: ZooMigrationActiveSource
	bootstrapEligible: boolean
	copyOnlyMigrationActionAvailable: boolean
	partialCanonicalRiskDetected: boolean
}

export interface GlobalFileBackedZooMigrationState {
	configRoot: ZooMigrationSurfaceState
	partialCanonicalRiskDetected: boolean
	copyOnlyMigrationActionAvailable: boolean
}

export interface ProjectZooMigrationState {
	configRoot: ZooMigrationSurfaceState
	customModes: ZooMigrationSurfaceState
	ignore: ZooMigrationSurfaceState
	mcp: ZooMigrationSurfaceState
	partialCanonicalRiskDetected: boolean
	copyOnlyMigrationActionAvailable: boolean
}

export interface ZooMigrationStateSummary {
	globalFileBacked: GlobalFileBackedZooMigrationState
	project: ProjectZooMigrationState
}

export interface GetGlobalFileBackedZooMigrationStateOptions {
	additionalMigrationSensitiveResolutions?: ZooPathResolution[]
}

export interface GetProjectZooMigrationStateOptions {
	additionalRootMigrationSensitiveResolutions?: ZooPathResolution[]
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

function getActiveSourceForResolution(resolution: ZooPathResolution): ZooMigrationActiveSource {
	if (resolution.canonicalExists) {
		return "canonical"
	}

	if (resolution.legacyExists) {
		return "legacy"
	}

	return "none"
}

async function bootstrapCanonicalPathFromLegacy(
	resolution: ZooPathResolution,
	entityType: ZooPathEntityType,
): Promise<ZooBootstrapResult> {
	if (!resolution.shouldBootstrapCanonicalFromLegacy) {
		return {
			before: resolution,
			after: resolution,
			copied: false,
			copySourcePath: null,
			copyDestinationPath: null,
			skippedReason: resolution.canonicalExists ? "canonical-exists" : "legacy-missing",
		}
	}

	await fs.mkdir(path.dirname(resolution.canonicalPath), { recursive: true })

	if (entityType === "directory") {
		await fs.cp(resolution.legacyPath, resolution.canonicalPath, {
			recursive: true,
			force: false,
			errorOnExist: true,
		})
	} else {
		await fs.copyFile(resolution.legacyPath, resolution.canonicalPath, fsConstants.COPYFILE_EXCL)
	}

	return {
		before: resolution,
		after: await resolveZooPathPair(resolution.canonicalPath, resolution.legacyPath, entityType),
		copied: true,
		copySourcePath: resolution.legacyPath,
		copyDestinationPath: resolution.canonicalPath,
		skippedReason: null,
	}
}

export async function bootstrapCanonicalConfigRootFromLegacy(
	resolution: ZooPathResolution,
): Promise<ZooBootstrapResult> {
	return bootstrapCanonicalPathFromLegacy(resolution, "directory")
}

export async function ensureCanonicalConfigRootForWrite(resolution: ZooPathResolution): Promise<ZooPathResolution> {
	if (resolution.canonicalExists) {
		return resolution
	}

	if (resolution.shouldBootstrapCanonicalFromLegacy) {
		return (await bootstrapCanonicalConfigRootFromLegacy(resolution)).after
	}

	await fs.mkdir(resolution.canonicalPath, { recursive: true })

	return {
		canonicalPath: resolution.canonicalPath,
		legacyPath: resolution.legacyPath,
		activePath: resolution.canonicalPath,
		canonicalExists: true,
		legacyExists: resolution.legacyExists,
		activeExists: true,
		shouldBootstrapCanonicalFromLegacy: false,
	}
}

export async function bootstrapCanonicalDotfileFromLegacy(resolution: ZooPathResolution): Promise<ZooBootstrapResult> {
	return bootstrapCanonicalPathFromLegacy(resolution, "file")
}

export function detectPartialCanonicalRootRisk(
	rootResolution: ZooPathResolution,
	migrationSensitiveResolutions: ZooPathResolution[],
): boolean {
	if (!rootResolution.canonicalExists || !rootResolution.legacyExists) {
		return false
	}

	return migrationSensitiveResolutions.some((resolution) => !resolution.canonicalExists && resolution.legacyExists)
}

export function summarizeZooMigrationPathState(
	resolution: ZooPathResolution,
	options?: { partialCanonicalRiskDetected?: boolean },
): ZooMigrationSurfaceState {
	const bootstrapEligible = resolution.shouldBootstrapCanonicalFromLegacy

	return {
		...resolution,
		activeSource: getActiveSourceForResolution(resolution),
		bootstrapEligible,
		copyOnlyMigrationActionAvailable: bootstrapEligible,
		partialCanonicalRiskDetected: options?.partialCanonicalRiskDetected ?? false,
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

export async function ensureCanonicalGlobalConfigRootForWrite(): Promise<ZooPathResolution> {
	return ensureCanonicalConfigRootForWrite(await resolveGlobalConfigDirectory())
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

export async function ensureCanonicalProjectConfigRootForCwd(cwd: string): Promise<ZooPathResolution> {
	return ensureCanonicalConfigRootForWrite(await resolveProjectConfigDirectoryForCwd(cwd))
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

export async function getGlobalFileBackedZooMigrationState(
	options?: GetGlobalFileBackedZooMigrationStateOptions,
): Promise<GlobalFileBackedZooMigrationState> {
	const configRootResolution = await resolveGlobalConfigDirectory()
	const partialCanonicalRiskDetected = detectPartialCanonicalRootRisk(
		configRootResolution,
		options?.additionalMigrationSensitiveResolutions ?? [],
	)
	const configRoot = summarizeZooMigrationPathState(configRootResolution, { partialCanonicalRiskDetected })

	return {
		configRoot,
		partialCanonicalRiskDetected,
		copyOnlyMigrationActionAvailable: configRoot.copyOnlyMigrationActionAvailable,
	}
}

export async function getProjectZooMigrationStateForCwd(
	cwd: string,
	options?: GetProjectZooMigrationStateOptions,
): Promise<ProjectZooMigrationState> {
	const [configRootResolution, customModesResolution, ignoreResolution, mcpResolution] = await Promise.all([
		resolveProjectConfigDirectoryForCwd(cwd),
		resolveProjectCustomModesFileForCwd(cwd),
		resolveProjectIgnoreFileForCwd(cwd),
		resolveProjectMcpFileForCwd(cwd),
	])

	const partialCanonicalRiskDetected = detectPartialCanonicalRootRisk(configRootResolution, [
		mcpResolution,
		...(options?.additionalRootMigrationSensitiveResolutions ?? []),
	])

	const configRoot = summarizeZooMigrationPathState(configRootResolution, { partialCanonicalRiskDetected })
	const customModes = summarizeZooMigrationPathState(customModesResolution)
	const ignore = summarizeZooMigrationPathState(ignoreResolution)
	const mcp = summarizeZooMigrationPathState(mcpResolution)

	return {
		configRoot,
		customModes,
		ignore,
		mcp,
		partialCanonicalRiskDetected,
		copyOnlyMigrationActionAvailable: [configRoot, customModes, ignore, mcp].some(
			(surface) => surface.copyOnlyMigrationActionAvailable,
		),
	}
}

export async function getZooMigrationStateSummaryForCwd(cwd: string): Promise<ZooMigrationStateSummary> {
	const [globalFileBacked, project] = await Promise.all([
		getGlobalFileBackedZooMigrationState(),
		getProjectZooMigrationStateForCwd(cwd),
	])

	return {
		globalFileBacked,
		project,
	}
}

function createSkippedCopyOnlySurfaceResult(
	surface: ZooMigrationSurfaceId,
	resolution: ZooPathResolution,
	reason: ZooMigrationCopyOnlySkippedReason,
): ZooMigrationCopyOnlySurfaceResult {
	return {
		surface,
		status: "skipped",
		sourcePath: resolution.legacyExists ? resolution.legacyPath : null,
		destinationPath: resolution.canonicalPath,
		reason,
	}
}

async function runCopyOnlyMigrationForSurface(
	surface: ZooMigrationSurfaceId,
	resolution: ZooPathResolution,
	entityType: ZooPathEntityType,
): Promise<ZooMigrationCopyOnlySurfaceResult> {
	if (!resolution.shouldBootstrapCanonicalFromLegacy) {
		const reason: ZooMigrationCopyOnlySkippedReason = resolution.canonicalExists
			? "canonical-exists"
			: resolution.legacyExists
				? "not-eligible"
				: "legacy-missing"

		return createSkippedCopyOnlySurfaceResult(surface, resolution, reason)
	}

	try {
		const result =
			entityType === "directory"
				? await bootstrapCanonicalConfigRootFromLegacy(resolution)
				: await bootstrapCanonicalDotfileFromLegacy(resolution)

		if (!result.copied) {
			return createSkippedCopyOnlySurfaceResult(surface, resolution, result.skippedReason ?? "not-eligible")
		}

		return {
			surface,
			status: "copied",
			sourcePath: result.copySourcePath,
			destinationPath: result.copyDestinationPath,
		}
	} catch (error) {
		return {
			surface,
			status: "failed",
			sourcePath: resolution.legacyExists ? resolution.legacyPath : null,
			destinationPath: resolution.canonicalPath,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function markResolutionCanonical(resolution: ZooPathResolution): ZooPathResolution {
	return {
		canonicalPath: resolution.canonicalPath,
		legacyPath: resolution.legacyPath,
		activePath: resolution.canonicalPath,
		canonicalExists: true,
		legacyExists: resolution.legacyExists,
		activeExists: true,
		shouldBootstrapCanonicalFromLegacy: false,
	}
}

export async function runZooMigrationCopyOnlyForCwd(cwd: string): Promise<ZooMigrationCopyOnlyResult> {
	const [globalResolution, projectRootResolution, customModesResolution, ignoreResolution, mcpResolution] =
		await Promise.all([
			resolveGlobalConfigDirectory(),
			resolveProjectConfigDirectoryForCwd(cwd),
			resolveProjectCustomModesFileForCwd(cwd),
			resolveProjectIgnoreFileForCwd(cwd),
			resolveProjectMcpFileForCwd(cwd),
		])

	const globalRootResult = await runCopyOnlyMigrationForSurface(
		"globalFileBacked.configRoot",
		globalResolution,
		"directory",
	)
	const projectRootResult = await runCopyOnlyMigrationForSurface(
		"project.configRoot",
		projectRootResolution,
		"directory",
	)
	const effectiveMcpResolution =
		projectRootResult.status === "copied" ? markResolutionCanonical(mcpResolution) : mcpResolution

	const nestedResults = await Promise.all([
		runCopyOnlyMigrationForSurface("project.customModes", customModesResolution, "file"),
		runCopyOnlyMigrationForSurface("project.ignore", ignoreResolution, "file"),
		runCopyOnlyMigrationForSurface("project.mcp", effectiveMcpResolution, "file"),
	])

	const results = [globalRootResult, projectRootResult, ...nestedResults]

	const summary = await getZooMigrationStateSummaryForCwd(cwd)

	return {
		results,
		summary,
		copiedCount: results.filter((result) => result.status === "copied").length,
		skippedCount: results.filter((result) => result.status === "skipped").length,
		failedCount: results.filter((result) => result.status === "failed").length,
	}
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
 * Reads a child file from a config root using canonical-first semantics, with a
 * same-scope legacy fallback only when a canonical root already exists but the
 * specific child file does not.
 */
export async function readConfigChildFileWithLegacyFallback(
	rootResolution: ZooPathResolution,
	relativeFilePath: string,
): Promise<string | null> {
	if (rootResolution.canonicalExists) {
		const canonicalContent = await readFileIfExists(path.join(rootResolution.canonicalPath, relativeFilePath))
		if (canonicalContent !== null) {
			return canonicalContent
		}

		if (rootResolution.legacyExists) {
			return readFileIfExists(path.join(rootResolution.legacyPath, relativeFilePath))
		}

		return null
	}

	if (rootResolution.legacyExists) {
		return readFileIfExists(path.join(rootResolution.legacyPath, relativeFilePath))
	}

	return null
}

/**
 * Resolves a child directory from a config root using canonical-first semantics,
 * with a same-scope legacy fallback only when a canonical root already exists
 * but the specific child directory does not.
 */
export async function resolveConfigChildDirectoryWithLegacyFallback(
	rootResolution: ZooPathResolution,
	relativeDirectoryPath: string,
): Promise<string | null> {
	if (rootResolution.canonicalExists) {
		const canonicalDirectory = path.join(rootResolution.canonicalPath, relativeDirectoryPath)
		if (await directoryExists(canonicalDirectory)) {
			return canonicalDirectory
		}

		if (rootResolution.legacyExists) {
			const legacyDirectory = path.join(rootResolution.legacyPath, relativeDirectoryPath)
			if (await directoryExists(legacyDirectory)) {
				return legacyDirectory
			}
		}

		return null
	}

	if (rootResolution.legacyExists) {
		const legacyDirectory = path.join(rootResolution.legacyPath, relativeDirectoryPath)
		return (await directoryExists(legacyDirectory)) ? legacyDirectory : null
	}

	return null
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
 * Discovers active/canonical subfolder configuration root resolutions using
 * Zoo-first / Roo-fallback semantics.
 */
export async function discoverSubfolderConfigDirectoryResolutions(cwd: string): Promise<ZooPathResolution[]> {
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
		const presenceByParent = new Map<string, { canonicalExists: boolean; legacyExists: boolean }>()

		for (const result of results) {
			const match = result.path.match(/^(.+?)[/\\]\.(zoo|roo)[/\\]/)
			if (!match) {
				continue
			}

			const parentDir = path.join(cwd, match[1])
			const configType = match[2] as "zoo" | "roo"
			const current = presenceByParent.get(parentDir) ?? { canonicalExists: false, legacyExists: false }

			if (configType === "zoo") {
				current.canonicalExists = true
			} else {
				current.legacyExists = true
			}

			presenceByParent.set(parentDir, current)
		}

		return Array.from(presenceByParent.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([parentDir, presence]) => {
				const canonicalPath = path.join(parentDir, ZOO_CONFIG_DIRECTORY_NAME)
				const legacyPath = path.join(parentDir, ROO_CONFIG_DIRECTORY_NAME)
				const activePath = !presence.canonicalExists && presence.legacyExists ? legacyPath : canonicalPath

				return {
					canonicalPath,
					legacyPath,
					activePath,
					canonicalExists: presence.canonicalExists,
					legacyExists: presence.legacyExists,
					activeExists: presence.canonicalExists || presence.legacyExists,
					shouldBootstrapCanonicalFromLegacy: !presence.canonicalExists && presence.legacyExists,
				}
			})
	} catch (error) {
		return []
	}
}

/**
 * Gets the ordered list of active configuration directories to check (global first, then project-local)
 * using Zoo-first / Roo-fallback semantics.
 */
export async function getConfigDirectoriesForCwd(cwd: string): Promise<string[]> {
	const resolutions = await getConfigDirectoryResolutionsForCwd(cwd)
	return resolutions.map((resolution) => resolution.activePath)
}

/**
 * Gets the ordered list of active configuration root resolutions to check
 * (global first, then project-local).
 */
export async function getConfigDirectoryResolutionsForCwd(cwd: string): Promise<ZooPathResolution[]> {
	const [globalResolution, projectResolution] = await Promise.all([
		resolveGlobalConfigDirectory(),
		resolveProjectConfigDirectoryForCwd(cwd),
	])

	return [globalResolution, projectResolution]
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
 * Gets the ordered list of all configuration root resolutions including subdirectories.
 */
export async function getAllConfigDirectoryResolutionsForCwd(cwd: string): Promise<ZooPathResolution[]> {
	const directories = await getConfigDirectoryResolutionsForCwd(cwd)
	const subfolderDirectories = await discoverSubfolderConfigDirectoryResolutions(cwd)

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
	const [globalResolution, projectResolution] = await Promise.all([
		resolveGlobalConfigDirectory(),
		resolveProjectConfigDirectoryForCwd(cwd),
	])

	// Read global and project-local configuration with same-scope legacy fallback
	// for partial canonical roots created by historical app-managed writes.
	const [globalContent, projectContent] = await Promise.all([
		readConfigChildFileWithLegacyFallback(globalResolution, relativePath),
		readConfigChildFileWithLegacyFallback(projectResolution, relativePath),
	])

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
