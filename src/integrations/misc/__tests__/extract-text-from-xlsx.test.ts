import ExcelJS from "exceljs"
import { extractTextFromXLSX, formatWorkbook } from "../extract-text-from-xlsx"
import { extractTextFromFile } from "../extract-text"

describe("XLSX buffer decoding", () => {
	it("preserves empty columns in a populated row from real XLSX bytes", async () => {
		const workbook = new ExcelJS.Workbook()
		const worksheet = workbook.addWorksheet("Sparse")
		worksheet.getCell("A1").value = null
		worksheet.getCell("B1").value = "middle"
		worksheet.getCell("C1").value = undefined
		worksheet.getCell("D1").value = "end"

		const expected = "--- Sheet: Sparse ---\n\tmiddle\t\tend"
		expect(formatWorkbook(workbook)).toBe(expected)
		const source = Buffer.from(await workbook.xlsx.writeBuffer())
		expect(await extractTextFromXLSX(source)).toBe(expected)
	})

	it("decodes only the selected buffer view when another workbook follows in the backing buffer", async () => {
		const approved = new ExcelJS.Workbook()
		const worksheet = approved.addWorksheet("Selected")
		worksheet.getCell("A1").value = "approved cell"
		worksheet.getCell("B1").value = 42
		const approvedBytes = Buffer.from(await approved.xlsx.writeBuffer())

		const unapproved = new ExcelJS.Workbook()
		unapproved.addWorksheet("Unapproved").getCell("A1").value = "outside selected bytes"
		const unapprovedBytes = Buffer.from(await unapproved.xlsx.writeBuffer())
		const prefix = Buffer.from("unapproved prefix")
		const backing = Buffer.concat([prefix, approvedBytes, unapprovedBytes])
		const source = backing.subarray(prefix.length, prefix.length + approvedBytes.length)

		// Passing source.buffer would expose the later, unapproved ZIP archive to the decoder.
		expect(source.byteOffset).toBeGreaterThan(0)
		expect(source.byteLength).toBeLessThan(source.buffer.byteLength)
		expect(await extractTextFromXLSX(source)).toBe("--- Sheet: Selected ---\napproved cell\t42")
	})

	it("rejects invalid workbook bytes instead of returning empty workbook text", async () => {
		await expect(extractTextFromXLSX(Buffer.from("not an XLSX archive"))).rejects.toThrow()
	})
})

