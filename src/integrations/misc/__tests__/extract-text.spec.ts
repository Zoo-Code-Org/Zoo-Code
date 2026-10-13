import fs from "fs/promises"
import os from "os"
import path from "path"
import * as binaryFile from "isbinaryfile"
import ExcelJS from "exceljs"
import mammoth from "mammoth"
import { DEFAULT_LINE_LIMIT } from "../../../core/prompts/tools/native-tools/read_file"
import {
	addLineNumbers,
	extractTextFromBuffer,
	extractTextFromFile,
	extractTextFromFileWithMetadata,
	getSupportedBinaryFormats,
	everyLineHasLineNumbers,
	stripLineNumbers,
	truncateOutput,
	applyRunLengthEncoding,
	processCarriageReturns,
	processBackspaces,
} from "../extract-text"

const { parsePdf } = vi.hoisted(() => ({
	parsePdf: vi.fn<(source: Buffer) => Promise<{ text: string }>>(),
}))

vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: parsePdf }))

describe("document decoders", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		parsePdf.mockReset()
	})

	it("lists supported document extensions without exposing the decoder registry", () => {
		const formats = getSupportedBinaryFormats()
		expect(formats).toEqual([".pdf", ".docx", ".ipynb", ".xlsx"])
		formats.pop()
		expect(getSupportedBinaryFormats()).toEqual([".pdf", ".docx", ".ipynb", ".xlsx"])
	})

	it.each([
		["first page\nsecond page\n", "1 | first page\n2 | second page\n"],
		["", ""],
	])("formats PDF parser text %j from the exact supplied bytes", async (text, expected) => {
		const source = Buffer.from("%PDF-1.7 approved document bytes")
		parsePdf.mockResolvedValue({ text })
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		expect(await extractTextFromBuffer(source, "missing.PDF")).toBe(expected)
		expect(parsePdf).toHaveBeenCalledExactlyOnceWith(source)
		expect(parsePdf.mock.calls[0][0]).toBe(source)
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it.each([
		["first paragraph\n\nsecond paragraph\n", "1 | first paragraph\n2 | \n3 | second paragraph\n"],
		["", ""],
	])("formats DOCX parser text %j from the exact supplied bytes", async (value, expected) => {
		const source = Buffer.from("PK approved document bytes")
		const parser = vi.spyOn(mammoth, "extractRawText").mockResolvedValue({ value, messages: [] })
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		expect(await extractTextFromBuffer(source, "missing.DOCX")).toBe(expected)
		expect(parser).toHaveBeenCalledExactlyOnceWith({ buffer: source })
		const input = parser.mock.calls[0][0]
		expect("buffer" in input && input.buffer).toBe(source)
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it("propagates PDF parser failures instead of treating document bytes as text", async () => {
		const source = Buffer.from("%PDF corrupted document")
		const failure = new Error("Invalid PDF document")
		parsePdf.mockRejectedValue(failure)
		const probe = vi.spyOn(binaryFile, "isBinaryFile")

		await expect(extractTextFromBuffer(source, "corrupted.pdf")).rejects.toBe(failure)
		expect(parsePdf).toHaveBeenCalledExactlyOnceWith(source)
		expect(probe).not.toHaveBeenCalled()
	})

	it("propagates DOCX parser failures instead of treating document bytes as text", async () => {
		const source = Buffer.from("PK corrupted document")
		const failure = new Error("Invalid DOCX archive")
		const parser = vi.spyOn(mammoth, "extractRawText").mockRejectedValue(failure)
		const probe = vi.spyOn(binaryFile, "isBinaryFile")

		await expect(extractTextFromBuffer(source, "corrupted.docx")).rejects.toBe(failure)
		expect(parser).toHaveBeenCalledExactlyOnceWith({ buffer: source })
		expect(probe).not.toHaveBeenCalled()
	})
})

describe("buffer input", () => {
	afterEach(() => vi.restoreAllMocks())

	it("returns supplied ordinary-text bytes without pathname I/O", async () => {
		const access = vi.spyOn(fs, "access").mockResolvedValue(undefined)
		const readFile = vi.spyOn(fs, "readFile").mockResolvedValue("unapproved disk content")
		const probe = vi.spyOn(binaryFile, "isBinaryFile").mockResolvedValue(false)
		const source = Buffer.from("approved first line\napproved second line")

		const content = await extractTextFromBuffer(source, "metadata-only.txt")

		expect(content).toBe("1 | approved first line\n2 | approved second line")
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
		expect(probe).not.toHaveBeenCalledWith("metadata-only.txt")
	})

	it("preserves empty-text formatting for an empty supplied buffer without pathname I/O", async () => {
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))
		const probe = vi.spyOn(binaryFile, "isBinaryFile")
		const source = Buffer.alloc(0)

		const content = await extractTextFromBuffer(source, "missing.txt")

		expect(content).toBe("1 | ")
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
		expect(probe).not.toHaveBeenCalledWith("missing.txt")
	})

	it("rejects unsupported binary bytes without pathname I/O", async () => {
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))
		const probe = vi.spyOn(binaryFile, "isBinaryFile")
		const source = Buffer.from([0, 1, 2, 0, 255])

		await expect(extractTextFromBuffer(source, "missing.BIN")).rejects.toThrow(
			"Cannot read text for file type: .bin",
		)

		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
		expect(probe).not.toHaveBeenCalledWith("missing.BIN")
	})

	it("falls back to supplied text bytes when binary detection fails", async () => {
		const source = Buffer.from("approved text\nsecond line")
		const probe = vi.spyOn(binaryFile, "isBinaryFile").mockRejectedValue(new Error("Detection failed"))
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		expect(await extractTextFromBuffer(source, "missing.txt")).toBe("1 | approved text\n2 | second line")
		expect(probe).toHaveBeenCalledExactlyOnceWith(source)
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it("decodes notebook bytes with historical line numbering and trailing newline", async () => {
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))
		const source = Buffer.from(
			JSON.stringify({
				cells: [
					{ cell_type: "markdown", source: ["Heading"] },
					{ cell_type: "code", source: ["first", "second"] },
					{ cell_type: "raw", source: ["ignored"] },
				],
			}),
		)

		expect(await extractTextFromBuffer(source, "missing.IPYNB")).toBe("1 | Heading\n2 | first\n3 | second\n")
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it("preserves empty notebook output without pathname I/O", async () => {
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))
		const source = Buffer.from(JSON.stringify({ cells: [] }))

		expect(await extractTextFromBuffer(source, "missing.ipynb")).toBe("")
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})

	it("decodes XLSX bytes and preserves visible-sheet formatting without pathname I/O", async () => {
		const workbook = new ExcelJS.Workbook()
		workbook.addWorksheet("Data").addRow(["approved cell", 42])
		const hidden = workbook.addWorksheet("Hidden", { state: "hidden" })
		hidden.addRow(["hidden cell"])
		const source = Buffer.from(await workbook.xlsx.writeBuffer())
		const access = vi.spyOn(fs, "access").mockRejectedValue(new Error("Unexpected pathname access"))
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected pathname read"))

		expect(await extractTextFromBuffer(source, "missing.XLSX")).toBe("--- Sheet: Data ---\napproved cell\t42")
		expect(access).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})
})

