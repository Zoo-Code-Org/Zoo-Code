import type { Requirement, ConflictResolution, ConflictResolver } from "./types"

/**
 * Keyword-based conflict resolver using Jaccard similarity.
 * Falls back to this when LLM-based resolution is unavailable.
 */
export class KeywordConflictResolver implements ConflictResolver {
	readonly name = "keyword"

	async resolve(
		newRequirement: Requirement,
		existingRequirements: Requirement[],
		_newMessageIndex: number,
		_allMessages: string[],
	): Promise<ConflictResolution> {
		const supersedes: string[] = []
		const newWords = this.getSignificantWords(newRequirement.text)

		for (const existing of existingRequirements) {
			const existingWords = this.getSignificantWords(existing.text)
			const overlap = this.calculateOverlap(newWords, existingWords)
			if (overlap >= 0.4) {
				supersedes.push(existing.id)
			}
		}

		return {
			supersedes,
			confidence: supersedes.length > 0 ? 0.6 : 0.9,
			reason:
				supersedes.length > 0
					? `Keyword overlap detected (Jaccard similarity >= 0.4)`
					: "No significant keyword overlap with existing requirements",
		}
	}

	/**
	 * Extract significant words from text (lowercase, remove common words)
	 */
	getSignificantWords(text: string): string[] {
		const stopWords = new Set([
			"the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
			"of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
			"been", "being", "have", "has", "had", "do", "does", "did", "will",
			"would", "could", "should", "may", "might", "shall", "can", "need",
			"must", "this", "that", "these", "those", "it", "its", "they", "them",
			"their", "we", "us", "our", "you", "your", "he", "she", "him", "her",
			"his", "not", "no", "nor", "so", "if", "then", "than", "too", "very",
			"just", "about", "above", "after", "again", "all", "also", "any",
			"because", "before", "between", "both", "each", "few", "more", "most",
			"other", "some", "such", "only", "own", "same", "into", "over", "under",
			"up", "out", "off", "down", "here", "there", "when", "where", "why",
			"how", "what", "which", "who", "whom", "please", "make", "like",
		])

		return text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, "")
			.split(/\s+/)
			.filter((w) => w.length > 2 && !stopWords.has(w))
	}

	/**
	 * Calculate overlap ratio between two word sets (Jaccard similarity)
	 */
	calculateOverlap(words1: string[], words2: string[]): number {
		if (words1.length === 0 || words2.length === 0) return 0

		const set1 = new Set(words1)
		const set2 = new Set(words2)

		let intersection = 0
		for (const w of set1) {
			if (set2.has(w)) intersection++
		}

		const union = new Set([...set1, ...set2]).size
		return union === 0 ? 0 : intersection / union
	}
}
