// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.parallelMode.spec.ts

import * as vscode from "vscode"

import { type ExtensionMessage, type ExtensionState, RooCodeEventName } from "@roo-code/types"

import { defaultModeSlug } from "../../../shared/modes"
import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { TelemetryService } from "@roo-code/telemetry"

// Mock p-wait-for
vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock fs/promises
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mocked = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue(""),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mocked,
		default: {
			...actual,
			...mocked,
		},
	}
})

// Mock axios
vi.mock("axios", () => ({
	default: {
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

// Mock safeWriteJson
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

// Mock path utils
vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return {
		...actual,
		getWorkspacePath: vi.fn().mockReturnValue(""),
	}
})

// Mock storage utils
vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

// Mock MCP types
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: {
		InvalidRequest: "InvalidRequest",
		MethodNotFound: "MethodNotFound",
		InternalError: "InternalError",
	},
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.name = "McpError"
			this.code = code
		}
	},
}))

// Mock delay
vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

// Mock MCP client
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	__esModule: true,
	Client: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			listTools: vi.fn().mockResolvedValue({ tools: [] }),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
		}
	}),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	__esModule: true,
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

const { onDidChangeConfigurationMock } = vi.hoisted(() => {
	const onDidChangeConfigurationMock = vi.fn((handler: (e: any) => any) => {
		const disposable = {
			dispose: vi.fn(),
		}
		const checkedKeys: string[] = []
		void handler({
			affectsConfiguration: (key: string) => {
				checkedKeys.push(key)
				return false
			},
		})

		if (checkedKeys.includes("workbench.colorTheme")) {
			onDidChangeConfigurationMock.mock.calls.pop()
		}

		return disposable
	})

	return { onDidChangeConfigurationMock }
})

// Mock vscode
vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	Range: class Range {
		constructor(
			readonly startLine: number,
			readonly startCharacter: number,
			readonly endLine: number,
			readonly endCharacter: number,
		) {}
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		getWorkspaceFolder: vi.fn(),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidChangeConfiguration: onDidChangeConfigurationMock,
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn().mockReturnValue({}),
		tabGroups: {
			onDidChangeTabs: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		},
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

// Mock TTS utils
vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

// Mock API
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

// Mock system prompt
vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

// Mock WorkspaceTracker - simple mock that works (same pattern as sticky-mode.spec.ts)
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))
// Mock ContextProxy for viewLocalState tests
vi.mock("../../config/ContextProxy", () => {
	const defaultState = {
		mode: "code",
		currentApiConfigName: "default",
		apiConfiguration: {},
		customModePrompts: {},
		modeApiConfigs: {},
		listApiConfigMeta: [],
		pinnedApiConfigs: {},
	}

	class MockContextProxy {
		public globalStorageUri: { fsPath: string }
		public extensionUri: { fsPath: string }
		public extensionMode = 1

		constructor(public context: any) {
			this.globalStorageUri = context?.globalStorageUri ?? { fsPath: "/test/storage/path" }
			this.extensionUri = context?.extensionUri ?? { fsPath: "/test/path" }
		}

		getValues = vi.fn().mockImplementation(() => ({
			...defaultState,
			mode: this.context?.globalState?.get("mode") ?? defaultState.mode,
			currentApiConfigName:
				this.context?.globalState?.get("currentApiConfigName") ?? defaultState.currentApiConfigName,
			apiConfiguration: this.context?.globalState?.get("apiConfiguration") ?? defaultState.apiConfiguration,
			customModePrompts: this.context?.globalState?.get("customModePrompts") ?? defaultState.customModePrompts,
			modeApiConfigs: this.context?.globalState?.get("modeApiConfigs") ?? defaultState.modeApiConfigs,
			listApiConfigMeta: this.context?.globalState?.get("listApiConfigMeta") ?? defaultState.listApiConfigMeta,
			pinnedApiConfigs: this.context?.globalState?.get("pinnedApiConfigs") ?? defaultState.pinnedApiConfigs,
		}))
		getValue = vi.fn().mockImplementation((key: string) => this.context?.globalState?.get(key))
		getProviderSettings = vi.fn().mockReturnValue({ apiProvider: "anthropic" })
		setValue = vi.fn().mockImplementation((key: string, value: any) => {
			return this.context?.globalState?.update?.(key, value) ?? Promise.resolve()
		})
		setValues = vi.fn().mockImplementation((values: Record<string, any>) => {
			return Promise.all(Object.entries(values).map(([key, value]) => this.setValue(key, value))).then(
				() => undefined,
			)
		})
		setProviderSettings = vi.fn().mockImplementation((settings: Record<string, any>) => this.setValues(settings))
		resetAllState = vi.fn().mockImplementation(() => {
			const keys = this.context?.globalState?.keys?.() ?? []
			return Promise.all(keys.map((key: string) => this.setValue(key, undefined))).then(() => undefined)
		})
	}
	return { ContextProxy: MockContextProxy }
})

