import { describe, it, expect } from "vitest"

import {
	normalizeString,
	unescapeHtmlEntities,
	stripAnsi,
	truncateTerminalOutput,
	truncateFileOutput,
	ADAPTIVE_FULL_READ_THRESHOLD,
	SLIDING_WINDOW_PREVIEW_LIMIT,
} from "../text-normalization"

describe("Text normalization utilities", () => {
	describe("normalizeString", () => {
		it("normalizes smart quotes by default", () => {
			expect(normalizeString("These are \u201Csmart quotes\u201D and \u2018single quotes\u2019")).toBe(
				"These are \"smart quotes\" and 'single quotes'",
			)
		})

		it("normalizes typographic characters by default", () => {
			expect(normalizeString("This has an em dash \u2014 and ellipsis\u2026")).toBe(
				"This has an em dash - and ellipsis...",
			)
		})

		it("normalizes whitespace by default", () => {
			expect(normalizeString("Multiple   spaces and\t\ttabs")).toBe("Multiple spaces and tabs")
		})

		it("can be configured to skip certain normalizations", () => {
			const input = "Keep \u201Csmart quotes\u201D but normalize   whitespace"
			expect(normalizeString(input, { smartQuotes: false })).toBe(
				"Keep \u201Csmart quotes\u201D but normalize whitespace",
			)
		})

		it("real-world example with mixed characters", () => {
			const input = "Let\u2019s test this\u2014with some \u201Cfancy\u201D punctuation\u2026 and   spaces"
			expect(normalizeString(input)).toBe('Let\'s test this-with some "fancy" punctuation... and spaces')
		})
	})

	describe("unescapeHtmlEntities", () => {
		it("unescapes basic HTML entities", () => {
			expect(unescapeHtmlEntities("&lt;div&gt;Hello&lt;/div&gt;")).toBe("<div>Hello</div>")
		})

		it("unescapes ampersand entity", () => {
			expect(unescapeHtmlEntities("This &amp; that")).toBe("This & that")
		})

		it("unescapes quote entities", () => {
			expect(unescapeHtmlEntities("&quot;quoted&quot; and &#39;single-quoted&#39;")).toBe(
				"\"quoted\" and 'single-quoted'",
			)
		})

		it("unescapes apostrophe entity", () => {
			expect(unescapeHtmlEntities("Don&apos;t worry")).toBe("Don't worry")
		})

		it("handles mixed content with multiple entity types", () => {
			expect(
				unescapeHtmlEntities(
					"&lt;a href=&quot;https://example.com?param1=value&amp;param2=value&quot;&gt;Link&lt;/a&gt;",
				),
			).toBe('<a href="https://example.com?param1=value&param2=value">Link</a>')
		})

		it("handles mixed content with apostrophe entities", () => {
			expect(
				unescapeHtmlEntities(
					"&lt;div&gt;Don&apos;t forget that Tom&amp;Jerry&apos;s show is at 3 o&apos;clock&lt;/div&gt;",
				),
			).toBe("<div>Don't forget that Tom&Jerry's show is at 3 o'clock</div>")
		})

		it("returns original string when no entities are present", () => {
			const original = "Plain text without entities"
			expect(unescapeHtmlEntities(original)).toBe(original)
		})

		it("handles empty or undefined input", () => {
			expect(unescapeHtmlEntities("")).toBe("")
			expect(unescapeHtmlEntities(undefined as unknown as string)).toBe(undefined)
		})

		it("unescapes square bracket entities (numeric)", () => {
			expect(unescapeHtmlEntities("string&#91;&#93;")).toBe("string[]")
			expect(unescapeHtmlEntities("array&#91;0&#93;")).toBe("array[0]")
			expect(unescapeHtmlEntities("matrix&#91;i&#93;&#91;j&#93;")).toBe("matrix[i][j]")
		})

		it("unescapes square bracket entities (named)", () => {
			expect(unescapeHtmlEntities("string&lsqb;&rsqb;")).toBe("string[]")
			expect(unescapeHtmlEntities("array&lsqb;0&rsqb;")).toBe("array[0]")
			expect(unescapeHtmlEntities("matrix&lsqb;i&rsqb;&lsqb;j&rsqb;")).toBe("matrix[i][j]")
		})

		it("handles C# array syntax with escaped square brackets", () => {
			// Test case based on the reported issue
			const input = "string&#91;&#93; myArray = new string&#91;5&#93;;\nmyArray&#91;2&#93; = &quot;hello&quot;;"
			const expected = 'string[] myArray = new string[5];\nmyArray[2] = "hello";'
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})

		it("handles mixed square bracket entities", () => {
			const input = "array&#91;0&rsqb; and &lsqb;1&#93;"
			const expected = "array[0] and [1]"
			expect(unescapeHtmlEntities(input)).toBe(expected)
		})
	})

	describe("stripAnsi", () => {
		it("removes ANSI color and formatting sequences", () => {
			const input = "\u001b[31mRed Error\u001b[0m and \u001b[1mBold Text\u001b[0m"
			expect(stripAnsi(input)).toBe("Red Error and Bold Text")
		})

		it("handles empty or clean strings", () => {
			expect(stripAnsi("")).toBe("")
			expect(stripAnsi("Clean text")).toBe("Clean text")
		})
	})

	describe("truncateTerminalOutput", () => {
		it("leaves output under maxLines unchanged", () => {
			const text = "line 1\nline 2\nline 3"
			expect(truncateTerminalOutput(text, 5)).toBe(text)
		})

		it("truncates output exceeding maxLines preserving head and tail", () => {
			const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
			const text = lines.join("\n")
			const result = truncateTerminalOutput(text, 6)

			expect(result).toContain("[...14 intermediate lines omitted for context conservation...]")
			expect(result.startsWith("line 1\nline 2\nline 3")).toBe(true)
			expect(result.endsWith("line 18\nline 19\nline 20")).toBe(true)
		})

		it("strips ANSI while truncating", () => {
			const lines = Array.from({ length: 10 }, (_, i) => `\u001b[32mline ${i + 1}\u001b[0m`)
			const text = lines.join("\n")
			const result = truncateTerminalOutput(text, 4)

			expect(result).not.toContain("\u001b[32m")
			expect(result).toContain("line 1")
			expect(result).toContain("line 10")
		})

		it("handles Windows CRLF line endings cleanly", () => {
			const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\r\n`)
			const text = lines.join("")
			const result = truncateTerminalOutput(text, 4)

			expect(result).not.toContain("\r")
			expect(result).toContain("line 1")
			expect(result).toContain("line 10")
			expect(result).toContain("[...6 intermediate lines omitted for context conservation...]")
		})

		it("pins critical compiler/test diagnostics when errors occur in the middle slice (Solution 3)", () => {
			const lines = Array.from({ length: 120 }, (_, i) => `Step ${i + 1}: running task...`)
			lines[60] = "FAILED: AssertionError: expected false to be true at OrderService.spec.ts:145"
			lines[61] = "  --> src/core/orders/OrderService.ts:88:12"
			const text = lines.join("\n")
			const result = truncateTerminalOutput(text, 40)

			expect(result).toContain("DIAGNOSTIC / ERROR CAPTURE")
			expect(result).toContain("FAILED: AssertionError: expected false to be true")
			expect(result).toContain("Step 1: running task...")
			expect(result).toContain("Step 120: running task...")
		})
	})

	describe("truncateFileOutput", () => {
		it("returns small file unchanged without truncation", () => {
			const text = "export const a = 1;\nexport const b = 2;"
			const result = truncateFileOutput(text, 100)

			expect(result.wasTruncated).toBe(false)
			expect(result.content).toBe(text)
			expect(result.returnedLines).toBe(2)
			expect(result.omittedLines).toBe(0)
		})

		it("truncates large file preserving head and tail with informative marker", () => {
			const lines = Array.from(
				{ length: 500 },
				(_, i) => `// Line ${i + 1}: export const item${i + 1} = ${i + 1};`,
			)
			const text = lines.join("\n")
			const result = truncateFileOutput(text, 100, 500)

			expect(result.wasTruncated).toBe(true)
			expect(result.returnedLines).toBe(100)
			expect(result.omittedLines).toBe(400)
			expect(result.content).toContain(
				"[...TRUNCATED 400 LINES: Showing first 50 and last 50 lines of 500 total lines",
			)
			expect(result.content).toContain("Line 1:")
			expect(result.content).toContain("Line 50:")
			expect(result.content).toContain("Line 451:")
			expect(result.content).toContain("Line 500:")
		})

		it("supports adaptive 300-line threshold and 200-line preview window (Solution 1)", () => {
			expect(ADAPTIVE_FULL_READ_THRESHOLD).toBe(300)
			expect(SLIDING_WINDOW_PREVIEW_LIMIT).toBe(200)

			const lines = Array.from({ length: 400 }, (_, i) => `// Line ${i + 1}`)
			const result = truncateFileOutput(lines.join("\n"), SLIDING_WINDOW_PREVIEW_LIMIT, 400)

			expect(result.wasTruncated).toBe(true)
			expect(result.returnedLines).toBe(200)
			expect(result.omittedLines).toBe(200)
			expect(result.content).toContain("first 100 and last 100 lines")
		})

		it("folds omitted middle block into semantic symbol skeleton (Solution 2)", () => {
			const lines = Array.from({ length: 450 }, (_, i) => `let local_var_${i} = ${i};`)
			// Insert declarations in middle block (around lines 150-250)
			lines[140] = "export class OrderService {"
			lines[180] = "    async calculateTax(order: Order): Promise<number> {"
			lines[220] = "    async processPayment(details: Payment): Promise<Receipt> {"
			lines[260] = "export function formatReceipt(receipt: Receipt): string {"

			const result = truncateFileOutput(lines.join("\n"), 100, 450)

			expect(result.wasTruncated).toBe(true)
			expect(result.content).toContain("[...SKIPPED 350 LINES: Middle Symbol Skeleton...]")
			expect(result.content).toContain("• Line 141: export class OrderService")
			expect(result.content).toContain("• Line 181: async calculateTax(order: Order): Promise<number>")
			expect(result.content).toContain("• Line 221: async processPayment(details: Payment): Promise<Receipt>")
			expect(result.content).toContain("• Line 261: export function formatReceipt(receipt: Receipt): string")
			expect(result.content).toContain(
				"To inspect any implementation, call read_file with offset=<line> and limit=40",
			)
		})
	})
})
