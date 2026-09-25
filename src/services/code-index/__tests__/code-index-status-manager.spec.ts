import * as vscode from "vscode"
import { makeUri, makeTextDocument, makeTextEditor, makeExtensionContext } from "../../../test-utils/vscode"
import { CodeIndexManager } from "../manager"
import { CodeIndexStateManager } from "../state-manager"
import { CodeIndexStatusManager, type CodeIndexStatus } from "../code-index-status-manager"

vi.mock("../../../core/webview/ClineProvider", () => ({ ClineProvider: { getAllInstances: vi.fn(() => []) } }))
vi.mock("../manager")
vi.mock("../state-manager")

vi.mock("vscode", () => ({
	window: { onDidChangeActiveTextEditor: vi.fn(), activeTextEditor: undefined },
	workspace: { workspaceFolders: undefined, getWorkspaceFolder: vi.fn() },
}))

function makeSource(workspacePath: string) {
	const status: CodeIndexStatus = {
		systemStatus: "Standby",
		message: "Ready",
		processedItems: 0,
		totalItems: 0,
		currentItemUnit: "blocks",
		workspacePath,
		workspaceEnabled: true,
		autoEnableDefault: true,
	}
	let emit = () => {}
	const subscription = { dispose: vi.fn() }
	const event: CodeIndexManager["onProgressUpdate"] = (listener) => {
		emit = () => listener(status)
		return subscription
	}
	const manager = new CodeIndexManager(
		workspacePath,
		makeUri(workspacePath),
		makeExtensionContext(),
		new CodeIndexStateManager(),
	)
	Object.defineProperty(manager, "onProgressUpdate", { value: vi.fn(event), configurable: true })
	return Object.assign(manager, {
		getCurrentStatus: vi.fn(() => status),
		dispose: vi.fn(),
		subscription,
		emit: () => emit(),
		status,
	})
}

