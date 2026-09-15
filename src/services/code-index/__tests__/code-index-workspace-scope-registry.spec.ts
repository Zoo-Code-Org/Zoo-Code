import * as vscode from "vscode"
import { makeExtensionContext, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { codeIndexWorkspaceScopeRegistry } from "../code-index-workspace-scope-registry"

vi.mock("vscode", () => ({
	workspace: { workspaceFolders: undefined, getWorkspaceFolder: vi.fn() },
	window: { activeTextEditor: undefined },
	Uri: { file: vi.fn() },
}))

vi.mock("../manager", () => ({
	CodeIndexManager: vi.fn().mockImplementation(function () {
		return { dispose: vi.fn() }
	}),
}))

describe("CodeIndexWorkspaceScopeRegistry", () => {
	let context: vscode.ExtensionContext
	let first: vscode.WorkspaceFolder
	let second: vscode.WorkspaceFolder

	beforeEach(() => {
		vi.clearAllMocks()
		context = makeExtensionContext()
		first = { uri: makeUri("/first"), name: "first", index: 0 }
		second = { uri: makeUri("/second"), name: "second", index: 1 }
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: [first, second] })
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: undefined })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
		vi.mocked(vscode.Uri.file).mockImplementation((value) => makeUri(value))
	})

	afterEach(() => {
		codeIndexWorkspaceScopeRegistry.disposeAll()
		vi.restoreAllMocks()
	})

	it.each([{ folders: undefined }, { folders: [] }])("returns no scope with folders=$folders", ({ folders }) => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: folders })
		expect(codeIndexWorkspaceScopeRegistry.getScope(context)).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("uses the first workspace when there is no active editor", () => {
		codeIndexWorkspaceScopeRegistry.getScope(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context)
	})

	it("prefers the active editor's workspace", () => {
		const editor = makeTextEditor({ document: makeTextDocument({ uri: makeUri("/second/file.ts") }) })
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: editor })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		codeIndexWorkspaceScopeRegistry.getScope(context)
		expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(editor.document.uri)
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context)
	})

	it("falls back to the first workspace for an editor outside all folders", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		codeIndexWorkspaceScopeRegistry.getScope(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context)
	})

	it("gives an explicit path priority over the active editor", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		codeIndexWorkspaceScopeRegistry.getScope(context, "/second")
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context)
		expect(vscode.workspace.getWorkspaceFolder).not.toHaveBeenCalled()
	})

	it("preserves the actual remote workspace URI", () => {
		const uri = makeUri("/remote", { scheme: "vscode-remote", authority: "ssh-remote+host" })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri, name: "remote", index: 0 }],
		})
		codeIndexWorkspaceScopeRegistry.getScope(context, "/remote")
		expect(CodeIndexManager).toHaveBeenCalledWith("/remote", uri, context)
		expect(vi.mocked(CodeIndexManager).mock.calls[0][1]).toBe(uri)
		expect(vscode.Uri.file).not.toHaveBeenCalled()
	})

	it("constructs a file URI for an explicit path without open workspaces", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined })
		const uri = makeUri("/outside folder/#name")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		codeIndexWorkspaceScopeRegistry.getScope(context, uri.fsPath)
		expect(vscode.Uri.file).toHaveBeenCalledWith(uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(uri.fsPath, uri, context)
	})

	it("reuses the same path and keeps different paths isolated", () => {
		const a = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")
		expect(codeIndexWorkspaceScopeRegistry.getScope(makeExtensionContext(), "/first")).toBe(a)
		const b = codeIndexWorkspaceScopeRegistry.getScope(context, "/second")
		expect(b).not.toBe(a)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([a, b])
	})

	it("returns a snapshot that cannot mutate the cache", () => {
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([])
		const scope = codeIndexWorkspaceScopeRegistry.getScope(context)
		codeIndexWorkspaceScopeRegistry.getAllScopes().pop()
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([scope])
	})

	it("disposes every scope, supports repeated cleanup and recreates scopes", () => {
		const a = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")!
		const b = codeIndexWorkspaceScopeRegistry.getScope(context, "/second")!
		codeIndexWorkspaceScopeRegistry.disposeAll()
		codeIndexWorkspaceScopeRegistry.disposeAll()
		expect(a.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
		expect(b.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([])
		expect(codeIndexWorkspaceScopeRegistry.getScope(context, "/first")).not.toBe(a)
	})

	it("attempts every scope and preserves all thrown values in an aggregate", () => {
		const a = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")!
		const b = codeIndexWorkspaceScopeRegistry.getScope(context, "/second")!
		const c = codeIndexWorkspaceScopeRegistry.getScope(context, "/third")!
		const error = new Error("first cleanup failed")
		vi.mocked(a.codeIndexManager.dispose).mockImplementationOnce(() => {
			throw error
		})
		vi.mocked(b.codeIndexManager.dispose).mockImplementationOnce(() => {
			throw "second cleanup failed"
		})

		let caught: unknown
		try {
			codeIndexWorkspaceScopeRegistry.disposeAll()
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(AggregateError)
		if (!(caught instanceof AggregateError)) throw new Error("Expected aggregate disposal failure")
		expect(caught.errors).toEqual([error, "second cleanup failed"])
		for (const scope of [a, b, c]) {
			expect(scope.codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
		}
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([])
		codeIndexWorkspaceScopeRegistry.disposeAll()
		expect(a.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
		const replacement = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")
		expect(replacement).not.toBe(a)
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([replacement])
	})

	it.each([false, true])("blocks reentrant lookup and cleanup, then resets (failure=%s)", (fails) => {
		const a = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")!
		const b = codeIndexWorkspaceScopeRegistry.getScope(context, "/second")!
		vi.mocked(a.codeIndexManager.dispose).mockImplementationOnce(() => {
			expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([])
			expect(codeIndexWorkspaceScopeRegistry.getScope(context)).toBeUndefined()
			expect(codeIndexWorkspaceScopeRegistry.getScope(context, "/first")).toBeUndefined()
			expect(codeIndexWorkspaceScopeRegistry.getScope(context, "/new")).toBeUndefined()
			codeIndexWorkspaceScopeRegistry.disposeAll()
			expect(b.codeIndexManager.dispose).not.toHaveBeenCalled()
			if (fails) throw new Error("cleanup failed")
		})

		if (fails) {
			expect(() => codeIndexWorkspaceScopeRegistry.disposeAll()).toThrow(AggregateError)
		} else {
			codeIndexWorkspaceScopeRegistry.disposeAll()
		}
		expect(a.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
		expect(b.codeIndexManager.dispose).toHaveBeenCalledTimes(1)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
		expect(codeIndexWorkspaceScopeRegistry.getAllScopes()).toEqual([])
		expect(codeIndexWorkspaceScopeRegistry.getScope(context, "/first")).not.toBe(a)
	})

	it("cleans up its own snapshot even when a caller mutates a previously returned list", () => {
		const a = codeIndexWorkspaceScopeRegistry.getScope(context, "/first")!
		const b = codeIndexWorkspaceScopeRegistry.getScope(context, "/second")!
		const snapshot = codeIndexWorkspaceScopeRegistry.getAllScopes()
		vi.mocked(a.codeIndexManager.dispose).mockImplementationOnce(() => {
			snapshot.splice(0, snapshot.length)
		})

		codeIndexWorkspaceScopeRegistry.disposeAll()
		expect(b.codeIndexManager.dispose).toHaveBeenCalledExactlyOnceWith()
		expect(snapshot).toEqual([])
	})
})
