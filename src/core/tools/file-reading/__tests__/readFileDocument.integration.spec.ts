import * as fs from "fs/promises"
import os from "os"
import path from "path"
import ExcelJS from "exceljs"
import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../../task/Task"
import { extractRawTextFromFile, extractTextFromFile } from "../../../../integrations/misc/extract-text"
import { ModernFileReader } from "../ModernFileReader"
import { MAX_LINE_LENGTH } from "../readFileConstants"
import type { ReadEntryOptions } from "../types"

function createReadingTask(cwd: string) {
	return {
		cwd,
		abort: false,
		abandoned: false,
		didToolFailInCurrentTurn: false,
		rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		say: vi.fn().mockResolvedValue(undefined),
		fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
	}
}

describe("text-only document extraction and structural reading", () => {
	let directory: string
	let reader: ModernFileReader
	let task: ReturnType<typeof createReadingTask>

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-document-reading-"))
		reader = new ModernFileReader()
		task = createReadingTask(directory)
	})

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function writeNotebook(source: string[]) {
		await fs.writeFile(
			path.join(directory, "example.ipynb"),
			JSON.stringify({ cells: [{ cell_type: "code", source }] }),
		)
	}

	function readDocument(params: ReadFileParams, options: ReadEntryOptions = { textOnly: true }) {
		// This boundary double omits Task fields unrelated to file reading.
		return reader.read(params, task as unknown as Task, options)
	}

	it("preserves the function declaration and indentation without numbering extracted notebook text twice", async () => {
		await writeNotebook([
			"def first():",
			"    value = 1",
			"    doubled = value * 2",
			"    return doubled",
			"",
			"def second():",
			"    return 9",
		])

		const result = await readDocument({
			path: "example.ipynb",
			mode: "indentation",
			indentation: { anchor_line: 3, max_levels: 1, include_header: false },
		})

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toBe(
			"File: example.ipynb\n1 | def first():\n2 |     value = 1\n3 |     doubled = value * 2\n4 |     return doubled\n5 | \n6 | def second():\n7 |     return 9\n\nIncluded ranges: 1-7 (total: 7 lines)",
		)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith("example.ipynb", "read_tool")
	})

	it("applies slice limits and continuation offsets to raw extracted notebook lines", async () => {
		await writeNotebook(["first", "    second", "third"])

		const result = await readDocument({ path: "example.ipynb", offset: 2, limit: 1 })

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toContain("Status: Showing lines 2-2 of 3 total lines.")
		expect(result.nativeContent).toContain("offset=3 and limit=1")
		expect(result.nativeContent?.endsWith("2 |     second")).toBe(true)
	})

	it("preserves source text resembling line-number prefixes and the existing formatted extraction API", async () => {
		await writeNotebook(["12 | actual content", "    3 | indented content"])
		const file = path.join(directory, "example.ipynb")

		expect(await extractRawTextFromFile(file)).toBe("12 | actual content\n    3 | indented content")
		expect(await extractTextFromFile(file)).toBe("1 | 12 | actual content\n2 |     3 | indented content\n")
		const result = await readDocument({ path: "example.ipynb" })
		expect(result.nativeContent).toBe("File: example.ipynb\n1 | 12 | actual content\n2 |     3 | indented content")
	})

	it("reads XLSX sheet text without stripping legitimate number-like cell prefixes", async () => {
		const workbook = new ExcelJS.Workbook()
		const sheet = workbook.addWorksheet("Data")
		sheet.addRow(["12 | actual content", "second column"])
		await workbook.xlsx.writeFile(path.join(directory, "example.xlsx"))

		const result = await readDocument({ path: "example.xlsx" })

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toBe(
			"File: example.xlsx\n1 | --- Sheet: Data ---\n2 | 12 | actual content\tsecond column",
		)
	})

	it("clips raw document lines without spending the source budget on extraction prefixes", async () => {
		await writeNotebook(["x".repeat(MAX_LINE_LENGTH + 10)])

		const result = await readDocument({ path: "example.ipynb" })

		expect(result.nativeContent).toBe(`File: example.ipynb\n1 | ${"x".repeat(MAX_LINE_LENGTH - 3)}...`)
		expect(result.longLinesTruncated).toBe(true)
	})

	it("keeps empty notebooks empty in both raw and existing formatted extraction APIs", async () => {
		const file = path.join(directory, "example.ipynb")
		await fs.writeFile(file, JSON.stringify({ cells: [] }))

		expect(await extractRawTextFromFile(file)).toBe("")
		expect(await extractTextFromFile(file)).toBe("")
	})

	it("rejects an out-of-range ordinary document read instead of returning the entire large document", async () => {
		const workbook = new ExcelJS.Workbook()
		const sheet = workbook.addWorksheet("Data")
		for (let index = 1; index <= 2101; index++) sheet.addRow([`row ${index}`])
		await workbook.xlsx.writeFile(path.join(directory, "large.xlsx"))

		const result = await readDocument({ path: "large.xlsx", offset: 2500, limit: 1 }, {})

		expect(result).toMatchObject({
			status: "error",
			nativeContent: "File: large.xlsx\nError: offset 2499 is beyond file end (2102 lines)",
		})
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
	})

	it("limits ordinary document output to the requested clipped line without returning unrelated rows", async () => {
		const workbook = new ExcelJS.Workbook()
		const sheet = workbook.addWorksheet("Data")
		for (let index = 1; index <= 2100; index++) sheet.addRow([`row ${index}`])
		sheet.addRow(["x".repeat(5000)])
		await workbook.xlsx.writeFile(path.join(directory, "large.xlsx"))

		const result = await readDocument({ path: "large.xlsx", offset: 2102, limit: 1 }, {})

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toBe(`File: large.xlsx\n2102 | ${"x".repeat(MAX_LINE_LENGTH - 3)}...`)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledExactlyOnceWith("large.xlsx", "read_tool")
	})

	it("applies the default line limit and continuation guidance to ordinary documents", async () => {
		const workbook = new ExcelJS.Workbook()
		const sheet = workbook.addWorksheet("Data")
		for (let index = 1; index <= 2101; index++) sheet.addRow([`row ${index}`])
		await workbook.xlsx.writeFile(path.join(directory, "large.xlsx"))

		const result = await readDocument({ path: "large.xlsx" }, {})

		expect(result.status).toBe("approved")
		expect(result.nativeContent).toContain("Status: Showing lines 1-2000 of 2102 total lines.")
		expect(result.nativeContent).toContain("offset=2001 and limit=2000")
		expect(result.nativeContent?.endsWith("2000 | row 1999")).toBe(true)
		expect(result.nativeContent).not.toContain("row 2101")
	})
})
