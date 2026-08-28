// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.parallelMode.spec.ts

import * as vscode from "vscode"

import {
	type ExtensionMessage,
	type ExtensionState,
	type ProviderSettingsEntry,
	type ProviderSettingsWithId,
	type RooCodeSettings,
	RooCodeEventName,
	providerIdentifiers,
} from "@roo-code/types"

import { defaultModeSlug } from "../../../shared/modes"
import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { TelemetryService } from "@roo-code/telemetry"

import type { Task } from "../../task/Task"

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
	const onDidChangeConfigurationMock = vi.fn(
		(handler: (e: { affectsConfiguration: (key: string) => boolean }) => void) => {
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
		},
	)

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
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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
		/**
		 * Mirrors the real ContextProxy state cache: seeded from the store in the
		 * constructor (like initialize()), then mutated only through setValue, so
		 * getValue can return a stale value that diverges from direct store writes.
		 */
		private stateCache: Record<string, unknown> = {}

		constructor(public context: vscode.ExtensionContext) {
			this.globalStorageUri = context.globalStorageUri ?? { fsPath: "/test/storage/path" }
			this.extensionUri = context.extensionUri ?? { fsPath: "/test/path" }

			for (const key of context.globalState.keys()) {
				const value = context.globalState.get(key)
				if (value !== undefined) {
					this.stateCache[key] = value
				}
			}
		}

		getValues = vi.fn().mockImplementation(() => ({
			...defaultState,
			mode: this.stateCache.mode ?? defaultState.mode,
			currentApiConfigName: this.stateCache.currentApiConfigName ?? defaultState.currentApiConfigName,
			apiConfiguration: this.stateCache.apiConfiguration ?? defaultState.apiConfiguration,
			customModePrompts: this.stateCache.customModePrompts ?? defaultState.customModePrompts,
			modeApiConfigs: this.stateCache.modeApiConfigs ?? defaultState.modeApiConfigs,
			listApiConfigMeta: this.stateCache.listApiConfigMeta ?? defaultState.listApiConfigMeta,
			pinnedApiConfigs: this.stateCache.pinnedApiConfigs ?? defaultState.pinnedApiConfigs,
		}))
		getValue = vi.fn().mockImplementation((key: string) => this.stateCache[key])
		getProviderSettings = vi.fn().mockReturnValue({ apiProvider: providerIdentifiers.anthropic })
		setValue = vi.fn().mockImplementation((key: string, value: unknown) => {
			if (value === undefined || value === null) {
				delete this.stateCache[key]
			} else {
				this.stateCache[key] = value
			}
			return this.context.globalState.update(key, value) ?? Promise.resolve()
		})
		setValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
			return Promise.all(Object.entries(values).map(([key, value]) => this.setValue(key, value))).then(
				() => undefined,
			)
		})
		setProviderSettings = vi
			.fn()
			.mockImplementation((settings: Record<string, unknown>) => this.setValues(settings))
		resetAllState = vi.fn().mockImplementation(() => {
			const keys = this.context.globalState.keys()
			return Promise.all(keys.map((key: string) => this.setValue(key, undefined))).then(() => undefined)
		})
	}
	return { ContextProxy: MockContextProxy }
})

