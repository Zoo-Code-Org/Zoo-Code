import type OpenAI from "openai"
import { apply_diff } from "../apply_diff"

// Helper type to access function tools
type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

// Helper to get function definition from tool
const getFunctionDef = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as FunctionTool).function

// OpenAI types the parameter schema as FunctionParameters (Record<string, unknown>).
// Narrow it with runtime checks instead of assertions so the spec tracks schema changes.
function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error("expected an object value in the apply_diff parameter schema")
	}
	return value as Record<string, unknown>
}

const getDiffParameterDescription = (): string => {
	const parameters = asRecord(getFunctionDef(apply_diff).parameters)
	const properties = asRecord(parameters["properties"])
	const diff = asRecord(properties["diff"])
	const description = diff["description"]
	if (typeof description !== "string") {
		throw new Error("diff parameter must declare a string description")
	}
	return description
}

describe("apply_diff diff parameter description", () => {
	const diffDescription = getDiffParameterDescription()

	it("should require complete, whole lines in the SEARCH block", () => {
		expect(diffDescription).toContain("The SEARCH block must contain complete, whole lines")
	})

	it("should warn that partial-line (substring) matching is not supported", () => {
		expect(diffDescription).toContain("partial-line (substring) matching is not supported")
	})
})
