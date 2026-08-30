import { modes } from "../../../../shared/modes"
import { getBuiltInModeInstructions } from "../mode-instructions"

function getInstructions(mode: string): string {
	return modes.find((candidate) => candidate.slug === mode)?.customInstructions ?? ""
}

describe("getBuiltInModeInstructions", () => {
	it("replaces unavailable Architect control tools with supported planning guidance", () => {
		const result = getBuiltInModeInstructions("architect", getInstructions("architect"), {
			availableToolNames: new Set(["read_file", "write_to_file", "ask_followup_question", "attempt_completion"]),
		})

		expect(result).not.toContain("update_todo_list")
		expect(result).not.toContain("switch_mode")
		expect(result).toContain("write the plan to a markdown file")
	})

	it("uses a response plan when Architect has no edit tool", () => {
		const result = getBuiltInModeInstructions("architect", getInstructions("architect"), {
			availableToolNames: new Set(["read_file", "ask_followup_question", "attempt_completion"]),
		})

		expect(result).toContain("present the plan directly in your response")
		expect(result).not.toContain("./plans")
	})

	it("does not treat image generation or replacement-only tools as plan file creation", () => {
		const result = getBuiltInModeInstructions("architect", getInstructions("architect"), {
			availableToolNames: new Set([
				"generate_image",
				"search_replace",
				"ask_followup_question",
				"attempt_completion",
			]),
		})

		expect(result).toContain("present the plan directly in your response")
		expect(result).not.toContain("write the plan to a markdown file")
	})

	it("removes Ask's external-resource claim when no MCP operation is available", () => {
		const result = getBuiltInModeInstructions("ask", getInstructions("ask"), {
			availableToolNames: new Set(["read_file", "ask_followup_question", "attempt_completion"]),
		})

		expect(result).not.toContain("access external resources")
	})
})
