const mocks = vi.hoisted(() => ({
	writeFile: vi.fn(),
	buildDiagnosticsReport: vi.fn(),
	getStorageBasePath: vi.fn(),
	openTextDocument: vi.fn(),
	showTextDocument: vi.fn(),
	writeText: vi.fn(),
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
}))

vi.mock("fs/promises", () => ({ writeFile: mocks.writeFile }))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: mocks.getStorageBasePath }))
vi.mock("../report", () => ({ buildDiagnosticsReport: mocks.buildDiagnosticsReport }))
vi.mock("vscode", () => ({
	version: "1.100.0",
	UIKind: { Desktop: 1, Web: 2 },
	ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
	env: {
		appName: "Visual Studio Code",
		uiKind: 1,
		language: "en",
		remoteName: undefined,
		clipboard: { writeText: mocks.writeText },
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => "") })),
		openTextDocument: mocks.openTextDocument,
	},
	window: {
		activeColorTheme: { kind: 2 },
		showTextDocument: mocks.showTextDocument,
		showInformationMessage: mocks.showInformationMessage,
		showWarningMessage: mocks.showWarningMessage,
		showErrorMessage: mocks.showErrorMessage,
	},
}))

import type * as vscode from "vscode"

import { createDiagnosticsReport } from "../command"

describe("createDiagnosticsReport", () => {
	const outputChannel = { appendLine: vi.fn() } as Pick<vscode.OutputChannel, "appendLine"> as vscode.OutputChannel
	const context = {
		globalStorageUri: { fsPath: "/private/storage/path" },
	} as Pick<vscode.ExtensionContext, "globalStorageUri"> as vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getStorageBasePath.mockResolvedValue("/private/storage/path")
		mocks.buildDiagnosticsReport.mockResolvedValue({ schemaVersion: 1, privacy: { uploaded: false } })
		mocks.writeFile.mockResolvedValue(undefined)
		mocks.openTextDocument.mockResolvedValue({})
		mocks.showTextDocument.mockResolvedValue(undefined)
		mocks.writeText.mockResolvedValue(undefined)
	})

	it("writes valid JSON to temp, opens it, and copies the same JSON without a provider", async () => {
		await createDiagnosticsReport({ context, outputChannel, providers: [] })

		expect(mocks.buildDiagnosticsReport).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }))
		expect(mocks.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(/zoo-code-diagnostics-\d+-[a-f0-9]{8}\.json$/),
			expect.any(String),
			"utf8",
		)
		const json = mocks.writeFile.mock.calls[0][1]
		expect(() => JSON.parse(json)).not.toThrow()
		expect(mocks.writeText).toHaveBeenCalledWith(json)
		expect(mocks.openTextDocument).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0][0])
		expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("No data was uploaded"))
	})

	it("reports only a sanitized failure category", async () => {
		mocks.writeFile.mockRejectedValue(new Error("secret path /Users/person/report.json"))

		await createDiagnosticsReport({ context, outputChannel, providers: [] })

		expect(outputChannel.appendLine).toHaveBeenCalledWith("[createDiagnosticsReport] failed: Error")
		expect(outputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("/Users/person"))
		expect(mocks.showErrorMessage).toHaveBeenCalledWith("Zoo Code could not create the diagnostics report.")
	})

	it("still copies the report when opening the document fails", async () => {
		mocks.openTextDocument.mockRejectedValue(new Error("editor unavailable"))

		await createDiagnosticsReport({ context, outputChannel, providers: [] })

		expect(mocks.writeText).toHaveBeenCalledTimes(1)
		expect(outputChannel.appendLine).toHaveBeenCalledWith("[createDiagnosticsReport] open failed")
		expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not open or copy"))
	})
})
