import type { Mock } from "vitest"
import * as vscode from "vscode"
import { TelemetryService } from "@roo-code/telemetry"

import { ContextProxy } from "../../core/config/ContextProxy"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { MdmService } from "../../services/mdm/MdmService"

import {
	__getLiveTabPanelCountForTests,
	__resetLiveTabPanelsForTests,
	getPanel,
	getVisibleProviderOrLog,
	openClineInNewTab,
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
	},
	ViewColumn: {
		Two: 2,
	},
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		createWebviewPanel: vi.fn(),
		visibleTextEditors: [],
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

vi.mock("../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn(),
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
	let mockVisibleProvider: { postMessageToWebview: Mock }
	let mockProvider: {
		postMessageToWebview: Mock
		evictCurrentTask: Mock
		refreshWorkspace: Mock
	}
	let handlers: Record<string, (...args: unknown[]) => unknown>

	beforeEach(() => {
		vi.clearAllMocks()
		// clearAllMocks() keeps mock implementations: reset the instance-lookup
		// return value so a preceding test's tab double cannot leak into the
		// dead-tab drop assertions below.
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)
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
		}

		mockProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
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

	// The sidebar title-bar handlers target the registered provider (the
	// sidebar click origin) directly, not the visible-instance heuristic.
	it("settingsButtonClicked posts both settingsButtonClicked and didBecomeVisible actions on the registered provider", () => {
		handlers["zoo-code.settingsButtonClicked"]()

		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("settings")
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "settingsButtonClicked",
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(2)
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("historyButtonClicked posts historyButtonClicked action on the registered provider", () => {
		handlers["zoo-code.historyButtonClicked"]()

		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("history")
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("marketplaceButtonClicked posts marketplaceButtonClicked action on the registered provider", () => {
		handlers["zoo-code.marketplaceButtonClicked"]()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "marketplaceButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// The `*InTab` handlers serve the `editor/title` menu: they target the
	// instance that owns the tracked tab panel, resolved via
	// ClineProvider.getInstanceForView.
	const tabHandlerCases: { command: string; actions: string[]; telemetry?: string }[] = [
		{
			command: "zoo-code.settingsButtonClickedInTab",
			actions: ["settingsButtonClicked", "didBecomeVisible"],
			telemetry: "settings",
		},
		{ command: "zoo-code.historyButtonClickedInTab", actions: ["historyButtonClicked"], telemetry: "history" },
		{ command: "zoo-code.marketplaceButtonClickedInTab", actions: ["marketplaceButtonClicked"] },
	]
	it.each(tabHandlerCases)(
		"$command targets the tab instance for the tracked tab panel",
		({ command, actions, telemetry }) => {
			const mockTabProvider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
			// Retain the tracked tab panel and pin the instance lookup
			// against its identity: a handler that resolved the sidebar view
			// or any other view must fail instead of passing on the stubbed
			// provider result alone.
			const tabPanel = {} as vscode.WebviewPanel
			setPanel(tabPanel, "tab")
			;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

			handlers[command]()

			// Identity pin: the lookup must receive the exact tracked panel
			// object, not a different object that merely compares equal.
			expect((ClineProvider.getInstanceForView as Mock).mock.calls[0]![0]).toBe(tabPanel)
			for (const action of actions) {
				expect(mockTabProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action })
			}
			expect(mockTabProvider.postMessageToWebview).toHaveBeenCalledTimes(actions.length)
			if (telemetry) {
				expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith(telemetry)
			}
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		},
	)

	// The `*InTab` handlers must no-op when there is no live tab instance: a
	// missing or disposed tab must not crash the handler or fall back to
	// another instance. Every handler is awaited, so an async handler that
	// slipped past its guard (rejecting on the missing instance) fails the
	// test instead of settling as an unhandled rejection.
	const inTabNoOpCommands = [
		"zoo-code.plusButtonClickedInTab",
		"zoo-code.settingsButtonClickedInTab",
		"zoo-code.historyButtonClickedInTab",
		"zoo-code.marketplaceButtonClickedInTab",
	]
	it.each(inTabNoOpCommands)("%s is a no-op when no tab panel is tracked", async (command) => {
		await handlers[command]()

		expect(ClineProvider.getInstanceForView as Mock).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each(inTabNoOpCommands)("%s is a no-op when the tab instance is disposed", async (command) => {
		const disposedPanel = {} as vscode.WebviewPanel
		setPanel(disposedPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		await handlers[command]()

		expect(ClineProvider.getInstanceForView as Mock).toHaveBeenCalledWith(disposedPanel)
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
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

	it("focusInput does not post when no sidebar panel is tracked", async () => {
		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("focusInput logs the drop when a tab panel is tracked without a live tab instance", async () => {
		setPanel({} as vscode.WebviewView, "sidebar")
		setPanel({} as vscode.WebviewPanel, "tab")

		await handlers["zoo-code.focusInput"]()

		// The tab takes selection priority, so the sidebar must not receive
		// the message; with no live tab instance the action is dropped and the
		// drop is logged so the silent no-op stays diagnosable.
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"focusInput: no live provider for the tracked tab panel; action dropped",
		)
	})

	it("focusInput posts the focus message on the tab instance when a tab panel is tracked", async () => {
		const mockTabProvider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		setPanel({} as vscode.WebviewView, "sidebar")
		const tabPanel = {} as vscode.WebviewPanel
		setPanel(tabPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

		await handlers["zoo-code.focusInput"]()

		// The tab takes selection priority: assert it was selected by identity
		// (reference, not structural equality).
		expect((ClineProvider.getInstanceForView as Mock).mock.calls[0]![0]).toBe(tabPanel)
		// No error was logged on the success path.
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
		expect(mockTabProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("setPanel keeps independent refs: clearing only the tab ref re-enables the sidebar post", async () => {
		setPanel({} as vscode.WebviewView, "sidebar")
		setPanel({} as vscode.WebviewPanel, "tab")

		// The tab ref does not wipe the sidebar ref... (the dead-tab drop is
		// logged, and the sidebar still must not receive the message).
		await handlers["zoo-code.focusInput"]()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"focusInput: no live provider for the tracked tab panel; action dropped",
		)

		// ...and clearing only the tab ref re-enables the sidebar post.
		setPanel(undefined, "tab")
		await handlers["zoo-code.focusInput"]()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	// Coverage for the .catch arm on the sidebar title-bar post sites
	// (settingsButtonClicked posts twice, plus historyButtonClicked and
	// marketplaceButtonClicked) and acceptInput (the visible-provider path).
	// Each handler is synchronous, so the .catch arm runs on a microtask;
	// setImmediate ensures all microtasks are flushed before we assert. The
	// log messages carry a `[<handlerName>]` prefix so multi-failure logs
	// remain unambiguous; the prefix is per-handler, not per-call (both of
	// settingsButtonClicked's posts share the same prefix). Each post rejects
	// with its own error and call N is pinned to post N, so a mutant that
	// alters one catch's message cannot hide behind the other post's
	// identical log.
	it.each([
		{
			command: "zoo-code.settingsButtonClicked",
			prefix: "settingsButtonClicked",
			errorLabels: ["first post", "second post"],
			target: "sidebar" as const,
		},
		{
			command: "zoo-code.historyButtonClicked",
			prefix: "historyButtonClicked",
			errorLabels: ["post"],
			target: "sidebar" as const,
		},
		{
			command: "zoo-code.marketplaceButtonClicked",
			prefix: "marketplaceButtonClicked",
			errorLabels: ["post"],
			target: "sidebar" as const,
		},
		{ command: "zoo-code.acceptInput", prefix: "acceptInput", errorLabels: ["post"], target: "visible" as const },
	])(
		"$command logs to outputChannel when postMessageToWebview rejects",
		async ({ command, prefix, errorLabels, target }) => {
			const post =
				target === "sidebar" ? mockProvider.postMessageToWebview : mockVisibleProvider.postMessageToWebview
			post.mockReset()
			const booms = errorLabels.map((label) => new Error(label))
			booms.forEach((boom) => post.mockRejectedValueOnce(boom))

			handlers[command]()

			// Flush microtasks so the chained .catch arms run.
			await new Promise((resolve) => setImmediate(resolve))

			expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(booms.length)
			booms.forEach((boom, index) => {
				expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
					index + 1,
					`[${prefix}] postMessageToWebview failed: ${boom}`,
				)
			})
		},
	)

	// The two posts reject with distinct errors and the nth-call assertions
	// pin each catch's message, so neither template literal can survive
	// behind the other post's identical log.
	it("settingsButtonClickedInTab logs to outputChannel when postMessageToWebview rejects", async () => {
		const booms = [new Error("first post"), new Error("second post")]
		const mockTabProvider = {
			postMessageToWebview: vi.fn().mockRejectedValueOnce(booms[0]).mockRejectedValueOnce(booms[1]),
		}
		setPanel({} as vscode.WebviewPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

		handlers["zoo-code.settingsButtonClickedInTab"]()

		// Flush microtasks so the chained .catch arms run.
		await new Promise((resolve) => setImmediate(resolve))

		expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(2)
		expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
			1,
			`[settingsButtonClickedInTab] postMessageToWebview failed: ${booms[0]}`,
		)
		expect(mockOutputChannel.appendLine).toHaveBeenNthCalledWith(
			2,
			`[settingsButtonClickedInTab] postMessageToWebview failed: ${booms[1]}`,
		)
	})

	// The history and marketplace InTab catch sites share the identical
	// single-post pattern (their sidebar equivalents are covered by the
	// it.each above); pin their exact messages too.
	it.each([
		{ command: "zoo-code.historyButtonClickedInTab", prefix: "historyButtonClickedInTab" },
		{ command: "zoo-code.marketplaceButtonClickedInTab", prefix: "marketplaceButtonClickedInTab" },
	])("$command logs to outputChannel when the tab postMessageToWebview rejects", async ({ command, prefix }) => {
		const boom = new Error("post")
		const mockTabProvider = { postMessageToWebview: vi.fn().mockRejectedValue(boom) }
		setPanel({} as vscode.WebviewPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

		handlers[command]()

		// Flush microtasks so the chained .catch arm runs.
		await new Promise((resolve) => setImmediate(resolve))

		expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(1)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(`[${prefix}] postMessageToWebview failed: ${boom}`)
	})

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

	it("plusButtonClicked calls evictCurrentTask on the registered sidebar provider", async () => {
		await handlers["zoo-code.plusButtonClicked"]()

		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("plus")
		expect(mockProvider.evictCurrentTask).toHaveBeenCalledTimes(1)
		expect(mockProvider.refreshWorkspace).toHaveBeenCalledTimes(1)
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	it("plusButtonClickedInTab evicts and posts on the tab instance for the tracked tab panel", async () => {
		const mockTabProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
		}
		// Same identity pin as the other InTab cases: the eviction must run
		// against the provider resolved from the exact tracked tab panel.
		const tabPanel = {} as vscode.WebviewPanel
		setPanel(tabPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

		await handlers["zoo-code.plusButtonClickedInTab"]()

		// Identity pin: the eviction must run against the provider resolved
		// from the exact tracked panel object, not a merely-equal stub.
		expect((ClineProvider.getInstanceForView as Mock).mock.calls[0]![0]).toBe(tabPanel)
		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("plus")
		expect(mockTabProvider.evictCurrentTask).toHaveBeenCalledTimes(1)
		expect(mockTabProvider.refreshWorkspace).toHaveBeenCalledTimes(1)
		expect(mockTabProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
		})
		expect(mockTabProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
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
		__resetLiveTabPanelsForTests()
	})

	it("creates a webview panel with title 'Zoo Code'", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// No tab was tracked, so the reuse path (and its instance lookup)
		// must not run.
		expect(ClineProvider.getInstanceForView as Mock).not.toHaveBeenCalled()
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

	it("reveals the existing tab instead of creating a second panel", async () => {
		const mockExistingProvider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		const mockPanel = Object.assign({} as vscode.WebviewPanel, {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn().mockResolvedValue(undefined),
		})
		setPanel(mockPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockExistingProvider)

		const result = await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(result).toBe(mockExistingProvider)
		expect(mockPanel.reveal).toHaveBeenCalledTimes(1)
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		expect(mockExistingProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
	})

	it("creates a new tab panel when the tracked tab's provider has been disposed", async () => {
		const mockPanel = Object.assign({} as vscode.WebviewPanel, {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn().mockResolvedValue(undefined),
		})
		setPanel(mockPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// The reuse path must resolve the tracked panel (not skip the lookup):
		// without this assertion the test would also pass if the handler
		// stopped consulting getInstanceForView at all.
		expect(ClineProvider.getInstanceForView as Mock).toHaveBeenCalledWith(mockPanel)
		expect(mockPanel.reveal).not.toHaveBeenCalled()
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("re-points the tracked tab ref at the panel that becomes active", async () => {
		// Panel A is created first and tracked...
		const panelA = Object.assign({} as vscode.WebviewPanel, {
			marker: "panel-A",
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panelA)
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// ...then panel B is created, which re-points the tracked tab ref.
		const panelB = Object.assign({} as vscode.WebviewPanel, {
			marker: "panel-B",
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panelB)
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// Activating A must reassign the tracked tab ref to A's panel...
		const stateChange = (panelA.onDidChangeViewState as Mock).mock.calls[0]![0] as (e: {
			webviewPanel: vscode.WebviewPanel
		}) => void
		// Activate panelA in place and pass it through: the production handler
		// tracks e.webviewPanel directly, so a clone would let a handler that
		// copies the event panel still pass the identity check below.
		Object.assign(panelA, { active: true, visible: true })
		stateChange({ webviewPanel: panelA })

		// ...so plusButtonClickedInTab targets A's provider, not B's.
		const mockProviderA = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
		}
		// Require the tracked panel by identity: a handler that clones the
		// state-change panel can no longer resolve the provider.
		;(ClineProvider.getInstanceForView as Mock).mockImplementation((view: unknown) =>
			view === panelA ? mockProviderA : undefined,
		)
		const handlers = new Map<string, (...args: unknown[]) => unknown>()
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				handlers.set(id, cb)
				return { dispose: vi.fn() }
			},
		)
		const mockSidebarProvider = Object.assign({} as ClineProvider, {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		})
		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: mockSidebarProvider,
		})

		await handlers.get("zoo-code.plusButtonClickedInTab")!()

		expect(mockProviderA.evictCurrentTask).toHaveBeenCalledTimes(1)
		expect(mockProviderA.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
		expect(mockProviderA.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	it("falls back to an undefined MdmService when MdmService.getInstance throws", async () => {
		;(MdmService.getInstance as Mock).mockImplementation(() => {
			throw new Error("MDM service not initialized")
		})

		const provider = await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// The creation must survive the MDM lookup failure: the provider is
		// constructed with an undefined MDM service and the tab panel is
		// still created.
		const ctor = vi.mocked(ClineProvider)
		expect(ctor.mock.instances[0]).toBeDefined()
		expect(ctor).toHaveBeenCalledWith(mockContext, mockOutputChannel, "editor", undefined, undefined)
		expect(provider).toBe(ctor.mock.instances[0])
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)

		// The fallback is observable in the output channel.
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[openClineInNewTab] MDM service unavailable, continuing without it: Error: MDM service not initialized",
		)
	})

	it("opens a new group to the right and targets ViewColumn.Two when no editors are visible", async () => {
		// The vscode mock factory declares a mutable visibleTextEditors slot that the
		// readonly public API type hides, so seed it through Object.assign.
		Object.assign(vscode.window, { visibleTextEditors: [] })

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.lockEditorGroup")
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"zoo-code.TabPanelProvider",
			"Zoo Code",
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [mockContext.extensionUri],
			},
		)

		// The panel icon points at the extension's asset files.
		const panel = (vscode.window.createWebviewPanel as Mock).mock.results[0].value as {
			iconPath?: { light: { path: string }; dark: { path: string } }
		}
		expect(panel.iconPath).toEqual({
			light: { path: "assets/icons/panel_light.png" },
			dark: { path: "assets/icons/panel_dark.png" },
		})
	})

	it("treats editors without a viewColumn as column 0 when computing the target column", async () => {
		// openClineInNewTab only reads viewColumn from each editor, so the
		// fixture keeps that single field.
		const editorWithoutColumn = Object.assign({} as vscode.TextEditor, { viewColumn: undefined })
		Object.assign(vscode.window, {
			visibleTextEditors: [editorWithoutColumn],
		})

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// lastCol falls back to 0, so the panel lands on column 1 instead of
		// opening a new editor group.
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"zoo-code.TabPanelProvider",
			"Zoo Code",
			1,
			expect.objectContaining({ enableScripts: true }),
		)
	})

	it("places the tab panel one column right of the rightmost visible editor", async () => {
		// openClineInNewTab only reads viewColumn from each editor, so the
		// fixtures keep that single field.
		Object.assign(vscode.window, {
			visibleTextEditors: [
				Object.assign({} as vscode.TextEditor, { viewColumn: 1 }),
				Object.assign({} as vscode.TextEditor, { viewColumn: 3 }),
			],
		})

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// lastCol is 3, so the panel lands on column 4 without opening a new
		// editor group.
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.newGroupRight")
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
			"zoo-code.TabPanelProvider",
			"Zoo Code",
			4,
			expect.objectContaining({ enableScripts: true }),
		)
	})

	it("constructs the tab provider with the 'editor' context and the live MdmService instance", async () => {
		// MdmService has a private constructor, so pin a sentinel stand-in.
		const mockMdm = Object.assign({} as MdmService, { name: "mock-mdm" })
		;(MdmService.getInstance as Mock).mockReturnValue(mockMdm)

		const provider = await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		const ctor = vi.mocked(ClineProvider)
		expect(ctor).toHaveBeenCalledTimes(1)
		expect(ctor).toHaveBeenCalledWith(mockContext, mockOutputChannel, "editor", undefined, mockMdm)
		expect(provider).toBe(ctor.mock.instances[0])
	})

	it("posts didBecomeVisible only for visible state changes and clears the tracked tab on dispose", async () => {
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// Retain the panel returned during creation and pin the tracked tab
		// against it with identity (not a weak defined check), so a wrong or
		// duplicated tracked panel fails before the dispose assertions.
		const panel = (vscode.window.createWebviewPanel as Mock).mock.results[0].value as {
			onDidChangeViewState: Mock
			onDidDispose: Mock
		}
		expect(getPanel()).toBe(panel)

		const stateHandler = panel.onDidChangeViewState.mock.calls[0][0] as (event: {
			webviewPanel: { visible: boolean; webview: { postMessage: (message: unknown) => void } }
		}) => void
		const visibleEvent = { webviewPanel: { visible: true, webview: { postMessage: vi.fn() } } }
		stateHandler(visibleEvent)
		expect(visibleEvent.webviewPanel.webview.postMessage).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})

		const hiddenEvent = { webviewPanel: { visible: false, webview: { postMessage: vi.fn() } } }
		stateHandler(hiddenEvent)
		expect(hiddenEvent.webviewPanel.webview.postMessage).not.toHaveBeenCalled()

		const disposeHandler = panel.onDidDispose.mock.calls[0][0] as () => void
		disposeHandler()
		expect(getPanel()).toBeUndefined()
	})

	it("re-points the tracked tab ref at the remaining live panel when the tracked panel closes", async () => {
		// Panel A is created and tracked first...
		const panelA = Object.assign({} as vscode.WebviewPanel, {
			marker: "panel-A",
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panelA)
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		// ...then panel B opens in a different group: B becomes active, so the
		// state-change handler re-points the tracked ref at B.
		const panelB = Object.assign({} as vscode.WebviewPanel, {
			marker: "panel-B",
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panelB)
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		Object.assign(panelB, { active: true, visible: true })
		;(panelB.onDidChangeViewState as Mock).mock.calls[0]![0]!({ webviewPanel: panelB })
		expect(getPanel()).toBe(panelB)

		// Closing the tracked panel (B) emits no state change for A, so the dispose
		// handler alone must re-point the tracked ref at the remaining live panel.
		Object.assign(panelA, { visible: true })
		const disposeB = (panelB.onDidDispose as Mock).mock.calls[0]![0] as () => void
		disposeB()
		expect(getPanel()).toBe(panelA)

		// The re-pointed panel must actually serve the tab-scoped commands: the
		// command handler resolves the provider from the tracked panel, so panel
		// A's provider receives the message even though B was created last.
		const replacementProvider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(replacementProvider)
		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: {} as ClineProvider,
		})
		await commandHandlers["zoo-code.historyButtonClickedInTab"]()
		expect(replacementProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
		// The lookup must target the re-pointed tracked panel (A), not B or the
		// sidebar: a lookup of the wrong panel would still reach the mock.
		expect(ClineProvider.getInstanceForView as Mock).toHaveBeenCalledWith(panelA)

		// Closing the last live tab clears the ref again.
		const disposeA = (panelA.onDidDispose as Mock).mock.calls[0]![0] as () => void
		disposeA()
		expect(getPanel()).toBeUndefined()
	})

	it("re-points the tracked tab at the best remaining live panel on close", async () => {
		const makePanel = (marker: string) =>
			Object.assign({} as vscode.WebviewPanel, {
				marker,
				webview: { postMessage: vi.fn() },
				onDidChangeViewState: vi.fn(),
				onDidDispose: vi.fn(),
			})
		const openThree = async (p1: vscode.WebviewPanel, p2: vscode.WebviewPanel, p3: vscode.WebviewPanel) => {
			;(vscode.window.createWebviewPanel as Mock)
				.mockReturnValueOnce(p1)
				.mockReturnValueOnce(p2)
				.mockReturnValueOnce(p3)
			// A preceding test's instance-lookup double must not leak into the reuse
			// path: each open here creates a fresh panel.
			;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)
			await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
			await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
			await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
			// The last created panel becomes the tracked tab.
			;(p3.onDidChangeViewState as Mock).mock.calls[0]![0]!({ webviewPanel: p3 })
			expect(getPanel()).toBe(p3)
			return p3
		}
		const disposeTracked = (p: vscode.WebviewPanel) => {
			const handler = (p.onDidDispose as Mock).mock.calls[0]![0] as () => void
			handler()
		}

		// Phase 1 — an active remaining panel wins over a visible one, even
		// while the active panel itself is not visible: during a view-state
		// transition active and visible can diverge, and the active panel is
		// the one the user was last looking at, so it must win the re-pointing.
		const panelA = makePanel("phase-1-A")
		const panelD = makePanel("phase-1-D")
		const panelC = makePanel("phase-1-C")
		await openThree(panelA, panelD, panelC)
		Object.assign(panelA, { active: true, visible: false })
		Object.assign(panelD, { active: false, visible: true })
		disposeTracked(panelC)
		expect(getPanel()).toBe(panelA)

		// Phase 2 — a visible remaining panel wins over a hidden one.
		__resetLiveTabPanelsForTests()
		setPanel(undefined, "tab")
		const panelE = makePanel("phase-2-E")
		const panelV = makePanel("phase-2-V")
		const panelC2 = makePanel("phase-2-C")
		await openThree(panelE, panelV, panelC2)
		Object.assign(panelE, { active: false, visible: false })
		Object.assign(panelV, { active: false, visible: true })
		disposeTracked(panelC2)
		expect(getPanel()).toBe(panelV)

		// Phase 3 — with no active or visible remaining panel, the first remaining
		// panel keeps the tracked ref: a panel can be open but hidden behind another
		// editor group (neither active nor visible), and dropping the ref here would
		// let the next open create a second panel instead of revealing it.
		__resetLiveTabPanelsForTests()
		setPanel(undefined, "tab")
		const panelH1 = makePanel("phase-3-H1")
		const panelH2 = makePanel("phase-3-H2")
		const panelC3 = makePanel("phase-3-C")
		await openThree(panelH1, panelH2, panelC3)
		Object.assign(panelH1, { active: false, visible: false })
		Object.assign(panelH2, { active: false, visible: false })
		disposeTracked(panelC3)
		expect(getPanel()).toBe(panelH1)
	})

	it("serializes concurrent opens so overlapping calls create one panel and share one provider", async () => {
		const [first, second] = await Promise.all([
			openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel }),
			openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel }),
		])

		// Overlapping "Open in editor" calls must share the in-flight
		// creation: exactly one tab panel is created and both callers receive
		// the same constructed provider. Pinning both results against the
		// mocked constructor (not just against each other) keeps the test
		// failing if the shared result is undefined.
		const ctor = vi.mocked(ClineProvider)
		const constructed = ctor.mock.instances[0]
		expect(constructed).toBeDefined()
		expect(first).toBe(constructed)
		expect(second).toBe(constructed)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("shares one in-flight creation when openInNewTab and popoutButtonClicked start before it resolves", async () => {
		// Defer the first creation at ContextProxy.getInstance so both command
		// handlers can start while the creation is still in flight.
		let resolveContextProxy!: () => void
		;(ContextProxy.getInstance as Mock).mockReturnValue(
			new Promise<void>((resolve) => {
				resolveContextProxy = resolve
			}),
		)

		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		const sidebarProvider = Object.assign({} as ClineProvider, {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		})
		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: sidebarProvider,
		})

		const started = [commandHandlers["zoo-code.openInNewTab"](), commandHandlers["zoo-code.popoutButtonClicked"]()]

		// While the shared creation is suspended at ContextProxy.getInstance,
		// neither caller has created a panel yet.
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()

		resolveContextProxy()
		const [first, second] = await Promise.all(started)

		// Both command entry points await the shared in-flight creation:
		// exactly one tab panel is created and both results are the same
		// constructed provider.
		const ctor = vi.mocked(ClineProvider)
		const constructed = ctor.mock.instances[0]
		expect(constructed).toBeDefined()
		expect(first).toBe(constructed)
		expect(second).toBe(constructed)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("creates a fresh panel for a new call once the previous creation settled and its provider disposed", async () => {
		// The first open settles and tracks its panel.
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)

		// The tracked provider is disposed, so the next open cannot reuse the
		// existing tab: the settled (and cleared) in-flight promise must not
		// be returned, and a fresh panel is created.
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		const secondProvider = await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		const ctor = vi.mocked(ClineProvider)
		const second = ctor.mock.instances[1]
		expect(second).toBeDefined()
		expect(secondProvider).toBe(second)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("keeps the replacement panel tracked when a stale panel's disposal fires late", async () => {
		// Capture each created panel so the first panel's (stale) dispose
		// handler can fire after the replacement is already tracked.
		const createdPanels: { onDidDispose: Mock }[] = []
		;(vscode.window.createWebviewPanel as Mock).mockImplementation(() => {
			const panel = {
				webview: { postMessage: vi.fn() },
				onDidChangeViewState: vi.fn(),
				onDidDispose: vi.fn(),
			}
			createdPanels.push(panel)
			return panel
		})

		// First open creates and tracks panel A.
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		expect(getPanel()).toBe(createdPanels[0])

		// Panel A's provider is disposed before the second open, so the
		// second open creates the replacement panel B.
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
		expect(getPanel()).toBe(createdPanels[1])

		// Panel A's stale dispose handler fires after the replacement is
		// tracked; it must not clobber the replacement's ref.
		createdPanels[0].onDidDispose.mock.calls[0][0]()

		expect(getPanel()).toBe(createdPanels[1])

		// Tab-surface commands still reach the provider that owns the
		// replacement panel after the stale disposal.
		const replacementProvider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(replacementProvider)
		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		registerCommands({
			context: mockContext,
			outputChannel: mockOutputChannel,
			provider: {} as ClineProvider,
		})
		await commandHandlers["zoo-code.historyButtonClickedInTab"]()
		expect(replacementProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
	})
})

describe("openClineInNewTab initialization failure", () => {
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
		__resetLiveTabPanelsForTests()
	})

	it("cleans up the tracked refs and disposes the provider when initialization fails", async () => {
		const resolveSpy = vi
			.spyOn(ClineProvider.prototype, "resolveWebviewView")
			.mockRejectedValue(new Error("init failed"))
		const disposeSpy = vi.spyOn(ClineProvider.prototype, "dispose").mockResolvedValue(undefined)

		await expect(openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })).rejects.toThrow(
			"init failed",
		)

		// The half-registered panel must not stay tracked: the live registry
		// drops it, the tracked tab ref is cleared (identity-guarded), and the
		// provider is disposed so the failed surface leaves no listeners or
		// state behind.
		expect(__getLiveTabPanelCountForTests()).toBe(0)
		expect(getPanel()).toBeUndefined()
		expect(disposeSpy).toHaveBeenCalledTimes(1)

		resolveSpy.mockRestore()
		disposeSpy.mockRestore()
	})
})
