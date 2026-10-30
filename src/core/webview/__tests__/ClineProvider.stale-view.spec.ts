import { WebviewFocusTracker } from "../WebviewFocusTracker"
// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.stale-view.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"

import { TelemetryService } from "@roo-code/telemetry"
import type { ExtensionMessage, WebviewMessage } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

// Mock setup
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = delayFn
	delayFn.reject = delayFn
	delayFn.range = delayFn
	return { default: delayFn }
})

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	extensions: {
		all: [],
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn(),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(() => ({
		taskId: "mock-task-id",
		instanceId: "mock-instance-id",
		abortTask: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	})),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

vi.mock("../../../integrations/theme/getTheme", () => ({
	getTheme: vi.fn().mockResolvedValue({ kind: "dark" }),
}))

vi.mock("../webviewMessageHandler", () => ({
	webviewMessageHandler: vi.fn().mockResolvedValue(undefined),
}))

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

function makeDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** An emitter-backed vscode.Event that also reports how many listeners are installed. */
function makeViewEvent<T>(retainDisposedListeners = false) {
	const listeners = new Set<(value: T) => unknown>()
	const event: vscode.Event<T> = (listener, _thisArgs, disposables) => {
		listeners.add(listener)
		// Retention models callbacks already queued when their subscription is disposed.
		const subscription = { dispose: () => !retainDisposedListeners && listeners.delete(listener) }
		// Real VS Code events push the subscription into the provided array.
		disposables?.push(subscription)
		return subscription
	}
	return {
		event,
		fire: (value: T) => [...listeners].forEach((listener) => listener(value)),
		listenerCount: () => listeners.size,
	}
}

function createSidebarView(retainDisposedListeners = false) {
	const messages = makeViewEvent<WebviewMessage>(retainDisposedListeners)
	const visibility = makeViewEvent<void>(retainDisposedListeners)
	const disposed = makeViewEvent<void>(retainDisposedListeners)
	const postMessage = vi.fn<(message: ExtensionMessage) => Promise<boolean>>().mockResolvedValue(true)
	const view: vscode.WebviewView = {
		viewType: ClineProvider.sideBarId,
		visible: true,
		webview: {
			html: "",
			options: {},
			cspSource: "vscode-webview://test-csp-source",
			asWebviewUri: (uri) => uri,
			postMessage,
			onDidReceiveMessage: messages.event,
		},
		onDidChangeVisibility: visibility.event,
		onDidDispose: disposed.event,
		show: vi.fn(),
	}
	return { view, messages, visibility, disposed, postMessage }
}

function createPanelView(retainDisposedListeners = false) {
	const sidebar = createSidebarView(retainDisposedListeners)
	const viewState = makeViewEvent<vscode.WebviewPanelOnDidChangeViewStateEvent>(retainDisposedListeners)
	const view: vscode.WebviewPanel = {
		webview: sidebar.view.webview,
		viewType: "test-panel",
		viewColumn: undefined,
		title: "Test panel",
		options: {},
		visible: true,
		active: true,
		onDidDispose: sidebar.disposed.event,
		onDidChangeViewState: viewState.event,
		reveal: vi.fn(),
		dispose: vi.fn(),
	}
	return { ...sidebar, view, viewState }
}

describe("ClineProvider - stale view lifecycle", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, unknown> = {
			mode: "code",
			currentApiConfigName: "test-config",
		}

		const secrets: Record<string, string | undefined> = {}

		// Structural double providing only the storage members ClineProvider and ContextProxy read.
		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" },
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		// Structural double providing only the logging members ClineProvider calls.
		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	afterEach(async () => {
		await provider.dispose()
	})

	describe("stale-resolve guards", () => {
		test("a resolve that finishes after the view was replaced assigns no HTML and installs no listeners", async () => {
			const first = createSidebarView()
			const second = createSidebarView()
			const htmlDeferred = makeDeferred<string>()
			provider["getHtmlContent"] = vi
				.fn<(webview: vscode.Webview) => Promise<string>>()
				.mockImplementationOnce(() => htmlDeferred.promise)
				.mockImplementation(() => Promise.resolve(`<!DOCTYPE html><html><body>current view</body></html>`))

			const staleResolve = provider.resolveWebviewView(first.view)
			await provider.resolveWebviewView(second.view)

			htmlDeferred.resolve(`<!DOCTYPE html><html><body>stale view</body></html>`)
			await staleResolve

			expect(first.view.webview.html).toBe("")
			expect(second.view.webview.html).toContain("current view")
			expect(first.messages.listenerCount()).toBe(0)
			expect(first.visibility.listenerCount()).toBe(0)
			expect(first.disposed.listenerCount()).toBe(0)
		})

		test("a resolve that finishes after the provider was disposed assigns no HTML and installs no listeners", async () => {
			const first = createSidebarView()
			const htmlDeferred = makeDeferred<string>()
			provider["getHtmlContent"] = vi
				.fn<(webview: vscode.Webview) => Promise<string>>()
				.mockImplementation(() => htmlDeferred.promise)

			const staleResolve = provider.resolveWebviewView(first.view)
			await provider.dispose()

			htmlDeferred.resolve(`<!DOCTYPE html><html><body>too late</body></html>`)
			await staleResolve

			expect(first.view.webview.html).toBe("")
			expect(first.messages.listenerCount()).toBe(0)
			expect(first.visibility.listenerCount()).toBe(0)
			expect(first.disposed.listenerCount()).toBe(0)
		})

		test("a resolve that finishes after the view was replaced during state hydration installs no listeners", async () => {
			const first = createSidebarView()
			const second = createSidebarView()
			// Resolve HTML immediately: the deferral under test is the resolve-level
			// await this.getState() that runs after the HTML assignment.
			provider["getHtmlContent"] = vi
				.fn<(webview: vscode.Webview) => Promise<string>>()
				.mockResolvedValue(`<!DOCTYPE html><html><body>sidebar</body></html>`)
			const stateDeferred = makeDeferred<ProviderState>()
			const realGetState = provider.getState.bind(provider)
			const stateSpy = vi
				.spyOn(provider, "getState")
				.mockImplementationOnce(() => stateDeferred.promise)
				.mockImplementation(() => realGetState())

			const staleResolve = provider.resolveWebviewView(first.view)
			// Let the first resolve run past the HTML assignment and park inside getState().
			await flushAsync()

			await provider.resolveWebviewView(second.view)
			stateDeferred.resolve(await realGetState())
			await staleResolve
			stateSpy.mockRestore()

			// HTML was assigned before the replacement, so the replaced view keeps its document...
			expect(first.view.webview.html).toContain("<!DOCTYPE html>")
			// ...but the stale resolve installed no listeners on it.
			expect(first.messages.listenerCount()).toBe(0)
			expect(first.visibility.listenerCount()).toBe(0)
			expect(first.disposed.listenerCount()).toBe(0)
			expect(second.messages.listenerCount()).toBeGreaterThan(0)
		})

		test("a resolve that finishes after the provider was disposed during state hydration installs no listeners", async () => {
			const first = createSidebarView()
			// Resolve HTML immediately so the deferred await this.getState() is the
			// resolve-level hydration, not the one inside getHtmlContent.
			provider["getHtmlContent"] = vi
				.fn<(webview: vscode.Webview) => Promise<string>>()
				.mockResolvedValue(`<!DOCTYPE html><html><body>sidebar</body></html>`)
			const stateDeferred = makeDeferred<ProviderState>()
			const realGetState = provider.getState.bind(provider)
			const stateSpy = vi.spyOn(provider, "getState").mockImplementation(() => stateDeferred.promise)

			const staleResolve = provider.resolveWebviewView(first.view)
			await flushAsync()

			await provider.dispose()
			stateDeferred.resolve(await realGetState())
			await staleResolve
			stateSpy.mockRestore()

			expect(first.view.webview.html).toContain("<!DOCTYPE html>")
			expect(first.messages.listenerCount()).toBe(0)
			expect(first.visibility.listenerCount()).toBe(0)
			expect(first.disposed.listenerCount()).toBe(0)
		})
	})

	test("a different view replacing the current one disposes the replaced view's subscriptions", async () => {
		const first = createSidebarView()
		const second = createSidebarView()
		await provider.resolveWebviewView(first.view)

		expect(first.messages.listenerCount()).toBeGreaterThan(0)
		expect(first.visibility.listenerCount()).toBeGreaterThan(0)
		expect(first.disposed.listenerCount()).toBeGreaterThan(0)

		await provider.resolveWebviewView(second.view)

		expect(first.messages.listenerCount()).toBe(0)
		expect(first.visibility.listenerCount()).toBe(0)
		expect(first.disposed.listenerCount()).toBe(0)
	})

	test("events from a replaced view are ignored and do not disturb the current view", async () => {
		const first = createSidebarView(true)
		const second = createSidebarView()
		await provider.resolveWebviewView(first.view)
		await provider.resolveWebviewView(second.view)

		const message: WebviewMessage = { type: "webviewDidFocus" }
		first.messages.fire(message)
		expect(vi.mocked(webviewMessageHandler)).not.toHaveBeenCalled()

		first.visibility.fire()
		await flushAsync()
		expect(first.postMessage).not.toHaveBeenCalled()
		expect(second.postMessage).not.toHaveBeenCalled()

		// A stale dispose must not clear the current view's listeners.
		first.disposed.fire()
		expect(provider["view"]).toBe(second.view)
		second.visibility.fire()
		await flushAsync()
		expect(second.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })
	})

	test("a queued configuration callback from a replaced view sends no theme", async () => {
		const first = createSidebarView()
		const second = createSidebarView()
		await provider.resolveWebviewView(first.view)
		const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)![0]
		await provider.resolveWebviewView(second.view)

		await listener({ affectsConfiguration: () => true })

		expect(first.postMessage).not.toHaveBeenCalled()
		expect(second.postMessage).not.toHaveBeenCalled()
	})

	test.each(["html", "state"] as const)("disposing a view during %s loading stops its resolve", async (stage) => {
		const first = createSidebarView()
		const html = makeDeferred<string>()
		const state = makeDeferred<ProviderState>()
		const realState = await provider.getState()
		provider["getHtmlContent"] = vi
			.fn()
			.mockImplementation(() => (stage === "html" ? html.promise : Promise.resolve("document")))
		const stateSpy = vi.spyOn(provider, "getState").mockImplementation(() => state.promise)
		const resolving = provider.resolveWebviewView(first.view)
		await flushAsync()

		first.disposed.fire()
		expect(provider["view"]).toBeUndefined()
		html.resolve("document")
		state.resolve(realState)
		await resolving
		stateSpy.mockRestore()

		expect(first.view.webview.html).toBe(stage === "html" ? "" : "document")
		expect(first.messages.listenerCount()).toBe(0)
		expect(first.visibility.listenerCount()).toBe(0)
		expect(first.disposed.listenerCount()).toBe(0)
	})

	test("panel replacement disposes the focus tracker and ignores queued panel events", async () => {
		const first = createPanelView(true)
		const second = createPanelView()
		const disposeFocus = vi.fn()
		const focusSpy = vi
			.spyOn(provider.webviewFocusTracker, "init")
			.mockReturnValueOnce({ dispose: disposeFocus })
			.mockReturnValue({ dispose: vi.fn() })
		const disposeSpy = vi.spyOn(provider, "dispose")
		await provider.resolveWebviewView(first.view)
		expect(disposeFocus).not.toHaveBeenCalled()
		await provider.resolveWebviewView(second.view)
		expect(disposeFocus).toHaveBeenCalledTimes(1)

		first.viewState.fire({ webviewPanel: first.view })
		first.disposed.fire()
		await flushAsync()
		expect(first.postMessage).not.toHaveBeenCalled()
		expect(second.postMessage).not.toHaveBeenCalled()
		expect(disposeSpy).not.toHaveBeenCalled()
		expect(provider["view"]).toBe(second.view)

		second.viewState.fire({ webviewPanel: second.view })
		await flushAsync()
		expect(second.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })
		second.disposed.fire()
		await flushAsync()
		expect(disposeSpy).toHaveBeenCalledTimes(1)
		expect(ClineProvider.getAllInstances()).not.toContain(provider)
		focusSpy.mockRestore()
		disposeSpy.mockRestore()
	})

	test("disposing the sidebar view clears the current view and its subscriptions", async () => {
		const first = createSidebarView()
		await provider.resolveWebviewView(first.view)
		expect(provider.isViewVisible).toBe(true)

		first.disposed.fire()

		expect(provider["view"]).toBeUndefined()
		expect(provider.isViewVisible).toBe(false)
		expect(first.messages.listenerCount()).toBe(0)
		expect(first.visibility.listenerCount()).toBe(0)
		expect(first.disposed.listenerCount()).toBe(0)
		// Only the view's resources are cleared; the sidebar provider instance itself remains.
		expect(ClineProvider.getAllInstances()).toContain(provider)
	})

	test("the current view keeps dispatching messages, visibility, and theme refreshes", async () => {
		const first = createSidebarView()
		await provider.resolveWebviewView(first.view)

		const message: WebviewMessage = { type: "webviewDidFocus" }
		first.messages.fire(message)
		await flushAsync()
		expect(vi.mocked(webviewMessageHandler)).toHaveBeenCalledWith(provider, message, provider["marketplaceManager"])

		first.visibility.fire()
		await flushAsync()
		expect(first.postMessage).toHaveBeenCalledWith({ type: "action", action: "didBecomeVisible" })

		const onDidChangeConfiguration = vi.mocked(vscode.workspace.onDidChangeConfiguration)
		const configListener = onDidChangeConfiguration.mock.calls.at(-1)![0]
		const colorThemeChange: vscode.ConfigurationChangeEvent = { affectsConfiguration: () => true }
		await configListener(colorThemeChange)
		expect(first.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "theme", text: JSON.stringify({ kind: "dark" }) }),
		)
	})
})
