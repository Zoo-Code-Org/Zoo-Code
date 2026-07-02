import fs from "fs/promises"
import * as path from "path"
import { Dirent } from "fs"

import type {
	CreateRuleInput,
	DeleteRuleInput,
	RuleKind,
	RuleLookupInput,
	RuleMetadata,
	RuleScope,
} from "@roo-code/types"
import { DEFAULT_MODES, type ModeConfig } from "@roo-code/types"

import { getGlobalRooDirectory, getProjectRooDirectoryForCwd } from "../roo-config"

const MAX_DEPTH = 5
const VALID_RULE_FILENAME_PATTERN = /^[a-z0-9_-]+(?:\.md)?$/

interface RuleFileInfo {
	originalPath: string
	resolvedPath: string
	isSymlink: boolean
}

interface RuleDirectoryInfo {
	scope: RuleScope
	kind: RuleKind
	modeSlug?: string
	modeName?: string
	directoryPath: string
}

export type RulesMode = Pick<ModeConfig, "slug" | "name">

export function shouldIncludeRuleFile(filename: string): boolean {
	const basename = path.basename(filename)
	if (!basename.toLowerCase().endsWith(".md")) {
		return false
	}

	const cachePatterns = [
		"*.DS_Store",
		"*.bak",
		"*.cache",
		"*.crdownload",
		"*.db",
		"*.dmp",
		"*.dump",
		"*.eslintcache",
		"*.lock",
		"*.log",
		"*.old",
		"*.part",
		"*.partial",
		"*.pyc",
		"*.pyo",
		"*.stackdump",
		"*.swo",
		"*.swp",
		"*.temp",
		"*.tmp",
		"Thumbs.db",
	]

	return !cachePatterns.some((pattern) => {
		if (pattern.startsWith("*.")) {
			const extension = pattern.slice(1)
			return basename.endsWith(extension)
		}

		return basename === pattern
	})
}

export async function getRules(cwd: string, options: { modes?: readonly RulesMode[] } = {}): Promise<RuleMetadata[]> {
	const directories = getRuleDirectories(cwd, options.modes)
	const rulesById = new Map<string, RuleMetadata>()

	for (const directory of directories) {
		const rules = await scanRuleDirectory(directory)
		for (const rule of rules) {
			rulesById.set(rule.id, rule)
		}
	}

	return Array.from(rulesById.values()).sort(compareRules)
}

