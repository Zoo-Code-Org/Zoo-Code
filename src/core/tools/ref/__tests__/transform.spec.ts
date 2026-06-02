/**
 * Tests for CRT Transform Engine — src/core/tools/ref/transform.ts
 *
 * Covers:
 * - applyTransform — 4-step pipeline (replace -> prepend -> wrap_with -> append)
 * - applyMultiTransform — per-fragment transform + optional join
 * - Edge cases: empty strings, special characters, multiline content, null/undefined
 */
import { describe, it, expect } from "vitest"
import { applyTransform, applyMultiTransform } from "../transform"
import type { TransformOptions } from "../transform"

// ---------------------------------------------------------------------------
// applyTransform — Single Content Pipeline
// ---------------------------------------------------------------------------

describe("applyTransform", () => {
	// ── Null / Undefined Guard ──────────────────────────────────────────────

	describe("null / undefined guard", () => {
		it("returns content as-is when transform is undefined", () => {
			expect(applyTransform("hello world")).toBe("hello world")
		})

		it("returns content as-is when transform is null", () => {
			expect(applyTransform("hello world", null)).toBe("hello world")
		})

		it("returns content as-is when content is empty string", () => {
			expect(applyTransform("", { prepend: "x" })).toBe("")
		})

		it("returns content as-is when content is empty and transform is null", () => {
			expect(applyTransform("", null)).toBe("")
		})

		it("returns content as-is when content is empty and transform is undefined", () => {
			expect(applyTransform("")).toBe("")
		})
	})

	// ── Step 1: replace ─────────────────────────────────────────────────────

	describe("Step 1 — replace", () => {
		it("replaces a single occurrence of `from` with `to`", () => {
			const result = applyTransform("foo bar baz", {
				replace: { from: "bar", to: "QUX" },
			})
			expect(result).toBe("foo QUX baz")
		})

		it("replaces all occurrences of `from` with `to`", () => {
			const result = applyTransform("a a a", {
				replace: { from: "a", to: "b" },
			})
			expect(result).toBe("b b b")
		})

		it("skips replace when `from` is not found in content", () => {
			const result = applyTransform("hello world", {
				replace: { from: "xyz", to: "ZZZ" },
				prepend: ">> ",
			})
			// replace skipped, prepend still applies
			expect(result).toBe(">> hello world")
		})

		it("skips replace when `from` is empty string", () => {
			const result = applyTransform("hello", {
				replace: { from: "", to: "x" },
			})
			expect(result).toBe("hello")
		})

		it("handles replace with empty `to` (deletion)", () => {
			const result = applyTransform("hello world", {
				replace: { from: "world", to: "" },
			})
			expect(result).toBe("hello ")
		})

		it("skips replace when `replace` is null", () => {
			const result = applyTransform("hello", {
				replace: null,
				prepend: "> ",
			} as TransformOptions)
			expect(result).toBe("> hello")
		})
	})

	// ── Step 2: prepend ─────────────────────────────────────────────────────

	describe("Step 2 — prepend", () => {
		it("prepends text before the content", () => {
			const result = applyTransform("world", { prepend: "hello " })
			expect(result).toBe("hello world")
		})

		it("prepends empty string (no-op)", () => {
			const result = applyTransform("content", { prepend: "" })
			expect(result).toBe("content")
		})

		it("prepends null (no-op)", () => {
			const result = applyTransform("content", { prepend: null } as TransformOptions)
			expect(result).toBe("content")
		})
	})

	// ── Step 3: wrap_with ───────────────────────────────────────────────────

	describe("Step 3 — wrap_with", () => {
		it("wraps content when template contains {content} placeholder", () => {
			const result = applyTransform("world", {
				wrap_with: "<tag>{content}</tag>",
			})
			expect(result).toBe("<tag>world</tag>")
		})

		it("appends content to template when {content} placeholder is absent", () => {
			const result = applyTransform("world", {
				wrap_with: "hello ",
			})
			expect(result).toBe("hello world")
		})

		it("replaces {content} placeholder only once", () => {
			const result = applyTransform("inner", {
				wrap_with: "{content} before {content} after",
			})
			// Only the first {content} is replaced by the engine
			expect(result).toBe("inner before {content} after")
		})

		it("handles wrap_with with empty string (no-op)", () => {
			const result = applyTransform("content", { wrap_with: "" })
			expect(result).toBe("content")
		})

		it("handles wrap_with as null (no-op)", () => {
			const result = applyTransform("content", { wrap_with: null } as TransformOptions)
			expect(result).toBe("content")
		})
	})

	// ── Step 4: append ──────────────────────────────────────────────────────

	describe("Step 4 — append", () => {
		it("appends text after the content", () => {
			const result = applyTransform("hello", { append: " world" })
			expect(result).toBe("hello world")
		})

		it("appends empty string (no-op)", () => {
			const result = applyTransform("content", { append: "" })
			expect(result).toBe("content")
		})

		it("appends null (no-op)", () => {
			const result = applyTransform("content", { append: null } as TransformOptions)
			expect(result).toBe("content")
		})
	})

	// ── Full Pipeline ───────────────────────────────────────────────────────

	describe("full pipeline — step order: replace → prepend → wrap_with → append", () => {
		it("applies all 4 steps in the correct order", () => {
			const result = applyTransform("world", {
				replace: { from: "world", to: "USER" },
				prepend: "Hello, ",
				wrap_with: "{content}!",
				append: " Have a nice day.",
			})
			// 1. replace: "world" → "USER"
			// 2. prepend: "Hello, USER"
			// 3. wrap_with: "{content}!" → "Hello, USER!"
			// 4. append: "Hello, USER! Have a nice day."
			expect(result).toBe("Hello, USER! Have a nice day.")
		})

		it("pipeline works when only some steps are provided", () => {
			const result = applyTransform("test", {
				replace: { from: "test", to: "demo" },
				append: "!",
			})
			expect(result).toBe("demo!")
		})

		it("pipeline order: prepend is applied before wrap_with", () => {
			const result = applyTransform("content", {
				prepend: "PRE-",
				wrap_with: "[{content}]",
			})
			// 1. prepend: "PRE-content"
			// 2. wrap_with: "[PRE-content]"
			expect(result).toBe("[PRE-content]")
		})

		it("pipeline order: replace is applied before prepend", () => {
			const result = applyTransform("foo", {
				replace: { from: "foo", to: "bar" },
				prepend: "baz",
			})
			// 1. replace: "bar"
			// 2. prepend: "bazbar"
			expect(result).toBe("bazbar")
		})
	})

	// ── Special Characters ──────────────────────────────────────────────────

	describe("special characters", () => {
		it("handles special regex characters in replace.from (treated as literal)", () => {
			const result = applyTransform("price: $10.00", {
				replace: { from: "$10.00", to: "$20.00" },
			})
			// Uses split/join — literal match, not regex
			expect(result).toBe("price: $20.00")
		})

		it("handles Unicode characters", () => {
			const result = applyTransform("Привет, мир!", {
				replace: { from: "мир", to: "Мир" },
				prepend: "🌟 ",
				append: " 🌟",
			})
			expect(result).toBe("🌟 Привет, Мир! 🌟")
		})

		it("handles HTML-like content", () => {
			const result = applyTransform("<div>content</div>", {
				wrap_with: "<section>{content}</section>",
			})
			expect(result).toBe("<section><div>content</div></section>")
		})
	})

	// ── Multiline Content ───────────────────────────────────────────────────

	describe("multiline content", () => {
		const multiline = "line1\nline2\nline3"

		it("replaces across lines", () => {
			const result = applyTransform(multiline, {
				replace: { from: "line2", to: "LINE2" },
			})
			expect(result).toBe("line1\nLINE2\nline3")
		})

		it("prepends to multiline content", () => {
			const result = applyTransform(multiline, { prepend: "START\n" })
			expect(result).toBe("START\nline1\nline2\nline3")
		})

		it("appends to multiline content", () => {
			const result = applyTransform(multiline, { append: "\nEND" })
			expect(result).toBe("line1\nline2\nline3\nEND")
		})

		it("wraps multiline content with template", () => {
			const result = applyTransform(multiline, {
				wrap_with: "```\n{content}\n```",
			})
			expect(result).toBe("```\nline1\nline2\nline3\n```")
		})
	})
})

