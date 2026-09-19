import { getToolUseGuidelinesSection } from "../tool-use-guidelines"
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

describe("getToolUseGuidelinesSection", () => {
	it("should include proper numbered guidelines", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))

		expect(guidelines).toContain("1. Assess what information")
		expect(guidelines).toContain("2. Choose the most appropriate tool")
		expect(guidelines).toContain("3. If multiple actions are needed")
	})

	it("should include multiple-tools-per-message guidance", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))

		expect(guidelines).toContain("you may use multiple tools in a single message")
		expect(guidelines).not.toContain("use one tool at a time per message")
	})

	it("should use simplified footer without step-by-step language", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))

		expect(guidelines).toContain("carefully considering the user's response after tool executions")
		expect(guidelines).not.toContain("It is crucial to proceed step-by-step")
		expect(guidelines).not.toContain("ALWAYS wait for user confirmation after each tool use")
	})

	it("should include common guidance", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))
		expect(guidelines).toContain("Assess what information you already have")
		expect(guidelines).toContain("Choose the most appropriate tool")
		expect(guidelines).not.toContain("<actual_tool_name>")
	})

	it("should not include per-tool confirmation guidelines", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))

		expect(guidelines).not.toContain("After each tool use, the user will respond with the result")
	})

	it("omits the list_files example when list_files is absent", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor([]))

		expect(guidelines).not.toContain("the list_files tool is more effective than running a command like `ls`")
	})

	it("includes the list_files example verbatim when list_files is present", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor(["list_files"]))

		// Exact substring of the gated example, and of the exact join around it.
		expect(guidelines).toContain(
			"gathering this information. For example using the list_files tool is more effective than running a command like `ls` in the terminal. It's critical",
		)
	})

	it("keeps the false branch empty when the example is omitted", () => {
		const guidelines = getToolUseGuidelinesSection(policyFor([]))

		// Any injected filler in the false branch breaks this exact join.
		expect(guidelines).toContain("gathering this information. It's critical")
	})
})
