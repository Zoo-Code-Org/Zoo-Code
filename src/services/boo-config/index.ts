import * as path from "path"
import * as os from "os"
import fs from "fs/promises"
import * as yaml from "yaml"

/**
 * Gets the global .boo directory path based on the current platform
 */
export function getGlobalBooDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ".boo")
}

/**
 * Gets the project-local .boo directory path for a given cwd
 */
export function getProjectBooDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ".boo")
}

/**
 * Check if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dirPath)
		return stat.isDirectory()
	} catch (error: any) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		throw error
	}
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath)
		return stat.isFile()
	} catch (error: any) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		throw error
	}
}

/**
 * Safely read a file, returning null if it doesn't exist
 */
export async function readFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
	} catch (error: any) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") {
			return null
		}
		throw error
	}
}

/**
 * Gets ordered list of .boo directories (global first, then project-local)
 */
export function getBooDirectoriesForCwd(cwd: string): string[] {
	return [getGlobalBooDirectory(), getProjectBooDirectoryForCwd(cwd)]
}

export interface BooCollaborateConfig {
	drafting_model?: string | null
}

export interface BooKnowledgeLookupConfig {
	lookup_model?: string | null
}

export interface BooConfig {
	collaborate?: BooCollaborateConfig
	knowledge_lookup?: BooKnowledgeLookupConfig
}

function parseProfileString(raw: unknown): string | null {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
}

/**
 * Reads and parses .boo/config.yaml from the given project root (cwd).
 * Returns an empty object if the file is missing or malformed.
 * Normalizes blank profile strings to null.
 */
export async function readProjectBooConfig(cwd: string): Promise<BooConfig> {
	const configPath = path.join(cwd, ".boo", "config.yaml")
	const content = await readFileIfExists(configPath)

	if (content === null) {
		return {}
	}

	let parsed: unknown
	try {
		parsed = yaml.parse(content)
	} catch {
		console.warn(`[boo-config] Failed to parse .boo/config.yaml: invalid YAML`)
		return {}
	}

	if (!parsed || typeof parsed !== "object") {
		return {}
	}

	const raw = parsed as Record<string, unknown>
	const result: BooConfig = {}

	const collaborate = raw["collaborate"]
	if (collaborate && typeof collaborate === "object") {
		const c = collaborate as Record<string, unknown>
		result.collaborate = { drafting_model: parseProfileString(c["drafting_model"]) }
	}

	const knowledgeLookup = raw["knowledge_lookup"]
	if (knowledgeLookup && typeof knowledgeLookup === "object") {
		const k = knowledgeLookup as Record<string, unknown>
		result.knowledge_lookup = { lookup_model: parseProfileString(k["lookup_model"]) }
	}

	if (Object.keys(result).length === 0) {
		return {}
	}

	return result
}
