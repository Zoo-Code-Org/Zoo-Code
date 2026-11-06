import * as vscode from "vscode"

import { exportUsageCsv, neutralizeCsvFormulas } from "../export-usage-csv"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
	workspace: { fs: { writeFile: vi.fn() } },
	window: { showSaveDialog: vi.fn(), showErrorMessage: vi.fn() },
}))

const showSaveDialog = vi.mocked(vscode.window.showSaveDialog)
const writeFile = vi.mocked(vscode.workspace.fs.writeFile)
const showErrorMessage = vi.mocked(vscode.window.showErrorMessage)

describe("exportUsageCsv", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		writeFile.mockResolvedValue(undefined)
	})

	it("writes the CSV to the file the user chose", async () => {
		const saveUri = { fsPath: "/tmp/chosen.csv" } as vscode.Uri
		showSaveDialog.mockResolvedValue(saveUri)

		const saved = await exportUsageCsv("date,cost\n2026-06-01,1.2", "7d")

		expect(saved).toBe(saveUri)
		expect(writeFile).toHaveBeenCalledWith(saveUri, Buffer.from("date,cost\n2026-06-01,1.2", "utf-8"))
		expect(showErrorMessage).not.toHaveBeenCalled()
	})

	it.each([
		["today", "zoo-usage-today.csv"],
		["7d", "zoo-usage-7d.csv"],
		["30d", "zoo-usage-30d.csv"],
		["all", "zoo-usage-all.csv"],
	])("suggests %s as %s, in CSV files", async (range, fileName) => {
		showSaveDialog.mockResolvedValue(undefined)

		await exportUsageCsv("a", range)

		const options = showSaveDialog.mock.calls[0][0]!
		expect(options.defaultUri?.fsPath.endsWith(fileName)).toBe(true)
		expect(options.filters).toEqual({ CSV: ["csv"] })
	})

	it.each([["../../etc/passwd"], ["x.csv"], [""], [42], [undefined], [null]])(
		"builds the file name from a known range only: %j gets the default",
		async (range) => {
			showSaveDialog.mockResolvedValue(undefined)

			await exportUsageCsv("a", range)

			expect(showSaveDialog.mock.calls[0][0]!.defaultUri?.fsPath.endsWith("zoo-usage-all.csv")).toBe(true)
		},
	)

	it("writes nothing if the user cancels the dialog", async () => {
		showSaveDialog.mockResolvedValue(undefined)

		expect(await exportUsageCsv("a", "all")).toBeUndefined()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it.each([[undefined], [null], [""], [42], [{}]])("does nothing for the text %j", async (csv) => {
		expect(await exportUsageCsv(csv, "all")).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("tells the user when the save dialog itself fails, and writes nothing", async () => {
		showSaveDialog.mockRejectedValue(new Error("dialog unavailable"))

		expect(await exportUsageCsv("a", "all")).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("dialog unavailable")
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("writes nothing for text beyond the size limit, and writes all of the text at it", async () => {
		const saveUri = { fsPath: "/tmp/big.csv" } as vscode.Uri
		showSaveDialog.mockResolvedValue(saveUri)

		expect(await exportUsageCsv("a".repeat(20_000_001), "all")).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()

		expect(await exportUsageCsv("a".repeat(20_000_000), "all")).toBe(saveUri)
		expect(writeFile).toHaveBeenCalledTimes(1)
		const [target, bytes] = writeFile.mock.calls[0]
		expect(target).toBe(saveUri)
		expect(bytes).toHaveLength(20_000_000) // all of it, not a truncated copy
	})

	it("tells the user about a failure that is not an Error, as text", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/ro/file.csv" } as vscode.Uri)
		writeFile.mockRejectedValue("disk full")

		expect(await exportUsageCsv("a", "all")).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("disk full")
	})

	it("tells the user when the file cannot be written, and does not report a saved file", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/ro/file.csv" } as vscode.Uri)
		writeFile.mockRejectedValue(new Error("EACCES: permission denied"))

		expect(await exportUsageCsv("a", "all")).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("EACCES: permission denied")
	})
})

describe("neutralizeCsvFormulas", () => {
	beforeEach(() => vi.clearAllMocks())

	// The shape the Usage tab writes: unquoted date and numbers, quoted text, quotes doubled.
	const webviewCsv = [
		"date,task,mode,provider,model,tokensIn,tokensOut,cacheReads,cacheWrites,cost",
		'2026-06-01T12:00:00.000Z,"Add a ""spinner"", then go","code","anthropic","claude-sonnet-5",52000,4100,31000,0,1.8400',
		'\'+275760-09-13T00:00:00.000Z,"\'=1+1","code","","",0,0,0,0,0.0000',
	].join("\n")

	it("leaves a CSV that is already inert exactly as it is", () => {
		expect(neutralizeCsvFormulas(webviewCsv)).toBe(webviewCsv)
		expect(neutralizeCsvFormulas(webviewCsv + "\n")).toBe(webviewCsv) // a final newline adds no empty row
	})

	it.each([
		["=1+1", "'=1+1", "'=1+1"],
		["+SUM(A1)", "'+SUM(A1)", "'+SUM(A1)"],
		["-2+3", "'-2+3", "'-2+3"],
		["@SUM(1)", "'@SUM(1)", "'@SUM(1)"],
		["\tcmd", "'\tcmd", "'\tcmd"],
		// A carriage return inside an unquoted cell makes the cell quoted when it is written again.
		["\rcmd", '"\'\rcmd"', "'\rcmd"],
		// Invisible characters in front of the sign do not hide it.
		["\uFEFF=1+1", "'\uFEFF=1+1", "'\uFEFF=1+1"],
		["\u200B@x", "'\u200B@x", "'\u200B@x"],
		// ... nor do control characters such as NUL, or other format characters (a soft hyphen, a bidirectional mark).
		["\u0000=1+1", "'\u0000=1+1", "'\u0000=1+1"],
		["\u0001\u0000@x", "'\u0001\u0000@x", "'\u0001\u0000@x"],
		["\u00AD-2", "'\u00AD-2", "'\u00AD-2"],
		["\u200E+1", "'\u200E+1", "'\u200E+1"],
	])("prefixes the formula-leading cell %j, quoted or not", (cell, unquotedOut, quotedInnerOut) => {
		// The cell as the webview would write it, in quotes ...
		expect(neutralizeCsvFormulas(`a,"${cell}",b`)).toBe(`a,"${quotedInnerOut.replace(/^"|"$/g, "")}",b`)
		// ... and bare.
		expect(neutralizeCsvFormulas(`a,${cell},b`)).toBe(`a,${unquotedOut},b`)
	})

	it.each([
		["x=1"],
		["a+b"],
		[" =1"],
		["'=1"],
		["1-2"],
		["\uFEFFtext"],
		["\u0000text"], // invisible characters alone do not make a formula
		["\n=1"], // a line feed is text: it is not skipped like a control character
		["\u0000\n=1"],
	])("leaves the cell %j alone", (cell) => {
		expect(neutralizeCsvFormulas(`a,"${cell}",b`)).toBe(`a,"${cell}",b`)
	})

	it.each([["=1"], ["\u0000=1"], ["\uFEFF@x"]])("prefixes %j inside quotes, as the webview writes it", (cell) => {
		expect(neutralizeCsvFormulas(`a,"${cell}",b`)).toBe(`a,"'${cell}",b`)
	})

	// A spreadsheet that does not split on commas: it reads the file with its own list separator, and recognises a quote only
	// at the start of a field. This reads a row that way.
	const fieldsSplitOn = (delimiter: string, csv: string) => {
		const fields: string[] = []
		for (const line of csv.split("\n")) {
			let field = ""
			let inQuotes = false
			let atStart = true
			for (let i = 0; i < line.length; i++) {
				const char = line[i]
				if (inQuotes) {
					if (char !== '"') field += char
					else if (line[i + 1] === '"') ((field += '"'), i++)
					else inQuotes = false
				} else if (char === '"' && atStart) {
					inQuotes = true
					atStart = false
				} else if (char === delimiter) {
					fields.push(field)
					field = ""
					atStart = true
				} else {
					field += char
					atStart = false
				}
			}
			fields.push(field)
		}
		return fields
	}
	const startsAFormula = (field: string) => /^(?:(?!\n)[\p{Cc}\p{Cf}])*[=+\-@\t\r]/u.test(field)

	describe("for a spreadsheet that splits on a semicolon or a tab", () => {
		it.each([
			["a formula after a semicolon in a cell", 'task,"x;=HYPERLINK(""http://e"",""go"")",1'],
			["a formula after a semicolon in a cell that is not quoted", "task,x;=1+1,1"],
			["a formula after a semicolon in a cell, with the quote in the middle of the field", 'a,"b;=1+1",c'],
			["a sign after a semicolon", "task,x;-2+3,1"],
			["an at sign after a semicolon", "task,x;@SUM(1),1"],
			["a formula after a tab in a cell", "task,x\t=1+1,1"],
			["a formula after several separators", "task,x;;\t=1+1,1"],
			["a formula after a semicolon and an invisible character", "task,x;\u0000=1+1,1"],
			["a cell that is a semicolon and a formula", "task,;=1+1,1"],
		])("leaves no field that is a formula, whatever the separator: %s", (_name, csv) => {
			const safe = neutralizeCsvFormulas(csv)!

			for (const delimiter of [",", ";", "\t"]) {
				for (const field of fieldsSplitOn(delimiter, safe)) {
					expect(
						startsAFormula(field),
						`${JSON.stringify(field)} split on ${JSON.stringify(delimiter)}`,
					).toBe(false)
				}
			}
		})

		it("shows that the same text is a formula for a semicolon import when it is left as it was written", () => {
			const written = "task,x;=1+1,1"

			expect(fieldsSplitOn(";", written).some(startsAFormula)).toBe(true)
		})

		it("changes nothing for a semicolon or a tab that is not followed by a formula start", () => {
			const csv = 'task,"a; b;c\td",1'

			expect(neutralizeCsvFormulas(csv)).toBe(csv)
		})

		it("writes the text that follows a semicolon as inert text from exportUsageCsv, whatever the webview sent", async () => {
			const saveUri = { fsPath: "/tmp/chosen.csv" } as vscode.Uri
			showSaveDialog.mockResolvedValue(saveUri)

			await exportUsageCsv("date,task\n2026-06-01,\"x;=cmd|' /c calc'!A0\"", "all")

			const written = writeFile.mock.calls[0][1].toString()
			expect(fieldsSplitOn(";", written).some(startsAFormula)).toBe(false)
		})
	})

	it("neutralises every row and every column, not only the first row or the task text", () => {
		const out = neutralizeCsvFormulas('h1,h2\n1,"=HYPERLINK(""http://x"")"\n"@a",2\n=3,4')

		expect(out).toBe('h1,h2\n1,"\'=HYPERLINK(""http://x"")"\n"\'@a",2\n\'=3,4')
	})

	it("keeps commas, doubled quotes and newlines inside a quoted cell, and judges the cell by its value", () => {
		expect(neutralizeCsvFormulas('"a,b","say ""hi""\nthen go"')).toBe('"a,b","say ""hi""\nthen go"')
		expect(neutralizeCsvFormulas('"x\n=1+1"')).toBe('"x\n=1+1"') // a formula only starts a cell
	})

	it("reads a Windows line ending as one row end", () => {
		expect(neutralizeCsvFormulas("a,b\r\n=c,d")).toBe("a,b\n'=c,d")
	})

	it.each([['a,"never closed'], ['"a","b'], ['"=1+1']])("rejects malformed CSV: %j", (csv) => {
		expect(neutralizeCsvFormulas(csv)).toBeUndefined()
	})

	it("writes only the neutralised text from exportUsageCsv, whatever the webview sent", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockResolvedValue(undefined)

		await exportUsageCsv("date,task\n2026-06-01,\"=cmd|' /C calc'!A0\"\n+1,@x", "all")

		expect(writeFile).toHaveBeenCalledWith(
			expect.anything(),
			Buffer.from("date,task\n2026-06-01,\"'=cmd|' /C calc'!A0\"\n'+1,'@x", "utf-8"),
		)
	})

	it("writes a cell that starts with a byte order mark and a sign as inert text", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockResolvedValue(undefined)

		await exportUsageCsv('h\n"\uFEFF=1+1"', "all")

		expect(writeFile).toHaveBeenCalledWith(expect.anything(), Buffer.from('h\n"\'\uFEFF=1+1"', "utf-8"))
	})

	it("writes a cell that starts with a NUL byte and a sign as inert text, byte for byte", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockResolvedValue(undefined)

		await exportUsageCsv('h\n"\u0000=1+1"\n\u0000@x', "all")

		const [, bytes] = writeFile.mock.calls[0]
		expect(Buffer.from(bytes).toString("utf-8")).toBe("h\n\"'\u0000=1+1\"\n'\u0000@x")
	})

	it("writes nothing for malformed CSV", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockClear()

		expect(await exportUsageCsv('a,"open', "all")).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})
})
