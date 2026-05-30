import { describe, it, expect, vi, beforeEach } from "vitest"
import { LLMConflictResolver } from "./LLMConflictResolver"
import type { Requirement } from "./types"

vi.mock("../../utils/single-completion-handler")

describe("LLMConflictResolver", () => {
	let resolver: LLMConflictResolver

	beforeEach(() => {
		resolver = new LLMConflictResolver({ apiProvider: "openai" } as any)
	})

	it("should have name 'llm'", () => {
		expect(resolver.name).toBe("llm")
	})

	it("should return empty supersedes when no existing requirements", async () => {
		const newReq: Requirement = {
			id: "1",
			text: "Build authentication",
			category: "functional",
			status: "pending",
			messageIndex: 0,
		}
		const result = await resolver.resolve(newReq, [], 0, [])
		expect(result.supersedes).toEqual([])
		expect(result.confidence).toBe(1.0)
		expect(result.reason).toBe("No existing requirements to compare")
	})

	describe("keyword fast path (no LLM call)", () => {
		it("should use keyword result directly when Jaccard >= 0.7 (clear match)", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			const llmSpy = vi.mocked(singleCompletionHandler)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT for login",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with JWT",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, [])
			// Jaccard(["build","authentication","jwt","login"], ["build","authentication","jwt"]) = 3/4 = 0.75 >= 0.7
			expect(result.supersedes).toEqual(["existing-1"])
			expect(result.confidence).toBe(0.9)
			expect(result.reason).toContain("Keyword overlap detected")
			// LLM should NOT be called
			expect(llmSpy).not.toHaveBeenCalled()
		})

		it("should use keyword result directly when Jaccard <= 0.3 (clear non-match)", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			const llmSpy = vi.mocked(singleCompletionHandler)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Add PostgreSQL database schema",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, [])
			// Jaccard(["build","authentication","jwt"], ["add","postgresql","database","schema"]) = 0/7 = 0 <= 0.3
			expect(result.supersedes).toEqual([])
			expect(result.confidence).toBe(0.95)
			expect(result.reason).toContain("No significant keyword overlap")
			// LLM should NOT be called
			expect(llmSpy).not.toHaveBeenCalled()
		})
	})

	describe("LLM fallback path (ambiguous Jaccard 0.3-0.7)", () => {
		it("should call LLM when Jaccard is in ambiguous range", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockResolvedValue(
				JSON.stringify({ supersedes: ["existing-1"], reason: "Same feature, OAuth replaces JWT" }),
			)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with OAuth",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, ["- Build authentication with JWT"])
			// Jaccard("build authentication jwt", "build authentication oauth") = 2/4 = 0.5 → ambiguous
			expect(result.supersedes).toEqual(["existing-1"])
			expect(result.confidence).toBe(0.8)
			expect(result.reason).toBe("Same feature, OAuth replaces JWT")
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
		})

		it("should return empty supersedes when LLM says no overlap", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockResolvedValue(
				JSON.stringify({ supersedes: [], reason: "No semantic overlap detected" }),
			)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with OAuth",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, ["- Build authentication with JWT"])
			expect(result.supersedes).toEqual([])
			expect(result.confidence).toBe(0.8)
			expect(result.reason).toBe("No semantic overlap detected")
		})

		it("should fallback to keyword heuristic on LLM call failure", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockRejectedValue(new Error("API timeout"))

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with OAuth",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, ["- Build authentication with JWT"])
			// Fallback: ambiguous pairs are included with lower confidence
			expect(result.supersedes).toEqual(["existing-1"])
			expect(result.confidence).toBe(0.4)
			expect(result.reason).toContain("LLM call failed")
			expect(result.reason).toContain("API timeout")
		})

		it("should parse JSON embedded in markdown response", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockResolvedValue(
				'Here is my analysis:\n```json\n{"supersedes": ["existing-1"], "reason": "OAuth replaces JWT"}\n```',
			)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with OAuth",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, ["- Build authentication with JWT"])
			expect(result.supersedes).toEqual(["existing-1"])
			expect(result.reason).toBe("OAuth replaces JWT")
		})
	})

	describe("mixed scenarios", () => {
		it("should combine clear keyword matches with LLM results for ambiguous pairs", async () => {
			const { singleCompletionHandler } = await import("../../utils/single-completion-handler")
			vi.mocked(singleCompletionHandler).mockResolvedValue(
				JSON.stringify({ supersedes: ["existing-2"], reason: "OAuth replaces JWT" }),
			)

			const existing: Requirement[] = [
				{
					id: "existing-1",
					text: "Use React 18 for frontend",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
				{
					id: "existing-2",
					text: "Build authentication with JWT",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
				{
					id: "existing-3",
					text: "Add PostgreSQL database",
					category: "functional",
					status: "pending",
					messageIndex: 0,
				},
			]
			const newReq: Requirement = {
				id: "new-1",
				text: "Build authentication with OAuth",
				category: "functional",
				status: "pending",
				messageIndex: 1,
			}
			const result = await resolver.resolve(newReq, existing, 1, [])
			// existing-1: Jaccard("use react 18 frontend", "build authentication oauth") = 0/7 = 0 → skip
			// existing-2: Jaccard("build authentication jwt", "build authentication oauth") = 2/4 = 0.5 → ambiguous → LLM
			// existing-3: Jaccard("add postgresql database", "build authentication oauth") = 0/7 = 0 → skip
			expect(result.supersedes).toEqual(["existing-2"])
			expect(result.confidence).toBe(0.8)
		})
	})
})
