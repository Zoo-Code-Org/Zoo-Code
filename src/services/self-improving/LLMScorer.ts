import type { ProviderSettings } from "@roo-code/types"

import { singleCompletionHandler } from "../../utils/single-completion-handler"
import type { Logger } from "./types"

/**
 * Input to the LLM scorer for evaluating a pattern.
 */
export interface LLMScoreInput {
	/** The pattern key (e.g., "tool:read_file+write_file") */
	patternKey: string
	/** The tools involved in this pattern */
	tools: string[]
	/** The user's task or question context */
	task: string
	/** Whether the pattern led to a successful outcome */
	outcome: "success" | "failure"
}

/**
 * Result from the LLM scorer.
 */
export interface LLMScoreResult {
	/** Semantic score 0–1 */
	score: number
	/** Human-readable reasoning for the score */
	reasoning: string
}

/**
 * LLMScorer — uses the existing singleCompletionHandler (LLM provider)
 * to evaluate patterns semantically.
 *
 * Only called for ambiguous patterns (accumulated score between 0.3–0.7).
 * Returns a score 0–1 with reasoning.
 *
 * Follows the same two-tier pattern as LLMConflictResolver:
 * - Keyword fast path → AccumulatedScoreStore
 * - LLM slow path → this scorer
 */
export class LLMScorer {
	private readonly apiConfiguration: ProviderSettings
	private readonly logger: Logger

	constructor(apiConfiguration: ProviderSettings, logger: Logger) {
		this.apiConfiguration = apiConfiguration
		this.logger = logger
	}

	/**
	 * Evaluate a pattern using the LLM for semantic analysis.
	 *
	 * @param input - The pattern and context to evaluate
	 * @returns Score 0–1 with reasoning
	 */
	async evaluate(input: LLMScoreInput): Promise<LLMScoreResult> {
		const prompt = this.buildPrompt(input)

		try {
			const response = await singleCompletionHandler(this.apiConfiguration, prompt)
			return this.parseResponse(response)
		} catch (error) {
			this.logger.appendLine(
				`[LLMScorer] LLM call failed for pattern "${input.patternKey}": ${error instanceof Error ? error.message : String(error)}`,
			)
			// Fallback: return neutral score
			return {
				score: 0.5,
				reasoning: `LLM evaluation failed, defaulting to neutral: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}

	/**
	 * Build the prompt for the LLM.
	 */
	private buildPrompt(input: LLMScoreInput): string {
		return `You are a pattern scoring system. Your job is to evaluate how well a tool-usage pattern matches a given task context.

PATTERN:
- Key: ${input.patternKey}
- Tools: [${input.tools.join(", ")}]
- Previous outcome: ${input.outcome}

TASK CONTEXT:
${input.task}

Evaluate this pattern on a scale of 0 to 1:
- 0.0 = Completely irrelevant or harmful pattern for this task
- 0.5 = Neutral — pattern is neither clearly good nor bad
- 1.0 = Perfect match — pattern is exactly what this task needs

Consider:
1. Do the tools in the pattern match what this task requires?
2. Did the pattern succeed or fail previously?
3. Is the pattern specific enough to be actionable?
4. Would applying this pattern likely help or hinder the task?

Respond with a JSON object:
{
    "score": 0.75,
    "reasoning": "Brief explanation of the score"
}

Return ONLY valid JSON. No markdown, no code fences.`
	}

	/**
	 * Parse the LLM response to extract score and reasoning.
	 */
	private parseResponse(response: string): LLMScoreResult {
		try {
			// Try to find a JSON object in the response
			const jsonMatch = response.match(/\{[\s\S]*\}/)
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0])
				const score = typeof parsed.score === "number" ? parsed.score : 0.5
				return {
					score: Math.max(0, Math.min(1, score)),
					reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
				}
			}
		} catch {
			// If parsing fails, return neutral
		}

		return {
			score: 0.5,
			reasoning: "Failed to parse LLM response, defaulting to neutral",
		}
	}
}
