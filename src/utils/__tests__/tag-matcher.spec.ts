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
