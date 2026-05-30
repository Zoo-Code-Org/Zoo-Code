import type { GroupEntry, ModeConfig } from "@roo-code/types"
import type { LearnedPattern } from "./types"
import type { Logger } from "./types"

/**
 * Minimum confidence for a pattern to be re-created as a mode on hot-reload.
 */
const MIN_RECREATE_CONFIDENCE = 0.3

/**
 * Minimum frequency for a pattern to be re-created as a mode on hot-reload.
 */
const MIN_RECREATE_FREQUENCY = 2

/**
 * Maps tool names to appropriate tool groups.
 * Heuristic mapping based on common tool categories.
 */
const TOOL_TO_GROUP_MAP: Record<string, ToolGroup> = {
	read_file: "read",
	write_to_file: "edit",
	apply_diff: "edit",
	search_files: "read",
	list_files: "read",
	execute_command: "command",
	use_mcp_tool: "mcp",
	access_mcp_resource: "mcp",
	ask_followup_question: "read",
	attempt_completion: "read",
	switch_mode: "modes",
	new_task: "modes",
	codebase_search: "read",
	update_todo_list: "edit",
	run_slash_command: "command",
	skill: "command",
	generate_image: "mcp",
	custom_tool: "mcp",
	read: "read",
	write: "edit",
	edit: "edit",
	search: "read",
	list: "read",
	command: "command",
	mcp: "mcp",
	ask: "read",
	complete: "read",
}

type ToolGroup = "read" | "edit" | "command" | "mcp" | "modes"

export class ModeFactoryService {
	private logger: Logger
	private customModesManager: { updateCustomMode(slug: string, config: ModeConfig): Promise<void> } | null = null
	private getPatterns: (() => LearnedPattern[]) | null = null
	private pendingRecreateCalls: Array<() => void> = []

	/** Re-entrancy guard: non-null while _recreateModes() is in flight */
	private recreatePromise: Promise<string[]> | null = null
	/** Debounce timer for collapsing rapid successive recreateModes() calls */
	private recreateTimer: ReturnType<typeof setTimeout> | null = null
	private readonly RECREATE_DEBOUNCE_MS = 500

	constructor(logger: Logger) {
		this.logger = logger
	}

	setCustomModesManager(manager: { updateCustomMode(slug: string, config: ModeConfig): Promise<void> }): void {
		this.customModesManager = manager
	}

	/**
	 * Register a callback to retrieve patterns from the learning store.
	 * Required for hot-reload mode recreation.
	 * Flushes any queued recreateModes() calls that arrived before the provider was set.
	 */
	setPatternProvider(provider: () => LearnedPattern[]): void {
		this.getPatterns = provider
		const pending = [...this.pendingRecreateCalls]
		this.pendingRecreateCalls = []
		for (const call of pending) {
			call()
		}
	}

	/**
	 * Re-create modes from current patterns.
	 * Called when .roomodes changes to re-apply auto-created modes
	 * that may have been overwritten by the reload.
	 * If the pattern provider is not yet set, queues the call for retry.
	 */
	/**
	 * Re-create modes from current patterns.
	 * Called when .roomodes changes to re-apply auto-created modes
	 * that may have been overwritten by the reload.
	 * If the pattern provider is not yet set, queues the call for retry.
	 *
	 * Debounces rapid successive calls and guards against re-entrancy
	 * to prevent infinite recreation loops when writing to .roomodes
	 * triggers the file watcher.
	 */
	async recreateModes(): Promise<string[]> {
		// Debounce: collapse rapid successive calls
		if (this.recreateTimer) {
			clearTimeout(this.recreateTimer)
		}

		return new Promise((resolve) => {
			this.recreateTimer = setTimeout(async () => {
				// Re-entrancy guard: if already recreating, return existing promise
				if (this.recreatePromise) {
					const result = await this.recreatePromise
					resolve(result)
					return
				}

				this.recreatePromise = this._recreateModes()
				const result = await this.recreatePromise
				this.recreatePromise = null
				resolve(result)
			}, this.RECREATE_DEBOUNCE_MS)
		})
	}

	/**
	 * Internal implementation of recreateModes — debounced and guarded
	 * against re-entrancy by the public wrapper.
	 */
	private async _recreateModes(): Promise<string[]> {
		if (!this.getPatterns) {
			this.logger.appendLine("[ModeFactory] Cannot recreate modes: pattern provider not set, queuing for retry")
			return new Promise((resolve) => {
				this.pendingRecreateCalls.push(() => {
					this.recreateModes().then(resolve)
				})
			})
		}

		const allPatterns = this.getPatterns()
		const candidates = allPatterns.filter((p) => {
			if (!p.context?.toolNames || p.context.toolNames.length === 0) return false
			if ((p.confidenceScore ?? 0) < MIN_RECREATE_CONFIDENCE) return false
			if ((p.frequency ?? 0) < MIN_RECREATE_FREQUENCY) return false
			return true
		})

		if (candidates.length === 0) {
			this.logger.appendLine("[ModeFactory] No candidate patterns for mode recreation")
			return []
		}

		this.logger.appendLine(`[ModeFactory] Recreating ${candidates.length} modes from patterns`)
		return this.createModesFromPatterns(candidates)
	}

