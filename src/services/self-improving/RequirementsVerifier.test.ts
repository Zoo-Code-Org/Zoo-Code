import { describe, it, expect, vi, beforeEach } from "vitest"
import { RequirementsVerifier } from "./RequirementsVerifier"
import { KeywordConflictResolver } from "./KeywordConflictResolver"
import type { ConflictResolver, ConflictResolution, Requirement } from "./types"

vi.mock("../../utils/single-completion-handler")

describe("RequirementsVerifier", () => {
	let verifier: RequirementsVerifier
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		logger = { appendLine: vi.fn() }
		verifier = new RequirementsVerifier(logger)
	})

	describe("config", () => {
		it("should use defaults when no config provided", () => {
			const v = new RequirementsVerifier()
			const config = v.getConfig()
			expect(config.mandatory).toBe(true)
			expect(config.autoExtract).toBe(true)
			expect(config.requireAllVerified).toBe(true)
		})

		it("should merge partial config with defaults", () => {
			const v = new RequirementsVerifier(undefined, { mandatory: false })
			const config = v.getConfig()
			expect(config.mandatory).toBe(false)
			expect(config.autoExtract).toBe(true)
			expect(config.requireAllVerified).toBe(true)
		})

		it("should update config via updateConfig", () => {
			verifier.updateConfig({ requireAllVerified: false })
			const config = verifier.getConfig()
			expect(config.requireAllVerified).toBe(false)
			expect(config.mandatory).toBe(true)
		})
	})

	describe("conflict resolver", () => {
		it("should default to KeywordConflictResolver", () => {
			const resolver = verifier.getConflictResolver()
			expect(resolver).toBeInstanceOf(KeywordConflictResolver)
			expect(resolver.name).toBe("keyword")
		})

		it("should accept custom conflict resolver via constructor", () => {
			const mockResolver: ConflictResolver = {
				name: "mock",
				resolve: vi.fn().mockResolvedValue({ supersedes: [], confidence: 1, reason: "mock" }),
			}
			const v = new RequirementsVerifier(undefined, undefined, mockResolver)
			expect(v.getConflictResolver()).toBe(mockResolver)
		})

		it("should allow runtime resolver swap via setConflictResolver", () => {
			const mockResolver: ConflictResolver = {
				name: "mock",
				resolve: vi.fn().mockResolvedValue({ supersedes: [], confidence: 1, reason: "mock" }),
			}
			verifier.setConflictResolver(mockResolver)
			expect(verifier.getConflictResolver()).toBe(mockResolver)
			expect(verifier.getConflictResolver().name).toBe("mock")
		})

		it("should use custom resolver during processUserMessages", async () => {
			const mockResolver: ConflictResolver = {
				name: "mock",
				resolve: vi.fn().mockResolvedValue({ supersedes: [], confidence: 1, reason: "mock" }),
			}
			const v = new RequirementsVerifier(logger, undefined, mockResolver)
			const reqs = await v.processUserMessages(["- Build authentication"])
			expect(mockResolver.resolve).toHaveBeenCalledTimes(1)
			expect(reqs).toHaveLength(1)
		})
	})

	describe("extractFromPrompt", () => {
		it("should extract requirements from bullet points", () => {
			const prompt = `
- Implement user authentication
- Add database schema
- Write API tests
			`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toBe("Implement user authentication")
			expect(reqs[1].text).toBe("Add database schema")
			expect(reqs[2].text).toBe("Write API tests")
			expect(reqs.every((r) => r.status === "pending")).toBe(true)
		})

		it("should extract requirements from numbered lists", () => {
			const prompt = `
1. Set up CI/CD pipeline
2. Configure monitoring
3. Deploy to production
			`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(3)
			expect(reqs[0].text).toBe("Set up CI/CD pipeline")
			expect(reqs[1].text).toBe("Configure monitoring")
			expect(reqs[2].text).toBe("Deploy to production")
		})

		it("should extract requirements from keyword sentences", () => {
			const prompt = "The system must handle 10k concurrent users. It should encrypt all data at rest. We need to implement rate limiting."
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs.length).toBeGreaterThanOrEqual(1)
			expect(reqs.some((r) => r.text.includes("handle 10k concurrent users"))).toBe(true)
		})

		it("should treat plain prompt as one goal requirement", () => {
			const prompt = "Build a todo app"
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(1)
			expect(reqs[0].text).toBe("Build a todo app")
			expect(reqs[0].category).toBe("goal")
		})

		it("should detect category headers", () => {
			const prompt = `
	## Security
	- Encrypt all passwords
	## Constraint
	- Response time under 200ms
				`.trim()
			const reqs = verifier.extractFromPrompt(prompt)
			expect(reqs).toHaveLength(2)
			expect(reqs[0].category).toBe("security")
			expect(reqs[1].category).toBe("constraint")
		})

		it("should return empty array for empty prompt", () => {
			const reqs = verifier.extractFromPrompt("")
			expect(reqs).toHaveLength(0)
		})

		it("should assign messageIndex to extracted requirements", () => {
			const reqs = verifier.extractFromPrompt("- Do something", 5)
			expect(reqs).toHaveLength(1)
			expect(reqs[0].messageIndex).toBe(5)
		})
	})

	describe("addRequirement", () => {
		it("should add a requirement manually", () => {
			const req = verifier.addRequirement("Test requirement", "constraint")
			expect(req.text).toBe("Test requirement")
			expect(req.category).toBe("constraint")
			expect(req.status).toBe("pending")
			expect(req.id).toBeTruthy()
			expect(req.messageIndex).toBe(0)
		})

		it("should default to functional category", () => {
			const req = verifier.addRequirement("Some requirement")
			expect(req.category).toBe("functional")
		})
	})

	describe("verifyRequirement", () => {
		it("should mark requirement as verified with evidence", () => {
			const req = verifier.addRequirement("Test")
			const result = verifier.verifyRequirement(req.id, "code-review", "Code reviewed and approved")
			expect(result).toBe(true)

			const updated = verifier.getAllRequirements()[0]
			expect(updated.status).toBe("verified")
			expect(updated.verifiedBy).toBe("code-review")
			expect(updated.evidence).toBe("Code reviewed and approved")
			expect(updated.verifiedAt).toBeGreaterThan(0)
		})

		it("should return false for unknown id", () => {
			const result = verifier.verifyRequirement("nonexistent", "manual", "n/a")
			expect(result).toBe(false)
		})
	})

	describe("failRequirement", () => {
		it("should mark requirement as failed with evidence", () => {
			const req = verifier.addRequirement("Test")
			const result = verifier.failRequirement(req.id, "Build failed")
			expect(result).toBe(true)

			const updated = verifier.getAllRequirements()[0]
			expect(updated.status).toBe("failed")
			expect(updated.evidence).toBe("Build failed")
		})

		it("should return false for unknown id", () => {
			const result = verifier.failRequirement("nonexistent", "n/a")
			expect(result).toBe(false)
		})
	})

	describe("getAllRequirements", () => {
		it("should return all requirements", () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			expect(verifier.getAllRequirements()).toHaveLength(2)
		})

		it("should return empty array when no requirements", () => {
			expect(verifier.getAllRequirements()).toHaveLength(0)
		})
	})

	describe("getRequirementsByStatus", () => {
		it("should filter by status", () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			verifier.verifyRequirement(r1.id, "manual", "done")

			const verified = verifier.getRequirementsByStatus("verified")
			const pending = verifier.getRequirementsByStatus("pending")

			expect(verified).toHaveLength(1)
			expect(verified[0].text).toBe("Req 1")
			expect(pending).toHaveLength(1)
			expect(pending[0].text).toBe("Req 2")
		})

		it("should filter superseded requirements", () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")

			// Manually supersede one
			const all = verifier.getAllRequirements()
			all[0].status = "superseded"

			const superseded = verifier.getRequirementsByStatus("superseded")
			expect(superseded).toHaveLength(1)
			expect(superseded[0].text).toBe("Req 1")
		})
	})

	describe("getActiveRequirements", () => {
		it("should return only non-superseded requirements", () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")

			// Manually supersede r1
			r1.status = "superseded"

			const active = verifier.getActiveRequirements()
			expect(active).toHaveLength(1)
			expect(active[0].text).toBe("Req 2")
		})

		it("should return all when none superseded", () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")

			const active = verifier.getActiveRequirements()
			expect(active).toHaveLength(2)
		})
	})

	describe("verify", () => {
		it("should return passed=true when no requirements", async () => {
			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.total).toBe(0)
			expect(result.summary).toBe("No requirements extracted")
		})

		it("should return passed=true when all verified", async () => {
			const r1 = verifier.addRequirement("Req 1")
			const r2 = verifier.addRequirement("Req 2")
			verifier.verifyRequirement(r1.id, "test", "Tests pass")
			verifier.verifyRequirement(r2.id, "code-review", "Reviewed")

			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.total).toBe(2)
			expect(result.verified).toHaveLength(2)
			expect(result.failed).toHaveLength(0)
			expect(result.pending).toHaveLength(0)
		})

		it("should return passed=false when any active requirement failed", async () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.failRequirement(r1.id, "Failed")

			const result = await verifier.verify()
			expect(result.passed).toBe(false)
			expect(result.total).toBe(1)
			expect(result.failed).toHaveLength(1)
			expect(result.summary).toContain("requirements failed")
		})

		it("should return passed=false when pending and requireAllVerified=true", async () => {
			verifier.addRequirement("Req 1")

			const result = await verifier.verify()
			expect(result.passed).toBe(false)
			expect(result.pending).toHaveLength(1)
		})

		it("should return passed=true when pending and requireAllVerified=false", async () => {
			verifier.updateConfig({ requireAllVerified: false })
			verifier.addRequirement("Req 1")

			const result = await verifier.verify()
			expect(result.passed).toBe(true)
			expect(result.pending).toHaveLength(1)
		})

		it("should ignore superseded requirements in verification", async () => {
			const r1 = verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")

			// Supersede r1 — it should not block completion
			r1.status = "superseded"

			const result = await verifier.verify()
			expect(result.passed).toBe(false) // Req 2 is still pending
			expect(result.total).toBe(2) // Total includes superseded
			expect(result.pending).toHaveLength(1) // Only Req 2 is pending
		})

		it("should pass when only superseded requirements remain unverified", async () => {
			const r1 = verifier.addRequirement("Req 1")
			r1.status = "superseded"

			const result = await verifier.verify()
			expect(result.passed).toBe(true) // No active requirements
			expect(result.total).toBe(1)
			expect(result.verified).toHaveLength(0)
			expect(result.pending).toHaveLength(0)
		})
	})

	describe("processUserMessages", () => {
		it("should extract requirements from a single message", async () => {
			const messages = ["- Build authentication"]
			const reqs = await verifier.processUserMessages(messages)
			expect(reqs).toHaveLength(1)
			expect(reqs[0].text).toBe("Build authentication")
			expect(reqs[0].messageIndex).toBe(0)
		})

		it("should accumulate requirements across multiple messages", async () => {
			const messages = [
				"- Build authentication",
				"- Add logging",
			]
			const reqs = await verifier.processUserMessages(messages)
			expect(reqs).toHaveLength(2)
			expect(reqs[0].text).toBe("Build authentication")
			expect(reqs[0].messageIndex).toBe(0)
			expect(reqs[1].text).toBe("Add logging")
			expect(reqs[1].messageIndex).toBe(1)
		})

		it("should supersede earlier requirement when later message overlaps", async () => {
			const messages = [
				"- Build authentication with JWT",
				"- Build authentication with OAuth",
			]
			const reqs = await verifier.processUserMessages(messages)
			expect(reqs).toHaveLength(2)

			// First requirement should be superseded
			expect(reqs[0].status).toBe("superseded")
			expect(reqs[0].supersededBy).toBe(reqs[1].id)

			// Second requirement should be active and reference the superseded one
			expect(reqs[1].status).toBe("pending")
			expect(reqs[1].supersedes).toBe(reqs[0].id)
		})

		it("should NOT supersede when topics are different", async () => {
			const messages = [
				"- Build authentication with JWT",
				"- Add database schema for users",
			]
			const reqs = await verifier.processUserMessages(messages)
			expect(reqs).toHaveLength(2)

			// Both should remain active (different topics)
			expect(reqs[0].status).toBe("pending")
			expect(reqs[1].status).toBe("pending")
			expect(reqs[0].supersededBy).toBeUndefined()
			expect(reqs[1].supersedes).toBeUndefined()
		})

		it("should handle explicit supersede keywords", async () => {
			const messages = [
				"- Build authentication with JWT bearer tokens",
				"Actually, use OAuth bearer tokens for authentication instead of JWT",
			]
			const reqs = await verifier.processUserMessages(messages)
			expect(reqs).toHaveLength(2)

			// First should be superseded due to semantic overlap
			expect(reqs[0].status).toBe("superseded")
			expect(reqs[1].status).toBe("pending")
		})

		it("should return empty array for empty messages", async () => {
			const reqs = await verifier.processUserMessages([])
			expect(reqs).toHaveLength(0)
		})

		it("should only process new messages on subsequent calls", async () => {
			// First call
			const reqs1 = await verifier.processUserMessages(["- Build authentication"])
			expect(reqs1).toHaveLength(1)
			expect(verifier.getProcessedMessageCount()).toBe(1)

			// Second call with same messages — should not re-process
			const reqs2 = await verifier.processUserMessages(["- Build authentication"])
			expect(reqs2).toHaveLength(1)
			expect(verifier.getProcessedMessageCount()).toBe(1)

			// Third call with new messages appended
			const reqs3 = await verifier.processUserMessages([
				"- Build authentication",
				"- Add logging",
			])
			expect(reqs3).toHaveLength(2)
			expect(verifier.getProcessedMessageCount()).toBe(2)
		})

		it("should supersede across multiple batches", async () => {
			// First batch
			await verifier.processUserMessages(["- Build authentication with JWT tokens"])
			expect(verifier.getProcessedMessageCount()).toBe(1)

			// Second batch — pass full accumulated list so new message is detected
			const reqs = await verifier.processUserMessages([
				"- Build authentication with JWT tokens",
				"- Build authentication with OAuth tokens",
			])
			expect(reqs).toHaveLength(2)
			expect(verifier.getProcessedMessageCount()).toBe(2)

			// First requirement should be superseded
			expect(reqs[0].status).toBe("superseded")
			expect(reqs[1].status).toBe("pending")
		})
	})

	describe("getProcessedMessageCount", () => {
		it("should start at 0", () => {
			expect(verifier.getProcessedMessageCount()).toBe(0)
		})

		it("should increment after processing messages", async () => {
			await verifier.processUserMessages(["- Req 1", "- Req 2"])
			expect(verifier.getProcessedMessageCount()).toBe(2)
		})
	})

	describe("reset", () => {
		it("should clear all requirements and message count", async () => {
			verifier.addRequirement("Req 1")
			verifier.addRequirement("Req 2")
			await verifier.processUserMessages(["- Req 3"])
			expect(verifier.getAllRequirements()).toHaveLength(3)
			expect(verifier.getProcessedMessageCount()).toBe(1)

			verifier.reset()
			expect(verifier.getAllRequirements()).toHaveLength(0)
			expect(verifier.getProcessedMessageCount()).toBe(0)
		})
	})
})

