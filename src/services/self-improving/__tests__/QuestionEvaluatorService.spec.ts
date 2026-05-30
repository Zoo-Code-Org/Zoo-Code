import { describe, it, expect, vi, beforeEach } from "vitest"
import { QuestionEvaluatorService } from "../QuestionEvaluatorService"

describe("QuestionEvaluatorService", () => {
	let service: QuestionEvaluatorService

	beforeEach(() => {
		service = new QuestionEvaluatorService({ appendLine: vi.fn() } as any)
	})

	describe("evaluateBestChoice", () => {
		it("should fallback to first choice when disabled", async () => {
			const disabled = new QuestionEvaluatorService({ appendLine: vi.fn() } as any, { enabled: false })
			const result = await disabled.evaluateBestChoice("test question", [
				{ text: "first", mode: null },
				{ text: "second", mode: null },
			])
			expect(result.selectedIndex).toBe(0)
			expect(result.evaluatedBy).toBe("fallback")
		})

		it("should fallback to first choice with single choice", async () => {
			const result = await service.evaluateBestChoice("test", [{ text: "only choice", mode: null }])
			expect(result.selectedIndex).toBe(0)
			expect(result.evaluatedBy).toBe("fallback")
		})

		it("should use contextual analysis for multiple choices", async () => {
			const result = await service.evaluateBestChoice("Should I implement the feature?", [
				{ text: "No, don't do it", mode: null },
				{ text: "Yes, implement the feature now with full test coverage", mode: null },
			])
			// Contextual analysis should prefer the actionable, specific answer
			expect(result.evaluatedBy).toBe("contextual")
			expect(result.selectedIndex).toBe(1) // Should pick the actionable answer
		})

		it("should prefer choices with mode switches for delegation questions", async () => {
			const result = await service.evaluateBestChoice("Which mode should I switch to for this task?", [
				{ text: "Just do it here", mode: null },
				{ text: "Switch to code mode", mode: "code" },
				{ text: "Switch to architect mode", mode: "architect" },
			])
			// Should prefer a choice with a mode switch
			expect(result.selectedIndex).toBeGreaterThan(0)
			expect(result.choices[result.selectedIndex].mode).not.toBeNull()
		})

		it("should use Full Team when available", async () => {
			const mockReviewTeam = {
				reviewPattern: vi.fn().mockResolvedValue({
					approved: true,
					score: 0.8,
					summary: "Good choice",
					innovatorVote: { approved: true, confidence: 0.8, reasoning: "good" },
					contrarianVote: { approved: true, confidence: 0.7, reasoning: "ok" },
					devilsAdvocateVote: { approved: true, confidence: 0.9, reasoning: "great" },
					deciderVote: { approved: true, confidence: 0.8, reasoning: "approved" },
					timestamp: new Date(),
				}),
			}
			service.setReviewTeam(mockReviewTeam as any)

			const result = await service.evaluateBestChoice("test", [
				{ text: "option A", mode: null },
				{ text: "option B", mode: null },
			])
			expect(result.evaluatedBy).toBe("full-team")
			expect(mockReviewTeam.reviewPattern).toHaveBeenCalledTimes(2)
		})
	})

	describe("getStatus", () => {
		it("should return status object", () => {
			const status = service.getStatus()
			expect(status.enabled).toBe(true)
			expect(status.useFullTeam).toBe(true)
		})
	})

	describe("updateConfig", () => {
		it("should update config values", () => {
			service.updateConfig({ enabled: false, useContextualAnalysis: false })
			const config = service.getConfig()
			expect(config.enabled).toBe(false)
			expect(config.useContextualAnalysis).toBe(false)
			expect(config.useFullTeam).toBe(true) // unchanged
		})
	})
})
