import { describe, it, expect } from "vitest"

import { normalizeString, unescapeHtmlEntities, stripAnsi, truncateTerminalOutput } from "../text-normalization"

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
	})
})
