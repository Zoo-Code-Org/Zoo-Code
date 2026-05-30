import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { ImprovementAction, LearnedPattern, LearningConfig, LearningEvent, LearningState, Logger } from "./types"
import { EMPTY_STATE } from "./types"
import type { CodeIndexManager } from "../code-index/manager"
import type { Experiments } from "./types"

/**
 * File names for the learning store
 */
const STATE_FILE = "state.json"
const PATTERNS_DIR = "patterns"
const ARCHIVE_DIR = "archive"
const PATTERN_INDEX_FILE = "_index.json"

/**
 * LearningStore - atomic file-based persistence for learning state.
 *
 * Storage layout:
 *   globalStorage/self-improving/
 *     state.json          - canonical LearningState metadata + counters
 *     patterns/           - per-pattern source-of-truth files
 *       _index.json       - compact index of active/stale/archived patterns
 *       <pattern-id>.json - individual pattern data
 *     archive/            - cold storage for archived patterns
 *       <pattern-id>.json
 */
export class LearningStore {
	private readonly baseDir: string
	private readonly patternsDir: string
	private readonly archiveDir: string
	private state: LearningState
	private readonly logger: Logger
	private initialized = false
	private codeIndexManager: CodeIndexManager | undefined
	private getExperiments: (() => Experiments | undefined) | undefined

	constructor(baseDir: string, logger: Logger) {
		this.baseDir = path.join(baseDir, "self-improving")
		this.patternsDir = path.join(this.baseDir, PATTERNS_DIR)
		this.archiveDir = path.join(this.baseDir, ARCHIVE_DIR)
		this.state = this.createEmptyState()
		this.logger = logger
	}

	/**
	 * Set the CodeIndexManager instance for vector-search-based pattern dedup/retrieval.
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

	/**
	 * Initialize the store - create directories and load persisted state.
	 * If state is corrupted or missing, falls back to empty defaults.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.patternsDir, { recursive: true })
			await fs.mkdir(this.archiveDir, { recursive: true })
			await this.loadState()
			this.initialized = true
		} catch (error) {
			this.logger.appendLine(
				`[LearningStore] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
			this.state = this.createEmptyState()
			this.initialized = true
		}
	}

	/**
	 * Load state from disk with graceful degradation.
	 */
	private async loadState(): Promise<void> {
		const statePath = path.join(this.baseDir, STATE_FILE)

		try {
			const raw = await fs.readFile(statePath, "utf-8")
			const parsed = JSON.parse(raw) as Partial<LearningState>

			if (parsed && typeof parsed === "object" && parsed.version === 1) {
				this.state = this.mergeWithDefaults(parsed)
				await this.loadPatternFiles()
				this.logger.appendLine(
					`[LearningStore] Loaded state: ${this.state.patterns.length} patterns, ${this.state.recentEvents.length} events`,
				)
				return
			}

			this.logger.appendLine("[LearningStore] Invalid state version, using defaults")
		} catch (error: unknown) {
			const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
			if (errorCode === "ENOENT") {
				this.logger.appendLine("[LearningStore] No existing state, starting fresh")
			} else {
				this.logger.appendLine(
					`[LearningStore] Corrupted state (${error instanceof Error ? error.message : String(error)}), using defaults`,
				)
			}
		}

		this.state = this.createEmptyState()
	}

	private async loadPatternFiles(): Promise<void> {
		this.state.patterns = await this.hydratePatternSet(this.patternsDir, this.state.patterns)
		this.state.archivedPatterns = (await this.hydratePatternSet(this.archiveDir, this.state.archivedPatterns)).map(
			(pattern) => ({
				...pattern,
				state: "archived",
			}),
		)
	}

	private async hydratePatternSet(
		directoryPath: string,
		manifestPatterns: readonly LearnedPattern[],
	): Promise<LearnedPattern[]> {
		const hydratedPatterns: LearnedPattern[] = []

		for (const manifestPattern of manifestPatterns) {
			const persistedPattern = await this.readPatternFile(directoryPath, manifestPattern.id)
			hydratedPatterns.push(persistedPattern ?? manifestPattern)
		}

		return hydratedPatterns
	}