describe("KeywordConflictResolver", () => {
	let resolver: KeywordConflictResolver

	beforeEach(() => {
		resolver = new KeywordConflictResolver()
	})

	it("should have name 'keyword'", () => {
		expect(resolver.name).toBe("keyword")
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
		expect(result.confidence).toBe(0.9)
	})

	it("should detect overlapping requirements", async () => {
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
		const result = await resolver.resolve(newReq, existing, 1, [])
		expect(result.supersedes).toEqual(["existing-1"])
		expect(result.confidence).toBe(0.6)
	})

	it("should NOT detect overlap for different topics", async () => {
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
			text: "Add database schema for users",
			category: "functional",
			status: "pending",
			messageIndex: 1,
		}
		const result = await resolver.resolve(newReq, existing, 1, [])
		expect(result.supersedes).toEqual([])
		expect(result.confidence).toBe(0.9)
	})

	it("should handle multiple existing requirements", async () => {
		const existing: Requirement[] = [
			{
				id: "existing-1",
				text: "Build authentication with JWT",
				category: "functional",
				status: "pending",
				messageIndex: 0,
			},
			{
				id: "existing-2",
				text: "Add database schema",
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
		expect(result.supersedes).toEqual(["existing-1"])
		expect(result.supersedes).not.toContain("existing-2")
	})
})

