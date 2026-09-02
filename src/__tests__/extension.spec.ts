// npx vitest run __tests__/extension.spec.ts

import type * as vscode from "vscode"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
		}),
		registerWebviewViewProvider: vi.fn(),
		registerUriHandler: vi.fn(),
		tabGroups: {
			onDidChangeTabs: vi.fn(),
		},
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: {
		registerTextDocumentContentProvider: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		}),
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

vi.mock("../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn().mockReturnValue(null),
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
	let settingsUpdatedHandler: ((data: Record<string, never>) => void | Promise<void>) | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		mockContext = {
			extensionPath: "/test/path",
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn(),
			},
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		settingsUpdatedHandler = undefined
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

			vi.mocked(TelemetryService.instance.shutdown).mockRejectedValue(new Error("shutdown failed"))
			const setTerminalProfileSpy = vi.spyOn(Terminal, "setTerminalProfile")

			const { activate, deactivate } = await import("../extension")
			await activate(mockContext)

			await expect(deactivate()).resolves.toBeUndefined()

			expect(setTerminalProfileSpy).toHaveBeenCalledWith(undefined)
			expect(TerminalRegistry.cleanup).toHaveBeenCalledTimes(1)

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

			instanceGetterSpy.mockRestore()

			setTerminalProfileSpy.mockRestore()
		})
	})
})
