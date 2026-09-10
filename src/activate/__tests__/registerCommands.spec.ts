import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"

import {
	getVisibleProviderOrLog,
	openClineInNewTab,
	registerBrowserBridgeCommand,
	registerCommands,
	setPanel,
} from "../registerCommands"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("vscode", () => ({
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	Uri: {
		joinPath: vi.fn((_base: unknown, ..._pathSegments: string[]) => ({ path: _pathSegments.join("/") })),
		parse: vi.fn((value: string) => ({ toString: () => value })),
	},
	ViewColumn: {
		Two: 2,
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		createWebviewPanel: vi.fn(),
		showErrorMessage: vi.fn(),
		visibleTextEditors: [],
	},
	env: {
		openExternal: vi.fn().mockResolvedValue(true),
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
	commands: {
		registerCommand: vi.fn(),
		executeCommand: vi.fn(),
	},
}))

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../core/webview/browserBridge", () => ({
	BrowserBridgeServer: {
		start: vi.fn(),
		getBrowserUrl: vi.fn((port: number) => `http://localhost:5173/?bridgePort=${port}`),
	},
}))

vi.mock("../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
		},
	},
}))

vi.mock("../../utils/focusPanel", () => ({
	focusPanel: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../handleTask", () => ({
	handleNewTask: vi.fn(),
}))

vi.mock("../../core/config/importExport", () => ({
	importSettingsWithFeedback: vi.fn(),
}))

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../services/mdm/MdmService", () => ({
	MdmService: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../services/ripgrep/diagnostic", () => ({
	registerRipgrepDiagnosticCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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

