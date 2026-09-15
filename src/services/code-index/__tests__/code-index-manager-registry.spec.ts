import * as vscode from "vscode"
import { makeExtensionContext, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"

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

describe("CodeIndexManagerRegistry", () => {
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
		CodeIndexManagerRegistry.disposeAll()
		vi.restoreAllMocks()
	})

	it.each([{ folders: undefined }, { folders: [] }])("returns no manager with folders=$folders", ({ folders }) => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: folders })
		expect(CodeIndexManagerRegistry.getInstance(context)).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("uses the first workspace when there is no active editor", () => {
		CodeIndexManagerRegistry.getInstance(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context)
	})

	it("prefers the active editor's workspace", () => {
		const editor = makeTextEditor({ document: makeTextDocument({ uri: makeUri("/second/file.ts") }) })
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: editor })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		CodeIndexManagerRegistry.getInstance(context)
		expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(editor.document.uri)
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context)
	})

	it("falls back to the first workspace for an editor outside all folders", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		CodeIndexManagerRegistry.getInstance(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context)
	})

	it("gives an explicit path priority over the active editor", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		CodeIndexManagerRegistry.getInstance(context, "/second")
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context)
		expect(vscode.workspace.getWorkspaceFolder).not.toHaveBeenCalled()
	})

	it("preserves the actual remote workspace URI", () => {
		const uri = makeUri("/remote", { scheme: "vscode-remote", authority: "ssh-remote+host" })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri, name: "remote", index: 0 }],
		})
		CodeIndexManagerRegistry.getInstance(context, "/remote")
		expect(CodeIndexManager).toHaveBeenCalledWith("/remote", uri, context)
		expect(vi.mocked(CodeIndexManager).mock.calls[0][1]).toBe(uri)
		expect(vscode.Uri.file).not.toHaveBeenCalled()
	})

	it("constructs a file URI for an explicit path without open workspaces", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined })
		const uri = makeUri("/outside folder/#name")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		CodeIndexManagerRegistry.getInstance(context, uri.fsPath)
		expect(vscode.Uri.file).toHaveBeenCalledWith(uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(uri.fsPath, uri, context)
	})

	it("reuses the same path and keeps different paths isolated", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, "/first")
		expect(CodeIndexManagerRegistry.getInstance(makeExtensionContext(), "/first")).toBe(a)
		const b = CodeIndexManagerRegistry.getInstance(context, "/second")
		expect(b).not.toBe(a)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([a, b])
	})

	it("returns a snapshot that cannot mutate the cache", () => {
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		const manager = CodeIndexManagerRegistry.getInstance(context)
		CodeIndexManagerRegistry.getAllInstances().pop()
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([manager])
	})

	it("disposes every manager, supports repeated cleanup and recreates instances", () => {
		const a = CodeIndexManagerRegistry.getInstance(context, "/first")!
		const b = CodeIndexManagerRegistry.getInstance(context, "/second")!
		CodeIndexManagerRegistry.disposeAll()
		CodeIndexManagerRegistry.disposeAll()
		expect(a.dispose).toHaveBeenCalledTimes(1)
		expect(b.dispose).toHaveBeenCalledTimes(1)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		expect(CodeIndexManagerRegistry.getInstance(context, "/first")).not.toBe(a)
	})
})
