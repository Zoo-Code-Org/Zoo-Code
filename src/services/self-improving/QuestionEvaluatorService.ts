import type { Logger } from "./types"
import type { ReviewTeamService } from "./ReviewTeamService"
import type { CodeIndexManager } from "../code-index/manager"
import type { Experiments } from "./types"
import type { AccumulatedScoreStore } from "./AccumulatedScoreStore"
import type { LLMScorer, LLMScoreInput } from "./LLMScorer"

export interface QuestionEvaluationConfig {
	enabled: boolean
	useFullTeam: boolean // use ReviewTeamService when Full Team is enabled
	useContextualAnalysis: boolean // do contextual analysis when Full Auto is enabled
	doResearchBeforeDeciding: boolean // spawn subtask for deeper research
	minChoicesForEvaluation: number // minimum choices to trigger evaluation (default 2)
	useHybridScoring: boolean // use AccumulatedScoreStore + LLMScorer two-tier scoring (default true)
}

/** Threshold below which accumulated score is used directly (fast path) */
const HYBRID_CLEAR_LOW_THRESHOLD = 0.3

/** Threshold above which accumulated score is used directly (fast path) */
const HYBRID_CLEAR_HIGH_THRESHOLD = 0.7

export interface QuestionEvaluation {
	question: string
	choices: { text: string; mode: string | null }[]
	selectedIndex: number
	selectedText: string
	reasoning: string
	evaluatedBy: "full-team" | "contextual" | "research" | "fallback"
}

const DEFAULT_CONFIG: QuestionEvaluationConfig = {
	enabled: true,
	useFullTeam: true,
	useContextualAnalysis: true,
	doResearchBeforeDeciding: false,
	minChoicesForEvaluation: 2,
	useHybridScoring: true,
}

export class QuestionEvaluatorService {
	private logger: Logger
	private config: QuestionEvaluationConfig
	private reviewTeam: ReviewTeamService | null = null
	private codeIndexManager: CodeIndexManager | undefined
	private getExperiments: (() => Experiments | undefined) | undefined
	private accumulatedScoreStore: AccumulatedScoreStore | null = null
	private llmScorer: LLMScorer | null = null

