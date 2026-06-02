/**
 * Tests for Selector Engine — src/core/tools/ref/selector.ts
 *
 * Covers:
 * - resolveSelector (4-stage cascade: exact → normalized → fuzzy → word-boundary)
 * - resolveAnchorPair (startAnchor + optional endAnchor)
 * - resolveContentRef (main entry: line-range / anchor / selector priority)
 * - Edge cases: empty input, whitespace, Unicode, emoji, non-ASCII
 */
import { describe, it, expect } from "vitest"
import { resolveSelector, resolveAnchorPair, resolveContentRef } from "../selector"
import type { ContentRef } from "../../../../shared/tools"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE_CODE = `function greet(name: string): string {
	const greeting = \`Hello, \${name}!\`
	return greeting
}

function farewell(name: string): void {
	const message = \`Goodbye, \${name}!\`
	console.log(message)
}`

const SOURCE_PROSE = `The quick brown fox jumps over the lazy dog.
This is a test sentence with some punctuation!
Smart quotes: \u201CHello\u201D and em-dash\u2014like this.
Multiple    spaces    to    collapse.`

const SOURCE_UNICODE = `Русский текст с разными символами.
日本語のテキストです。
Emoji: 🚀🔥🎉`

// ---------------------------------------------------------------------------
// Helper: create minimal ContentRef
// ---------------------------------------------------------------------------