export async function createRule(cwd: string, input: CreateRuleInput): Promise<string> {
	const directoryPath = getTargetRuleDirectory(cwd, input)
	const fileName = normalizeRuleFileName(input.fileName)
	const filePath = path.join(directoryPath, fileName)

	assertPathInsideDirectory(filePath, directoryPath)

	try {
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(filePath, createRuleTemplate(fileName, input), { encoding: "utf-8", flag: "wx" })
		return filePath
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Rule file already exists: ${fileName}`)
		}

		throw error
	}
}

export async function deleteRule(cwd: string, input: DeleteRuleInput): Promise<void> {
	const filePath = await resolveRuleFile(cwd, input)
	if (!filePath) {
		throw new Error("Rule file not found")
	}

	await fs.rm(filePath, { force: true })
}

export async function resolveRuleFile(cwd: string, input: RuleLookupInput): Promise<string | undefined> {
	const directoryPath = getTargetRuleDirectory(cwd, input)
	const relativePath = normalizeRelativeRulePath(input.relativePath)
	const filePath = path.resolve(directoryPath, relativePath)

	assertPathInsideDirectory(filePath, directoryPath)

	try {
		const stats = await fs.lstat(filePath)
		if (stats.isFile() || stats.isSymbolicLink()) {
			await assertRealPathInsideDirectory(filePath, directoryPath)
			return filePath
		}
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			return undefined
		}

		throw error
	}

	return undefined
}

export function getRulesDirectoryPath(
	cwd: string,
	input: Pick<CreateRuleInput, "scope" | "kind" | "modeSlug">,
): string {
	return getTargetRuleDirectory(cwd, input)
}

function getRuleDirectories(cwd: string, modes: readonly RulesMode[] = DEFAULT_MODES): RuleDirectoryInfo[] {
	const globalRooDirectory = getGlobalRooDirectory()
	const projectRooDirectory = getProjectRooDirectoryForCwd(cwd)
	const bases: Array<{ scope: RuleScope; basePath: string }> = [{ scope: "global", basePath: globalRooDirectory }]
	if (cwd) {
		bases.push({ scope: "project", basePath: projectRooDirectory })
	}

	return bases.flatMap(({ scope, basePath }) => [
		{
			scope,
			kind: "generic" as const,
			directoryPath: path.join(basePath, "rules"),
		},
		...modes.map((mode) => ({
			scope,
			kind: "mode" as const,
			modeSlug: mode.slug,
			modeName: mode.name,
			directoryPath: path.join(basePath, `rules-${mode.slug}`),
		})),
	])
}

async function scanRuleDirectory(directory: RuleDirectoryInfo): Promise<RuleMetadata[]> {
	try {
		const stats = await fs.stat(directory.directoryPath)
		if (!stats.isDirectory()) {
			return []
		}

		const entries = await fs.readdir(directory.directoryPath, { withFileTypes: true, recursive: true })
		const fileInfo: RuleFileInfo[] = []

		await Promise.all(
			entries.map((entry) =>
				resolveRuleDirectoryEntry(entry, directory.directoryPath, fileInfo, 0, directory.directoryPath),
			),
		)

		return fileInfo
			.filter(({ originalPath }) => shouldIncludeRuleFile(originalPath))
			.sort((a, b) => a.originalPath.toLowerCase().localeCompare(b.originalPath.toLowerCase()))
			.map(({ originalPath, resolvedPath, isSymlink }) => {
				const relativePath = path.relative(directory.directoryPath, originalPath)
				const name = path.basename(originalPath)
				return {
					id: createRuleId(directory.scope, directory.kind, directory.modeSlug, relativePath),
					name,
					scope: directory.scope,
					kind: directory.kind,
					modeSlug: directory.modeSlug,
					modeName: directory.modeName,
					filePath: resolvedPath,
					relativePath,
					directoryPath: directory.directoryPath,
					isSymlink,
				}
			})
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			return []
		}

		throw error
	}
}

async function resolveRuleDirectoryEntry(
	entry: Dirent,
	dirPath: string,
	fileInfo: RuleFileInfo[],
	depth: number,
	rulesDirectoryPath: string,
	originalDirPath = dirPath,
): Promise<void> {
	if (depth > MAX_DEPTH) {
		return
	}

	const fullPath = path.resolve(entry.parentPath || dirPath, entry.name)
	const originalPath = path.join(originalDirPath, path.relative(dirPath, fullPath))
	if (entry.isFile()) {
		if (await isRealPathInsideDirectory(fullPath, rulesDirectoryPath)) {
			fileInfo.push({ originalPath, resolvedPath: fullPath, isSymlink: originalPath !== fullPath })
		}
	} else if (entry.isSymbolicLink()) {
		await resolveRuleSymlink(fullPath, fileInfo, depth + 1, rulesDirectoryPath, originalPath)
	}
}

async function resolveRuleSymlink(
	symlinkPath: string,
	fileInfo: RuleFileInfo[],
	depth: number,
	rulesDirectoryPath: string,
	originalSymlinkPath = symlinkPath,
): Promise<void> {
	if (depth > MAX_DEPTH) {
		return
	}

	try {
		const linkTarget = await fs.readlink(symlinkPath)
		let realSymlinkDir: string
		try {
			realSymlinkDir = await fs.realpath(path.dirname(symlinkPath))
		} catch {
			realSymlinkDir = path.dirname(symlinkPath)
		}
		const resolvedTarget = path.resolve(realSymlinkDir, linkTarget)
		const stats = await fs.stat(resolvedTarget)

		if (!(await isRealPathInsideDirectory(resolvedTarget, rulesDirectoryPath))) {
			return
		}

		if (stats.isFile()) {
			fileInfo.push({ originalPath: originalSymlinkPath, resolvedPath: resolvedTarget, isSymlink: true })
		} else if (stats.isDirectory()) {
			const entries = await fs.readdir(resolvedTarget, { withFileTypes: true, recursive: true })
			await Promise.all(
				entries.map((entry) =>
					resolveRuleDirectoryEntry(
						entry,
						resolvedTarget,
						fileInfo,
						depth + 1,
						rulesDirectoryPath,
						originalSymlinkPath,
					),
				),
			)
		} else if (stats.isSymbolicLink()) {
			await resolveRuleSymlink(resolvedTarget, fileInfo, depth + 1, rulesDirectoryPath, originalSymlinkPath)
		}
	} catch {
		// Skip invalid symlinks.
	}
}

function getTargetRuleDirectory(cwd: string, input: Pick<CreateRuleInput, "scope" | "kind" | "modeSlug">): string {
	if (input.scope !== "global" && input.scope !== "project") {
		throw new Error("Invalid rule scope")
	}

	if (input.kind !== "generic" && input.kind !== "mode") {
		throw new Error("Invalid rule kind")
	}

	if (input.kind === "mode" && !input.modeSlug) {
		throw new Error("Mode-specific rules require a mode")
	}

	if (input.kind === "generic" && input.modeSlug) {
		throw new Error("Generic rules cannot specify a mode")
	}

	if (input.scope === "project" && !cwd) {
		throw new Error("Workspace rules require an open workspace")
	}

	const basePath = input.scope === "global" ? getGlobalRooDirectory() : getProjectRooDirectoryForCwd(cwd)
	return path.join(basePath, input.kind === "generic" ? "rules" : `rules-${validateModeSlug(input.modeSlug!)}`)
}

function normalizeRuleFileName(fileName: string): string {
	const trimmed = fileName.trim()

	if (!trimmed) {
		throw new Error("Rule name is required")
	}

	if (path.isAbsolute(trimmed) || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new Error("Rule name must be a file name, not a path")
	}

	const ruleName = trimmed.endsWith(".md") ? trimmed.slice(0, -".md".length) : trimmed
	if (ruleName.length > 64) {
		throw new Error("Rule name must be 64 characters or less (excluding the .md suffix)")
	}

	if (!VALID_RULE_FILENAME_PATTERN.test(trimmed)) {
		throw new Error("Rule name must contain only lowercase letters, numbers, hyphens, and underscores")
	}

	return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`
}

function normalizeRelativeRulePath(relativePath: string): string {
	const trimmed = relativePath.trim()

	if (!trimmed) {
		throw new Error("Rule path is required")
	}

	if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]+/).includes("..")) {
		throw new Error("Invalid rule path")
	}

	if (!shouldIncludeRuleFile(trimmed)) {
		throw new Error("Invalid rule file")
	}

	return path.normalize(trimmed)
}

