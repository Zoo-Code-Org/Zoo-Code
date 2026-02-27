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

export class SkillsManager {
	private skills: Map<string, SkillMetadata> = new Map()
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
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
	 */
	async discoverSkills(): Promise<void> {
		this.skills.clear()
		const skillsDirs = await this.getSkillsDirectories()

		for (const { dir, source, mode } of skillsDirs) {
			// Use a fresh visited set and claim map for each top-level scan so
			// traversal is deduplicated within a single root without sharing
			// state across different source or mode roots. Later roots still
			// override earlier ones (e.g. .roo over .agents) via Map.set.
			await this.scanSkillsDirectory(dir, source, mode, 0, new Set<string>(), new Map<string, number>())
		}
	}

	/**
	 * Maximum depth for recursive scanning of skill container directories.
	 * Prevents infinite loops from circular symlinks.
	 */
	private static readonly MAX_SCAN_DEPTH = 5

	/**
	 * Scan a skills directory for skill subdirectories.
	 * Handles symlink cases:
	 * 1. The skills directory itself is a symlink (resolved by directoryExists using realpath)
	 * 2. Individual skill subdirectories are symlinks
	 * 3. Symlinked container directories that contain skill subdirectories (e.g., ln -s ../../repo/skills .roo/skills/)
	 *
	 * A directory that contains a SKILL.md is treated as a skill. A directory
	 * without one is treated as a container and scanned recursively (up to
	 * {@link MAX_SCAN_DEPTH}) so skills nested inside a symlinked container are
	 * discovered.
	 *
	 * Symlinks are followed even when they point outside the configured skills
	 * root. This is not a security concern: the user controls these directories
	 * and could place skill files there directly, so a symlink is just a
	 * convenient way to share a skills repo (the point of issue #1842).
	 *
	 * Within a single root, skills sharing the same identity (name, source and
	 * mode key) are resolved deterministically rather than by scan order: the
	 * shallowest skill wins (so a direct-root skill beats one nested inside a
	 * container), and ties at the same depth are broken by sorted entry name
	 * (first wins).
	 *
	 * @param visited - Real paths already scanned in this run, used to avoid
	 *   redundant work and infinite loops from circular symlinks.
	 * @param claimedDepths - Skill keys discovered in this root, mapped to the
	 *   depth at which they were found.
	 */
	private async scanSkillsDirectory(
	 dirPath: string,
	 source: "global" | "project",
	 mode: string | undefined,
	 depth: number = 0,
	 visited: Set<string> = new Set<string>(),
	 claimedDepths: Map<string, number> = new Map<string, number>(),
	): Promise<void> {
		if (depth > SkillsManager.MAX_SCAN_DEPTH) {
			return
		}

		if (!(await directoryExists(dirPath))) {
			return
		}

		try {
			// Get the real path (resolves if dirPath is a symlink)
			const realDirPath = await fs.realpath(dirPath)

			// Skip directories we've already visited (by real path) to avoid
			// redundant scanning and infinite loops from circular symlinks.
			if (visited.has(realDirPath)) {
				return
			}
			visited.add(realDirPath)

			// Read directory entries, sorted so same-depth collisions resolve
			// deterministically regardless of filesystem ordering.
			const entries = [...(await fs.readdir(realDirPath))].sort()

			for (const entryName of entries) {
				const entryPath = path.join(realDirPath, entryName)

				// Check if this entry is a directory (follows symlinks automatically)
				const stats = await fs.stat(entryPath).catch(() => null)
				if (!stats?.isDirectory()) continue

				// Check if this directory contains a SKILL.md (i.e., it's a skill directory)
				const skillMdPath = path.join(entryPath, "SKILL.md")
				if (await fileExists(skillMdPath)) {
					// Load skill metadata - the skill name comes from the entry name (symlink name if symlinked)
					await this.loadSkillMetadata(entryPath, source, mode, entryName, depth, claimedDepths)
				} else {
					// No SKILL.md found - this might be a container directory (e.g., a symlinked repo of skills)
					// Recursively scan it for skill subdirectories, sharing the same
					// visited set so traversal stays deduplicated and bounded.
					await this.scanSkillsDirectory(entryPath, source, mode, depth + 1, visited, claimedDepths)
				}
			}
		} catch {
			// Directory doesn't exist or can't be read - this is fine
		}
	}