describe("CodeIndexStatusManager", () => {
	let editorChanged: () => void
	let disposeEditor: ReturnType<typeof vi.fn<() => void>>

	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(vscode.window, "activeTextEditor", { configurable: true, value: undefined })
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			configurable: true,
			value: [{ uri: makeUri("/first"), name: "first", index: 0 }],
		})
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
		disposeEditor = vi.fn()
		vi.mocked(vscode.window.onDidChangeActiveTextEditor).mockImplementation((listener) => {
			editorChanged = () => listener(undefined)
			return { dispose: disposeEditor }
		})
	})

	it("resolves the workspace before requesting its manager", () => {
		const resolve = vi.fn(() => makeSource("/first"))
		const manager = new CodeIndexStatusManager(resolve)
		manager.init()
		expect(resolve).toHaveBeenLastCalledWith("/first")
		const uri = makeUri("/second/file.ts")
		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			value: makeTextEditor({ document: makeTextDocument({ uri }) }),
		})
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: makeUri("/second"),
			name: "second",
			index: 1,
		})
		editorChanged()
		expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(uri)
		expect(resolve).toHaveBeenLastCalledWith("/second")
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
		editorChanged()
		expect(resolve).toHaveBeenLastCalledWith("/first")
		manager.dispose()
	})

	it.each([undefined, []])("does not request a manager without a workspace: %s", (folders) => {
		Object.defineProperty(vscode.workspace, "workspaceFolders", { configurable: true, value: folders })
		const resolve = vi.fn()
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(resolve)
		manager["publishStatus"] = publish
		manager.init()
		editorChanged()
		expect(resolve).not.toHaveBeenCalled()
		expect(publish).not.toHaveBeenCalled()
		manager.dispose()
	})

	it("publishes initial and full updated status without resubscribing in the same workspace", () => {
		const source = makeSource("/first")
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(() => source)
		manager["publishStatus"] = publish
		expect(source.onProgressUpdate).not.toHaveBeenCalled()
		manager.init()
		expect(publish).toHaveBeenCalledExactlyOnceWith(source.status)
		source.status.message = "Updated"
		source.emit()
		expect(publish).toHaveBeenLastCalledWith(source.status)
		expect(publish).toHaveBeenCalledTimes(2)
		editorChanged()
		expect(source.onProgressUpdate).toHaveBeenCalledTimes(1)
		expect(publish).toHaveBeenCalledTimes(2)
		manager.dispose()
	})

	it("switches subscriptions and rejects stale events before and after switching", () => {
		const first = makeSource("/first")
		const second = makeSource("/second")
		let current = first
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(() => current)
		manager["publishStatus"] = publish
		manager.init()
		current = second
		first.emit()
		expect(publish).toHaveBeenCalledTimes(1)
		editorChanged()
		expect(first.subscription.dispose).toHaveBeenCalledTimes(1)
		expect(publish).toHaveBeenLastCalledWith(second.status)
		first.emit()
		expect(publish).toHaveBeenCalledTimes(2)
		second.emit()
		expect(publish).toHaveBeenCalledTimes(3)
		manager.dispose()
		expect(first.dispose).not.toHaveBeenCalled()
		expect(second.dispose).not.toHaveBeenCalled()
	})

	it("handles missing workspaces and releases the subscription when a workspace disappears", () => {
		const source = makeSource("/first")
		let current: typeof source | undefined
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(() => current)
		manager["publishStatus"] = publish
		manager.init()
		expect(publish).not.toHaveBeenCalled()
		current = source
		editorChanged()
		expect(publish).toHaveBeenCalledExactlyOnceWith(source.status)
		current = undefined
		editorChanged()
		expect(source.subscription.dispose).toHaveBeenCalledTimes(1)
		source.emit()
		expect(publish).toHaveBeenCalledTimes(1)
		manager.dispose()
	})

	it("disposes idempotently, ignores stale progress and supports reinitialization", () => {
		const source = makeSource("/first")
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(() => source)
		manager["publishStatus"] = publish
		manager.dispose()
		manager.init()
		manager.dispose()
		manager.dispose()
		expect(disposeEditor).toHaveBeenCalledTimes(1)
		expect(source.subscription.dispose).toHaveBeenCalledTimes(1)
		source.emit()
		expect(publish).toHaveBeenCalledTimes(1)
		manager.init()
		expect(publish).toHaveBeenCalledTimes(2)
		manager.dispose()
	})

	it("logs both unsubscribe failures and keeps disposal idempotent", () => {
		const source = makeSource("/first")
		const manager = new CodeIndexStatusManager(() => source)
		const editorError = new Error("editor cleanup failed")
		const progressError = new Error("progress cleanup failed")
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			manager.init()
			disposeEditor.mockImplementationOnce(() => {
				throw editorError
			})
			source.subscription.dispose.mockImplementationOnce(() => {
				throw progressError
			})
			expect(() => manager.dispose()).not.toThrow()
			expect(log).toHaveBeenNthCalledWith(
				1,
				"[CodeIndexStatusManager] Failed to dispose active editor subscription:",
				editorError,
			)
			expect(log).toHaveBeenNthCalledWith(
				2,
				"[CodeIndexStatusManager] Failed to dispose progress subscription:",
				progressError,
			)
			manager.dispose()
			expect(disposeEditor).toHaveBeenCalledTimes(1)
			expect(source.subscription.dispose).toHaveBeenCalledTimes(1)
			expect(log).toHaveBeenCalledTimes(2)
		} finally {
			log.mockRestore()
		}
	})

	it("logs an unsubscribe failure and still subscribes to the next workspace", () => {
		const first = makeSource("/first")
		const second = makeSource("/second")
		let current = first
		const publish = vi.fn()
		const manager = new CodeIndexStatusManager(() => current)
		manager["publishStatus"] = publish
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			manager.init()
			first.subscription.dispose.mockImplementationOnce(() => {
				throw "cleanup failed"
			})
			current = second
			expect(() => editorChanged()).not.toThrow()
			expect(log).toHaveBeenCalledExactlyOnceWith(
				"[CodeIndexStatusManager] Failed to dispose progress subscription:",
				"cleanup failed",
			)
			expect(second.onProgressUpdate).toHaveBeenCalledTimes(1)
			expect(publish).toHaveBeenLastCalledWith(second.status)
			first.emit()
			expect(publish).toHaveBeenCalledTimes(2)
		} finally {
			manager.dispose()
			log.mockRestore()
		}
	})

	it("propagates initialization failure without automatic cleanup", () => {
		const source = makeSource("/first")
		const publish = vi.fn().mockImplementationOnce(() => {
			throw new Error("publish failed")
		})
		const manager = new CodeIndexStatusManager(() => source)
		manager["publishStatus"] = publish
		expect(() => manager.init()).toThrow("publish failed")
		expect(disposeEditor).not.toHaveBeenCalled()
		expect(source.subscription.dispose).not.toHaveBeenCalled()
		manager.dispose()
	})
})
