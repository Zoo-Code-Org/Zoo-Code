import * as fs from "fs/promises"
import * as path from "path"

import debounce from "lodash.debounce"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"

/**
 * A single accumulated score entry for a pattern.
 */
export interface AccumulatedScoreEntry {
	/** Unique key identifying the pattern (e.g., "tool:read_file+write_file") */
	patternKey: string
	/** Decay-weighted accumulated score across sessions */
	accumulatedScore: number
	/** Total number of times this pattern has been recorded */
	count: number
	/** Timestamp of the most recent recording (epoch ms) */
	lastSeen: number
	/** Number of times this pattern was recorded as a failure */
	failureCount: number
}

/**
 * AccumulatedScoreStore — persistent JSON store (one file per workspace)
 * that accumulates pattern scores across sessions with time-based decay.
 *
 * Architecture (two-tier hybrid scoring):
 * - Fast path: getPatternScore() returns accumulated score directly
 * - Slow path: ambiguous scores (0.3–0.7) trigger LLM evaluation
 * - Feedback loop: recordPattern() updates store with task outcome
 *
 * Persistence uses debounced JSON writes (same pattern as CacheManager)
 * to batch updates and avoid excessive disk I/O.
 */
export class AccumulatedScoreStore {
	private static readonly STORE_FILENAME = "accumulated-scores.json"

	/** Decay factor applied on each recordPattern call (0.9 = recent patterns weighted more) */
	private static readonly DECAY_FACTOR = 0.9

	/** Patterns older than this many days are pruned */
	private static readonly PRUNE_AFTER_DAYS = 30

	/** Debounce interval for persistence (ms) */
	private static readonly DEBOUNCE_MS = 1500

	private readonly filePath: string
	private readonly logger: Logger
	private entries: Map<string, AccumulatedScoreEntry> = new Map()
	private initialized = false
	private initPromise: Promise<void> | null = null
	private readonly debouncedPersist: () => void

	constructor(storageBasePath: string, logger: Logger) {
		this.filePath = path.join(storageBasePath, AccumulatedScoreStore.STORE_FILENAME)
		this.logger = logger
		this.debouncedPersist = debounce(async () => {
			await this.doPersist()
		}, AccumulatedScoreStore.DEBOUNCE_MS)
	}