	private async readPatternFile(directoryPath: string, patternId: string): Promise<LearnedPattern | null> {
		try {
			const raw = await fs.readFile(path.join(directoryPath, `${patternId}.json`), "utf-8")
			const parsed = JSON.parse(raw) as LearnedPattern
			return parsed?.id === patternId ? parsed : null
		} catch (error) {
			const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
			if (errorCode !== "ENOENT") {
				this.logger.appendLine(
					`[LearningStore] Failed to read pattern ${patternId}.json: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			return null
		}
	}

	/**
	 * Merge parsed state with defaults to handle schema evolution.
	 */
	private mergeWithDefaults(parsed: Partial<LearningState>): LearningState {
		const config = { ...EMPTY_STATE.config, ...(parsed.config ?? {}) }

		return {
			version: 1,
			config,
			counters: {
				userTurnsSinceReview: parsed.counters?.userTurnsSinceReview ?? 0,
				toolIterationsSinceReview: parsed.counters?.toolIterationsSinceReview ?? 0,
			},
			patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
			archivedPatterns: Array.isArray(parsed.archivedPatterns) ? parsed.archivedPatterns : [],
			recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(-config.maxStoredEvents) : [],
			pendingActions: Array.isArray(parsed.pendingActions) ? parsed.pendingActions : [],
			telemetry: {
				promptEnrichmentUses: parsed.telemetry?.promptEnrichmentUses ?? 0,
				toolPreferenceUses: parsed.telemetry?.toolPreferenceUses ?? 0,
				errorAvoidanceUses: parsed.telemetry?.errorAvoidanceUses ?? 0,
				skillSuggestionCount: parsed.telemetry?.skillSuggestionCount ?? 0,
				lastReviewAt: parsed.telemetry?.lastReviewAt,
				lastCuratorRunAt: parsed.telemetry?.lastCuratorRunAt,
			},
		}
	}

	/**
	 * Persist the full state to disk with state.json committed last.
	 */
	async persist(): Promise<void> {
		if (!this.initialized) {
			return
		}

		try {
			this.enforceBounds()

			await this.persistPatternFiles(this.patternsDir, this.state.patterns)
			await this.persistPatternFiles(this.archiveDir, this.state.archivedPatterns)
			await this.writePatternIndex()
			await safeWriteJson(path.join(this.baseDir, STATE_FILE), this.state, { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[LearningStore] Persist error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async persistPatternFiles(directoryPath: string, patterns: readonly LearnedPattern[]): Promise<void> {
		const expectedNames = new Set(patterns.map((pattern) => `${pattern.id}.json`))

		await Promise.all(
			patterns.map((pattern) =>
				safeWriteJson(path.join(directoryPath, `${pattern.id}.json`), pattern, { prettyPrint: true }),
			),
		)

		try {
			const existingEntries = await fs.readdir(directoryPath, { withFileTypes: true })
			await Promise.all(
				existingEntries
					.filter(
						(entry) =>
							entry.isFile() &&
							entry.name.endsWith(".json") &&
							entry.name !== PATTERN_INDEX_FILE &&
							!expectedNames.has(entry.name),
					)
					.map((entry) => fs.rm(path.join(directoryPath, entry.name), { force: true })),
			)
		} catch (error) {
			this.logger.appendLine(
				`[LearningStore] Pattern cleanup error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async writePatternIndex(): Promise<void> {
		await safeWriteJson(
			path.join(this.patternsDir, PATTERN_INDEX_FILE),
			{
				version: 1,
				updatedAt: Date.now(),
				activePatternIds: this.state.patterns.map((pattern) => pattern.id),
				archivedPatternIds: this.state.archivedPatterns.map((pattern) => pattern.id),
			},
			{ prettyPrint: true },
		)
	}

	/**
	 * Enforce storage bounds (max patterns, max events).
	 */
	private enforceBounds(): void {
		const maxPatterns = this.state.config.maxStoredPatterns
		const maxEvents = this.state.config.maxStoredEvents

		if (this.state.patterns.length > maxPatterns) {
			this.state.patterns = [...this.state.patterns]
				.sort((a, b) => a.confidenceScore - b.confidenceScore)
				.slice(-maxPatterns)
		}

		if (this.state.archivedPatterns.length > maxPatterns) {
			this.state.archivedPatterns = [...this.state.archivedPatterns]
				.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
				.slice(-maxPatterns)
		}

		if (this.state.recentEvents.length > maxEvents) {
			this.state.recentEvents = this.state.recentEvents.slice(-maxEvents)
		}
	}

	// ──── Getters ────

	getState(): Readonly<LearningState> {
		return this.state
	}

	getConfig(): Readonly<LearningConfig> {
		return this.state.config
	}

	getPatterns(): readonly LearnedPattern[] {
		return this.state.patterns
	}

	getArchivedPatterns(): readonly LearnedPattern[] {
		return this.state.archivedPatterns
	}

	getRecentEvents(): readonly LearningEvent[] {
		return this.state.recentEvents
	}

	getPendingActions(): readonly ImprovementAction[] {
		return this.state.pendingActions
	}

	getTelemetry(): Readonly<LearningState["telemetry"]> {
		return this.state.telemetry
	}

	getCounters(): Readonly<LearningState["counters"]> {
		return this.state.counters
	}

	// ──── Mutations ────

	setConfig(config: Partial<LearningConfig>): void {
		this.state.config = { ...this.state.config, ...config }
	}

	addEvent(event: LearningEvent): void {
		this.state.recentEvents.push(event)
	}

	addPattern(pattern: LearnedPattern): void {
		const existing = this.state.patterns.findIndex((candidate) => candidate.id === pattern.id)
		if (existing >= 0) {
			this.state.patterns[existing] = pattern
			return
		}

		this.state.patterns.push(pattern)
	}

	updatePattern(id: string, updates: Partial<LearnedPattern>): void {
		const index = this.state.patterns.findIndex((pattern) => pattern.id === id)
		if (index >= 0) {
			this.state.patterns[index] = { ...this.state.patterns[index], ...updates }
		}
	}

	removePattern(id: string): void {
		this.state.patterns = this.state.patterns.filter((pattern) => pattern.id !== id)
	}

	archivePattern(id: string): void {
		const index = this.state.patterns.findIndex((pattern) => pattern.id === id)
		if (index >= 0) {
			const pattern = { ...this.state.patterns[index], state: "archived" as const }
			this.state.archivedPatterns.push(pattern)
			this.state.patterns.splice(index, 1)
		}
	}

	addAction(action: ImprovementAction): void {
		this.state.pendingActions.push(action)
	}

	removeAction(id: string): void {
		this.state.pendingActions = this.state.pendingActions.filter((action) => action.id !== id)
	}

	incrementUserTurns(): void {
		this.state.counters.userTurnsSinceReview++
	}

	incrementToolIterations(delta = 1): void {
		this.state.counters.toolIterationsSinceReview += delta
	}

	resetCounters(): void {
		this.state.counters.userTurnsSinceReview = 0
		this.state.counters.toolIterationsSinceReview = 0
	}

	updateTelemetry(updates: Partial<LearningState["telemetry"]>): void {
		this.state.telemetry = { ...this.state.telemetry, ...updates }
	}

	/**
	 * Reset all learning state to defaults.
	 */
	async reset(): Promise<void> {
		this.state = this.createEmptyState()
		await this.persist()
	}

	private createEmptyState(): LearningState {
		return {
			...EMPTY_STATE,
			config: { ...EMPTY_STATE.config },
			counters: { ...EMPTY_STATE.counters },
			patterns: [],
			archivedPatterns: [],
			recentEvents: [],
			pendingActions: [],
			telemetry: { ...EMPTY_STATE.telemetry },
		}
	}

	/**
	 * Search for similar patterns using vector search.
	 * Uses CodeIndexManager to find semantically similar patterns for dedup/retrieval.
	 * Gated behind selfImprovingCodeIndex experiment flag.
	 */
	async searchSimilarPatterns(query: string): Promise<LearnedPattern[]> {
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

			// Map vector search results to LearnedPattern instances
			const patterns: LearnedPattern[] = []
			for (const result of results) {
				const payload = result.payload
				if (!payload?.codeChunk) {
					continue
				}

				const filePath = payload.filePath ?? "unknown"
				const startLine = payload.startLine ?? 0
				const endLine = payload.endLine ?? 0

				patterns.push({
					id: crypto.randomUUID(),
					patternType: "code-index",
					state: "active",
					summary: `[${filePath}:${startLine}-${endLine}] ${payload.codeChunk.slice(0, 180)}`,
					confidenceScore: Math.min(1, result.score),
					frequency: 1,
					successRate: 0.5,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: ["CODE_INDEX_HIT"],
					context: {
						toolNames: [],
						errorKeys: [],
					},
				})
			}

			return patterns
		} catch (error) {
			this.logger.appendLine(
				`[LearningStore] searchSimilarPatterns error: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	/**
	 * Generate a unique ID for patterns, events, and actions.
	 */
	static generateId(): string {
		return crypto.randomUUID()
	}
}
