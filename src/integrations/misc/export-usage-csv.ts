import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

const USAGE_RANGES: readonly string[] = ["today", "7d", "30d", "all"]

/**
 * What starts a cell that a spreadsheet may evaluate: = + - @, a tab or a carriage return, and the same after
 * invisible characters that an application may skip: control characters such as NUL (a line feed is text, not
 * skipped) and format characters such as a byte order mark or the zero-width ones.
 */
const FORMULA_START = /^(?:(?!\n)[\p{Cc}\p{Cf}])*[=+\-@\t\r]/u

/**
 * A spreadsheet may split a row on a semicolon (the list separator of many locales) or a tab as well as on a comma, and
 * it recognises a quote only at the start of a field: so the text after a semicolon or a tab inside a cell can start a
 * field of its own, whatever quotes surround the cell. A formula start there is broken as well.
 */
const FORMULA_AFTER_FIELD_SEPARATOR = /([;\t])(?=(?:(?!\n)[\p{Cc}\p{Cf}])*[=+\-@\t\r])/gu

/** The most text the host writes for an export: ten years of daily tasks is far below it, a runaway message is not. */
const MAX_USAGE_CSV_LENGTH = 20_000_000

/**
 * Makes every cell of a CSV inert for a spreadsheet: a cell that starts with = + - @ (or a tab or carriage return) is
 * evaluated as a formula by a spreadsheet, so it gets a leading apostrophe, and so does the text that follows a
 * semicolon or a tab inside a cell (where a spreadsheet that splits on those starts a new field). The text is parsed and written again, so
 * a cell is judged by its value, however it was quoted. Returns `undefined` for text that is not well-formed CSV
 * (a quote that is never closed). Text that is already inert comes back unchanged.
 */
export function neutralizeCsvFormulas(csv: string): string | undefined {
	const rows: { value: string; quoted: boolean }[][] = []
	let row: { value: string; quoted: boolean }[] = []
	let value = ""
	let quoted = false
	let inQuotes = false
	// Whether anything has been read since the last row ended, so a final newline does not make an empty row.
	let pending = false

	const endField = () => {
		row.push({ value, quoted })
		value = ""
		quoted = false
	}
	const endRow = () => {
		endField()
		rows.push(row)
		row = []
		pending = false
	}

	for (let i = 0; i < csv.length; i++) {
		const char = csv[i]
		pending = true
		if (inQuotes) {
			if (char !== '"') {
				value += char
			} else if (csv[i + 1] === '"') {
				value += '"'
				i++
			} else {
				inQuotes = false
			}
		} else if (char === '"' && value === "" && !quoted) {
			inQuotes = true
			quoted = true
		} else if (char === ",") {
			endField()
		} else if (char === "\n" || (char === "\r" && csv[i + 1] === "\n")) {
			if (char === "\r") i++
			endRow()
		} else {
			value += char
		}
	}
	if (inQuotes) return undefined
	if (pending) endRow()

	return rows
		.map((cells) =>
			cells
				.map((cell) => {
					const started = FORMULA_START.test(cell.value) ? `'${cell.value}` : cell.value
					const safe = started.replace(FORMULA_AFTER_FIELD_SEPARATOR, "$1'")
					return cell.quoted || /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
				})
				.join(","),
		)
		.join("\n")
}

/**
 * Saves the Usage tab's CSV where the user chooses. A webview cannot reliably download a file, so, like every other
 * export, the webview sends the text and the host writes it. The file name is built here from a known range, never
 * from the message. Resolves to the saved file, or `undefined` if the user cancelled, there was nothing to save, or the dialog or the write failed (the user is told).
 */
export async function exportUsageCsv(csv: unknown, range: unknown): Promise<vscode.Uri | undefined> {
	if (typeof csv !== "string" || csv.length === 0 || csv.length > MAX_USAGE_CSV_LENGTH) return undefined
	// The text comes from a webview: whatever it holds, no cell of the saved file is a formula.
	const safeCsv = neutralizeCsvFormulas(csv)
	if (safeCsv === undefined) return undefined

	const name = `zoo-usage-${typeof range === "string" && USAGE_RANGES.includes(range) ? range : "all"}.csv`
	try {
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
			filters: { CSV: ["csv"] },
		})
		if (!saveUri) return undefined

		await vscode.workspace.fs.writeFile(saveUri, Buffer.from(safeCsv, "utf-8"))
		return saveUri
	} catch (error) {
		vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
		return undefined
	}
}
