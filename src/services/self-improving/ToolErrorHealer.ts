import type { Logger } from "./types"

export interface ToolErrorHealerConfig {
	enabled: boolean
	autoCorrect: boolean
	learnFromCorrections: boolean
	maxCorrectionsPerTool: number
}

interface ToolCorrection {
	toolName: string
	missingParam: string
	fixStrategy: string
	occurrences: number
	lastSeen: Date
}

const DEFAULT_CONFIG: ToolErrorHealerConfig = {
	enabled: true,
	autoCorrect: true,
	learnFromCorrections: true,
	maxCorrectionsPerTool: 10,
}

/**
 * Known parameter requirements for tools that commonly have issues.
 * Maps tool names to their required parameters and common fixes.
 */
const KNOWN_TOOL_REQUIREMENTS: Record<string, { param: string; defaultValue?: string; hint: string }[]> = {
	search_files: [
		{ param: "regex", hint: "Provide a valid regex pattern for the search" },
		{ param: "path", hint: "Specify the directory path to search in" },
	],
	read_file: [{ param: "path", hint: "Specify the file path to read" }],
	write_to_file: [
		{ param: "path", hint: "Specify the file path to write to" },
		{ param: "content", hint: "Provide the content to write" },
	],
	apply_diff: [
		{ param: "path", hint: "Specify the file path to edit" },
		{ param: "diff", hint: "Provide the diff content to apply" },
	],
	execute_command: [{ param: "command", hint: "Provide the command to execute" }],
	use_mcp_tool: [
		{ param: "server_name", hint: "Specify the MCP server name" },
		{ param: "tool_name", hint: "Specify the tool name to call" },
		{ param: "arguments", hint: "Provide the tool arguments as JSON" },
	],
	access_mcp_resource: [
		{ param: "server_name", hint: "Specify the MCP server name" },
		{ param: "uri", hint: "Specify the resource URI" },
	],
	ask_followup_question: [{ param: "question", hint: "Provide the question to ask" }],
	attempt_completion: [{ param: "result", hint: "Provide the completion result" }],
	new_task: [
		{ param: "mode", hint: "Specify the mode for the new task" },
		{ param: "message", hint: "Provide the task message" },
	],
}

export class ToolErrorHealer {
	private logger: Logger
	private config: ToolErrorHealerConfig
	private corrections: Map<string, ToolCorrection[]> = new Map()