describe("path input", () => {
	afterEach(() => vi.restoreAllMocks())

	it("rejects unsupported binary paths after probing without loading the whole file", async () => {
		vi.spyOn(fs, "access").mockResolvedValue(undefined)
		const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Unexpected whole-file read"))
		const probe = vi.spyOn(binaryFile, "isBinaryFile").mockResolvedValue(true)

		await expect(extractTextFromFileWithMetadata("large.bin")).rejects.toThrow(
			"Cannot read text for file type: .bin",
		)

		expect(probe).toHaveBeenCalledWith("large.bin")
		expect(readFile).not.toHaveBeenCalled()
	})

	it("loads document bytes from the path and preserves document metadata", async () => {
		vi.spyOn(fs, "access").mockResolvedValue(undefined)
		const source = Buffer.from(JSON.stringify({ cells: [{ cell_type: "code", source: ["first", "second"] }] }))
		const readFile = vi.spyOn(fs, "readFile").mockResolvedValue(source)

		expect(await extractTextFromFileWithMetadata("document.ipynb", 1)).toEqual({
			content: "1 | first\n2 | second\n",
			totalLines: 3,
			returnedLines: 3,
			wasTruncated: false,
		})
		expect(readFile).toHaveBeenCalledWith("document.ipynb")
	})
})