describe("registerCommands handlers", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext
	let mockVisibleProvider: {
		postMessageToWebview: Mock
		getActiveBrowserBridgePort: Mock
		enableBrowserBridge: Mock
	}
	let mockProvider: { postMessageToWebview: Mock }
	let handlers: Record<string, (...args: unknown[]) => unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = {}

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

		mockContext = {
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		mockVisibleProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getActiveBrowserBridgePort: vi.fn().mockReturnValue(undefined),
			enableBrowserBridge: vi.fn(),
		}

		mockProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockVisibleProvider)
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				handlers[id] = cb
				return { dispose: vi.fn() }
			},
		)

		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: mockProvider as unknown as ClineProvider,
		})
	})

	afterEach(() => {
		// Reset module-level panel state to prevent leakage between tests.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
	})

	it("registers the ripgrep diagnostic command and stores its disposable in context.subscriptions", async () => {
		const { registerRipgrepDiagnosticCommand } = await import("../../services/ripgrep/diagnostic")
		const mock = vi.mocked(registerRipgrepDiagnosticCommand)
		const disposable = mock.mock.results[0]?.value
		expect(mock).toHaveBeenCalled()
		expect(mockContext.subscriptions).toContain(disposable)
	})

	it("settingsButtonClicked posts both settingsButtonClicked and didBecomeVisible actions", () => {
		handlers["zoo-code.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledTimes(2)
	})

	it("settingsButtonClicked is a no-op when no visible provider", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		handlers["zoo-code.settingsButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("historyButtonClicked posts historyButtonClicked action", () => {
		handlers["zoo-code.historyButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
	})

	it("marketplaceButtonClicked posts marketplaceButtonClicked action", () => {
		handlers["zoo-code.marketplaceButtonClicked"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "marketplaceButtonClicked",
		})
	})

	it("acceptInput posts acceptInput message", () => {
		handlers["zoo-code.acceptInput"]()

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "acceptInput",
		})
	})

	it("toggleAutoApprove awaits postMessage with toggleAutoApprove action", async () => {
		// Deferred-promise pattern: pin that the handler actually awaits
		// postMessageToWebview rather than fire-and-forgetting it. If `await`
		// were dropped in the handler, handlerPromise would resolve before
		// resolvePost() is called and `settled` would flip true at the
		// microtask flush below, failing the pending-state assertion.
		let resolvePost!: () => void
		const postPromise = new Promise<void>((resolve) => {
			resolvePost = resolve
		})
		mockVisibleProvider.postMessageToWebview.mockReturnValueOnce(postPromise)

		const handlerPromise = handlers["zoo-code.toggleAutoApprove"]() as Promise<unknown>
		let settled = false
		void handlerPromise.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)

		resolvePost()
		await handlerPromise

		expect(mockVisibleProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "toggleAutoApprove",
		})
	})

	it("focusInput awaits postMessage on the registered provider when a sidebar panel is active", async () => {
		const fakeSidebar = {} as vscode.WebviewView
		setPanel(fakeSidebar, "sidebar")

		// Same deferred-promise pattern as above. focusInput first awaits
		// focusPanel() (mocked to resolve sync) and then awaits
		// provider.postMessageToWebview — so we flush two microtasks before
		// asserting the pending state, to let the handler advance past the
		// focusPanel await and suspend on the deferred postPromise.
		let resolvePost!: () => void
		const postPromise = new Promise<void>((resolve) => {
			resolvePost = resolve
		})
		mockProvider.postMessageToWebview.mockReturnValueOnce(postPromise)

		const handlerPromise = handlers["zoo-code.focusInput"]() as Promise<unknown>
		let settled = false
		void handlerPromise.then(() => {
			settled = true
		})
		await Promise.resolve()
		await Promise.resolve()
		expect(settled).toBe(false)

		resolvePost()
		await handlerPromise

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
	})

	it("focusInput does not post when no sidebar panel is active", async () => {
		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// Representative coverage for the .catch arm on all five void-prefixed
	// postMessageToWebview sites in registerCommands.ts (settingsButtonClicked
	// posts twice, plus historyButtonClicked, marketplaceButtonClicked, and
	// acceptInput). Each handler is synchronous, so the .catch arm runs on a
	// microtask; setImmediate ensures all microtasks are flushed before we assert. The
	// log messages carry a `[<handlerName>]` prefix so multi-failure logs
	// remain unambiguous; the prefix is per-handler, not per-call (both of
	// settingsButtonClicked's posts share the same prefix).
	it.each([
		{ command: "zoo-code.settingsButtonClicked", prefix: "settingsButtonClicked", expectedCalls: 2 },
		{ command: "zoo-code.historyButtonClicked", prefix: "historyButtonClicked", expectedCalls: 1 },
		{ command: "zoo-code.marketplaceButtonClicked", prefix: "marketplaceButtonClicked", expectedCalls: 1 },
		{ command: "zoo-code.acceptInput", prefix: "acceptInput", expectedCalls: 1 },
	])(
		"$command logs to outputChannel when postMessageToWebview rejects",
		async ({ command, prefix, expectedCalls }) => {
			const boom = new Error("boom")
			mockVisibleProvider.postMessageToWebview.mockReset()
			mockVisibleProvider.postMessageToWebview.mockRejectedValue(boom)

			handlers[command]()

			// Flush microtasks so the chained .catch arm runs.
			await new Promise((resolve) => setImmediate(resolve))

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(expectedCalls)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				`[${prefix}] postMessageToWebview failed: ${boom}`,
			)
		},
	)

	it("toggleAutoApprove logs to outputChannel when postMessageToWebview rejects", async () => {
		// toggleAutoApprove is `async` and awaits postMessageToWebview inside a
		// try/catch (rather than relying on a `.catch` microtask like the
		// void-prefixed sites), so awaiting the handler itself is sufficient to
		// observe the appendLine call.
		const boom = new Error("boom")
		mockVisibleProvider.postMessageToWebview.mockReset()
		mockVisibleProvider.postMessageToWebview.mockRejectedValue(boom)

		await handlers["zoo-code.toggleAutoApprove"]()

		expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(1)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			`[toggleAutoApprove] postMessageToWebview failed: ${boom}`,
		)
	})

	it("plusButtonClicked calls evictCurrentTask on the visible provider", async () => {
		const evictCurrentTask = vi.fn().mockResolvedValue(undefined)
		const refreshWorkspace = vi.fn().mockResolvedValue(undefined)
		;(mockVisibleProvider as any).evictCurrentTask = evictCurrentTask
		;(mockVisibleProvider as any).refreshWorkspace = refreshWorkspace

		await handlers["zoo-code.plusButtonClicked"]()

		expect(evictCurrentTask).toHaveBeenCalledTimes(1)
	})

	it("plusButtonClicked is a no-op when no visible provider", async () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		// Should not throw even with no visible provider
		await handlers["zoo-code.plusButtonClicked"]()
	})
})

