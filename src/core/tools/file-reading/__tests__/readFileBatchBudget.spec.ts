import { getReadFileBatchBudget, MAX_READ_FILES_RESULT_BYTES } from "../readFileBatchBudget"
import { ReadFileBatchOutput } from "../readFileBatchOutput"
import { clipUtf8 } from "../clipUtf8"

describe("file-reading batch result budget", () => {
	it("accounts for context, output reserve, pending results and the existing safety margin", () => {
		expect(
			getReadFileBatchBudget({
				contextWindow: 10000,
				contextTokens: 3000,
				reservedOutputTokens: 2000,
				pendingBytes: 500,
			}),
		).toBe(3500)
		expect(getReadFileBatchBudget({ contextWindow: 10000, contextTokens: 10000, reservedOutputTokens: 2000 })).toBe(
			0,
		)
		expect(getReadFileBatchBudget({ contextWindow: 1000000, contextTokens: 0, reservedOutputTokens: 1000 })).toBe(
			MAX_READ_FILES_RESULT_BYTES,
		)
	})
	it.each([NaN, Infinity, -1])("fails closed for invalid windows (%s)", (contextWindow) => {
		expect(getReadFileBatchBudget({ contextWindow, contextTokens: 0, reservedOutputTokens: 1000 })).toBe(0)
	})
	it("clips UTF-8 without replacement characters", () => {
		expect(clipUtf8("a🔥b", 4)).toBe("a")
		expect(clipUtf8("a🔥b", 5)).toBe("a🔥")
	})
	it("clips on complete lines and tells the model the first undelivered line", () => {
		const output = new ReadFileBatchOutput(2500, 1)
		output.add(
			{ path: "a.ts", offset: 40 },
			{
				path: "a.ts",
				status: "approved",
				nativeContent: `File: a.ts\n40 | ${"x".repeat(800)}\n41 | ${"y".repeat(800)}`,
			},
		)
		const result = output.toString()
		expect(result).toContain("40 | ")
		expect(result).not.toContain("41 | ")
		expect(result).toContain("offset=41")
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2500)
	})
	it("does not fabricate a next line when no complete line fits", () => {
		const output = new ReadFileBatchOutput(1500, 1)
		output.add(
			{ path: "a.ts", offset: 80 },
			{ path: "a.ts", status: "approved", nativeContent: `File: a.ts\n80 | ${"x".repeat(2000)}` },
		)
		expect(output.toString()).toContain("offset=80")
		expect(output.toString()).not.toContain("80 |")
	})
	it("bounds metadata, errors, feedback and pathological paths as well as file text", () => {
		const output = new ReadFileBatchOutput(MAX_READ_FILES_RESULT_BYTES, 10)
		for (let i = 0; i < 10; i++)
			output.add(
				{ path: "🔥\n".repeat(300) },
				{ path: "a", status: "error", error: "e".repeat(100000), feedbackText: "f".repeat(100000) },
			)
		expect(Buffer.byteLength(output.toString())).toBeLessThanOrEqual(MAX_READ_FILES_RESULT_BYTES)
		expect(output.toString().match(/Entry \d+:/g)).toHaveLength(10)
	})
	it("replaces the reader's full-range warning with continuation for delivered lines", () => {
		const output = new ReadFileBatchOutput(5000, 1)
		output.add(
			{ path: "a.ts", offset: 40 },
			{
				path: "a.ts",
				status: "approved",
				nativeContent:
					"File: a.ts\nIMPORTANT: File content truncated.\n\tStatus: Showing lines 40-41 of 100 total lines.\n\tTo read more: Use the read_file tool with offset=42 and limit=2.\n\t\n\t40 | first\n41 | second",
			},
		)
		const result = output.toString()
		expect(result).toContain("Status: truncated")
		expect(result).toContain("40 | first\n41 | second")
		expect(result).toContain("offset=42")
		expect(result).not.toContain("Showing lines")
	})
	it("keeps errors higher priority than clipping while retaining the clipping notice", () => {
		const output = new ReadFileBatchOutput(5000, 1)
		output.add(
			{ path: "a" },
			{ path: "a", status: "approved", nativeContent: "File: a\nError: invalid range", longLinesTruncated: true },
		)
		expect(output.toString()).toContain("Status: error")
		expect(output.toString()).toContain("Long lines clipped")
	})
	it("shares unused allowance with later entries and preserves stable result order", () => {
		const output = new ReadFileBatchOutput(5000, 2)
		expect(output.contentAllowance).toBe(1348)
		output.add({ path: "a" }, { path: "a", status: "approved", nativeContent: "File: a\n1 | first" })
		expect(output.contentAllowance).toBe(2687)
		output.add({ path: "b" }, { path: "b", status: "denied", feedbackText: "do not read" })
		expect(output.toString()).toBe(
			'Batch read: 2 entries; result budget 5000 bytes.\nEntry 1: "a"\nStatus: success\n1 | first\n\n---\n\nEntry 2: "b"\nStatus: denied\nUser feedback: do not read',
		)
	})
	it("reports every entry even when only a content-free status manifest fits", () => {
		const output = new ReadFileBatchOutput(0, 2)
		output.add({ path: "a" }, { path: "a", status: "budget_exhausted" })
		output.add({ path: "b" }, { path: "b", status: "cancelled" })
		expect(output.toString()).toContain("Insufficient context for file content")
		expect(output.toString()).toMatch(
			/Entry 1:[\s\S]*Status: budget_exhausted[\s\S]*Entry 2:[\s\S]*Status: cancelled/,
		)
	})

	it("has no content allowance after all declared entries are complete", () => {
		const output = new ReadFileBatchOutput(5000, 1)
		output.add({ path: "a" }, { path: "a", status: "approved", nativeContent: "File: a\n1 | content" })
		expect(output.contentAllowance).toBe(0)
	})
})
