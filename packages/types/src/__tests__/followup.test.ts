import { followUpDataSchema, hasUsableAnswer, suggestionItemSchema, type SuggestionItem } from "../followup.js"

describe("hasUsableAnswer", () => {
	it("accepts a non-blank string answer", () => {
		expect(hasUsableAnswer({ answer: "Yes, proceed" })).toBe(true)
	})

	it("accepts a non-blank answer with surrounding whitespace, including one that also carries a mode", () => {
		const withMode: SuggestionItem = { answer: "  spaced  ", mode: "code" }
		expect(hasUsableAnswer(withMode)).toBe(true)
	})

	it("rejects an empty or whitespace-only answer", () => {
		expect(hasUsableAnswer({ answer: "" })).toBe(false)
		expect(hasUsableAnswer({ answer: "   \n\t " })).toBe(false)
	})

	it("rejects a missing answer (issue #1226)", () => {
		expect(hasUsableAnswer({})).toBe(false)
		expect(hasUsableAnswer({ answer: undefined })).toBe(false)
	})

	it("rejects non-string answers from malformed transport data (issue #1226)", () => {
		expect(hasUsableAnswer({ answer: 42 })).toBe(false)
		expect(hasUsableAnswer({ answer: { mode_slug: "code" } })).toBe(false)
		expect(hasUsableAnswer({ answer: null })).toBe(false)
	})

	it("rejects a null or undefined suggestion item", () => {
		expect(hasUsableAnswer(null)).toBe(false)
		expect(hasUsableAnswer(undefined)).toBe(false)
	})
})

describe("suggestionItemSchema", () => {
	it("accepts a suggestion without an answer (issue #1226)", () => {
		expect(suggestionItemSchema.parse({ mode: "code" })).toEqual({ mode: "code" })
	})

	it("still rejects a non-string answer", () => {
		expect(() => suggestionItemSchema.parse({ answer: 42 })).toThrow()
	})
})

describe("followUpDataSchema", () => {
	it("accepts suggestions with a mix of usable and missing answers (issue #1226)", () => {
		const parsed = followUpDataSchema.parse({
			question: "Pick one?",
			suggest: [{ answer: "Yes" }, { mode: "code" }, { answer: undefined }],
		})

		expect(parsed).toEqual({
			question: "Pick one?",
			suggest: [{ answer: "Yes" }, { mode: "code" }, {}],
		})
	})
})
