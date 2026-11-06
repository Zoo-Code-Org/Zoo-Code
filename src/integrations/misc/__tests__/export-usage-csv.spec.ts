import * as os from "os"
import * as path from "path"
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

const stored = new Map<string, unknown>()
const context = {
	getValue: vi.fn((key: string) => stored.get(key)),
	setValue: vi.fn(async (key: string, value: unknown) => void stored.set(key, value)),
}

describe("exportUsageCsv", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		stored.clear()
		writeFile.mockResolvedValue(undefined)
	})

	describe("the folder of the dialog", () => {
		it("opens in Downloads at first, and remembers the folder the file was saved in", async () => {
			showSaveDialog.mockResolvedValue({ fsPath: "/work/reports/chosen.csv" } as vscode.Uri)

			await exportUsageCsv("a", "30d", context)

			expect(showSaveDialog.mock.calls[0][0]!.defaultUri?.fsPath).toBe(
				path.join(os.homedir(), "Downloads", "zoo-usage-30d.csv"),
			)
			expect(stored.get("lastUsageExportPath")).toBe("/work/reports/chosen.csv")
		})

		it("opens in the folder of the last export, with the name of this range", async () => {
			stored.set("lastUsageExportPath", "/work/reports/chosen.csv")
			showSaveDialog.mockResolvedValue(undefined)

			await exportUsageCsv("a", "7d", context)

			expect(showSaveDialog.mock.calls[0][0]!.defaultUri?.fsPath).toBe(
				path.join("/work/reports", "zoo-usage-7d.csv"),
			)
		})

		it("remembers nothing when the user cancels, or when nothing was written", async () => {
			showSaveDialog.mockResolvedValue(undefined)
			await exportUsageCsv("a", "all", context)

			showSaveDialog.mockResolvedValue({ fsPath: "/x/y.csv" } as vscode.Uri)
			writeFile.mockRejectedValue(new Error("disk full"))
			await exportUsageCsv("a", "all", context)

			expect(context.setValue).not.toHaveBeenCalled()
		})

		it("still reports the saved file when the folder cannot be remembered", async () => {
			const saveUri = { fsPath: "/x/y.csv" } as vscode.Uri
			showSaveDialog.mockResolvedValue(saveUri)
			context.setValue.mockRejectedValueOnce(new Error("state unavailable"))

			expect(await exportUsageCsv("a", "all", context)).toBe(saveUri)
			expect(showErrorMessage).not.toHaveBeenCalled()
		})
	})

	it("writes the CSV to the file the user chose", async () => {
		const saveUri = { fsPath: "/tmp/chosen.csv" } as vscode.Uri
		showSaveDialog.mockResolvedValue(saveUri)

		const saved = await exportUsageCsv("date,cost\n2026-06-01,1.2", "7d", context)

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

		await exportUsageCsv("a", range, context)

		const options = showSaveDialog.mock.calls[0][0]!
		expect(options.defaultUri?.fsPath.endsWith(fileName)).toBe(true)
		expect(options.filters).toEqual({ CSV: ["csv"] })
	})

	it.each([["../../etc/passwd"], ["x.csv"], [""], [42], [undefined], [null]])(
		"builds the file name from a known range only: %j gets the default",
		async (range) => {
			showSaveDialog.mockResolvedValue(undefined)

			await exportUsageCsv("a", range, context)

			expect(showSaveDialog.mock.calls[0][0]!.defaultUri?.fsPath.endsWith("zoo-usage-all.csv")).toBe(true)
		},
	)

	it("writes nothing if the user cancels the dialog", async () => {
		showSaveDialog.mockResolvedValue(undefined)

		expect(await exportUsageCsv("a", "all", context)).toBeUndefined()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it.each([[undefined], [null], [""], [42], [{}]])("does nothing for the text %j", async (csv) => {
		expect(await exportUsageCsv(csv, "all", context)).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("tells the user when the save dialog itself fails, and writes nothing", async () => {
		showSaveDialog.mockRejectedValue(new Error("dialog unavailable"))

		expect(await exportUsageCsv("a", "all", context)).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("dialog unavailable")
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("writes nothing for text beyond the size limit, and writes all of the text at it", async () => {
		const saveUri = { fsPath: "/tmp/big.csv" } as vscode.Uri
		showSaveDialog.mockResolvedValue(saveUri)

		expect(await exportUsageCsv("a".repeat(20_000_001), "all", context)).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()

		expect(await exportUsageCsv("a".repeat(20_000_000), "all", context)).toBe(saveUri)
		expect(writeFile).toHaveBeenCalledTimes(1)
		const [target, bytes] = writeFile.mock.calls[0]
		expect(target).toBe(saveUri)
		expect(bytes).toHaveLength(20_000_000) // all of it, not a truncated copy
	})

	it("tells the user about a failure that is not an Error, as text", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/ro/file.csv" } as vscode.Uri)
		writeFile.mockRejectedValue("disk full")

		expect(await exportUsageCsv("a", "all", context)).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("disk full")
	})

	it("tells the user when the file cannot be written, and does not report a saved file", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/ro/file.csv" } as vscode.Uri)
		writeFile.mockRejectedValue(new Error("EACCES: permission denied"))

		expect(await exportUsageCsv("a", "all", context)).toBeUndefined()
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
		["line\ntext"], // a line break inside a cell is text, as long as what follows it is not a formula
		["\nnot a formula"],
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
					else if (line[i + 1] === '"') {
						field += '"'
						i++
					} else inQuotes = false
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

	describe("for a quote after a separator inside a cell", () => {
		// What is written when a cell has a formula behind quotes: a separator, quotes (doubled in the file), a sign.
		const formulaBehindQuotes = /[;\t\r\n](?:""|\p{Cc}|\p{Cf})*[=+\-@]/u

		it.each([
			["a semicolon", 'a,"x;""=1+1;end"', ";"],
			["a tab", 'a,"x\t""=1+1\tend"', "\t"],
			["several quotes", 'a,"x;""""""@SUM(1)"', ";"],
			["quotes and an invisible character", 'a,"x;""\u0000""-2+3"', ";"],
			["a line break", 'a,"x\n""=1+1"', "\n"],
		])("breaks the formula start behind the quotes after %s", (_name, csv, delimiter) => {
			const safe = neutralizeCsvFormulas(csv)!

			expect(safe, JSON.stringify(safe)).not.toMatch(formulaBehindQuotes)
			expect(fieldsSplitOn(delimiter, safe).some(startsAFormula), JSON.stringify(safe)).toBe(false)
			expect(safe).toContain(`${delimiter}'`) // the apostrophe is in front of the quotes
		})

		it("shows that the crafted cell was a formula behind its quote when it was written as it came", () => {
			const crafted = 'a,"x;""=1+1;end"'

			expect(crafted).toMatch(formulaBehindQuotes)
			expect(fieldsSplitOn(";", crafted).some(startsAFormula)).toBe(true)
		})

		it("writes the crafted cell as inert text from exportUsageCsv, for comma, semicolon and tab imports", async () => {
			showSaveDialog.mockResolvedValue({ fsPath: "/tmp/chosen.csv" } as vscode.Uri)

			await exportUsageCsv('date,task\n2026,"x;""=1+1;end"', "all", context)

			const written = writeFile.mock.calls[0][1].toString()
			expect(written).not.toMatch(formulaBehindQuotes)
			for (const delimiter of [",", ";", "\t"]) {
				expect(fieldsSplitOn(delimiter, written).some(startsAFormula), JSON.stringify(written)).toBe(false)
			}
		})

		it("leaves a quote after a separator alone when no formula follows it", () => {
			expect(neutralizeCsvFormulas('a,"x;""quoted"" text"')).toBe('a,"x;""quoted"" text"')
		})

		it("still takes a pass over the text for a long run of separators and quotes", () => {
			const started = performance.now()
			neutralizeCsvFormulas(`a,"${';""'.repeat(100_000)}x",b`)
			expect((performance.now() - started) / 1000).toBeLessThan(2)
		})
	})

	describe("for a line break inside a cell", () => {
		it.each([
			["the crafted message", 'date,task\n2026,"note\n=1+1\nend"'],
			["after a carriage return", 'date,task\n2026,"note\r=1+1\rend"'],
			["after a Windows line ending", 'date,task\n2026,"note\r\n@SUM(1)\r\nend"'],
			["after several line breaks and an invisible character", 'date,task\n2026,"a\n\n\u0000-2+3\nend"'],
			["in a cell that is not quoted by the webview but is multiline once written", 'date,task\n2026,"x\n+1"'],
		])("is inert in every line, for comma, semicolon and tab imports: %s", (_name, csv) => {
			const safe = neutralizeCsvFormulas(csv)!

			// An application that ends a row at every line break whatever quotes are open reads each line as a row.
			for (const delimiter of [",", ";", "\t"]) {
				for (const field of fieldsSplitOn(delimiter, safe.replace(/\r(?!\n)/g, "\n").replace(/\r\n/g, "\n"))) {
					expect(
						startsAFormula(field),
						`${JSON.stringify(field)} split on ${JSON.stringify(delimiter)}`,
					).toBe(false)
				}
			}
		})

		it("shows that the crafted message was a formula on its second line when it was written as it came", () => {
			const written = 'date,task\n2026,"note\n=1+1\nend"'

			expect(fieldsSplitOn(",", written).some(startsAFormula)).toBe(true) // a line that starts with =
		})

		it("writes the crafted message as inert text from exportUsageCsv", async () => {
			const saveUri = { fsPath: "/tmp/chosen.csv" } as vscode.Uri
			showSaveDialog.mockResolvedValue(saveUri)

			await exportUsageCsv('date,task\n2026,"note\n=1+1\nend"', "all", context)

			const written = writeFile.mock.calls[0][1].toString()
			for (const delimiter of [",", ";", "\t"]) {
				expect(fieldsSplitOn(delimiter, written).some(startsAFormula)).toBe(false)
			}
		})
	})

	describe("on text that is built to be slow", () => {
		const secondsFor = (csv: string) => {
			const started = performance.now()
			neutralizeCsvFormulas(csv)
			return (performance.now() - started) / 1000
		}

		it.each([
			["a long run of tabs in a cell", `a,"${"\t".repeat(200_000)}",b`],
			["a long run of tabs and semicolons", `a,"${";\t".repeat(100_000)}x",b`],
			["a long run of line breaks", `a,"${"\n".repeat(200_000)}",b`],
			["a long run of invisible characters between separators", `a,"${";\u0000".repeat(100_000)}x",b`],
			["a long run of tabs followed by a formula", `a,"${"\t".repeat(200_000)}=1",b`],
		])("takes a pass over the text, not a pass for every separator: %s", (_name, csv) => {
			expect(secondsFor(csv)).toBeLessThan(2) // quadratic scanning of 200 000 separators takes minutes
		})

		it("still breaks every formula start in such a run", () => {
			const safe = neutralizeCsvFormulas(`a,"${"\t".repeat(1000)}=1",b`)!

			for (const delimiter of [",", ";", "\t"]) {
				expect(fieldsSplitOn(delimiter, safe).some(startsAFormula)).toBe(false)
			}
		})
	})

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

			await exportUsageCsv("date,task\n2026-06-01,\"x;=cmd|' /c calc'!A0\"", "all", context)

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
		// A line break inside a cell can end a row for an application that ignores the quotes: what follows it is a start too.
		expect(neutralizeCsvFormulas('"x\n=1+1"')).toBe('"x\n\'=1+1"')
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

		await exportUsageCsv("date,task\n2026-06-01,\"=cmd|' /C calc'!A0\"\n+1,@x", "all", context)

		expect(writeFile).toHaveBeenCalledWith(
			expect.anything(),
			Buffer.from("date,task\n2026-06-01,\"'=cmd|' /C calc'!A0\"\n'+1,'@x", "utf-8"),
		)
	})

	it("writes a cell that starts with a byte order mark and a sign as inert text", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockResolvedValue(undefined)

		await exportUsageCsv('h\n"\uFEFF=1+1"', "all", context)

		expect(writeFile).toHaveBeenCalledWith(expect.anything(), Buffer.from('h\n"\'\uFEFF=1+1"', "utf-8"))
	})

	it("writes a cell that starts with a NUL byte and a sign as inert text, byte for byte", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockResolvedValue(undefined)

		await exportUsageCsv('h\n"\u0000=1+1"\n\u0000@x', "all", context)

		const [, bytes] = writeFile.mock.calls[0]
		expect(Buffer.from(bytes).toString("utf-8")).toBe("h\n\"'\u0000=1+1\"\n'\u0000@x")
	})

	it("writes nothing for malformed CSV", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/tmp/out.csv" } as vscode.Uri)
		writeFile.mockClear()

		expect(await exportUsageCsv('a,"open', "all", context)).toBeUndefined()
		expect(showSaveDialog).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})
})