describe("text path adapters", () => {
	let directory: string

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "extract-text-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("returns truncation metadata and the actual included range for a text file", async () => {
		const filePath = path.join(directory, "notes.txt")
		await fs.writeFile(filePath, "first\nsecond\nthird")

		expect(await extractTextFromFileWithMetadata(filePath, 2)).toEqual({
			content: "1 | first\n2 | second",
			totalLines: 3,
			returnedLines: 2,
			wasTruncated: true,
			linesShown: [1, 2],
		})
	})

	it("preserves the single blank line and its metadata for an empty text file", async () => {
		const filePath = path.join(directory, "empty.txt")
		await fs.writeFile(filePath, "")

		expect(await extractTextFromFileWithMetadata(filePath)).toEqual({
			content: "1 | ",
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
			linesShown: [1, 1],
		})
	})

	it("keeps the legacy content-only path adapter and default line limit", async () => {
		const filePath = path.join(directory, "large.txt")
		const source = Buffer.from(Array.from({ length: DEFAULT_LINE_LIMIT + 1 }, (_, i) => `line ${i + 1}`).join("\n"))
		await fs.writeFile(filePath, source)

		const content = await extractTextFromFile(filePath)

		expect(content.split("\n")).toHaveLength(DEFAULT_LINE_LIMIT)
		expect(content).toContain(`${DEFAULT_LINE_LIMIT} | line ${DEFAULT_LINE_LIMIT}`)
		expect(content).not.toContain(`line ${DEFAULT_LINE_LIMIT + 1}`)
		expect(await extractTextFromBuffer(source, "metadata-only.txt")).toBe(content)
	})

	it("continues reading text when pathname binary detection fails", async () => {
		const filePath = path.join(directory, "notes.txt")
		await fs.writeFile(filePath, "first\nsecond")
		const probe = vi.spyOn(binaryFile, "isBinaryFile").mockRejectedValue(new Error("Detection failed"))

		expect(await extractTextFromFileWithMetadata(filePath)).toEqual({
			content: "1 | first\n2 | second",
			totalLines: 2,
			returnedLines: 2,
			wasTruncated: false,
			linesShown: [1, 2],
		})
		expect(probe).toHaveBeenCalledExactlyOnceWith(filePath)
	})

	it("reports a missing text path before probing or loading content", async () => {
		const filePath = path.join(directory, "missing.txt")
		const probe = vi.spyOn(binaryFile, "isBinaryFile")
		const readFile = vi.spyOn(fs, "readFile")

		await expect(extractTextFromFileWithMetadata(filePath)).rejects.toThrow(`File not found: ${filePath}`)
		expect(probe).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
	})
})

describe("addLineNumbers", () => {
	it("should add line numbers starting from 1 by default", () => {
		const input = "line 1\nline 2\nline 3"
		const expected = "1 | line 1\n2 | line 2\n3 | line 3\n"
		expect(addLineNumbers(input)).toBe(expected)
	})

	it("should add line numbers starting from specified line number", () => {
		const input = "line 1\nline 2\nline 3"
		const expected = "10 | line 1\n11 | line 2\n12 | line 3\n"
		expect(addLineNumbers(input, 10)).toBe(expected)
	})

	it("should handle empty content", () => {
		expect(addLineNumbers("")).toBe("")
		expect(addLineNumbers("", 5)).toBe("5 | \n")
	})

	it("should handle single line content", () => {
		expect(addLineNumbers("single line")).toBe("1 | single line\n")
		expect(addLineNumbers("single line", 42)).toBe("42 | single line\n")
	})

	it("should pad line numbers based on the highest line number", () => {
		const input = "line 1\nline 2"
		// When starting from 99, highest line will be 100, so needs 3 spaces padding
		const expected = " 99 | line 1\n100 | line 2\n"
		expect(addLineNumbers(input, 99)).toBe(expected)
	})

	it("should preserve trailing newline without adding extra line numbers", () => {
		const input = "line 1\nline 2\n"
		const expected = "1 | line 1\n2 | line 2\n"
		expect(addLineNumbers(input)).toBe(expected)
	})

	it("should handle multiple blank lines correctly", () => {
		const input = "line 1\n\n\n\nline 2"
		const expected = "1 | line 1\n2 | \n3 | \n4 | \n5 | line 2\n"
		expect(addLineNumbers(input)).toBe(expected)
	})

	it("should handle multiple trailing newlines correctly", () => {
		const input = "line 1\nline 2\n\n\n"
		const expected = "1 | line 1\n2 | line 2\n3 | \n4 | \n"
		expect(addLineNumbers(input)).toBe(expected)
	})

	it("should handle numbered trailing newline correctly", () => {
		const input = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\n\n"
		const expected =
			" 1 | Line 1\n 2 | Line 2\n 3 | Line 3\n 4 | Line 4\n 5 | Line 5\n 6 | Line 6\n 7 | Line 7\n 8 | Line 8\n 9 | Line 9\n10 | Line 10\n11 | \n"
		expect(addLineNumbers(input)).toBe(expected)
	})

	it("should handle only blank lines with offset correctly", () => {
		const input = "\n\n\n"
		const expected = "10 | \n11 | \n12 | \n"
		expect(addLineNumbers(input, 10)).toBe(expected)
	})
})

describe("everyLineHasLineNumbers", () => {
	it("should return true for content with line numbers", () => {
		const input = "1 | line one\n2 | line two\n3 | line three"
		expect(everyLineHasLineNumbers(input)).toBe(true)
	})

	it("should return true for content with padded line numbers", () => {
		const input = "  1 | line one\n  2 | line two\n  3 | line three"
		expect(everyLineHasLineNumbers(input)).toBe(true)
	})

	it("should return false for content without line numbers", () => {
		const input = "line one\nline two\nline three"
		expect(everyLineHasLineNumbers(input)).toBe(false)
	})

	it("should return false for mixed content", () => {
		const input = "1 | line one\nline two\n3 | line three"
		expect(everyLineHasLineNumbers(input)).toBe(false)
	})

	it("should handle empty content", () => {
		expect(everyLineHasLineNumbers("")).toBe(false)
	})

	it("should return false for content with pipe but no line numbers", () => {
		const input = "a | b\nc | d"
		expect(everyLineHasLineNumbers(input)).toBe(false)
	})
})

