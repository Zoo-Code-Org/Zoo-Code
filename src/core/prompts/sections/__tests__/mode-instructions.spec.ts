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

		const stepNumbers = Array.from(result.matchAll(/^(\d+)\. /gm), (match) => Number(match[1]))
		expect(stepNumbers).toEqual([1, 2, 3, 4, 5, 6])
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

	it("preserves Ask's external-resource claim when an MCP operation is available", () => {
		const withResourceTool = getBuiltInModeInstructions("ask", getInstructions("ask"), {
			availableToolNames: new Set(["access_mcp_resource"]),
		})
		const withDynamicTool = getBuiltInModeInstructions("ask", getInstructions("ask"), {
			availableToolNames: new Set(["mcp--test-server--search"]),
		})

		expect(withResourceTool).toContain("access external resources")
		expect(withDynamicTool).toContain("access external resources")
	})

	it("leaves other built-in modes unchanged", () => {
		const instructions = getInstructions("code")

		expect(
			getBuiltInModeInstructions("code", instructions, {
				availableToolNames: new Set(),
			}),
		).toBe(instructions)
	})

	it("leaves Architect instructions unchanged when all referenced tools are available", () => {
		const instructions = getInstructions("architect")

		expect(
			getBuiltInModeInstructions("architect", instructions, {
				availableToolNames: new Set(["update_todo_list", "switch_mode", "write_to_file"]),
			}),
		).toBe(instructions)
	})

	it("leaves built-in instructions unchanged when no prompt context is provided", () => {
		const instructions = getInstructions("architect")

		expect(getBuiltInModeInstructions("architect", instructions)).toBe(instructions)
	})
})