// Mock Task
vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options: any) {
		return {
			api: undefined,
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			taskId: options?.historyItem?.id || "test-task-id",
			emit: vi.fn(),
		}
	}),
}))

// Mock extract-text
vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

// Mock model cache
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

// Mock cloud service
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				getAllowList: vi.fn().mockResolvedValue([]),
				getUserInfo: vi.fn().mockReturnValue(null),
				getOrganizationSettings: vi.fn().mockReturnValue(null),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

// Mock modes
vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		modes: [
			{
				slug: "code",
				name: "Code Mode",
				roleDefinition: "You are a code assistant",
				groups: ["read", "edit"],
			},
			{
				slug: "architect",
				name: "Architect Mode",
				roleDefinition: "You are an architect",
				groups: ["read", "edit"],
			},
			{
				slug: "debugger",
				name: "Debugger Mode",
				roleDefinition: "You are a debugger",
				groups: ["read", "edit"],
			},
			{
				slug: "ask",
				name: "Ask Mode",
				roleDefinition: "You are a helpful assistant",
				groups: ["read"],
			},
		],
		getModeBySlug: vi.fn().mockImplementation((slug: string) => {
			return actual.modes?.find((m) => m.slug === slug) ?? null
		}),
		defaultModeSlug: "code",
	}
})

// Mock custom instructions
vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

// Mock zoo-code-auth
vi.mock("../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: vi.fn(() => "https://www.zoocode.dev"),
	getCachedZooCodeToken: vi.fn(),
	handleAuthCallback: vi.fn(),
	setZooCodeUserInfo: vi.fn(),
	disconnectZooCode: vi.fn(),
}))

// Mock diff strategy
vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getToolDescription: () => "test",
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

// Mock Terminal
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		defaultShellIntegrationTimeout: 10000,
		setShellIntegrationTimeout: vi.fn(),
		setShellIntegrationDisabled: vi.fn(),
		setCommandDelay: vi.fn(),
		setTerminalZshClearEolMark: vi.fn(),
		setTerminalZshOhMy: vi.fn(),
		setTerminalZshP10k: vi.fn(),
		setPowershellCounter: vi.fn(),
		setTerminalZdotdir: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

// Mock McpHub and McpServerManager
vi.mock("../../services/mcp/McpHub", () => ({
	McpHub: vi.fn().mockImplementation(function () {
		return {
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
		}
	}),
}))

vi.mock("../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
		}),
		unregisterProvider: vi.fn(),
	},
}))

// Mock SkillsManager
vi.mock("../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
}))

// Mock MarketplaceManager
vi.mock("../../services/marketplace", () => ({
	MarketplaceManager: vi.fn().mockImplementation(function () {
		return {
			cleanup: vi.fn(),
		}
	}),
}))

