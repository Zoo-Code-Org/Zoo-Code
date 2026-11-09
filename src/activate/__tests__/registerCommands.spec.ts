import type { Mock } from "vitest"
import * as vscode from "vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName, type TelemetryProperties } from "@roo-code/types"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { WebviewFocusTracker } from "../../core/webview/WebviewFocusTracker"
import { ContextProxy } from "../../core/config/ContextProxy"
import { makeExtensionContext } from "../../test-utils/vscode"
import { MdmService } from "../../services/mdm/MdmService"

import {
	getPanel,
	getVisibleProviderOrLog,
	openClineInNewTab,
	openClineInNewTabForApi,
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

// The real telemetry client derives every event's properties from the provider that was bound
// last (BaseTelemetryClient holds it as a WeakRef), so the binding order is observable through
// the properties of an event captured afterwards.
const telemetryBinding = vi.hoisted(() => ({
	current: undefined as { getTelemetryProperties(): Promise<Record<string, unknown>> } | undefined,
	events: [] as Record<string, unknown>[],
	pending: [] as Promise<void>[],
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
			setProvider: vi.fn((provider: { getTelemetryProperties(): Promise<Record<string, unknown>> }) => {
				telemetryBinding.current = provider
			}),
			captureEvent: vi.fn((event: string, properties?: Record<string, unknown>) => {
				telemetryBinding.pending.push(
					(async () => {
						const providerProperties = telemetryBinding.current
							? await telemetryBinding.current.getTelemetryProperties()
							: {}
						telemetryBinding.events.push({ event, ...providerProperties, ...(properties || {}) })
					})(),
				)
			}),
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

vi.mock("../../services/diagnostics", () => ({
	createDiagnosticsReport: vi.fn(),
}))
vi.mock("../../services/ripgrep/diagnostic", () => ({
	registerRipgrepDiagnosticCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
}))

// A tab panel double: shaped the way the survivor rule reads a panel - active and visible
// state plus the registration hooks the creation path installs - so a test asserts against
// panel identity rather than structure.
const makeTabPanel = (title: string, viewState: { active: boolean; visible: boolean }): vscode.WebviewPanel => ({
	viewType: "zoo-code.TabPanelProvider",
	title,
	webview: {
		options: {},
		html: "",
		cspSource: "test-webview",
		postMessage: vi.fn().mockResolvedValue(true),
		onDidReceiveMessage: vi.fn(),
		asWebviewUri: vi.fn((uri) => uri),
	},
	options: {},
	viewColumn: vscode.ViewColumn.Two,
	...viewState,
	onDidChangeViewState: vi.fn(),
	onDidDispose: vi.fn(),
	reveal: vi.fn(),
	dispose: vi.fn(),
})

describe("getVisibleProviderOrLog", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		// Same reason as in the openClineInNewTab block: getVisibleProviderOrLog iterates
		// the automocked getAllInstances, which is undefined until something installs a list.
		;(ClineProvider.getAllInstances as Mock).mockReturnValue([])
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
	let mockVisibleProvider: { postMessageToWebview: Mock; retryWebviewRecovery: Mock<() => Promise<void>> }
	let mockProvider: {
		postMessageToWebview: Mock
		evictCurrentTask: Mock
		refreshWorkspace: Mock
		webviewFocusTracker: WebviewFocusTracker
		retryWebviewRecovery: Mock<() => Promise<void>>
		whenViewResolved: Mock<() => Promise<void>>
		isViewLaunched: boolean
	}
	let mockVisibleProviderInstance: ClineProvider
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

		mockContext = makeExtensionContext()

		mockVisibleProvider = {
			retryWebviewRecovery: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}

		// The visible-provider double supplies message posting and explicit recovery retry.
		mockVisibleProviderInstance = mockVisibleProvider as unknown as ClineProvider
		mockProvider = {
			retryWebviewRecovery: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
			webviewFocusTracker: new WebviewFocusTracker(),
			// The title-bar menu path implies the view is already resolved, so the gate releases at
			// once here; the palette case, where the view is still unset, has its own tests below.
			isViewLaunched: true,
			whenViewResolved: vi.fn().mockResolvedValue(undefined),
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

	it.each([false, true])("retries the appropriate provider when a visible provider exists: %s", async (visible) => {
		vi.mocked(ClineProvider.getVisibleInstance).mockReturnValue(visible ? mockVisibleProviderInstance : undefined)
		await handlers["zoo-code.retryWebviewRecovery"]()
		expect(mockVisibleProvider.retryWebviewRecovery).toHaveBeenCalledTimes(visible ? 1 : 0)
		expect(mockProvider.retryWebviewRecovery).toHaveBeenCalledTimes(visible ? 0 : 1)
	})

	afterEach(() => {
		// Reset module-level panel state to prevent leakage between tests.
		setPanel(undefined, "sidebar")
		setPanel(undefined, "tab")
		// vi.clearAllMocks drops call history but keeps implementations, so an
		// implementation installed on either static registry lookup would otherwise leak into
		// every later test and make its result depend on execution order.
		;(ClineProvider.getInstanceForView as Mock).mockReset()
		;(ClineProvider.getAllInstances as Mock).mockReset().mockReturnValue([])
	})

	it("registers the ripgrep diagnostic command and stores its disposable in context.subscriptions", async () => {
		const { registerRipgrepDiagnosticCommand } = await import("../../services/ripgrep/diagnostic")
		const mock = vi.mocked(registerRipgrepDiagnosticCommand)
		const disposable = mock.mock.results[0]?.value
		expect(mock).toHaveBeenCalled()
		expect(mockContext.subscriptions).toContain(disposable)
	})

	it("creates the diagnostics report from every provider instance, visible or not", async () => {
		// Re-adopted from main's copy of this file: the command was added with the privacy-safe
		// diagnostics report, and the click-origin rework of the title-bar handlers left it alone,
		// so it still feeds every instance to the service instead of only the visible one.
		const { createDiagnosticsReport } = await import("../../services/diagnostics")
		const providers = [mockProvider as unknown as ClineProvider, mockVisibleProviderInstance]
		vi.mocked(ClineProvider.getAllInstances).mockReturnValue(providers)
		vi.mocked(ClineProvider.getVisibleInstance).mockReturnValue(undefined)

		handlers["zoo-code.createDiagnosticsReport"]()

		expect(vi.mocked(createDiagnosticsReport)).toHaveBeenCalledWith({
			context: mockContext,
			outputChannel: mockOutputChannel,
			providers,
		})
	})

	it("passes the shared focus tracker to the newTask handler", async () => {
		const { handleNewTask } = await import("../handleTask")
		const params = { prompt: "new task" }
		await handlers["zoo-code.newTask"](params)
		expect(handleNewTask).toHaveBeenCalledWith(params, mockProvider.webviewFocusTracker)
	})

	it.each(["popoutButtonClicked", "openInNewTab"])(
		"%s opens an editor chat using the registered provider's focus tracker",
		async (command) => {
			const panel: vscode.WebviewPanel = {
				viewType: "zoo-code.TabPanelProvider",
				title: "Zoo Code",
				webview: {
					options: {},
					html: "",
					cspSource: "test-webview",
					postMessage: vi.fn().mockResolvedValue(true),
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn((uri) => uri),
				},
				options: {},
				viewColumn: vscode.ViewColumn.Two,
				active: true,
				visible: true,
				onDidChangeViewState: vi.fn(),
				onDidDispose: vi.fn(),
				reveal: vi.fn(),
				dispose: vi.fn(),
			}
			vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel)

			const result = await handlers[`zoo-code.${command}`]()

			expect(ClineProvider).toHaveBeenCalledExactlyOnceWith(
				mockContext,
				mockOutputChannel,
				"editor",
				await ContextProxy.getInstance(mockContext),
				mockProvider.webviewFocusTracker,
				undefined,
			)
			const tabProvider = vi.mocked(ClineProvider).mock.results[0].value
			expect(result).toBe(tabProvider)
			expect(tabProvider.resolveWebviewView).toHaveBeenCalledExactlyOnceWith(panel)
		},
	)

	// The sidebar title-bar handlers target the registered provider (the
	// sidebar click origin) directly, not the visible-instance heuristic.
	it("settingsButtonClicked posts both settingsButtonClicked and didBecomeVisible actions on the registered provider", async () => {
		await handlers["zoo-code.settingsButtonClicked"]()

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

	it("historyButtonClicked posts historyButtonClicked action on the registered provider", async () => {
		await handlers["zoo-code.historyButtonClicked"]()

		expect(TelemetryService.instance.captureTitleButtonClicked).toHaveBeenCalledWith("history")
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "historyButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("marketplaceButtonClicked posts marketplaceButtonClicked action on the registered provider", async () => {
		await handlers["zoo-code.marketplaceButtonClicked"]()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "marketplaceButtonClicked",
		})
		expect(mockVisibleProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// Palette invocations reach these three commands before resolveWebviewView has handed the
	// activation-time provider its view (the `*InTab` ids are hidden from the palette, these three
	// are not), and postMessageToWebview returns without sending while the view is unset. Each test
	// drives that state and checks the three things the finding describes: the pane is asked to
	// open, nothing is posted or logged before the view resolves, and after it resolves the actions
	// arrive in order - plus the log entry that must exist when a post fails, so neither a dropped
	// post nor a failed one stays silent.
	it.each([
		{
			command: "zoo-code.settingsButtonClicked",
			prefix: "settingsButtonClicked",
			actions: [
				{ type: "action", action: "settingsButtonClicked" },
				{ type: "action", action: "didBecomeVisible" },
			],
		},
		{
			command: "zoo-code.historyButtonClicked",
			prefix: "historyButtonClicked",
			actions: [{ type: "action", action: "historyButtonClicked" }],
		},
		{
			command: "zoo-code.marketplaceButtonClicked",
			prefix: "marketplaceButtonClicked",
			actions: [{ type: "action", action: "marketplaceButtonClicked" }],
		},
	])("waits for the sidebar view to resolve before posting $command", async ({ command, prefix, actions }) => {
		let settleGate!: () => void
		const gate = new Promise<void>((resolve) => {
			settleGate = resolve
		})
		const sidebarProvider = Object.assign({} as ClineProvider, {
			isViewLaunched: false,
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			whenViewResolved: vi.fn().mockReturnValue(gate),
		})
		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		registerCommands({ context: mockContext, outputChannel: mockOutputChannel, provider: sidebarProvider })

		const handler = commandHandlers[command]()

		// The pane was asked to open, but nothing may be posted until the view itself resolves. Drain
		// the microtask queue so the handler reaches the gate and stops there.
		await new Promise((resolve) => setImmediate(resolve))
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(expect.stringContaining("SidebarProvider.focus"))
		expect(sidebarProvider.whenViewResolved).toHaveBeenCalledTimes(1)
		expect(sidebarProvider.postMessageToWebview).not.toHaveBeenCalled()
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()

		settleGate()
		await handler

		expect(sidebarProvider.postMessageToWebview).toHaveBeenCalledTimes(actions.length)
		actions.forEach((action, index) => {
			expect(sidebarProvider.postMessageToWebview).toHaveBeenNthCalledWith(index + 1, action)
		})

		// The other half of "does nothing and writes no log": a post that fails has to leave the
		// handler-prefixed entry in the output channel. Arm one rejection, with the view now resolved
		// so the rejection is the only thing between the command and the log.
		const boom = new Error(`${prefix} post failed`)
		sidebarProvider.postMessageToWebview.mockReset()
		sidebarProvider.postMessageToWebview.mockRejectedValueOnce(boom)
		sidebarProvider.postMessageToWebview.mockResolvedValue(undefined)
		await commandHandlers[command]()
		await new Promise((resolve) => setImmediate(resolve))
		expect(mockOutputChannel.appendLine).toHaveBeenCalledTimes(1)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(`[${prefix}] postMessageToWebview failed: ${boom}`)
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

	it("focusInput does not post when a tab panel is tracked without a live tab instance", async () => {
		setPanel({} as vscode.WebviewView, "sidebar")
		setPanel({} as vscode.WebviewPanel, "tab")

		await handlers["zoo-code.focusInput"]()

		// The tab takes selection priority, so the sidebar must not receive
		// the message; with no live tab instance there is no other target.
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
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

		// The tab ref does not wipe the sidebar ref...
		await handlers["zoo-code.focusInput"]()
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()

		// ...and clearing only the tab ref re-enables the sidebar post.
		setPanel(undefined, "tab")
		await handlers["zoo-code.focusInput"]()
		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
	})

	// Two tab panels can be open at once and the tracker follows whichever one the user
	// activates: the onDidChangeViewState wiring in openClineInNewTab
	// (registerCommands.ts:492-508) says so outright and re-points on activation. Disposal
	// has to make the same choice deliberately, because focusInput reads the tracker
	// (255-273) and getPanel falls back to the sidebar (47-49): a cleared tracker with a
	// live panel left behind sends the next ordinary "Open in editor" to a third panel
	// instead of the one that is still on screen.
	//
	// The pool the survivor is chosen from is the instance registry, because closing a
	// panel disposes its provider and ClineProvider.dispose unregisters the instance
	// synchronously at its start (ClineProvider.ts:1653-1659). These tests model liveness
	// the same way: a view is live while a map entry for it exists, and disposing a tab
	// removes that entry.

	let providersByView: Map<vscode.WebviewView | vscode.WebviewPanel, ClineProvider>
	const liveInstances = (): ClineProvider[] => [...providersByView.values()]

	// View -> live instance, which is the lookup getInstanceForView performs
	// (ClineProvider.ts:1754-1756), so the tab provider is resolved by panel identity.
	const startInstanceRegistry = () => {
		providersByView = new Map()
		;(ClineProvider.getInstanceForView as Mock).mockImplementation(
			(view: vscode.WebviewView | vscode.WebviewPanel) => providersByView.get(view),
		)
		;(ClineProvider.getAllInstances as Mock).mockImplementation(liveInstances)
	}

	/**
	 * Open one tab panel through the shipped creation path and register the provider the
	 * automocked ClineProvider constructor produced for it. forceNew is how two live tab
	 * panels happen today: startNewTask({ newTab: true }) asks for its own provider without
	 * closing the panel that is already open.
	 */
	const openTabPanel = async (panel: vscode.WebviewPanel, forceNew = false): Promise<ClineProvider> => {
		vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panel)
		const provider = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: mockProvider.webviewFocusTracker,
			forceNew,
		})
		// The automocked constructor does not run resolveWebviewView, so the view assignment
		// the real resolve makes (ClineProvider.ts:1896) has to be made here: the survivor rule
		// reads each instance's view, exactly as getInstanceForView does.
		provider["view"] = panel
		providersByView.set(panel, provider)
		return provider
	}

	const viewStateCallback = (panel: vscode.WebviewPanel) =>
		(panel.onDidChangeViewState as Mock).mock.calls[0][0] as (event: { webviewPanel: vscode.WebviewPanel }) => void

	const disposeCallback = (panel: vscode.WebviewPanel) => (panel.onDidDispose as Mock).mock.calls[0][0] as () => void

	/**
	 * Opens live tab panels - the survivor plus any extras - and re-points the tracker at the
	 * first one the way the visibility handler does, then closes that tracked panel with its
	 * unregistered - the ordering the shipped wiring produces, because ClineProvider's own
	 * view-dispose handler is registered inside resolveWebviewView (ClineProvider.ts:
	 * 1907-1931), before the one in openClineInNewTab, so it runs first and clears the tab
	 * ref. Each case states only the survivor's view state, which is what decides which
	 * tier of the survivor rule it measures.
	 */
	const closeTrackedTabPanel = async (
		survivorPanel: vscode.WebviewPanel,
		extraSurvivors: vscode.WebviewPanel[] = [],
	) => {
		const trackedPanel = makeTabPanel("closing-tab", { active: true, visible: true })
		await openTabPanel(trackedPanel)
		// Registered first, so the survivor rule has to rank the candidates rather than take
		// the live instance it happens to meet first.
		for (const extra of extraSurvivors) {
			await openTabPanel(extra, true)
		}
		const survivorProvider = await openTabPanel(survivorPanel, true)
		viewStateCallback(trackedPanel)({ webviewPanel: trackedPanel })
		expect(getPanel()).toBe(trackedPanel)
		setPanel(undefined, "tab")
		providersByView.delete(trackedPanel)
		return { trackedPanel, survivorPanel, survivorProvider }
	}

	it("keeps the live tab panel that is active tracked when the tracked panel closes", async () => {
		startInstanceRegistry()
		const survivorPanel = makeTabPanel("survivor-tab", { active: true, visible: true })
		const { trackedPanel, survivorProvider } = await closeTrackedTabPanel(survivorPanel)

		disposeCallback(trackedPanel)()

		// A sidebar is tracked as well, so "kept the survivor tracked" has to be proved
		// against the fallback: getPanel and focusInput must both name the tab.
		setPanel({} as vscode.WebviewView, "sidebar")
		expect(getPanel()).toBe(survivorPanel)

		await handlers["zoo-code.focusInput"]()

		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("tracks a visible but inactive survivor over the sidebar fallback", async () => {
		startInstanceRegistry()
		// The user closed the tab from a different group, so nothing reports itself active.
		const survivorPanel = makeTabPanel("survivor-tab", { active: false, visible: true })
		const { trackedPanel, survivorProvider } = await closeTrackedTabPanel(survivorPanel)

		disposeCallback(trackedPanel)()

		setPanel({} as vscode.WebviewView, "sidebar")
		expect(getPanel()).toBe(survivorPanel)
		await handlers["zoo-code.focusInput"]()
		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("tracks a survivor in a hidden group instead of dropping the tab surface", async () => {
		startInstanceRegistry()
		// A tab moved into a collapsed group is neither active nor visible, and it is still a
		// tab the user can click back to. Dropping the tracker here is the defect: the next
		// ordinary "Open in editor" builds a second panel beside it.
		const survivorPanel = makeTabPanel("survivor-tab", { active: false, visible: false })
		const { trackedPanel, survivorProvider } = await closeTrackedTabPanel(survivorPanel)

		disposeCallback(trackedPanel)()

		setPanel({} as vscode.WebviewView, "sidebar")
		expect(getPanel()).toBe(survivorPanel)
		await handlers["zoo-code.focusInput"]()
		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	// The three cases above each leave a single live tab, so any tier of the survivor rule
	// returns it and none of them can tell the tiers apart. These two register several live
	// tabs at once, which is the only way to show the preference order is enforced.
	it("prefers the active survivor when several tabs are still live", async () => {
		startInstanceRegistry()
		const hiddenPanel = makeTabPanel("hidden-tab", { active: false, visible: false })
		const visiblePanel = makeTabPanel("visible-tab", { active: false, visible: true })
		const activePanel = makeTabPanel("active-tab", { active: true, visible: true })
		const { trackedPanel, survivorPanel, survivorProvider } = await closeTrackedTabPanel(activePanel, [
			hiddenPanel,
			visiblePanel,
		])
		expect(survivorPanel).toBe(activePanel)

		disposeCallback(trackedPanel)()

		// Tier one: the panel the user is looking at wins over the two other live tabs,
		// whichever order they were opened in.
		setPanel({} as vscode.WebviewView, "sidebar")
		expect(getPanel()).toBe(activePanel)
		await handlers["zoo-code.focusInput"]()
		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("prefers the visible survivor over a hidden one when nothing is active", async () => {
		startInstanceRegistry()
		const hiddenPanel = makeTabPanel("hidden-tab", { active: false, visible: false })
		const visiblePanel = makeTabPanel("visible-tab", { active: false, visible: true })
		const { trackedPanel, survivorPanel, survivorProvider } = await closeTrackedTabPanel(visiblePanel, [
			hiddenPanel,
		])
		expect(survivorPanel).toBe(visiblePanel)

		disposeCallback(trackedPanel)()

		// Tier two: with no active panel anywhere the visible tab wins even though the hidden
		// tab was registered first.
		setPanel({} as vscode.WebviewView, "sidebar")
		expect(getPanel()).toBe(visiblePanel)
		await handlers["zoo-code.focusInput"]()
		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "focusInput",
		})
		expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("opens into the surviving tab panel instead of creating a third one", async () => {
		startInstanceRegistry()
		const survivorPanel = makeTabPanel("survivor-tab", { active: true, visible: true })
		const { trackedPanel, survivorProvider } = await closeTrackedTabPanel(survivorPanel)
		const creationsBefore = vi.mocked(vscode.window.createWebviewPanel).mock.calls.length

		disposeCallback(trackedPanel)()

		const opened = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: mockProvider.webviewFocusTracker,
		})

		// The reuse path is what keeps one panel per surface: it only fires while the tracker
		// names the live panel, so a cleared tracker must show up as a new creation.
		expect(vi.mocked(vscode.window.createWebviewPanel).mock.calls).toHaveLength(creationsBefore)
		expect(opened).toBe(survivorProvider)
		expect(survivorPanel.reveal).toHaveBeenCalled()
		expect(survivorProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
	})

	it("selects the survivor when disposal arrives while the tracker still names the panel", async () => {
		startInstanceRegistry()
		const survivorPanel = makeTabPanel("survivor-tab", { active: true, visible: true })
		const trackedPanel = makeTabPanel("closing-tab", { active: true, visible: true })
		await openTabPanel(trackedPanel)
		await openTabPanel(survivorPanel, true)
		viewStateCallback(trackedPanel)({ webviewPanel: trackedPanel })
		// The other half of the state the stale-reference comment at registerCommands.ts:
		// 426-430 describes: the provider is gone while the tracker still points at the panel,
		// which is what a creation that failed after setPanel leaves behind. The branch that
		// owns this case must select the survivor rather than clear, and must not select the
		// panel being disposed - its registry entry is already gone.
		providersByView.delete(trackedPanel)

		disposeCallback(trackedPanel)()

		expect(getPanel()).toBe(survivorPanel)
	})

	it("leaves the tab ref clear when the disposed panel was the last live tab", async () => {
		startInstanceRegistry()
		const lastPanel = makeTabPanel("last-tab", { active: true, visible: true })
		await openTabPanel(lastPanel)
		// Deliberately no onDidChangeViewState: that is the property that separates a panel
		// from a view, and ClineProvider itself uses it as the tab/sidebar discriminator
		// (ClineProvider.ts:1898). The describe's ClineProvider-typed double stands in for the
		// sidebar instance - only its view matters to the survivor rule.
		const sidebarView = {} as vscode.WebviewView
		const sidebarProvider = mockVisibleProviderInstance
		// The sidebar instance is live too, and its view is a WebviewView, not a panel: the
		// survivor rule must not put a sidebar view into the tab ref, because the tab branch of
		// focusInput would then post through the panel-shaped path at the wrong surface.
		sidebarProvider["view"] = sidebarView
		providersByView.set(sidebarView, sidebarProvider)
		// Provider-first ordering again: the ref is cleared and the instance unregistered
		// before registerCommands sees the disposal.
		setPanel(undefined, "tab")
		providersByView.delete(lastPanel)

		disposeCallback(lastPanel)()

		// Nothing is left in the tab surface, so the ref stays empty and the sidebar resumes.
		// This state already holds today; it is pinned so the survivor rule cannot break it by
		// pointing the tab ref at the panel that was just disposed.
		setPanel(sidebarView, "sidebar")
		expect(getPanel()).toBe(sidebarView)

		await handlers["zoo-code.focusInput"]()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
		expect(lastPanel.reveal).not.toHaveBeenCalled()
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

	it("waits for the sidebar webview to resolve before posting the chat actions", async () => {
		// The worktree flow invokes plusButtonClicked without a sidebar click, so the pane opens but
		// resolveWebviewView has not handed the provider its view yet. postMessageToWebview returns
		// without sending while the view is unset, so posting immediately drops both actions.
		let settleGate!: () => void
		const gate = new Promise<void>((resolve) => {
			settleGate = resolve
		})
		const sidebarProvider = Object.assign({} as ClineProvider, {
			isViewLaunched: false,
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			whenViewResolved: vi.fn().mockReturnValue(gate),
		})
		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		registerCommands({ context: mockContext, outputChannel: mockOutputChannel, provider: sidebarProvider })

		const handler = commandHandlers["zoo-code.plusButtonClicked"]()

		// The pane opened, but nothing may be posted until the view itself resolves. Drain the
		// microtask queue so the handler reaches the gate and stops there.
		await new Promise((resolve) => setImmediate(resolve))
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(expect.stringContaining("SidebarProvider.focus"))
		expect(sidebarProvider.postMessageToWebview).not.toHaveBeenCalled()

		settleGate()
		await handler

		expect(sidebarProvider.postMessageToWebview).toHaveBeenNthCalledWith(1, {
			type: "action",
			action: "chatButtonClicked",
		})
		expect(sidebarProvider.postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "action",
			action: "focusInput",
		})
	})

	// The shared double above never sets isViewLaunched, so every case that goes through it
	// takes the not-launched branch. This is the other side of the guard at
	// registerCommands.ts:194: a view that is already resolved must neither focus the pane nor
	// wait on the resolution gate, while still posting both actions.
	it("plusButtonClicked skips the focus command and the wait when the sidebar view is already launched", async () => {
		const sidebarProvider = Object.assign({} as ClineProvider, {
			isViewLaunched: true,
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			refreshWorkspace: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			whenViewResolved: vi.fn().mockResolvedValue(undefined),
		})
		const commandHandlers: Record<string, (...args: unknown[]) => unknown> = {}
		;(vscode.commands.registerCommand as Mock).mockImplementation(
			(id: string, cb: (...args: unknown[]) => unknown) => {
				commandHandlers[id] = cb
				return { dispose: vi.fn() }
			},
		)
		registerCommands({ context: mockContext, outputChannel: mockOutputChannel, provider: sidebarProvider })

		// Counted rather than absolute: earlier cases in this file also invoke commands, so the
		// claim under test is that this handler adds no focus call of its own.
		const executeCommandMock = vscode.commands.executeCommand as Mock
		// Destructure the invoked command out of the call tuple: filtering the array itself
		// stringifies every argument, so a matching payload anywhere in the tuple would count
		// as a focus call.
		const isFocus = ([command]: unknown[]) =>
			typeof command === "string" && command.includes("SidebarProvider.focus")
		const focusCallsBefore = executeCommandMock.mock.calls.filter(isFocus).length

		await commandHandlers["zoo-code.plusButtonClicked"]()

		expect(executeCommandMock.mock.calls.filter(isFocus).length).toBe(focusCallsBefore)
		expect(sidebarProvider.whenViewResolved).not.toHaveBeenCalled()
		expect(sidebarProvider.postMessageToWebview).toHaveBeenNthCalledWith(1, {
			type: "action",
			action: "chatButtonClicked",
		})
		expect(sidebarProvider.postMessageToWebview).toHaveBeenNthCalledWith(2, {
			type: "action",
			action: "focusInput",
		})
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
		// The survivor rule and panel disposal iterate getAllInstances; the automock
		// returns undefined until a mockImplementation installs a list, so seed the empty
		// list before the first test body runs rather than only resetting it afterwards.
		;(ClineProvider.getAllInstances as Mock).mockReturnValue([])

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

	// Same reset as the handlers block above: vi.clearAllMocks leaves implementations
	// installed by a test in this block in place for the tests that follow it, and the
	// survivor rule reads both lookups, so an instance left behind here would decide a
	// later test that never registered it.
	afterEach(() => {
		;(ClineProvider.getInstanceForView as Mock).mockReset()
		;(ClineProvider.getAllInstances as Mock).mockReset().mockReturnValue([])
	})

	it.each([false, true])(
		"clears a closed tab reference only if it is still current (replacement: %s)",
		async (replaced) => {
			await openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			})
			const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0].value
			const onDispose = vi.mocked(panel.onDidDispose).mock.calls[0][0]
			const replacement = { ...panel }
			if (replaced) setPanel(replacement, "tab")

			onDispose()

			expect(getPanel()).toBe(replaced ? replacement : undefined)
		},
	)

	it("leaves a live tab panel tracked when a failed creation clears the ref", async () => {
		const survivorPanel = makeTabPanel("survivor-tab", { active: true, visible: true })
		// View -> live instance, which is what the survivor rule reads through getAllInstances
		// and getInstanceForView (ClineProvider.ts:1744-1756). The creation that fails below is
		// deliberately absent from this map: its provider is disposed before the ref is
		// cleared, and dispose unregisters the instance synchronously at its start
		// (ClineProvider.ts:1653-1659), so the half-built panel cannot be picked.
		const providerByView = new Map<vscode.WebviewPanel, ClineProvider>()
		;(ClineProvider.getAllInstances as Mock).mockImplementation(() => [...providerByView.values()])
		;(ClineProvider.getInstanceForView as Mock).mockImplementation((view: vscode.WebviewPanel) =>
			providerByView.get(view),
		)
		vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(survivorPanel)
		const survivorProvider = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		// The resolve assigns the panel to the provider's own view (ClineProvider.ts:1896);
		// the automocked constructor does not run it, so make the assignment here.
		survivorProvider["view"] = survivorPanel
		providerByView.set(survivorPanel, survivorProvider)
		expect(getPanel()).toBe(survivorPanel)

		// A forced call - startNewTask({ newTab: true }) - builds its own panel and makes it
		// the tracked ref the moment it exists (registerCommands.ts:530). The failure lands
		// after resolveWebviewView, at the visibility-listener registration, so the cleanup
		// path is the one holding the ref.
		// The panel double's registration hooks are read-only on the type, so the failing
		// listener goes in through a fresh object literal rather than an assignment.
		const failingPanel: vscode.WebviewPanel = {
			...makeTabPanel("failing-tab", { active: true, visible: true }),
			onDidChangeViewState: vi.fn(() => {
				throw new Error("view state listener registration failed")
			}),
		}
		vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(failingPanel)

		await expect(
			openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
				forceNew: true,
			}),
		).rejects.toThrow("view state listener registration failed")

		// Same rule as onDidDispose: the ref goes to a live panel, not to nothing.
		expect(getPanel()).toBe(survivorPanel)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("cleanup was incomplete"))

		// The symptom a cleared ref produces: the next ordinary "Open in editor" reveals the
		// panel that is still on screen instead of building a third one beside it.
		const revealed = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		expect(revealed).toBe(survivorProvider)
		expect(survivorPanel.reveal).toHaveBeenCalledTimes(1)
		// The survivor panel, then the failed one: no third panel was created.
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("reuses a tab that appeared while the panel was being created", async () => {
		const trackedPanel = {
			reveal: vi.fn().mockResolvedValue(undefined),
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		}
		const trackedProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		// The provider construction is the await in the middle of the creation window: install a
		// tracked tab there, as the API path or a sidebar-to-tab move would.
		const constructed = vi.mocked(ClineProvider)
		// A plain function, not an arrow: the production code calls this with `new`.
		const constructedProvider = { dispose: vi.fn().mockResolvedValue(undefined) }
		constructed.mockImplementationOnce(function () {
			setPanel(trackedPanel as never, "tab")
			;(ClineProvider.getInstanceForView as Mock).mockReturnValue(trackedProvider)
			return constructedProvider
		} as never)

		const returned = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// A tab that appeared in the window is reused instead of replaced, and the provider that
		// never received a panel is disposed so it does not stay registered with listeners.
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		// The caller gets the tracked provider, not the one that was constructed in this call.
		expect(returned).toBe(trackedProvider)
		// ...and that constructed provider is disposed, so it cannot stay registered with listeners.
		expect(constructedProvider.dispose).toHaveBeenCalledTimes(1)
		expect(trackedProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
	})

	it("rebinds telemetry to the tab provider that survived the race before disposing the constructed one", async () => {
		const trackedPanel = {
			reveal: vi.fn().mockResolvedValue(undefined),
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		}
		// TelemetryProperties requires the app-level fields; only the task id identifies the tab.
		const tabProperties = (taskId: string): TelemetryProperties => ({
			language: "en",
			mode: "act",
			appName: "zoo-code",
			appVersion: "0.0.0",
			vscodeVersion: "1.0.0",
			platform: "win32",
			editorName: "VS Code",
			taskId,
		})

		// Each provider reports the task id of the tab it owns, the way
		// ClineProvider.getTelemetryProperties reports the properties of its own view.
		const trackedProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
			getTelemetryProperties: async () => tabProperties("surviving-tab"),
		}
		const constructedProvider = {
			// Its teardown is the only window in which the binding can still point at the
			// instance being thrown away, so the event is captured from inside dispose():
			// whatever reads telemetry while this provider is going down must already see the
			// tab that is actually being returned.
			dispose: vi.fn().mockImplementation(() => {
				TelemetryService.instance.captureEvent(TelemetryEventName.TAB_SHOWN)
				return Promise.resolve()
			}),
			getTelemetryProperties: async () => tabProperties("disposed-tab"),
		}

		// A tracked tab appears during the construction window, as it does on the API path or
		// after a sidebar-to-tab move. The constructed provider binds telemetry on the way in,
		// exactly as the real constructor does (ClineProvider.ts calls
		// TelemetryService.instance.setProvider(this)).
		vi.mocked(ClineProvider).mockImplementationOnce(function () {
			setPanel(trackedPanel as never, "tab")
			;(ClineProvider.getInstanceForView as Mock).mockReturnValue(trackedProvider)
			TelemetryService.instance.setProvider(constructedProvider)
			return constructedProvider
		} as never)

		telemetryBinding.current = undefined
		telemetryBinding.events.length = 0
		telemetryBinding.pending.length = 0

		const returned = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// The raced path disposed the constructed provider and the caller got the tracked one.
		expect(returned).toBe(trackedProvider)
		expect(constructedProvider.dispose).toHaveBeenCalledTimes(1)

		// BaseTelemetryClient merges the properties of whichever provider is bound into every
		// event, so a stale binding surfaces as the disposed tab's task id. The first event was
		// captured by the disposal itself: it must already carry the surviving tab. The second
		// one is captured after the call returned, which is what later events see.
		await Promise.all(telemetryBinding.pending)
		expect(telemetryBinding.events).toHaveLength(1)
		expect(telemetryBinding.events[0]).toMatchObject({ taskId: "surviving-tab" })
		expect(telemetryBinding.events[0]).not.toMatchObject({ taskId: "disposed-tab" })

		TelemetryService.instance.captureEvent(TelemetryEventName.TAB_SHOWN)
		await Promise.all(telemetryBinding.pending)
		expect(telemetryBinding.events).toHaveLength(2)
		expect(telemetryBinding.events[1]).toMatchObject({ taskId: "surviving-tab" })
		expect(telemetryBinding.current).toBe(trackedProvider)
	})

	it("does not return an API provider that fails after publishing its panel", async () => {
		const waitFor = async (label: string, condition: () => boolean): Promise<void> => {
			for (let attempt = 0; attempt < 240; attempt++) {
				if (condition()) {
					return
				}
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
			throw new Error(`condition never held: ${label}`)
		}

		// Both creations park on their own newGroupRight await, the last stop before a panel is
		// created. The ordinary one must get past the reuse check at the top with nothing tracked
		// - that is the shape of the bug - and the API one must publish its panel while the
		// ordinary one is still parked, so the later check is the only thing that can adopt it.
		const apiPanel = makeTabPanel("api-tab", { active: true, visible: true })
		const ordinaryPanel = makeTabPanel("ordinary-tab", { active: true, visible: true })
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(apiPanel).mockReturnValueOnce(ordinaryPanel)

		// The automocked class neither registers instances nor assigns the panel to the provider's
		// view; resolveWebviewView does both in the real code (ClineProvider.ts:1896-1931), so the
		// doubles do it here and the survivor rule reads the same two lookups. Disposal
		// unregisters, as it does at ClineProvider.ts:1653-1659.
		const providerByView = new Map<vscode.WebviewPanel, ClineProvider>()
		const apiProvider = {
			view: undefined as vscode.WebviewPanel | undefined,
			resolveWebviewView: vi.fn(async (view: vscode.WebviewPanel) => {
				apiProvider.view = view
				providerByView.set(view, apiProvider as unknown as ClineProvider)
			}),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(async () => {
				providerByView.delete(apiPanel)
			}),
		}
		const ordinaryProvider = {
			resolveWebviewView: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		;(ClineProvider.getInstanceForView as Mock).mockImplementation((view: vscode.WebviewPanel) =>
			providerByView.get(view),
		)
		;(ClineProvider.getAllInstances as Mock).mockImplementation(() => [...providerByView.values()])
		// The ordinary construction happens first, so it takes the first implementation.
		vi.mocked(ClineProvider)
			.mockImplementationOnce(function () {
				return ordinaryProvider
			} as never)
			.mockImplementationOnce(function () {
				return apiProvider
			} as never)

		let groupCalls = 0
		let lockCalls = 0
		// Each gate is a promise whose resolver a promise executor installs. TS cannot see an
		// assignment made inside the executor from a sibling `let`, so the settle function starts as a
		// no-op and the executor always replaces it.
		const makeGate = (): { wait: Promise<void>; settle: (error?: Error) => void } => {
			let settle: (error?: Error) => void = () => undefined
			const wait = new Promise<void>((resolve, reject) => {
				settle = (error) => (error === undefined ? resolve() : reject(error))
			})
			return { wait, settle }
		}
		const ordinaryGroup = makeGate()
		const apiGroup = makeGate()
		const apiLock = makeGate()
		const executeCommandMock = vscode.commands.executeCommand as Mock
		const previousExecute = executeCommandMock.getMockImplementation()
		executeCommandMock.mockImplementation(async (command: string) => {
			if (command === "workbench.action.newGroupRight") {
				groupCalls += 1
				if (groupCalls === 1) {
					await ordinaryGroup.wait
				} else {
					await apiGroup.wait
				}
				return undefined
			}
			if (command === "workbench.action.lockEditorGroup") {
				lockCalls += 1
				if (lockCalls === 1) {
					// The API creation's last step is the one that fails, after its panel was published
					// and its provider registered for that view.
					await apiLock.wait
				}
				return undefined
			}
			return previousExecute?.(command)
		})

		try {
			const apiAttempt = openClineInNewTabForApi({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			})
			const ordinaryAttempt = openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			})
			await waitFor("both creations parked on their group command", () => groupCalls === 2)
			apiGroup.settle()
			// Published, registered, creation still unsettled: the dispose listener is installed after
			// resolveWebviewView, so its single call is the signal that a live panel is tracked while
			// the creation that made it is still running.
			await waitFor(
				"the API panel published and tracked with its creation unsettled",
				() => getPanel() === apiPanel && (apiPanel.onDidDispose as Mock).mock.calls.length === 1,
			)
			ordinaryGroup.settle()
			// The failure has to land on the API creation's own last step. Between installing the
			// dispose listener and taking the editor-group lock the creation sits in a 100ms delay,
			// and rejecting the lock before anything awaits it fires the rejection into nobody.
			await waitFor("the API creation parked on the editor-group lock", () => lockCalls === 1)
			// The ordinary creation has reached the later reuse check by now, and the creation it
			// could adopt fails from here on.
			apiLock.settle(new Error("api lock failed"))

			await expect(apiAttempt).rejects.toThrow("api lock failed")
			const returned = await ordinaryAttempt

			// The caller keeps its own provider. Without the wait in the later reuse check the adoption
			// happens first and this reddens on provider identity, naming the raced provider rather
			// than a timer: the rolled-back creation had already published the panel and registered
			// this provider for it.
			expect(returned).toBe(ordinaryProvider)
			expect(returned).not.toBe(apiProvider)
			// The ordinary call's own provider is the one it returned, not the one the rollback disposed.
			expect(ordinaryProvider.dispose).not.toHaveBeenCalled()
			expect(apiProvider.dispose).toHaveBeenCalledTimes(1)
			expect(apiPanel.dispose).toHaveBeenCalledTimes(1)
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith(
				expect.stringContaining("cleanup was incomplete"),
			)
			// The ordinary creation still opened its own tab, and that tab is the tracked one.
			expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
			expect(getPanel()).toBe(ordinaryPanel)
		} finally {
			// Restore the saved implementation rather than mockRestore(): this file's beforeEach only
			// clears call history, and mockRestore() on a bare vi.fn() leaves executeCommand with no
			// implementation at all, so every later tab creation in this file breaks. In a finally so a
			// failing assertion cannot leak the override.
			executeCommandMock.mockImplementation(previousExecute ?? (async () => undefined))
		}
	})

	it("creates a webview panel with title 'Zoo Code'", async () => {
		const webviewFocusTracker = new WebviewFocusTracker()
		await openClineInNewTab({ context: mockContext, outputChannel: mockOutputChannel, webviewFocusTracker })
		expect(ClineProvider).toHaveBeenCalledWith(
			mockContext,
			mockOutputChannel,
			"editor",
			await ContextProxy.getInstance(mockContext),
			webviewFocusTracker,
			undefined,
		)

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

		const result = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		expect(result).toBe(mockExistingProvider)
		expect(mockPanel.reveal).toHaveBeenCalledTimes(1)
		expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled()
		expect(mockExistingProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "didBecomeVisible",
		})
	})

	it("creates a distinct provider for each independent API tab request", async () => {
		const webviewFocusTracker = new WebviewFocusTracker()

		// Independent API task requests must not share one provider: each gets its own panel
		// and provider even though the earlier request tracked a tab.
		const [first, second] = await Promise.all([
			openClineInNewTabForApi({ context: mockContext, outputChannel: mockOutputChannel, webviewFocusTracker }),
			openClineInNewTabForApi({ context: mockContext, outputChannel: mockOutputChannel, webviewFocusTracker }),
		])

		// Identity, not just construction: sharing the first provider between both
		// callers would satisfy mere defined/count assertions.
		const created = vi.mocked(ClineProvider).mock.results.map((result) => result.value)
		expect(created).toHaveLength(2)
		expect(created[0]).toBe(first)
		expect(created[1]).toBe(second)
		expect(first).not.toBe(second)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
		// The tracked tab must be the last created panel, not a reused provider.
		expect(ClineProvider.getInstanceForView as Mock).not.toHaveBeenCalled()
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

		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// The reuse path must resolve the tracked panel (not skip the lookup):
		// without this assertion the test would also pass if the handler
		// stopped consulting getInstanceForView at all.
		expect(ClineProvider.getInstanceForView as Mock).toHaveBeenCalledWith(mockPanel)
		expect(mockPanel.reveal).not.toHaveBeenCalled()
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("disposes the provider and the panel when a creation step rejects", async () => {
		const panel = Object.assign({} as vscode.WebviewPanel, {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			dispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panel)

		// Fail the LAST creation step: the provider is constructed, the panel is created and
		// tracked, and the view resolved - exactly the state a later "Open in editor" would
		// otherwise inherit as a dead tab.
		const executeCommandMock = vscode.commands.executeCommand as Mock
		const previousExecute = executeCommandMock.getMockImplementation()
		executeCommandMock.mockImplementation(async (command: string) => {
			if (command === "workbench.action.lockEditorGroup") {
				throw new Error("lock failed")
			}
			return previousExecute?.(command)
		})

		try {
			await expect(
				openClineInNewTab({
					context: mockContext,
					outputChannel: mockOutputChannel,
					webviewFocusTracker: new WebviewFocusTracker(),
				}),
			).rejects.toThrow("lock failed")

			// Nothing half-built may stay behind: the provider is disposed (it registers in
			// ClineProvider.activeInstances with its listeners), the panel is disposed, and the
			// tracked tab ref no longer points at the orphan panel.
			const created = vi.mocked(ClineProvider).mock.results[0].value
			expect(created.dispose).toHaveBeenCalledTimes(1)
			expect(panel.dispose).toHaveBeenCalledTimes(1)
			expect(getPanel()).toBeUndefined()
		} finally {
			// Restore the saved implementation rather than mockRestore(): this file's beforeEach
			// only clears call history, and mockRestore() on a bare vi.fn() leaves executeCommand
			// with no implementation at all, so every later tab creation in this file breaks.
			// In a finally so a failing assertion cannot leak the override.
			// The saved default can be undefined (a bare vi.fn()), which is behaviourally
			// the same as a no-op implementation - mockImplementation needs a function.
			executeCommandMock.mockImplementation(previousExecute ?? (async () => undefined))
		}
	})

	it("reports incomplete cleanup when the tab-creation rollback itself fails", async () => {
		const panel = Object.assign({} as vscode.WebviewPanel, {
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
			dispose: vi.fn().mockImplementation(() => {
				throw new Error("panel gone")
			}),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panel)
		const executeCommandMock = vscode.commands.executeCommand as Mock
		const previousExecute = executeCommandMock.getMockImplementation()
		executeCommandMock.mockImplementation(async (command: string) => {
			if (command === "workbench.action.lockEditorGroup") {
				// Arm the failing provider cleanup here: the instance exists by now, and this is
				// the last await before the rollback runs, so the ordering is deterministic.
				vi.mocked(ClineProvider).mock.results[0].value.dispose = vi
					.fn()
					.mockRejectedValue(new Error("dispose hung"))
				throw new Error("lock failed")
			}
			return previousExecute?.(command)
		})

		// The original failure is still what the caller sees...
		try {
			await expect(
				openClineInNewTab({
					context: mockContext,
					outputChannel: mockOutputChannel,
					webviewFocusTracker: new WebviewFocusTracker(),
				}),
			).rejects.toThrow("lock failed")

			// ...both cleanup steps were attempted, and the incomplete result is surfaced
			// rather than swallowed behind the original error. The order of the two labels follows
			// the order the cleanup runs them in: the panel first (it cannot stall), then the
			// provider teardown whose rejection used to hold the panel open.
			const created = vi.mocked(ClineProvider).mock.results[0].value
			expect(created.dispose).toHaveBeenCalledTimes(1)
			expect(panel.dispose).toHaveBeenCalledTimes(1)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("cleanup was incomplete (panel: panel gone; provider: dispose hung)"),
			)
		} finally {
			// Restore the saved implementation rather than mockRestore(): this file's beforeEach
			// only clears call history, and mockRestore() on a bare vi.fn() leaves executeCommand
			// with no implementation at all, so every later tab creation in this file breaks.
			// In a finally so a failing assertion cannot leak the override.
			// The saved default can be undefined (a bare vi.fn()), which is behaviourally
			// the same as a no-op implementation - mockImplementation needs a function.
			executeCommandMock.mockImplementation(previousExecute ?? (async () => undefined))
		}
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
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// ...then panel B is created, which re-points the tracked tab ref.
		const panelB = Object.assign({} as vscode.WebviewPanel, {
			marker: "panel-B",
			webview: { postMessage: vi.fn() },
			onDidChangeViewState: vi.fn(),
			onDidDispose: vi.fn(),
		})
		;(vscode.window.createWebviewPanel as Mock).mockReturnValueOnce(panelB)
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

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
		// Scoped to the single lookup openClineInNewTab performs: this file's beforeEach only
		// clears call history, so a plain mockImplementation would keep throwing for every
		// later test in this file.
		;(MdmService.getInstance as Mock).mockImplementationOnce(() => {
			throw new Error("MDM service not initialized")
		})

		const provider = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// The creation must survive the MDM lookup failure: the provider is
		// constructed with an undefined MDM service and the tab panel is
		// still created.
		const ctor = vi.mocked(ClineProvider)
		expect(ctor.mock.instances[0]).toBeDefined()
		expect(ctor).toHaveBeenCalledWith(
			mockContext,
			mockOutputChannel,
			"editor",
			undefined,
			expect.any(WebviewFocusTracker),
			undefined,
		)
		expect(provider).toBe(ctor.mock.instances[0])
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)

		// The fallback is observable in the output channel.
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"[openClineInNewTab] MDM service unavailable, continuing without it: Error: MDM service not initialized",
		)
	})
	it("does not leak the MdmService failure into later tab creations", () => {
		// This file's beforeEach only clears call history, so an implementation installed with
		// mockImplementation would still throw for every later test in this file. The throwing
		// double above must be scoped to the single lookup that test exercises.
		expect(() => MdmService.getInstance()).not.toThrow()
	})

	it("opens a new group to the right and targets ViewColumn.Two when no editors are visible", async () => {
		// The vscode mock factory declares a mutable visibleTextEditors slot that the
		// readonly public API type hides, so seed it through Object.assign.
		Object.assign(vscode.window, { visibleTextEditors: [] })

		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

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

		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

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

		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

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
		// One-shot: this file's beforeEach only clears call history, so a persistent implementation
		// would hand mockMdm to every later tab creation's constructor input as well.
		;(MdmService.getInstance as Mock).mockReturnValueOnce(mockMdm)

		const provider = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		const ctor = vi.mocked(ClineProvider)
		expect(ctor).toHaveBeenCalledTimes(1)
		expect(ctor).toHaveBeenCalledWith(
			mockContext,
			mockOutputChannel,
			"editor",
			undefined,
			expect.any(WebviewFocusTracker),
			mockMdm,
		)
		expect(provider).toBe(ctor.mock.instances[0])
	})

	it("posts didBecomeVisible only for visible state changes and clears the tracked tab on dispose", async () => {
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// Retain the panel returned during creation and pin the tracked tab
		// against it with identity (not a weak defined check), so a wrong or
		// duplicated tracked panel fails before the dispose assertions.
		const panel = (vscode.window.createWebviewPanel as Mock).mock.results[0].value as {
			onDidChangeViewState: Mock
			onDidDispose: Mock
		}
		expect(getPanel()).toBe(panel)

		const stateHandler = panel.onDidChangeViewState.mock.calls[0][0] as (event: {
			webviewPanel: { active?: boolean; visible: boolean; webview: { postMessage: (message: unknown) => void } }
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

		// A visible panel that is not active must not take the tracked ref over. Earlier events in
		// this test carried no `active` field at all, so that branch was never exercised. The
		// event names a different panel object than the tracked one: a guard that looked only at
		// `visible` would move the ref and this assertion would fail.
		const otherPanel = { active: false, visible: true, webview: { postMessage: vi.fn() } }
		stateHandler({ webviewPanel: otherPanel })
		expect(getPanel()).toBe(panel)

		const disposeHandler = panel.onDidDispose.mock.calls[0][0] as () => void
		disposeHandler()
		expect(getPanel()).toBeUndefined()
	})

	it("serializes concurrent opens so overlapping calls create one panel and share one provider", async () => {
		const [first, second] = await Promise.all([
			openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			}),
			openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			}),
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

	it("gives each overlapping forced call its own provider", async () => {
		// startNewTask({ newTab: true }) forces a new tab because it has just closed the editors.
		// Two of those overlapping must not join the same creation: sharing one provider would make
		// both callers evict and re-create the task on the same webview and lose the first task.
		const first = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
			forceNew: true,
		})
		const second = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
			forceNew: true,
		})

		const [firstProvider, secondProvider] = await Promise.all([first, second])

		const ctor = vi.mocked(ClineProvider)
		expect(ctor.mock.instances.length).toBe(2)
		expect(firstProvider).toBe(ctor.mock.instances[0])
		expect(secondProvider).toBe(ctor.mock.instances[1])
		expect(firstProvider).not.toBe(secondProvider)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("keeps a forced creation from evicting an in-flight ordinary creation", async () => {
		// An ordinary "Open in editor" call is mid-creation when startNewTask({ newTab: true }) starts.
		// The forced call must create its own provider without taking the shared slot away from the
		// ordinary one: a caller that starts afterwards is asking for the panel the ordinary creation
		// is building, and receiving the forced creation's promise would reject it for a failure of
		// someone else's creation while its own creation still opens a panel nobody awaits.
		let resolveContextProxy!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveContextProxy = resolve
		})
		// Two one-shot returns: the gate has to serve exactly the two independent creations this
		// test starts (the ordinary one and the forced one), and the third call joins the ordinary
		// creation's promise without reaching ContextProxy. A persistent return value would stay
		// installed for later tests, and a single one-shot return would serve the forced creation
		// instead of one of each.
		;(ContextProxy.getInstance as Mock).mockReturnValueOnce(gate).mockReturnValueOnce(gate)

		const ordinary = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		const forced = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
			forceNew: true,
		})
		const later = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		resolveContextProxy()
		const [ordinaryProvider, forcedProvider, laterProvider] = await Promise.all([ordinary, forced, later])

		const ctor = vi.mocked(ClineProvider)
		// The ordinary creation keeps the slot, so the call that starts after the forced one still
		// joins the ordinary creation instead of the forced one.
		expect(ordinaryProvider).toBe(ctor.mock.instances[0])
		expect(laterProvider).toBe(ctor.mock.instances[0])
		// The forced call still gets its own provider and its own panel.
		expect(forcedProvider).toBe(ctor.mock.instances[1])
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("lets a later ordinary call join a forced creation that started with a free slot", async () => {
		// The store guard is only about not evicting somebody else's creation. A forced call that
		// starts while the slot is free still occupies it, so a non-forced caller that starts during
		// that creation reuses its panel rather than opening a second one.
		let resolveContextProxy!: () => void
		const gate = new Promise<void>((resolve) => {
			resolveContextProxy = resolve
		})
		// One-shot: only the forced creation reaches ContextProxy.getInstance; the later call joins
		// its in-flight promise, so nothing is left queued for the tests that follow.
		;(ContextProxy.getInstance as Mock).mockReturnValueOnce(gate)

		const forced = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
			forceNew: true,
		})
		const later = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		resolveContextProxy()
		const [forcedProvider, laterProvider] = await Promise.all([forced, later])

		const ctor = vi.mocked(ClineProvider)
		expect(forcedProvider).toBe(ctor.mock.instances[0])
		expect(laterProvider).toBe(ctor.mock.instances[0])
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})
	it("shares one in-flight creation when openInNewTab and popoutButtonClicked start before it resolves", async () => {
		// Defer the first creation at ContextProxy.getInstance so both command
		// handlers can start while the creation is still in flight.
		let resolveContextProxy!: () => void
		// One-shot: the first caller starts the creation and the second joins its in-flight
		// promise, so only this test's first ContextProxy.getInstance call is gated.
		;(ContextProxy.getInstance as Mock).mockReturnValueOnce(
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
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)

		// The tracked provider is disposed, so the next open cannot reuse the
		// existing tab: the settled (and cleared) in-flight promise must not
		// be returned, and a fresh panel is created.
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)

		const secondProvider = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		const ctor = vi.mocked(ClineProvider)
		const second = ctor.mock.instances[1]
		expect(second).toBeDefined()
		expect(secondProvider).toBe(second)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("clears the in-flight creation when it rejects so a later open retries", async () => {
		// A creation that fails must not stay in the slot: every later "Open in editor"
		// would receive the settled rejected promise and the tab could never be opened
		// again without reloading the window.
		const failure = new Error("context proxy unavailable")
		;(ContextProxy.getInstance as Mock).mockRejectedValueOnce(failure)

		await expect(
			openClineInNewTab({
				context: mockContext,
				outputChannel: mockOutputChannel,
				webviewFocusTracker: new WebviewFocusTracker(),
			}),
		).rejects.toThrow(failure)

		// The retry starts a fresh creation instead of replaying the stored rejection.
		// Capture how many providers have been constructed so the retry's own
		// instance can be identified below.
		const ctor = vi.mocked(ClineProvider)
		const createdBeforeRetry = ctor.mock.instances.length
		const retried = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		// Identity, not just definedness: the retry must return the provider it
		// constructed in this call, not a leftover from the rejected one.
		const expected = ctor.mock.instances[createdBeforeRetry]
		expect(expected).toBeDefined()
		expect(retried).toBe(expected)
		expect(ContextProxy.getInstance).toHaveBeenCalledTimes(2)
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1)
	})

	it("shares a rejected creation with overlapping callers and still clears the slot", async () => {
		// Both callers join the same in-flight creation, so both must observe its
		// rejection: dropping it for the joined caller would leave that command
		// handler hanging on a promise that never yields a usable result.
		let rejectCreation!: (error: Error) => void
		// Only the in-flight creation is deferred; the retry after it settles gets the
		// normal (immediate) context proxy.
		;(ContextProxy.getInstance as Mock).mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				rejectCreation = reject
			}),
		)

		const first = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		const second = openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})

		// Attach the observers before the rejection is triggered.
		const firstSettled = first.then(
			() => "resolved",
			(error: unknown) => error,
		)
		const secondSettled = second.then(
			() => "resolved",
			(error: unknown) => error,
		)

		const failure = new Error("panel creation failed")
		rejectCreation(failure)

		expect(await firstSettled).toBe(failure)
		expect(await secondSettled).toBe(failure)
		expect(ContextProxy.getInstance).toHaveBeenCalledTimes(1)

		// The slot is cleared even on the shared-rejection path: the next open runs a
		// fresh creation instead of replaying the stored rejection.
		const ctor = vi.mocked(ClineProvider)
		const createdBeforeRetry = ctor.mock.instances.length
		const third = await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		// Identity, not just definedness: the next open returns the provider this
		// call constructed, proving the slot was cleared rather than replayed.
		const expected = ctor.mock.instances[createdBeforeRetry]
		expect(expected).toBeDefined()
		expect(third).toBe(expected)
		expect(ContextProxy.getInstance).toHaveBeenCalledTimes(2)
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
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
		expect(getPanel()).toBe(createdPanels[0])

		// Panel A's provider is disposed before the second open, so the
		// second open creates the replacement panel B.
		;(ClineProvider.getInstanceForView as Mock).mockReturnValue(undefined)
		await openClineInNewTab({
			context: mockContext,
			outputChannel: mockOutputChannel,
			webviewFocusTracker: new WebviewFocusTracker(),
		})
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