describe("stripLineNumbers", () => {
	it("should strip line numbers from content", () => {
		const input = "1 | line one\n2 | line two\n3 | line three"
		const expected = "line one\nline two\nline three"
		expect(stripLineNumbers(input)).toBe(expected)
	})

	it("should strip padded line numbers", () => {
		const input = "  1 | line one\n  2 | line two\n  3 | line three"
		const expected = "line one\nline two\nline three"
		expect(stripLineNumbers(input)).toBe(expected)
	})

	it("should handle content without line numbers", () => {
		const input = "line one\nline two\nline three"
		expect(stripLineNumbers(input)).toBe(input)
	})

	it("should handle empty content", () => {
		expect(stripLineNumbers("")).toBe("")
	})

	it("should preserve content with pipe but no line numbers", () => {
		const input = "a | b\nc | d"
		expect(stripLineNumbers(input)).toBe(input)
	})

	it("should handle windows-style line endings", () => {
		const input = "1 | line one\r\n2 | line two\r\n3 | line three"
		const expected = "line one\r\nline two\r\nline three"
		expect(stripLineNumbers(input)).toBe(expected)
	})

	it.each([false, true])("preserves trailing LF and CRLF including blank lines (aggressive=%s)", (aggressive) => {
		for (const newline of ["\n", "\r\n"]) {
			expect(stripLineNumbers(`1 | first${newline}2 | ${newline}${newline}`, aggressive)).toBe(
				`first${newline}${newline}${newline}`,
			)
			expect(stripLineNumbers(newline, aggressive)).toBe(newline)
		}
	})

	it("normalizes mixed line endings to CRLF while preserving the trailing blank line", () => {
		expect(stripLineNumbers("1 | first\n2 | second\r\n")).toBe("first\r\nsecond\r\n")
	})

	it("should handle content with varying line number widths", () => {
		const input = "  1 | line one\n 10 | line two\n100 | line three"
		const expected = "line one\nline two\nline three"
		expect(stripLineNumbers(input)).toBe(expected)
	})

	describe("aggressive mode", () => {
		it("should strip content with just a pipe character", () => {
			const input = "| line one\n| line two\n| line three"
			const expected = "line one\nline two\nline three"
			expect(stripLineNumbers(input, true)).toBe(expected)
		})

		it("should strip content with mixed formats in aggressive mode", () => {
			const input = "1 | line one\n| line two\n123 | line three"
			const expected = "line one\nline two\nline three"
			expect(stripLineNumbers(input, true)).toBe(expected)
		})

		it("should not strip content with pipe characters not at start in aggressive mode", () => {
			const input = "text | more text\nx | y"
			expect(stripLineNumbers(input, true)).toBe(input)
		})

		it("should handle empty content in aggressive mode", () => {
			expect(stripLineNumbers("", true)).toBe("")
		})

		it("should preserve padding after pipe in aggressive mode", () => {
			const input = "|  line with extra spaces\n1 |  indented content"
			const expected = " line with extra spaces\n indented content"
			expect(stripLineNumbers(input, true)).toBe(expected)
		})

		it("should preserve windows-style line endings in aggressive mode", () => {
			const input = "| line one\r\n| line two\r\n| line three"
			const expected = "line one\r\nline two\r\nline three"
			expect(stripLineNumbers(input, true)).toBe(expected)
		})

		it("should not affect regular content when using aggressive mode", () => {
			const input = "regular line\nanother line\nno pipes here"
			expect(stripLineNumbers(input, true)).toBe(input)
		})
	})
})