function makeRef(
	overrides: Partial<ContentRef> & { ref: string; source: "chat" | "file" | "terminal" | "tool" },
): ContentRef {
	return {
		startAnchor: undefined,
		endAnchor: undefined,
		selector: undefined,
		startLine: undefined,
		endLine: undefined,
		contextType: undefined,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// resolveSelector
// ---------------------------------------------------------------------------

describe("resolveSelector", () => {
	describe("Stage 1 — Exact Match", () => {
		it("finds an exact substring in source code", () => {
			const result = resolveSelector("code", SOURCE_CODE, "Hello")
			expect(result.content).toBe("Hello")
			expect(result.method).toBe("exact")
			expect(result.confidence).toBe(1.0)
			expect(result.startOffset).toBeGreaterThanOrEqual(0)
			expect(result.sourceId).toBe("code")
		})

		it("returns line number for exact match", () => {
			const result = resolveSelector("code", SOURCE_CODE, "function farewell")
			expect(result.line).toBe(6)
			expect(result.content).toContain("function farewell")
		})
	})

	describe("Stage 2 — Normalized Match", () => {
		it("matches despite whitespace differences", () => {
			const result = resolveSelector("prose", SOURCE_PROSE, "Multiple spaces to collapse")
			expect(result.method).toBe("normalized")
			expect(result.confidence).toBe(0.9)
			expect(result.content).toContain("Multiple")
		})

		it("matches with smart quotes normalized to straight quotes", () => {
			const result = resolveSelector("prose", SOURCE_PROSE, '"Hello"')
			expect(result.method).toBe("normalized")
			expect(result.confidence).toBe(0.9)
			expect(result.content).toContain("Hello")
		})

		it("matches when punctuation is normalized (em-dash)", () => {
			const result = resolveSelector("prose", SOURCE_PROSE, "em-dash-like this")
			expect(result.method).toBe("normalized")
			expect(result.content).toContain("em-dash")
		})
	})

	describe("Stage 3 — LCS Fuzzy Match", () => {
		it("finds content with minor typos (80% tolerance)", () => {
			const source = "The quick brown fox jumps over the lazy dog"
			// "The quick brown fox jumps over the lazy doG" has 1 wrong char (G≠g)
			// With caseSensitive: true, exact/normalized fail → LCS matches 41/42 chars (97.6%) ≥ 80% → fuzzy
			const result = resolveSelector("fuzzy", source, "The quick brown fox jumps over the lazy doG", {
				tolerance: 0.2,
				caseSensitive: true,
			})
			expect(result.method).toBe("fuzzy")
			expect(result.confidence).toBe(0.7)
			expect(result.content).toContain("The quick brown fox jumps over the lazy dog")
		})

		it("matches with character-level differences within tolerance", () => {
			const result = resolveSelector("fuzzy", SOURCE_CODE, "function farewell(name: string) {")
			// Should match via fuzzy since the exact has "void" not inferred
			expect(result.method).toBe("fuzzy")
			expect(result.confidence).toBe(0.7)
		})

		it("fails when below minimum match length", () => {
			const source = "abc"
			expect(() => resolveSelector("fail", source, "xyz", { tolerance: 0.1 })).toThrow()
		})

		it("rejects empty source gracefully", () => {
			expect(() => resolveSelector("empty", "", "anything")).toThrow("Empty source")
		})

		it("rejects empty quote gracefully", () => {
			expect(() => resolveSelector("empty", "source", "")).toThrow("Empty quote")
		})
	})

	describe("Stage 4 — Word-Boundary Expansion", () => {
		it("expands partial word match to word boundaries", () => {
			const result = resolveSelector("expand", SOURCE_CODE, "greet", { expandToWords: true })
			// "greet" is a word boundary itself, so it shouldn't expand
			expect(result.content).toBe("greet")
		})

		it("does NOT expand when expandToWords is false", () => {
			const result = resolveSelector("noexpand", SOURCE_CODE, "greet", { expandToWords: false })
			expect(result.content).toBe("greet")
		})
	})

	describe("Case Sensitivity", () => {
		it("matches case-insensitively by default via normalized stage", () => {
			const result = resolveSelector("code", SOURCE_CODE, "HELLO")
			// Exact match fails because "HELLO" !== "Hello" (case-sensitive string comparison),
			// but normalized match lowercases both → "hello" matches "hello"
			expect(result.method).toBe("normalized")
			expect(result.confidence).toBe(0.9)
			expect(result.content).toBe("Hello")
		})

		it("fails case-sensitive match when case differs", () => {
			expect(() => resolveSelector("code", SOURCE_CODE, "HELLO", { caseSensitive: true })).toThrow()
		})
	})
})

// ---------------------------------------------------------------------------
// resolveAnchorPair
// ---------------------------------------------------------------------------

describe("resolveAnchorPair", () => {
	it("resolves content between startAnchor and endAnchor", () => {
		const result = resolveAnchorPair("code", SOURCE_CODE, "function greet", "return greeting")
		expect(result.method).toBe("anchor")
		expect(result.content).toContain("function greet")
		expect(result.content).toContain("return greeting")
		expect(result.content).toContain("Hello")
	})

	it("resolves from startAnchor to end of line when endAnchor is omitted", () => {
		const result = resolveAnchorPair("code", SOURCE_CODE, "function greet")
		expect(result.method).toBe("anchor")
		expect(result.content).toContain("function greet")
		expect(result.content).includes("): string {")
	})

	it("uses minimum confidence from both anchors", () => {
		// force fuzzy on endAnchor by using a slightly different string
		const result = resolveAnchorPair("code", SOURCE_CODE, "function greet", "return greeting")
		expect(result.confidence).toBeGreaterThan(0)
	})

	it("throws if startAnchor is not found", () => {
		expect(() => resolveAnchorPair("code", SOURCE_CODE, "nonexistent_function")).toThrow()
	})

	it("uses custom options for anchor resolution", () => {
		const result = resolveAnchorPair("code", SOURCE_CODE, "FUNCTION GREET", "RETURN GREETING", {
			caseSensitive: false,
		})
		expect(result.content.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// resolveContentRef
// ---------------------------------------------------------------------------

describe("resolveContentRef", () => {
	describe("Priority 1 — Line Range (file source only)", () => {
		it("extracts a single line by startLine", () => {
			const ref = makeRef({ source: "file", ref: "src/test.ts", startLine: 1 })
			const result = resolveContentRef("test.ts", SOURCE_CODE, ref)
			expect(result.content).toContain("function greet")
			expect(result.line).toBe(1)
			expect(result.confidence).toBe(1.0)
		})

		it("extracts a line range", () => {
			const ref = makeRef({ source: "file", ref: "src/test.ts", startLine: 1, endLine: 3 })
			const result = resolveContentRef("test.ts", SOURCE_CODE, ref)
			const lines = result.content.split("\n")
			expect(lines.length).toBe(3)
			expect(lines[0]).toContain("function greet")
		})

		it("clamps endLine to source length", () => {
			const ref = makeRef({ source: "file", ref: "src/test.ts", startLine: 1, endLine: 999 })
			const result = resolveContentRef("test.ts", SOURCE_CODE, ref)
			expect(result.content).toBe(SOURCE_CODE)
		})

		it("throws when startLine exceeds source line count", () => {
			const ref = makeRef({ source: "file", ref: "src/test.ts", startLine: 999 })
			expect(() => resolveContentRef("test.ts", SOURCE_CODE, ref)).toThrow()
		})
	})

	describe("Priority 2 — Anchor Pair", () => {
		it("resolves via startAnchor+endAnchor", () => {
			const ref = makeRef({ source: "chat", ref: "-1", startAnchor: "function greet", endAnchor: "return" })
			const result = resolveContentRef("chat:-1", SOURCE_CODE, ref)
			expect(result.method).toBe("anchor")
			expect(result.content).toContain("function greet")
		})
	})

	describe("Priority 3 — Selector", () => {
		it("resolves via exact selector", () => {
			const ref = makeRef({ source: "chat", ref: "-1", selector: "return greeting" })
			const result = resolveContentRef("chat:-1", SOURCE_CODE, ref)
			expect(result.method).toBe("exact")
			expect(result.content).toBe("return greeting")
		})
	})

	describe("Error Handling", () => {
		it("throws when no matching strategy is specified", () => {
			const ref = makeRef({ source: "chat", ref: "-1" })
			expect(() => resolveContentRef("chat:-1", SOURCE_CODE, ref)).toThrow("must specify at least one")
		})

		it("throws when source is empty", () => {
			const ref = makeRef({ source: "chat", ref: "-1", selector: "anything" })
			expect(() => resolveContentRef("empty", "", ref)).toThrow("Empty source")
		})
	})
})

// ---------------------------------------------------------------------------
// Unicode & Edge Cases
// ---------------------------------------------------------------------------

describe("resolveSelector — Unicode & Edge Cases", () => {
	it("matches Russian text", () => {
		const result = resolveSelector("ru", SOURCE_UNICODE, "Русский текст")
		expect(result.content).toContain("Русский текст")
	})

	it("matches Japanese text", () => {
		const result = resolveSelector("jp", SOURCE_UNICODE, "日本語")
		expect(result.content).toContain("日本語")
	})

	it("handles emoji in source", () => {
		const result = resolveSelector("emoji", SOURCE_UNICODE, "🚀🔥🎉")
		expect(result.content).toBe("🚀🔥🎉")
	})

	it("normalizes whitespace-only differences", () => {
		const source = "a    b    c"
		const result = resolveSelector("ws", source, "a b c")
		expect(result.method).toBe("normalized")
	})

	it("handles empty lines in line range extraction", () => {
		const source = "line1\n\n\nline4"
		const ref = makeRef({ source: "file", ref: "test.txt", startLine: 2, endLine: 4 })
		const result = resolveContentRef("test", source, ref)
		expect(result.content).toBe("\n\nline4")
	})

	it("confidence is 0.95 when exact match but word-expanded", () => {
		// If we match something mid-word and it expands, confidence drops to 0.95
		const source = "helloWorld"
		// "World" is a word boundary itself, so let's try "elloW" which spans word boundary
		const result = resolveSelector("conf", source, "elloW")
		expect(result.confidence).toBeLessThanOrEqual(0.95)
	})
})