function validateModeSlug(modeSlug: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(modeSlug)) {
		throw new Error("Invalid mode slug")
	}

	return modeSlug
}

function assertPathInsideDirectory(filePath: string, directoryPath: string): void {
	if (!isPathInsideDirectory(path.resolve(filePath), path.resolve(directoryPath))) {
		throw new Error("Rule path must stay inside the rules directory")
	}
}

async function assertRealPathInsideDirectory(filePath: string, directoryPath: string): Promise<void> {
	if (!(await isRealPathInsideDirectory(filePath, directoryPath))) {
		throw new Error("Rule path must stay inside the rules directory")
	}
}

async function isRealPathInsideDirectory(filePath: string, directoryPath: string): Promise<boolean> {
	const [realFilePath, realDirectoryPath] = await Promise.all([fs.realpath(filePath), fs.realpath(directoryPath)])
	return isPathInsideDirectory(realFilePath, realDirectoryPath)
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(directoryPath, filePath)
	return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
}

function createRuleId(scope: RuleScope, kind: RuleKind, modeSlug: string | undefined, relativePath: string): string {
	return [scope, kind, modeSlug ?? "generic", relativePath].join(":")
}

function createRuleTemplate(fileName: string, input: CreateRuleInput): string {
	const title = path.basename(fileName, ".md")
	const modeLine = input.kind === "mode" ? ` for ${input.modeSlug} mode` : ""

	return `# ${title}\n\nAdd Zoo Code rule guidance${modeLine} here.\n`
}

function compareRules(a: RuleMetadata, b: RuleMetadata): number {
	const scopeOrder = { global: 0, project: 1 } satisfies Record<RuleScope, number>
	const kindOrder = { mode: 0, generic: 1 } satisfies Record<RuleKind, number>

	return (
		scopeOrder[a.scope] - scopeOrder[b.scope] ||
		kindOrder[a.kind] - kindOrder[b.kind] ||
		(a.modeName ?? "").localeCompare(b.modeName ?? "") ||
		a.relativePath.toLowerCase().localeCompare(b.relativePath.toLowerCase())
	)
}