	/**
	 * Load skill metadata from a skill directory.
	 * @param skillDir - The resolved path to the skill directory (target of symlink if symlinked)
	 * @param source - Whether this is a global or project skill
	 * @param mode - The mode this skill is specific to (undefined for generic skills)
	 * @param skillName - The skill name (from symlink name if symlinked, otherwise from directory name)
	 * @param depth - Depth within the current root at which the skill was found
	 * @param claimedDepths - Skill keys already discovered in the current root and their depths
	 */
	private async loadSkillMetadata(
	 skillDir: string,
	 source: "global" | "project",
	 mode: string | undefined,
	 skillName?: string,
	 depth: number = 0,
	 claimedDepths?: Map<string, number>,
	): Promise<void> {
		const skillMdPath = path.join(skillDir, "SKILL.md")
		if (!(await fileExists(skillMdPath))) return

		try {
			const fileContent = await fs.readFile(skillMdPath, "utf-8")

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

			// Within the same root, a skill already found at the same or a
			// shallower depth takes priority (direct-root beats nested).
			const claimedDepth = claimedDepths?.get(skillKey)
			if (claimedDepth !== undefined) {
				const existingPath = this.skills.get(skillKey)?.path ?? "another skill"
				if (claimedDepth <= depth) {
					console.warn(
						`Skill "${effectiveSkillName}" at ${skillMdPath} is shadowed by ${existingPath} with the same identity`,
					)
					return
				}
				console.warn(
					`Skill "${effectiveSkillName}" at ${existingPath} is shadowed by ${skillMdPath} with the same identity`,
				)
			}
			claimedDepths?.set(skillKey, depth)

			this.skills.set(skillKey, {
				name: effectiveSkillName,
				description,
				path: skillMdPath,
				source,
				mode: primaryMode, // Deprecated: kept for backward compatibility
				modeSlugs, // New: array of mode slugs, undefined = any mode
			})
		} catch (error) {
			console.error(`Failed to load skill at ${skillDir}:`, error)
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

		// Check if skill already exists on disk at the direct location
		if (await fileExists(skillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: skillMdPath }))
		}

		// Check if a skill with the same identity was already discovered elsewhere
		// (e.g., nested inside a symlinked container directory). Creating another
		// skill with the same name/source/mode key would let scan order decide
		// which skill remains available, so reject the collision explicitly.
		const primaryMode = modeSlugs?.[0]
		const existingSkill = this.getSkill(name, source, primaryMode)
		if (existingSkill) {
			throw new Error(t("skills:errors.already_exists", { name, path: existingSkill.path }))
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

		// Determine source and destination directories.
		// Derive the source directory from the discovered skill's path rather than
		// rebuilding it from the name, so nested skills (e.g., discovered inside a
		// symlinked container like skills/repo/my-skill) move from their actual
		// on-disk location instead of a non-existent skills/my-skill path.
		const destDirName = newMode ? `skills-${newMode}` : "skills"
		const sourceDir = path.dirname(skill.path)
		const destSkillsDir = path.join(baseDir, destDirName)
		const destDir = path.join(destSkillsDir, name)
		const destSkillMdPath = path.join(destDir, "SKILL.md")

		// Check if skill already exists at destination
		if (await fileExists(destSkillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: destSkillMdPath }))
		}

		// Ensure destination skills directory exists
		await fs.mkdir(destSkillsDir, { recursive: true })

		// Move the skill directory
		await fs.rename(sourceDir, destDir)

		// Clean up the now-empty source parent directory (e.g., the emptied
		// skills-{mode} directory). Uses the actual parent of the moved skill so
		// nested skills clean up their real container rather than an assumed path.
		const sourceSkillsDir = path.dirname(sourceDir)
		try {
			const entries = await fs.readdir(sourceSkillsDir)
			if (entries.length === 0) {
				await fs.rmdir(sourceSkillsDir)
			}
		} catch {
			// Ignore errors - directory might not exist or have permission issues
		}

		// Refresh skills list
		await this.discoverSkills()
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
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const pattern = new vscode.RelativePattern(dirPath, "**/SKILL.md")
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)

		watcher.onDidChange(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		watcher.onDidCreate(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		watcher.onDidDelete(async (uri) => {
			if (this.isDisposed) return
			await this.discoverSkills()
		})

		this.disposables.push(watcher)
	}

	async dispose(): Promise<void> {
		this.isDisposed = true
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
		this.skills.clear()
	}
}