// Mock ProviderSettingsManager
vi.mock("../../config/ProviderSettingsManager", () => ({
	ProviderSettingsManager: vi.fn().mockImplementation(function () {
		return {
			saveConfig: vi.fn().mockResolvedValue("test-id"),
			listConfig: vi.fn().mockResolvedValue([]),
			getProfile: vi.fn().mockResolvedValue({}),
			activateProfile: vi.fn().mockImplementation(async (args: { name?: string; id?: string }) => ({
				name: args.name ?? "default",
				id: args.id ?? "test-id",
				apiProvider: "anthropic",
			})),
			setModeConfig: vi.fn().mockResolvedValue(undefined),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			resetAllConfigs: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

// Mock CustomModesManager
vi.mock("../../config/CustomModesManager", () => ({
	CustomModesManager: vi.fn().mockImplementation(function () {
		return {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			getCustomModes: vi.fn().mockResolvedValue([]),
			resetCustomModes: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
}))

// Mock task persistence
vi.mock("../../task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	TaskHistoryStore: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockReturnValue([]),
			get: vi.fn().mockReturnValue(null),
			set: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			migrateFromGlobalState: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
	assertValidTransition: vi.fn(),
}))

// Mock RateLimitClock
vi.mock("../../task/RateLimitClock", () => ({
	createRateLimitClock: vi.fn().mockReturnValue({
		isRateLimited: vi.fn().mockReturnValue(false),
		resetTimer: vi.fn(),
	}),
}))

beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterAll(() => {
	vi.restoreAllMocks()
})

/**
 * ClineProvider - Parallel Mode Support Tests
 *
 * These tests verify that the view-local state isolation feature works correctly,
 * allowing multiple ClineProvider instances (e.g., in parallel tabs) to maintain
 * independent mode, API configuration, and other view-specific settings.
 */
describe("ClineProvider - Parallel Mode Support", () => {
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, any> = {
			mode: "code",
			currentApiConfigName: "default",
			apiConfiguration: {},
			customModePrompts: {},
			modeApiConfigs: {},
			listApiConfigMeta: [],
			pinnedApiConfigs: {},
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: any) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			} as any,
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string) => {
					secrets[key] = value
					return Promise.resolve()
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					delete secrets[key]
					return Promise.resolve()
				}),
			} as any,
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			} as any,
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			} as vscode.Uri,
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel
	})

	const createMockWebviewView = (postMessage = vi.fn()) =>
		({
			webview: {
				postMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
		}) as any

	describe("viewId uniqueness", () => {
		it("should assign unique viewId to each instance", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Each instance should have a unique viewId
			expect(provider1.viewId).toBeDefined()
			expect(provider2.viewId).toBeDefined()
			expect(provider1.viewId).not.toBe(provider2.viewId)

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should have viewId in correct format: {renderContext}-{instanceCount}", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			expect(provider.viewId).toMatch(/^sidebar-\d+$/)

			await provider.dispose()
		})

		it("should increment instance count for each new instance", async () => {
			const provider1 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// First editor instance should be "editor-0" (or next available)
			// Second editor instance should have a different number
			const num1 = parseInt(provider1.viewId.split("-")[1]!)
			const num2 = parseInt(provider2.viewId.split("-")[1]!)

			expect(num2).toBeGreaterThan(num1)

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("local state isolation", () => {
		it("should isolate mode state between instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await (provider1 as any).saveViewState("mode", "architect")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("code")

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should allow different modes in separate instances after saveViewState", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// Access private method for testing
			const saveViewState1 = (provider1 as any).saveViewState.bind(provider1)
			const saveViewState2 = (provider2 as any).saveViewState.bind(provider2)

			// Save different modes to each provider
			await saveViewState1("mode", "architect")
			await saveViewState2("mode", "debugger")

			// Verify isolation - each provider should have its own mode
			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("debugger")

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should isolate currentApiConfigName between instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			const saveViewState1 = (provider1 as any).saveViewState.bind(provider1)
			const saveViewState2 = (provider2 as any).saveViewState.bind(provider2)

			await saveViewState1("currentApiConfigName", "profile-a")
			await saveViewState2("currentApiConfigName", "profile-b")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.currentApiConfigName).toBe("profile-a")
			expect(state2.currentApiConfigName).toBe("profile-b")

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("saveViewState", () => {
		it("should update viewLocalState and persist mode through registered viewStates", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			const contextProxySpy = vi.spyOn(provider.contextProxy, "setValue")
			await (provider as any).setViewStateId("stable-sidebar-view")

			await (provider as any).saveViewState("mode", "architect")

			expect((provider as any).viewLocalState.mode).toBe("architect")
			expect(provider.contextProxy.getValue("viewStates" as any)).toMatchObject({
				"stable-sidebar-view": { mode: "architect" },
			})
			expect(contextProxySpy).toHaveBeenCalledWith(
				"viewStates",
				expect.objectContaining({
					"stable-sidebar-view": expect.objectContaining({
						mode: "architect",
						updatedAt: expect.any(Number),
					}),
				}),
			)
			expect(contextProxySpy).not.toHaveBeenCalledWith("__view_state_stable-sidebar-view_mode", expect.anything())

			await provider.dispose()
		})

		it("should update viewLocalState and persist currentApiConfigName through registered viewStates", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).setViewStateId("stable-sidebar-view")
			await (provider as any).saveViewState("currentApiConfigName", "my-profile")

			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")
			expect(provider.contextProxy.getValue("viewStates" as any)).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "my-profile" },
			})

			await provider.dispose()
		})

		it("should update viewLocalState for apiConfiguration without persisting provider settings or secrets", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			const testApiConfig = {
				apiProvider: "openrouter" as const,
				openRouterModelId: "claude-3.5-sonnet",
				openRouterApiKey: "secret-key",
			}

			await (provider as any).setViewStateId("stable-sidebar-view")
			await (provider as any).saveViewState("apiConfiguration", testApiConfig)

			expect((provider as any).viewLocalState.apiConfiguration).toEqual(testApiConfig)
			expect(provider.contextProxy.getValue("viewStates" as any)).toBeUndefined()

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives undefined", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")
			expect((provider as any).viewLocalState.mode).toBe("architect")

			await (provider as any).saveViewState("mode", undefined)

			expect(Object.prototype.hasOwnProperty.call((provider as any).viewLocalState, "mode")).toBe(false)

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives null", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("currentApiConfigName", "my-profile")
			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")

			await (provider as any).saveViewState("currentApiConfigName", null)

			expect(Object.prototype.hasOwnProperty.call((provider as any).viewLocalState, "currentApiConfigName")).toBe(
				false,
			)

			await provider.dispose()
		})
		it("should merge concurrent persisted updates from separate provider instances without lost viewStates", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await (provider1 as any).setViewStateId("stable-sidebar-view")
			await (provider2 as any).setViewStateId("stable-editor-view")

			await Promise.all([
				(provider1 as any).saveViewState("mode", "architect"),
				(provider2 as any).saveViewState("currentApiConfigName", "editor-profile"),
			])

			expect(mockContext.globalState.get("viewStates" as any)).toMatchObject({
				"stable-sidebar-view": { mode: "architect" },
				"stable-editor-view": { currentApiConfigName: "editor-profile" },
			})

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("loadViewState", () => {
		it("should keep viewLocalState empty when no stable per-view values exist", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await vi.waitFor(() => {
				expect((provider as any).viewLocalState).toEqual({})
			})

			const state = await provider.getState()
			expect(state.mode).toBe("code")
			expect(state.currentApiConfigName).toBe("default")

			await provider.dispose()
		})

		it("should restore mode and currentApiConfigName from hydrated viewStates after extension reload", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const stableViewId = "stable-sidebar-view"

			await provider.contextProxy.setValue("viewStates" as any, {
				[stableViewId]: { mode: "architect", currentApiConfigName: "new-profile", updatedAt: 123 },
			})

			await (provider as any).setViewStateId(stableViewId)

			const state = await provider.getState()
			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("new-profile")

			await provider.dispose()
		})

		it("should resolve API configuration from the persisted profile selection", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const stableViewId = "stable-editor-tab-a"
			const getProfileSpy = vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "profile-a",
				id: "profile-a-id",
				apiProvider: "openrouter",
				openRouterModelId: "openrouter/anthropic/claude-sonnet-4",
			} as any)

			await provider.contextProxy.setValue("viewStates" as any, {
				[stableViewId]: { mode: "architect", currentApiConfigName: "profile-a", updatedAt: 123 },
			})
			await provider.contextProxy.setValue("mode" as any, "debugger")
			await provider.contextProxy.setValue("currentApiConfigName" as any, "profile-b")
			await provider.contextProxy.setValue("apiConfiguration" as any, { apiProvider: "anthropic" })

			await (provider as any).setViewStateId(stableViewId)
			const state = await provider.getState()

			expect(getProfileSpy).toHaveBeenCalledWith({ name: "profile-a" })
			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("profile-a")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: "openrouter",
				openRouterModelId: "openrouter/anthropic/claude-sonnet-4",
			})

			await provider.dispose()
		})

		it("should not throw when a persisted profile selection cannot be resolved", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const stableViewId = "stable-editor-tab-a"
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockRejectedValue(new Error("missing profile"))

			await provider.contextProxy.setValue("viewStates" as any, {
				[stableViewId]: { mode: "architect", currentApiConfigName: "deleted-profile", updatedAt: 123 },
			})

			await expect((provider as any).setViewStateId(stableViewId)).resolves.toBeUndefined()
			const state = await provider.getState()

			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("deleted-profile")
			expect(state.apiConfiguration.apiProvider).toBe("anthropic")

			await provider.dispose()
		})

		it("should log and keep existing viewLocalState when loadViewState fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(provider as any, "log")

			;(provider as any).viewLocalState = { mode: "architect" }
			vi.spyOn(provider.contextProxy, "getValue").mockImplementation(() => {
				throw new Error("load failed")
			})

			await (provider as any).loadViewState()

			expect((provider as any).viewLocalState.mode).toBe("architect")
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Error loading state"))

			await provider.dispose()
		})
	})

	describe("persisted view state pruning", () => {
		it("should keep the newest 50 persisted view states", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const states = Object.fromEntries(
				Array.from({ length: 55 }, (_, index) => [
					`view-${index}`,
					{ mode: `mode-${index}`, updatedAt: index },
				]),
			)

			const pruned = (provider as any).prunePersistedViewStates(states)

			expect(Object.keys(pruned)).toHaveLength(50)
			expect(pruned["view-54"]).toBeDefined()
			expect(pruned["view-5"]).toBeDefined()
			expect(pruned["view-4"]).toBeUndefined()

			await provider.dispose()
		})
	})

	describe("getState merging", () => {
		it("should merge viewLocalState on top of global state", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Initially, getState should return values from contextProxy (global state)
			let state = await provider.getState()
			expect(state.mode).toBe("code")

			// After saveViewState, viewLocalState should take precedence
			await (provider as any).saveViewState("mode", "architect")

			state = await provider.getState()
			expect(state.mode).toBe("architect")

			await provider.dispose()
		})

		it("should preserve global state values not overridden by viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")

			const state = await provider.getState()

			// mode should come from viewLocalState
			expect(state.mode).toBe("architect")

			// Other values should still come from global state / contextProxy
			expect(state.language).toBeDefined()
			expect(state.customModes).toBeDefined()

			await provider.dispose()
		})

		it("should let viewLocalState apiConfiguration override provider settings", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("apiConfiguration", {
				apiProvider: "openrouter",
				openRouterApiKey: "local-key",
			})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("openrouter")
			expect(state.apiConfiguration.openRouterApiKey).toBe("local-key")

			await provider.dispose()
		})

		it("should update viewLocalState apiConfiguration when setValues receives flat provider settings", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("apiConfiguration", {
				apiProvider: "openrouter",
				openRouterModelId: "openrouter/old-model",
			})

			await provider.setValues({
				apiProvider: "bedrock",
				awsUseApiKey: true,
				awsApiKey: "mock-key",
				awsRegion: "us-east-1",
				apiModelId: "anthropic.claude-opus-4-8-20261215-v1:0",
				awsBedrockEndpoint: "http://127.0.0.1:4567",
				awsBedrockEndpointEnabled: true,
			})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("bedrock")
			expect(state.apiConfiguration.awsBedrockEndpoint).toBe("http://127.0.0.1:4567")
			expect((provider as any).viewLocalState.apiConfiguration.apiProvider).toBe("bedrock")

			await provider.dispose()
		})

		it("should persist setValue mutations for view-local mode", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).setViewStateId("stable-sidebar-view")
			await provider.setValue("mode" as any, "architect" as any)

			expect(provider.contextProxy.getValue("viewStates" as any)).toMatchObject({
				"stable-sidebar-view": { mode: "architect" },
			})

			await provider.dispose()
		})

		it("should persist setValues mutations for view-local API profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).setViewStateId("stable-sidebar-view")
			await provider.setValues({ currentApiConfigName: "profile-from-set-values" } as any)

			expect(provider.contextProxy.getValue("viewStates" as any)).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "profile-from-set-values" },
			})

			await provider.dispose()
		})
	})

	describe("profile mutations", () => {
		it("should synchronize viewLocalState when activateProviderProfile mutates ContextProxy", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValueOnce({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: "openrouter",
				openRouterModelId: "openrouter/new-model",
			} as any)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([
				{ id: "new-profile-id", name: "new-profile", apiProvider: "openrouter" },
			] as any)
			;(provider as any).viewLocalState = {
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: "anthropic" },
			}

			await provider.activateProviderProfile({ name: "new-profile" })
			const state = await provider.getState()

			expect(state.currentApiConfigName).toBe("new-profile")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: "openrouter",
				openRouterModelId: "openrouter/new-model",
			})

			await provider.dispose()
		})

		it("should synchronize viewLocalState when upsertProviderProfile activates a saved profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "test-id", name: "saved-profile", apiProvider: "bedrock" },
			] as any)
			;(provider as any).viewLocalState = {
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: "anthropic" },
			}

			await provider.upsertProviderProfile("saved-profile", {
				apiProvider: "bedrock",
				awsRegion: "us-east-1",
			} as any)
			const state = await provider.getState()

			expect(state.currentApiConfigName).toBe("saved-profile")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: "bedrock",
				awsRegion: "us-east-1",
			})

			await provider.dispose()
		})

		it("should synchronize viewLocalState when deleteProviderProfile selects a replacement profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName" as any, "deleted-profile")
			await provider.contextProxy.setValue("listApiConfigMeta" as any, [
				{ id: "deleted-id", name: "deleted-profile", apiProvider: "anthropic" },
				{ id: "replacement-id", name: "replacement-profile", apiProvider: "openrouter" },
			])
			;(provider as any).viewLocalState = {
				currentApiConfigName: "deleted-profile",
				apiConfiguration: { apiProvider: "anthropic" },
			}

			await provider.deleteProviderProfile({
				id: "deleted-id",
				name: "deleted-profile",
				apiProvider: "anthropic",
			} as any)
			const state = await provider.getState()

			expect(state.currentApiConfigName).toBe("replacement-profile")
			expect(state.listApiConfigMeta).toEqual([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: "openrouter" },
			])

			await provider.dispose()
		})

		it("should clear viewLocalState when resetState resets ContextProxy", async () => {
			vi.mocked(vscode.window.showInformationMessage).mockImplementationOnce(
				async (_message: string, _options: unknown, confirm: unknown) => confirm as any,
			)
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			;(provider as any).viewLocalState = {
				mode: "architect",
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: "openrouter" },
			}

			await provider.resetState()

			expect((provider as any).viewLocalState).toEqual({})

			await provider.dispose()
		})
	})

	describe("provider profile activation", () => {
		it("should sync view-local apiConfiguration when activating an upserted profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await (provider as any).saveViewState("apiConfiguration", {
				apiProvider: "openrouter",
				openRouterModelId: "openai/gpt-4.1",
			})

			const providerSettings = {
				apiProvider: "zai" as const,
				zaiApiKey: "mock-key",
				zaiApiLine: "international_api" as const,
				apiModelId: "glm-5.1",
			}
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("zai-profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "default", id: "zai-profile-id", apiProvider: "zai" },
			])

			await provider.upsertProviderProfile("default", providerSettings, true)

			const state = await provider.getState()
			expect(state.currentApiConfigName).toBe("default")
			expect(state.apiConfiguration).toMatchObject(providerSettings)
			expect(state.apiConfiguration.apiProvider).toBe("zai")
			expect((provider as any).viewLocalState.apiConfiguration).toMatchObject(providerSettings)

			await provider.dispose()
		})
	})

	describe("handleModeSwitch integration", () => {
		it("should update viewLocalState.mode when handleModeSwitch is called", async () => {
			const postMessage = vi.fn()
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).resolveWebviewView(createMockWebviewView(postMessage))

			const saveViewStateSpy = vi.spyOn(provider as any, "saveViewState")

			await provider.handleModeSwitch("architect" as any)

			expect((provider as any).viewLocalState.mode).toBe("architect")
			expect(saveViewStateSpy).toHaveBeenCalledWith("mode", "architect")

			await provider.dispose()
		})

		it("should post state and skip mode config lookup when API config locking is enabled", async () => {
			const postMessage = vi.fn()
			mockContext.workspaceState.get = vi.fn().mockImplementation((key: string, fallback?: unknown) => {
				return key === "lockApiConfigAcrossModes" ? true : fallback
			})

			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const getModeConfigIdSpy = vi.spyOn(provider.providerSettingsManager, "getModeConfigId")

			await (provider as any).resolveWebviewView(createMockWebviewView(postMessage))
			postMessage.mockClear()

			await provider.handleModeSwitch("architect" as any)

			expect(getModeConfigIdSpy).not.toHaveBeenCalled()
			expect(postMessage).toHaveBeenCalled()

			await provider.dispose()
		})

		it("should activate configured mode profile when switching modes", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValueOnce("profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([
				{ id: "profile-id", name: "mode-profile", apiProvider: "openrouter" },
			] as any)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValueOnce({
				apiProvider: "openrouter",
			} as any)
			const activateProviderProfileSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.handleModeSwitch("architect" as any)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith({ name: "mode-profile" })

			await provider.dispose()
		})

		it("should leave current configuration unchanged for empty mode profiles", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValueOnce("empty-profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([
				{ id: "empty-profile-id", name: "empty-profile" },
			] as any)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValueOnce({} as any)
			const activateProviderProfileSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.handleModeSwitch("architect" as any)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()

			await provider.dispose()
		})

		it("should emit ModeChanged event after handleModeSwitch", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const modeChangedSpy = vi.fn()

			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)

			await provider.handleModeSwitch("architect" as any)

			expect(modeChangedSpy).toHaveBeenCalledWith("architect")

			await provider.dispose()
		})
	})

	describe("multi-instance isolation", () => {
		it("should maintain independent state across three instances", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const provider3 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await (provider1 as any).saveViewState("mode", "code")
			await (provider1 as any).saveViewState("currentApiConfigName", "profile-1")
			await (provider2 as any).saveViewState("mode", "architect")
			await (provider2 as any).saveViewState("currentApiConfigName", "profile-2")
			await (provider3 as any).saveViewState("mode", "debugger")
			await (provider3 as any).saveViewState("currentApiConfigName", "profile-3")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()
			const state3 = await provider3.getState()

			expect(state1.mode).toBe("code")
			expect(state1.currentApiConfigName).toBe("profile-1")
			expect(state2.mode).toBe("architect")
			expect(state2.currentApiConfigName).toBe("profile-2")
			expect(state3.mode).toBe("debugger")
			expect(state3.currentApiConfigName).toBe("profile-3")

			await provider1.dispose()
			await provider2.dispose()
			await provider3.dispose()
		})

		it("should handle mode switch in one instance without affecting others", async () => {
			const postMessage1 = vi.fn()
			const postMessage2 = vi.fn()
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const provider2 = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await (provider1 as any).resolveWebviewView(createMockWebviewView(postMessage1))
			await (provider2 as any).resolveWebviewView(createMockWebviewView(postMessage2))
			await (provider1 as any).saveViewState("mode", "code")
			await (provider2 as any).saveViewState("mode", "debugger")

			await provider1.handleModeSwitch("architect" as any)

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("debugger")
			expect((provider2 as any).viewLocalState.mode).toBe("debugger")

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("_clearViewLocalState", () => {
		it("should clear all view-local state values", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")
			await (provider as any).saveViewState("currentApiConfigName", "my-profile")
			await (provider as any).saveViewState("apiConfiguration", { apiProvider: "openrouter" })

			expect((provider as any).viewLocalState.mode).toBe("architect")
			expect((provider as any).viewLocalState.currentApiConfigName).toBe("my-profile")
			expect((provider as any).viewLocalState.apiConfiguration).toEqual({ apiProvider: "openrouter" })

			// Call _clearViewLocalState
			;(provider as any)._clearViewLocalState()

			// All values should be cleared
			expect((provider as any).viewLocalState).toEqual({})

			await provider.dispose()
		})

		it("should cause getState to fall back to contextProxy values after clear", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await (provider as any).saveViewState("mode", "architect")

			let state = await provider.getState()
			expect(state.mode).toBe("architect")

			// Clear viewLocalState
			;(provider as any)._clearViewLocalState()

			// getState should now fall back to contextProxy (global) state
			state = await provider.getState()
			expect(state.mode).toBe("code") // Default from mock context

			await provider.dispose()
		})

		it("should be safe to call on empty viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Should not throw even if viewLocalState is already empty
			expect((provider as any)._clearViewLocalState()).toBeUndefined()
			expect((provider as any).viewLocalState).toEqual({})

			await provider.dispose()
		})
	})
})
