import { describe, expect, it } from "vitest"

import {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP,
	ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS,
	ORCHESTRATOR_NESTED_DELEGATION_MARKER,
	ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT,
	ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS,
	ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT,
	ORCHESTRATOR_REPEATED_DELEGATION_MARKER,
	ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT,
	buildOrchestratorNestedChildResumeExpectations,
	buildOrchestratorNestedParentResumeExpectations,
	buildOrchestratorRepeatedResumeExpectations,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
	shouldMatchOrchestratorNestedChildResumeRequest,
	shouldMatchOrchestratorNestedParentResumeRequest,
	shouldMatchOrchestratorRepeatedResumeRequest,
	shouldMatchOrchestratorResumeRequest,
} from "./orchestrator-plan"

describe("orchestrator fan-out delegation plan", () => {
	it("defines the first commit single-round ask/architect/code child sequence", () => {
		expect(ORCHESTRATOR_FAN_OUT_PARENT_PROMPT).toContain("ORCHESTRATOR_SINGLE_ROUND_FAN_OUT")
		expect(ORCHESTRATOR_FAN_OUT_CHILD_STEPS).toEqual([
			expect.objectContaining({
				mode: "ask",
				summary: "Requirement summary: gather requirements for the reporting workflow.",
			}),
			expect.objectContaining({
				mode: "architect",
				summary: "Design summary: outline a minimal fan-in architecture.",
			}),
			expect.objectContaining({
				mode: "code",
				summary: "Implementation summary: implement the delegated workflow skeleton.",
			}),
		])
	})

	it("builds cumulative parent resume expectations for fan-in matching", () => {
		expect(buildOrchestratorResumeExpectations()).toEqual([
			{
				stepIndex: 1,
				requiredSummaries: ["Requirement summary: gather requirements for the reporting workflow."],
				nextMode: "architect",
			},
			{
				stepIndex: 2,
				requiredSummaries: [
					"Requirement summary: gather requirements for the reporting workflow.",
					"Design summary: outline a minimal fan-in architecture.",
				],
				nextMode: "code",
			},
			{
				stepIndex: 3,
				requiredSummaries: [
					"Requirement summary: gather requirements for the reporting workflow.",
					"Design summary: outline a minimal fan-in architecture.",
					"Implementation summary: implement the delegated workflow skeleton.",
				],
				nextMode: undefined,
			},
		])
	})

	it("matches child requests without matching the parent prompt that embeds child markers", () => {
		expect(
			shouldMatchOrchestratorChildRequest(
				"child ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD",
				"ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD",
			),
		).toBe(true)
		expect(
			shouldMatchOrchestratorChildRequest(
				"ORCHESTRATOR_SINGLE_ROUND_FAN_OUT embeds ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD",
				"ORCHESTRATOR_SINGLE_ROUND_REQUIREMENTS_CHILD",
			),
		).toBe(false)
	})

	it("matches parent resume requests only after cumulative child result injection", () => {
		const firstExpectation = buildOrchestratorResumeExpectations()[0]!
		const resumeRequest = `ORCHESTRATOR_SINGLE_ROUND_FAN_OUT completed.\\n\\nResult:\\n${firstExpectation.requiredSummaries[0]}`

		expect(shouldMatchOrchestratorResumeRequest(resumeRequest, firstExpectation.requiredSummaries)).toBe(true)
		expect(
			shouldMatchOrchestratorResumeRequest(
				`ORCHESTRATOR_SINGLE_ROUND_FAN_OUT completed.\\n\\nResult:\\nmissing ${firstExpectation.requiredSummaries[0]}`,
				firstExpectation.requiredSummaries,
			),
		).toBe(false)
		expect(
			shouldMatchOrchestratorResumeRequest(
				"ORCHESTRATOR_SINGLE_ROUND_FAN_OUT without result",
				firstExpectation.requiredSummaries,
			),
		).toBe(false)
	})

	it("keeps the final parent result fan-in explicit and reviewable", () => {
		expect(ORCHESTRATOR_FAN_OUT_FINAL_RESULT).toContain(
			"Requirement summary: gather requirements for the reporting workflow.",
		)
		expect(ORCHESTRATOR_FAN_OUT_FINAL_RESULT).toContain("Design summary: outline a minimal fan-in architecture.")
		expect(ORCHESTRATOR_FAN_OUT_FINAL_RESULT).toContain(
			"Implementation summary: implement the delegated workflow skeleton.",
		)
	})

	it("defines a three-round repeated delegation sequence with ask/architect/code children per round", () => {
		expect(ORCHESTRATOR_REPEATED_DELEGATION_PARENT_PROMPT).toContain(ORCHESTRATOR_REPEATED_DELEGATION_MARKER)
		expect(ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS).toHaveLength(9)
		expect(
			ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(({ round, role, mode }) => ({ round, role, mode })),
		).toEqual([
			{ round: 1, role: "requirements", mode: "ask" },
			{ round: 1, role: "design", mode: "architect" },
			{ round: 1, role: "implementation", mode: "code" },
			{ round: 2, role: "requirements", mode: "ask" },
			{ round: 2, role: "design", mode: "architect" },
			{ round: 2, role: "implementation", mode: "code" },
			{ round: 3, role: "requirements", mode: "ask" },
			{ round: 3, role: "design", mode: "architect" },
			{ round: 3, role: "implementation", mode: "code" },
		])
		expect(ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS[0]?.summary).toBe(
			"Round 1 requirements summary: capture reporting workflow constraints.",
		)
		expect(ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS[8]?.summary).toBe(
			"Round 3 implementation summary: validate repeated delegation convergence.",
		)
	})

	it("builds cumulative repeated delegation resume expectations across all rounds", () => {
		const expectations = buildOrchestratorRepeatedResumeExpectations()

		expect(expectations).toHaveLength(9)
		expect(expectations[0]).toEqual({
			stepIndex: 1,
			requiredSummaries: ["Round 1 requirements summary: capture reporting workflow constraints."],
			nextMode: "architect",
		})
		expect(expectations[2]).toEqual({
			stepIndex: 3,
			requiredSummaries: ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.slice(0, 3).map(({ summary }) => summary),
			nextMode: "ask",
		})
		expect(expectations[8]).toEqual({
			stepIndex: 9,
			requiredSummaries: ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS.map(({ summary }) => summary),
			nextMode: undefined,
		})
	})

	it("matches repeated delegation parent resumes only for cumulative child result injection", () => {
		const expectations = buildOrchestratorRepeatedResumeExpectations()
		const thirdExpectation = expectations[2]!
		const resumeRequest = `${ORCHESTRATOR_REPEATED_DELEGATION_MARKER} completed.\\n\\nResult:\\n${thirdExpectation.requiredSummaries.join(" completed.\\n\\nResult:\\n")}`

		expect(shouldMatchOrchestratorRepeatedResumeRequest(resumeRequest, thirdExpectation.requiredSummaries)).toBe(
			true,
		)
		expect(
			shouldMatchOrchestratorRepeatedResumeRequest(
				`${ORCHESTRATOR_REPEATED_DELEGATION_MARKER} completed.\\n\\nResult:\\nmissing ${thirdExpectation.requiredSummaries[2]}`,
				thirdExpectation.requiredSummaries,
			),
		).toBe(false)
		expect(
			shouldMatchOrchestratorRepeatedResumeRequest(
				"ORCHESTRATOR_SINGLE_ROUND_FAN_OUT completed.\\n\\nResult:\\nRound 1 requirements summary: capture reporting workflow constraints.",
				["Round 1 requirements summary: capture reporting workflow constraints."],
			),
		).toBe(false)
	})

	it("composes a repeated delegation final result with every round and child summary", () => {
		for (const { round, role, summary } of ORCHESTRATOR_REPEATED_DELEGATION_CHILD_STEPS) {
			expect(ORCHESTRATOR_REPEATED_DELEGATION_FINAL_RESULT).toContain(`Round ${round} ${role}: ${summary}`)
		}
	})

	it("defines a nested parent/child orchestrator plan with A/B/C/D roles, modes, and summaries", () => {
		expect(ORCHESTRATOR_NESTED_DELEGATION_PARENT_PROMPT).toContain(ORCHESTRATOR_NESTED_DELEGATION_MARKER)
		expect(ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP).toEqual(
			expect.objectContaining({
				role: "child-orchestrator",
				mode: "orchestrator",
				summary: ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
			}),
		)
		expect(ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS).toEqual([
			expect.objectContaining({
				role: "requirements",
				mode: "ask",
				summary: "Nested requirement summary: capture child orchestrator requirements.",
			}),
			expect.objectContaining({
				role: "implementation",
				mode: "code",
				summary: "Nested implementation summary: produce child orchestrator implementation notes.",
			}),
		])
	})

	it("matches nested child orchestrator resumes only after cumulative C/D result injection", () => {
		const expectations = buildOrchestratorNestedChildResumeExpectations()
		expect(expectations).toEqual([
			{
				stepIndex: 1,
				requiredSummaries: ["Nested requirement summary: capture child orchestrator requirements."],
				nextMode: "code",
			},
			{
				stepIndex: 2,
				requiredSummaries: ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS.map(({ summary }) => summary),
				nextMode: undefined,
			},
		])

		const secondExpectation = expectations[1]!
		const childResumeRequest = `${ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.marker} completed.\\n\\nResult:\\n${secondExpectation.requiredSummaries.join(" completed.\\n\\nResult:\\n")}`

		expect(
			shouldMatchOrchestratorNestedChildResumeRequest(childResumeRequest, secondExpectation.requiredSummaries),
		).toBe(true)
		expect(
			shouldMatchOrchestratorNestedChildResumeRequest(
				`${ORCHESTRATOR_NESTED_DELEGATION_CHILD_ORCHESTRATOR_STEP.marker} completed.\\n\\nResult:\\nmissing ${secondExpectation.requiredSummaries[1]}`,
				secondExpectation.requiredSummaries,
			),
		).toBe(false)
		expect(
			shouldMatchOrchestratorNestedChildResumeRequest(
				`${ORCHESTRATOR_NESTED_DELEGATION_MARKER} completed.\\n\\nResult:\\n${secondExpectation.requiredSummaries[0]}`,
				[secondExpectation.requiredSummaries[0]!],
			),
		).toBe(false)
	})

	it("matches top-level nested parent resumes only after the B nested result", () => {
		const expectations = buildOrchestratorNestedParentResumeExpectations()
		expect(expectations).toEqual([
			{
				stepIndex: 1,
				requiredSummaries: [ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT],
				nextMode: undefined,
			},
		])

		const parentResumeRequest = `${ORCHESTRATOR_NESTED_DELEGATION_MARKER} completed.\\n\\nResult:\\n${ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT}`
		expect(
			shouldMatchOrchestratorNestedParentResumeRequest(parentResumeRequest, [
				ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT,
			]),
		).toBe(true)
		expect(
			shouldMatchOrchestratorNestedParentResumeRequest(
				`${ORCHESTRATOR_NESTED_DELEGATION_MARKER} completed.\\n\\nResult:\\n${ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS[0]!.summary}`,
				[ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT],
			),
		).toBe(false)
	})

	it("composes nested child and final parent results with the nested summaries", () => {
		for (const { summary } of ORCHESTRATOR_NESTED_DELEGATION_GRANDCHILD_STEPS) {
			expect(ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT).toContain(summary)
		}
		expect(ORCHESTRATOR_NESTED_DELEGATION_FINAL_RESULT).toContain(ORCHESTRATOR_NESTED_DELEGATION_CHILD_FINAL_RESULT)
	})
})
