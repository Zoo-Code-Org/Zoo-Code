import { describe, it, expect, vi, beforeEach } from "vitest"
import { ReviewTeamService } from "../ReviewTeamService"
import type { LearnedPattern } from "../../../../packages/types/src/learning"

describe("ReviewTeamService", () => {
	let service: ReviewTeamService

	beforeEach(() => {
		service = new ReviewTeamService({ appendLine: vi.fn() } as any)
	})

	describe("reviewPattern", () => {
		it("should approve high-confidence patterns", async () => {
			const pattern: LearnedPattern = {
				id: "test-1",
				patternType: "tool",
				state: "active",
				summary: "high confidence pattern",
				confidenceScore: 0.8,
				frequency: 10,
				successRate: 0.9,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file", "edit_file"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBeGreaterThanOrEqual(0.5)
		})

		it("should reject low-confidence patterns", async () => {
			service.setApprovedPatternCount(1) // Bypass first-pattern boost
			const pattern: LearnedPattern = {
				id: "test-2",
				patternType: "tool",
				state: "active",
				summary: "low confidence pattern",
				confidenceScore: 0.3, // Above minConfidenceForReview (0.2) so it gets reviewed
				frequency: 1,
				successRate: 0.5,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(false)
		})

		it("should pass through when disabled", async () => {
			const disabled = new ReviewTeamService({ appendLine: vi.fn() } as any, { enabled: false })
			const pattern: LearnedPattern = {
				id: "test-3",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.5,
				frequency: 3,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const verdict = await disabled.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBe(1.0)
		})

		it("should include all 4 persona votes", async () => {
			const pattern: LearnedPattern = {
				id: "test-4",
				patternType: "tool",
				state: "active",
				summary: "test",
				confidenceScore: 0.6,
				frequency: 5,
				successRate: 0.8,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file", "edit_file", "execute_command"] },
			}
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.innovatorVote).toBeDefined()
			expect(verdict.contrarianVote).toBeDefined()
			expect(verdict.devilsAdvocateVote).toBeDefined()
			expect(verdict.deciderVote).toBeDefined()
		})
	})

	describe("reviewPatterns", () => {
		it("should return approved and rejected lists", async () => {
			service.setApprovedPatternCount(1) // Bypass first-pattern boost
			const patterns: LearnedPattern[] = [
				{
					id: "p1",
					patternType: "tool",
					state: "active",
					summary: "good",
					confidenceScore: 0.8,
					frequency: 10,
					successRate: 0.9,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file", "edit_file"] },
				},
				{
					id: "p2",
					patternType: "tool",
					state: "active",
					summary: "bad",
					confidenceScore: 0.3, // Above minConfidenceForReview (0.2) so it gets reviewed
					frequency: 1,
					successRate: 0.3,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
			]
			const result = await service.reviewPatterns(patterns)
			expect(result.approved).toHaveLength(1)
			expect(result.rejected).toHaveLength(1)
			expect(result.verdicts).toHaveLength(2)
		})
		it("should auto-approve first pattern when approvedPatternCount is 0 (cold start boost)", async () => {
			const pattern: LearnedPattern = {
				id: "cold-start-1",
				patternType: "tool",
				state: "active",
				summary: "cold start pattern",
				confidenceScore: 0.3,
				frequency: 1,
				successRate: 0.3,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			// approvedPatternCount starts at 0
			const verdict = await service.reviewPattern(pattern)
			expect(verdict.approved).toBe(true)
			expect(verdict.score).toBeGreaterThanOrEqual(0.3)
		})

		it("should still reject low-confidence pattern after first pattern is approved", async () => {
			// Seed: approve first pattern to bump count
			const firstPattern: LearnedPattern = {
				id: "seed-1",
				patternType: "tool",
				state: "active",
				summary: "seed",
				confidenceScore: 0.3,
				frequency: 1,
				successRate: 0.3,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const firstVerdict = await service.reviewPattern(firstPattern)
			expect(firstVerdict.approved).toBe(true)

			// Now approvedPatternCount is 1, so boost no longer applies
			const secondPattern: LearnedPattern = {
				id: "cold-start-2",
				patternType: "tool",
				state: "active",
				summary: "second pattern",
				confidenceScore: 0.3,
				frequency: 1,
				successRate: 0.3,
				firstSeenAt: Date.now(),
				lastSeenAt: Date.now(),
				sourceSignals: [],
				context: { toolNames: ["read_file"] },
			}
			const secondVerdict = await service.reviewPattern(secondPattern)
			expect(secondVerdict.approved).toBe(false)
		})

		it("should increment approvedPatternCount via reviewPatterns", async () => {
			expect(service.getApprovedPatternCount()).toBe(0)

			const patterns: LearnedPattern[] = [
				{
					id: "boost-test-1",
					patternType: "tool",
					state: "active",
					summary: "first",
					confidenceScore: 0.3,
					frequency: 1,
					successRate: 0.3,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file"] },
				},
				{
					id: "boost-test-2",
					patternType: "tool",
					state: "active",
					summary: "second",
					confidenceScore: 0.8,
					frequency: 10,
					successRate: 0.9,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					sourceSignals: [],
					context: { toolNames: ["read_file", "edit_file"] },
				},
			]
			const result = await service.reviewPatterns(patterns)
			expect(result.approved).toHaveLength(2)
			expect(service.getApprovedPatternCount()).toBe(2)
		})
	})

	describe("updateConfig", () => {
		it("should update config values", () => {
			service.updateConfig({ innovatorWeight: 0.5, deciderThreshold: 0.8 })
			const config = service.getConfig()
			expect(config.innovatorWeight).toBe(0.5)
			expect(config.deciderThreshold).toBe(0.8)
		})
	})
})
