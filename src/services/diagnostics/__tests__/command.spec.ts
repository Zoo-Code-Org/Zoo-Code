const mocks = vi.hoisted(() => ({
	buildDiagnosticsReport: vi.fn(),
	getStorageBasePath: vi.fn(),
	openTextDocument: vi.fn(),
	showTextDocument: vi.fn(),
	writeText: vi.fn(),
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
}))

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

import * as vscode from "vscode"

import { createDiagnosticsReport } from "../command"

describe("createDiagnosticsReport", () => {
	// The command uses only appendLine on the output channel.
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
	// The command uses only globalStorageUri.fsPath from the extension context.
	const context = {
		globalStorageUri: { fsPath: "/private/storage/path" },
	} as unknown as vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getStorageBasePath.mockResolvedValue("/private/storage/path")
		mocks.buildDiagnosticsReport.mockResolvedValue({ schemaVersion: 1, privacy: { uploaded: false } })
		mocks.openTextDocument.mockResolvedValue({})
		mocks.showTextDocument.mockResolvedValue(undefined)
		mocks.writeText.mockResolvedValue(undefined)
	})

	it("opens an untitled JSON document and copies the same JSON without a provider", async () => {
		await createDiagnosticsReport({ context, outputChannel, providers: [] })

		expect(mocks.buildDiagnosticsReport).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }))
		expect(mocks.openTextDocument).toHaveBeenCalledWith({
			content: JSON.stringify({ schemaVersion: 1, privacy: { uploaded: false } }, null, 2),
			language: "json",
		})
		const json = mocks.openTextDocument.mock.calls[0][0].content
		expect(() => JSON.parse(json)).not.toThrow()
		expect(mocks.writeText).toHaveBeenCalledWith(json)
		expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("No data was uploaded"))
	})

	it("reports only a sanitized failure category", async () => {
		mocks.buildDiagnosticsReport.mockRejectedValue(new Error("secret path /Users/person/report.json"))

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

	it.each([
		[1, "light"],
		[2, "dark"],
		[3, "highContrast"],
		[4, "highContrastLight"],
		[99, "unknown"],
	] as const)("includes theme kind %s as %s", async (kind, expected) => {
		// Include an unknown runtime enum value to exercise the forward-compatible fallback.
		vi.spyOn(vscode.window, "activeColorTheme", "get").mockReturnValue({ kind: kind as vscode.ColorThemeKind })
		try {
			await createDiagnosticsReport({ context, outputChannel, providers: [] })
			expect(mocks.buildDiagnosticsReport).toHaveBeenCalledWith(
				expect.objectContaining({ environment: expect.objectContaining({ colorThemeKind: expected }) }),
			)
		} finally {
			vi.restoreAllMocks()
		}
	})

	it("opens the report even when the clipboard is unavailable", async () => {
		mocks.writeText.mockRejectedValueOnce(new Error("private clipboard failure"))
		await createDiagnosticsReport({ context, outputChannel, providers: [] })
		expect(mocks.showTextDocument).toHaveBeenCalledTimes(1)
		expect(outputChannel.appendLine).toHaveBeenCalledWith("[createDiagnosticsReport] copy failed")
		expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1)
		expect(mocks.showInformationMessage).not.toHaveBeenCalled()
	})

	it("contains non-Error failures without exposing the rejected value", async () => {
		mocks.getStorageBasePath.mockRejectedValueOnce("secret storage path")
		await createDiagnosticsReport({ context, outputChannel, providers: [] })
		expect(outputChannel.appendLine).toHaveBeenCalledWith("[createDiagnosticsReport] failed: UnknownError")
		expect(mocks.openTextDocument).not.toHaveBeenCalled()
		expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1)
	})
})