// The openInBrowser command is dev-only tooling: it is not contributed in
// package.json and is registered directly through registerBrowserBridgeCommand
// (only when ROO_BROWSER_BRIDGE=1 in a Development host), so these tests drive
// that function instead of the main registration loop.
describe("registerBrowserBridgeCommand", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockVisibleProvider: {
		getActiveBrowserBridgePort: Mock
		enableBrowserBridge: Mock
	}
	let openInBrowser: () => Promise<unknown>

	const getOpenedUrl = (): string => {
		const uri = vi.mocked(vscode.env.openExternal).mock.calls[0]?.[0] as { toString(): string } | undefined
		return uri?.toString() ?? ""
	}

	beforeEach(() => {
		vi.clearAllMocks()

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

		mockVisibleProvider = {
			getActiveBrowserBridgePort: vi.fn().mockReturnValue(undefined),
			enableBrowserBridge: vi.fn(),
		}
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockVisibleProvider)

		let handler: (() => Promise<unknown>) | undefined
		;(vscode.commands.registerCommand as Mock).mockImplementation((id: string, cb: () => Promise<unknown>) => {
			expect(id).toBe("zoo-code.openInBrowser")
			handler = cb
			return { dispose: vi.fn() }
		})

		registerBrowserBridgeCommand({
			context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
			outputChannel: mockOutputChannel,
			provider: {} as ClineProvider,
		})
		openInBrowser = () => handler!()
	})

	it("starts a bridge, enables it on the provider, and opens the URL with the port", async () => {
		const bridge = {
			port: 43210,
			dispose: vi.fn(),
			getBrowserUrl: vi.fn().mockReturnValue("http://localhost:5173/?bridgePort=43210"),
		}
		const { BrowserBridgeServer } = await import("../../core/webview/browserBridge")
		vi.mocked(BrowserBridgeServer.start).mockResolvedValue(bridge as never)

		await openInBrowser()

		expect(BrowserBridgeServer.start).toHaveBeenCalledTimes(1)
		expect(mockVisibleProvider.enableBrowserBridge).toHaveBeenCalledWith(bridge)
		expect(mockVisibleProvider.getActiveBrowserBridgePort).toHaveBeenCalled()
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
		expect(getOpenedUrl()).toBe("http://localhost:5173/?bridgePort=43210")
	})

	it("reuses the existing bridge and does not start a second one", async () => {
		const { BrowserBridgeServer } = await import("../../core/webview/browserBridge")
		mockVisibleProvider.getActiveBrowserBridgePort.mockReturnValue(43210)

		await openInBrowser()

		expect(BrowserBridgeServer.start).not.toHaveBeenCalled()
		expect(mockVisibleProvider.enableBrowserBridge).not.toHaveBeenCalled()
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1)
		expect(getOpenedUrl()).toBe("http://localhost:5173/?bridgePort=43210")
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[openInBrowser] Reusing existing browser bridge on port 43210.",
		)
	})

	it("aborts when there is no visible provider", async () => {
		const { BrowserBridgeServer } = await import("../../core/webview/browserBridge")
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		await openInBrowser()

		expect(BrowserBridgeServer.start).not.toHaveBeenCalled()
		expect(vscode.env.openExternal).not.toHaveBeenCalled()
	})

	it("logs when the bridge fails to start", async () => {
		const { BrowserBridgeServer } = await import("../../core/webview/browserBridge")
		vi.mocked(BrowserBridgeServer.start).mockResolvedValue(undefined as never)

		await openInBrowser()

		expect(mockVisibleProvider.enableBrowserBridge).not.toHaveBeenCalled()
		expect(vscode.env.openExternal).not.toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("[openInBrowser] Failed to start the browser bridge.")
	})
})

describe("openClineInNewTab", () => {
	let mockOutputChannel: vscode.OutputChannel
	let mockContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

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

		mockContext = {
			subscriptions: [],
			extensionUri: { path: "/mock/ext" },
		} as unknown as vscode.ExtensionContext

		const mockPanel = {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		}
		;(vscode.window.createWebviewPanel as Mock).mockReturnValue(mockPanel)

		// Reset module-level panel state.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
	})

	it("creates a webview panel with title 'Zoo Code'", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"zoo-code.TabPanelProvider",
			"Zoo Code",
			expect.any(Number),
			expect.objectContaining({
				enableScripts: true,
				retainContextWhenHidden: true,
			}),
		)
	})
})
