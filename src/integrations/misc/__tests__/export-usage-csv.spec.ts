import * as vscode from "vscode"

import { exportUsageCsv } from "../export-usage-csv"

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

	it("tells the user when the file cannot be written, and does not report a saved file", async () => {
		showSaveDialog.mockResolvedValue({ fsPath: "/ro/file.csv" } as vscode.Uri)
		writeFile.mockRejectedValue(new Error("EACCES: permission denied"))

		expect(await exportUsageCsv("a", "all")).toBeUndefined()
		expect(showErrorMessage).toHaveBeenCalledWith("EACCES: permission denied")
	})
})
