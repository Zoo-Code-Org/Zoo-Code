/**
 * CustomToolRegistry - A reusable class for dynamically loading and managing TypeScript tools.
 *
 * Features:
 * - Dynamic TypeScript/JavaScript tool loading with esbuild transpilation.
 * - Runtime validation of tool definitions.
 * - Tool execution with context.
 * - JSON Schema generation for LLM integration.
 */

import fs from "fs"
import path from "path"
import { createHash, randomUUID } from "crypto"
import os from "os"

import type { CustomToolDefinition, SerializedCustomToolDefinition, CustomToolParametersSchema } from "@roo-code/types"

import type { StoredCustomTool, LoadResult } from "./types.js"
import { serializeCustomTool } from "./serialize.js"
import { runEsbuild, EsbuildSourceError, NODE_BUILTIN_MODULES, COMMONJS_REQUIRE_BANNER } from "./esbuild-runner.js"

export interface RegistryOptions {
	/** Directory for caching compiled TypeScript files. Explicit paths are not supported on Windows. */
	cacheDir?: string
	/** Additional paths for resolving node modules (useful for tools outside node_modules). */
	nodePaths?: string[]
	/** Path to the extension root directory (for finding bundled esbuild binary in production). */
	extensionPath?: string
}

export class CustomToolRegistry {
	private tools = new Map<string, StoredCustomTool>()
	private cacheDir: string
	private nodePaths: string[]
	private extensionPath?: string
	private lastLoaded: Map<string, number> = new Map()
	private sourceFailures = new Map<string, { mtimeMs: number; error: EsbuildSourceError }>()

	constructor(options?: RegistryOptions) {
		// This check cannot verify Windows ACLs. Reject explicit roots before disk access.
		if (process.platform === "win32" && options?.cacheDir !== undefined) {
			throw new Error("Explicit custom tool cache paths are not supported on Windows")
		}
		// Normalize the configured root. Preparation also resolves platform aliases.
		this.cacheDir = path.resolve(
			options?.cacheDir ??
				path.join(
					process.platform === "win32" ? os.homedir() : os.tmpdir(),
					`dynamic-tools-cache-${process.getuid?.() ?? "user"}`,
				),
		)
		// Default to current working directory's node_modules.
		this.nodePaths = options?.nodePaths ?? [path.join(process.cwd(), "node_modules")]
		this.extensionPath = options?.extensionPath
	}

