import { getObjectiveSection } from "../objective"
import type { EffectiveToolPolicy } from "../../tools/effective-tool-policy"

/** Build a policy advertising `tools` as logically available. */
function policyFor(tools: string[]): EffectiveToolPolicy {
	return {
		tools: new Set(tools),
		hasMcpGroup: false,
		hasMcpTools: false,
		hasMcpResources: false,
	}
}

describe("getObjectiveSection", () => {
	it("should include proper numbered structure", () => {
		const objective = getObjectiveSection(policyFor([]))

		// Check that all numbered items are present
		expect(objective).toContain("1. Analyze the user's task")
		expect(objective).toContain("2. Work through these goals sequentially")
		expect(objective).toContain("3. Remember, use the tools provided to you")
		expect(objective).toContain("4. Once you've completed the user's task")
		expect(objective).toContain("5. The user may provide feedback")
	})

	it("should include analysis guidance", () => {
		const objective = getObjectiveSection(policyFor(["read_file"]))

		expect(objective).toContain("Before calling a tool, do some analysis")
		expect(objective).toContain("analyze the file structure provided in environment_details")
		expect(objective).toContain("think about which of the provided tools is the most relevant")
	})

	it("should include parameter inference guidance", () => {
		const objective = getObjectiveSection(policyFor(["ask_followup_question"]))

		expect(objective).toContain("Go through each of the required parameters")
		expect(objective).toContain(
			"determine if the user has directly provided or given enough information to infer a value",
		)
		expect(objective).toContain("DO NOT invoke the tool (not even with fillers for the missing params)")
		expect(objective).toContain("ask_followup_question tool")
	})

	it("should include guidance about not engaging in back and forth conversations", () => {
		const objective = getObjectiveSection(policyFor([]))

		expect(objective).toContain("DO NOT continue in pointless back and forth conversations")
		expect(objective).toContain("don't end your responses with questions or offers for further assistance")
	})

	it("should include the OBJECTIVE header", () => {
		const objective = getObjectiveSection(policyFor([]))

		expect(objective).toContain("OBJECTIVE")
		expect(objective).toContain("You accomplish a given task iteratively")
	})

	it("drops the broad-tool claim under a zero-clause policy", () => {
		// Regression guard: step 3 must not claim "extensive capabilities" or a
		// "wide range of tools" when the policy advertises no tool clauses at all.
		const objective = getObjectiveSection(policyFor([]))

		expect(objective).not.toContain("extensive capabilities")
		expect(objective).not.toContain("wide range of tools")
	})

	it("replaces the ask step with best-effort phrasing when ask_followup_question is absent", () => {
		const objective = getObjectiveSection(policyFor([]))

		// Exact substring of the false branch, which no other test asserts.
		expect(objective).toContain("state your assumptions and proceed with the best available value")
		expect(objective).not.toContain("ask_followup_question tool")
	})

	it("still names attempt_completion unconditionally when the tool is not advertised", () => {
		// Step 4 names attempt_completion, a protocol tool, so the wording is emitted
		// even when the policy's tools set does not include it. The local policyFor builds
		// the policy object directly (no resolver), so policyFor([]) provably excludes
		// attempt_completion.
		const policy = policyFor([])

		expect(policy.tools.has("attempt_completion")).toBe(false)
		expect(getObjectiveSection(policy)).toContain(
			"you must use the attempt_completion tool to present the result of the task to the user",
		)
	})
})
