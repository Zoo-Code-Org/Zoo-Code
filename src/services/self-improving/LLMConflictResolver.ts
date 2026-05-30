import type { Requirement, ConflictResolution, ConflictResolver } from "./types"
import type { ProviderSettings } from "@roo-code/types"
import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { KeywordConflictResolver } from "./KeywordConflictResolver"

/**
 * Two-tier conflict resolver:
 * 1. Fast keyword path via Jaccard similarity (KeywordConflictResolver)
 * 2. LLM fallback for ambiguous similarity range (0.3 < Jaccard < 0.7)
 *
 * Clear match (>= 0.7) → keyword result directly (no LLM call)
 * Clear non-match (<= 0.3) → keyword result directly (no LLM call)
 * Ambiguous (0.3–0.7) → LLM for semantic analysis
 */
export class LLMConflictResolver implements ConflictResolver {
	readonly name = "llm"

	/** Jaccard threshold below which requirements are considered unrelated */
	private static readonly CLEAR_NON_MATCH_THRESHOLD = 0.3

	/** Jaccard threshold above which requirements are considered a clear match */
	private static readonly CLEAR_MATCH_THRESHOLD = 0.7

	private readonly keywordResolver: KeywordConflictResolver

	constructor(
		private readonly apiConfiguration: ProviderSettings,
	) {
		this.keywordResolver = new KeywordConflictResolver()
	}

	async resolve(
		newRequirement: Requirement,
		existingRequirements: Requirement[],
		newMessageIndex: number,
		allMessages: string[],
	): Promise<ConflictResolution> {
		if (existingRequirements.length === 0) {
			return { supersedes: [], confidence: 1.0, reason: "No existing requirements to compare" }
		}

		// Phase 1: Keyword analysis for each existing requirement
		const newWords = this.keywordResolver.getSignificantWords(newRequirement.text)
		const clearSupersedes: string[] = []
		const ambiguousPairs: Array<{ existing: Requirement; similarity: number }> = []

		for (const existing of existingRequirements) {
			const existingWords = this.keywordResolver.getSignificantWords(existing.text)
			const similarity = this.keywordResolver.calculateOverlap(newWords, existingWords)

			if (similarity >= LLMConflictResolver.CLEAR_MATCH_THRESHOLD) {
				// Clear keyword match — supersede without LLM
				clearSupersedes.push(existing.id)
			} else if (similarity > LLMConflictResolver.CLEAR_NON_MATCH_THRESHOLD) {
				// Ambiguous range — needs LLM analysis
				ambiguousPairs.push({ existing, similarity })
			}
			// similarity <= 0.3: clear non-match, skip entirely
		}

		// Phase 2: LLM analysis for ambiguous pairs only
		let llmSupersedes: string[] = []
		let llmReason = ""

		if (ambiguousPairs.length > 0) {
			try {
				const result = await this.callLlm(
					newRequirement,
					ambiguousPairs,
					newMessageIndex,
					allMessages,
				)
				llmSupersedes = result.supersedes
				llmReason = result.reason
			} catch (error) {
				// LLM call failed — fall back to keyword heuristic for ambiguous pairs
				const fallbackIds = ambiguousPairs.map((p) => p.existing.id)
				return {
					supersedes: [...clearSupersedes, ...fallbackIds],
					confidence: 0.4,
					reason: `LLM call failed, fell back to keyword heuristic: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
		}

		const allSupersedes = [...new Set([...clearSupersedes, ...llmSupersedes])]
		const confidence = this.calculateConfidence(
			clearSupersedes.length,
			ambiguousPairs.length,
			llmSupersedes.length,
		)

		return {
			supersedes: allSupersedes,
			confidence,
			reason: llmReason || this.buildKeywordReason(clearSupersedes),
		}
	}

	/**
	 * Calculate overall confidence based on how many decisions came from keyword vs LLM.
	 */
	private calculateConfidence(
		clearCount: number,
		ambiguousCount: number,
		llmSupersedeCount: number,
	): number {
		const totalDecisions = clearCount + ambiguousCount
		if (totalDecisions === 0) return 0.95

		// Keyword decisions have high confidence (0.9), LLM decisions moderate (0.8)
		const keywordWeight = clearCount / totalDecisions
		const llmWeight = ambiguousCount / totalDecisions
		return Math.round((keywordWeight * 0.9 + llmWeight * 0.8) * 100) / 100
	}

	/**
	 * Build a reason string when only keyword analysis was used.
	 */
	private buildKeywordReason(supersedes: string[]): string {
		if (supersedes.length > 0) {
			return `Keyword overlap detected (Jaccard similarity >= ${LLMConflictResolver.CLEAR_MATCH_THRESHOLD})`
		}
		return "No significant keyword overlap with existing requirements"
	}

	/**
	 * Call LLM to resolve ambiguous requirement pairs.
	 */
	private async callLlm(
		newRequirement: Requirement,
		ambiguousPairs: Array<{ existing: Requirement; similarity: number }>,
		newMessageIndex: number,
		allMessages: string[],
	): Promise<{ supersedes: string[]; reason: string }> {
		const recentMessages = allMessages
			.slice(Math.max(0, allMessages.length - 5))
			.map((m, i) => `[Message ${i + 1}]: ${m.slice(0, 200)}`)
			.join("\n\n")

		const ambiguousList = ambiguousPairs
			.map(
				(p, i) =>
					`[${i + 1}] ID: ${p.existing.id}\n    Text: "${p.existing.text}"\n    Category: ${p.existing.category}\n    From message: ${p.existing.messageIndex}\n    Keyword similarity: ${p.similarity.toFixed(2)}`,
			)
			.join("\n\n")

		const prompt = `You are a requirements conflict resolution system. Your job is to determine if a NEW user requirement SUPERSEDES (replaces, overrides, or contradicts) any EXISTING requirements.

RULES:
- A later requirement supersedes an earlier one when they address the same feature, behavior, or constraint
- The most recent message has the HIGHEST priority — later instructions override earlier ones
- If the new requirement is about a completely different topic, it does NOT supersede anything
- If the new requirement explicitly contradicts an existing one (e.g., "don't do X" vs "do X"), it supersedes
- If the new requirement is a refinement or clarification of an existing one, it supersedes
- Consider semantic meaning, not just keywords
- Return ONLY the IDs of existing requirements that are superseded

CONTEXT (recent user messages):
${recentMessages}

EXISTING REQUIREMENTS (ambiguous — keyword similarity was inconclusive):
${ambiguousList}

NEW REQUIREMENT (from message ${newMessageIndex}):
"${newRequirement.text}"
Category: ${newRequirement.category}

Does this new requirement supersede any of the existing requirements? Respond with a JSON object:
{
    "supersedes": ["id1", "id2"],
    "reason": "Brief explanation of the decision"
}

If none are superseded, return: { "supersedes": [], "reason": "No semantic overlap detected" }`

		const response = await singleCompletionHandler(this.apiConfiguration, prompt)
		return this.parseResponse(response)
	}

	private parseResponse(response: string): { supersedes: string[]; reason: string } {
		try {
			const jsonMatch = response.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0])
				return {
					supersedes: Array.isArray(parsed.supersedes) ? parsed.supersedes : [],
					reason: typeof parsed.reason === "string" ? parsed.reason : "",
				}
			}
		} catch {
			// If parsing fails, return empty
		}
		return { supersedes: [], reason: "Failed to parse LLM response" }
	}
}