	/**
	 * Load all tools from a directory.
	 * Supports both .ts and .js files.
	 *
	 * @param toolDir - Absolute path to the tools directory
	 * @returns LoadResult with lists of loaded and failed tools
	 */
	async loadFromDirectory(toolDir: string): Promise<LoadResult> {
		const result: LoadResult = { loaded: [], failed: [] }

		try {
			if (!fs.existsSync(toolDir)) {
				return result
			}

			const files = fs.readdirSync(toolDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"))

			for (const file of files) {
				const filePath = path.join(toolDir, file)

				try {
					console.log(`[CustomToolRegistry] importing tool from ${filePath}`)
					const mod = await this.import(filePath)

					for (const [exportName, value] of Object.entries(mod)) {
						const def = this.validate(exportName, value)

						if (!def) {
							continue
						}

						this.tools.set(def.name, { ...def, source: filePath })
						console.log(`[CustomToolRegistry] loaded tool ${def.name} from ${filePath}`)
						result.loaded.push(def.name)
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					console.error(`[CustomToolRegistry] import(${filePath}) failed: ${message}`)
					result.failed.push({ file, error: message })
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`[CustomToolRegistry] loadFromDirectory(${toolDir}) failed: ${message}`)
			result.failed.push({ file: toolDir, error: message })
		}

		return result
	}

	async loadFromDirectoryIfStale(toolDir: string): Promise<LoadResult> {
		if (!fs.existsSync(toolDir)) {
			return { loaded: [], failed: [] }
		}

		const lastLoaded = this.lastLoaded.get(toolDir)
		const stat = fs.statSync(toolDir)
		const isStale = lastLoaded === undefined || stat.mtimeMs > lastLoaded

		if (isStale) {
			const result = await this.loadFromDirectory(toolDir)
			if (result.failed.length === 0) {
				this.lastLoaded.set(toolDir, stat.mtimeMs)
			} else {
				this.lastLoaded.delete(toolDir)
			}
			return result
		}

		return { loaded: this.list(), failed: [] }
	}

	/**
	 * Load all tools from multiple directories.
	 * Directories are processed in order, so later directories can override tools from earlier ones.
	 * Supports both .ts and .js files.
	 *
	 * @param toolDirs - Array of absolute paths to tools directories
	 * @returns LoadResult with lists of loaded and failed tools from all directories
	 */
	async loadFromDirectories(toolDirs: string[]): Promise<LoadResult> {
		const result: LoadResult = { loaded: [], failed: [] }

		for (const toolDir of toolDirs) {
			const dirResult = await this.loadFromDirectory(toolDir)
			result.loaded.push(...dirResult.loaded)
			result.failed.push(...dirResult.failed)
		}

		return result
	}

	/**
	 * Load all tools from multiple directories if any has become stale.
	 * Directories are processed in order, so later directories can override tools from earlier ones.
	 *
	 * @param toolDirs - Array of absolute paths to tools directories
	 * @returns LoadResult with lists of loaded and failed tools
	 */
	async loadFromDirectoriesIfStale(toolDirs: string[]): Promise<LoadResult> {
		const result: LoadResult = { loaded: [], failed: [] }

		for (const toolDir of toolDirs) {
			const dirResult = await this.loadFromDirectoryIfStale(toolDir)
			result.loaded.push(...dirResult.loaded)
			result.failed.push(...dirResult.failed)
		}

		return result
	}

	/**
	 * Register a tool directly (without loading from file).
	 */
	register(definition: CustomToolDefinition, source?: string): void {
		const { name: id } = definition
		const validated = this.validate(id, definition)

		if (!validated) {
			throw new Error(`Invalid tool definition for '${id}'`)
		}

		const storedTool: StoredCustomTool = source ? { ...validated, source } : validated
		this.tools.set(id, storedTool)
	}

	/**
	 * Unregister a tool by ID.
	 */
	unregister(id: string): boolean {
		return this.tools.delete(id)
	}

	/**
	 * Get a tool by ID.
	 */
	get(id: string): CustomToolDefinition | undefined {
		return this.tools.get(id)
	}

	/**
	 * Check if a tool exists.
	 */
	has(id: string): boolean {
		return this.tools.has(id)
	}

	/**
	 * Get all registered tool IDs.
	 */
	list(): string[] {
		return Array.from(this.tools.keys())
	}

	/**
	 * Get all registered tools.
	 */
	getAll(): CustomToolDefinition[] {
		return Array.from(this.tools.values())
	}

	/**
	 * Get all registered tools in the serialized format.
	 */
	getAllSerialized(): SerializedCustomToolDefinition[] {
		return this.getAll().map(serializeCustomTool)
	}

	/**
	 * Get the number of registered tools.
	 */
	get size(): number {
		return this.tools.size
	}

	/**
	 * Clear all registered tools.
	 */
	clear(): void {
		this.tools.clear()
	}

	/**
	 * Set the extension path for finding bundled esbuild binary.
	 * This should be called with context.extensionPath when the extension activates.
	 */
	setExtensionPath(extensionPath: string): void {
		this.extensionPath = extensionPath
	}

	/**
	 * Get the current extension path.
	 */
	getExtensionPath(): string | undefined {
		return this.extensionPath
	}

	/** Reject cache paths that another account could supply or replace. */
	private validateCachePath(cachePath: string, directory: boolean): void {
		const stat = fs.lstatSync(cachePath)
		const uid = process.getuid?.()
		if (
			(directory ? !stat.isDirectory() : !stat.isFile()) ||
			(uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) ||
			(!directory && stat.nlink !== 1)
		) {
			throw new Error(`Unsafe custom tool cache path: ${cachePath}`)
		}
	}

	private prepareCacheDirectory(): void {
		// Resolve platform aliases (e.g. /var on macOS), then check ancestors before writing.
		let ancestor = path.dirname(this.cacheDir)
		const missing: string[] = []
		while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
			missing.unshift(path.basename(ancestor))
			ancestor = path.dirname(ancestor)
		}
		let parent = fs.realpathSync(ancestor)
		for (let current = parent; ; current = path.dirname(current)) {
			const stat = fs.statSync(current)
			const uid = process.getuid?.()
			if (
				uid !== undefined &&
				((stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0))
			) {
				throw new Error(`Unsafe custom tool cache parent: ${current}`)
			}
			if (path.dirname(current) === current) break
		}
		for (const component of missing) {
			parent = path.join(parent, component)
			fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
			this.validateCachePath(parent, true)
		}
		this.cacheDir = path.join(parent, path.basename(this.cacheDir))
		fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
		this.validateCachePath(this.cacheDir, true)
	}

	/**
	 * Clear the TypeScript compilation cache on disk.
	 * This removes all tool-specific subdirectories and their contents.
	 */
	clearCache(): void {
		this.lastLoaded.clear()
		this.sourceFailures.clear()

		if (fs.existsSync(this.cacheDir)) {
			try {
				this.prepareCacheDirectory()
				const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true })
				for (const entry of entries) {
					const entryPath = path.join(this.cacheDir, entry.name)
					try {
						if (entry.isDirectory()) {
							// Remove tool-specific subdirectory and all its contents.
							fs.rmSync(entryPath, { recursive: true, force: true })
						} else if (entry.name.endsWith(".mjs")) {
							// Also clean up any legacy flat .mjs files from older cache format.
							fs.unlinkSync(entryPath)
						}
					} catch (error) {
						console.error(`[CustomToolRegistry] clearCache failed for ${entryPath}: ${String(error)}`)
					}
				}
			} catch (error) {
				console.error(
					`[CustomToolRegistry] clearCache failed to clean disk cache: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	/**
	 * Dynamically import a TypeScript or JavaScript file.
	 * TypeScript files are transpiled on-the-fly using esbuild.
	 *
	 * For TypeScript files, esbuild bundles the code with these considerations:
	 * - Node.js built-in modules (fs, path, etc.) are kept external
	 * - npm packages are bundled with a CommonJS shim for require() compatibility
	 * - The tool's local node_modules is included in the resolution path
	 */
	private async import(filePath: string): Promise<Record<string, CustomToolDefinition>> {
		const absolutePath = path.resolve(filePath)
		const ext = path.extname(absolutePath)

		if (ext === ".js" || ext === ".mjs") {
			return import(`file://${absolutePath}`)
		}

		const stat = fs.statSync(absolutePath)
		// Version the entry format so older bundles cannot bypass env publication.
		const cacheKey = `v2:${absolutePath}:${stat.mtimeMs}`

		this.prepareCacheDirectory()

		const hash = createHash("sha256").update(cacheKey).digest("hex").slice(0, 16)

		// Use a tool-specific subdirectory to avoid .env file conflicts between tools.
		const toolCacheDir = path.join(this.cacheDir, hash)
		fs.mkdirSync(toolCacheDir, { recursive: true, mode: 0o700 })
		this.validateCachePath(toolCacheDir, true)

		const tempFile = path.join(toolCacheDir, "bundle.mjs")

		// Check if we have a cached version on disk (from a previous run/instance).
		if (fs.lstatSync(tempFile, { throwIfNoEntry: false })) {
			this.validateCachePath(tempFile, false)
			return import(`file://${tempFile}`)
		}

		// Remember a source diagnostic, not a missing or unsafe cache path.
		const failure = this.sourceFailures.get(absolutePath)
		if (failure?.mtimeMs === stat.mtimeMs) throw failure.error
		this.sourceFailures.delete(absolutePath)

		// Get the tool's directory to include its node_modules in resolution path.
		const toolDir = path.dirname(absolutePath)
		const toolNodeModules = path.join(toolDir, "node_modules")

		// Combine default nodePaths with tool-specific node_modules.
		// Tool's node_modules takes priority (listed first).
		const nodePaths = fs.existsSync(toolNodeModules) ? [toolNodeModules, ...this.nodePaths] : this.nodePaths

		// Bundle the TypeScript file with dependencies using esbuild CLI.
		// - Node.js built-ins are external (they can't be bundled and are always available)
		// - npm packages are bundled with CommonJS require() shim for compatibility
		const pendingFile = path.join(toolCacheDir, `bundle-${randomUUID()}.tmp.mjs`)
		try {
			await runEsbuild(
				{
					entryPoint: absolutePath,
					outfile: pendingFile,
					format: "esm",
					platform: "node",
					target: "node18",
					bundle: true,
					sourcemap: "inline",
					packages: "bundle",
					nodePaths,
					external: NODE_BUILTIN_MODULES,
					banner: COMMONJS_REQUIRE_BANNER,
				},
				this.extensionPath,
			)

			fs.chmodSync(pendingFile, 0o600)
			this.validateCachePath(pendingFile, false)
			this.copyEnvFiles(toolDir, toolCacheDir)
			// A concurrent cleanup can make esbuild recreate this directory with a loose mode.
			this.validateCachePath(toolCacheDir, true)
			// The bundle is the commit marker. Readers only reuse a complete entry.
			fs.renameSync(pendingFile, tempFile)
		} catch (error) {
			if (error instanceof EsbuildSourceError) {
				this.sourceFailures.set(absolutePath, { mtimeMs: stat.mtimeMs, error })
			}
			throw error
		} finally {
			fs.rmSync(pendingFile, { force: true })
		}

		return import(`file://${tempFile}`)
	}

	/**
	 * Copy .env files from the tool's source directory to the tool-specific cache directory.
	 * This allows tools that use dotenv with __dirname to find their .env files,
	 * while ensuring different tools' .env files don't overwrite each other.
	 *
	 * @param toolDir - The directory containing the tool source files
	 * @param destDir - The tool-specific cache directory to copy .env files to
	 */
	private copyEnvFiles(toolDir: string, destDir: string): void {
		const envFiles = fs.readdirSync(toolDir).filter((file) => file === ".env" || file.startsWith(".env."))
		for (const envFile of envFiles) {
			const source = path.join(toolDir, envFile)
			if (!fs.statSync(source).isFile()) continue
			const pending = path.join(destDir, `${envFile}-${randomUUID()}.tmp`)
			try {
				fs.copyFileSync(source, pending, fs.constants.COPYFILE_EXCL)
				fs.chmodSync(pending, 0o600)
				this.validateCachePath(pending, false)
				fs.renameSync(pending, path.join(destDir, envFile))
			} finally {
				fs.rmSync(pending, { force: true })
			}
		}
	}

	/**
	 * Check if a value is a Zod schema by looking for the _def property
	 * which is present on all Zod types.
	 */
	private isParametersSchema(value: unknown): value is CustomToolParametersSchema {
		return (
			value !== null &&
			typeof value === "object" &&
			"_def" in value &&
			typeof (value as Record<string, unknown>)._def === "object"
		)
	}

	/**
	 * Validate a tool definition and return a typed result.
	 * Returns null for non-tool exports, throws for invalid tools.
	 */
	private validate(exportName: string, value: unknown): CustomToolDefinition | null {
		// Quick pre-check to filter out non-objects.
		if (!value || typeof value !== "object") {
			return null
		}

		// Check if it looks like a tool (has execute function).
		if (!("execute" in value) || typeof (value as Record<string, unknown>).execute !== "function") {
			return null
		}

		const obj = value as Record<string, unknown>
		const errors: string[] = []

		// Validate name.
		if (typeof obj.name !== "string") {
			errors.push("name: Expected string")
		} else if (obj.name.length === 0) {
			errors.push("name: Tool must have a non-empty name")
		}

		// Validate description.
		if (typeof obj.description !== "string") {
			errors.push("description: Expected string")
		} else if (obj.description.length === 0) {
			errors.push("description: Tool must have a non-empty description")
		}

		// Validate parameters (optional).
		if (obj.parameters !== undefined && !this.isParametersSchema(obj.parameters)) {
			errors.push("parameters: parameters must be a Zod schema")
		}

		if (errors.length > 0) {
			throw new Error(`Invalid tool definition for '${exportName}': ${errors.join(", ")}`)
		}

		return value as CustomToolDefinition
	}
}

export const customToolRegistry = new CustomToolRegistry()
