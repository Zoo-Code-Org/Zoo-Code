import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import matter from "gray-matter"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { getGlobalRooDirectory, getGlobalAgentsDirectory, getProjectAgentsDirectoryForCwd } from "../roo-config"
import { directoryExists, fileExists } from "../roo-config"
import { SkillMetadata, SkillContent } from "../../shared/skills"
import { modes, getAllModes } from "../../shared/modes"
import {
	validateSkillName as validateSkillNameShared,
	SkillNameValidationError,
	SKILL_NAME_MAX_LENGTH,
} from "@roo-code/types"
import { t } from "../../i18n"

// Re-export for convenience
export type { SkillMetadata, SkillContent }

// Direct children (new skill folders or container symlinks) and their SKILL.md files.
const SKILLS_WATCH_PATTERN = "{*,*/SKILL.md}"

/** Mutable state shared by every scan in a single discovery pass. */
interface DiscoveryPass {
	/** Skills found in this pass. Published to the manager only when the pass ends. */
	skills: Map<string, SkillMetadata>
	/** SKILL.md paths of the skills found in this pass that come from a symlinked container. */
	containerSkillPaths: Set<string>
	/** Symlinked containers found in this pass: real path -> the root entry that links to it. */
	containers: Map<string, string>
	/**
	 * Paths that an unexpected error (anything except ENOENT/ENOTDIR) hid. Previously
	 * discovered skills and containers under them are kept, because they might only be
	 * unreadable for a moment. Everything else is replaced by the results of the pass.
	 */
	failedPaths: string[]
}

function isNotFoundError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return code === "ENOENT" || code === "ENOTDIR"
}

function isUnderAny(filePath: string, dirs: Iterable<string>): boolean {
	for (const dir of dirs) {
		if (filePath === dir || filePath.startsWith(dir + path.sep)) return true
	}
	return false
}

/**
 * Dot-prefixed entries are never valid skill names. They are also used for the
 * hidden staging and trash dirs of a cross-filesystem move.
 */
function isHiddenEntry(name: string): boolean {
	return name.startsWith(".")
}

