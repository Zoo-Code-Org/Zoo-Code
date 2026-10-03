import ExcelJS from "exceljs"
import { extractTextFromXLSX } from "../extract-text-from-xlsx"

describe("extractTextFromXLSX", () => {
	describe("basic functionality", () => {
		it("should extract text with proper formatting", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Hello"
			worksheet.getCell("B1").value = "World"
			worksheet.getCell("A2").value = "Test"
			worksheet.getCell("B2").value = 123

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			expect(result).toContain("Hello\tWorld")
			expect(result).toContain("Test\t123")
		})

		it("should skip rows with no content", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Row 1"
			// Row 2 is completely empty
			worksheet.getCell("A3").value = "Row 3"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Row 1")
			expect(result).toContain("Row 3")
			// Should not contain empty rows
			expect(result).not.toMatch(/\n\t*\n/)
		})
	})

	describe("sheet handling", () => {
		it("should process multiple sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const sheet1 = workbook.addWorksheet("First Sheet")
			sheet1.getCell("A1").value = "Sheet 1 Data"

			const sheet2 = workbook.addWorksheet("Second Sheet")
			sheet2.getCell("A1").value = "Sheet 2 Data"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: First Sheet ---")
			expect(result).toContain("Sheet 1 Data")
			expect(result).toContain("--- Sheet: Second Sheet ---")
			expect(result).toContain("Sheet 2 Data")
		})

		it("should skip hidden sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const hiddenSheet = workbook.addWorksheet("Hidden Sheet")
			hiddenSheet.getCell("A1").value = "Hidden Data"
			hiddenSheet.state = "hidden"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Hidden Sheet ---")
			expect(result).not.toContain("Hidden Data")
		})

		it("should skip very hidden sheets", async () => {
			const workbook = new ExcelJS.Workbook()

			const visibleSheet = workbook.addWorksheet("Visible Sheet")
			visibleSheet.getCell("A1").value = "Visible Data"

			const veryHiddenSheet = workbook.addWorksheet("Very Hidden Sheet")
			veryHiddenSheet.getCell("A1").value = "Very Hidden Data"
			veryHiddenSheet.state = "veryHidden"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Visible Sheet ---")
			expect(result).toContain("Visible Data")
			expect(result).not.toContain("--- Sheet: Very Hidden Sheet ---")
			expect(result).not.toContain("Very Hidden Data")
		})
	})

	describe("formatCellValue logic", () => {
		it("should handle null and undefined values", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = "Before"
			worksheet.getCell("A2").value = null
			worksheet.getCell("A3").value = undefined
			worksheet.getCell("A4").value = "After"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Before")
			expect(result).toContain("After")
			// Should handle null/undefined as empty strings
			const lines = result.split("\n")
			const dataLines = lines.filter((line) => !line.startsWith("---") && line.trim())
			expect(dataLines).toHaveLength(2) // Only 'Before' and 'After' should create content
		})

		it("should format dates correctly", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			const testDate = new Date("2023-12-25")
			worksheet.getCell("A1").value = testDate

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("2023-12-25")
		})

		it("should handle error values", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { error: "#DIV/0!" }

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("[Error: #DIV/0!]")
		})

		it("should handle rich text", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				richText: [{ text: "Hello " }, { text: "World", font: { bold: true } }],
			}

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Hello World")
		})

		it("should handle hyperlinks", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = {
				text: "Roo Code",
				hyperlink: "https://roocode.com/",
			}

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Roo Code (https://roocode.com/)")
		})

		it("should handle formulas with and without results", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { formula: "A2+A3", result: 30 }
			worksheet.getCell("A2").value = { formula: "SUM(B1:B10)" }

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("30") // Formula with result
			expect(result).toContain("[Formula: SUM(B1:B10)]") // Formula without result
		})

		it("should read every cell of a filled-down formula", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// Excel saves a formula filled down a column as one shared formula
			worksheet.getCell("A1").value = { formula: "B1*2", result: 2 }
			worksheet.getCell("A2").value = { sharedFormula: "A1", result: 4 }
			worksheet.getCell("A3").value = { sharedFormula: "A1" }

			const result = await extractTextFromXLSX(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n2\n4\n[Formula: B3*2]")
		})

		it("should read formula errors and dates like plain values", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = { formula: "1/0", result: { error: "#DIV/0!" } }
			worksheet.getCell("B1").value = { formula: "A2+30", result: new Date("2024-10-30T00:00:00.000Z") }
			worksheet.getCell("B1").numFmt = "yyyy-mm-dd"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n[Error: #DIV/0!]\t2024-10-30")
		})

		it("should keep the time of dates and read times of day and durations", async () => {
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
				["1899-12-31T01:00:00.000Z", "[mm]:ss", "25:00:00"],
			]
			cells.forEach(([date, numFmt], index) => {
				const cell = worksheet.getRow(1).getCell(index + 1)
				cell.value = new Date(date)
				cell.numFmt = numFmt
			})

			const result = await extractTextFromXLSX(workbook)

			expect(result).toBe(`--- Sheet: Sheet1 ---\n${cells.map(([, , text]) => text).join("\t")}`)
		})

		it("should count durations from 1904-01-01 in a 1904 workbook", async () => {
			const workbook = new ExcelJS.Workbook()
			workbook.properties.date1904 = true
			const worksheet = workbook.addWorksheet("Sheet1")

			worksheet.getCell("A1").value = new Date("1904-01-02T12:00:00.000Z")
			worksheet.getCell("A1").numFmt = "[h]:mm"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toBe("--- Sheet: Sheet1 ---\n36:00:00")
		})
	})

	describe("edge cases", () => {
		it("should handle empty workbook", async () => {
			const workbook = new ExcelJS.Workbook()
			workbook.addWorksheet("Empty Sheet")

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Empty Sheet ---")
			expect(result.trim()).toBe("--- Sheet: Empty Sheet ---")
		})

		it("should handle workbook with only empty cells", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Sheet1")

			// Set cells but leave them empty
			worksheet.getCell("A1").value = ""
			worksheet.getCell("B1").value = ""

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("--- Sheet: Sheet1 ---")
			// Should not contain any data rows since empty strings don't count as content
			const lines = result.split("\n").filter((line) => line.trim() && !line.startsWith("---"))
			expect(lines).toHaveLength(0)
		})
	})

	describe("function overloads", () => {
		it("should work with workbook objects", async () => {
			const workbook = new ExcelJS.Workbook()
			const worksheet = workbook.addWorksheet("Test")
			worksheet.getCell("A1").value = "Test Data"

			const result = await extractTextFromXLSX(workbook)

			expect(result).toContain("Test Data")
		})

		it("should reject invalid file paths", async () => {
			await expect(extractTextFromXLSX("/non/existent/file.xlsx")).rejects.toThrow()
		})
	})
})
