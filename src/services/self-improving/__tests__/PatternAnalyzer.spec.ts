import { describe, expect, it } from "vitest"

import { PatternAnalyzer } from "../PatternAnalyzer"
import type { LearnedPattern, LearningEvent } from "../types"

function createEvent(id: string, signal: LearningEvent["signal"], toolNames: string[]): LearningEvent {
	return {
		id,
		signal,
		timestamp: Number(id.replace(/\D/g, "")) || 1,
		context: {
			toolNames,
		},
		outcome: {},
	}
}

function createPattern(overrides: Partial<LearnedPattern>): LearnedPattern {
	return {
		id: "pattern-1",
		patternType: "tool",
		state: "active",
		summary: "Effective tool combination: browser,search",
		confidenceScore: 0.5,
		frequency: 4,
		successRate: 0.8,
		firstSeenAt: 1,
		lastSeenAt: 1,
		sourceSignals: ["TASK_SUCCESS"],
		context: {
			toolNames: ["browser", "search"],
		},
		...overrides,
	}
}

describe("PatternAnalyzer", () => {
	it("does not merge tool-combination patterns by summary substring alone", async () => {
		const analyzer = new PatternAnalyzer()
		const existingPatterns = [createPattern({})]
		const events = [
			createEvent("event-1", "TASK_SUCCESS", ["search"]),
			createEvent("event-2", "TASK_SUCCESS", ["search"]),
			createEvent("event-3", "TASK_SUCCESS", ["search"]),
		]

		const patterns = await analyzer.analyze(events, existingPatterns)
		const toolPatterns = patterns.filter((pattern) => pattern.patternType === "tool")

		expect(toolPatterns).toHaveLength(1)
		expect(toolPatterns[0]).toMatchObject({
			id: expect.not.stringMatching(/^pattern-1$/),
			summary: "Effective tool combination: search",
			frequency: 3,
			context: {
				toolNames: ["search"],
			},
		})
	})

	it("preserves cumulative frequency for existing tool-preference patterns", async () => {
		const analyzer = new PatternAnalyzer()
		const existingPatterns = [
			createPattern({
				id: "prompt-pattern",
				patternType: "prompt",
				summary: "Prefer terminal for reliable results",
				frequency: 5,
				successRate: 0.8,
				context: {
					toolNames: ["terminal"],
				},
			}),
		]
		const events = [
			createEvent("event-1", "TASK_SUCCESS", ["terminal"]),
			createEvent("event-2", "TASK_SUCCESS", ["terminal"]),
			createEvent("event-3", "TASK_FAILURE", ["terminal"]),
		]

		const patterns = await analyzer.analyze(events, existingPatterns)
		const promptPatterns = patterns.filter((pattern) => pattern.patternType === "prompt")

		expect(promptPatterns).toHaveLength(1)
		expect(promptPatterns[0]).toMatchObject({
			id: "prompt-pattern",
			frequency: 8,
			successRate: 0.75,
			context: {
				toolNames: ["terminal"],
			},
		})
	})
})
