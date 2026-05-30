import type { Logger } from "./types"
import type { ClassifiedError } from "./ErrorClassifier"
import { ErrorCategory } from "./ErrorClassifier"
import type { CodeIndexAdapter } from "./CodeIndexAdapter"
import type { VectorStoreSearchResult } from "../code-index/interfaces/vector-store"

export interface ResilienceConfig {
	enabled: boolean
	maxRetries: number
	baseDelayMs: number
	maxDelayMs: number
	jitterFactor: number
	autoRecover: boolean
	recoveryCommands: string[]
	persistState: boolean
}

export interface RecoveryState {
	consecutiveFailures: number
	lastFailureType: string | null
	lastFailureTime: number | null
	lastSuccessfulTool: string | null
	recoveryAttempts: number
	isInRecoveryMode: boolean
}

const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	maxRetries: 5,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	jitterFactor: 0.1,
	autoRecover: true,
	recoveryCommands: [
		"break down the task into smaller steps",
		"simplify the approach",
		"try a different strategy",
		"verify tool parameters before calling",
	],
	persistState: true,
}

export class ResilienceService {
	private logger: Logger
	private config: ResilienceConfig
	private state: RecoveryState
	private codeIndexAdapter: CodeIndexAdapter | undefined

	constructor(logger: Logger, config?: Partial<ResilienceConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.state = this.getInitialState()
	}

	setCodeIndexAdapter(adapter: CodeIndexAdapter | undefined): void {
		this.codeIndexAdapter = adapter
	}

