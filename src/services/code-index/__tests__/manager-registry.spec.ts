import * as vscode from "vscode"
import { makeExtensionContext, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"
import { CodeIndexDisposalError } from "../errors/code-index-disposal-error"

vi.mock("vscode", () => ({
	window: { activeTextEditor: undefined },
	workspace: { workspaceFolders: undefined, getWorkspaceFolder: vi.fn() },
	Uri: { file: vi.fn() },
}))

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { dispose: vi.fn() }
	}),
}))

describe("CodeIndexManagerRegistry", () => {
	let context: vscode.ExtensionContext
	const first: vscode.WorkspaceFolder = { uri: makeUri("/first"), name: "first", index: 0 }
	const second: vscode.WorkspaceFolder = {
		uri: makeUri("/second", { scheme: "vscode-remote", authority: "ssh-remote+host" }),
		name: "second",
		index: 1,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		context = makeExtensionContext()
		vi.mocked(vscode.Uri.file).mockImplementation((value) => makeUri(value))
		Object.defineProperty(vscode.window, "activeTextEditor", { value: undefined, configurable: true })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			value: [first, second],
			configurable: true,
		})
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
	})

	afterEach(() => CodeIndexManagerRegistry.disposeAll())

	it("returns no manager without a workspace or explicit path", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		expect(CodeIndexManagerRegistry.getInstance(context)).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("defaults to the first workspace and reuses its manager", () => {
		const manager = CodeIndexManagerRegistry.getInstance(context)
		expect(CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)).toBe(manager)
		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(first.uri.fsPath, first.uri, context)
	})

	it("uses the active editor workspace and preserves its remote URI", () => {
		const editor = makeTextEditor()
		Object.defineProperty(vscode.window, "activeTextEditor", { value: editor })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		CodeIndexManagerRegistry.getInstance(context)
		expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(editor.document.uri)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context)
	})

	it("falls back to the first workspace when the active editor is outside it", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { value: makeTextEditor() })
		CodeIndexManagerRegistry.getInstance(context)
		expect(CodeIndexManager).toHaveBeenCalledWith(first.uri.fsPath, first.uri, context)
	})

	it("prefers an explicit workspace over the active editor", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { value: makeTextEditor() })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context)
		expect(vscode.workspace.getWorkspaceFolder).not.toHaveBeenCalled()
	})

	it("creates a file URI for an explicit path outside workspace folders", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		const uri = makeUri("/outside")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		CodeIndexManagerRegistry.getInstance(context, "/outside")
		expect(vscode.Uri.file).toHaveBeenCalledWith("/outside")
		expect(CodeIndexManager).toHaveBeenCalledWith("/outside", uri, context)
	})

	it("creates distinct managers for different workspaces", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		const b = CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)!
		expect(a).not.toBe(b)
	})

	it("lists all registered managers", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		const b = CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)!
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([a, b])
	})

	it("disposes every registered manager", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		const b = CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)!
		CodeIndexManagerRegistry.disposeAll()
		expect(a.dispose).toHaveBeenCalledTimes(1)
		expect(b.dispose).toHaveBeenCalledTimes(1)
	})

	it("removes all managers from the registry on disposal", () => {
		CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)
		CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)
		CodeIndexManagerRegistry.disposeAll()
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
	})

	it("does not dispose managers again when cleanup is repeated", () => {
		const manager = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		CodeIndexManagerRegistry.disposeAll()
		CodeIndexManagerRegistry.disposeAll()
		expect(manager.dispose).toHaveBeenCalledTimes(1)
	})

	it("creates a new manager for the same workspace after disposal", () => {
		const manager = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		CodeIndexManagerRegistry.disposeAll()
		expect(CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)).not.toBe(manager)
	})

	it("attempts every disposal and reports all errors", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		const b = CodeIndexManagerRegistry.getInstance(context, second.uri.fsPath)!
		const firstError = new Error("first cleanup failed")
		const secondError = new Error("second cleanup failed")
		vi.mocked(a.dispose).mockImplementation(() => {
			throw firstError
		})
		vi.mocked(b.dispose).mockImplementation(() => {
			throw secondError
		})
		let caught: unknown
		try {
			CodeIndexManagerRegistry.disposeAll()
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(CodeIndexDisposalError)
		if (!(caught instanceof CodeIndexDisposalError)) throw new Error("Expected disposal error")
		expect(caught.name).toBe("CodeIndexDisposalError")
		expect(caught.errors).toEqual([firstError, secondError])
		expect(caught.errors[0]).toBe(firstError)
		expect(caught.errors[1]).toBe(secondError)
		expect(caught.message).toBe(
			"Failed to dispose code index managers (2 errors):\n1. first cleanup failed\n2. second cleanup failed",
		)
		expect(b.dispose).toHaveBeenCalledTimes(1)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
	})

	it("preserves non-Error thrown values in disposal diagnostics", () => {
		const manager = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		vi.mocked(manager.dispose).mockImplementation(() => {
			throw "cleanup rejected"
		})
		expect(() => CodeIndexManagerRegistry.disposeAll()).toThrow(
			"Failed to dispose code index managers (1 errors):\n1. cleanup rejected",
		)
	})

	it("clears the registry before disposal callbacks run", () => {
		const manager = CodeIndexManagerRegistry.getInstance(context, first.uri.fsPath)!
		vi.mocked(manager.dispose).mockImplementation(() => {
			expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		})
		CodeIndexManagerRegistry.disposeAll()
	})
})
