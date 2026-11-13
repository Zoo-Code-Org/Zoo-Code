// npx vitest run __tests__/extension.spec.ts

import type * as vscode from "vscode"
import type { WebviewMessage } from "@roo-code/types"

import {
	makeCompositeDisposable,
	makeEventEmitter,
	makeExtensionContext,
	makeWorkspaceConfiguration,
} from "../test-utils/vscode"

vi.mock("vscode", () => ({
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
		registerWebviewViewProvider: vi.fn(),
		registerUriHandler: vi.fn(),
		tabGroups: {
			onDidChangeTabs: vi.fn(),
		},
		onDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		registerTextDocumentContentProvider: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			inspect: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeWorkspaceFolders: vi.fn(),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	env: {
		language: "en",
		isTelemetryEnabled: true,
		onDidChangeTelemetryEnabled: vi.fn(),
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
	},
}))

vi.mock("dotenv", () => ({
	config: vi.fn(),
}))

// Mock fs so the extension module can safely check for optional .env.
vi.mock("fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
}))

const mockCloudServiceInstance = {
	off: vi.fn(),
	on: vi.fn(),
	getUserInfo: vi.fn().mockReturnValue(null),
	isTaskSyncEnabled: vi.fn().mockReturnValue(false),
	authService: {
		getSessionToken: vi.fn().mockReturnValue("test-session-token"),
	},
}

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		createInstance: vi.fn(),
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return mockCloudServiceInstance
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

const mockTelemetryServiceInstance = {
	register: vi.fn(),
	setProvider: vi.fn(),
	shutdown: vi.fn(),
	updateTelemetryState: vi.fn(),
}

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		createInstance: vi.fn().mockReturnValue(mockTelemetryServiceInstance),
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return mockTelemetryServiceInstance
		},
	},
	PostHogTelemetryClient: vi.fn(),
}))

vi.mock("../utils/outputChannelLogger", () => ({
	createOutputChannelLogger: vi.fn().mockReturnValue(vi.fn()),
	createDualLogger: vi.fn().mockReturnValue(vi.fn()),
}))

vi.mock("../shared/package", () => ({
	Package: {
		name: "test-extension",
		outputChannel: "Test Output",
		version: "1.0.0",
	},
}))

vi.mock("../shared/language", () => ({
	formatLanguage: vi.fn().mockReturnValue("en"),
}))

vi.mock("../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn().mockResolvedValue({
			getValue: vi.fn(),
			setValue: vi.fn(),
			getValues: vi.fn().mockReturnValue({}),
			getProviderSettings: vi.fn().mockReturnValue({}),
			getGlobalState: vi.fn().mockReturnValue("enabled"),
		}),
	},
}))

vi.mock("../integrations/editor/DiffViewProvider", () => ({
	DIFF_VIEW_URI_SCHEME: "test-diff-scheme",
}))

vi.mock("../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		initialize: vi.fn(),
		cleanup: vi.fn(),
	},
}))

vi.mock("../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		cleanup: vi.fn().mockResolvedValue(undefined),
		getInstance: vi.fn().mockResolvedValue(null),
		unregisterProvider: vi.fn(),
	},
}))

vi.mock("../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn().mockReturnValue(null),
		disposeAll: vi.fn(),
	},
}))

vi.mock("../services/mdm/MdmService", () => ({
	MdmService: {
		createInstance: vi.fn().mockResolvedValue(null),
	},
}))

vi.mock("../utils/migrateSettings", () => ({
	migrateSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../utils/autoImportSettings", () => ({
	autoImportSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../extension/api", () => ({
	API: vi.fn().mockImplementation(function () {
		return {}
	}),
}))

vi.mock("../activate/registerCommands", () => ({ openClineInNewTab: vi.fn() }))

vi.mock("../activate", () => ({
	handleUri: vi.fn(),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	CodeActionProvider: vi.fn().mockImplementation(function () {
		return {
			providedCodeActionKinds: [],
		}
	}),
}))

vi.mock("../i18n", () => ({
	initializeI18n: vi.fn(),
	t: vi.fn((key) => key),
}))

// Mock ClineProvider
vi.mock("../core/webview/ClineProvider", async () => {
	const mockInstance = {
		resolveWebviewView: vi.fn(),
		postMessageToWebview: vi.fn(),
		postStateToWebview: vi.fn(),
		postStateToWebviewWithoutClineMessages: vi.fn().mockResolvedValue(undefined),
		getState: vi.fn().mockResolvedValue({}),
		initializeCloudProfileSyncWhenReady: vi.fn().mockResolvedValue(undefined),
		providerSettingsManager: {},
		contextProxy: { getGlobalState: vi.fn() },
		customModesManager: {},
		upsertProviderProfile: vi.fn().mockResolvedValue(undefined),
	}
	return {
		ClineProvider: Object.assign(
			vi.fn().mockImplementation(function () {
				return mockInstance
			}),
			{
				// Static method used by extension.ts
				getVisibleInstance: vi.fn().mockReturnValue(mockInstance),
				getAllInstances: vi.fn().mockReturnValue([]),
				sideBarId: "zoo-code.SidebarProvider",
			},
		),
	}
})

// Mock modelCache to prevent network requests during module loading
vi.mock("../api/providers/fetchers/modelCache", () => ({
	flushModels: vi.fn(),
	getModels: vi.fn().mockResolvedValue([]),
	initializeModelCacheRefresh: vi.fn().mockResolvedValue(undefined),
	refreshModels: vi.fn().mockResolvedValue({}),
}))

