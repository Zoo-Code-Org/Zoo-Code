// npx vitest utils/__tests__/tag-matcher.spec.ts

import { TagMatcher } from "../tag-matcher"

describe("TagMatcher", () => {
	describe("collect() chunk merging (line 52)", () => {
		it("merges consecutive same-type chars into one chunk within a single call", () => {
			// Two text chars in one update() → both hit collect() with matched=false
			// second char finds last chunk same type → last.data += char (line 52)
			const matcher = new TagMatcher("think")
			const result = matcher.update("ab")
			expect(result).toEqual([{ matched: false, data: "ab" }])
		})

		it("merges consecutive reasoning chars within a single call", () => {
			const matcher = new TagMatcher("think")
			matcher.update("<think>")
			const result = matcher.update("ab")
			expect(result).toEqual([{ matched: true, data: "ab" }])
		})
	})

	describe("final() with a chunk argument (line 131)", () => {
		it("processes a chunk passed directly to final()", () => {
			// Call final() with a chunk instead of update() — exercises line 131
			const matcher = new TagMatcher("think")
			const result = matcher.final("hello")
			expect(result).toEqual([{ matched: false, data: "hello" }])
		})

		it("processes a closing tag passed to final()", () => {
			const matcher = new TagMatcher("think")
			// Don't use update() — keeps reasoning in the buffer so final() flushes it
			const result = matcher.final("<think>reasoning</think>")
			expect(result.some((r) => r.matched && r.data === "reasoning")).toBe(true)
		})
	})

	describe("space handling in TAG_OPEN (lines 93-97)", () => {
		it("tolerates a space before tag name has started (line 95: all candidates at index 0)", () => {
			// "< think>" — space arrives when all candidates are at index 0
			// hits line 95 (continue), candidates survive, 't' then matches normally
			const matcher = new TagMatcher("think")
			const result = matcher.final("< think>content</think>")
			expect(result.some((r) => r.matched && r.data === "content")).toBe(true)
		})

		it("drops mid-match candidates on a space (line 97)", () => {
			// "<th ink>" — space arrives mid-match (index > 0, index < name.length)
			// those candidates are dropped, tag is not opened
			const matcher = new TagMatcher("think")
			const result = matcher.final("<th ink>content</think>")
			expect(result.every((r) => !r.matched)).toBe(true)
		})
	})

	describe("multi-tag constructor (string[])", () => {
		it("opens and closes <thought> when constructed with array", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<thought>deep reasoning</thought>done")
			expect(result.some((r) => r.matched && r.data === "deep reasoning")).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "done")).toBe(true)
		})

		it("opens and closes <think> when constructed with array", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<think>thinking</think>done")
			expect(result.some((r) => r.matched && r.data === "thinking")).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "done")).toBe(true)
		})

		it("<think> open is not closed by </thought> (cross-tag isolation)", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<think>reasoning</thought>still reasoning</think>done")
			// </thought> must be treated as text since active tag is <think>
			expect(result.some((r) => r.matched && r.data.includes("</thought>"))).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "done")).toBe(true)
		})

		it("<thought> open is not closed by </think> (inverse cross-tag isolation)", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<thought>reasoning</think>still reasoning</thought>done")
			// </think> must be treated as text since active tag is <thought>
			expect(result.some((r) => r.matched && r.data.includes("</think>"))).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "done")).toBe(true)
		})
	})

	describe("chunk split at mid-tag-name boundary", () => {
		it("correctly opens tag split across two update() calls", () => {
			const matcher = new TagMatcher("think")
			const first = matcher.update("<thi")
			// Tag not yet complete — no chunks emitted yet
			expect(first).toEqual([])
			const second = matcher.update("nk>content</think>")
			expect(second.some((r) => r.matched && r.data === "content")).toBe(true)
		})
	})

	describe("unmatched > in TAG_OPEN falls back to TEXT", () => {
		it("treats <xyz> as plain text when xyz is not a configured tag name", () => {
			const matcher = new TagMatcher("think")
			const result = matcher.final("<xyz>content")
			expect(result.every((r) => !r.matched)).toBe(true)
		})

		it("treats stray closing tag as plain text when no tag is open", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("final</think>text")
			expect(result).toEqual([{ matched: false, data: "final</think>text" }])
		})

		it("treats extra closing tag after a closed block as plain text", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<think>thinking</think>final</think>text")
			expect(result.some((r) => r.matched && r.data === "thinking")).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "final</think>text")).toBe(true)
		})
	})

	describe("nested tags", () => {
		it("treats inner <thought> as text when outer <think> is active", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<think>outer<thought>inner</thought> middle</think>final")
			expect(result.some((r) => r.matched && r.data.includes("<thought>inner</thought>"))).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "final")).toBe(true)
		})

		it("correctly unwinds nested same-name tags", () => {
			const matcher = new TagMatcher(["think", "thought"])
			const result = matcher.final("<think>outer<think>inner</think> middle</think>final")
			expect(result.some((r) => r.matched && r.data.includes("<think>inner</think>"))).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "final")).toBe(true)
		})
	})

	describe("space handling in TAG_CLOSE (line 119)", () => {
		it("tolerates a trailing space before > in closing tag (</think >)", () => {
			// space at index === tagName.length hits line 119 (continue)
			const matcher = new TagMatcher("think")
			const result = matcher.final("<think>reasoning</think >after")
			expect(result.some((r) => r.matched && r.data === "reasoning")).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "after")).toBe(true)
		})

		it("tolerates a leading space after </ in closing tag (</ think>)", () => {
			// space at index === 0 hits line 119 (continue)
			const matcher = new TagMatcher("think")
			const result = matcher.final("<think>reasoning</ think>after")
			expect(result.some((r) => r.matched && r.data === "reasoning")).toBe(true)
			expect(result.some((r) => !r.matched && r.data === "after")).toBe(true)
		})
	})
})
