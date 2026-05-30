import crypto from "crypto"

import type { Experiments, LearnedPattern, LearningEvent } from "./types"
import type { CodeIndexManager } from "../code-index/manager"

interface PatternAnalyzerOptions {
	getExperiments?: () => Experiments | undefined
}

/**
 * PatternAnalyzer - extracts learned patterns from event streams
 * using deterministic heuristics (frequency analysis, correction tracking,
 * success correlation).
 *
 * Adapted from Hermes' symbolic pattern extraction approach.
 */
export class PatternAnalyzer {
	private readonly getExperiments: () => Experiments | undefined
	private codeIndexManager: CodeIndexManager | undefined

	constructor(options: PatternAnalyzerOptions = {}) {
		this.getExperiments = options.getExperiments ?? (() => undefined)
	}

	/**
	 * Set the CodeIndexManager instance for vector-search-based pattern retrieval.
	 */
	setCodeIndexManager(manager: CodeIndexManager | undefined): void {
		this.codeIndexManager = manager
	}

	/**
	 * Analyze a batch of events and return new/updated patterns.
	 * This is the main entry point called during review cycles.
	 */
	async analyze(events: LearningEvent[], existingPatterns: LearnedPattern[]): Promise<LearnedPattern[]> {
		const patterns: LearnedPattern[] = []
		const now = Date.now()

		const correctionPatterns = this.extractCorrectionPatterns(events, existingPatterns, now)
		patterns.push(...correctionPatterns)

		const successPatterns = this.extractSuccessPatterns(events, existingPatterns, now)
		patterns.push(...successPatterns)

		const toolPatterns = this.extractToolPatterns(events, existingPatterns, now)
		patterns.push(...toolPatterns)

		const codeIndexPatterns = await this.extractCodeIndexPatterns(events, existingPatterns, now)
		patterns.push(...codeIndexPatterns)

		const experiments = this.getExperiments()
		if (experiments?.selfImprovingPromptQuality !== false) {
			const promptQualityPatterns = this.extractPromptQualityPatterns(events, existingPatterns, now)
			patterns.push(...promptQualityPatterns)
		}

		if (experiments?.selfImprovingPromptQuality !== false) {
			const patternRepeatPatterns = this.extractPatternRepeatPatterns(events, existingPatterns, now)
			patterns.push(...patternRepeatPatterns)
		}

		return patterns
	}

	/**
	 * Extract error-avoidance patterns from correction/failure events.
	 */
	private extractCorrectionPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const correctionEvents = events.filter(
			(event) =>
				event.signal === "USER_CORRECTION" || (event.signal === "TASK_FAILURE" && event.outcome.corrected),
		)

		const byErrorKey = new Map<string, LearningEvent[]>()
		for (const event of correctionEvents) {
			const key = event.context.errorKey || "unknown"
			const bucket = byErrorKey.get(key) ?? []
			bucket.push(event)
			byErrorKey.set(key, bucket)
		}

