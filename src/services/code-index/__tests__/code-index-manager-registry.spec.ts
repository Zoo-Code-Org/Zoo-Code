import * as vscode from "vscode"
import { makeExtensionContext, makeTextDocument, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexManagerRegistry } from "../code-index-manager-registry"
import { CodeIndexWorkspaceScope } from "../code-index-workspace-scope"
import { CodeIndexStateManager } from "../state-manager"

vi.mock("../state-manager")

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
		expect(CodeIndexManagerRegistry.getOrCreate(context)).toBeUndefined()
		expect(CodeIndexManagerRegistry.getOrCreateScope(context)).toBeUndefined()
		expect(CodeIndexManager).not.toHaveBeenCalled()
	})

	it("returns the complete cached scope shared with the manager API", () => {
		const scope = CodeIndexManagerRegistry.getOrCreateScope(context)!
		expect(scope).toBeInstanceOf(CodeIndexWorkspaceScope)
		expect(scope.workspaceIndexingEnablementManager).toBeDefined()
		expect(CodeIndexManagerRegistry.getOrCreateScope(context, "/first")).toBe(scope)
		expect(CodeIndexManagerRegistry.getOrCreate(context)).toBe(scope.codeIndexManager)
		expect(CodeIndexManagerRegistry.getOrCreateScope(context, "/second")).not.toBe(scope)
		CodeIndexManagerRegistry.disposeAll()
		expect(CodeIndexManagerRegistry.getOrCreateScope(context)).not.toBe(scope)
	})

	it("uses the first workspace when there is no active editor", () => {
		CodeIndexManagerRegistry.getOrCreate(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context, expect.any(CodeIndexStateManager))
	})

	it("prefers the active editor's workspace", () => {
		const editor = makeTextEditor({ document: makeTextDocument({ uri: makeUri("/second/file.ts") }) })
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: editor })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(second)
		expect(CodeIndexManagerRegistry.getOrCreate(context)).toBeDefined()
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context, expect.any(CodeIndexStateManager))
	})

	it("falls back to the first workspace for an editor outside all folders", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		CodeIndexManagerRegistry.getOrCreate(context)
		expect(CodeIndexManager).toHaveBeenCalledWith("/first", first.uri, context, expect.any(CodeIndexStateManager))
	})

	it("gives an explicit path priority over the active editor", () => {
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: makeTextEditor() })
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(first)
		expect(CodeIndexManagerRegistry.getOrCreate(context, "/second")).toBeDefined()
		expect(CodeIndexManager).toHaveBeenCalledWith("/second", second.uri, context, expect.any(CodeIndexStateManager))
	})

	it("preserves the actual remote workspace URI", () => {
		const uri = makeUri("/remote", { scheme: "vscode-remote", authority: "ssh-remote+host" })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri, name: "remote", index: 0 }],
		})
		CodeIndexManagerRegistry.getOrCreate(context, "/remote")
		expect(CodeIndexManager).toHaveBeenCalledWith("/remote", uri, context, expect.any(CodeIndexStateManager))
		expect(vi.mocked(CodeIndexManager).mock.calls[0][1]).toBe(uri)
		expect(vscode.Uri.file).not.toHaveBeenCalled()
	})

	it("constructs a file URI for an explicit path without open workspaces", () => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: undefined })
		const uri = makeUri("/outside folder/#name")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		CodeIndexManagerRegistry.getOrCreate(context, uri.fsPath)
		expect(vscode.Uri.file).toHaveBeenCalledWith(uri.fsPath)
		expect(CodeIndexManager).toHaveBeenCalledWith(uri.fsPath, uri, context, expect.any(CodeIndexStateManager))
	})

	it("constructs a file URI for an explicit path not matching any open workspace folder", () => {
		// workspaceFolders contains /first and /second, but /outside/project matches neither
		const uri = makeUri("/outside/project")
		vi.mocked(vscode.Uri.file).mockReturnValue(uri)
		CodeIndexManagerRegistry.getOrCreate(context, "/outside/project")
		expect(vscode.Uri.file).toHaveBeenCalledWith("/outside/project")
		expect(CodeIndexManager).toHaveBeenCalledWith(
			"/outside/project",
			uri,
			context,
			expect.any(CodeIndexStateManager),
		)
	})

	it("reuses the same path and keeps different paths isolated", () => {
		const a = CodeIndexManagerRegistry.getOrCreate(context, "/first")
		expect(CodeIndexManagerRegistry.getOrCreate(makeExtensionContext(), "/first")).toBe(a)
		const b = CodeIndexManagerRegistry.getOrCreate(context, "/second")
		expect(b).not.toBe(a)
		expect(CodeIndexManager).toHaveBeenCalledTimes(2)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([a, b])
	})

	it("returns a snapshot that cannot mutate the cache", () => {
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		const manager = CodeIndexManagerRegistry.getOrCreate(context)
		CodeIndexManagerRegistry.getAllInstances().pop()
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([manager])
	})

	it("logs each disposal failure, continues cleanup and permits recreation", () => {
		const logError = vi.spyOn(console, "error").mockImplementation(() => {})
		const first = CodeIndexManagerRegistry.getOrCreate(context, "/first")!
		const second = CodeIndexManagerRegistry.getOrCreate(context, "/second")!
		const third = CodeIndexManagerRegistry.getOrCreate(context, "/third")!
		const error = new Error("cleanup failed")
		vi.mocked(first.dispose).mockImplementationOnce(() => {
			throw error
		})
		vi.mocked(second.dispose).mockImplementationOnce(() => {
			throw "second cleanup failed"
		})

		expect(() => CodeIndexManagerRegistry.disposeAll()).not.toThrow()
		for (const manager of [first, second, third]) {
			expect(manager.dispose).toHaveBeenCalledExactlyOnceWith()
		}
		expect(logError).toHaveBeenCalledTimes(2)
		expect(logError).toHaveBeenNthCalledWith(
			1,
			"[CodeIndexManagerRegistry] Failed to dispose workspace scope for /first:",
			error,
		)
		expect(logError).toHaveBeenNthCalledWith(
			2,
			"[CodeIndexManagerRegistry] Failed to dispose workspace scope for /second:",
			"second cleanup failed",
		)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		CodeIndexManagerRegistry.disposeAll()
		expect(logError).toHaveBeenCalledTimes(2)
		expect(first.dispose).toHaveBeenCalledTimes(1)
		expect(CodeIndexManagerRegistry.getOrCreate(context, "/first")).not.toBe(first)
	})

	it("disposes every manager, supports repeated cleanup and recreates instances", () => {
		const disposeScope = vi.spyOn(CodeIndexWorkspaceScope.prototype, "dispose")
		const a = CodeIndexManagerRegistry.getOrCreate(context, "/first")!
		const b = CodeIndexManagerRegistry.getOrCreate(context, "/second")!
		CodeIndexManagerRegistry.disposeAll()
		CodeIndexManagerRegistry.disposeAll()
		expect(disposeScope).toHaveBeenCalledTimes(2)
		expect(a.dispose).toHaveBeenCalledTimes(1)
		expect(b.dispose).toHaveBeenCalledTimes(1)
		expect(CodeIndexManagerRegistry.getAllInstances()).toEqual([])
		expect(CodeIndexManagerRegistry.getOrCreate(context, "/first")).not.toBe(a)
	})
})
