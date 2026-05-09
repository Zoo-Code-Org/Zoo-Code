import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"
import * as RooImport from "../../services/roo-import/RooImport"

import { getVisibleProviderOrLog, handleImportRooHandoff } from "../registerCommands"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("vscode", () => ({
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/mock/workspace",
				},
			},
		],
	},
}))

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../services/roo-import/RooImport", () => ({
	importRooHandoffFromPath: vi.fn(),
	promptAndImportRooHandoff: vi.fn(),
}))

describe("getVisibleProviderOrLog", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
	})

	it("returns the visible provider if found", () => {
		const mockProvider = {} as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible Roo Code instances.")
	})
})

describe("handleImportRooHandoff", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext
	let mockProvider: Partial<ClineProvider>

	beforeEach(() => {
		mockOutputChannel = { appendLine: vi.fn() } as any
		mockContext = { globalStorageUri: { fsPath: "/tmp/zoo" } } as any
		mockProvider = {
			providerSettingsManager: {} as any,
			contextProxy: {} as any,
			customModesManager: {} as any,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		}
		vi.clearAllMocks()
		;(ClineProvider.getInstance as Mock).mockResolvedValue(mockProvider)
	})

	it("returns undefined when no provider is available", async () => {
		;(ClineProvider.getInstance as Mock).mockResolvedValue(undefined)

		const result = await handleImportRooHandoff(undefined, mockContext, mockOutputChannel)

		expect(result).toBeUndefined()
	})

	it("calls importRooHandoffFromPath when a handoff path is given", async () => {
		const mockResult = { success: true, tasksCopied: 2 }
		vi.mocked(RooImport.importRooHandoffFromPath).mockResolvedValue(mockResult)

		const result = await handleImportRooHandoff("/path/to/handoff.json", mockContext, mockOutputChannel)

		expect(RooImport.importRooHandoffFromPath).toHaveBeenCalledWith("/path/to/handoff.json", expect.any(Object))
		expect(mockProvider.postStateToWebview).toHaveBeenCalled()
		expect(result).toBe(mockResult)
	})

	it("calls promptAndImportRooHandoff when no path is given", async () => {
		const mockResult = { success: true, tasksCopied: 0 }
		vi.mocked(RooImport.promptAndImportRooHandoff).mockResolvedValue(mockResult)

		const result = await handleImportRooHandoff(undefined, mockContext, mockOutputChannel)

		expect(RooImport.promptAndImportRooHandoff).toHaveBeenCalled()
		expect(result).toBe(mockResult)
	})

	it("does not call postStateToWebview when import returns undefined", async () => {
		vi.mocked(RooImport.promptAndImportRooHandoff).mockResolvedValue(undefined)

		await handleImportRooHandoff(undefined, mockContext, mockOutputChannel)

		expect(mockProvider.postStateToWebview).not.toHaveBeenCalled()
	})

	it("logs and returns undefined when the import throws", async () => {
		vi.mocked(RooImport.importRooHandoffFromPath).mockRejectedValue(new Error("disk full"))

		const result = await handleImportRooHandoff("/path/to/handoff.json", mockContext, mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("[Roo Import] Failed: disk full")
	})
})