		for (const [errorKey, errorEvents] of byErrorKey) {
			const frequency = errorEvents.length
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "error" && pattern.context.errorKeys?.includes(errorKey),
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + frequency,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + frequency * 0.05),
					successRate: Math.max(0, existing.successRate - frequency * 0.02),
				})
			} else if (frequency >= 2) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "error",
					state: "active",
					summary: `Avoid: repeated ${errorKey} errors detected`,
					confidenceScore: Math.min(0.5, frequency * 0.1),
					frequency,
					successRate: 0.3,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["USER_CORRECTION", "TASK_FAILURE"],
					context: {
						errorKeys: [errorKey],
						toolNames: this.collectToolNames(errorEvents),
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract success patterns from task success events.
	 */
	private extractSuccessPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const successEvents = events.filter((event) => event.signal === "TASK_SUCCESS")

		if (successEvents.length < 2) {
			return patterns
		}

		const byToolSet = new Map<string, LearningEvent[]>()
		for (const event of successEvents) {
			const toolKey = [...(event.context.toolNames ?? [])].sort().join(",")
			if (!toolKey) {
				continue
			}

			const bucket = byToolSet.get(toolKey) ?? []
			bucket.push(event)
			byToolSet.set(toolKey, bucket)
		}

		for (const [toolKey, toolEvents] of byToolSet) {
			const frequency = toolEvents.length
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "tool" && this.hasMatchingToolNames(pattern, toolKey.split(",")),
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + frequency,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + frequency * 0.03),
					successRate: Math.min(1, existing.successRate + frequency * 0.02),
				})
			} else if (frequency >= 2) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "tool",
					state: "active",
					summary: `Effective tool combination: ${toolKey}`,
					confidenceScore: Math.min(0.6, frequency * 0.1),
					frequency,
					successRate: 0.6,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["TASK_SUCCESS"],
					context: {
						toolNames: toolKey.split(","),
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract tool preference patterns.
	 */
	private extractToolPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const toolCounts = new Map<string, { success: number; failure: number }>()

		for (const event of events) {
			for (const toolName of event.context.toolNames ?? []) {
				const counts = toolCounts.get(toolName) ?? { success: 0, failure: 0 }
				if (event.signal === "TASK_SUCCESS") {
					counts.success++
				} else if (event.signal === "TASK_FAILURE") {
					counts.failure++
				}
				toolCounts.set(toolName, counts)
			}
		}

		for (const [toolName, counts] of toolCounts) {
			const total = counts.success + counts.failure
			if (total < 3) {
				continue
			}

			const successRate = counts.success / total
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "prompt" && this.hasMatchingToolNames(pattern, [toolName]),
			)

			if (existing) {
				const combinedFrequency = existing.frequency + total
				const existingSuccesses = existing.successRate * existing.frequency
				const combinedSuccessRate = (existingSuccesses + counts.success) / combinedFrequency

				patterns.push({
					...existing,
					frequency: combinedFrequency,
					lastSeenAt: now,
					successRate: combinedSuccessRate,
					confidenceScore: Math.min(1, existing.confidenceScore + 0.02),
				})
			} else if (successRate > 0.7) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "prompt",
					state: "active",
					summary: `Prefer ${toolName} for reliable results`,
					confidenceScore: Math.min(0.5, successRate * 0.5),
					frequency: total,
					successRate,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["TASK_SUCCESS"],
					context: {
						toolNames: [toolName],
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract code index correlation patterns.
	 * Uses vector search to find patterns related to current event context
	 * when selfImprovingCodeIndex experiment is enabled.
	 */
	private async extractCodeIndexPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): Promise<LearnedPattern[]> {
		const experiments = this.getExperiments()
		const codeIndexEvents = events.filter((event) => event.signal === "CODE_INDEX_HIT")

		// When code index integration is enabled, use vector search for richer patterns
		if (experiments?.selfImprovingCodeIndex !== false && this.codeIndexManager) {
			return this.extractCodeIndexPatternsWithVectorSearch(events, existingPatterns, now, codeIndexEvents)
		}

		// Fallback: original heuristic-based extraction
		if (codeIndexEvents.length < 3) {
			return []
		}

		const totalHits = codeIndexEvents.reduce((sum, event) => sum + (event.context.codeIndex?.hits ?? 0), 0)
		const averageHits = totalHits / codeIndexEvents.length
		if (averageHits <= 0) {
			return []
		}

		const summary = `Code indexing correlates with task outcomes (avg ${averageHits.toFixed(1)} hits/event)`
		const existing = existingPatterns.find(
			(pattern) => pattern.patternType === "code-index" && pattern.summary === summary,
		)

		if (existing) {
			return [
				{
					...existing,
					frequency: existing.frequency + codeIndexEvents.length,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + averageHits * 0.01),
				},
			]
		}

		return [
			{
				id: crypto.randomUUID(),
				patternType: "code-index",
				state: "active",
				summary,
				confidenceScore: Math.min(0.5, averageHits * 0.05),
				frequency: codeIndexEvents.length,
				successRate: 0.6,
				firstSeenAt: now,
				lastSeenAt: now,
				sourceSignals: ["CODE_INDEX_HIT"],
				context: {
					toolNames: [],
					errorKeys: [],
				},
			},
		]
	}

	/**
	 * Vector-search-enhanced code index pattern extraction.
	 * Searches for patterns related to current event context via CodeIndexManager.
	 */
	private async extractCodeIndexPatternsWithVectorSearch(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
		codeIndexEvents: LearningEvent[],
	): Promise<LearnedPattern[]> {
		const patterns: LearnedPattern[] = []

		// Build search queries from event context
		const searchQueries: string[] = []
		for (const event of events) {
			const toolContext = event.context.toolNames?.join(" ") ?? ""
			const errorContext = event.context.errorKey ?? ""
			const query = [toolContext, errorContext, event.outcome.summary ?? ""].filter(Boolean).join(" ")
			if (query.length > 5) {
				searchQueries.push(query)
			}
		}

		// Deduplicate queries (take up to 3 most relevant)
		const uniqueQueries = [...new Set(searchQueries)].slice(0, 3)

		for (const query of uniqueQueries) {
			try {
				const results = await this.codeIndexManager!.searchIndex(query)
				if (!results || results.length === 0) {
					continue
				}

				for (const result of results) {
					const payload = result.payload
					if (!payload?.codeChunk) {
						continue
					}

					const filePath = payload.filePath ?? "unknown"
					const startLine = payload.startLine ?? 0
					const endLine = payload.endLine ?? 0
					const summary = `[CodeIndex:${filePath}:${startLine}-${endLine}] ${payload.codeChunk.slice(0, 150)}`

					const existing = existingPatterns.find(
						(p) => p.patternType === "code-index" && p.summary === summary,
					)

					if (existing) {
						patterns.push({
							...existing,
							frequency: existing.frequency + 1,
							lastSeenAt: now,
							confidenceScore: Math.min(1, existing.confidenceScore + result.score * 0.05),
						})
					} else {
						patterns.push({
							id: crypto.randomUUID(),
							patternType: "code-index",
							state: "active",
							summary,
							confidenceScore: Math.min(0.5, result.score * 0.5),
							frequency: 1,
							successRate: 0.5,
							firstSeenAt: now,
							lastSeenAt: now,
							sourceSignals: ["CODE_INDEX_HIT"],
							context: {
								toolNames: [],
								errorKeys: [],
							},
						})
					}
				}
			} catch (error) {
				// Log and continue with other queries
				console.error(`[PatternAnalyzer] Vector search error for query "${query}":`, error)
			}
		}

		return patterns
	}

	/**
	 * Extract patterns from PROMPT_QUALITY events.
	 * Identifies prompt fingerprints that consistently yield high/low quality scores.
	 */
	private extractPromptQualityPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const qualityEvents = events.filter((event) => event.signal === "PROMPT_QUALITY")

		if (qualityEvents.length < 2) {
			return patterns
		}

		const byFingerprint = new Map<string, { total: number; count: number }>()
		for (const event of qualityEvents) {
			const fp = event.context.promptFingerprint ?? "unknown"
			const bucket = byFingerprint.get(fp) ?? { total: 0, count: 0 }
			bucket.total += event.outcome.confidenceDelta ?? 0
			bucket.count++
			byFingerprint.set(fp, bucket)
		}

		for (const [fingerprint, stats] of byFingerprint) {
			if (stats.count < 2) {
				continue
			}

			const avgDelta = stats.total / stats.count
			const isPositive = avgDelta > 0
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "prompt" && pattern.context.promptFingerprint === fingerprint,
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + stats.count,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + Math.abs(avgDelta) * 0.1),
					successRate: isPositive
						? Math.min(1, existing.successRate + 0.02)
						: Math.max(0, existing.successRate - 0.02),
				})
			} else if (stats.count >= 3) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "prompt",
					state: "active",
					summary: isPositive
						? `Prompt fingerprint ${fingerprint.slice(0, 16)} yields quality improvements`
						: `Prompt fingerprint ${fingerprint.slice(0, 16)} degrades quality`,
					confidenceScore: Math.min(0.5, Math.abs(avgDelta) * 2),
					frequency: stats.count,
					successRate: isPositive ? 0.6 : 0.3,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["PROMPT_QUALITY"],
					context: {
						promptFingerprint: fingerprint,
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract patterns from PATTERN_REPEAT events.
	 * Identifies patterns that are being reused successfully.
	 */
	private extractPatternRepeatPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const repeatEvents = events.filter((event) => event.signal === "PATTERN_REPEAT")

		if (repeatEvents.length < 2) {
			return patterns
		}

		const byPatternId = new Map<string, LearningEvent[]>()
		for (const event of repeatEvents) {
			const patternId = event.context.promptFingerprint ?? "unknown"
			const bucket = byPatternId.get(patternId) ?? []
			bucket.push(event)
			byPatternId.set(patternId, bucket)
		}

		for (const [patternId, patternEvents] of byPatternId) {
			const frequency = patternEvents.length
			const existing = existingPatterns.find(
				(pattern) => pattern.id === patternId || pattern.context.promptFingerprint === patternId,
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + frequency,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + frequency * 0.03),
					successRate: Math.min(1, existing.successRate + frequency * 0.01),
				})
			} else if (frequency >= 3) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "prompt",
					state: "active",
					summary: `Pattern ${patternId.slice(0, 16)} reused ${frequency} times — reinforcing`,
					confidenceScore: Math.min(0.4, frequency * 0.05),
					frequency,
					successRate: 0.5,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["PATTERN_REPEAT"],
					context: {
						promptFingerprint: patternId,
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Collect unique tool names from a set of events.
	 */
	private collectToolNames(events: LearningEvent[]): string[] {
		const names = new Set<string>()
		for (const event of events) {
			for (const name of event.context.toolNames ?? []) {
				names.add(name)
			}
		}

		return [...names]
	}

	private hasMatchingToolNames(pattern: LearnedPattern, toolNames: string[]): boolean {
		const existingToolNames = pattern.context.toolNames
		if (!existingToolNames || existingToolNames.length !== toolNames.length) {
			return false
		}

		const normalizedExisting = [...existingToolNames].sort()
		const normalizedIncoming = [...toolNames].sort()

		return normalizedExisting.every((toolName, index) => toolName === normalizedIncoming[index])
	}
}
