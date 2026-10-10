import { ReadFileTextProcessor } from "../ReadFileTextProcessor"

describe("ReadFileTextProcessor", () => {
	let processor: ReadFileTextProcessor

	beforeEach(() => {
		processor = new ReadFileTextProcessor()
	})

	it("keeps 1-based slice offsets and continuation guidance", () => {
		const output = processor.process("first\nsecond\nthird", { path: "a", offset: 2, limit: 1 })
		expect(output).toBe(
			[
				"IMPORTANT: File content truncated.",
				"\tStatus: Showing lines 2-2 of 3 total lines.",
				"\tTo read more: Use the read_file tool with offset=3 and limit=1.",
				"\t",
				"\t2 | second",
			].join("\n"),
		)
		expect(output).toContain("Showing lines 2-2 of 3 total lines")
		expect(output).toContain("offset=3 and limit=1")
		expect(output).toContain("2 | second")
		expect(output).not.toContain("1 | first")
	})

	it("preserves the slice reader's existing representation of an empty source", () => {
		expect(processor.process("", { path: "a" })).toBe("1 | ")
	})

	it("preserves an out-of-range error rather than reporting a nonempty file as empty", () => {
		const output = processor.process("first\nsecond", { path: "a", offset: 50, limit: 1 })
		expect(output).toBe("Error: offset 49 is beyond file end (2 lines)")
	})

	it("uses the anchor and preserves structural range summaries", () => {
		const output = processor.process("function sample() {\n    return 1\n}\nconst tail = 2", {
			path: "a",
			mode: "indentation",
			indentation: { anchor_line: 2, include_header: false },
		})
		expect(output).toContain("function sample()")
		expect(output).toContain("return 1")
		expect(output).toMatch(/Included ranges:|IMPORTANT: File content truncated/)
	})

	it("preserves indentation anchor errors without appending a range summary", () => {
		const output = processor.process("first\nsecond", {
			path: "a",
			mode: "indentation",
			indentation: { anchor_line: 50 },
		})
		expect(output).toBe("Error: anchor_line 50 is out of range (1-2)")
	})

	it("detects long-line clipping only for returned lines", () => {
		const source = "short\n" + "x".repeat(3000)
		expect(processor.hasClippedLines(source, "1 | short")).toBe(false)
		expect(processor.hasClippedLines(source, "2 | xxx...")).toBe(true)
		expect(processor.hasClippedLines(source, "Error: no lines returned")).toBe(false)
		expect(processor.hasClippedLines(source, "3 | missing line")).toBe(false)
	})
})
