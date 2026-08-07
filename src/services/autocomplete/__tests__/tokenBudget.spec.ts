import { estimateTokens, pruneSnippets, trimToTokenBudget } from "../prompt/tokenBudget"
import type { AutocompleteSnippet } from "../types"

describe("estimateTokens", () => {
	it("returns 0 for empty text", () => {
		expect(estimateTokens("")).toBe(0)
	})

	it("scales with text length", () => {
		expect(estimateTokens("a".repeat(35))).toBeLessThanOrEqual(estimateTokens("a".repeat(70)))
	})
})

describe("trimToTokenBudget", () => {
	it("returns the full text when under budget", () => {
		expect(trimToTokenBudget("hello", 100, "tail")).toBe("hello")
	})

	it("trims from the head for suffixes", () => {
		const text = "0123456789"
		expect(trimToTokenBudget(text, 1, "head")).toBe("0123")
	})

	it("trims from the tail for prefixes", () => {
		const text = "0123456789"
		expect(trimToTokenBudget(text, 1, "tail")).toBe("6789")
	})

	it("realigns a trimmed prefix to a line boundary", () => {
		// A raw slice opens the prompt mid-token, which reads to the model as a
		// broken identifier rather than the start of a statement.
		const text = "const alpha = 1\nconst beta = 2\nconst gamma = 3"
		const trimmed = trimToTokenBudget(text, 6, "tail")

		expect(trimmed.startsWith("const")).toBe(true)
		expect(text.endsWith(trimmed)).toBe(true)
	})

	it("realigns a trimmed suffix to a line boundary", () => {
		const text = "const alpha = 1\nconst beta = 2\nconst gamma = 3"
		const trimmed = trimToTokenBudget(text, 6, "head")

		expect(trimmed.endsWith("\n")).toBe(true)
		expect(text.startsWith(trimmed)).toBe(true)
	})

	it("never splits a surrogate pair", () => {
		// An orphaned half-pair is an invalid code unit that corrupts the prompt.
		const text = "a".repeat(20) + "😀".repeat(10)
		const head = trimToTokenBudget(text, 5, "head")
		const tail = trimToTokenBudget(text, 5, "tail")

		expect(head).toBe(Array.from(head).join(""))
		expect(tail).toBe(Array.from(tail).join(""))
	})
})

describe("pruneSnippets", () => {
	const snippet = (content: string, filePath = "a.ts"): AutocompleteSnippet => ({
		filePath,
		languageId: "typescript",
		line: 1,
		content,
	})

	it("keeps all snippets when under budget", () => {
		const snippets = [snippet("const a = 1"), snippet("const b = 2")]
		const result = pruneSnippets(snippets, 1000)
		expect(result.snippets).toHaveLength(2)
		expect(result.dropped).toBe(0)
	})

	it("drops snippets from the tail when budget is exceeded", () => {
		const snippets = [snippet("const a = 1"), snippet("const b = 2"), snippet("const c = 3")]
		const result = pruneSnippets(snippets, 10)
		expect(result.dropped).toBeGreaterThan(0)
	})

	it("trims the last-kept snippet's content when partially fitting", () => {
		const big = "x".repeat(200)
		const snippets = [snippet(big)]
		const result = pruneSnippets(snippets, 20)
		expect(result.snippets).toHaveLength(1)
		expect(result.snippets[0].content.length).toBeLessThan(big.length)
	})

	it("returns empty when budget is too small for any snippet", () => {
		const snippets = [snippet("const a = 1")]
		const result = pruneSnippets(snippets, 1)
		expect(result.snippets).toHaveLength(0)
		expect(result.dropped).toBe(1)
	})

	it("preserves arrival order among kept snippets", () => {
		const snippets = [snippet("const a = 1", "a.ts"), snippet("const b = 2", "b.ts")]
		const result = pruneSnippets(snippets, 1000)
		expect(result.snippets.map((s) => s.filePath)).toEqual(["a.ts", "b.ts"])
	})
})