describe("extension.ts", () => {
	let mockContext: vscode.ExtensionContext
	let globalStateValues: Map<string, unknown>
	let settingsUpdatedHandler: ((data: Record<string, never>) => void | Promise<void>) | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		globalStateValues = new Map<string, unknown>()
		mockContext = {
			extensionPath: "/test/path",
			globalState: {
				get: vi.fn((key: string) => globalStateValues.get(key)),
				update: vi.fn(),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		settingsUpdatedHandler = undefined
	})

	test("shares the extension-owned focus tracker with the sidebar and code actions and disposes its listeners", async () => {
		vi.resetModules()
		const { WebviewFocusTracker } = await import("../core/webview/WebviewFocusTracker")
		const { ClineProvider } = await import("../core/webview/ClineProvider")
		const { ContextProxy } = await import("../core/config/ContextProxy")
		const { registerCodeActions } = await import("../activate")
		const vscode = await import("vscode")
		const { activate } = await import("../extension")

		await activate(mockContext)

		const trackers = mockContext.subscriptions.filter((entry) => entry instanceof WebviewFocusTracker)
		expect(trackers).toHaveLength(1)
		const tracker = trackers[0]
		const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock.results[0].value
		expect(ClineProvider).toHaveBeenCalledExactlyOnceWith(
			mockContext,
			outputChannel,
			"sidebar",
			await ContextProxy.getInstance(mockContext),
			tracker,
			null,
		)
		expect(registerCodeActions).toHaveBeenCalledExactlyOnceWith(mockContext, tracker)

		const messages = makeEventEmitter<WebviewMessage>()
		const disposed = makeEventEmitter<void>()
		const provider = ClineProvider.getVisibleInstance()!
		tracker.init(provider, { webview: { onDidReceiveMessage: messages.event }, onDidDispose: disposed.event })
		messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(provider)

		// Dispose the exact instance owned by the extension, rather than a separate test tracker.
		tracker.dispose()
		messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBeUndefined()
	})

	test("keeps focus trackers independent across extension activations", async () => {
		vi.resetModules()
		const { WebviewFocusTracker } = await import("../core/webview/WebviewFocusTracker")
		const { registerCodeActions } = await import("../activate")
		const { activate } = await import("../extension")
		const secretChanges = makeEventEmitter<vscode.SecretStorageChangeEvent>()
		const secondContext = makeExtensionContext({
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
				onDidChange: secretChanges.event,
			},
		})

		await activate(mockContext)
		await activate(secondContext)

		const firstTracker = mockContext.subscriptions.find((entry) => entry instanceof WebviewFocusTracker)
		const secondTracker = secondContext.subscriptions.find((entry) => entry instanceof WebviewFocusTracker)
		expect(firstTracker).toBeInstanceOf(WebviewFocusTracker)
		expect(secondTracker).toBeInstanceOf(WebviewFocusTracker)
		expect(secondTracker).not.toBe(firstTracker)
		expect(registerCodeActions).toHaveBeenNthCalledWith(1, mockContext, firstTracker)
		expect(registerCodeActions).toHaveBeenNthCalledWith(2, secondContext, secondTracker)
		firstTracker?.dispose()
		secondTracker?.dispose()
		secretChanges.dispose()
	})

	test("injects a factory instance with this activation's dependencies without reading the sidebar tracker", async () => {
		vi.resetModules()
		const { API } = await import("../extension/api")
		const { openClineInNewTab } = await import("../activate/registerCommands")
		const { ClineProviderFactory } = await import("../core/webview/ClineProviderFactory")
		const { WebviewFocusTracker } = await import("../core/webview/WebviewFocusTracker")
		const { ClineProvider } = await import("../core/webview/ClineProvider")
		const { activate } = await import("../extension")
		const vscode = await import("vscode")
		await activate(mockContext)

		const tracker = mockContext.subscriptions.find((entry) => entry instanceof WebviewFocusTracker)
		const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock.results[0].value
		const sidebar = vi.mocked(ClineProvider).mock.results[0].value
		const providerFactory = vi.mocked(API).mock.calls[0][2]
		expect(providerFactory).toBeInstanceOf(ClineProviderFactory)
		expect(sidebar.webviewFocusTracker).toBeUndefined()
		expect(openClineInNewTab).not.toHaveBeenCalled()
		vi.mocked(openClineInNewTab).mockResolvedValueOnce(sidebar)

		await expect(providerFactory.createInNewTab()).resolves.toBe(sidebar)
		expect(openClineInNewTab).toHaveBeenCalledExactlyOnceWith({
			context: mockContext,
			outputChannel,
			webviewFocusTracker: tracker,
		})
		tracker?.dispose()
	})

	test("initializes the code index scope and registers it for extension cleanup", async () => {
		vi.resetModules()
		const { CodeIndexScope } = await import("../services/code-index/code-index-scope")
		const init = vi.spyOn(CodeIndexScope.prototype, "init")
		const dispose = vi.spyOn(CodeIndexScope.prototype, "dispose")
		try {
			const { activate } = await import("../extension")
			await activate(mockContext)

			const scopes = mockContext.subscriptions.filter((entry) => entry instanceof CodeIndexScope)
			expect(scopes).toHaveLength(1)
			expect(init).toHaveBeenCalledExactlyOnceWith()
			expect(init.mock.contexts[0]).toBe(scopes[0])
			expect(dispose).not.toHaveBeenCalled()
			scopes[0].dispose()
			expect(dispose).toHaveBeenCalledExactlyOnceWith()
		} finally {
			init.mockRestore()
			dispose.mockRestore()
		}
	})

	test("publishes indexing status to matching providers and logs delivery failures", async () => {
		vi.resetModules()
		const { CodeIndexScope } = await import("../services/code-index/code-index-scope")
		const { ClineProvider } = await import("../core/webview/ClineProvider")
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const provider = ClineProvider.getVisibleInstance()!
		Object.defineProperty(provider, "workspacePath", { configurable: true, value: "/workspace" })
		const getAll = vi.mocked(ClineProvider.getAllInstances)
		const post = vi.mocked(provider.postMessageToWebview)
		getAll.mockReturnValue([provider, provider])
		post.mockRejectedValueOnce(new Error("delivery failed")).mockResolvedValue(undefined)
		try {
			const { activate } = await import("../extension")
			await activate(mockContext)
			const scope = mockContext.subscriptions.find((entry) => entry instanceof CodeIndexScope)!
			const status = {
				systemStatus: "Standby" as const,
				message: "Ready",
				processedItems: 0,
				totalItems: 0,
				currentItemUnit: "blocks",
				workspacePath: "/workspace",
				workspaceEnabled: true,
				autoEnableDefault: true,
			}
			scope["statusManager"]!["publishStatus"](status)
			await Promise.resolve()
			expect(post).toHaveBeenCalledTimes(2)
			expect(post).toHaveBeenCalledWith({ type: "indexingStatusUpdate", values: status })
			expect(log).toHaveBeenCalledWith(
				"[CodeIndexStatusManager] Failed to publish indexing status:",
				expect.objectContaining({ message: "delivery failed" }),
			)
			scope.dispose()
		} finally {
			log.mockRestore()
			getAll.mockReturnValue([])
			post.mockReset()
			Reflect.deleteProperty(provider, "workspacePath")
		}
	})

	test.each([
		{ workspacePath: "/other-workspace", receivesStatus: false },
		{ workspacePath: "/workspace", receivesStatus: true },
		{ workspacePath: undefined, receivesStatus: true },
		{ workspacePath: "", receivesStatus: true },
	])(
		"routes status for provider workspace=$workspacePath with receivesStatus=$receivesStatus",
		async ({ workspacePath, receivesStatus }) => {
			vi.resetModules()
			const { CodeIndexScope } = await import("../services/code-index/code-index-scope")
			const { ClineProvider } = await import("../core/webview/ClineProvider")
			const provider = ClineProvider.getVisibleInstance()!
			Object.defineProperty(provider, "workspacePath", { configurable: true, value: workspacePath })
			const getAll = vi.mocked(ClineProvider.getAllInstances)
			getAll.mockReturnValue([provider])
			try {
				const { activate } = await import("../extension")
				await activate(mockContext)
				const scope = mockContext.subscriptions.find((entry) => entry instanceof CodeIndexScope)!
				const status = {
					systemStatus: "Indexing" as const,
					message: "Processing confidential.ts",
					processedItems: 1,
					totalItems: 2,
					currentItemUnit: "files",
					workspacePath: "/workspace",
					workspaceEnabled: true,
					autoEnableDefault: true,
				}
				scope["statusManager"]!["publishStatus"](status)
				await Promise.resolve()
				if (receivesStatus) {
					expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
						type: "indexingStatusUpdate",
						values: status,
					})
				} else {
					expect(provider.postMessageToWebview).not.toHaveBeenCalled()
				}
				scope.dispose()
			} finally {
				getAll.mockReturnValue([])
				Reflect.deleteProperty(provider, "workspacePath")
			}
		},
	)

	test.each([new Error("scope initialization failed"), "scope initialization failed"])(
		"continues activation and logs code index scope initialization failure: %s",
		async (error) => {
			vi.resetModules()
			const { CodeIndexScope } = await import("../services/code-index/code-index-scope")
			const init = vi.spyOn(CodeIndexScope.prototype, "init").mockImplementationOnce(() => {
				throw error
			})
			try {
				const { activate } = await import("../extension")
				await expect(activate(mockContext)).resolves.toBeDefined()

				const vscode = await import("vscode")
				const channel = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value
				expect(channel?.appendLine).toHaveBeenCalledWith(
					"[CodeIndexScope] Failed to initialize: scope initialization failed",
				)
				expect(mockContext.subscriptions.filter((entry) => entry instanceof CodeIndexScope)).toHaveLength(1)
			} finally {
				init.mockRestore()
			}
		},
	)

	test("registers the Copilot model broadcast against every provider instance and the output channel", async () => {
		vi.resetModules()
		const disposable = { dispose: vi.fn() }
		const registerCopilotModelBroadcast = vi.fn().mockReturnValue(disposable)
		vi.doMock("../services/language-models/copilotModelBroadcast", () => ({ registerCopilotModelBroadcast }))
		try {
			const { ClineProvider } = await import("../core/webview/ClineProvider")
			const vscode = await import("vscode")
			const { activate } = await import("../extension")

			await activate(mockContext)

			expect(registerCopilotModelBroadcast).toHaveBeenCalledTimes(1)
			const { getTargets, log } = registerCopilotModelBroadcast.mock.calls[0][0]

			const instances = [{ id: "first" }, { id: "second" }]
			vi.mocked(ClineProvider.getAllInstances).mockReturnValue(instances as never)
			expect(getTargets()).toBe(instances)

			const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock.results[0].value
			log("copilot broadcast message")
			expect(outputChannel.appendLine).toHaveBeenCalledWith("copilot broadcast message")

			expect(mockContext.subscriptions).toContain(disposable)
		} finally {
			vi.doUnmock("../services/language-models/copilotModelBroadcast")
		}
	})

	test("does not call dotenv.config when optional .env does not exist", async () => {
		vi.resetModules()
		vi.clearAllMocks()

		const fs = await import("fs")
		vi.mocked(fs.existsSync).mockReturnValue(false)

		const dotenv = await import("dotenv")

		const { activate } = await import("../extension")
		await activate(mockContext)

		expect(dotenv.config).not.toHaveBeenCalled()
	})

	test("calls dotenv.config when optional .env exists", async () => {
		vi.resetModules()
		vi.clearAllMocks()

		const fs = await import("fs")
		vi.mocked(fs.existsSync).mockReturnValue(true)

		const dotenv = await import("dotenv")

		const { activate } = await import("../extension")
		await activate(mockContext)

		expect(dotenv.config).toHaveBeenCalledTimes(1)
	})

	describe("command-list activation seeding", () => {
		function setConfigScope(
			vscode: typeof import("vscode"),
			scope: { globalValue?: string[]; workspaceValue?: string[]; deniedGlobalValue?: string[]; gate?: boolean },
		) {
			const { globalValue, workspaceValue, deniedGlobalValue, gate = false } = scope
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				// Key-scoped so proxy/other activation reads still see no value.
				get: vi.fn((key: string) => {
					if (key === "workspaceCommandListsEnabled") {
						return gate
					}
					return key === "allowedCommands" ? [...(globalValue ?? []), ...(workspaceValue ?? [])] : undefined
				}),
				// Key-scoped inspect: the deny seed must not read the allow scope's
				// values through the same fixture object.
				inspect: vi.fn().mockImplementation((key: string) =>
					key === "deniedCommands"
						? { key, defaultValue: [], globalValue: deniedGlobalValue }
						: {
								key,
								// Real inspect() always reports the declared package default;
								// including it here lets the workspace-override test prove the
								// default stays unseeded beside an override, not just absent.
								defaultValue: ["git log", "git diff", "git show"],
								globalValue,
								workspaceValue,
							},
				),
				update: vi.fn(),
				// The double scripts key-scoped get() and per-scope inspect()
				// shapes the shared helper cannot express without obscuring them.
			} as unknown as vscode.WorkspaceConfiguration)
		}

		beforeEach(() => {
			vi.resetModules()
		})

		afterEach(async () => {
			const vscode = await import("vscode")
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: vi.fn().mockReturnValue([]),
				inspect: vi.fn(),
				// Restores the neutral default after the scope fixtures above;
				// update is intentionally absent because no test runs after this.
			} as unknown as vscode.WorkspaceConfiguration)
		})

		test("seeds both command lists before initializing the terminal registry", async () => {
			// Invariant: a seed rejection must fail activation before the terminal
			// registry is initialized, so no initialized-but-half-activated state is
			// reachable (the registry's listeners are released only via deactivate,
			// which the host does not guarantee after a failed activation).
			const order: string[] = []
			const seedCommandList = vi.fn(async (_globalState: vscode.Memento, configKey: string): Promise<void> => {
				order.push(`seed:${configKey}`)
			})
			vi.doMock("../utils/seedAllowedCommands", () => ({ seedCommandList }))
			try {
				const { TerminalRegistry } = await import("../integrations/terminal/TerminalRegistry")
				vi.mocked(TerminalRegistry.initialize).mockImplementation(() => void order.push("initialize"))

				const { activate } = await import("../extension")
				await activate(mockContext)

				expect(order).toEqual(["seed:allowedCommands", "seed:deniedCommands", "initialize"])
				expect(TerminalRegistry.initialize).toHaveBeenCalledTimes(1)
			} finally {
				vi.doUnmock("../utils/seedAllowedCommands")
			}
		})

		test("aborts activation before the terminal registry is initialized when seeding rejects", async () => {
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			try {
				const { TerminalRegistry } = await import("../integrations/terminal/TerminalRegistry")
				const { ClineProvider } = await import("../core/webview/ClineProvider")

				const { activate } = await import("../extension")
				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				// The seed rejection must reach the host unchanged, with the registry
				// never initialized and no downstream activation (sidebar provider) reached.
				expect(TerminalRegistry.initialize).not.toHaveBeenCalled()
				expect(ClineProvider).not.toHaveBeenCalled()
			} finally {
				vi.doUnmock("../utils/seedAllowedCommands")
			}
		})

		test("disposes the auth secret-storage listener when seeding rejects activation", async () => {
			// A rejected seed aborts activation after the auth initializer has
			// registered its secret-storage listener, and the host does not guarantee
			// `deactivate()` after a failed activation, so the failure path must
			// release the retained listener disposable itself.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const dispose = vi.fn()
			const authListener = { dispose }
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi.fn().mockResolvedValue(authListener),
			}))
			try {
				const { activate } = await import("../extension")
				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				// Retained for the success path (deactivate disposes subscriptions) and
				// disposed on the failure path, exactly once, with the error propagated.
				expect(mockContext.subscriptions).toContain(authListener)
				expect(dispose).toHaveBeenCalledExactlyOnceWith()
			} finally {
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
			}
		})

		test("shuts down the telemetry service before propagating a seed rejection", async () => {
			// The telemetry client is created and registered before the seed point,
			// so a rejected seed must shut it down on the failure path: without
			// `deactivate()` after a failed activation, an unshut-down client keeps
			// sending events against an extension the host treats as inactive.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			// A never-settling shutdown: activation may only reject once the awaited
			// teardown settles, pinning that the seed rejection never reaches the
			// host ahead of it.
			let settleShutdown: () => void = () => {}
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return new Promise<void>((resolve) => {
					settleShutdown = resolve
				})
			})
			try {
				const { activate } = await import("../extension")
				const activation = activate(mockContext)
				let rejected = false
				void activation.catch(() => {
					rejected = true
				})

				// Both teardown steps run on the failure path, in order, exactly once.
				await vi.waitFor(() => expect(teardownOrder).toEqual(["auth-listener-disposed", "telemetry-shutdown"]))

				// Still unrejected while the awaited shutdown is unsettled: the catch
				// must not propagate the seed rejection before teardown completes.
				expect(rejected).toBe(false)

				settleShutdown()
				await expect(activation).rejects.toThrow("seed state write failed")
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
			}
		})

		test("logs a rejected telemetry shutdown without masking the seed rejection", async () => {
			// The seed-failure catch awaits the shutdown inside its own try/catch, so a
			// rejecting shutdown must be logged and the seed error must still reach the
			// host as the activation failure. A regression that rethrows the shutdown
			// error hides why activation aborted; one that swallows it silently loses
			// the only record of the telemetry teardown failure.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			// Distinct from the seed error so any masking of the seed rejection is visible.
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return Promise.reject(new Error("shutdown drain failed"))
			})
			try {
				const vscode = await import("vscode")
				const { activate } = await import("../extension")

				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				// The shutdown failure surfaces through the appendLine idiom, with its
				// error text, instead of replacing the seed rejection the host receives.
				const channel = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value
				expect(channel?.appendLine).toHaveBeenCalledWith(
					"Failed to shut down telemetry service: shutdown drain failed",
				)
				// Teardown still runs in order on this path: listener released before the shutdown call.
				expect(teardownOrder).toEqual(["auth-listener-disposed", "telemetry-shutdown"])
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
			}
		})

		test("disposes the network proxy resources when seeding rejects activation", async () => {
			// The debug-proxy resources are initialized before the seed point, and the host
			// does not guarantee `deactivate()` after a failed activation, so the failure path
			// must release them too: a retained configuration listener would let a
			// `debugProxy.*` toggle re-apply proxy configuration inside a dead extension.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			const proxyDispose = vi.fn(() => void teardownOrder.push("proxy-disposed"))
			vi.doMock("../utils/networkProxy", () => ({
				// The initializer resolves to the aggregate disposable covering the
				// configuration listener, override cleanup, and fetch-patch restore.
				initializeNetworkProxy: vi.fn().mockResolvedValue({ dispose: proxyDispose }),
				getSystemProxyUrl: vi.fn().mockReturnValue(undefined),
				isProxyEnabled: vi.fn().mockReturnValue(false),
				createProxyRoutingRequestHandler: vi.fn().mockReturnValue(undefined),
			}))
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return Promise.resolve()
			})
			try {
				// Debug mode is the only mode in which the proxy initializer acquires
				// resources, so it is the mode the failed-activation teardown applies to.
				const vscode = await import("vscode")
				const devContext = { ...mockContext, extensionMode: vscode.ExtensionMode.Development }

				const { activate } = await import("../extension")
				await expect(activate(devContext)).rejects.toThrow("seed state write failed")

				// Strict reverse acquisition order: the proxy initializes first, telemetry
				// second, the auth listener last, so teardown runs auth → telemetry → proxy,
				// and the proxy disposable is released exactly once.
				expect(teardownOrder).toEqual(["auth-listener-disposed", "telemetry-shutdown", "proxy-disposed"])
				expect(proxyDispose).toHaveBeenCalledExactlyOnceWith()
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
				vi.doUnmock("../utils/networkProxy")
			}
		})

		// When activation starts with the debug proxy disabled, only the configuration
		// listener can build the undici dispatcher agent, so the failed-activation
		// teardown must own that listener-created resource. This runs the real
		// initializer with undici/global-agent doubles swapped in and gates the seed
		// rejection until the listener-path install has settled, so the close is
		// observed through the aggregate dispose rather than the late-import guard.
		test("closes the listener-created proxy agent when seeding rejects after a mid-session enable", async () => {
			let rejectSeed: () => void = () => {}
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn(
					() =>
						new Promise<void>((_resolve, reject) => {
							rejectSeed = () => reject(new Error("seed state write failed"))
						}),
				),
			}))
			const closeSpy = vi.fn().mockResolvedValue(undefined)
			const proxyAgentCtor = vi.fn().mockImplementation(function () {
				return { close: closeSpy }
			})
			// The slot double mirrors undici's global dispatcher state so the conditional
			// restore is observable on this teardown path.
			const defaultDispatcher = { close: vi.fn().mockResolvedValue(undefined) }
			const dispatcherSlot: { current: unknown } = { current: defaultDispatcher }
			const setGlobalDispatcher = vi.fn((dispatcher: unknown) => {
				dispatcherSlot.current = dispatcher
			})
			const getGlobalDispatcher = vi.fn(() => dispatcherSlot.current)
			vi.doMock("undici", () => ({
				ProxyAgent: proxyAgentCtor,
				setGlobalDispatcher,
				getGlobalDispatcher,
				fetch: vi.fn(),
			}))
			vi.doMock("global-agent", () => ({ bootstrap: vi.fn() }))
			try {
				const vscode = await import("vscode")
				const { Package } = await import("../shared/package")
				let configListener:
					((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined
				vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
					configListener = listener as typeof configListener
					return { dispose: vi.fn() }
				})
				// Mutable so flipping enabled=true re-reads exactly like a live settings
				// toggle: the helper's get() reads the record at call time.
				const debugProxyValues: Record<string, unknown> = {
					"debugProxy.enabled": false,
					"debugProxy.serverUrl": "http://localhost:8080",
					"debugProxy.tlsInsecure": false,
				}
				const otherSections = makeWorkspaceConfiguration()
				vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section?: string) =>
					section === Package.name ? makeWorkspaceConfiguration(debugProxyValues) : otherSections,
				)
				const fetchBefore = globalThis.fetch
				try {
					const devContext = { ...mockContext, extensionMode: vscode.ExtensionMode.Development }
					const { activate } = await import("../extension")
					const activation = activate(devContext)

					// Activation has registered the configuration listener and reached the
					// gated seed: flip the toggle on, as a mid-session settings change would.
					await vi.waitFor(() => expect(configListener).toBeTypeOf("function"))
					debugProxyValues["debugProxy.enabled"] = true
					configListener?.({ affectsConfiguration: () => true })
					// The listener-path agent is installed before the seed failure arrives, so
					// the teardown below closes an installed agent, not a late-import one.
					await vi.waitFor(() => expect(setGlobalDispatcher).toHaveBeenCalledOnce())

					rejectSeed()
					await expect(activation).rejects.toThrow("seed state write failed")

					// The aggregate owned the listener-created agent: the dispatcher captured
					// at install is back in the slot and the agent closed exactly once.
					expect(dispatcherSlot.current).toBe(defaultDispatcher)
					expect(setGlobalDispatcher).toHaveBeenLastCalledWith(defaultDispatcher)
					expect(closeSpy).toHaveBeenCalledOnce()
					// The fetch patch the listener applied is restored by the same teardown.
					expect(globalThis.fetch).toBe(fetchBefore)
				} finally {
					globalThis.fetch = fetchBefore
					delete process.env.GLOBAL_AGENT_HTTP_PROXY
					delete process.env.GLOBAL_AGENT_HTTPS_PROXY
					delete process.env.GLOBAL_AGENT_NO_PROXY
				}
			} finally {
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("undici")
				vi.doUnmock("global-agent")
			}
		})

		test("disposes the output channel last when seeding rejects activation", async () => {
			// The output channel is the first resource `activate` acquires, and the
			// host does not guarantee `deactivate()` after a failed activation, so
			// the failure path must release it too — last, because every earlier
			// teardown step logs its own failure through this channel.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			const proxyDispose = vi.fn(() => void teardownOrder.push("proxy-disposed"))
			vi.doMock("../utils/networkProxy", () => ({
				// The mock returns the aggregate disposable unconditionally; the
				// mode-gating of the real initializer is pinned in its own spec.
				initializeNetworkProxy: vi.fn().mockResolvedValue({ dispose: proxyDispose }),
				getSystemProxyUrl: vi.fn().mockReturnValue(undefined),
				isProxyEnabled: vi.fn().mockReturnValue(false),
				createProxyRoutingRequestHandler: vi.fn().mockReturnValue(undefined),
			}))
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return Promise.resolve()
			})
			try {
				const vscode = await import("vscode")
				// The factory double is a fixed object, so calling the mock now hands
				// back the same channel `activate` will create; arming its dispose
				// before activation lets the order assertion observe the step.
				const channel = vi.mocked(vscode.window.createOutputChannel)("Test Output")
				channel.dispose = vi.fn(() => void teardownOrder.push("channel-disposed"))

				const { activate } = await import("../extension")
				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				// Strict reverse acquisition: the channel was acquired first, so it is
				// disposed after auth, telemetry, and the proxy — every teardown log
				// line was still writable when those steps ran.
				expect(teardownOrder).toEqual([
					"auth-listener-disposed",
					"telemetry-shutdown",
					"proxy-disposed",
					"channel-disposed",
				])
				expect(channel.dispose).toHaveBeenCalledExactlyOnceWith()
				// Still registered for the normal deactivate path; the failure-path
				// dispose must not have replaced the subscription push.
				expect(mockContext.subscriptions).toContain(channel)
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
				vi.doUnmock("../utils/networkProxy")
			}
		})

		test("clears the persistence trace sink before disposing the output channel when seeding rejects", async () => {
			// The persistence trace sink installed at activation start mirrors
			// trace lines through the output channel, so the failure path must
			// unregister it before the channel goes away: a later trace — such as
			// `deactivate()`'s shutdown event — would otherwise write into a
			// disposed channel.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			const proxyDispose = vi.fn(() => void teardownOrder.push("proxy-disposed"))
			vi.doMock("../utils/networkProxy", () => ({
				// The mock returns the aggregate disposable unconditionally; the
				// mode-gating of the real initializer is pinned in its own spec.
				initializeNetworkProxy: vi.fn().mockResolvedValue({ dispose: proxyDispose }),
				getSystemProxyUrl: vi.fn().mockReturnValue(undefined),
				isProxyEnabled: vi.fn().mockReturnValue(false),
				createProxyRoutingRequestHandler: vi.fn().mockReturnValue(undefined),
			}))
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			// Only the teardown call is an order marker: installation passes the
			// channel-logging sink, while clearing passes undefined — the setter's
			// documented way to restore the default console sink.
			const setPersistenceTraceSink = vi.fn((sink?: unknown) => {
				if (sink === undefined) {
					teardownOrder.push("trace-sink-cleared")
				}
			})
			vi.doMock("../core/task-persistence/persistenceTrace", () => ({
				setPersistenceTraceSink,
				tracePersistenceEvent: vi.fn(),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return Promise.resolve()
			})
			try {
				const vscode = await import("vscode")
				// The factory double is a fixed object, so calling the mock now hands
				// back the same channel `activate` will create; arming its dispose
				// before activation lets the order assertion observe the step.
				const channel = vi.mocked(vscode.window.createOutputChannel)("Test Output")
				channel.dispose = vi.fn(() => void teardownOrder.push("channel-disposed"))

				const { activate } = await import("../extension")
				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				// Reverse acquisition order pins the clear between the proxy release
				// and the channel dispose: the sink was installed after the channel
				// it logs through but before the proxy, so it is released after the
				// proxy — and before the channel, which goes last.
				expect(teardownOrder).toEqual([
					"auth-listener-disposed",
					"telemetry-shutdown",
					"proxy-disposed",
					"trace-sink-cleared",
					"channel-disposed",
				])
				// Exactly the install call and the clear: the failure path neither
				// skips the clear nor repeats it.
				expect(setPersistenceTraceSink).toHaveBeenCalledTimes(2)
				expect(setPersistenceTraceSink).toHaveBeenNthCalledWith(1, expect.any(Function))
				expect(setPersistenceTraceSink).toHaveBeenNthCalledWith(2, undefined)
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
				vi.doUnmock("../utils/networkProxy")
				vi.doUnmock("../core/task-persistence/persistenceTrace")
			}
		})

		test("propagates the seed rejection when the proxy initializer acquired nothing", async () => {
			// Outside debug mode the real initializer returns a no-op disposable, so the
			// failed-activation teardown on the catch path must stay harmless: auth and
			// telemetry still tear down, and the seed error still reaches the host.
			vi.doMock("../utils/seedAllowedCommands", () => ({
				seedCommandList: vi.fn().mockRejectedValue(new Error("seed state write failed")),
			}))
			const teardownOrder: string[] = []
			vi.doMock("../services/zoo-code-auth", () => ({
				initZooCodeAuth: vi
					.fn()
					.mockResolvedValue({ dispose: () => void teardownOrder.push("auth-listener-disposed") }),
			}))
			const { TelemetryService } = await import("@roo-code/telemetry")
			const shutdown = vi.mocked(TelemetryService.instance.shutdown)
			shutdown.mockImplementation(() => {
				teardownOrder.push("telemetry-shutdown")
				return Promise.resolve()
			})
			try {
				// mockContext carries no Development extensionMode, so the unmocked
				// initializer takes its early return and acquires nothing.
				const { activate } = await import("../extension")
				await expect(activate(mockContext)).rejects.toThrow("seed state write failed")

				expect(teardownOrder).toEqual(["auth-listener-disposed", "telemetry-shutdown"])
			} finally {
				shutdown.mockReset()
				vi.doUnmock("../utils/seedAllowedCommands")
				vi.doUnmock("../services/zoo-code-auth")
			}
		})

		test("does not shut down telemetry when activation completes", async () => {
			// Telemetry shutdown is failure-path only: a successfully activated
			// extension owns the telemetry client until deactivate() runs.
			const { TelemetryService } = await import("@roo-code/telemetry")

			const { activate } = await import("../extension")
			await expect(activate(mockContext)).resolves.toBeDefined()

			expect(TelemetryService.instance.shutdown).not.toHaveBeenCalled()
		})

		test("does not seed global state from an enforced workspace-scoped override", async () => {
			const vscode = await import("vscode")
			// The gate is on: an enforced workspace list replaces the default across
			// scopes, so the seed must not re-grant the approvals it removed. (With
			// the gate off the workspace layer is inert and the default is seeded —
			// pinned in the seed module's own spec.)
			setConfigScope(vscode, { workspaceValue: ["docker"], gate: true })

			const { activate } = await import("../extension")
			await activate(mockContext)

			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("allowedCommands", expect.anything())
			expect(globalStateValues.get("allowedCommands")).toBeUndefined()
		})

		test("seeds global state from the user-scoped value when it is empty", async () => {
			const vscode = await import("vscode")
			setConfigScope(vscode, { globalValue: ["git"] })

			const { activate } = await import("../extension")
			await activate(mockContext)

			expect(mockContext.globalState.update).toHaveBeenCalledWith("allowedCommands", ["git"])
		})

		test("does not overwrite global state that is already populated", async () => {
			const vscode = await import("vscode")
			setConfigScope(vscode, { globalValue: ["git"] })
			globalStateValues.set("allowedCommands", ["npm"])

			const { activate } = await import("../extension")
			await activate(mockContext)

			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("allowedCommands", expect.anything())
			expect(globalStateValues.get("allowedCommands")).toEqual(["npm"])
		})

		test("seeds both command-list keys on a fresh profile", async () => {
			const vscode = await import("vscode")
			setConfigScope(vscode, { globalValue: ["git"], deniedGlobalValue: ["docker"] })

			const { activate } = await import("../extension")
			await activate(mockContext)

			expect(mockContext.globalState.update).toHaveBeenCalledWith("allowedCommands", ["git"])
			expect(mockContext.globalState.update).toHaveBeenCalledWith("deniedCommands", ["docker"])
		})
	})

	describe("cloud organization settings handling", () => {
		beforeEach(() => {
			vi.resetModules()
		})

		test("settings updates refresh webview state and contain failures", async () => {
			const { CloudService } = await import("@roo-code/cloud")
			const { ClineProvider } = await import("../core/webview/ClineProvider")

			vi.mocked(CloudService.createInstance).mockImplementation(async (_context, _logger, handlers) => {
				settingsUpdatedHandler = handlers?.["settings-updated"]
				return {
					off: vi.fn(),
					on: vi.fn(),
					telemetryClient: null,
					authService: null,
					hasActiveSession: vi.fn().mockReturnValue(false),
				} as unknown as never
			})

			vi.mocked(CloudService.hasInstance).mockReturnValue(true)

			// Activate the extension
			const { activate } = await import("../extension")
			await activate(mockContext)

			const provider = (
				ClineProvider as unknown as {
					getVisibleInstance(): { postStateToWebviewWithoutClineMessages: ReturnType<typeof vi.fn> }
				}
			).getVisibleInstance()
			provider.postStateToWebviewWithoutClineMessages.mockClear()
			const refreshError = new Error("state refresh failed")
			provider.postStateToWebviewWithoutClineMessages.mockRejectedValueOnce(refreshError)

			settingsUpdatedHandler!({})
			await Promise.resolve()

			expect(provider.postStateToWebviewWithoutClineMessages).toHaveBeenCalledTimes(1)
			const vscode = await import("vscode")
			const channel = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value
			expect(channel?.appendLine).toHaveBeenCalledWith(
				"[CloudService] Failed to refresh state after settings update: state refresh failed",
			)
		})

		test("activation continues when model cache refresh initialization fails", async () => {
			const { initializeModelCacheRefresh } = await import("../api/providers/fetchers/modelCache")
			vi.mocked(initializeModelCacheRefresh).mockRejectedValueOnce(new Error("cache startup failed"))

			const { activate } = await import("../extension")
			await expect(activate(mockContext)).resolves.toBeDefined()
			await Promise.resolve()

			const vscode = await import("vscode")
			const channel = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value
			expect(channel?.appendLine).toHaveBeenCalledWith(
				"[ModelCache] Background refresh initialization failed: cache startup failed",
			)
		})

		test("activation continues when CloudService initialization fails", async () => {
			const { CloudService } = await import("@roo-code/cloud")

			vi.mocked(CloudService.createInstance).mockRejectedValue(new Error("cloud init failed"))
			vi.mocked(CloudService.hasInstance).mockReturnValue(false)

			const { activate } = await import("../extension")

			await expect(activate(mockContext)).resolves.toBeDefined()
		})
	})

	describe("telemetry level reactivity", () => {
		beforeEach(async () => {
			vi.resetModules()
			const vscode = await import("vscode")
			;(vscode.env as { isTelemetryEnabled: boolean }).isTelemetryEnabled = true
		})

		test("registers a listener for vscode.env.onDidChangeTelemetryEnabled", async () => {
			const vscode = await import("vscode")

			const { activate } = await import("../extension")
			await activate(mockContext)

			expect(vscode.env.onDidChangeTelemetryEnabled).toHaveBeenCalledTimes(1)
			expect(vscode.env.onDidChangeTelemetryEnabled).toHaveBeenCalledWith(expect.any(Function))
		})

		test("re-evaluates telemetry state from stored settings when VS Code's global toggle changes", async () => {
			const vscode = await import("vscode")
			const { TelemetryService } = await import("@roo-code/telemetry")
			const { ContextProxy } = await import("../core/config/ContextProxy")

			const mockContextProxyInstance = await (
				ContextProxy.getInstance as unknown as () => Promise<{ getGlobalState: ReturnType<typeof vi.fn> }>
			)()
			vi.mocked(mockContextProxyInstance.getGlobalState).mockReturnValue("enabled")
			;(vscode.env as { isTelemetryEnabled: boolean }).isTelemetryEnabled = true

			const { activate } = await import("../extension")
			await activate(mockContext)

			const updateTelemetryStateMock = vi.mocked(TelemetryService.instance.updateTelemetryState)
			updateTelemetryStateMock.mockClear()

			// The real vscode.env.onDidChangeTelemetryEnabled event carries no payload; the handler
			// must read the current vscode.env.isTelemetryEnabled value, not any argument it's called with.
			const onDidChangeHandler = vi.mocked(vscode.env.onDidChangeTelemetryEnabled).mock.calls[0][0]
			onDidChangeHandler(undefined as never)

			expect(updateTelemetryStateMock).toHaveBeenCalledWith(true)
		})

		test("treats a disabled stored setting as opted out even when VS Code telemetry is enabled", async () => {
			const vscode = await import("vscode")
			const { TelemetryService } = await import("@roo-code/telemetry")
			const { ContextProxy } = await import("../core/config/ContextProxy")

			const mockContextProxyInstance = await (
				ContextProxy.getInstance as unknown as () => Promise<{ getGlobalState: ReturnType<typeof vi.fn> }>
			)()
			vi.mocked(mockContextProxyInstance.getGlobalState).mockReturnValue("disabled")
			;(vscode.env as { isTelemetryEnabled: boolean }).isTelemetryEnabled = true

			const { activate } = await import("../extension")
			await activate(mockContext)

			const updateTelemetryStateMock = vi.mocked(TelemetryService.instance.updateTelemetryState)
			updateTelemetryStateMock.mockClear()

			const onDidChangeHandler = vi.mocked(vscode.env.onDidChangeTelemetryEnabled).mock.calls[0][0]
			onDidChangeHandler(undefined as never)

			expect(updateTelemetryStateMock).toHaveBeenCalledWith(false)
		})

		test("treats VS Code's live telemetry-disabled signal as opted out even when the stored setting is enabled", async () => {
			const vscode = await import("vscode")
			const { TelemetryService } = await import("@roo-code/telemetry")
			const { ContextProxy } = await import("../core/config/ContextProxy")

			const mockContextProxyInstance = await (
				ContextProxy.getInstance as unknown as () => Promise<{ getGlobalState: ReturnType<typeof vi.fn> }>
			)()
			vi.mocked(mockContextProxyInstance.getGlobalState).mockReturnValue("enabled")
			;(vscode.env as { isTelemetryEnabled: boolean }).isTelemetryEnabled = true

			const { activate } = await import("../extension")
			await activate(mockContext)

			const updateTelemetryStateMock = vi.mocked(TelemetryService.instance.updateTelemetryState)
			updateTelemetryStateMock.mockClear()

			// Simulate the user turning off VS Code's global telemetry toggle: the live env value
			// flips before the event fires, and the handler must honor it rather than only the
			// stored extension setting.
			;(vscode.env as { isTelemetryEnabled: boolean }).isTelemetryEnabled = false

			const onDidChangeHandler = vi.mocked(vscode.env.onDidChangeTelemetryEnabled).mock.calls[0][0]
			onDidChangeHandler(undefined as never)

			expect(updateTelemetryStateMock).toHaveBeenCalledWith(false)
		})

		test("pushes a state update to the webview so its own PostHog client picks up the new vscode.env.isTelemetryEnabled value", async () => {
			const vscode = await import("vscode")
			const { ClineProvider } = await import("../core/webview/ClineProvider")

			const { activate } = await import("../extension")
			await activate(mockContext)

			const visibleInstance = (
				ClineProvider as unknown as {
					getVisibleInstance(): { postStateToWebviewWithoutClineMessages: ReturnType<typeof vi.fn> }
				}
			).getVisibleInstance()
			vi.mocked(visibleInstance.postStateToWebviewWithoutClineMessages).mockClear()

			const onDidChangeHandler = vi.mocked(vscode.env.onDidChangeTelemetryEnabled).mock.calls[0][0]
			onDidChangeHandler(undefined as never)

			expect(visibleInstance.postStateToWebviewWithoutClineMessages).toHaveBeenCalled()
		})
	})

	describe("deactivate", () => {
		beforeEach(() => {
			vi.resetModules()
		})

		test("still runs terminal cleanup when telemetry shutdown rejects", async () => {
			const { TelemetryService } = await import("@roo-code/telemetry")
			const { Terminal } = await import("../integrations/terminal/Terminal")
			const { TerminalRegistry } = await import("../integrations/terminal/TerminalRegistry")
			const { CodeIndexManagerRegistry } = await import("../services/code-index/code-index-manager-registry")

			vi.mocked(TelemetryService.instance.shutdown).mockRejectedValue(new Error("shutdown failed"))
			const setTerminalProfileSpy = vi.spyOn(Terminal, "setTerminalProfile")

			const { activate, deactivate } = await import("../extension")
			await activate(mockContext)

			await expect(deactivate()).resolves.toBeUndefined()

			expect(setTerminalProfileSpy).toHaveBeenCalledWith(undefined)
			expect(TerminalRegistry.cleanup).toHaveBeenCalledTimes(1)
			expect(CodeIndexManagerRegistry.disposeAll).toHaveBeenCalledTimes(1)

			setTerminalProfileSpy.mockRestore()
		})

		// Review finding: every other TelemetryService call site touched by this PR checks
		// hasInstance() first; deactivate()'s shutdown call didn't. Not a crash today (the mock
		// always resolves), but TelemetryService.instance throws for real if no instance exists,
		// so the guard keeps this call site consistent with the rest of the file.
		test("does not touch TelemetryService.instance when no instance exists", async () => {
			const { TelemetryService } = await import("@roo-code/telemetry")
			const { Terminal } = await import("../integrations/terminal/Terminal")
			const { TerminalRegistry } = await import("../integrations/terminal/TerminalRegistry")
			const { CodeIndexManagerRegistry } = await import("../services/code-index/code-index-manager-registry")

			const setTerminalProfileSpy = vi.spyOn(Terminal, "setTerminalProfile")

			const { activate, deactivate } = await import("../extension")
			await activate(mockContext)

			// Flip to false only after activate() completes, so this only exercises
			// deactivate()'s own guard rather than any hasInstance() check during activation.
			vi.mocked(TelemetryService.hasInstance).mockReturnValue(false)

			// Model the real singleton failure mode: TelemetryService.instance throws when no
			// instance exists. If deactivate()'s hasInstance() guard were ever removed, this
			// throw would surface instead of the assertion below silently passing regardless.
			const instanceGetterSpy = vi.spyOn(TelemetryService, "instance", "get").mockImplementation(() => {
				throw new Error("TelemetryService not initialized")
			})

			await expect(deactivate()).resolves.toBeUndefined()

			expect(instanceGetterSpy).not.toHaveBeenCalled()
			expect(mockTelemetryServiceInstance.shutdown).not.toHaveBeenCalled()
			expect(setTerminalProfileSpy).toHaveBeenCalledWith(undefined)
			expect(TerminalRegistry.cleanup).toHaveBeenCalledTimes(1)
			expect(CodeIndexManagerRegistry.disposeAll).toHaveBeenCalledTimes(1)

			instanceGetterSpy.mockRestore()
			setTerminalProfileSpy.mockRestore()
		})
	})
})