	getConfig(): ResilienceConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<ResilienceConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[Resilience] Config updated: ${JSON.stringify(updates)}`)
	}

	getState(): RecoveryState {
		return { ...this.state }
	}

	/**
	 * Called when a "having trouble" or streaming failure occurs.
	 * Returns the delay in ms before the next retry, or -1 if max retries exceeded.
	 */
	onStreamingFailure(): number {
		if (!this.config.enabled) {
			return -1
		}

		this.state.consecutiveFailures++
		this.state.lastFailureType = "streaming_failed"
		this.state.lastFailureTime = Date.now()
		this.state.isInRecoveryMode = true

		if (this.state.consecutiveFailures > this.config.maxRetries) {
			this.logger.appendLine(
				`[Resilience] Max retries (${this.config.maxRetries}) exceeded. Entering recovery mode.`,
			)
			return -1 // Signal to enter recovery mode
		}

		const delay = this.calculateBackoff(this.state.consecutiveFailures)
		this.logger.appendLine(
			`[Resilience] Streaming failure #${this.state.consecutiveFailures}. Retrying in ${delay}ms.`,
		)
		return delay
	}

	/**
	 * Called when a tool parameter validation error occurs (e.g., missing required parameter).
	 * Returns a recovery action suggestion or null.
	 */
	onToolParameterError(
		toolName: string,
		missingParam: string,
	): { action: "retry" | "recover" | "abort"; delay?: number; suggestion?: string } | null {
		if (!this.config.enabled) {
			return null
		}

		this.state.consecutiveFailures++
		this.state.lastFailureType = "tool_parameter_error"
		this.state.lastFailureTime = Date.now()
		this.state.lastSuccessfulTool = toolName

		this.logger.appendLine(
			`[Resilience] Tool parameter error: ${toolName} missing '${missingParam}'. Failure #${this.state.consecutiveFailures}.`,
		)

		// Record this as a learning event for the self-improving system
		this.recordToolError(toolName, missingParam)

		if (this.state.consecutiveFailures > this.config.maxRetries) {
			return {
				action: "abort",
				suggestion: `Tool ${toolName} repeatedly missing required parameter '${missingParam}'`,
			}
		}

		const delay = this.calculateBackoff(this.state.consecutiveFailures)
		return {
			action: "retry",
			delay,
			suggestion: `Ensure '${missingParam}' parameter is provided when calling ${toolName}`,
		}
	}

	/**
	 * Check if the streaming failure is due to a large response (not model error).
	 * Large responses occur when the model tries to deliver a comprehensive result
	 * that exceeds API limits — this is not a model error and should not trigger recovery.
	 */
	isLargeResponseFailure(error: string): boolean {
		const largeResponseIndicators = [
			"response too large",
			"response too long",
			"max_tokens",
			"maximum context length",
			"too many tokens",
			"content too large",
			"stream.*timeout",
			"timeout.*stream",
			"413",
			"payload too large",
		]
		return largeResponseIndicators.some((indicator) => new RegExp(indicator, "i").test(error))
	}

	/**
	 * Handle a large response failure — suggest shortening instead of triggering recovery.
	 * Does NOT increment consecutiveFailures since this isn't a model error.
	 */
	onLargeResponseFailure(): string {
		return "The response was too large. Shorten the response and try again. Consider summarizing or splitting into smaller chunks."
	}

	/**
	 * Called when the model is attempting to deliver a final result (attempt_completion).
	 * Resets recovery state to prevent false positive recovery from large response failures.
	 */
	onDeliveryAttempt(): void {
		this.state.consecutiveFailures = 0
		this.state.isInRecoveryMode = false
		this.state.recoveryAttempts = 0
	}

	/**
	 * Called when a task succeeds — resets recovery state.
	 */
	onTaskSuccess(): void {
		if (this.state.consecutiveFailures > 0) {
			this.logger.appendLine(
				`[Resilience] Task succeeded after ${this.state.consecutiveFailures} failures. Resetting state.`,
			)
		}
		this.state = this.getInitialState()
	}

	/**
	 * Get a recovery command suggestion based on current state.
	 */
	getRecoverySuggestion(): string {
		if (!this.state.isInRecoveryMode) {
			return ""
		}

		const index = Math.min(this.state.recoveryAttempts, this.config.recoveryCommands.length - 1)
		this.state.recoveryAttempts++

		const suggestion = this.config.recoveryCommands[index] ?? this.config.recoveryCommands[0]
		return suggestion
	}

	/**
	 * Check if the system is in recovery mode.
	 */
	isInRecoveryMode(): boolean {
		return this.state.isInRecoveryMode
	}

	/**
	 * Exit recovery mode (called when a task succeeds after recovery).
	 */
	exitRecoveryMode(): void {
		this.state.isInRecoveryMode = false
		this.state.recoveryAttempts = 0
		this.logger.appendLine("[Resilience] Exited recovery mode.")
	}

	/**
	 * Record a tool error for the self-improving system to learn from.
	 */
	private recordToolError(toolName: string, missingParam: string): void {
		this.logger.appendLine(`[Resilience] Recording tool error for learning: ${toolName}.${missingParam}`)
	}

	/**
	 * Calculate exponential backoff with jitter.
	 */
	private calculateBackoff(attempt: number): number {
		const exponentialDelay = Math.min(this.config.baseDelayMs * Math.pow(2, attempt - 1), this.config.maxDelayMs)
		const jitter = exponentialDelay * this.config.jitterFactor * Math.random()
		return Math.floor(exponentialDelay + jitter)
	}

	private getInitialState(): RecoveryState {
		return {
			consecutiveFailures: 0,
			lastFailureType: null,
			lastFailureTime: null,
			lastSuccessfulTool: null,
			recoveryAttempts: 0,
			isInRecoveryMode: false,
		}
	}

	/**
	 * Format a single VectorStoreSearchResult into a human-readable context line.
	 */
	private formatSearchResult(result: VectorStoreSearchResult): string {
		const filePath = result.payload?.filePath ?? String(result.id)
		const startLine = result.payload?.startLine
		const endLine = result.payload?.endLine
		const snippet = result.payload?.codeChunk
		const lineRange =
			startLine !== undefined && endLine !== undefined
				? ` (lines ${startLine}-${endLine})`
				: startLine !== undefined
					? ` (line ${startLine})`
					: ""
		const snippetStr = snippet ? `: ${snippet.slice(0, 200).replace(/\n/g, " ")}` : ""
		return `- ${filePath}${lineRange}${snippetStr}`
	}

	/**
	 * Generate a recovery context block based on the classified error, original message,
	 * and recent conversation history.
	 *
	 * Uses actual recent messages (last user req + last assistant res) to build a
	 * contextual task summary, then queries the code index for relevant context.
	 * Non-blocking — returns original message on any error or when no enrichment is needed.
	 * Gated behind recoveryContext experiment flag.
	 */
	async generateRecoveryContext(
		classifiedError: ClassifiedError,
		originalMessage: string,
		experiments?: Record<string, boolean>,
		recentMessages?: string[],
	): Promise<string> {
		// Only enrich for MODEL_THOUGHT_FAILURE with break_down_task recovery
		if (
			classifiedError.category !== ErrorCategory.MODEL_THOUGHT_FAILURE ||
			classifiedError.recoveryAction !== "break_down_task"
		) {
			return originalMessage
		}

		// Check experiment gate
		if (experiments?.recoveryContext === false) {
			return originalMessage
		}

		// Build task summary from recent conversation messages
		const taskSummary = this.buildTaskSummary(recentMessages)

		// Use task summary as the search query for code index (more contextual than originalMessage)
		const searchQuery = taskSummary || originalMessage

		// Try to enrich with code index context
		if (this.codeIndexAdapter?.isAvailable()) {
			try {
				const results = await this.codeIndexAdapter.searchVectorStore(searchQuery)
				if (results && results.length > 0) {
					const contextLines = results.map((r) => this.formatSearchResult(r))
					const contextBlock = [
						`[Context Recovery] You were working on: ${taskSummary || "a task that failed"}. Here is relevant code context:`,
						...contextLines,
					].join("\n")

					this.logger.appendLine(
						`[Resilience] Recovery context generated: ${results.length} code index results (taskSummary: "${(taskSummary || originalMessage).slice(0, 80)}")`,
					)
					return `${originalMessage}\n\n${contextBlock}`
				}
			} catch (error) {
				// Graceful fallback — log and return original message
				this.logger.appendLine(
					`[Resilience] Recovery context generation error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// Fallback: inject contextual guidance referencing the actual task
		const fallbackGuidance = taskSummary
			? `[Context Recovery] You were working on: ${taskSummary}. Consider breaking this into smaller, more focused steps. Try using a simpler approach or different tool.`
			: "[Context Recovery] The previous attempt failed. Consider breaking the task into smaller, more focused steps. Try using a simpler approach or different tool."
		return `${originalMessage}\n\n${fallbackGuidance}`
	}

	/**
	 * Build a concise task summary from recent conversation messages.
	 * Extracts the last user request and last assistant response to describe
	 * what the agent was trying to do when it failed.
	 */
	private buildTaskSummary(recentMessages?: string[]): string {
		if (!recentMessages || recentMessages.length === 0) {
			return ""
		}

		// Find the last user message (request) and last assistant message (response)
		let lastUserReq = ""
		let lastAssistantRes = ""

		for (const msg of recentMessages) {
			// Simple heuristic: user messages are typically requests/instructions
			if (msg.startsWith("[USER]")) {
				lastUserReq = msg.slice(6).trim()
			} else if (msg.startsWith("[ASSISTANT]")) {
				lastAssistantRes = msg.slice(11).trim()
			}
		}

		// Build summary from the last user request
		if (lastUserReq) {
			// Truncate to first 200 chars for a concise summary
			const truncated = lastUserReq.length > 200
				? lastUserReq.slice(0, 200) + "..."
				: lastUserReq
			return truncated
		}

		// Fallback to assistant response if no user message found
		if (lastAssistantRes) {
			const truncated = lastAssistantRes.length > 200
				? lastAssistantRes.slice(0, 200) + "..."
				: lastAssistantRes
			return truncated
		}

		return ""
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			maxRetries: this.config.maxRetries,
			autoRecover: this.config.autoRecover,
			consecutiveFailures: this.state.consecutiveFailures,
			isInRecoveryMode: this.state.isInRecoveryMode,
			lastFailureType: this.state.lastFailureType,
			recoveryAttempts: this.state.recoveryAttempts,
		}
	}
}