export class SkillsManager {
	private skills: Map<string, SkillMetadata> = new Map()
	// SKILL.md paths of skills that come from a symlinked container. These are read-only for move/delete.
	private containerSkillPaths: Set<string> = new Set()
	// Published symlinked containers: real path -> the root entry that links to it
	private containers: Map<string, string> = new Map()
	// Skills root -> the real path it last resolved to, so a root that later fails to
	// resolve still covers the skills found under its target
	private rootRealPaths: Map<string, string> = new Map()
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	// Keyed by container real path. VS Code watchers don't follow symlinks.
	private containerWatchers: Map<string, vscode.Disposable> = new Map()
	// Runs discovery passes one at a time, so an older pass can't finish after a newer one
	private discoveryQueue: Promise<void> = Promise.resolve()
	private isDisposed = false

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
	}

	async initialize(): Promise<void> {
		await this.discoverSkills()
		await this.setupFileWatchers()
	}

	/**
	 * Discover all skills from global and project directories.
	 * Supports both generic skills (skills/) and mode-specific skills (skills-{mode}/).
	 * Also supports symlinks:
	 * - .roo/skills can be a symlink to a directory containing skill subdirectories
	 * - .roo/skills/[dirname] can be a symlink to a skill directory
	 * - .roo/skills/[dirname] can be a symlink to a container of skill directories
	 */
	async discoverSkills(): Promise<void> {
		const run = this.discoveryQueue.then(() => this.runDiscovery())
		// A failed pass must not block the passes queued after it
		this.discoveryQueue = run.catch(() => {})
		return run
	}

	private async runDiscovery(): Promise<void> {
		if (this.isDisposed) return

		// Build into new collections, so readers keep seeing the last published skills
		// during the scan, and a pass that throws leaves them untouched.
		const pass: DiscoveryPass = {
			skills: new Map(),
			containerSkillPaths: new Set(),
			containers: new Map(),
			failedPaths: [],
		}
		const skillsDirs = await this.getSkillsDirectories()

		for (const { dir, source, mode } of skillsDirs) {
			await this.scanSkillsDirectory(dir, source, mode, pass)
		}

		if (this.isDisposed) return

		this.publishSkills(pass)
		this.syncContainerWatchers()
	}

	/**
	 * Replace the published skills and containers with the results of a pass.
	 * Previously discovered ones that the pass did not find are kept only if they
	 * are under a path that failed to read, until a pass reads that path again.
	 */
	private publishSkills(pass: DiscoveryPass): void {
		const keptContainers: string[] = []
		for (const [realPath, linkPath] of this.containers) {
			if (pass.containers.has(realPath)) continue
			if (isUnderAny(realPath, pass.failedPaths) || isUnderAny(linkPath, pass.failedPaths)) {
				pass.containers.set(realPath, linkPath)
				keptContainers.push(realPath)
			}
		}

		for (const [key, skill] of this.skills) {
			if (pass.skills.has(key)) continue
			if (!isUnderAny(skill.path, pass.failedPaths) && !isUnderAny(skill.path, keptContainers)) continue
			pass.skills.set(key, skill)
			if (this.containerSkillPaths.has(skill.path)) {
				pass.containerSkillPaths.add(skill.path)
			}
		}

		this.skills = pass.skills
		this.containerSkillPaths = pass.containerSkillPaths
		this.containers = pass.containers
	}

	/**
	 * Scan a skills directory for skill subdirectories.
	 * Handles symlink cases:
	 * 1. The skills directory itself is a symlink (resolved by directoryExists using realpath)
	 * 2. Individual skill subdirectories are symlinks
	 * 3. Symlinked container of skills (e.g., .roo/skills/shared -> /repo/skills).
	 *    Only symlinks are treated as containers, and only one level deep.
	 *
	 * On name collisions the last loaded skill wins. Containers are loaded first
	 * in reverse order, so direct skills win over container skills, and the
	 * alphabetically first container wins over the others.
	 *
	 * Errors are handled per entry, so one unreadable entry never hides the rest of the root.
	 */
	private async scanSkillsDirectory(
		dirPath: string,
		source: "global" | "project",
		mode: string | undefined,
		pass: DiscoveryPass,
	): Promise<void> {
		let realDirPath = dirPath
		let entries: string[]
		try {
			if (!(await directoryExists(dirPath))) {
				return
			}
			// Get the real path (resolves if dirPath is a symlink)
			realDirPath = await fs.realpath(dirPath)
			// Sorted so collision handling doesn't depend on filesystem order
			entries = [...(await fs.readdir(realDirPath))].sort()
		} catch (error) {
			if (!isNotFoundError(error)) {
				pass.failedPaths.push(dirPath, realDirPath, this.rootRealPaths.get(dirPath) ?? realDirPath)
				console.error(`Failed to scan skills directory ${dirPath}:`, error)
			}
			return
		}
		this.rootRealPaths.set(dirPath, realDirPath)

		const directSkills: string[] = []
		const containerPaths: string[] = []

		for (const entryName of entries) {
			if (isHiddenEntry(entryName)) continue
			const entryPath = path.join(realDirPath, entryName)

			try {
				// Check if this entry is a directory (follows symlinks automatically)
				const stats = await fs.stat(entryPath)
				if (!stats.isDirectory()) continue

				if (await fileExists(path.join(entryPath, "SKILL.md"))) {
					directSkills.push(entryName)
				} else if (await this.isSymlink(entryPath, pass)) {
					containerPaths.push(entryPath)
				}
			} catch (error) {
				// A broken symlink (ENOENT) is simply not a skill
				if (!isNotFoundError(error)) {
					pass.failedPaths.push(entryPath)
					console.error(`Failed to check skill entry ${entryPath}:`, error)
				}
			}
		}

		for (const containerPath of containerPaths.reverse()) {
			await this.scanSkillContainer(containerPath, source, mode, pass)
		}

		for (const entryName of directSkills) {
			// The skill name comes from the entry name (symlink name if symlinked)
			await this.loadSkillMetadata(pass, path.join(realDirPath, entryName), source, mode, entryName)
		}
	}

	private async scanSkillContainer(
		containerPath: string,
		source: "global" | "project",
		mode: string | undefined,
		pass: DiscoveryPass,
	): Promise<void> {
		let realContainerPath = containerPath
		try {
			realContainerPath = await fs.realpath(containerPath)
			pass.containers.set(realContainerPath, containerPath)

			const entries = [...(await fs.readdir(realContainerPath))].sort()
			for (const entryName of entries) {
				if (isHiddenEntry(entryName)) continue
				const entryPath = path.join(realContainerPath, entryName)

				let isDirectory = false
				try {
					isDirectory = (await fs.stat(entryPath)).isDirectory()
				} catch (error) {
					// A broken symlink (ENOENT) is simply not a skill
					if (!isNotFoundError(error)) {
						pass.failedPaths.push(entryPath)
						console.error(`Failed to stat skill entry ${entryPath} in container ${containerPath}:`, error)
					}
				}
				if (!isDirectory) continue

				const skillMdPath = await this.loadSkillMetadata(pass, entryPath, source, mode, entryName)
				if (skillMdPath) {
					pass.containerSkillPaths.add(skillMdPath)
				}
			}
		} catch (error) {
			if (!isNotFoundError(error)) {
				pass.failedPaths.push(containerPath, realContainerPath)
				console.error(`Failed to scan skills container ${containerPath}:`, error)
			}
		}
	}

	/**
	 * @param pass - When called during discovery, an unexpected error marks the entry
	 * as failed, since it might be a container that is only unreadable for a moment.
	 */
	private async isSymlink(entryPath: string, pass?: DiscoveryPass): Promise<boolean> {
		try {
			return (await fs.lstat(entryPath)).isSymbolicLink()
		} catch (error) {
			if (!isNotFoundError(error)) {
				pass?.failedPaths.push(entryPath)
				console.error(`Failed to check whether ${entryPath} is a symlink:`, error)
			}
			return false
		}
	}

	/**
	 * Load skill metadata from a skill directory.
	 * @param pass - The discovery pass that collects the loaded skill
	 * @param skillDir - The resolved path to the skill directory (target of symlink if symlinked)
	 * @param source - Whether this is a global or project skill
	 * @param mode - The mode this skill is specific to (undefined for generic skills)
	 * @param skillName - The skill name (from symlink name if symlinked, otherwise from directory name)
	 * @returns The SKILL.md path if the skill was loaded, otherwise undefined
	 */
	private async loadSkillMetadata(
		pass: DiscoveryPass,
		skillDir: string,
		source: "global" | "project",
		mode?: string,
		skillName?: string,
	): Promise<string | undefined> {
		const skillMdPath = path.join(skillDir, "SKILL.md")

		let fileContent: string
		try {
			if (!(await fileExists(skillMdPath))) return undefined
			fileContent = await fs.readFile(skillMdPath, "utf-8")
		} catch (error) {
			// An unreadable SKILL.md may only be unreadable for a moment, so keep the
			// previously discovered skill. A file removed mid-scan is simply gone.
			if (!isNotFoundError(error)) {
				pass.failedPaths.push(skillDir)
				console.error(`Failed to read skill at ${skillDir}:`, error)
			}
			return undefined
		}

		try {
			// Use gray-matter to parse frontmatter
			const { data: frontmatter, content: body } = matter(fileContent)

			// Validate required fields (only name and description for now)
			if (!frontmatter.name || typeof frontmatter.name !== "string") {
				console.error(`Skill at ${skillDir} is missing required 'name' field`)
				return
			}
			if (!frontmatter.description || typeof frontmatter.description !== "string") {
				console.error(`Skill at ${skillDir} is missing required 'description' field`)
				return
			}

			// Validate that frontmatter name matches the skill name (directory name or symlink name)
			// Per the Agent Skills spec: "name field must match the parent directory name"
			const effectiveSkillName = skillName || path.basename(skillDir)
			if (frontmatter.name !== effectiveSkillName) {
				console.error(`Skill name "${frontmatter.name}" doesn't match directory "${effectiveSkillName}"`)
				return
			}

			// Validate skill name per agentskills.io spec using shared validation
			const nameValidation = validateSkillNameShared(effectiveSkillName)
			if (!nameValidation.valid) {
				const errorMessage = this.getSkillNameErrorMessage(effectiveSkillName, nameValidation.error!)
				console.error(`Skill name "${effectiveSkillName}" is invalid: ${errorMessage}`)
				return
			}

			// Description constraints:
			// - 1-1024 chars
			// - non-empty (after trimming)
			const description = frontmatter.description.trim()
			if (description.length < 1 || description.length > 1024) {
				console.error(
					`Skill "${effectiveSkillName}" has an invalid description length: must be 1-1024 characters (got ${description.length})`,
				)
				return
			}

			// Parse modeSlugs from frontmatter (new format) or fall back to directory-based mode
			// Priority: frontmatter.modeSlugs > frontmatter.mode > directory mode
			let modeSlugs: string[] | undefined
			if (Array.isArray(frontmatter.modeSlugs)) {
				modeSlugs = frontmatter.modeSlugs.filter((s: unknown) => typeof s === "string" && s.length > 0)
				if (modeSlugs.length === 0) {
					modeSlugs = undefined // Empty array means "any mode"
				}
			} else if (typeof frontmatter.mode === "string" && frontmatter.mode.length > 0) {
				// Legacy single mode in frontmatter
				modeSlugs = [frontmatter.mode]
			} else if (mode) {
				// Fall back to directory-based mode (skills-{mode}/)
				modeSlugs = [mode]
			}

			// Create unique key combining name, source, and modeSlugs for override resolution
			// For backward compatibility, use first mode slug or undefined for the key
			const primaryMode = modeSlugs?.[0]
			const skillKey = this.getSkillKey(effectiveSkillName, source, primaryMode)

			pass.skills.set(skillKey, {
				name: effectiveSkillName,
				description,
				path: skillMdPath,
				source,
				mode: primaryMode, // Deprecated: kept for backward compatibility
				modeSlugs, // New: array of mode slugs, undefined = any mode
			})
			return skillMdPath
		} catch (error) {
			console.error(`Failed to load skill at ${skillDir}:`, error)
			return undefined
		}
	}

	/**
	 * Get skills available for the current mode.
	 * Resolves overrides: project > global, mode-specific > generic.
	 *
	 * @param currentMode - The current mode slug (e.g., 'code', 'architect')
	 */
	getSkillsForMode(currentMode: string): SkillMetadata[] {
		const resolvedSkills = new Map<string, SkillMetadata>()

		for (const skill of this.skills.values()) {
			// Check if skill is available in current mode:
			// - modeSlugs undefined or empty = available in all modes ("Any mode")
			// - modeSlugs array with values = available only if currentMode is in the array
			const isAvailableInMode = this.isSkillAvailableInMode(skill, currentMode)
			if (!isAvailableInMode) continue

			const existingSkill = resolvedSkills.get(skill.name)

			if (!existingSkill) {
				resolvedSkills.set(skill.name, skill)
				continue
			}

			// Apply override rules
			const shouldOverride = this.shouldOverrideSkill(existingSkill, skill)
			if (shouldOverride) {
				resolvedSkills.set(skill.name, skill)
			}
		}

		return Array.from(resolvedSkills.values())
	}

	/**
	 * Check if a skill is available in the given mode.
	 * - modeSlugs undefined or empty = available in all modes ("Any mode")
	 * - modeSlugs with values = available only if mode is in the array
	 */
	private isSkillAvailableInMode(skill: SkillMetadata, currentMode: string): boolean {
		// No mode restrictions = available in all modes
		if (!skill.modeSlugs || skill.modeSlugs.length === 0) {
			return true
		}
		// Check if current mode is in the allowed modes
		return skill.modeSlugs.includes(currentMode)
	}

	/**
	 * Determine if newSkill should override existingSkill based on priority rules.
	 * Priority: project > global, mode-specific > generic
	 */
	private shouldOverrideSkill(existing: SkillMetadata, newSkill: SkillMetadata): boolean {
		// Define source priority: project > global
		const sourcePriority: Record<string, number> = {
			project: 2,
			global: 1,
		}

		const existingPriority = sourcePriority[existing.source] ?? 0
		const newPriority = sourcePriority[newSkill.source] ?? 0

		// Higher priority source always wins
		if (newPriority > existingPriority) return true
		if (newPriority < existingPriority) return false

		// Same source: mode-specific overrides generic
		// A skill with modeSlugs (restricted) is more specific than one without (any mode)
		const existingHasModes = existing.modeSlugs && existing.modeSlugs.length > 0
		const newHasModes = newSkill.modeSlugs && newSkill.modeSlugs.length > 0
		if (newHasModes && !existingHasModes) return true
		if (!newHasModes && existingHasModes) return false

		// Same source and same mode-specificity: keep existing (first wins)
		return false
	}

	/**
	 * Get all skills (for UI display, debugging, etc.)
	 */
	getAllSkills(): SkillMetadata[] {
		return Array.from(this.skills.values())
	}

	async getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null> {
		// If mode is provided, try to find the best matching skill
		let skill: SkillMetadata | undefined

		if (currentMode) {
			const modeSkills = this.getSkillsForMode(currentMode)
			skill = modeSkills.find((s) => s.name === name)
		} else {
			// Fall back to any skill with this name
			skill = Array.from(this.skills.values()).find((s) => s.name === name)
		}

		if (!skill) return null

		// Read skill content from disk
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { content: body } = matter(fileContent)

		return {
			...skill,
			instructions: body.trim(),
		}
	}

	/**
	 * Get all skills metadata (for UI display)
	 * Returns skills from all sources without content
	 */
	getSkillsMetadata(): SkillMetadata[] {
		return this.getAllSkills()
	}

	/**
	 * Get a skill by name, source, and optionally mode
	 */
	getSkill(name: string, source: "global" | "project", mode?: string): SkillMetadata | undefined {
		const skillKey = this.getSkillKey(name, source, mode)
		return this.skills.get(skillKey)
	}

	/**
	 * Find a skill by name and source (regardless of mode).
	 * Useful for opening/editing skills where the exact mode key may vary.
	 */
	findSkillByNameAndSource(name: string, source: "global" | "project"): SkillMetadata | undefined {
		for (const skill of this.skills.values()) {
			if (skill.name === name && skill.source === source) {
				return skill
			}
		}
		return undefined
	}

	/**
	 * Validate skill name per agentskills.io spec using shared validation.
	 * Converts error codes to user-friendly error messages.
	 */
	private validateSkillName(name: string): { valid: boolean; error?: string } {
		const result = validateSkillNameShared(name)
		if (!result.valid) {
			return { valid: false, error: this.getSkillNameErrorMessage(name, result.error!) }
		}
		return { valid: true }
	}

	/**
	 * Convert skill name validation error code to a user-friendly error message.
	 */
	private getSkillNameErrorMessage(name: string, error: SkillNameValidationError): string {
		switch (error) {
			case SkillNameValidationError.Empty:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.TooLong:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.InvalidFormat:
				return t("skills:errors.name_format")
		}
	}

	/**
	 * Create a new skill
	 * @param name - Skill name (must be valid per agentskills.io spec)
	 * @param source - "global" or "project"
	 * @param description - Skill description
	 * @param modeSlugs - Optional mode restrictions (undefined/empty = any mode)
	 * @returns Path to created SKILL.md file
	 */
	async createSkill(
		name: string,
		source: "global" | "project",
		description: string,
		modeSlugs?: string[],
	): Promise<string> {
		// Validate skill name
		const validation = this.validateSkillName(name)
		if (!validation.valid) {
			throw new Error(validation.error)
		}

		// Validate description
		const trimmedDescription = description.trim()
		if (trimmedDescription.length < 1 || trimmedDescription.length > 1024) {
			throw new Error(t("skills:errors.description_length", { length: trimmedDescription.length }))
		}

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalRooDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = path.join(provider.cwd, ".roo")
		}

		// Always use the generic skills directory (mode info stored in frontmatter now)
		const skillsDir = path.join(baseDir, "skills")
		const skillDir = path.join(skillsDir, name)
		const skillMdPath = path.join(skillDir, "SKILL.md")

		// Check if skill already exists
		if (await fileExists(skillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: skillMdPath }))
		}

		// Create the skill directory
		await fs.mkdir(skillDir, { recursive: true })

		// Generate SKILL.md content with frontmatter
		const titleName = name
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")

		// Build frontmatter with optional modeSlugs
		const frontmatterLines = [`name: ${name}`, `description: ${trimmedDescription}`]
		if (modeSlugs && modeSlugs.length > 0) {
			frontmatterLines.push(`modeSlugs:`)
			for (const slug of modeSlugs) {
				frontmatterLines.push(`  - ${slug}`)
			}
		}

		const skillContent = `---
${frontmatterLines.join("\n")}
---

# ${titleName}

## Instructions

Add your skill instructions here.
`

		// Write the SKILL.md file
		await fs.writeFile(skillMdPath, skillContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()

		return skillMdPath
	}

	/**
	 * Delete a skill
	 * @param name - Skill name to delete
	 * @param source - Where the skill is located
	 * @param mode - Optional mode (to locate in skills-{mode}/ directory)
	 */
	async deleteSkill(name: string, source: "global" | "project", mode?: string): Promise<void> {
		// Find the skill
		const skill = this.getSkill(name, source, mode)
		if (!skill) {
			const modeInfo = mode ? ` (mode: ${mode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		this.assertNotContainerSkill(skill)

		// Get the skill directory (parent of SKILL.md)
		const skillDir = path.dirname(skill.path)

		// Delete the entire skill directory
		await fs.rm(skillDir, { recursive: true, force: true })

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Move a skill to a different mode
	 * @param name - Skill name to move
	 * @param source - Where the skill is located ("global" or "project")
	 * @param currentMode - Current mode (undefined for generic skills)
	 * @param newMode - Target mode (undefined for generic skills)
	 */
	async moveSkill(
		name: string,
		source: "global" | "project",
		currentMode: string | undefined,
		newMode: string | undefined,
	): Promise<void> {
		// Don't move if source and destination are the same
		if (currentMode === newMode) {
			return
		}

		// Find the skill at its current location
		const skill = this.getSkill(name, source, currentMode)
		if (!skill) {
			const modeInfo = currentMode ? ` (mode: ${currentMode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		this.assertNotContainerSkill(skill)

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalRooDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = path.join(provider.cwd, ".roo")
		}

		// Determine source and destination directories. The source comes from the
		// discovered path, since the skills directory itself may be a symlink.
		const destDirName = newMode ? `skills-${newMode}` : "skills"
		const sourceDir = path.dirname(skill.path)
		const sourceRoot = path.join(baseDir, currentMode ? `skills-${currentMode}` : "skills")

		// Only move skills that live directly in the .roo source root (possibly through a
		// symlinked root). Skills sharing the same key may come from .agents, which is shared
		// with other agents and must never be moved out from under them.
		const realSourceRoot = await fs.realpath(sourceRoot).catch((error: unknown) => {
			if (isNotFoundError(error)) return undefined
			throw error
		})
		if (path.dirname(sourceDir) !== realSourceRoot) {
			const modeInfo = currentMode ? ` (mode: ${currentMode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		const destSkillsDir = path.join(baseDir, destDirName)
		const destDir = path.join(destSkillsDir, name)
		const destSkillMdPath = path.join(destDir, "SKILL.md")

		// Check if skill already exists at destination
		if (await fileExists(destSkillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: destSkillMdPath }))
		}

		// Ensure destination skills directory exists
		await fs.mkdir(destSkillsDir, { recursive: true })

		// Move the skill directory (falls back to copy+remove across filesystems)
		await this.moveDirectory(sourceDir, destDir)

		// Clean up empty source skills directory. Skip it if it's a symlink, so we
		// never leave a dangling symlink.
		try {
			if (!(await this.isSymlink(sourceRoot))) {
				const entries = await fs.readdir(sourceRoot)
				if (entries.length === 0) {
					await fs.rmdir(sourceRoot)
				}
			}
		} catch {
			// Ignore errors - directory might not exist or have permission issues
		}

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Skills inside a symlinked container live outside the workspace (for example, in a
	 * shared repo). Moving or deleting them would change that shared content. Unlinking
	 * the container would remove all of its skills. So they are read-only here.
	 */
	private assertNotContainerSkill(skill: SkillMetadata): void {
		if (this.containerSkillPaths.has(skill.path)) {
			throw new Error(t("skills:errors.container_skill_read_only", { name: skill.name, path: skill.path }))
		}
	}

	/**
	 * Rename a directory, falling back to copy + delete across filesystems
	 * (a skills directory may be a symlink to another device).
	 *
	 * The fallback never leaves the skill at two discoverable locations:
	 * 1. Copy the source into a hidden staging dir next to destDir (dest filesystem),
	 *    and check that no relative symlink in the copy points outside it.
	 * 2. Atomically rename the source aside to a hidden trash dir (source filesystem).
	 * 3. Atomically promote staging to destDir. On failure, restore the source from trash.
	 * 4. Best-effort delete of the trash dir. The move is already committed, so a
	 *    failure here is logged instead of thrown and never leaves a duplicate skill.
	 *
	 * Between steps 2 and 3 the skill is briefly not discoverable at all. Discovery and
	 * the watchers skip the dot-prefixed staging and trash dirs.
	 */
	private async moveDirectory(sourceDir: string, destDir: string): Promise<void> {
		try {
			await fs.rename(sourceDir, destDir)
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") {
				throw error
			}
		}

		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
		const stagingDir = path.join(path.dirname(destDir), `.${path.basename(destDir)}.moving-${suffix}`)
		const trashDir = path.join(path.dirname(sourceDir), `.${path.basename(sourceDir)}.removing-${suffix}`)
		let sourceMovedAside = false

		try {
			// verbatimSymlinks: otherwise relative links get rewritten to point into the deleted source
			await fs.cp(sourceDir, stagingDir, {
				recursive: true,
				errorOnExist: true,
				force: false,
				verbatimSymlinks: true,
			})

			// A relative link that points outside the skill would dangle at the new
			// location. Fail now, while the source still exists.
			const escapingLink = await this.findEscapingRelativeSymlink(stagingDir)
			if (escapingLink) {
				throw new Error(
					t("skills:errors.symlink_escapes_skill", {
						link: path.join(sourceDir, path.relative(stagingDir, escapingLink)),
					}),
				)
			}

			const destExists = await fs.lstat(destDir).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error?.code === "ENOENT") {
						return false
					}
					throw error
				},
			)
			if (destExists) {
				throw Object.assign(new Error(`Destination already exists: ${destDir}`), { code: "EEXIST" })
			}

			// Same parent directory, so this is atomic and cannot fail with EXDEV
			await fs.rename(sourceDir, trashDir)
			sourceMovedAside = true

			await fs.rename(stagingDir, destDir)
		} catch (moveError) {
			if (sourceMovedAside) {
				try {
					await fs.rename(trashDir, sourceDir)
				} catch (restoreError) {
					// Keep the trash dir so the original content is never lost
					console.error(
						`Failed to restore skill directory ${sourceDir} from ${trashDir} after a failed move:`,
						restoreError,
					)
				}
			}
			await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
			throw moveError
		}

		// The move is committed and the source is no longer discoverable under its
		// original name, so leftover trash must not turn a successful move into an error.
		try {
			await fs.rm(trashDir, { recursive: true, force: true })
		} catch (cleanupError) {
			console.error(`Failed to remove moved skill's old directory ${trashDir}:`, cleanupError)
		}
	}

	/**
	 * Find a relative symlink under rootDir whose target resolves outside rootDir.
	 * Absolute links keep working after a move, so they are allowed.
	 * @returns The path of the first such link, or undefined if there is none
	 */
	private async findEscapingRelativeSymlink(rootDir: string): Promise<string | undefined> {
		const pending = [rootDir]
		while (pending.length > 0) {
			const dir = pending.pop()!
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				const entryPath = path.join(dir, entry.name)
				if (entry.isDirectory()) {
					pending.push(entryPath)
				} else if (entry.isSymbolicLink()) {
					const target = await fs.readlink(entryPath)
					if (path.isAbsolute(target)) continue
					const relativeToRoot = path.relative(rootDir, path.resolve(dir, target))
					if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
						return entryPath
					}
				}
			}
		}
		return undefined
	}

	/**
	 * Update the mode associations for a skill by modifying its SKILL.md frontmatter.
	 * @param name - Skill name
	 * @param source - Where the skill is located ("global" or "project")
	 * @param newModeSlugs - New mode slugs (undefined/empty = any mode)
	 */
	async updateSkillModes(name: string, source: "global" | "project", newModeSlugs?: string[]): Promise<void> {
		// Find any skill with this name and source (regardless of current mode)
		let skill: SkillMetadata | undefined
		for (const s of this.skills.values()) {
			if (s.name === name && s.source === source) {
				skill = s
				break
			}
		}

		if (!skill) {
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo: "" }))
		}

		this.assertNotContainerSkill(skill)

		// Read the current SKILL.md file
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { data: frontmatter, content: body } = matter(fileContent)

		// Update the frontmatter with new modeSlugs
		if (newModeSlugs && newModeSlugs.length > 0) {
			frontmatter.modeSlugs = newModeSlugs
			// Remove legacy mode field if present
			delete frontmatter.mode
		} else {
			// Empty/undefined = any mode, remove mode restrictions
			delete frontmatter.modeSlugs
			delete frontmatter.mode
		}

		// Serialize back to SKILL.md format
		const newContent = matter.stringify(body, frontmatter)
		await fs.writeFile(skill.path, newContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Get all skills directories to scan, including mode-specific directories.
	 */
	private async getSkillsDirectories(): Promise<
		Array<{
			dir: string
			source: "global" | "project"
			mode?: string
		}>
	> {
		const dirs: Array<{ dir: string; source: "global" | "project"; mode?: string }> = []
		const globalRooDir = getGlobalRooDirectory()
		const globalAgentsDir = getGlobalAgentsDirectory()
		const provider = this.providerRef.deref()
		const projectRooDir = provider?.cwd ? path.join(provider.cwd, ".roo") : null
		const projectAgentsDir = provider?.cwd ? getProjectAgentsDirectoryForCwd(provider.cwd) : null

		// Get list of modes to check for mode-specific skills
		const modesList = await this.getAvailableModes()

		// Priority rules for skills with the same name:
		// 1. Source level: project > global (handled by shouldOverrideSkill in getSkillsForMode)
		// 2. Within the same source level: later-processed directories override earlier ones
		//    (via Map.set replacement during discovery - same source+mode+name key gets replaced)
		//
		// Processing order (later directories override earlier ones at the same source level):
		// - Global: .agents/skills first, then .roo/skills (so .roo wins)
		// - Project: .agents/skills first, then .roo/skills (so .roo wins)

		// Global .agents directories (lowest priority - shared across agents)
		dirs.push({ dir: path.join(globalAgentsDir, "skills"), source: "global" })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalAgentsDir, `skills-${mode}`), source: "global", mode })
		}

		// Project .agents directories
		if (projectAgentsDir) {
			dirs.push({ dir: path.join(projectAgentsDir, "skills"), source: "project" })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(projectAgentsDir, `skills-${mode}`), source: "project", mode })
			}
		}

		// Global .roo directories (Roo-specific, higher priority than .agents)
		dirs.push({ dir: path.join(globalRooDir, "skills"), source: "global" })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalRooDir, `skills-${mode}`), source: "global", mode })
		}

		// Project .roo directories (highest priority)
		if (projectRooDir) {
			dirs.push({ dir: path.join(projectRooDir, "skills"), source: "project" })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(projectRooDir, `skills-${mode}`), source: "project", mode })
			}
		}

		return dirs
	}

	/**
	 * Get list of available modes (built-in + custom)
	 */
	private async getAvailableModes(): Promise<string[]> {
		const provider = this.providerRef.deref()
		const builtInModeSlugs = modes.map((m) => m.slug)

		if (!provider) {
			return builtInModeSlugs
		}

		try {
			const customModes = await provider.customModesManager.getCustomModes()
			const allModes = getAllModes(customModes)
			return allModes.map((m) => m.slug)
		} catch {
			return builtInModeSlugs
		}
	}

	private getSkillKey(name: string, source: string, mode?: string): string {
		return `${source}:${mode || "generic"}:${name}`
	}

	private async setupFileWatchers(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const provider = this.providerRef.deref()
		if (!provider?.cwd) return

		// Watch for changes in skills directories
		const globalRooDir = getGlobalRooDirectory()
		const globalAgentsDir = getGlobalAgentsDirectory()
		const projectRooDir = path.join(provider.cwd, ".roo")
		const projectAgentsDir = getProjectAgentsDirectoryForCwd(provider.cwd)

		// Watch global .roo skills directory
		this.watchDirectory(path.join(globalRooDir, "skills"))

		// Watch global .agents skills directory
		this.watchDirectory(path.join(globalAgentsDir, "skills"))

		// Watch project .roo skills directory
		this.watchDirectory(path.join(projectRooDir, "skills"))

		// Watch project .agents skills directory
		this.watchDirectory(path.join(projectAgentsDir, "skills"))

		// Watch mode-specific directories for all available modes
		const modesList = await this.getAvailableModes()
		for (const mode of modesList) {
			// .roo mode-specific
			this.watchDirectory(path.join(globalRooDir, `skills-${mode}`))
			this.watchDirectory(path.join(projectRooDir, `skills-${mode}`))
			// .agents mode-specific
			this.watchDirectory(path.join(globalAgentsDir, `skills-${mode}`))
			this.watchDirectory(path.join(projectAgentsDir, `skills-${mode}`))
		}
	}

	private watchDirectory(dirPath: string): void {
		const watcher = this.createSkillsWatcher(dirPath)
		if (watcher) {
			this.disposables.push(watcher)
		}
	}

	private syncContainerWatchers(): void {
		const containers = this.containers
		for (const [containerPath, watcher] of this.containerWatchers) {
			if (this.isDisposed || !containers.has(containerPath)) {
				watcher.dispose()
				this.containerWatchers.delete(containerPath)
			}
		}

		if (this.isDisposed) return

		for (const containerPath of containers.keys()) {
			if (this.containerWatchers.has(containerPath)) continue
			const watcher = this.createSkillsWatcher(containerPath)
			if (watcher) {
				this.containerWatchers.set(containerPath, watcher)
			}
		}
	}

	private createSkillsWatcher(dirPath: string): vscode.Disposable | undefined {
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return undefined
		}

		const pattern = new vscode.RelativePattern(dirPath, SKILLS_WATCH_PATTERN)
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)

		const onEvent = async (uri: vscode.Uri) => {
			if (this.isDisposed) return
			// Skip hidden entries, such as the staging and trash dirs of a cross-filesystem move
			const relativePath = path.relative(dirPath, uri.fsPath)
			if (relativePath.split(path.sep).some(isHiddenEntry)) return
			await this.discoverSkills()
		}

		watcher.onDidChange(onEvent)
		watcher.onDidCreate(onEvent)
		watcher.onDidDelete(onEvent)

		return watcher
	}

	async dispose(): Promise<void> {
		this.isDisposed = true
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
		this.containerWatchers.forEach((w) => w.dispose())
		this.containerWatchers.clear()
		this.skills.clear()
		this.containerSkillPaths.clear()
		this.containers.clear()
		this.rootRealPaths.clear()
	}
}
