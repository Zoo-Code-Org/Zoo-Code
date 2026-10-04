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

const getDiffDescription = (): string => {
	const parameters = asRecord(getFunctionDef(apply_diff).parameters)
	const properties = asRecord(parameters["properties"])
	const diff = asRecord(properties["diff"])
	const description = diff["description"]
	if (typeof description !== "string") {
		throw new Error("diff parameter must declare a string description")
	}
	return description
}

const getRequiredParameters = (): unknown[] => {
	const parameters = asRecord(getFunctionDef(apply_diff).parameters)
	const required = parameters["required"]
	if (!Array.isArray(required)) {
		throw new Error("apply_diff parameters must declare a required array")
	}
	return required
}

describe("apply_diff tool description", () => {
	const description = getFunctionDef(apply_diff).description

	describe("read_file line-number format", () => {
		it("should document line numbers using the actual read_file output format (number, spaces, pipe)", () => {
			// The real format comes from addLineNumbers() in extract-text.ts: "N | content"
			expect(description).toContain("'1 | '")
			expect(description).toContain("'2 | '")
		})

		it("should not describe read_file line numbers with a colon suffix", () => {
			// Regression guard: read_file never outputs "N: " prefixes (extract-text.ts addLineNumbers),
			// and the server-side auto-strip in multi-search-replace.ts only keys on the "N | " pattern.
			expect(description).not.toContain("'1: '")
			expect(description).not.toContain("'2: '")
		})

		it("should instruct the model to strip line numbers from the SEARCH block", () => {
			expect(description).toContain("MUST STRIP all line numbers from the 'SEARCH' block")
		})
	})

	describe("diff parameter description", () => {
		const diffDescription = getDiffDescription()

		it("should use the actual read_file output format in the line-number prohibition bullet", () => {
			expect(diffDescription).toContain("'137 | '")
			expect(diffDescription).not.toContain("'137: '")
		})

		it("should keep the template placeholder free of line numbers", () => {
			expect(diffDescription).toContain("[exact content to find WITHOUT line numbers]")
		})
	})

	describe("schema", () => {
		it("should require path and diff parameters", () => {
			expect(getRequiredParameters()).toEqual(["path", "diff"])
		})
	})
})
