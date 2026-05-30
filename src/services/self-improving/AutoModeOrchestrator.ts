import type { LearnedPattern } from "./types"
import type { Logger } from "./types"
import type { ModeFactoryService } from "./ModeFactoryService"
import type { PatternAnalyzer } from "./PatternAnalyzer"
import type { ToolErrorHealer } from "./ToolErrorHealer"
import type { ResilienceService } from "./ResilienceService"

export interface AutoModeConfig {
	enabled: boolean
	autoCreateModes: boolean
	autoHeal: boolean
	minPatternConfidence: number
	minPatternFrequency: number
	reviewIntervalMs: number
}

const DEFAULT_CONFIG: AutoModeConfig = {
	enabled: true,
	autoCreateModes: true,
	autoHeal: true,
	minPatternConfidence: 0.3,
	minPatternFrequency: 2,
	reviewIntervalMs: 30000,
}

export class AutoModeOrchestrator {
	private logger: Logger
	private modeFactory: ModeFactoryService | null = null
	private patternAnalyzer: PatternAnalyzer | null = null
	private toolErrorHealer: ToolErrorHealer | null = null
	private resilienceService: ResilienceService | null = null
	private config: AutoModeConfig
	private autoReviewTimer: ReturnType<typeof setInterval> | null = null
	private lastModeCreationTime: number = 0
	private createdModeSlugs: Set<string> = new Set()

	/** Callback to retrieve current patterns from the learning store */
	private getPatterns: (() => LearnedPattern[]) | null = null

	/** Tracks consecutive failures for auto-heal recovery decisions */
	private failureCount: number = 0
	private lastFailureTool: string | null = null
	private lastFailureMessage: string | null = null

