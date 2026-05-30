import type { Logger, Experiments } from "./types"
import type { CodeIndexManager } from "../code-index/manager"

export interface TrustConfig {
	enabled: boolean
	autoApproveRead: boolean // auto-approve read operations
	autoApproveWrite: boolean // auto-approve write operations
	autoApproveCommands: boolean // auto-approve command execution
	autoApproveMcp: boolean // auto-approve MCP tool calls
	autoApproveModeSwitch: boolean // auto-approve mode switches
	maxConsecutiveActions: number // max actions before requiring confirmation (0 = unlimited)
	trustedCommands: string[] // specific commands to auto-approve (e.g., ["npm test", "git status"])
	trustedPaths: string[] // file path patterns to auto-approve writes to
}

const DEFAULT_CONFIG: TrustConfig = {
	enabled: false,
	autoApproveRead: true,
	autoApproveWrite: false,
	autoApproveCommands: false,
	autoApproveMcp: false,
	autoApproveModeSwitch: false,
	maxConsecutiveActions: 0,
	trustedCommands: [],
	trustedPaths: [],
}

export class TrustService {
	private logger: Logger
	private config: TrustConfig
	private consecutiveActions: number = 0
	/** Tracks whether the current task has already completed, preventing auto-approval of attempt_completion */
	public taskCompleted: boolean = false
	private codeIndexManager: CodeIndexManager | undefined
	private getExperiments: (() => Experiments | undefined) | undefined

	constructor(logger: Logger, config?: Partial<TrustConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	/**
	 * Set the CodeIndexManager instance for vector-search-based pattern retrieval.
	 */
	setCodeIndexManager(manager: CodeIndexManager | undefined): void {
		this.codeIndexManager = manager
	}

	/**
	 * Set the experiments accessor for feature gating.
	 */
	setExperimentsAccessor(getExperiments: () => Experiments | undefined): void {
		this.getExperiments = getExperiments
	}

	getConfig(): TrustConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<TrustConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[TrustService] Config updated: ${JSON.stringify(updates)}`)
	}

	/**
	 * Check if a tool/command should be auto-approved.
	 */
	shouldAutoApprove(toolName: string, params?: { command?: string; path?: string; mode?: string }): boolean {
		if (!this.config.enabled) {
			return false
		}

		// Check max consecutive actions limit
		if (this.config.maxConsecutiveActions > 0 && this.consecutiveActions >= this.config.maxConsecutiveActions) {
			this.logger.appendLine(
				`[TrustService] Max consecutive actions (${this.config.maxConsecutiveActions}) reached, requiring confirmation`,
			)
			return false
		}

		let approved = false

		switch (toolName) {
			case "read_file":
			case "search_files":
			case "list_files":
				approved = this.config.autoApproveRead
				break

			case "write_file":
			case "edit_file":
			case "create_file":
			case "delete_file":
				if (this.config.autoApproveWrite && params?.path) {
					approved = this.isPathTrusted(params.path)
				} else {
					approved = this.config.autoApproveWrite
				}
				break

			case "execute_command":
			case "bash":
			case "powershell":
				if (this.config.autoApproveCommands && params?.command) {
					approved = this.isCommandTrusted(params.command)
				} else {
					approved = this.config.autoApproveCommands
				}
				break

			case "use_mcp_tool":
			case "access_mcp_resource":
				approved = this.config.autoApproveMcp
				break

			case "switch_mode":
				approved = this.config.autoApproveModeSwitch
				break

			case "ask_followup_question":
				// These are always auto-approved (they're user-facing, not dangerous)
				approved = true
				break

			case "attempt_completion":
				// Check if task already completed before auto-approving
				if (this.taskCompleted) {
					this.logger.appendLine(`[TrustService] Blocked attempt_completion: task already completed`)
					return false
				}
				approved = true
				break

			default:
				approved = false
		}

		if (approved) {
			this.consecutiveActions++
			this.logger.appendLine(
				`[TrustService] Auto-approved: ${toolName} (consecutive: ${this.consecutiveActions})`,
			)
		}

		return approved
	}

	/**
	 * Reset the consecutive action counter (call after user interaction).
	 */
	resetConsecutiveCounter(): void {
		this.consecutiveActions = 0
	}

	/**
	 * Check if a command is in the trusted list.
	 */
	private isCommandTrusted(command: string): boolean {
		if (this.config.trustedCommands.length === 0) {
			return true
		} // if autoApproveCommands is on, all commands trusted

		return this.config.trustedCommands.some((trusted) => {
			if (trusted.endsWith("*")) {
				return command.startsWith(trusted.slice(0, -1))
			}
			return command === trusted || command.startsWith(trusted)
		})
	}

	/**
	 * Check if a file path matches trusted patterns.
	 */
	private isPathTrusted(filePath: string): boolean {
		if (this.config.trustedPaths.length === 0) {
			return true
		} // if autoApproveWrite is on, all paths trusted

		return this.config.trustedPaths.some((pattern) => {
			if (pattern.endsWith("*")) {
				return filePath.startsWith(pattern.slice(0, -1))
			}
			if (pattern.endsWith("/")) {
				return filePath.startsWith(pattern)
			}
			return filePath === pattern || filePath.startsWith(pattern + "/")
		})
	}

	/**
	 * Search for similar patterns using vector search.
	 * Uses CodeIndexManager to find past successful/failed patterns similar to current context.
	 * Informs trust scoring decisions.
	 * Gated behind selfImprovingCodeIndex experiment flag.
	 */
	async searchSimilarPatterns(
		context: string,
	): Promise<Array<{ summary: string; score: number; filePath?: string }>> {
		const experiments = this.getExperiments?.()
		if (experiments?.selfImprovingCodeIndex === false) {
			return []
		}

		if (!this.codeIndexManager) {
			return []
		}

		try {
			const results = await this.codeIndexManager.searchIndex(context)
			if (!results || results.length === 0) {
				return []
			}

			return results
				.filter((r) => r.payload?.codeChunk)
				.map((r) => ({
					summary: r.payload?.codeChunk?.slice(0, 200) ?? "",
					score: r.score,
					filePath: r.payload?.filePath,
				}))
		} catch (error) {
			this.logger.appendLine(
				`[TrustService] searchSimilarPatterns error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	getStatus(): Record<string, unknown> {
		return {
			enabled: this.config.enabled,
			autoApproveRead: this.config.autoApproveRead,
			autoApproveWrite: this.config.autoApproveWrite,
			autoApproveCommands: this.config.autoApproveCommands,
			autoApproveMcp: this.config.autoApproveMcp,
			autoApproveModeSwitch: this.config.autoApproveModeSwitch,
			maxConsecutiveActions: this.config.maxConsecutiveActions,
			trustedCommands: this.config.trustedCommands.length,
			trustedPaths: this.config.trustedPaths.length,
			consecutiveActions: this.consecutiveActions,
		}
	}
}