// ---------------------------------------------------------------------------
// applyMultiTransform — Multiple Content Fragments
// ---------------------------------------------------------------------------

describe("applyMultiTransform", () => {
	// ── Null / Undefined Guard ──────────────────────────────────────────────

	describe("null / undefined guard", () => {
		it("returns contents as-is when transform is undefined", () => {
			expect(applyMultiTransform(["a", "b"])).toEqual({ contents: ["a", "b"] })
		})

		it("returns contents as-is when transform is null", () => {
			expect(applyMultiTransform(["a", "b"], null)).toEqual({ contents: ["a", "b"] })
		})

		it("returns contents as-is when contents array is empty", () => {
			expect(applyMultiTransform([], { prepend: "x" })).toEqual({ contents: [] })
		})
	})

	// ── Per-fragment Transform ──────────────────────────────────────────────

	describe("per-fragment transform", () => {
		it("applies transform to each fragment independently", () => {
			const result = applyMultiTransform(["a", "b", "c"], {
				prepend: "> ",
			})
			expect(result.contents).toEqual(["> a", "> b", "> c"])
		})

		it("replaces in each fragment independently", () => {
			const result = applyMultiTransform(["x-foo", "y-foo", "z-foo"], {
				replace: { from: "foo", to: "bar" },
			})
			expect(result.contents).toEqual(["x-bar", "y-bar", "z-bar"])
		})

		it("applies full pipeline to each fragment", () => {
			const result = applyMultiTransform(["hello", "world"], {
				replace: { from: "hello", to: "hi" },
				prepend: "<p>",
				append: "</p>",
			})
			expect(result.contents).toEqual(["<p>hi</p>", "<p>world</p>"])
		})

		it("handles mixed empty and non-empty fragments", () => {
			const result = applyMultiTransform(["", "hello", ""], {
				prepend: "> ",
			})
			expect(result.contents).toEqual(["", "> hello", ""])
		})
	})

	// ── join_with ───────────────────────────────────────────────────────────

	describe("join_with", () => {
		it("joins all fragments using join_with separator", () => {
			const result = applyMultiTransform(["a", "b", "c"], {
				prepend: "> ",
				join_with: ", ",
			})
			expect(result.contents).toEqual(["> a", "> b", "> c"])
			expect(result.joined).toBe("> a, > b, > c")
		})

		it("returns undefined joined when join_with is not specified", () => {
			const result = applyMultiTransform(["a", "b"], { prepend: "x" })
			expect(result.joined).toBeUndefined()
			expect(result.contents).toEqual(["xa", "xb"])
		})

		it("handles join_with with empty string (falsy — treated as no join)", () => {
			const result = applyMultiTransform(["a", "b", "c"], {
				join_with: "",
			})
			// join_with "" is falsy, so join is skipped, joined remains undefined
			expect(result.joined).toBeUndefined()
			expect(result.contents).toEqual(["a", "b", "c"])
		})

		it("joins with newline separator", () => {
			const result = applyMultiTransform(["line1", "line2"], {
				join_with: "\n",
			})
			expect(result.joined).toBe("line1\nline2")
		})
	})

	// ── Edge Cases ──────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles empty array without throwing", () => {
			expect(() => applyMultiTransform([])).not.toThrow()
		})

		it("handles single-element array", () => {
			const result = applyMultiTransform(["only"], { append: "!" })
			expect(result.contents).toEqual(["only!"])
			expect(result.joined).toBeUndefined()
		})

		it("handles special characters in fragments", () => {
			const result = applyMultiTransform(["$10", "€20"], {
				prepend: "amount: ",
				join_with: " | ",
			})
			expect(result.joined).toBe("amount: $10 | amount: €20")
		})
	})
})