// Mock Task
vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options?: { historyItem?: { id?: string } }) {
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
				apiProvider: providerIdentifiers.anthropic,
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

		const globalState: Record<string, unknown> = {
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
				update: vi.fn().mockImplementation((key: string, value: unknown) => {
					globalState[key] = value
					return Promise.resolve()
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
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
		}) as unknown as vscode.WebviewView

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

			await provider2.saveViewState("mode", "debugger")
			await provider1.saveViewState("mode", "architect")

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

			const saveViewState1 = provider1.saveViewState.bind(provider1)
			const saveViewState2 = provider2.saveViewState.bind(provider2)

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
			await provider["setViewStateId"]("stable-sidebar-view")

			await provider.saveViewState("mode", "architect")

			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
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

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("currentApiConfigName", "my-profile")

			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "my-profile" },
			})

			await provider.dispose()
		})

		it("should update viewLocalState for apiConfiguration without persisting provider settings or secrets", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			const testApiConfig = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "claude-3.5-sonnet",
				openRouterApiKey: "secret-key",
			}

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("apiConfiguration", testApiConfig)

			expect(provider["viewLocalState"].apiConfiguration).toEqual(testApiConfig)
			expect(provider.contextProxy.getValue("viewStates")).toBeUndefined()

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives undefined", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("mode", "architect")
			expect(provider["viewLocalState"].mode).toBe("architect")

			await provider.saveViewState("mode", undefined)

			expect(Object.prototype.hasOwnProperty.call(provider["viewLocalState"], "mode")).toBe(false)

			await provider.dispose()
		})

		it("should clear local override when saveViewState receives undefined", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("currentApiConfigName", "my-profile")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")

			await provider.saveViewState("currentApiConfigName", undefined)

			expect(Object.prototype.hasOwnProperty.call(provider["viewLocalState"], "currentApiConfigName")).toBe(false)

			await provider.dispose()
		})
		it("should not update viewLocalState when durable view-state persistence fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerAccess = provider as unknown as {
				setViewStateId: (viewStateId: string) => Promise<void>
				saveViewState: (key: keyof ExtensionState, value: unknown) => Promise<void>
				viewLocalState: Partial<ExtensionState>
			}
			vi.spyOn(provider.contextProxy, "setValue").mockRejectedValueOnce(new Error("persist failed"))

			await providerAccess.setViewStateId("stable-sidebar-view")

			await expect(providerAccess.saveViewState("mode", "architect")).rejects.toThrow("persist failed")
			expect(providerAccess.viewLocalState).not.toHaveProperty("mode")
			expect(provider.contextProxy.getValue("viewStates")).toBeUndefined()

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

			await provider1["setViewStateId"]("stable-sidebar-view")
			await provider2["setViewStateId"]("stable-editor-view")

			await Promise.all([
				provider1.saveViewState("mode", "architect"),
				provider2.saveViewState("currentApiConfigName", "editor-profile"),
			])

			expect(mockContext.globalState.get("viewStates")).toMatchObject({
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
				expect(provider["viewLocalState"]).toEqual({})
			})

			const state = await provider.getState()
			expect(state.mode).toBe("code")
			expect(state.currentApiConfigName).toBe("default")

			await provider.dispose()
		})

		it("should restore mode and currentApiConfigName from hydrated viewStates after extension reload", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const stableViewId = "stable-sidebar-view"

			await provider.contextProxy.setValue("viewStates", {
				[stableViewId]: { mode: "architect", currentApiConfigName: "new-profile", updatedAt: 123 },
			})

			await provider["setViewStateId"](stableViewId)

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
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/anthropic/claude-sonnet-4",
			})

			await provider.contextProxy.setValue("viewStates", {
				[stableViewId]: { mode: "architect", currentApiConfigName: "profile-a", updatedAt: 123 },
			})
			await provider.contextProxy.setValue("mode", "debugger")
			await provider.contextProxy.setValue("currentApiConfigName", "profile-b")
			// "apiConfiguration" is a GlobalState key rather than a RooCodeSettings key,
			// so the proxy's generic key type is widened to reach the mock's cache path.
			await provider.contextProxy.setValue("apiConfiguration" as unknown as keyof RooCodeSettings, {
				apiProvider: providerIdentifiers.anthropic,
			})

			await provider["setViewStateId"](stableViewId)
			const state = await provider.getState()

			expect(getProfileSpy).toHaveBeenCalledWith({ name: "profile-a" })
			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("profile-a")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/anthropic/claude-sonnet-4",
			})

			await provider.dispose()
		})

		it("should not throw when a persisted profile selection cannot be resolved", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const stableViewId = "stable-editor-tab-a"
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockRejectedValue(new Error("missing profile"))

			await provider.contextProxy.setValue("viewStates", {
				[stableViewId]: { mode: "architect", currentApiConfigName: "deleted-profile", updatedAt: 123 },
			})

			await expect(provider["setViewStateId"](stableViewId)).resolves.toBeUndefined()
			const state = await provider.getState()

			expect(state.mode).toBe("architect")
			expect(state.currentApiConfigName).toBe("deleted-profile")
			expect(state.apiConfiguration.apiProvider).toBe("anthropic")

			await provider.dispose()
		})

		it("should log and keep existing viewLocalState when loadViewState fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(provider, "log")

			provider["viewLocalState"] = { mode: "architect" }
			vi.spyOn(provider.contextProxy, "getValue").mockImplementation(() => {
				throw new Error("load failed")
			})

			await provider["loadViewState"]()

			expect(provider["viewLocalState"].mode).toBe("architect")
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

			const pruned = provider["prunePersistedViewStates"](states)

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
			await provider.saveViewState("mode", "architect")

			state = await provider.getState()
			expect(state.mode).toBe("architect")

			await provider.dispose()
		})

		it("should preserve global state values not overridden by viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("mode", "architect")

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

			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "local-key",
			})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("openrouter")
			expect(state.apiConfiguration.openRouterApiKey).toBe("local-key")

			await provider.dispose()
		})

		it("should merge getValues from ContextProxy with view-local values taking precedence", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerAccess = provider as unknown as {
				saveViewState: (key: keyof ExtensionState, value: unknown) => Promise<void>
			}
			const contextProxyAccess = provider.contextProxy as unknown as {
				setValues: (values: Partial<ExtensionState>) => Promise<void>
			}
			await contextProxyAccess.setValues({
				mode: "debugger",
				currentApiConfigName: "shared-profile",
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "shared-key",
				},
				customModePrompts: { code: { roleDefinition: "shared" } },
			})

			await providerAccess.saveViewState("mode", "architect")
			await providerAccess.saveViewState("currentApiConfigName", "view-profile")
			await providerAccess.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "view-key",
			})

			const values = provider.getValues()

			expect(values.mode).toBe("architect")
			expect(values.currentApiConfigName).toBe("view-profile")
			expect(values.apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "view-key",
			})
			expect(values.customModePrompts).toEqual({ code: { roleDefinition: "shared" } })

			await provider.dispose()
		})

		it("should update viewLocalState apiConfiguration when setValues receives flat provider settings", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/old-model",
			})

			await provider.setValues({
				apiProvider: providerIdentifiers.bedrock,
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
			expect(provider["viewLocalState"].apiConfiguration?.apiProvider).toBe("bedrock")
			expect(provider["viewLocalState"].apiConfiguration).not.toHaveProperty("openRouterModelId")

			await provider.dispose()
		})

		it("should persist setValue mutations for view-local mode", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.setValue("mode", "architect")

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { mode: "architect" },
			})

			await provider.dispose()
		})

		it("should persist setValues mutations for view-local API profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.setValues({ currentApiConfigName: "profile-from-set-values" })

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "profile-from-set-values" },
			})

			await provider.dispose()
		})

		it("should sanitize raw viewStateId before using it as persisted viewStates key", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider["setViewStateId"]("tab panel/with.dots and spaces")
			await provider.setValue("mode", "architect")

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				tab_panel_with_dots_and_spaces: { mode: "architect" },
			})
			expect(provider.contextProxy.getValue("viewStates")).not.toHaveProperty("tab panel/with.dots and spaces")

			await provider.dispose()
		})

		it("should persist queued writes under the viewStateId active when the change was made", async () => {
			let releaseFirstWrite!: () => void
			const firstWriteStarted = new Promise<void>((resolve) => {
				mockContext.globalState.update = vi
					.fn()
					.mockImplementationOnce((key: string, value: unknown) => {
						mockContext.globalState.get = vi
							.fn()
							.mockImplementation((lookupKey: string) => (lookupKey === key ? value : undefined))
						resolve()
						return new Promise<void>((writeResolve) => {
							releaseFirstWrite = writeResolve
						})
					})
					.mockImplementation((key: string, value: unknown) => {
						mockContext.globalState.get = vi
							.fn()
							.mockImplementation((lookupKey: string) => (lookupKey === key ? value : undefined))
						return Promise.resolve()
					})
			})
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider["setViewStateId"]("view-a")
			const firstSave = provider.saveViewState("mode", "architect")
			await firstWriteStarted
			await provider["setViewStateId"]("view-b")
			releaseFirstWrite()
			await firstSave

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"view-a": { mode: "architect" },
			})
			expect(provider.contextProxy.getValue("viewStates")).not.toHaveProperty("view-b")

			await provider.dispose()
		})

		it("should preserve persisted viewStates entry when an editor provider is disposed during teardown", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await provider["setViewStateId"]("tab-to-preserve")
			await provider.saveViewState("mode", "architect")
			expect(provider.contextProxy.getValue("viewStates")).toHaveProperty("tab-to-preserve")

			await provider.dispose()

			expect(provider.contextProxy.getValue("viewStates")).toHaveProperty("tab-to-preserve")
		})

		it("should read viewStates fresh from storage so out-of-proxy writes are not clobbered", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider["setViewStateId"]("view-a")
			await provider.saveViewState("mode", "architect")

			// Simulate a concurrent writer (another view's provider) updating the shared
			// map directly in storage, bypassing this proxy's cache.
			const stored = (await mockContext.globalState.get<Record<string, unknown>>("viewStates")) ?? {}
			mockContext.globalState.update("viewStates", {
				...stored,
				"view-b": { mode: "debug", updatedAt: 1 },
			})

			await provider.saveViewState("mode", "code")

			// The serialized write must have merged on top of the fresh storage value, not
			// on top of this proxy's stale cache.
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"view-a": { mode: "code" },
				"view-b": { mode: "debug" },
			})

			await provider.dispose()
		})

		it("should re-key durable viewStates entries from the temporary pre-launch view id", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// A change made before the stable id is registered persists under the
			// temporary id so it is not lost; registration re-keys it to the stable id.
			await provider.saveViewState("mode", "architect")

			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				[provider.viewId]: { mode: "architect" },
			})

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("mode", "debugger")

			const viewStates = provider.contextProxy.getValue("viewStates") as Record<string, { mode?: string }>
			expect(viewStates["stable-sidebar-view"]).toMatchObject({ mode: "debugger" })
			expect(viewStates[provider.viewId]).toBeUndefined()

			await provider.dispose()
		})

		it("should drop the temporary viewStates entry when a stable entry already exists", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// A stable entry already exists (e.g. a previous session persisted under a
			// colliding temporary id); it must win over the temporary entry.
			await provider.contextProxy.setValue("viewStates", {
				[provider.viewId]: { mode: "architect", updatedAt: 1 },
				"stable-sidebar-view": { mode: "debugger", updatedAt: 2 },
			})

			await provider["setViewStateId"]("stable-sidebar-view")

			const viewStates = provider.contextProxy.getValue("viewStates") as Record<string, { mode?: string }>
			expect(viewStates["stable-sidebar-view"]).toMatchObject({ mode: "debugger" })
			expect(viewStates[provider.viewId]).toBeUndefined()
			expect(provider["viewLocalState"].mode).toBe("debugger")

			await provider.dispose()
		})

		it("should discard a stale loadViewState when a newer view id is registered during the load", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const providerAccess = provider as unknown as {
				viewId: string
				viewLocalState: { mode?: string; currentApiConfigName?: string }
				loadViewState(): Promise<void>
				setViewStateId(id: string): Promise<void>
			}

			// Seed persisted entries under both ids through the proxy so the loads
			// observe them via the cached read path: the temporary entry holds a
			// pre-registration selection, the stable entry the post-registration one.
			await provider.contextProxy.setValue("viewStates", {
				[providerAccess.viewId]: { mode: "architect", currentApiConfigName: "ghost-profile", updatedAt: 1 },
				"stable-sidebar-view": { mode: "debug", updatedAt: 2 },
			})

			// Hang the temporary entry's profile lookup so that load is still in flight
			// when the stable id is registered.
			let releaseGhost!: () => void
			const ghostLoad = new Promise<void>((resolve) => {
				releaseGhost = resolve
			})
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockReturnValue(
				ghostLoad.then(
					() =>
						({
							name: "ghost-profile",
							id: "ghost-id",
							apiProvider: providerIdentifiers.anthropic,
						}) as unknown as Awaited<ReturnType<typeof provider.providerSettingsManager.getProfile>>,
				),
			)

			const staleLoad = providerAccess.loadViewState()

			// Register the stable id without awaiting its load: the re-key drops the
			// temporary entry (the stable one already exists) and the registration's own
			// load settles on the stable entry immediately.
			const register = providerAccess.setViewStateId("stable-sidebar-view")
			await register

			releaseGhost()
			await staleLoad

			// The stale (temporary-id) load must not overwrite the stable id's load.
			expect(providerAccess.viewLocalState).toEqual({ mode: "debug" })

			await provider.dispose()
		})
	})

	describe("profile mutations", () => {
		it("should synchronize viewLocalState when activateProviderProfile mutates ContextProxy", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValueOnce({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/new-model",
			})
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([
				{ id: "new-profile-id", name: "new-profile", apiProvider: providerIdentifiers.openrouter },
			])
			const saveViewStateSpy = vi.spyOn(provider, "saveViewState")
			provider["viewLocalState"] = {
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			}

			await provider.activateProviderProfile({ name: "new-profile" })
			const state = await provider.getState()

			expect(saveViewStateSpy).not.toHaveBeenCalled()
			expect(state.currentApiConfigName).toBe("new-profile")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/new-model",
			})

			await provider.dispose()
		})

		it("should synchronize viewLocalState when upsertProviderProfile activates a saved profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "test-id", name: "saved-profile", apiProvider: providerIdentifiers.bedrock },
			])
			const saveViewStateSpy = vi.spyOn(provider, "saveViewState")
			provider["viewLocalState"] = {
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			}

			await provider.upsertProviderProfile("saved-profile", {
				apiProvider: providerIdentifiers.bedrock,
				awsRegion: "us-east-1",
			})
			const state = await provider.getState()

			expect(saveViewStateSpy).not.toHaveBeenCalled()
			expect(state.currentApiConfigName).toBe("saved-profile")
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.bedrock,
				awsRegion: "us-east-1",
			})

			await provider.dispose()
		})

		it("should synchronize viewLocalState when deleteProviderProfile selects a replacement profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName", "deleted-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "deleted-id", name: "deleted-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])
			provider["viewLocalState"] = {
				currentApiConfigName: "deleted-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			}

			await provider.deleteProviderProfile({
				id: "deleted-id",
				name: "deleted-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			const state = await provider.getState()

			expect(state.currentApiConfigName).toBe("replacement-profile")
			expect(state.listApiConfigMeta).toEqual([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])

			await provider.dispose()
		})

		it("should re-point persisted view pins that referenced a deleted profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "keeper-id", name: "keeper-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// Two views have durable pins; one pins the profile about to be deleted.
			mockContext.globalState.update("viewStates", {
				"view-keeps": { mode: "code", currentApiConfigName: "keeper-profile", updatedAt: 1 },
				"view-deleted": { mode: "architect", currentApiConfigName: "doomed-profile", updatedAt: 2 },
			})

			await provider.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.openrouter,
			})

			// The affected pin is re-pointed to the replacement profile; the unrelated pin survives.
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"view-keeps": { mode: "code", currentApiConfigName: "keeper-profile" },
				"view-deleted": { mode: "architect", currentApiConfigName: "keeper-profile" },
			})

			await provider.dispose()
		})
		it("should clear viewLocalState when resetState resets ContextProxy", async () => {
			vi.mocked(vscode.window.showInformationMessage).mockImplementationOnce(
				async (_message: string, _options: unknown, ...items: vscode.MessageItem[]) => items[0],
			)
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			provider["viewLocalState"] = {
				mode: "architect",
				currentApiConfigName: "stale-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter },
			}

			await provider.resetState()

			expect(provider["viewLocalState"]).toEqual({})

			await provider.dispose()
		})
	})

	describe("provider profile activation", () => {
		it("should sync view-local apiConfiguration when activating an upserted profile", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4.1",
			})

			const providerSettings = {
				apiProvider: providerIdentifiers.zai,
				zaiApiKey: "mock-key",
				zaiApiLine: "international_api" as const,
				apiModelId: "glm-5.1",
			}
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("zai-profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "default", id: "zai-profile-id", apiProvider: providerIdentifiers.zai },
			])

			await provider.upsertProviderProfile("default", providerSettings, true)

			const state = await provider.getState()
			expect(state.currentApiConfigName).toBe("default")
			expect(state.apiConfiguration).toMatchObject(providerSettings)
			expect(state.apiConfiguration.apiProvider).toBe("zai")
			expect(state.apiConfiguration).not.toHaveProperty("openRouterModelId")
			expect(provider["viewLocalState"].apiConfiguration).toMatchObject(providerSettings)

			await provider.dispose()
		})
	})

	describe("handleModeSwitch integration", () => {
		it("should update viewLocalState.mode when handleModeSwitch is called", async () => {
			const postMessage = vi.fn()
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.resolveWebviewView(createMockWebviewView(postMessage))

			const saveViewStateSpy = vi.spyOn(provider, "saveViewState")

			await provider.handleModeSwitch("architect")

			expect(provider["viewLocalState"].mode).toBe("architect")
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

			await provider.resolveWebviewView(createMockWebviewView(postMessage))
			postMessage.mockClear()

			await provider.handleModeSwitch("architect")

			expect(getModeConfigIdSpy).not.toHaveBeenCalled()
			expect(postMessage).toHaveBeenCalled()

			await provider.dispose()
		})

		it("should activate configured mode profile when switching modes", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValueOnce("profile-id")
			const profileEntry: ProviderSettingsEntry = {
				id: "profile-id",
				name: "mode-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const profileSettings: ProviderSettingsWithId & { name: string } = {
				id: "profile-id",
				name: "mode-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([profileEntry])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValueOnce(profileSettings)
			const activateProfileSpy = vi
				.spyOn(provider.providerSettingsManager, "activateProfile")
				.mockResolvedValueOnce(profileSettings)

			await provider.handleModeSwitch("architect")

			expect(activateProfileSpy).toHaveBeenCalledWith({ name: "mode-profile" })

			await provider.dispose()
		})

		it("should leave current configuration unchanged for empty mode profiles", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValueOnce("empty-profile-id")
			const profileEntry: ProviderSettingsEntry = { id: "empty-profile-id", name: "empty-profile" }
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([profileEntry])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValueOnce({
				id: "empty-profile-id",
				name: "empty-profile",
			})
			const activateProfileSpy = vi.spyOn(provider.providerSettingsManager, "activateProfile")

			await provider.handleModeSwitch("architect")

			expect(activateProfileSpy).not.toHaveBeenCalled()

			await provider.dispose()
		})

		it("should emit ModeChanged event after handleModeSwitch", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const modeChangedSpy = vi.fn()

			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)

			await provider.handleModeSwitch("architect")

			expect(modeChangedSpy).toHaveBeenCalledWith("architect")

			await provider.dispose()
		})

		// A4 regression: non-focused target task
		it("should scope mode switches for non-focused tasks to the task only", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider["resolveWebviewView"](createMockWebviewView())
			const makeTask = (taskId: string) => ({
				taskId,
				_taskMode: "code",
				emit: vi.fn(),
				saveClineMessages: vi.fn().mockResolvedValue(undefined),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			})
			await provider.addClineToStack(makeTask("focused-task") as unknown as Task)
			const backgroundTask = makeTask("background-task")
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("mode", "code")
			const modeChangedSpy = vi.fn()
			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)
			const activateProfileSpy = vi.spyOn(provider.providerSettingsManager, "activateProfile")
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			await provider.handleModeSwitch("architect", backgroundTask as unknown as Task)
			// Task-scoped effects apply to the background task:
			expect(backgroundTask.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskModeSwitched,
				"background-task",
				"architect",
			)
			expect(backgroundTask._taskMode).toBe("architect")
			// ...but the view-level effects (durable mode pin, broadcast, profile) stay untouched:
			expect(provider["viewLocalState"].mode).toBe("code")
			expect(modeChangedSpy).not.toHaveBeenCalled()
			expect(activateProfileSpy).not.toHaveBeenCalled()
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

			await provider1.saveViewState("mode", "code")
			await provider1.saveViewState("currentApiConfigName", "profile-1")
			await provider2.saveViewState("mode", "architect")
			await provider2.saveViewState("currentApiConfigName", "profile-2")
			await provider3.saveViewState("mode", "debugger")
			await provider3.saveViewState("currentApiConfigName", "profile-3")

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

			await provider1.resolveWebviewView(createMockWebviewView(postMessage1))
			await provider2.resolveWebviewView(createMockWebviewView(postMessage2))
			await provider1.saveViewState("mode", "code")
			await provider2.saveViewState("mode", "debugger")

			await provider1.handleModeSwitch("architect")

			const state1 = await provider1.getState()
			const state2 = await provider2.getState()

			expect(state1.mode).toBe("architect")
			expect(state2.mode).toBe("debugger")
			expect(provider2["viewLocalState"].mode).toBe("debugger")

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("_clearViewLocalState", () => {
		it("should clear all view-local state values", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("mode", "architect")
			await provider.saveViewState("currentApiConfigName", "my-profile")
			await provider.saveViewState("apiConfiguration", { apiProvider: providerIdentifiers.openrouter })

			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
			})

			// Call _clearViewLocalState
			provider["_clearViewLocalState"]()

			// All values should be cleared
			expect(provider["viewLocalState"]).toEqual({})

			await provider.dispose()
		})

		it("should cause getState to fall back to contextProxy values after clear", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			await provider.saveViewState("mode", "architect")

			let state = await provider.getState()
			expect(state.mode).toBe("architect")

			// Clear viewLocalState
			provider["_clearViewLocalState"]()

			// getState should now fall back to contextProxy (global) state
			state = await provider.getState()
			expect(state.mode).toBe("code") // Default from mock context

			await provider.dispose()
		})

		it("should be safe to call on empty viewLocalState", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

			// Should not throw even if viewLocalState is already empty
			expect(provider["_clearViewLocalState"]()).toBeUndefined()
			expect(provider["viewLocalState"]).toEqual({})

			await provider.dispose()
		})
	})
})