	constructor(logger: Logger, config?: Partial<QuestionEvaluationConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	/**
	 * Set the AccumulatedScoreStore instance for hybrid scoring.
	 */
	setAccumulatedScoreStore(store: AccumulatedScoreStore | null): void {
		this.accumulatedScoreStore = store
	}

	/**
	 * Set the LLMScorer instance for hybrid scoring.
	 */
	setLLMScorer(scorer: LLMScorer | null): void {
		this.llmScorer = scorer
	}

	/**
	 * Set the CodeIndexManager instance for vector-search-based question similarity.
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

	getConfig(): QuestionEvaluationConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<QuestionEvaluationConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[QuestionEvaluator] Config updated: ${JSON.stringify(updates)}`)
	}

	setReviewTeam(team: ReviewTeamService): void {
		this.reviewTeam = team
	}

	/**
	 * Evaluate all choices and select the best one.
	 * Returns the index of the best choice.
	 */
	async evaluateBestChoice(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): Promise<QuestionEvaluation> {
		if (!this.config.enabled || choices.length < this.config.minChoicesForEvaluation) {
			// Fallback: select first choice
			return {
				question,
				choices,
				selectedIndex: 0,
				selectedText: this.resolveSelectedText(choices, 0),
				reasoning: "Evaluation disabled or too few choices",
				evaluatedBy: "fallback",
			}
		}

		// Strategy 0: Hybrid scoring (fast path + LLM slow path)
		if (this.config.useHybridScoring && this.accumulatedScoreStore) {
			const evaluation = await this.evaluateWithHybridScoring(question, choices, context)
			if (evaluation) return evaluation
		}

		// Strategy 1: Full Team evaluation (if enabled and ReviewTeamService is available)
		if (this.config.useFullTeam && this.reviewTeam) {
			const evaluation = await this.evaluateWithFullTeam(question, choices, context)
			if (evaluation) return evaluation
		}

		// Strategy 2: Contextual analysis (if enabled)
		if (this.config.useContextualAnalysis) {
			const evaluation = this.evaluateContextually(question, choices, context)
			if (evaluation) return evaluation
		}

		// Strategy 3: Research (if enabled) — would spawn a subtask
		if (this.config.doResearchBeforeDeciding) {
			this.logger.appendLine("[QuestionEvaluator] Research mode enabled but subtask spawning not yet implemented")
		}

		// Final fallback: first choice
		return {
			question,
			choices,
			selectedIndex: 0,
			selectedText: this.resolveSelectedText(choices, 0),
			reasoning: "No evaluation strategy produced a result",
			evaluatedBy: "fallback",
		}
	}

	/**
	 * Evaluate choices using hybrid scoring (two-tier: AccumulatedScoreStore + LLMScorer).
	 *
	 * Fast path: If accumulated score is ≤0.3 or ≥0.7, use it directly.
	 * Slow path: If score is between 0.3–0.7, call LLMScorer for semantic analysis.
	 *
	 * After task completion, callers should invoke recordPatternOutcome() to
	 * feed back the result into the AccumulatedScoreStore.
	 */
	private async evaluateWithHybridScoring(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): Promise<QuestionEvaluation | null> {
		if (!this.accumulatedScoreStore) return null

		this.logger.appendLine(
			`[QuestionEvaluator] Evaluating ${choices.length} choices with Hybrid Scoring for: "${question.substring(0, 60)}..."`,
		)

		const scores: { index: number; score: number; reasoning: string; usedLLM: boolean }[] = []

		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i]
			const patternKey = this.buildPatternKey(choice, question)

			// Fast path: check accumulated store
			const accumulatedScore = this.accumulatedScoreStore.getPatternScore(patternKey)

			if (accumulatedScore !== undefined) {
				// Clear low score → use directly (pattern is known to be bad)
				if (accumulatedScore <= HYBRID_CLEAR_LOW_THRESHOLD) {
					scores.push({
						index: i,
						score: accumulatedScore,
						reasoning: `Fast path: accumulated score ${accumulatedScore.toFixed(2)} (clear low, ≤${HYBRID_CLEAR_LOW_THRESHOLD})`,
						usedLLM: false,
					})
					continue
				}

				// Clear high score → use directly (pattern is known to be good)
				if (accumulatedScore >= HYBRID_CLEAR_HIGH_THRESHOLD) {
					scores.push({
						index: i,
						score: accumulatedScore,
						reasoning: `Fast path: accumulated score ${accumulatedScore.toFixed(2)} (clear high, ≥${HYBRID_CLEAR_HIGH_THRESHOLD})`,
						usedLLM: false,
					})
					continue
				}

				// Ambiguous range (0.3–0.7) → slow path: LLM evaluation
				if (this.llmScorer) {
					const llmInput: LLMScoreInput = {
						patternKey,
						tools: this.extractToolsFromChoice(choice),
						task: question,
						outcome: "success", // optimistic default; caller updates via recordPatternOutcome
					}

					try {
						const llmResult = await this.llmScorer.evaluate(llmInput)
						scores.push({
							index: i,
							score: llmResult.score,
							reasoning: `LLM path: ${llmResult.reasoning} (accumulated was ${accumulatedScore.toFixed(2)})`,
							usedLLM: true,
						})
						continue
					} catch (error) {
						this.logger.appendLine(
							`[QuestionEvaluator] LLM scoring failed for choice ${i}: ${error instanceof Error ? error.message : String(error)}`,
						)
						// Fall through to accumulated score
					}
				}

				// LLM unavailable or failed → use accumulated score as-is
				scores.push({
					index: i,
					score: accumulatedScore,
					reasoning: `Accumulated score ${accumulatedScore.toFixed(2)} (LLM unavailable for ambiguous range)`,
					usedLLM: false,
				})
			} else {
				// No accumulated data yet → use LLM if available, else neutral
				if (this.llmScorer) {
					const llmInput: LLMScoreInput = {
						patternKey,
						tools: this.extractToolsFromChoice(choice),
						task: question,
						outcome: "success",
					}

					try {
						const llmResult = await this.llmScorer.evaluate(llmInput)
						scores.push({
							index: i,
							score: llmResult.score,
							reasoning: `LLM path (no prior data): ${llmResult.reasoning}`,
							usedLLM: true,
						})
						continue
					} catch (error) {
						this.logger.appendLine(
							`[QuestionEvaluator] LLM scoring failed for new choice ${i}: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}

				// No data and no LLM → neutral score
				scores.push({
					index: i,
					score: 0.5,
					reasoning: "No prior data and LLM unavailable — neutral score",
					usedLLM: false,
				})
			}
		}

		// Sort by score descending, pick the best
		scores.sort((a, b) => b.score - a.score)
		const best = scores[0]

		this.logger.appendLine(
			`[QuestionEvaluator] Hybrid Scoring selected choice ${best.index + 1} (score: ${(best.score * 100).toFixed(0)}%, LLM: ${best.usedLLM})`,
		)

		return {
			question,
			choices,
			selectedIndex: best.index,
			selectedText: this.resolveSelectedText(choices, best.index),
			reasoning: best.reasoning,
			evaluatedBy: best.usedLLM ? "research" : "contextual",
		}
	}

	/**
	 * Record the outcome of a pattern evaluation back into the AccumulatedScoreStore.
	 * Call this after the task completes to close the feedback loop.
	 *
	 * @param patternKey - The pattern key that was evaluated
	 * @param score - The score that was assigned
	 * @param success - Whether the pattern led to a successful outcome
	 */
	recordPatternOutcome(patternKey: string, score: number, success: boolean): void {
		if (!this.accumulatedScoreStore) {
			return
		}

		this.accumulatedScoreStore.recordPattern(patternKey, score, success)
		this.logger.appendLine(
			`[QuestionEvaluator] Recorded outcome for "${patternKey}": score=${score.toFixed(2)}, success=${success}`,
		)
	}

	/**
	 * Build a pattern key from a choice and question context.
	 * Used to look up accumulated scores and record outcomes.
	 */
	private buildPatternKey(choice: { text: string; mode: string | null }, question: string): string {
		const modePart = choice.mode ? `mode:${choice.mode}` : "no-mode"
		// Use a hash of the question as a coarse task category
		const taskHash = this.simpleHash(question)
		return `choice:${modePart}|q:${taskHash}`
	}

	/**
	 * Extract tool names from a choice for LLM evaluation context.
	 */
	private extractToolsFromChoice(choice: { text: string; mode: string | null }): string[] {
		const tools: string[] = ["ask_followup_question"]
		if (choice.mode) {
			tools.push(`mode_switch:${choice.mode}`)
		}
		return tools
	}

	/**
	 * Simple string hash for building pattern keys.
	 */
	private simpleHash(str: string): string {
		let hash = 0
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i)
			hash = ((hash << 5) - hash) + char
			hash = hash & hash // Convert to 32bit integer
		}
		return Math.abs(hash).toString(16).slice(0, 8)
	}

	/**
	 * Evaluate choices using the Full Team (ReviewTeamService).
	 * Each persona evaluates each choice and votes.
	 */
	private async evaluateWithFullTeam(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): Promise<QuestionEvaluation | null> {
		if (!this.reviewTeam) return null

		this.logger.appendLine(
			`[QuestionEvaluator] Evaluating ${choices.length} choices with Full Team for: "${question.substring(0, 60)}..."`,
		)

		// Score each choice using the review team personas
		const scores: { index: number; score: number; reasoning: string }[] = []

		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i]

			// Create a pseudo-pattern for the review team to evaluate
			const pseudoPattern = {
				id: `question-choice-${i}`,
				patternType: "tool" as const,
				state: "active" as const,
				summary: `Choice ${i + 1}: ${choice.text.substring(0, 100)}`,
				confidenceScore: 0.5,
				frequency: 1,
				successRate: 0.5,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: {
					toolNames: ["ask_followup_question"],
					errorKeys: [],
					modes: choice.mode ? [choice.mode] : [],
				},
			}

			const verdict = await this.reviewTeam.reviewPattern(pseudoPattern)
			scores.push({
				index: i,
				score: verdict.score,
				reasoning: verdict.summary,
			})
		}

		// Sort by score descending, pick the best
		scores.sort((a, b) => b.score - a.score)
		const best = scores[0]

		this.logger.appendLine(
			`[QuestionEvaluator] Full Team selected choice ${best.index + 1} (score: ${(best.score * 100).toFixed(0)}%)`,
		)

		return {
			question,
			choices,
			selectedIndex: best.index,
			selectedText: this.resolveSelectedText(choices, best.index),
			reasoning: best.reasoning,
			evaluatedBy: "full-team",
		}
	}

	/**
	 * Contextual analysis: evaluate choices based on the question context.
	 * Uses heuristics like:
	 * - Prefer choices with mode switches when the question involves delegation
	 * - Prefer specific answers over vague ones
	 * - Prefer answers that match the question's intent
	 */
	private evaluateContextually(
		question: string,
		choices: { text: string; mode: string | null }[],
		context?: { taskHistory?: string[]; workspaceFiles?: string[] },
	): QuestionEvaluation | null {
		const scores = choices.map((choice, index) => {
			let score = 0.5 // neutral start
			const reasons: string[] = []

			// Prefer choices with mode switches when question involves delegation
			if (choice.mode && (question.toLowerCase().includes("mode") || question.toLowerCase().includes("switch"))) {
				score += 0.2
				reasons.push("Mode switch matches delegation intent")
			}

			// Prefer longer, more specific answers
			if (choice.text.length > 50) {
				score += 0.1
				reasons.push("Specific/detailed answer")
			} else if (choice.text.length < 10) {
				score -= 0.1
				reasons.push("Too brief/vague")
			}

			// Prefer answers that contain actionable verbs
			const actionableVerbs = [
				"implement",
				"create",
				"fix",
				"build",
				"write",
				"add",
				"update",
				"refactor",
				"analyze",
				"research",
			]
			if (actionableVerbs.some((v) => choice.text.toLowerCase().includes(v))) {
				score += 0.1
				reasons.push("Actionable answer")
			}

			// Penalize "no" or negative answers when question is asking for action
			if (choice.text.toLowerCase().startsWith("no") || choice.text.toLowerCase().startsWith("don't")) {
				score -= 0.15
				reasons.push("Negative/avoidance answer")
			}

			// Prefer answers that reference the question's key terms
			const questionWords = question
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 4)
			const matchingWords = questionWords.filter((w) => choice.text.toLowerCase().includes(w))
			if (matchingWords.length > 0) {
				score += 0.05 * Math.min(matchingWords.length, 3)
				reasons.push(`Matches ${matchingWords.length} key terms from question`)
			}

			return { index, score, reasoning: reasons.join("; ") || "Neutral evaluation" }
		})

		// Sort by score descending
		scores.sort((a, b) => b.score - a.score)
		const best = scores[0]

		this.logger.appendLine(
			`[QuestionEvaluator] Contextual analysis selected choice ${best.index + 1} (score: ${(best.score * 100).toFixed(0)}%)`,
		)

		return {
			question,
			choices,
			selectedIndex: best.index,
			selectedText: this.resolveSelectedText(choices, best.index),
			reasoning: best.reasoning,
			evaluatedBy: "contextual",
		}
	}

	/**
	 * Search for similar past questions using vector search.
	 * Uses CodeIndexManager to find semantically similar questions and their resolutions.
	 * Gated behind selfImprovingCodeIndex experiment flag.
	 */
	async searchSimilarQuestions(
		query: string,
	): Promise<Array<{ question: string; resolution: string; score: number }>> {
		const experiments = this.getExperiments?.()
		if (experiments?.selfImprovingCodeIndex === false) {
			return []
		}

		if (!this.codeIndexManager) {
			return []
		}

		try {
			const results = await this.codeIndexManager.searchIndex(query)
			if (!results || results.length === 0) {
				return []
			}

			return results
				.filter((r) => r.payload?.codeChunk)
				.map((r) => ({
					question: r.payload?.codeChunk?.slice(0, 200) ?? "",
					resolution: `Found in ${r.payload?.filePath ?? "unknown"}:${r.payload?.startLine ?? 0}`,
					score: r.score,
				}))
		} catch (error) {
			this.logger.appendLine(
				`[QuestionEvaluator] searchSimilarQuestions error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	/**
	 * Resolve the selected text with a fallback chain:
	 * 1. Preferred choice's text (if non-empty)
	 * 2. First choice's text (if non-empty)
	 * 3. Empty string (last resort — should not happen in practice)
	 *
	 * This prevents empty responses when LLM evaluation returns malformed results
	 * with empty text fields. The first choice is the same as what auto-approve
	 * timeout would have selected anyway.
	 */
	private resolveSelectedText(
		choices: { text: string; mode: string | null }[],
		preferredIndex: number,
	): string {
		const preferred = choices[preferredIndex]?.text
		if (preferred && preferred.trim().length > 0) {
			return preferred
		}
		const fallback = choices[0]?.text
		if (fallback && fallback.trim().length > 0) {
			return fallback
		}
		return ""
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			useFullTeam: this.config.useFullTeam,
			useContextualAnalysis: this.config.useContextualAnalysis,
			doResearchBeforeDeciding: this.config.doResearchBeforeDeciding,
			useHybridScoring: this.config.useHybridScoring,
			accumulatedScoreStoreReady: this.accumulatedScoreStore !== null,
			llmScorerReady: this.llmScorer !== null,
		}
	}
}
