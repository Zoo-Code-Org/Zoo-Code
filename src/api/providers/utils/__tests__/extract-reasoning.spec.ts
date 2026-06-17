// npx vitest run api/providers/utils/__tests__/extract-reasoning.spec.ts

import { extractReasoningFromDelta } from "../extract-reasoning"

describe("extractReasoningFromDelta", () => {
	it("returns reasoning_content when present and non-blank", () => {
		expect(extractReasoningFromDelta({ reasoning_content: "thinking..." })).toBe("thinking...")
	})

	it("returns reasoning when reasoning_content is missing", () => {
		expect(extractReasoningFromDelta({ reasoning: "analyzing" })).toBe("analyzing")
	})

	it("prefers reasoning_content over reasoning when both are non-blank", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: "from_content",
				reasoning: "from_reasoning",
			}),
		).toBe("from_content")
	})

	it("falls back to reasoning when reasoning_content is null on the same delta", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: null,
				reasoning: "fallback",
			}),
		).toBe("fallback")
	})

	it("falls back to reasoning when reasoning_content is empty string", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: "",
				reasoning: "fallback",
			}),
		).toBe("fallback")
	})

	it("preserves whitespace-only payloads so streamed chunks keep word and paragraph boundaries", () => {
		expect(extractReasoningFromDelta({ reasoning_content: " " })).toBe(" ")
		expect(extractReasoningFromDelta({ reasoning: "\n\n" })).toBe("\n\n")
	})

	it("falls back to reasoning when reasoning_content is an empty string but does not skip whitespace", () => {
		expect(
			extractReasoningFromDelta({
				reasoning_content: "",
				reasoning: "\n\n",
			}),
		).toBe("\n\n")
	})

	it("returns undefined when neither field is present", () => {
		expect(extractReasoningFromDelta({ content: "hi" })).toBeUndefined()
	})

	it("returns undefined for nullish input", () => {
		expect(extractReasoningFromDelta(null)).toBeUndefined()
		expect(extractReasoningFromDelta(undefined)).toBeUndefined()
	})
})
