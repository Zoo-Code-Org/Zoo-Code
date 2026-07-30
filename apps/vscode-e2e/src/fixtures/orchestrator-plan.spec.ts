import { describe, expect, it } from "vitest"

import {
	ORCHESTRATOR_FAN_OUT_CHILD_STEPS,
	ORCHESTRATOR_FAN_OUT_FINAL_RESULT,
	ORCHESTRATOR_FAN_OUT_PARENT_PROMPT,
	buildOrchestratorResumeExpectations,
	shouldMatchOrchestratorChildRequest,
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
		const [firstExpectation] = buildOrchestratorResumeExpectations()
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
})
