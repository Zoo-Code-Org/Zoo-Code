import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Experiments, LearnedPattern, ImprovementAction } from "./types"
import type { Logger } from "./types"
import type { CodeIndexManager } from "../code-index/manager"

export interface ReviewTeamConfig {
	enabled: boolean
	innovatorWeight: number // default 0.3
	contrarianWeight: number // default 0.3
	devilsAdvocateWeight: number // default 0.3
	deciderThreshold: number // default 0.6 — minimum weighted score to pass
	requireUnanimous: boolean // default false — if true, all must approve
	minConfidenceForReview: number // default 0.2 — skip review for very low confidence
	storageBasePath?: string // path for persisting counts
	getExperiments?: () => Experiments | undefined
}

export interface ReviewVerdict {
	approved: boolean
	score: number
	innovatorVote: VoteResult
	contrarianVote: VoteResult
	devilsAdvocateVote: VoteResult
	deciderVote: VoteResult
	summary: string
	timestamp: Date
}

export interface VoteResult {
	approved: boolean
	confidence: number // 0-1
	reasoning: string
}

const DEFAULT_CONFIG: ReviewTeamConfig = {
	enabled: true,
	innovatorWeight: 0.3,
	contrarianWeight: 0.3,
	devilsAdvocateWeight: 0.3,
	deciderThreshold: 0.6,
	requireUnanimous: false,
	minConfidenceForReview: 0.2,
}

interface PersistedCounts {
	approvedPatternCount: number
	approvedActionCount: number
}

const COUNTS_FILE = "review-team-counts.json"

export class ReviewTeamService {
	private logger: Logger
	private config: ReviewTeamConfig
	private approvedPatternCount: number = 0
	private approvedActionCount: number = 0
	private initialized = false
	private initPromise: Promise<void> | null = null
	private codeIndexManager: CodeIndexManager | undefined
	private readonly COLD_START_GRACE_ACTIONS = 20
	private actionCount = 0

	constructor(logger: Logger, config?: Partial<ReviewTeamConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
	}

	/**
	 * Set the CodeIndexManager instance for vector-search-based pattern evidence lookup.
	 */
	setCodeIndexManager(manager: CodeIndexManager | undefined): void {
		this.codeIndexManager = manager
	}

