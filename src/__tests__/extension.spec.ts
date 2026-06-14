// npx vitest run __tests__/extension.spec.ts

import type * as vscode from "vscode"
import type { AuthState } from "@roo-code/types"

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
	},
	ExtensionMode: {
		Production: 1,
	},
}))

vi.mock("@dotenvx/dotenvx", () => ({
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

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		createInstance: vi.fn().mockReturnValue({
			register: vi.fn(),
			setProvider: vi.fn(),
			shutdown: vi.fn(),
		}),
		get instance() {
			return {
				register: vi.fn(),
				setProvider: vi.fn(),
				shutdown: vi.fn(),
			}
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
		postStateToWebviewWithoutClineMessages: vi.fn(),
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
	initializeModelCacheRefresh: vi.fn(),
	refreshModels: vi.fn().mockResolvedValue({}),
}))

describe("extension.ts", () => {
	let mockContext: vscode.ExtensionContext
	let authStateChangedHandler:
		| ((data: { state: AuthState; previousState: AuthState }) => void | Promise<void>)
		| undefined

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

		authStateChangedHandler = undefined
	})

	test("does not call dotenvx.config when optional .env does not exist", async () => {
		vi.resetModules()
		vi.clearAllMocks()

		const fs = await import("fs")
		vi.mocked(fs.existsSync).mockReturnValue(false)

		const dotenvx = await import("@dotenvx/dotenvx")

		const { activate } = await import("../extension")
		await activate(mockContext)

		expect(dotenvx.config).not.toHaveBeenCalled()
	})

	test("calls dotenvx.config when optional .env exists", async () => {
		vi.resetModules()
		vi.clearAllMocks()

		const fs = await import("fs")
		vi.mocked(fs.existsSync).mockReturnValue(true)

		const dotenvx = await import("@dotenvx/dotenvx")

		const { activate } = await import("../extension")
		await activate(mockContext)

		expect(dotenvx.config).toHaveBeenCalledTimes(1)
	})

	describe("cloud auth state handling", () => {
		beforeEach(() => {
			vi.resetModules()
		})

		test("auth state changes still post webview state without Roo model cache side effects", async () => {
			const { CloudService } = await import("@roo-code/cloud")
			const { ClineProvider } = await import("../core/webview/ClineProvider")

			vi.mocked(CloudService.createInstance).mockImplementation(async (_context, _logger, handlers) => {
				if (handlers?.["auth-state-changed"]) {
					authStateChangedHandler = handlers["auth-state-changed"]
				}
				return {
					off: vi.fn(),
					on: vi.fn(),
					telemetryClient: null,
					authService: null,
					hasActiveSession: vi.fn().mockReturnValue(false),
				} as any
			})

			vi.mocked(CloudService.hasInstance).mockReturnValue(true)

			// Activate the extension
			const { activate } = await import("../extension")
			await activate(mockContext)

			const provider = (ClineProvider as any).getVisibleInstance()
			provider.postStateToWebviewWithoutClineMessages.mockClear()

			await authStateChangedHandler!({
				state: "active-session" as AuthState,
				previousState: "logged-out" as AuthState,
			})

			expect(provider.postStateToWebviewWithoutClineMessages).toHaveBeenCalledTimes(1)
		})

		test("activation continues when CloudService initialization fails", async () => {
			const { CloudService } = await import("@roo-code/cloud")

			vi.mocked(CloudService.createInstance).mockRejectedValue(new Error("cloud init failed"))
			vi.mocked(CloudService.hasInstance).mockReturnValue(false)

			const { activate } = await import("../extension")

			await expect(activate(mockContext)).resolves.toBeDefined()
		})
	})
})