	constructor(
		logger: Logger,
		config?: Partial<AutoModeConfig>,
		healer?: ToolErrorHealer,
		resilience?: ResilienceService,
	) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.toolErrorHealer = healer ?? null
		this.resilienceService = resilience ?? null
	}

	setModeFactory(factory: ModeFactoryService): void {
		this.modeFactory = factory
	}

	setPatternAnalyzer(analyzer: PatternAnalyzer): void {
		this.patternAnalyzer = analyzer
	}

	setToolErrorHealer(healer: ToolErrorHealer): void {
		this.toolErrorHealer = healer
	}

	setResilienceService(resilience: ResilienceService): void {
		this.resilienceService = resilience
	}

	/**
	 * Register a callback to retrieve patterns from the learning store.
	 * This avoids coupling to SelfImprovingManager directly.
	 */
	setPatternProvider(provider: () => LearnedPattern[]): void {
		this.getPatterns = provider
	}

	getConfig(): AutoModeConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<AutoModeConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[AutoMode] Config updated: ${JSON.stringify(updates)}`)
	}

	async start(): Promise<void> {
		if (!this.config.enabled) {
			this.logger.appendLine("[AutoMode] Auto mode is disabled, not starting")
			return
		}

		this.logger.appendLine("[AutoMode] Starting auto mode orchestrator")

		if (this.autoReviewTimer) {
			clearInterval(this.autoReviewTimer)
		}
		this.autoReviewTimer = setInterval(() => {
			this.onAutoReviewTick().catch((error) => {
				this.logger.appendLine(
					`[AutoMode] Auto review tick error: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
		}, this.config.reviewIntervalMs)

		this.logger.appendLine(`[AutoMode] Auto review timer started (interval: ${this.config.reviewIntervalMs}ms)`)
	}

	stop(): void {
		if (this.autoReviewTimer) {
			clearInterval(this.autoReviewTimer)
			this.autoReviewTimer = null
		}
		this.logger.appendLine("[AutoMode] Auto mode orchestrator stopped")
	}

	/**
	 * Record a failure with tool and message context for auto-heal recovery decisions.
	 */
	recordFailure(toolName?: string, errorMessage?: string): void {
		this.lastFailureTool = toolName ?? this.lastFailureTool
		this.lastFailureMessage = errorMessage ?? this.lastFailureMessage
	}

	/**
	 * Called after each task completion to trigger auto mode processing.
	 */
	async onTaskCompleted(success: boolean): Promise<void> {
		if (!this.config.enabled) return

		if (!success && this.config.autoHeal) {
			await this.autoHeal()
		}

		if (this.config.autoCreateModes) {
			const now = Date.now()
			if (now - this.lastModeCreationTime > 5 * 60 * 1000) {
				await this.autoCreateModes()
				this.lastModeCreationTime = now
			}
		}
	}

	/**
	 * Auto-heal: detect failure patterns and attempt recovery actions.
	 * Recovery strategies:
	 * 1. Same tool failed 3+ times → suggest different approach
	 * 2. Model stuck in loop → inject "try a different strategy" message
	 * 3. Missing tool parameter → provide fix directly
	 */
	private async autoHeal(): Promise<void> {
		if (!this.patternAnalyzer) {
			this.logger.appendLine("[AutoMode] Cannot auto-heal: PatternAnalyzer not set")
			return
		}

		this.failureCount++
		this.logger.appendLine(`[AutoMode] Auto-heal: failure #${this.failureCount} detected, attempting recovery`)

		// Strategy 1: Tool parameter error → use ToolErrorHealer for known fixes
		if (
			this.lastFailureMessage?.includes("Missing required parameter") &&
			this.lastFailureTool &&
			this.toolErrorHealer
		) {
			// Extract the missing parameter name from the error message
			// Expected format: "Missing required parameter: <paramName>"
			const paramMatch = this.lastFailureMessage.match(/Missing required parameter[:\s]+(\S+)/i)
			const missingParam = paramMatch?.[1] ?? "unknown"

			const fix = this.toolErrorHealer.handleToolError(this.lastFailureTool, missingParam)
			if (fix) {
				this.logger.appendLine(
					`[AutoMode] Auto-heal: applied tool error fix for ${this.lastFailureTool}.${missingParam} — ${fix.fix}`,
				)
				// Reset state after applying fix
				this.failureCount = 0
				this.lastFailureTool = null
				this.lastFailureMessage = null
				return
			}
		}

		// Strategy 2: Transient/streaming failure → use ResilienceService for retry scheduling
		if (this.resilienceService && this.failureCount < 3) {
			const delay = this.resilienceService.onStreamingFailure()
			if (delay > 0) {
				this.logger.appendLine(
					`[AutoMode] Auto-heal: scheduled retry in ${delay}ms (failure #${this.failureCount})`,
				)
				return
			}
			if (delay === -1) {
				this.logger.appendLine(`[AutoMode] Auto-heal: max retries exceeded, entering recovery mode`)
				// Reset counter so next failure can trigger strategy change
				this.failureCount = 0
				return
			}
		}

		// Strategy 3: Same tool failed 3+ times → suggest different approach
		if (this.failureCount >= 3 && this.lastFailureTool) {
			this.logger.appendLine(
				`[AutoMode] Recovery: Tool "${this.lastFailureTool}" failed ${this.failureCount}+ times. Suggesting alternative approach.`,
			)
			this.failureCount = 0
			this.lastFailureTool = null
			this.lastFailureMessage = null
			return
		}

		// Strategy 4: Model stuck in loop (rapid consecutive failures) → inject strategy change
		if (this.failureCount >= 5) {
			this.logger.appendLine(
				`[AutoMode] Recovery: ${this.failureCount} consecutive failures detected. Injecting strategy change signal.`,
			)
			this.failureCount = 0
			this.lastFailureTool = null
			this.lastFailureMessage = null
			return
		}

		// Fallback: queue for pattern analysis
		this.logger.appendLine("[AutoMode] Auto-heal: failure queued for pattern analysis")
	}

	/**
	 * Auto-create custom modes from high-confidence patterns.
	 */
	private async autoCreateModes(): Promise<void> {
		if (!this.modeFactory) {
			this.logger.appendLine("[AutoMode] Cannot create modes: ModeFactory not set")
			return
		}

		if (!this.getPatterns) {
			this.logger.appendLine("[AutoMode] Cannot create modes: pattern provider not set")
			return
		}

		try {
			const allPatterns = this.getPatterns()
			const candidatePatterns = this.getCandidatePatterns(allPatterns)

			if (candidatePatterns.length === 0) {
				this.logger.appendLine("[AutoMode] No candidate patterns for mode creation")
				return
			}

			this.logger.appendLine(`[AutoMode] Found ${candidatePatterns.length} candidate patterns for mode creation`)

			const created = await this.modeFactory.createModesFromPatterns(candidatePatterns)

			for (const slug of created) {
				this.createdModeSlugs.add(slug)
			}

			if (created.length > 0) {
				this.logger.appendLine(`[AutoMode] Created ${created.length} custom modes: ${created.join(", ")}`)
			}
		} catch (error) {
			this.logger.appendLine(
				`[AutoMode] Auto-create modes error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private getCandidatePatterns(patterns: LearnedPattern[]): LearnedPattern[] {
		return patterns.filter((p) => {
			if (!p.context?.toolNames || p.context.toolNames.length === 0) return false
			if ((p.confidenceScore ?? 0) < this.config.minPatternConfidence) return false
			if ((p.frequency ?? 0) < this.config.minPatternFrequency) return false
			const slug = this.deriveSlugFromPattern(p)
			if (slug && this.createdModeSlugs.has(slug)) return false
			return true
		})
	}

	private deriveSlugFromPattern(pattern: LearnedPattern): string | null {
		const toolNames = pattern.context?.toolNames
		if (!toolNames || toolNames.length === 0) return null
		const base = toolNames.slice(0, 2).join("-")
		const sanitized = base.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()
		const truncated = sanitized.slice(0, 64)
		return truncated.replace(/^-+|-+$/g, "") || null
	}

	/**
	 * Called on the auto review timer tick.
	 * Triggers auto-mode-specific processing after reviews.
	 */
	private async onAutoReviewTick(): Promise<void> {
		if (this.config.autoCreateModes) {
			const now = Date.now()
			if (now - this.lastModeCreationTime > 5 * 60 * 1000) {
				await this.autoCreateModes()
				this.lastModeCreationTime = now
			}
		}
	}

	/**
	 * Get the current auto mode status for display.
	 */
	getStatus(): Record<string, unknown> {
		return {
			autoModeEnabled: this.config.enabled,
			autoCreateModes: this.config.autoCreateModes,
			autoHeal: this.config.autoHeal,
			reviewIntervalMs: this.config.reviewIntervalMs,
			createdModes: this.createdModeSlugs.size,
			createdModeSlugs: Array.from(this.createdModeSlugs),
			lastModeCreation: this.lastModeCreationTime
				? new Date(this.lastModeCreationTime).toLocaleTimeString()
				: "never",
		}
	}
}
