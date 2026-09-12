import * as vscode from "vscode"

import { makeEventEmitter, makeTextEditor, makeUri } from "../../../test-utils/vscode"
import { CodeIndexStatusManager } from "../code-index-status-manager"
import { CodeIndexWorkspaceScopeRegistry } from "../code-index-workspace-scope-registry"
import type { CodeIndexWorkspaceScope } from "../code-index-workspace-scope"
import type { CodeIndexStatus } from "../interfaces/status-consumer"

describe("CodeIndexStatusManager", () => {
	const first = { uri: makeUri("/first"), name: "first", index: 0 }
	const second = { uri: makeUri("/second"), name: "second", index: 1 }
	let editorChanges: vscode.EventEmitter<vscode.TextEditor | undefined>
	let manager: CodeIndexStatusManager
	let registry: { getExistingScope: ReturnType<typeof vi.fn<(path: string) => CodeIndexWorkspaceScope | undefined>> }
	const output = { appendLine: vi.fn() }

	function workspace(message: string) {
		const progress = makeEventEmitter<CodeIndexStatus>()
		const status: CodeIndexStatus = {
			workspacePath: "/workspace",
			workspaceEnabled: true,
			autoEnableDefault: true,
			systemStatus: "Standby",
			message,
			processedItems: 0,
			totalItems: 0,
			currentItemUnit: "blocks",
		}
		const codeIndexManager = {
			onProgressUpdate: vi.fn(progress.event),
			getCurrentStatus: vi.fn(() => status),
		}
		// The status manager reads only the workspace's progress/status port.
		const scope = { codeIndexManager, isInitialized: true } as unknown as CodeIndexWorkspaceScope
		return { scope, progress, codeIndexManager, status }
	}

	function consumer() {
		const ready = makeEventEmitter<void>()
		const port = {
			onDidCodeIndexWebviewReady: ready.event,
			postCodeIndexStatus: vi.fn().mockResolvedValue(undefined),
		}
		const registration = manager.addConsumer(port)
		return { ready, port, registration }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		editorChanges = makeEventEmitter<vscode.TextEditor | undefined>()
		vi.spyOn(vscode.window, "onDidChangeActiveTextEditor").mockImplementation(editorChanges.event)
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: undefined })
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: [first, second] })
		registry = { getExistingScope: vi.fn() }
		const workspaceRegistry = new CodeIndexWorkspaceScopeRegistry()
		vi.spyOn(workspaceRegistry, "getExistingScope").mockImplementation(registry.getExistingScope)
		manager = new CodeIndexStatusManager(workspaceRegistry, output)
	})

	afterEach(() => manager.dispose())

	it("waits for init, subscribes once and replays readiness to sidebar and late editor consumers", () => {
		const a = workspace("first")
		registry.getExistingScope.mockReturnValue(a.scope)
		const sidebar = consumer()
		sidebar.ready.fire()
		expect(a.codeIndexManager.onProgressUpdate).not.toHaveBeenCalled()
		manager.init()
		expect(sidebar.port.postCodeIndexStatus).toHaveBeenCalledExactlyOnceWith(a.status)
		const editor = consumer()
		sidebar.ready.fire()
		editor.ready.fire()
		expect(sidebar.port.postCodeIndexStatus).toHaveBeenCalledTimes(2)
		expect(editor.port.postCodeIndexStatus).toHaveBeenCalledTimes(2)
		expect(a.codeIndexManager.onProgressUpdate).toHaveBeenCalledOnce()
		a.progress.fire(a.status)
		expect(editor.port.postCodeIndexStatus).toHaveBeenCalledTimes(3)
	})

	it("uses the latest active workspace at startup and drops the previous progress subscription", () => {
		const a = workspace("first")
		const b = workspace("second")
		registry.getExistingScope.mockImplementation((path: string) => (path === "/first" ? a.scope : b.scope))
		const ui = consumer()
		manager.init()
		const editor = makeTextEditor()
		Object.defineProperty(vscode.window, "activeTextEditor", { value: editor })
		vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(second)
		editorChanges.fire(editor)
		a.progress.fire(a.status)
		expect(ui.port.postCodeIndexStatus).toHaveBeenCalledTimes(2)
		b.progress.fire(b.status)
		expect(ui.port.postCodeIndexStatus).toHaveBeenLastCalledWith(b.status)
		editorChanges.fire(editor)
		expect(b.codeIndexManager.onProgressUpdate).toHaveBeenCalledOnce()
	})

	it("unsubscribes outside a workspace without creating scopes", () => {
		const a = workspace("first")
		registry.getExistingScope.mockReturnValue(a.scope)
		const ui = consumer()
		manager.init()
		Object.defineProperty(vscode.window, "activeTextEditor", { value: makeTextEditor() })
		vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(undefined)
		editorChanges.fire(vscode.window.activeTextEditor)
		a.progress.fire(a.status)
		ui.ready.fire()
		expect(ui.port.postCodeIndexStatus).toHaveBeenCalledOnce()
		expect(registry.getExistingScope).toHaveBeenCalledOnce()
	})

	it("does not subscribe to a lazily created, uninitialized workspace", () => {
		const a = workspace("first")
		Object.defineProperty(a.scope, "isInitialized", { value: false })
		registry.getExistingScope.mockReturnValue(a.scope)
		consumer()
		manager.init()
		expect(a.codeIndexManager.onProgressUpdate).not.toHaveBeenCalled()
	})

	it("detaches disposed consumers and stops all events after disposal", () => {
		const a = workspace("first")
		registry.getExistingScope.mockReturnValue(a.scope)
		const sidebar = consumer()
		const editor = consumer()
		manager.init()
		editor.registration.dispose()
		editor.ready.fire()
		a.progress.fire(a.status)
		expect(editor.port.postCodeIndexStatus).toHaveBeenCalledOnce()
		manager.dispose()
		sidebar.ready.fire()
		editorChanges.fire(undefined)
		a.progress.fire(a.status)
		expect(sidebar.port.postCodeIndexStatus).toHaveBeenCalledTimes(2)
	})

	it("logs rejected asynchronous publications without reviving a disposed subscription", async () => {
		const a = workspace("first")
		registry.getExistingScope.mockReturnValue(a.scope)
		const ui = consumer()
		ui.port.postCodeIndexStatus.mockRejectedValue(new Error("closed"))
		manager.init()
		manager.dispose()
		await Promise.resolve()
		expect(output.appendLine).toHaveBeenCalledWith("Failed to publish code index status: Error: closed")
	})
})
