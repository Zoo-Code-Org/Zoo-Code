import ExcelJS from "exceljs"

const ROW_LIMIT = 50000

/**
 * Excel stores a date or a time as a day count shown through the cell's number format, and
 * ExcelJS hands it over as a UTC Date. Outside quoted text, escaped characters and [...] sections,
 * a format with a day, a year, or a month with no hour or second beside it (mmm) shows a date.
 * Any other format is a time of day or, with [h], [m] or [s], an elapsed duration. Those count
 * from day 0 (1899-12-30, or 1904-01-01 in a 1904 workbook), so they must not read as a date.
 */
function formatDate(date: Date, cell: ExcelJS.Cell): string {
	// Round to the second, as Excel shows it: a NOW() stamp of 14:04:59.9 reads 14:05:00
	const time = Math.round(date.getTime() / 1000) * 1000
	const iso = new Date(time).toISOString()
	const numFmt = cell.numFmt ?? ""
	const elapsed = /\[(h+|m+|s+)\]/i.exec(numFmt)
	const tokens = numFmt.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")
	const isDate = !numFmt || /[dy]/i.test(tokens) || (/m/i.test(tokens) && !/[hs]/i.test(tokens))
	if (!elapsed && isDate) {
		return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ")
	}
	if (!elapsed) {
		return iso.slice(11, 19)
	}
	const epoch = cell.worksheet.workbook.properties.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
	const seconds = (time - epoch) / 1000
	const pad = (n: number) => String(n).padStart(2, "0")
	// Elapsed time counts in the unit of its bracket: [mm]:ss of 25 hours reads 1500:00
	const unit = elapsed[1][0].toLowerCase()
	if (unit === "s") {
		return String(seconds)
	}
	if (unit === "m") {
		return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
	}
	return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

function formatCellValue(cell: ExcelJS.Cell): string {
	let value = cell.value
	if (value === null || value === undefined) {
		return ""
	}

	// Handle formulas - read the calculated result like a plain value. The cells of a formula
	// filled down or across hold { sharedFormula, result }; cell.formula gives their formula.
	// The result comes from cell.result: ExcelJS leaves a cached 0 or false out of cell.value.
	if (typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
		const result = cell.result
		if (result === undefined || result === null) {
			return `[Formula: ${cell.formula}]`
		}
		value = result
	}

	// Handle error values (#DIV/0!, #N/A, etc.)
	if (typeof value === "object" && "error" in value) {
		return `[Error: ${value.error}]`
	}

	// Handle dates - ExcelJS can parse them as Date objects
	if (value instanceof Date) {
		return formatDate(value, cell)
	}

	// Handle rich text
	if (typeof value === "object" && "richText" in value) {
		return value.richText.map((rt) => rt.text).join("")
	}

	// Handle hyperlinks
	if (typeof value === "object" && "text" in value && "hyperlink" in value) {
		return `${value.text} (${value.hyperlink})`
	}

	return value.toString()
}

export async function extractTextFromXLSX(filePathOrWorkbook: string | ExcelJS.Workbook): Promise<string> {
	let workbook: ExcelJS.Workbook
	let excelText = ""

	if (typeof filePathOrWorkbook === "string") {
		workbook = new ExcelJS.Workbook()
		await workbook.xlsx.readFile(filePathOrWorkbook)
	} else {
		workbook = filePathOrWorkbook
	}

	workbook.eachSheet((worksheet, sheetId) => {
		if (worksheet.state === "hidden" || worksheet.state === "veryHidden") {
			return
		}

		excelText += `--- Sheet: ${worksheet.name} ---\n`

		worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
			if (rowNumber > ROW_LIMIT) {
				excelText += `[... truncated at row ${rowNumber} ...]\n`
				return false
			}

			const rowTexts: string[] = []
			let hasContent = false

			row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
				const cellText = formatCellValue(cell)
				if (cellText.trim()) {
					hasContent = true
				}
				rowTexts.push(cellText)
			})

			if (hasContent) {
				excelText += rowTexts.join("\t") + "\n"
			}

			return true
		})

		excelText += "\n"
	})

	return excelText.trim()
}
