import { MAX_LINE_LENGTH } from "../../../core/prompts/tools/native-tools/read_file"
import { formatWithLineNumbers, parseLines, readWithIndentation, readWithSlice } from "../indentation-reader"

describe("line formatting Unicode boundaries", () => {
	it("does not leave a dangling surrogate when clipping a long line", () => {
		const output = formatWithLineNumbers(parseLines("🔥".repeat(2000)))
		expect(output).toBe(`1 | ${"🔥".repeat(998)}...`)
		expect(output).toContain("...")
		expect(Buffer.from(output).toString("utf8")).not.toContain("�")
		expect(output.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 4)
	})

	it.each([
		["pair crossing the boundary", "abcd🔥tail", "abcd..."],
		["complete pair before the boundary", "abc🔥tail", "abc🔥..."],
		["pair after the boundary", "abcde🔥tail", "abcde..."],
		["lowest high surrogate", `abcd${String.fromCodePoint(0x10000)}tail`, "abcd..."],
		["highest high surrogate", `abcd${String.fromCodePoint(0x10ffff)}tail`, "abcd..."],
		["BMP below the surrogate range", "abcd\ud7fftail", "abcd\ud7ff..."],
		["BMP above the surrogate range", "abcd\ue000tail", "abcd\ue000..."],
		["non-ASCII BMP text", "Жé文Ωßtail", "Жé文Ωß..."],
		["combining characters without normalization", "abcde\u0301tail", "abcde..."],
		["ZWJ sequence without grapheme segmentation", "ab👩\u200d💻tail", "ab👩\u200d..."],
	])("clips %s without corrupting UTF-16", (_name, content, expected) => {
		const output = formatWithLineNumbers(parseLines(content), 8)
		expect(output).toBe(`1 | ${expected}`)
		expect(Buffer.from(output).toString("utf8")).toBe(output)
		expect(output.slice(4).length).toBeLessThanOrEqual(8)
	})

	it.each(["abc", "abcdefgh", "🔥🔥🔥🔥", "e\u0301👩\u200d💻"])(
		"preserves text at or below the limit: %s",
		(content) => {
			const output = formatWithLineNumbers(parseLines(content), 8)
			expect(output).toBe(`1 | ${content}`)
			expect(Buffer.from(output).toString("utf8")).toBe(output)
		},
	)

	it.each([0, 1, 2, 3])("preserves the existing ellipsis behavior for a limit of %i", (limit) => {
		expect(formatWithLineNumbers(parseLines("abcdef"), limit)).toBe("1 | ...")
	})

	it.each([
		[4, "..."],
		[5, "🔥..."],
	])("clips an emoji at the start with a limit of %i", (limit, expected) => {
		const output = formatWithLineNumbers(parseLines("🔥tail"), limit)
		expect(output).toBe(`1 | ${expected}`)
		expect(Buffer.from(output).toString("utf8")).toBe(output)
		expect(output.slice(4).length).toBeLessThanOrEqual(limit)
	})

	it("preserves ASCII clipping and aligned line numbers alongside Unicode", () => {
		const lines = parseLines(`abcdefghij\n${"middle\n".repeat(8)}abcd🔥tail`)
		expect(formatWithLineNumbers([lines[0], lines[9]], 8)).toBe(" 1 | abcde...\n10 | abcd...")
	})

	it("preserves empty formatting and the existing zero line-number fallback", () => {
		expect(formatWithLineNumbers([])).toBe("")
		expect(formatWithLineNumbers([{ ...parseLines("🔥")[0], lineNumber: 0 }])).toBe("0 | 🔥")
	})
})

describe("Unicode clipping through the existing readers", () => {
	const longLine = "🔥".repeat(2000)
	const clippedLine = `${"🔥".repeat(998)}...`

	it("preserves slice selection, ranges and truncation metadata", () => {
		const result = readWithSlice(`before\n${longLine}\nafter`, 1, 1)
		expect(result).toEqual({
			content: `2 | ${clippedLine}`,
			includedRanges: [[2, 2]],
			totalLines: 3,
			returnedLines: 1,
			wasTruncated: true,
			hasClippedLines: true,
		})
		expect(Buffer.from(result.content).toString("utf8")).toBe(result.content)
	})

	it("preserves indentation selection and metadata with a single-line limit", () => {
		const result = readWithIndentation(`function example() {\n    ${longLine}\n}`, {
			anchorLine: 2,
			limit: 1,
		})
		expect(result).toEqual({
			content: `2 |     ${"🔥".repeat(996)}...`,
			includedRanges: [[2, 2]],
			totalLines: 3,
			returnedLines: 1,
			wasTruncated: true,
		})
		expect(Buffer.from(result.content).toString("utf8")).toBe(result.content)
	})

	it("preserves indentation expansion, blank trimming and complete-file metadata", () => {
		const result = readWithIndentation(`\nfunction example() {\n    ${longLine}\n}\n`, {
			anchorLine: 3,
			includeSiblings: true,
		})
		expect(result).toEqual({
			content: `2 | function example() {\n3 |     ${"🔥".repeat(996)}...\n4 | }`,
			includedRanges: [[2, 4]],
			totalLines: 5,
			returnedLines: 3,
			wasTruncated: false,
		})
		expect(Buffer.from(result.content).toString("utf8")).toBe(result.content)
	})

	it("preserves default slice limits and empty input", () => {
		expect(readWithSlice(longLine)).toEqual({
			content: `1 | ${clippedLine}`,
			includedRanges: [[1, 1]],
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
			hasClippedLines: true,
		})
		expect(readWithSlice("")).toEqual({
			content: "1 | ",
			includedRanges: [[1, 1]],
			totalLines: 1,
			returnedLines: 1,
			wasTruncated: false,
			hasClippedLines: false,
		})
	})

	it("preserves reader errors without formatting or leaking the long line", () => {
		expect(readWithSlice(longLine, 1)).toEqual({
			content: "Error: offset 1 is beyond file end (1 lines)",
			includedRanges: [],
			totalLines: 1,
			returnedLines: 0,
			wasTruncated: false,
			hasClippedLines: false,
		})
		expect(readWithIndentation(longLine, { anchorLine: 0 })).toEqual({
			content: "Error: anchor_line 0 is out of range (1-1)",
			includedRanges: [],
			totalLines: 1,
			returnedLines: 0,
			wasTruncated: false,
			hasClippedLines: false,
		})
	})
})