	/**
	 * Initialize the store — load persisted entries from disk.
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
			await this.loadFromDisk()
			this.logger.appendLine(
				`[AccumulatedScoreStore] Initialized: ${this.entries.size} pattern entries loaded`,
			)
		} catch (error) {
			this.logger.appendLine(
				`[AccumulatedScoreStore] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
			this.initPromise = null
		}
	}

	/**
	 * Load entries from disk.
	 */
	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, "utf-8")
			const parsed = JSON.parse(raw)

			if (!Array.isArray(parsed)) {
				return
			}

			for (const candidate of parsed) {
				const entry = this.sanitizeEntry(candidate)
				if (entry) {
					this.entries.set(entry.patternKey, entry)
				}
			}
		} catch (error: unknown) {
			const err = error as NodeJS.ErrnoException
			if (err.code !== "ENOENT") {
				this.logger.appendLine(
					`[AccumulatedScoreStore] Load error: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	/**
	 * Persist entries to disk atomically.
	 */
	private async doPersist(): Promise<void> {
		try {
			await safeWriteJson(this.filePath, Array.from(this.entries.values()), { prettyPrint: true })
		} catch (error) {
			this.logger.appendLine(
				`[AccumulatedScoreStore] Persist error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Flush any pending debounced writes immediately.
	 */
	async flush(): Promise<void> {
		await this.doPersist()
	}

	/**
	 * Validate and sanitize a raw entry from disk.
	 */
	private sanitizeEntry(value: unknown): AccumulatedScoreEntry | null {
		if (!value || typeof value !== "object") {
			return null
		}

		const candidate = value as Partial<AccumulatedScoreEntry>

		if (typeof candidate.patternKey !== "string" || candidate.patternKey.trim().length === 0) {
			return null
		}

		return {
			patternKey: candidate.patternKey,
			accumulatedScore: typeof candidate.accumulatedScore === "number" ? candidate.accumulatedScore : 0.5,
			count: typeof candidate.count === "number" && candidate.count >= 0 ? Math.floor(candidate.count) : 0,
			lastSeen: typeof candidate.lastSeen === "number" ? candidate.lastSeen : Date.now(),
			failureCount:
				typeof candidate.failureCount === "number" && candidate.failureCount >= 0
					? Math.floor(candidate.failureCount)
					: 0,
		}
	}

	// ──── Public API ────

	/**
	 * Record a pattern observation with its score and success/failure outcome.
	 *
	 * Applies decay to the accumulated score so recent observations
	 * are weighted more heavily than older ones.
	 *
	 * @param patternKey - Unique key identifying the pattern
	 * @param score - Score for this observation (0–1)
	 * @param success - Whether the pattern led to a successful outcome
	 */
	recordPattern(patternKey: string, score: number, success: boolean): void {
		const now = Date.now()
		const existing = this.entries.get(patternKey)

		if (existing) {
			// Apply decay to existing accumulated score
			const decayedScore = existing.accumulatedScore * AccumulatedScoreStore.DECAY_FACTOR
			// Weight new observation: 0.1 weight for new, 0.9 weight for accumulated
			const newAccumulated = decayedScore * 0.9 + score * 0.1

			existing.accumulatedScore = Math.max(0, Math.min(1, newAccumulated))
			existing.count += 1
			existing.lastSeen = now
			if (!success) {
				existing.failureCount += 1
			}
		} else {
			this.entries.set(patternKey, {
				patternKey,
				accumulatedScore: Math.max(0, Math.min(1, score)),
				count: 1,
				lastSeen: now,
				failureCount: success ? 0 : 1,
			})
		}

		this.debouncedPersist()
	}

	/**
	 * Get the accumulated score for a pattern (fast path).
	 * Returns undefined if the pattern has never been recorded.
	 */
	getPatternScore(patternKey: string): number | undefined {
		const entry = this.entries.get(patternKey)
		if (!entry) {
			return undefined
		}

		return entry.accumulatedScore
	}

	/**
	 * Get all accumulated score entries.
	 * Used by the LLM scorer to evaluate ambiguous patterns.
	 */
	getAllPatterns(): AccumulatedScoreEntry[] {
		return Array.from(this.entries.values()).map((entry) => ({ ...entry }))
	}

	/**
	 * Get entries that have ambiguous scores (between 0.3 and 0.7 exclusive).
	 * These are candidates for LLM evaluation.
	 */
	getAmbiguousPatterns(): AccumulatedScoreEntry[] {
		return this.getAllPatterns().filter(
			(entry) => entry.accumulatedScore > 0.3 && entry.accumulatedScore < 0.7,
		)
	}

	/**
	 * Remove entries older than PRUNE_AFTER_DAYS.
	 * Returns the number of pruned entries.
	 */
	pruneOldPatterns(): number {
		const cutoff = Date.now() - AccumulatedScoreStore.PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000
		let pruned = 0

		for (const [key, entry] of this.entries) {
			if (entry.lastSeen < cutoff) {
				this.entries.delete(key)
				pruned++
			}
		}

		if (pruned > 0) {
			this.logger.appendLine(
				`[AccumulatedScoreStore] Pruned ${pruned} old pattern(s) (older than ${AccumulatedScoreStore.PRUNE_AFTER_DAYS} days)`,
			)
			this.debouncedPersist()
		}

		return pruned
	}

	/**
	 * Get aggregate statistics about the store.
	 */
	getStats(): { totalEntries: number; totalObservations: number; totalFailures: number } {
		let totalObservations = 0
		let totalFailures = 0

		for (const entry of this.entries.values()) {
			totalObservations += entry.count
			totalFailures += entry.failureCount
		}

		return {
			totalEntries: this.entries.size,
			totalObservations,
			totalFailures,
		}
	}

	/**
	 * Reset all accumulated scores.
	 */
	async reset(): Promise<void> {
		this.entries.clear()
		await this.doPersist()
	}
}