	/**
	 * Derive a custom mode config from a learned pattern.
	 * Returns null if the pattern doesn't have enough data to create a meaningful mode.
	 */
	deriveModeFromPattern(pattern: LearnedPattern): ModeConfig | null {
		const toolNames = pattern.context?.toolNames
		if (!toolNames || toolNames.length === 0) {
			this.logger.appendLine(`[ModeFactory] Pattern ${pattern.id} has no tool names, skipping mode creation`)
			return null
		}

		const slug = this.generateSlug(pattern)
		if (!slug) return null

		const name = this.generateName(pattern)
		const roleDefinition = this.generateRoleDefinition(pattern)
		const groups = this.deriveGroups(toolNames)

		if (groups.length === 0) {
			this.logger.appendLine(
				`[ModeFactory] Pattern ${pattern.id} has no valid tool groups, skipping mode creation`,
			)
			return null
		}

		return {
			slug,
			name,
			roleDefinition,
			groups,
			source: "project",
		}
	}

	/**
	 * Create or update a custom mode from a pattern via CustomModesManager.
	 */
	async createModeFromPattern(pattern: LearnedPattern): Promise<string | null> {
		if (!this.customModesManager) {
			this.logger.appendLine("[ModeFactory] CustomModesManager not set, cannot create mode")
			return null
		}

		const config = this.deriveModeFromPattern(pattern)
		if (!config) return null

		try {
			await this.customModesManager.updateCustomMode(config.slug, config)
			this.logger.appendLine(`[ModeFactory] Created/updated custom mode: ${config.slug} (${config.name})`)
			return config.slug
		} catch (error) {
			this.logger.appendLine(
				`[ModeFactory] Failed to create mode: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	/**
	 * Batch create modes from multiple patterns.
	 * Returns array of successfully created mode slugs.
	 */
	async createModesFromPatterns(patterns: LearnedPattern[]): Promise<string[]> {
		const created: string[] = []
		for (const pattern of patterns) {
			const slug = await this.createModeFromPattern(pattern)
			if (slug) created.push(slug)
		}
		return created
	}

	private generateSlug(pattern: LearnedPattern): string | null {
		const toolNames = pattern.context?.toolNames
		if (!toolNames || toolNames.length === 0) return null

		const base = toolNames.slice(0, 2).join("-")
		const sanitized = base.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()
		const truncated = sanitized.slice(0, 64)
		return truncated.replace(/^-+|-+$/g, "") || "auto-mode"
	}

	private generateName(pattern: LearnedPattern): string {
		const toolNames = pattern.context?.toolNames
		if (toolNames && toolNames.length > 0) {
			const toolLabels = toolNames.map((t) => t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
			return `${toolLabels.slice(0, 3).join(" + ")} Specialist`
		}
		return `Auto Mode (${pattern.patternType})`
	}

	private generateRoleDefinition(pattern: LearnedPattern): string {
		const toolNames = pattern.context?.toolNames || []
		const errorKeys = pattern.context?.errorKeys || []
		const modes = pattern.context?.modes || []
		const successRate = pattern.successRate ?? 0.5
		const confidence = pattern.confidenceScore ?? 0.5

		let role = `You are a specialized mode optimized for:\n\n`

		if (toolNames.length > 0) {
			role += `## Tools\n`
			role += `You specialize in using: ${toolNames.join(", ")}\n\n`
		}

		if (pattern.patternType === "error" && errorKeys.length > 0) {
			role += `## Error Avoidance\n`
			role += `You are designed to avoid these known error patterns: ${errorKeys.join(", ")}\n\n`
		}

		if (modes.length > 0) {
			role += `## Context\n`
			role += `This mode was learned from work in: ${modes.join(", ")}\n\n`
		}

		role += `## Performance\n`
		role += `- Success rate: ${(successRate * 100).toFixed(0)}%\n`
		role += `- Confidence score: ${(confidence * 100).toFixed(0)}%\n`
		role += `- Frequency: ${pattern.frequency} occurrences\n\n`

		role += `## Instructions\n`
		role += `Follow the established patterns and best practices that led to the creation of this mode. `

		if (pattern.summary) {
			role += `\n\nPattern summary: ${pattern.summary}`
		}

		return role
	}

	private deriveGroups(toolNames: string[]): GroupEntry[] {
		const groupSet = new Set<ToolGroup>()

		for (const toolName of toolNames) {
			const group = TOOL_TO_GROUP_MAP[toolName]
			if (group) {
				groupSet.add(group)
			}
		}

		return Array.from(groupSet)
	}
}
