import type { Mock } from "vitest"
import * as vscode from "vscode"
import { TelemetryService } from "@roo-code/telemetry"

import { ClineProvider } from "../../core/webview/ClineProvider"

import { getVisibleProviderOrLog, openClineInNewTab, registerCommands, setPanel } from "../registerCommands"

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
	let mockVisibleProvider: { postMessageToWebview: Mock }
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
			setPanel({} as vscode.WebviewPanel, "tab")
			;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

			handlers[command]()

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
	it.each(inTabNoOpCommands)("$command is a no-op when no tab panel is tracked", async (command) => {
		await handlers[command]()

		expect(ClineProvider.getInstanceForView as Mock).not.toHaveBeenCalled()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each(inTabNoOpCommands)("$command is a no-op when the tab instance is disposed", async (command) => {
		setPanel({} as vscode.WebviewPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		await handlers[command]()

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

	it("focusInput does not post when a tab panel is tracked alongside the sidebar", async () => {
		setPanel({} as vscode.WebviewView, "sidebar")
		setPanel({} as vscode.WebviewPanel, "tab")

		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("setPanel keeps independent refs: clearing only the tab ref re-enables the sidebar post", async () => {
		setPanel({} as vscode.WebviewView, "sidebar")
		setPanel({} as vscode.WebviewPanel, "tab")

		// The tab ref does not wipe the sidebar ref...
		await handlers["zoo-code.focusInput"]()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()

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
		const evictCurrentTask = vi.fn().mockResolvedValue(undefined)
		const refreshWorkspace = vi.fn().mockResolvedValue(undefined)
		;(mockProvider as any).evictCurrentTask = evictCurrentTask
		;(mockProvider as any).refreshWorkspace = refreshWorkspace

		await handlers["zoo-code.plusButtonClicked"]()

		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("plus")
		expect(evictCurrentTask).toHaveBeenCalledTimes(1)
		expect(refreshWorkspace).toHaveBeenCalledTimes(1)
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "chatButtonClicked" })
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	it("plusButtonClickedInTab evicts and posts on the tab instance for the tracked tab panel", async () => {
		const mockTabProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
		}
		setPanel({} as vscode.WebviewPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(mockTabProvider)

		await handlers["zoo-code.plusButtonClickedInTab"]()

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
		const mockPanel = {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn().mockResolvedValue(undefined),
		} as unknown as vscode.WebviewPanel
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
		const mockPanel = {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			reveal: vi.fn().mockResolvedValue(undefined),
		} as unknown as vscode.WebviewPanel
		setPanel(mockPanel, "tab")
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel })

		expect(mockPanel.reveal).not.toHaveBeenCalled()
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})
})
