import * as vscode from "vscode"
import { makeExtensionContext, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { codeIndexScopeRegistry } from "../code-index-scope-registry"
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

vi.mock("../state-manager", () => ({
	CodeIndexStateManager: vi.fn().mockImplementation(function () {
		return { init: vi.fn(), dispose: vi.fn() }
	}),
}))

describe("codeIndexScopeRegistry", () => {
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

	afterEach(async () => codeIndexScopeRegistry.disposeAll())

	it("returns no scope without a workspace or explicit path", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		expect(codeIndexScopeRegistry.getScope(context)).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("returns no scope for an explicitly empty path", () => {
		expect(codeIndexScopeRegistry.getScope(context, "")).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("defaults to the first workspace and reuses its scope", () => {
		const scope = codeIndexScopeRegistry.getScope(context)
		expect(codeIndexScopeRegistry.getScope(context, first.uri.fsPath)).toBe(scope)
		expect(CodeIndexManager).toHaveBeenCalledExactlyOnceWith(
			first.uri.fsPath,
			first.uri,
			context,
			expect.anything(),
		)
	})

	it("does not register individual managers for extension-context disposal", () => {
		const manager = codeIndexScopeRegistry.getScope(context)
		expect(context.subscriptions).not.toContain(manager)
	})

	it("uses the active editor workspace and preserves its remote URI", () => {
		const editor = makeTextEditor()
		Object.defineProperty(vscode.window, "activeTextEditor", { value: editor })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		codeIndexScopeRegistry.getScope(context)
		expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(editor.document.uri)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context, expect.anything())
	})

	it("falls back to the first workspace when the active editor is outside it", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { value: makeTextEditor() })
		codeIndexScopeRegistry.getScope(context)
		expect(CodeIndexManager).toHaveBeenCalledWith(first.uri.fsPath, first.uri, context, expect.anything())
	})

	it("prefers an explicit workspace over the active editor", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { value: makeTextEditor() })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		codeIndexScopeRegistry.getScope(context, second.uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(second.uri.fsPath, second.uri, context, expect.anything())
		expect(vscode.workspace.getWorkspaceFolder).not.toHaveBeenCalled()
	})

	it("creates a file URI for an explicit path outside workspace folders", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { value: undefined })
		const uri = makeUri("/outside")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		codeIndexScopeRegistry.getScope(context, "/outside")
		expect(vscode.Uri.file).toHaveBeenCalledWith("/outside")
		expect(CodeIndexManager).toHaveBeenCalledWith("/outside", uri, context, expect.anything())
	})

	it("creates a file URI for an explicit path that matches no workspace folder", () => {
		const explicitPath = "/outside"
		const uri = makeUri(explicitPath)
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)

		codeIndexScopeRegistry.getScope(context, explicitPath)

		expect(vscode.Uri.file).toHaveBeenCalledWith(explicitPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(explicitPath, uri, context, expect.anything())
	})

	it("creates distinct scopes for different workspaces", () => {
		const a = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const b = codeIndexScopeRegistry.getScope(context, second.uri.fsPath)!
		expect(a).not.toBe(b)
	})

	it("lists all registered scopes", () => {
		const a = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const b = codeIndexScopeRegistry.getScope(context, second.uri.fsPath)!
		expect(codeIndexScopeRegistry.getAllScopes()).toEqual([a, b])
	})

	it("disposes every registered scope", async () => {
		const a = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const b = codeIndexScopeRegistry.getScope(context, second.uri.fsPath)!
		const disposeA = vi.spyOn(a, "dispose")
		const disposeB = vi.spyOn(b, "dispose")
		await codeIndexScopeRegistry.disposeAll()
		expect(disposeA).toHaveBeenCalledTimes(1)
		expect(disposeB).toHaveBeenCalledTimes(1)
	})

	it("removes all scopes from the registry on disposal", async () => {
		codeIndexScopeRegistry.getScope(context, first.uri.fsPath)
		codeIndexScopeRegistry.getScope(context, second.uri.fsPath)
		await codeIndexScopeRegistry.disposeAll()
		expect(codeIndexScopeRegistry.getAllScopes()).toEqual([])
	})

	it("does not dispose scopes again when cleanup is repeated", async () => {
		const scope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const dispose = vi.spyOn(scope, "dispose")
		await codeIndexScopeRegistry.disposeAll()
		await codeIndexScopeRegistry.disposeAll()
		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it("creates a new scope for the same workspace after disposal", async () => {
		const scope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		await codeIndexScopeRegistry.disposeAll()
		expect(codeIndexScopeRegistry.getScope(context, first.uri.fsPath)).not.toBe(scope)
	})

	it("attempts every disposal and reports all errors", async () => {
		const a = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const b = codeIndexScopeRegistry.getScope(context, second.uri.fsPath)!
		const firstError = new Error("first cleanup failed")
		const secondError = new Error("second cleanup failed")
		vi.spyOn(a, "dispose").mockImplementation(() => {
			throw firstError
		})
		const disposeB = vi.spyOn(b, "dispose").mockImplementation(() => {
			throw secondError
		})
		let caught: unknown
		try {
			await codeIndexScopeRegistry.disposeAll()
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
		expect(disposeB).toHaveBeenCalledTimes(1)
		expect(codeIndexScopeRegistry.getAllScopes()).toEqual([])
	})

	it("preserves non-Error thrown values in disposal diagnostics", async () => {
		const scope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		vi.spyOn(scope, "dispose").mockImplementation(() => {
			throw "cleanup rejected"
		})
		await expect(codeIndexScopeRegistry.disposeAll()).rejects.toThrow(
			"Failed to dispose code index managers (1 errors):\n1. cleanup rejected",
		)
	})

	it("creates and retains a new scope after disposal fails", async () => {
		const disposedScope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		vi.spyOn(disposedScope, "dispose").mockImplementation(() => {
			throw new Error("cleanup failed")
		})

		await expect(codeIndexScopeRegistry.disposeAll()).rejects.toThrow("cleanup failed")

		const newScope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)
		expect(newScope).toBeDefined()
		expect(newScope).not.toBe(disposedScope)
		expect(codeIndexScopeRegistry.getAllScopes()).toEqual([newScope])
	})

	it("clears the registry before disposal callbacks run", async () => {
		const scope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		const dispose = vi.spyOn(scope, "dispose").mockImplementation(async () => {
			expect(codeIndexScopeRegistry.getAllScopes()).toEqual([])
		})
		await codeIndexScopeRegistry.disposeAll()
		expect(dispose).toHaveBeenCalledTimes(1)
	})

	it("does not create or retain scopes during disposal callbacks", async () => {
		const scope = codeIndexScopeRegistry.getScope(context, first.uri.fsPath)!
		vi.spyOn(scope, "dispose").mockImplementation(async () => {
			expect(codeIndexScopeRegistry.getScope(context, first.uri.fsPath)).toBeUndefined()
		})

		await codeIndexScopeRegistry.disposeAll()

		expect(CodeIndexManager).toHaveBeenCalledTimes(1)
		expect(codeIndexScopeRegistry.getAllScopes()).toEqual([])
	})
})