	constructor(logger: Logger, config?: Partial<ToolErrorHealerConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	getConfig(): ToolErrorHealerConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<ToolErrorHealerConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[ToolErrorHealer] Config updated: ${JSON.stringify(updates)}`)
	}

	/**
	 * Get a healing suggestion for a tool error message.
	 * Parses the error message to extract the missing parameter name,
	 * then looks up the known fix for that tool+parameter combination.
	 * Returns a human-readable suggestion string or null if no fix known.
	 */
	getHealingSuggestion(toolName: string, errorMessage: string): string | null {
		if (!this.config.enabled) {
			return null
		}

		// Try to extract missing parameter name from common error patterns
		const paramMatch = errorMessage.match(/parameter\s+'([^']+)'/i)
		const missingParam = paramMatch?.[1]

		if (!missingParam) {
			return null
		}

		const requirements = KNOWN_TOOL_REQUIREMENTS[toolName]
		if (!requirements) {
			return null
		}

		const req = requirements.find((r) => r.param === missingParam)
		if (!req) {
			return null
		}

		return `Suggestion: ${req.hint}`
	}

	/**
	 * Handle a tool parameter error. Returns a fix suggestion or null.
	 */
	handleToolError(toolName: string, missingParam: string): { fix: string; autoCorrectable: boolean } | null {
		if (!this.config.enabled) {
			return null
		}

		// Check if we have a known fix first (before recording, so unknown tools don't get learned fixes)
		const knownFix = this.getKnownFix(toolName, missingParam)
		if (knownFix) {
			this.logger.appendLine(`[ToolErrorHealer] Known fix for ${toolName}.${missingParam}: ${knownFix.fix}`)
			// Record the error for learning purposes
			this.recordError(toolName, missingParam)
			return knownFix
		}

		// For unknown tools, only return a learned fix if we've seen this error before
		// and have enough occurrences to auto-correct
		const learnedFix = this.getLearnedFix(toolName, missingParam)
		if (learnedFix && learnedFix.autoCorrectable) {
			this.logger.appendLine(`[ToolErrorHealer] Learned fix for ${toolName}.${missingParam}: ${learnedFix.fix}`)
			// Record the error for learning purposes
			this.recordError(toolName, missingParam)
			return learnedFix
		}

		// Record the error for future learning
		this.recordError(toolName, missingParam)

		return null
	}

	/**
	 * Get all known parameter requirements for a tool.
	 */
	getToolRequirements(toolName: string): { param: string; hint: string }[] {
		return KNOWN_TOOL_REQUIREMENTS[toolName] ?? []
	}

	/**
	 * Check if a tool has known parameter requirements.
	 */
	hasKnownRequirements(toolName: string): boolean {
		return toolName in KNOWN_TOOL_REQUIREMENTS
	}

	/**
	 * Get a summary of all recorded corrections for learning.
	 */
	getCorrectionSummary(): { toolName: string; missingParam: string; occurrences: number }[] {
		const summary: { toolName: string; missingParam: string; occurrences: number }[] = []
		for (const [, corrections] of this.corrections) {
			for (const c of corrections) {
				summary.push({
					toolName: c.toolName,
					missingParam: c.missingParam,
					occurrences: c.occurrences,
				})
			}
		}
		return summary
	}

	private recordError(toolName: string, missingParam: string): void {
		if (!this.config.learnFromCorrections) {
			return
		}

		const key = `${toolName}:${missingParam}`
		let toolCorrections = this.corrections.get(key)

		if (toolCorrections) {
			const existing = toolCorrections.find((c) => c.toolName === toolName && c.missingParam === missingParam)
			if (existing) {
				existing.occurrences++
				existing.lastSeen = new Date()
			} else {
				toolCorrections.push({
					toolName,
					missingParam,
					fixStrategy: `Ensure '${missingParam}' is provided when calling ${toolName}`,
					occurrences: 1,
					lastSeen: new Date(),
				})
			}
		} else {
			this.corrections.set(key, [
				{
					toolName,
					missingParam,
					fixStrategy: `Ensure '${missingParam}' is provided when calling ${toolName}`,
					occurrences: 1,
					lastSeen: new Date(),
				},
			])
		}

		// Trim to max
		const allCorrections = this.corrections.get(key) ?? []
		if (allCorrections.length > this.config.maxCorrectionsPerTool) {
			allCorrections.sort((a, b) => b.occurrences - a.occurrences)
			this.corrections.set(key, allCorrections.slice(0, this.config.maxCorrectionsPerTool))
		}
	}

	private getKnownFix(toolName: string, missingParam: string): { fix: string; autoCorrectable: boolean } | null {
		const requirements = KNOWN_TOOL_REQUIREMENTS[toolName]
		if (!requirements) {
			return null
		}

		const req = requirements.find((r) => r.param === missingParam)
		if (!req) {
			return null
		}

		return {
			fix: req.hint,
			autoCorrectable: this.config.autoCorrect,
		}
	}

	private getLearnedFix(toolName: string, missingParam: string): { fix: string; autoCorrectable: boolean } | null {
		const key = `${toolName}:${missingParam}`
		const toolCorrections = this.corrections.get(key)
		if (!toolCorrections || toolCorrections.length === 0) {
			return null
		}

		const best = toolCorrections.reduce((a, b) => (a.occurrences > b.occurrences ? a : b))

		return {
			fix: best.fixStrategy,
			autoCorrectable: this.config.autoCorrect && best.occurrences >= 2,
		}
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			autoCorrect: this.config.autoCorrect,
			knownTools: Object.keys(KNOWN_TOOL_REQUIREMENTS).length,
			recordedCorrections: this.getCorrectionSummary().length,
		}
	}
}