describe("formatWorkbook", () => {
	describe("basic functionality", () => {
		it("should extract text with proper formatting", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Hello"
			worksheet.getCell("B1").value = "World"
			worksheet.getCell("A2").value = "Test"
			worksheet.getCell("B2").value = 123

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			expect(result).toContain("Hello\tWorld")
			expect(result).toContain("Test\t123")
		})

		it("should skip rows with no content", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Row 1"
			// Row 2 is completely empty
			worksheet.getCell("A3").value = "Row 3"

			const result = formatWorkbook(workbook)

			expect(result).toContain("Row 1")
			expect(result).toContain("Row 3")
			// Should not contain empty rows
			expect(result).not.toMatch(/\n\t*\n/)
		})
	})

	describe("sheet handling", () => {
		it("should process multiple sheets", () => {
			const workbook = new ExcelJS.Workbook()

			const sheet1 = workbook.addWorksheet("First Sheet")
			sheet1.getCell("A1").value = "Sheet 1 Data"

			const sheet2 = workbook.addWorksheet("Second Sheet")
			sheet2.getCell("A1").value = "Sheet 2 Data"

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: First Sheet ---")
			expect(result).toContain("Sheet 1 Data")
			expect(result).toContain("--- Sheet: Second Sheet ---")
			expect(result).toContain("Sheet 2 Data")
		})

		it("should skip hidden sheets", () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const hiddenSheet = workbook.addWorksheet("Hidden Sheet")
			hiddenSheet.getCell("A1").value = "Hidden Data"
			hiddenSheet.state = "hidden"

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Hidden Sheet ---")
			expect(result).not.toContain("Hidden Data")
		})

		it("should skip very hidden sheets", () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const veryHiddenSheet = workbook.addWorksheet("Very Hidden Sheet")
			veryHiddenSheet.getCell("A1").value = "Very Hidden Data"
			veryHiddenSheet.state = "veryHidden"

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Very Hidden Sheet ---")
			expect(result).not.toContain("Very Hidden Data")
		})
	})

	describe("formatCellValue logic", () => {
		it("should handle null and undefined values", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Before"
			worksheet.getCell("A2").value = null
			worksheet.getCell("A3").value = undefined
			worksheet.getCell("A4").value = "After"

			const result = formatWorkbook(workbook)

			expect(result).toContain("Before")
			expect(result).toContain("After")
			// Should handle null/undefined as empty strings
			const lines = result.split("\n")
			const dataLines = lines.filter((line) => !line.startsWith("---") && line.trim())
			expect(dataLines).toHaveLength(2) // Only 'Before' and 'After' should create content
		})

		it("should format dates correctly", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			const testDate = new Date("2023-12-25")
			worksheet.getCell("A1").value = testDate

			const result = formatWorkbook(workbook)

			expect(result).toContain("2023-12-25")
		})

		it("should handle error values", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { error: "#DIV/0!" }

			const result = formatWorkbook(workbook)

			expect(result).toContain("[Error: #DIV/0!]")
		})

		it("should handle rich text", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				richText: [{ text: "Hello " }, { text: "World", font: { bold: true } }],
			}

			const result = formatWorkbook(workbook)

			expect(result).toContain("Hello World")
		})

		it("should handle hyperlinks", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				text: "Roo Code",
				hyperlink: "https://roocode.com/",
			}

			const result = formatWorkbook(workbook)

			expect(result).toContain("Roo Code (https://roocode.com/)")
		})

		it("should handle formulas with and without results", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { formula: "A2+A3", result: 30 }
			worksheet.getCell("A2").value = { formula: "SUM(B1:B10)" }

			const result = formatWorkbook(workbook)

			expect(result).toContain("30") // Formula with result
			expect(result).toContain("[Formula: SUM(B1:B10)]") // Formula without result
		})

		it("should read every cell of a filled-down formula", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// Excel saves a formula filled down a column as one shared formula
			worksheet.getCell("A1").value = { formula: "B1*2", result: 2 }
			worksheet.getCell("A2").value = { sharedFormula: "A1", result: 4 }
			worksheet.getCell("A3").value = { sharedFormula: "A1" }

			const result = formatWorkbook(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n2\n4\n[Formula: B3*2]")
		})

		it("should read a cached 0 or false formula result, not the formula", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// ExcelJS keeps a falsy cached result in cell.result but leaves it out of cell.value
			worksheet.getCell("A1").value = { formula: "B1*2", result: 0 }
			worksheet.getCell("A2").value = { sharedFormula: "A1", result: 0 }
			worksheet.getCell("A3").value = { formula: "B1>1", result: false }

			const result = formatWorkbook(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n0\n0\nfalse")
		})

		it("should read every cell of a merged formula through the top-left cell", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// The other cells of a merged range return the top-left cell's value, but not its result
			worksheet.getCell("A1").value = { formula: "C1*2", result: 4 }
			worksheet.mergeCells("A1:B1")
			worksheet.getCell("A2").value = { formula: "C2*2", result: 0 }
			worksheet.mergeCells("A2:B2")
			worksheet.getCell("A3").value = { formula: "C3+30", result: new Date("2024-10-30T00:00:00.000Z") }
			worksheet.getCell("A3").numFmt = "yyyy-mm-dd"
			worksheet.mergeCells("A3:B3")

			const result = formatWorkbook(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n4\t4\n0\t0\n2024-10-30\t2024-10-30")
		})

		it("should read formula errors and dates like plain values", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { formula: "1/0", result: { error: "#DIV/0!" } }
			worksheet.getCell("B1").value = { formula: "A2+30", result: new Date("2024-10-30T00:00:00.000Z") }
			worksheet.getCell("B1").numFmt = "yyyy-mm-dd"

			const result = formatWorkbook(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n[Error: #DIV/0!]\t2024-10-30")
		})

		it("should keep the time of dates and read times of day and durations", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// ExcelJS reads a time of day or a duration as a Date counted from 1899-12-30
			const cells: [string, string, string][] = [
				["2024-09-30T14:04:59.900Z", "yyyy-mm-dd h:mm", "2024-09-30 14:05:00"],
				["2024-09-30T09:30:00.000Z", "DD.MM.YYYY HH:MM", "2024-09-30 09:30:00"],
				["2024-05-01T00:00:00.000Z", "mmm yyyy", "2024-05-01"],
				["2024-09-30T00:00:00.000Z", "d-mmm", "2024-09-30"],
				["1899-12-30T06:00:00.000Z", "h:mm", "06:00:00"],
				["1899-12-30T12:00:00.000Z", "[$-x-systime]h:mm:ss AM/PM", "12:00:00"],
				["1899-12-30T18:00:00.000Z", 'h:mm" daily"', "18:00:00"],
				["1899-12-31T12:00:00.000Z", "[h]:mm:ss", "36:00:00"],
				["1899-12-31T12:00:30.000Z", "[h]:mm", "36:00"],
				["1899-12-31T01:00:30.000Z", "[m]", "1500"],
				["1899-12-31T01:00:30.000Z", "[mm]:ss", "1500:30"],
				["1899-12-30T01:30:00.000Z", "[ss]", "5400"],
				["2024-09-30T00:00:00.000Z", "mmmm", "2024-09-30"],
				["1899-12-30T18:00:00.000Z", "h:mm\\ \\d\\a\\i\\l\\y", "18:00:00"],
			]
			cells.forEach(([date, numFmt], index) => {
				const cell = worksheet.getRow(1).getCell(index + 1)
				cell.value = new Date(date)
				cell.numFmt = numFmt
			})

			const result = formatWorkbook(workbook)

			expect(result).toBe(`--- Sheet: Sheet1 ---\n${cells.map(([, , text]) => text).join("\t")}`)
		})

		it("should count durations from 1904-01-01 in a 1904 workbook", () => {
			const workbook = new ExcelJS.Workbook()
			workbook.properties.date1904 = true
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = new Date("1904-01-02T12:00:00.000Z")
			worksheet.getCell("A1").numFmt = "[h]:mm"

			const result = formatWorkbook(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n36:00")
		})
	})

	describe("edge cases", () => {
		it("includes row 50000, marks row 50001 as truncated, and still formats the next sheet", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Large")
			worksheet.getCell("A50000").value = "last included row"
			worksheet.getCell("A50001").value = "excluded row content"
			workbook.addWorksheet("Next").getCell("A1").value = "next sheet content"

			expect(formatWorkbook(workbook)).toBe(
				"--- Sheet: Large ---\nlast included row\n[... truncated at row 50001 ...]\n\n" +
					"--- Sheet: Next ---\nnext sheet content",
			)
		})

		it("should handle empty workbook", () => {
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Empty Sheet")

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: Empty Sheet ---")
			expect(result.trim()).toBe("--- Sheet: Empty Sheet ---")
		})

		it("should handle workbook with only empty cells", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// Set cells but leave them empty
			worksheet.getCell("A1").value = ""
			worksheet.getCell("B1").value = ""

			const result = formatWorkbook(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			// Should not contain any data rows since empty strings don't count as content
			const lines = result.split("\n").filter((line) => line.trim() && !line.startsWith("---"))
			expect(lines).toHaveLength(0)
		})
	})

	describe("workbook formatting and path adapter", () => {
		it("should work with workbook objects", () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Test")
			worksheet.getCell("A1").value = "Test Data"

			const result = formatWorkbook(workbook)

			expect(result).toContain("Test Data")
		})

		it("should reject invalid file paths", async () => {
			await expect(extractTextFromFile("/non/existent/file.xlsx")).rejects.toThrow()
		})
	})
})
