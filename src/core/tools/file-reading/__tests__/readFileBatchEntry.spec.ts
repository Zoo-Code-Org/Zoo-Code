import { formatReadFileBatchEntry } from "../readFileBatchEntry"

describe("pure file-reading batch entry formatting", () => {
	it("accounts for UTF-8 content bytes independently from reserved metadata", () => {
		const result = formatReadFileBatchEntry(
			{ path: "a" },
			{
				path: "a",
				status: "approved",
				nativeContent: "File: a\n1 | 🔥",
				feedbackText: "feedback",
			},
			3,
			1000,
		)
		expect(result.contentBytes).toBe(Buffer.byteLength("1 | 🔥"))
		expect(result.section).toBe('Entry 3: "a"\nStatus: success\n1 | 🔥\nUser feedback: feedback')
	})

	it("uses the requested anchor when a structural result cannot fit a full line", () => {
		const entry = { path: "a", mode: "indentation" as const, indentation: { anchor_line: 42 } }
		const result = formatReadFileBatchEntry(
			entry,
			{ path: "a", status: "approved", nativeContent: `File: a\n42 | ${"x".repeat(1000)}` },
			1,
			100,
		)
		expect(result.contentBytes).toBe(0)
		expect(result.section).toContain("offset=42")
		expect(result.section).not.toContain("42 |")
	})

	it("prefers the structural anchor over an unrelated slice offset when no line fits", () => {
		const result = formatReadFileBatchEntry(
			{ path: "a", mode: "indentation", offset: 2, indentation: { anchor_line: 42 } },
			{ path: "a", status: "approved", nativeContent: `File: a\n42 | ${"x".repeat(1000)}` },
			1,
			100,
		)
		expect(result.contentBytes).toBe(0)
		expect(result.section).toContain("offset=42")
		expect(result.section).not.toContain("offset=2.")
	})

	it("escapes path labels and marks bounded errors and feedback explicitly", () => {
		const result = formatReadFileBatchEntry(
			{ path: "a\nb" },
			{
				path: "a\nb",
				status: "error",
				error: "error ".repeat(100),
				feedbackText: "feedback ".repeat(100),
			},
			1,
			1000,
		)
		expect(result.section).toContain('Entry 1: "a\\nb"')
		expect(result.section).toContain("... (error clipped)")
		expect(result.section).toContain("... (feedback clipped)")
		expect(result.contentBytes).toBeLessThanOrEqual(200)
	})
})