	/**
	 * Initialize the service — load persisted counts if storage is configured
	 * and the SELF_IMPROVING_PERSIST_COUNTS experiment is enabled.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		if (!this.initPromise) {
			this.initPromise = this.doInitialize()
		}

		await this.initPromise
	}

	private async doInitialize(): Promise<void> {
		try {
			const experiments = this.config.getExperiments?.()
			if (experiments?.selfImprovingPersistCounts === false) {
				this.initialized = true
				return
			}

			if (!this.config.storageBasePath) {
				this.initialized = true
				return
			}

			const countsPath = path.join(this.config.storageBasePath, COUNTS_FILE)
			try {
				const data = await fs.readFile(countsPath, "utf-8")
				const parsed = JSON.parse(data) as PersistedCounts
				this.approvedPatternCount = parsed.approvedPatternCount ?? 0
				this.approvedActionCount = parsed.approvedActionCount ?? 0
				this.logger.appendLine(
					`[ReviewTeamService] Loaded counts: ${this.approvedPatternCount} patterns, ${this.approvedActionCount} actions`,
				)
			} catch {
				// File doesn't exist yet — start from zero
				this.logger.appendLine("[ReviewTeamService] No persisted counts found, starting fresh")
			}
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] Failed to load counts: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
			this.initPromise = null
		}
	}

	/**
	 * Persist current counts to disk if storage is configured.
	 */
	private async persistCounts(): Promise<void> {
		const experiments = this.config.getExperiments?.()
		if (experiments?.selfImprovingPersistCounts === false) {
			return
		}

		if (!this.config.storageBasePath) {
			return
		}

		try {
			const countsPath = path.join(this.config.storageBasePath, COUNTS_FILE)
			const data: PersistedCounts = {
				approvedPatternCount: this.approvedPatternCount,
				approvedActionCount: this.approvedActionCount,
			}
			await safeWriteJson(countsPath, data)
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] Failed to persist counts: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	getApprovedPatternCount(): number {
		return this.approvedPatternCount
	}

	setApprovedPatternCount(count: number): void {
		this.approvedPatternCount = count
		this.persistCounts()
	}

	getApprovedActionCount(): number {
		return this.approvedActionCount
	}

	setApprovedActionCount(count: number): void {
		this.approvedActionCount = count
		this.persistCounts()
	}

	getConfig(): ReviewTeamConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<ReviewTeamConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[ReviewTeam] Config updated: ${JSON.stringify(updates)}`)
	}

	/**
	 * Review a single pattern through all 4 personas.
	 */
	async reviewPattern(pattern: LearnedPattern): Promise<ReviewVerdict> {
		if (!this.config.enabled) {
			return this.passThroughVerdict("Review team disabled")
		}

		if ((pattern.confidenceScore ?? 0) < this.config.minConfidenceForReview) {
			return this.passThroughVerdict(
				`Confidence ${pattern.confidenceScore} below threshold ${this.config.minConfidenceForReview}`,
			)
		}

		const innovatorVote = this.innovatorReview(pattern)
		const contrarianVote = this.contrarianReview(pattern)
		const devilsAdvocateVote = this.devilsAdvocateReview(pattern)
		const deciderVote = this.deciderReview(pattern, [innovatorVote, contrarianVote, devilsAdvocateVote])

		const weightedScore = this.calculateWeightedScore([innovatorVote, contrarianVote, devilsAdvocateVote])
		// Lower threshold for new patterns to avoid chicken-and-egg problem
		const threshold = pattern.frequency < 3 ? 0.4 : this.config.deciderThreshold
		// First-pattern boost: when no patterns have ever been approved, lower threshold
		// to seed the system and break the chicken-and-egg problem
		const isFirstPattern = this.approvedPatternCount === 0
		const effectiveThreshold = isFirstPattern ? Math.min(threshold, 0.3) : threshold
		// Also override decider for first pattern — decider's 0.5 threshold is too high for cold-start
		const effectiveDeciderApproved = isFirstPattern ? weightedScore >= effectiveThreshold : deciderVote.approved
		const approved = this.config.requireUnanimous
			? innovatorVote.approved && contrarianVote.approved && devilsAdvocateVote.approved && deciderVote.approved
			: weightedScore >= effectiveThreshold && effectiveDeciderApproved

		if (approved) {
			this.approvedPatternCount++
		}

		const summary = this.generateSummary(pattern, approved, weightedScore, [
			innovatorVote,
			contrarianVote,
			devilsAdvocateVote,
			deciderVote,
		])

		return {
			approved,
			score: weightedScore,
			innovatorVote,
			contrarianVote,
			devilsAdvocateVote,
			deciderVote,
			summary,
			timestamp: new Date(),
		}
	}

	/**
	 * Review multiple patterns and return only approved ones.
	 */
	async reviewPatterns(patterns: LearnedPattern[]): Promise<{
		approved: LearnedPattern[]
		rejected: LearnedPattern[]
		verdicts: ReviewVerdict[]
	}> {
		const approved: LearnedPattern[] = []
		const rejected: LearnedPattern[] = []
		const verdicts: ReviewVerdict[] = []

		for (const pattern of patterns) {
			const verdict = await this.reviewPattern(pattern)
			verdicts.push(verdict)
			if (verdict.approved) {
				approved.push(pattern)
			} else {
				rejected.push(pattern)
			}
		}

		this.logger.appendLine(
			`[ReviewTeam] Reviewed ${patterns.length} patterns: ${approved.length} approved, ${rejected.length} rejected`,
		)

		return { approved, rejected, verdicts }
	}

	/**
	 * Review a single action through all 4 personas.
	 */
	async reviewAction(action: ImprovementAction): Promise<ReviewVerdict> {
		if (!this.config.enabled) {
			return this.passThroughVerdict("Review team disabled")
		}

		const innovatorVote = this.innovatorReviewAction(action)
		const contrarianVote = this.contrarianReviewAction(action)
		const devilsAdvocateVote = this.devilsAdvocateReviewAction(action)
		const deciderVote = this.deciderReviewAction(action, [innovatorVote, contrarianVote, devilsAdvocateVote])

		const weightedScore = this.calculateWeightedScore([innovatorVote, contrarianVote, devilsAdvocateVote])
		// Cold-start mitigation: when no actions have ever been approved, lower threshold
		// to seed the system and break the chicken-and-egg problem.
		// Max weighted score ~0.533 — can't reach default 0.6 threshold without boost.
		const isFirstAction = this.approvedActionCount === 0
		let effectiveThreshold = isFirstAction
			? Math.min(this.config.deciderThreshold, 0.3)
			: this.config.deciderThreshold
		// Broader cold-start grace period: first 20 actions get a lower threshold
		// to avoid excessive rejection during system warm-up
		if (this.actionCount < this.COLD_START_GRACE_ACTIONS) {
			effectiveThreshold = Math.max(effectiveThreshold * 0.5, 0.3)
		}
		this.actionCount++
		// Override decider for first action — decider's 0.5 threshold is too high for cold-start
		const effectiveDeciderApproved = isFirstAction ? weightedScore >= effectiveThreshold : deciderVote.approved
		const approved = this.config.requireUnanimous
			? innovatorVote.approved && contrarianVote.approved && devilsAdvocateVote.approved && deciderVote.approved
			: weightedScore >= effectiveThreshold && effectiveDeciderApproved

		if (approved) {
			this.approvedActionCount++
		} else {
			this.logger.appendLine(
				`[ReviewTeam] Rejected action: ${action.actionType} (score: ${weightedScore.toFixed(2)}, threshold: ${effectiveThreshold.toFixed(2)})`,
			)
		}

		const summary = `Action ${action.actionType} (${action.id}): ${approved ? "APPROVED" : "REJECTED"} (score: ${(weightedScore * 100).toFixed(0)}%)`

		return {
			approved,
			score: weightedScore,
			innovatorVote,
			contrarianVote,
			devilsAdvocateVote,
			deciderVote,
			summary,
			timestamp: new Date(),
		}
	}

	/**
	 * Review multiple actions and return only approved ones.
	 */
	async reviewActions(actions: ImprovementAction[]): Promise<{
		approved: ImprovementAction[]
		rejected: ImprovementAction[]
		verdicts: ReviewVerdict[]
	}> {
		const approved: ImprovementAction[] = []
		const rejected: ImprovementAction[] = []
		const verdicts: ReviewVerdict[] = []

		for (const action of actions) {
			const verdict = await this.reviewAction(action)
			verdicts.push(verdict)
			if (verdict.approved) {
				approved.push(action)
			} else {
				rejected.push(action)
			}
		}

		this.logger.appendLine(
			`[ReviewTeam] Reviewed ${actions.length} actions: ${approved.length} approved, ${rejected.length} rejected`,
		)

		return { approved, rejected, verdicts }
	}

	/**
	 * Search for similar approved patterns using vector search.
	 * Finds evidence of "has this pattern worked before?" to inform persona scores.
	 * Gated behind selfImprovingCodeIndex experiment flag.
	 */
	async searchSimilarApprovedPatterns(pattern: LearnedPattern): Promise<Array<{ summary: string; score: number }>> {
		const experiments = this.config.getExperiments?.()
		if (experiments?.selfImprovingCodeIndex === false) {
			return []
		}

		if (!this.codeIndexManager) {
			return []
		}

		try {
			const query = [
				pattern.summary,
				...(pattern.context?.toolNames ?? []),
				...(pattern.context?.errorKeys ?? []),
			]
				.filter(Boolean)
				.join(" ")

			const results = await this.codeIndexManager.searchIndex(query)
			if (!results || results.length === 0) {
				return []
			}

			return results
				.filter((r) => r.payload?.codeChunk)
				.map((r) => ({
					summary: r.payload?.codeChunk?.slice(0, 200) ?? "",
					score: r.score,
				}))
		} catch (error) {
			this.logger.appendLine(
				`[ReviewTeamService] searchSimilarApprovedPatterns error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	// ===== INNOVATOR =====

	private innovatorReview(pattern: LearnedPattern): VoteResult {
		let score = 0.5 // neutral start
		const reasons: string[] = []

		// Novel tool combinations are innovative
		if (pattern.context?.toolNames && pattern.context.toolNames.length >= 3) {
			score += 0.2
			reasons.push("Novel multi-tool combination")
		}

		// High success rate with new patterns
		if ((pattern.successRate ?? 0) > 0.8 && (pattern.frequency ?? 0) >= 3) {
			score += 0.15
			reasons.push("High success rate with sufficient frequency")
		}

		// Error patterns with clear avoidance strategies
		if (pattern.patternType === "error" && pattern.context?.errorKeys && pattern.context.errorKeys.length > 0) {
			score += 0.1
			reasons.push("Actionable error avoidance pattern")
		}

		// Low frequency patterns need more evidence
		if ((pattern.frequency ?? 0) < 2) {
			score -= 0.05
			reasons.push("Low frequency — needs more evidence")
		}

		// Very low confidence
		if ((pattern.confidenceScore ?? 0) < 0.2) {
			score -= 0.2
			reasons.push("Very low confidence score")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "No strong signals",
		}
	}

	private innovatorReviewAction(action: ImprovementAction): VoteResult {
		let score = 0.5
		const reasons: string[] = []

		if (action.actionType === "SKILL_CREATE" || action.actionType === "SKILL_CREATE_FROM_SCRATCH") {
			score += 0.15
			reasons.push("Skill creation enables reusable knowledge")
		}
		if (action.actionType === "PROMPT_ENRICHMENT") {
			score += 0.1
			reasons.push("Prompt enrichment improves future interactions")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "Standard action",
		}
	}

	// ===== CONTRARIAN =====

	private contrarianReview(pattern: LearnedPattern): VoteResult {
		let score = 0.5 // neutral start
		const reasons: string[] = []

		// Low frequency patterns might be coincidental
		if ((pattern.frequency ?? 0) < 3) {
			score -= 0.05
			reasons.push("Low frequency — may be coincidental")
		}

		// Very high confidence with low frequency is suspicious
		if ((pattern.confidenceScore ?? 0) > 0.8 && (pattern.frequency ?? 0) < 5) {
			score -= 0.2
			reasons.push("High confidence with low frequency — possible overfitting")
		}

		// Single tool patterns might be too narrow
		if (pattern.context?.toolNames && pattern.context.toolNames.length === 1) {
			score -= 0.1
			reasons.push("Single tool pattern — may be too narrow")
		}

		// Error patterns with no error keys lack specificity
		if (
			pattern.patternType === "error" &&
			(!pattern.context?.errorKeys || pattern.context.errorKeys.length === 0)
		) {
			score -= 0.15
			reasons.push("Error pattern without specific error keys")
		}

		// High frequency with good confidence is reliable
		if ((pattern.frequency ?? 0) >= 5 && (pattern.confidenceScore ?? 0) >= 0.5) {
			score += 0.2
			reasons.push("High frequency with good confidence — reliable pattern")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "No strong concerns",
		}
	}

	private contrarianReviewAction(action: ImprovementAction): VoteResult {
		let score = 0.5
		const reasons: string[] = []

		if (action.actionType === "SKILL_CREATE" && !("content" in action.payload)) {
			score -= 0.2
			reasons.push("Skill creation without content — may be premature")
		}
		if (action.actionType === "SKILL_CREATE_FROM_SCRATCH" && !("instructions" in action.payload)) {
			score -= 0.2
			reasons.push("SKILL_CREATE_FROM_SCRATCH without instructions — may be incomplete")
		}
		if (action.actionType === "ERROR_AVOIDANCE" && !("errorKey" in action.payload)) {
			score -= 0.15
			reasons.push("Error avoidance without specific error key")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "No strong concerns",
		}
	}

	// ===== DEVIL'S ADVOCATE =====

	private devilsAdvocateReview(pattern: LearnedPattern): VoteResult {
		let score = 0.5 // neutral start
		const reasons: string[] = []

		// Check for potential negative side effects
		if (pattern.patternType === "tool" && pattern.context?.toolNames) {
			const tools = pattern.context.toolNames
			// Writing without reading first is risky
			if (tools.includes("edit_file") && !tools.includes("read_file") && !tools.includes("search_files")) {
				score -= 0.2
				reasons.push("Edit without prior read — risk of incorrect changes")
			}
			// Command execution without safety checks
			if (tools.includes("execute_command") && !tools.includes("read_file")) {
				score -= 0.1
				reasons.push("Command execution without context verification")
			}
		}

		// Stale patterns may be outdated
		if (pattern.state === "stale") {
			score -= 0.2
			reasons.push("Stale pattern — may be outdated")
		}

		// Archived patterns should not be used
		if (pattern.state === "archived") {
			score -= 0.3
			reasons.push("Archived pattern — should not be applied")
		}

		// Very high success rate with low frequency might be lucky
		if ((pattern.successRate ?? 0) > 0.95 && (pattern.frequency ?? 0) < 5) {
			score -= 0.15
			reasons.push("Near-perfect success with low frequency — may be lucky")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "No edge case concerns",
		}
	}

	private devilsAdvocateReviewAction(action: ImprovementAction): VoteResult {
		let score = 0.5
		const reasons: string[] = []

		if (action.actionType === "SKILL_CREATE") {
			score -= 0.1
			reasons.push("Skill creation modifies agent behavior — verify necessity")
		}
		if (action.actionType === "ERROR_AVOIDANCE") {
			score += 0.1
			reasons.push("Error avoidance is low-risk, high-value")
		}

		return {
			approved: score >= 0.5,
			confidence: Math.max(0, Math.min(1, score)),
			reasoning: reasons.length > 0 ? reasons.join("; ") : "No edge case concerns",
		}
	}

	// ===== THE DECIDER =====

	private deciderReview(pattern: LearnedPattern, votes: VoteResult[]): VoteResult {
		const avgScore = votes.reduce((sum, v) => sum + v.confidence, 0) / votes.length
		const approvals = votes.filter((v) => v.approved).length
		const reasons: string[] = []

		// Unanimous approval
		if (approvals === votes.length) {
			reasons.push("Unanimous approval from all reviewers")
		}

		// Split decision
		if (approvals === 2 && votes.length === 3) {
			reasons.push("Split decision — majority approves")
		}

		// Majority rejection
		if (approvals <= 1) {
			reasons.push("Majority recommends rejection")
		}

		// High confidence override
		if (avgScore >= 0.8) {
			reasons.push("High average confidence — overriding concerns")
		}

		// Low confidence override
		if (avgScore < 0.3) {
			reasons.push("Very low average confidence — recommending rejection")
		}

		return {
			approved: avgScore >= 0.5,
			confidence: avgScore,
			reasoning: reasons.length > 0 ? reasons.join("; ") : "Standard review",
		}
	}

	private deciderReviewAction(action: ImprovementAction, votes: VoteResult[]): VoteResult {
		return this.deciderReview({} as LearnedPattern, votes)
	}

	private calculateWeightedScore(votes: VoteResult[]): number {
		const weights = [this.config.innovatorWeight, this.config.contrarianWeight, this.config.devilsAdvocateWeight]
		let totalWeight = 0
		let weightedSum = 0

		for (let i = 0; i < votes.length; i++) {
			const w = weights[i] ?? 0
			weightedSum += votes[i].confidence * w
			totalWeight += w
		}

		return totalWeight > 0 ? weightedSum / totalWeight : 0.5
	}

	private generateSummary(pattern: LearnedPattern, approved: boolean, score: number, votes: VoteResult[]): string {
		const status = approved ? "APPROVED" : "REJECTED"
		const voteSummary = votes
			.map((v, i) => {
				const names = ["Innovator", "Contrarian", "Devil's Advocate", "The Decider"]
				return `${names[i]}: ${v.approved ? "✅" : "❌"} (${(v.confidence * 100).toFixed(0)}%)`
			})
			.join(" | ")

		return `[${status}] Pattern ${pattern.id} (${pattern.patternType}): score=${(score * 100).toFixed(0)}% | ${voteSummary}`
	}

	private passThroughVerdict(reason: string): ReviewVerdict {
		return {
			approved: true,
			score: 1.0,
			innovatorVote: { approved: true, confidence: 1.0, reasoning: reason },
			contrarianVote: { approved: true, confidence: 1.0, reasoning: reason },
			devilsAdvocateVote: { approved: true, confidence: 1.0, reasoning: reason },
			deciderVote: { approved: true, confidence: 1.0, reasoning: reason },
			summary: `Pass-through: ${reason}`,
			timestamp: new Date(),
		}
	}
}