describe("truncateOutput", () => {
	it("returns original content when no line limit provided", () => {
		const content = "line1\nline2\nline3"
		expect(truncateOutput(content)).toBe(content)
	})

	it("returns original content when lines are under limit", () => {
		const content = "line1\nline2\nline3"
		expect(truncateOutput(content, 5)).toBe(content)
	})

	it("truncates content with 20/80 split when over limit", () => {
		// Create 25 lines of content
		const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`)
		const content = lines.join("\n")

		// Set limit to 10 lines
		const result = truncateOutput(content, 10)

		// Should keep:
		// - First 2 lines (20% of 10)
		// - Last 8 lines (80% of 10)
		// - Omission indicator in between
		const expectedLines = [
			"line1",
			"line2",
			"",
			"[...15 lines omitted...]",
			"",
			"line18",
			"line19",
			"line20",
			"line21",
			"line22",
			"line23",
			"line24",
			"line25",
		]
		expect(result).toBe(expectedLines.join("\n"))
	})

	it("handles empty content", () => {
		expect(truncateOutput("", 10)).toBe("")
	})

	it("handles single line content", () => {
		expect(truncateOutput("single line", 10)).toBe("single line")
	})

	describe("processBackspaces", () => {
		it("should handle basic backspace deletion", () => {
			const input = "abc\b\bxy"
			const expected = "axy"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle backspaces at start of input", () => {
			const input = "\b\babc"
			const expected = "abc"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle backspaces with newlines", () => {
			const input = "abc\b\n123\b\b"
			const expected = "ab\n1"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle consecutive backspaces", () => {
			const input = "abcdef\b\b\b\bxy"
			const expected = "abxy"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle backspaces at end of input", () => {
			const input = "abc\b\b"
			const expected = "a"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle mixed backspaces and content", () => {
			const input = "abc\bx\byz\b\b123"
			const expected = "ab123"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle multiple groups of consecutive backspaces", () => {
			const input = "abc\b\bdef\b\b\bghi\b\b\b\bjkl"
			const expected = "jkl"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle backspaces with empty content between them", () => {
			const input = "abc\b\b\b\b\b\bdef"
			const expected = "def"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle complex mixed content with backspaces", () => {
			const input = "Loading[\b\b\b\b\b\b\b\bProgress[\b\b\b\b\b\b\b\b\bStatus: \b\b\b\b\b\b\b\bDone!"
			// Technically terminal displays "Done!s: [" but we assume \b is destructive as an optimization
			const expected = "Done!"
			expect(processBackspaces(input)).toBe(expected)
		})

		it("should handle backspaces with special characters", () => {
			const input = "abc😀\b\bdef🎉\b\b\bghi"
			const expected = "abcdeghi"
			expect(processBackspaces(input)).toBe(expected)
		})
	})

	it("handles windows-style line endings", () => {
		// Create content with windows line endings
		const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`)
		const content = lines.join("\r\n")

		const result = truncateOutput(content, 5)

		// Should keep first line (20% of 5 = 1) and last 4 lines (80% of 5 = 4)
		// Split result by either \r\n or \n to normalize line endings
		const resultLines = result.split(/\r?\n/)
		const expectedLines = ["line1", "", "[...10 lines omitted...]", "", "line12", "line13", "line14", "line15"]
		expect(resultLines).toEqual(expectedLines)
	})

	describe("character limit functionality", () => {
		it("returns original content when no character limit provided", () => {
			const content = "a".repeat(1000)
			expect(truncateOutput(content, undefined, undefined)).toBe(content)
		})

		it("returns original content when characters are under limit", () => {
			const content = "a".repeat(100)
			expect(truncateOutput(content, undefined, 200)).toBe(content)
		})

		it("truncates content by character limit with 20/80 split", () => {
			// Create content with 1000 characters
			const content = "a".repeat(1000)

			// Set character limit to 100
			const result = truncateOutput(content, undefined, 100)

			// Should keep:
			// - First 20 characters (20% of 100)
			// - Last 80 characters (80% of 100)
			// - Omission indicator in between
			const expectedStart = "a".repeat(20)
			const expectedEnd = "a".repeat(80)
			const expected = expectedStart + "\n[...900 characters omitted...]\n" + expectedEnd

			expect(result).toBe(expected)
		})

		it("prioritizes character limit over line limit", () => {
			// Create content with few lines but many characters per line
			const longLine = "a".repeat(500)
			const content = `${longLine}\n${longLine}\n${longLine}`

			// Set both limits - character limit should take precedence
			const result = truncateOutput(content, 10, 100)

			// Should truncate by character limit, not line limit
			const expectedStart = "a".repeat(20)
			const expectedEnd = "a".repeat(80)
			// Total content: 1502 chars, limit: 100, so 1402 chars omitted
			const expected = expectedStart + "\n[...1402 characters omitted...]\n" + expectedEnd

			expect(result).toBe(expected)
		})

		it("falls back to line limit when character limit is satisfied", () => {
			// Create content with many short lines
			const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`)
			const content = lines.join("\n")

			// Character limit is high enough, so line limit should apply
			const result = truncateOutput(content, 10, 10000)

			// Should truncate by line limit
			const expectedLines = [
				"line1",
				"line2",
				"",
				"[...15 lines omitted...]",
				"",
				"line18",
				"line19",
				"line20",
				"line21",
				"line22",
				"line23",
				"line24",
				"line25",
			]
			expect(result).toBe(expectedLines.join("\n"))
		})

		it("handles edge case where character limit equals content length", () => {
			const content = "exactly100chars".repeat(6) + "1234" // exactly 100 chars
			const result = truncateOutput(content, undefined, 100)
			expect(result).toBe(content)
		})

		it("handles very small character limits", () => {
			const content = "a".repeat(1000)
			const result = truncateOutput(content, undefined, 10)

			// 20% of 10 = 2, 80% of 10 = 8
			const expected = "aa\n[...990 characters omitted...]\n" + "a".repeat(8)
			expect(result).toBe(expected)
		})

		it("handles character limit with mixed content", () => {
			const content = "Hello world! This is a test with mixed content including numbers 123 and symbols @#$%"
			const result = truncateOutput(content, undefined, 50)

			// 20% of 50 = 10, 80% of 50 = 40
			const expectedStart = content.slice(0, 10) // "Hello worl"
			const expectedEnd = content.slice(-40) // last 40 chars
			const omittedChars = content.length - 50
			const expected = expectedStart + `\n[...${omittedChars} characters omitted...]\n` + expectedEnd

			expect(result).toBe(expected)
		})

		describe("edge cases with very small character limits", () => {
			it("handles character limit of 1", () => {
				const content = "abcdefghijklmnopqrstuvwxyz"
				const result = truncateOutput(content, undefined, 1)

				// 20% of 1 = 0.2 (floor = 0), so beforeLimit = 0
				// afterLimit = 1 - 0 = 1
				// Should keep 0 chars from start and 1 char from end
				const expected = "\n[...25 characters omitted...]\nz"
				expect(result).toBe(expected)
			})

			it("handles character limit of 2", () => {
				const content = "abcdefghijklmnopqrstuvwxyz"
				const result = truncateOutput(content, undefined, 2)

				// 20% of 2 = 0.4 (floor = 0), so beforeLimit = 0
				// afterLimit = 2 - 0 = 2
				// Should keep 0 chars from start and 2 chars from end
				const expected = "\n[...24 characters omitted...]\nyz"
				expect(result).toBe(expected)
			})

			it("handles character limit of 5", () => {
				const content = "abcdefghijklmnopqrstuvwxyz"
				const result = truncateOutput(content, undefined, 5)

				// 20% of 5 = 1, so beforeLimit = 1
				// afterLimit = 5 - 1 = 4
				// Should keep 1 char from start and 4 chars from end
				const expected = "a\n[...21 characters omitted...]\nwxyz"
				expect(result).toBe(expected)
			})

			it("handles character limit with multi-byte characters", () => {
				const content = "🚀🎉🔥💻🌟🎨🎯🎪🎭🎬" // 10 emojis, each is multi-byte
				const result = truncateOutput(content, undefined, 10)

				// Character limit works on string length, not byte count
				// 20% of 10 = 2, 80% of 10 = 8
				// Note: In JavaScript, each emoji is actually 2 characters (surrogate pair)
				// So the content is actually 20 characters long, not 10
				const expected = "🚀\n[...10 characters omitted...]\n🎯🎪🎭🎬"
				expect(result).toBe(expected)
			})

			it("handles character limit with newlines in content", () => {
				const content = "line1\nline2\nline3\nline4\nline5"
				const result = truncateOutput(content, undefined, 15)

				// Total length is 29 chars (including newlines)
				// 20% of 15 = 3, 80% of 15 = 12
				// The slice will take first 3 chars: "lin"
				// And last 12 chars: "e4\nline5" (counting backwards)
				const expected = "lin\n[...14 characters omitted...]\n\nline4\nline5"
				expect(result).toBe(expected)
			})

			it("handles character limit exactly matching content with omission message", () => {
				// Edge case: when the omission message would make output longer than original
				const content = "short"
				const result = truncateOutput(content, undefined, 10)

				// Content is 5 chars, limit is 10, so no truncation needed
				expect(result).toBe(content)
			})

			it("handles character limit smaller than omission message", () => {
				const content = "a".repeat(100)
				const result = truncateOutput(content, undefined, 3)

				// 20% of 3 = 0.6 (floor = 0), so beforeLimit = 0
				// afterLimit = 3 - 0 = 3
				const expected = "\n[...97 characters omitted...]\naaa"
				expect(result).toBe(expected)
			})

			it("prioritizes character limit even with very high line limit", () => {
				const content = "a".repeat(1000)
				const result = truncateOutput(content, 999999, 50)

				// Character limit should still apply despite high line limit
				const expectedStart = "a".repeat(10) // 20% of 50
				const expectedEnd = "a".repeat(40) // 80% of 50
				const expected = expectedStart + "\n[...950 characters omitted...]\n" + expectedEnd
				expect(result).toBe(expected)
			})
		})
	})
})

describe("applyRunLengthEncoding", () => {
	it("should handle empty input", () => {
		expect(applyRunLengthEncoding("")).toBe("")
	})

	it.each(["single line", "single line\n", "first\nsecond\nlast", "first\nsecond\nlast\n"])(
		"preserves distinct lines and their final newline in %j",
		(input) => {
			expect(applyRunLengthEncoding(input)).toBe(input)
		},
	)

	it("flushes separate compressible runs without carrying their repeat counts across a divider", () => {
		const first = "first long repeated log entry with enough text to compress\n"
		const second = "second long repeated log entry with enough text to compress\n"
		const input = first.repeat(3) + "divider\n" + second.repeat(4) + "last line"

		expect(applyRunLengthEncoding(input)).toBe(
			first +
				"<previous line repeated 2 additional times>\n" +
				"divider\n" +
				second +
				"<previous line repeated 3 additional times>\n" +
				"last line",
		)
	})

	it("retains a short repeated run before a different final line when compression would expand it", () => {
		const input = "x\nx\nx\nfinal line"
		expect(applyRunLengthEncoding(input)).toBe(input)
	})

	it("should compress repeated single lines when beneficial", () => {
		const input = "longerline\nlongerline\nlongerline\nlongerline\nlongerline\nlongerline\n"
		const expected = "longerline\n<previous line repeated 5 additional times>\n"
		expect(applyRunLengthEncoding(input)).toBe(expected)
	})

	it("should not compress when not beneficial", () => {
		const input = "y\ny\ny\ny\ny\n"
		expect(applyRunLengthEncoding(input)).toBe(input)
	})
})

describe("processCarriageReturns", () => {
	it("should return original input if no carriage returns (\r) present", () => {
		const input = "Line 1\nLine 2\nLine 3"
		expect(processCarriageReturns(input)).toBe(input)
	})

	it("handles a terminal chunk ending with a high surrogate during a partial overwrite", () => {
		// An emoji split across chunks can leave a high surrogate at the end of the replacement segment.
		expect(processCarriageReturns("abcdef\r\ud83d")).toBe("\ud83d cdef")
	})

	it("preserves a complete emoji replacement and the remaining suffix", () => {
		expect(processCarriageReturns("abcdef\r🚀")).toBe("🚀cdef")
	})

	it("detects a surrogate pair beginning at the overwrite boundary", () => {
		expect(processCarriageReturns("a🚀tail\rb")).toBe("b \ude80tail")
	})

	it("does not treat private-use BMP characters at the overwrite boundary as surrogates", () => {
		expect(processCarriageReturns("a\ue000tail\rb")).toBe("b\ue000tail")
	})

	it("should process basic progress bar with carriage returns (\r)", () => {
		const input = "Progress: [===>---------] 30%\rProgress: [======>------] 60%\rProgress: [==========>] 100%"
		const expected = "Progress: [==========>] 100%%"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle multi-line outputs with carriage returns (\r)", () => {
		const input = "Line 1\rUpdated Line 1\nLine 2\rUpdated Line 2\rFinal Line 2"
		const expected = "Updated Line 1\nFinal Line 2 2"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle carriage returns (\r) at end of line", () => {
		// A carriage return (\r) at the end of a line should be treated as if the cursor is at the start
		// with no content following it, so we keep the existing content
		const input = "Initial text\rReplacement text\r"
		// Depending on terminal behavior:
		// Option 1: If last carriage return (\r) is ignored because nothing follows it to replace text
		const expected = "Replacement text"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	// Additional test to clarify behavior with a terminal-like example
	it("should handle carriage returns (\r) in a way that matches terminal behavior", () => {
		// In a real terminal:
		// 1. "Hello" is printed
		// 2. Carriage return (\r) moves cursor to start of line
		// 3. "World" overwrites, becoming "World"
		// 4. Carriage return (\r) moves cursor to start again
		// 5. Nothing follows, so the line remains "World" (cursor just sitting at start)
		const input = "Hello\rWorld\r"
		const expected = "World"
		expect(processCarriageReturns(input)).toBe(expected)

		// Same principle applies to carriage return (\r) + line feed (\n)
		// 1. "Line1" is printed
		// 2. Carriage return (\r) moves cursor to start
		// 3. Line feed (\n) moves to next line, so the line remains "Line1"
		expect(processCarriageReturns("Line1\r\n")).toBe("Line1\n")
	})

	it("should preserve lines without carriage returns (\r)", () => {
		const input = "Line 1\nLine 2\rUpdated Line 2\nLine 3"
		const expected = "Line 1\nUpdated Line 2\nLine 3"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle complex tqdm-like progress bars", () => {
		const input =
			"10%|██        | 10/100 [00:01<00:09, 10.00it/s]\r20%|████      | 20/100 [00:02<00:08, 10.00it/s]\r100%|██████████| 100/100 [00:10<00:00, 10.00it/s]"
		const expected = "100%|██████████| 100/100 [00:10<00:00, 10.00it/s]"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle ANSI escape sequences", () => {
		const input = "\x1b]633;C\x07Loading\rLoading.\rLoading..\rLoading...\x1b]633;D\x07"
		const expected = "Loading...\x1b]633;D\x07"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle mixed content with carriage returns (\r) and line feeds (\n)", () => {
		const input =
			"Step 1: Starting\rStep 1: In progress\rStep 1: Done\nStep 2: Starting\rStep 2: In progress\rStep 2: Done"
		const expected = "Step 1: Donerogress\nStep 2: Donerogress"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle empty input", () => {
		expect(processCarriageReturns("")).toBe("")
	})

	it("should handle large number of carriage returns (\r) efficiently", () => {
		// Create a string with many carriage returns (\r)
		let input = ""
		for (let i = 0; i < 10000; i++) {
			input += `Progress: ${i / 100}%\r`
		}
		input += "Progress: 100%"

		const expected = "Progress: 100%9%"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	// Additional edge cases to stress test processCarriageReturns
	it("should handle consecutive carriage returns (\r)", () => {
		const input = "Initial\r\r\r\rFinal"
		const expected = "Finalal"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle carriage returns (\r) at the start of a line", () => {
		const input = "\rText after carriage return"
		const expected = "Text after carriage return"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle only carriage returns (\r)", () => {
		const input = "\r\r\r\r"
		const expected = ""
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle carriage returns (\r) with empty strings between them", () => {
		const input = "Start\r\r\r\r\rEnd"
		const expected = "Endrt"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle multiline with carriage returns (\r) at different positions", () => {
		const input = "Line1\rLine1Updated\nLine2\nLine3\rLine3Updated\rLine3Final\nLine4"
		const expected = "Line1Updated\nLine2\nLine3Finaled\nLine4"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle carriage returns (\r) with special characters", () => {
		// This test demonstrates our handling of multi-byte characters (like emoji) when they get partially overwritten.
		// When a carriage return (\r) causes partial overwrite of a multi-byte character (like an emoji),
		// we need to handle this special case to prevent display issues or corruption.
		//
		// In this example:
		// 1. "Line with 🚀 emoji" is printed (note that the emoji is a multi-byte character)
		// 2. Carriage return (\r) moves cursor to start of line
		// 3. "Line with a" is printed, which partially overwrites the line
		// 4. The 'a' character ends at a position that would split the 🚀 emoji
		// 5. Instead of creating corrupted output, we insert a space to replace the partial emoji
		//
		// This behavior mimics terminals that can detect and properly handle these situations
		// by replacing partial characters with spaces to maintain text integrity.
		const input = "Line with 🚀 emoji\rLine with a"
		const expected = "Line with a  emoji"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should correctly handle multiple consecutive line feeds (\n) with carriage returns (\r)", () => {
		// Another test case for multi-byte character handling during carriage return (\r) overwrites.
		// In this case, we're testing with a different emoji and pattern to ensure robustness.
		//
		// When a new line with an emoji partially overlaps with text from the previous line,
		// we need to properly detect surrogate pairs and other multi-byte sequences to avoid
		// creating invalid Unicode output.
		//
		// Note: The expected result might look strange but it's consistent with how real
		// terminals process such content - they only overwrite at character boundaries
		// and don't attempt to interpret or normalize the resulting text.
		const input = "Line with not a emoji\rLine with 🔥 emoji"
		const expected = "Line with 🔥 emojioji"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle carriage returns (\r) in the middle of non-ASCII text", () => {
		// Tests handling of non-Latin text (like Chinese characters)
		// Non-ASCII text uses multi-byte encodings, so this test verifies our handling works
		// properly with such character sets.
		//
		// Our implementation ensures we preserve character boundaries and don't create
		// invalid sequences when carriage returns (\r) cause partial overwrites.
		const input = "你好世界啊\r你好地球"
		const expected = "你好地球啊"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should correctly handle complex patterns of alternating carriage returns (\r) and line feeds (\n)", () => {
		// Break down the example:
		// 1. "Line1" + carriage return (\r) + line feed (\n): carriage return (\r) moves cursor to start of line, line feed (\n) moves to next line, preserving "Line1"
		// 2. "Line2" + carriage return (\r): carriage return (\r) moves cursor to start of line
		// 3. "Line2Updated" overwrites "Line2"
		// 4. Line feed (\n): moves to next line
		// 5. "Line3" + carriage return (\r) + line feed (\n): carriage return (\r) moves cursor to start, line feed (\n) moves to next line, preserving "Line3"
		const input = "Line1\r\nLine2\rLine2Updated\nLine3\r\n"
		const expected = "Line1\nLine2Updated\nLine3\n"
		expect(processCarriageReturns(input)).toBe(expected)
	})

	it("should handle partial overwrites with carriage returns (\r)", () => {
		// In this case:
		// 1. "Initial text" is printed
		// 2. Carriage return (\r) moves cursor to start of line
		// 3. "next" is printed, overwriting only the first 4 chars
		// 4. Carriage return (\r) moves cursor to start, but nothing follows
		// Final result should be "nextial text" (first 4 chars overwritten)
		const input = "Initial text\rnext\r"
		const expected = "nextial text"
		expect(processCarriageReturns(input)).toBe(expected)
	})
})
