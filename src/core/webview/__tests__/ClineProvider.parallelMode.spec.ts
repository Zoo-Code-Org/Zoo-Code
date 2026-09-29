// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.parallelMode.spec.ts

import * as vscode from "vscode"

import {
	type ExtensionMessage,
	type ExtensionState,
	type ProviderSettingsEntry,
	type ProviderSettingsWithId,
	type RooCodeSettings,
	PROVIDER_SETTINGS_KEYS,
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
		// Mirrors the real ContextProxy contract: the flat provider-settings keys are served
		// from the state cache, so values written via setProviderSettings round-trip.
		// The apiProvider default mirrors the schema default for an unwritten store.
		getProviderSettings = vi.fn().mockImplementation(() => {
			const flat: Record<string, unknown> = {}
			for (const key of PROVIDER_SETTINGS_KEYS) {
				const value = this.stateCache[key]
				if (value !== undefined) {
					flat[key] = value
				}
			}
			return { apiProvider: providerIdentifiers.anthropic, ...flat }
		})
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
	const modes = [
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
	]
	return {
		...actual,
		modes,
		// Resolve against the mocked mode list above (not the real module modes) so the
		// lookup matches exactly what the tests set up.
		getModeBySlug: vi.fn().mockImplementation((slug: string) => {
			return modes.find((m) => m.slug === slug) ?? null
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
			deleteConfig: vi.fn().mockResolvedValue(undefined),
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

		mockContext = Object.assign({} as vscode.ExtensionContext, {
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
		})

		mockOutputChannel = Object.assign({} as vscode.OutputChannel, {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		})
	})

	const createMockWebviewView = (postMessage = vi.fn()) =>
		Object.assign({} as vscode.WebviewView, {
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
		})

	describe("persisted view state pruning edge cases", () => {
		it("should drop the entry without updatedAt first when the cap is exceeded", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			// An entry written before updatedAt existed ranks below every timestamped entry
			// (updatedAt ?? 0) and is the first to fall off the cap.
			const states = {
				...Object.fromEntries(
					Array.from({ length: 50 }, (_, index) => [
						`view-${index}`,
						{ mode: `mode-${index}`, updatedAt: index + 1 },
					]),
				),
				"view-missing": { mode: "mode-legacy" },
			}

			const pruned = provider["prunePersistedViewStates"](states)

			expect(Object.keys(pruned)).toHaveLength(50)
			expect(pruned["view-missing"]).toBeUndefined()
			// Surviving entries must retain their complete persisted state, not just
			// exist: pin the exact fields of the oldest and newest survivors.
			expect(pruned["view-0"]).toEqual({ mode: "mode-0", updatedAt: 1 })
			expect(pruned["view-49"]).toEqual({ mode: "mode-49", updatedAt: 50 })

			await provider.dispose()
		})

		it("should keep the earliest inserted entries when updatedAt values tie", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			// Equal timestamps preserve insertion order (stable sort), so the first 50
			// registered views survive and the last 5 fall off the cap.
			const states = Object.fromEntries(
				Array.from({ length: 55 }, (_, index) => [`view-${index}`, { mode: `mode-${index}`, updatedAt: 1 }]),
			)

			const pruned = provider["prunePersistedViewStates"](states)

			expect(Object.keys(pruned)).toHaveLength(50)
			expect(pruned["view-0"]).toEqual({ mode: "mode-0", updatedAt: 1 })
			expect(pruned["view-49"]).toEqual({ mode: "mode-49", updatedAt: 1 })
			expect(pruned["view-50"]).toBeUndefined()

			await provider.dispose()
		})

		it("should drop malformed stored entries before pruning", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			// Storage can hold corrupted entries (undefined holes or non-object values) after
			// partial writes: the guard keeps them out of the sorted map so the prune cannot
			// read updatedAt off a missing entry.
			const states = Object.assign({} as Parameters<ClineProvider["prunePersistedViewStates"]>[0], {
				"view-void": undefined,
				"view-corrupt": "not-an-object",
				"view-good": { mode: "ask", updatedAt: 1 },
			})

			const pruned = provider["prunePersistedViewStates"](states)

			expect(Object.keys(pruned)).toEqual(["view-good"])
			expect(pruned["view-good"]).toEqual({ mode: "ask", updatedAt: 1 })

			await provider.dispose()
		})
	})

	describe("durable editor view state retention (#1065)", () => {
		it("should preserve persisted viewStates entry when an editor provider is disposed during teardown", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			await provider["setViewStateId"]("tab-to-preserve")
			await provider.saveViewState("mode", "architect")
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"tab-to-preserve": { mode: "architect" },
			})

			await provider.dispose()

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"tab-to-preserve": { mode: "architect" },
			})
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
			// The activation path clears (not seeds) the view-local overlay: the shared
			// store serves the activated settings, so no per-view snapshot can mask
			// later shared edits.
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()

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
			// Same A-semantics contract: the upsert/activation path clears the overlay
			// instead of snapshotting the activated settings into it.
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()

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
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// Structural cast: the env mock shapes activateProfile results as getProfile results.
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "replacement-profile",
				id: "replacement-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "replacement-key",
			} as unknown as Awaited<ReturnType<typeof provider.providerSettingsManager.getProfile>>)

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
			// The replacement's settings are served from the shared store through
			// getState(); the view-local overlay is cleared on the activation path, so
			// it cannot keep serving the deleted profile's configuration.
			expect(state.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "replacement-key",
			})
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()
			expect(vi.mocked(provider.providerSettingsManager.deleteConfig)).toHaveBeenCalledWith("deleted-profile")

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
			await mockContext.globalState.update("viewStates", {
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

		it("should not write viewStates when re-pointing skips a corrupt stored entry", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "keeper-id", name: "keeper-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// The stored map pins the keeper profile and holds a corrupt (null) entry: no pin
			// references the doomed profile, so the re-point pass must skip every entry and
			// leave the map untouched.
			const corruptFixture = {
				"view-keeps": { mode: "code", currentApiConfigName: "keeper-profile", updatedAt: 1 },
				"view-null": null,
			}
			await mockContext.globalState.update("viewStates", corruptFixture)
			provider["viewLocalState"] = {
				currentApiConfigName: "keeper-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
			}
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")
			const activateSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.openrouter,
			})

			expect(setValueSpy).not.toHaveBeenCalledWith("viewStates", expect.anything())
			expect(mockContext.globalState.get("viewStates")).toEqual(corruptFixture)
			expect(activateSpy).not.toHaveBeenCalled()

			await provider.dispose()
		})

		it("should re-point a mode-less legacy pin to a fresh two-field pin", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "keeper-id", name: "keeper-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// A pre-mode-pinning legacy entry pins the doomed profile and carries an unrelated
			// field: the re-pointed entry must be a fresh two-field pin, not a spread of the old one.
			await mockContext.globalState.update("viewStates", {
				"view-legacy": { currentApiConfigName: "doomed-profile", updatedAt: 2, legacyFlag: true },
			})

			await provider.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.openrouter,
			})

			// The empty viewLocalState takes the activate branch, which may persist an extra
			// temporary view entry, so assert on the re-pointed entry rather than the whole map.
			expect(mockContext.globalState.get("viewStates")).toEqual(
				expect.objectContaining({
					"view-legacy": { currentApiConfigName: "keeper-profile", updatedAt: expect.any(Number) },
				}),
			)

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

		it("should refresh the shared profile list when upsertProviderProfile saves without activating", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			const quietEntry: ProviderSettingsEntry = {
				id: "quiet-id",
				name: "quiet-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([quietEntry])
			const activateProfileSpy = vi.spyOn(provider.providerSettingsManager, "activateProfile")

			const savedId = await provider.upsertProviderProfile(
				"quiet-profile",
				{ apiProvider: providerIdentifiers.openrouter },
				false,
			)

			// The non-activating path persists the refreshed shared profile list under the durable
			// key while leaving the current selection and profile activation untouched.
			expect(savedId).toBe("test-id")
			expect(activateProfileSpy).not.toHaveBeenCalled()
			expect(mockContext.globalState.get("listApiConfigMeta")).toEqual([quietEntry])
			expect(mockContext.globalState.get("currentApiConfigName")).toBe("default")

			await provider.dispose()
		})

		it("should activate the replacement profile when the deleting view has no profile pin", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "keeper-id", name: "keeper-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.openrouter },
			])
			const activateSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.openrouter,
			})

			// A view without its own profile pin follows the deletion through the activation path,
			// so the shared selection refreshes to the replacement profile via activation.
			expect(activateSpy).toHaveBeenCalledWith({ name: "keeper-profile" })
			expect(await provider.getState()).toMatchObject({ currentApiConfigName: "keeper-profile" })

			await provider.dispose()
		})

		it("should refresh the pinned view through activation when it pinned the deleted profile", async () => {
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
			const listConfigSpy = vi
				.spyOn(provider.providerSettingsManager, "listConfig")
				.mockResolvedValue([
					{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
				])
			// Structural cast: the env mock shapes activateProfile results as getProfile results.
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "replacement-profile",
				id: "replacement-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "replacement-key",
			} as unknown as Awaited<ReturnType<typeof provider.providerSettingsManager.getProfile>>)
			const activateSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.deleteProviderProfile({
				id: "deleted-id",
				name: "deleted-profile",
				apiProvider: providerIdentifiers.anthropic,
			})

			// The pinning view must take the activation path with the replacement profile...
			expect(activateSpy).toHaveBeenCalledWith({ name: "replacement-profile" })
			// ...and the shared store serves the replacement settings through
			// getState(), while the cleared view-local overlay cannot mask them...
			expect((await provider.getState()).apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "replacement-key",
			})
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()
			// ...and the unrelated-pin fallback is ruled out by the activation list
			// lookup: the fallback reads the surviving entries from the store instead
			// of resolving the activation list. The activation route refreshes the
			// durable shared list from the settings store (listConfig), so the
			// replacement-only durable value is the observable pin: a path that never
			// resolved the activation list would leave the pre-deletion entries in place.
			expect(listConfigSpy).toHaveBeenCalled()
			expect(mockContext.globalState.get("listApiConfigMeta")).toEqual([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])

			await provider.dispose()
		})

		it("should re-pin a live sibling view that pins the deleted profile when the deleting view has no pin", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// B pins the doomed profile without an overlay (a fresh pin via setValue).
			await providerB.setValue("currentApiConfigName", "doomed-profile")

			// A has no profile pin of its own; the shared selection names the doomed profile.
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			await providerA.contextProxy.setValue("listApiConfigMeta", [
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])

			// Structural cast: the env mock shapes activateProfile/getProfile results uniformly.
			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "replacement-profile",
				id: "replacement-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "repl-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// The pre-return re-pin resolves the replacement's settings through the
			// manager: name the lookup so a wrong or empty argument cannot be served
			// the replacement's settings.
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) =>
					args.name === "replacement-profile"
						? ({
								name: "replacement-profile",
								id: "replacement-id",
								apiProvider: providerIdentifiers.openrouter,
								openRouterBaseUrl: "repl-url",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
						: Promise.reject(new Error(`profile ${String(args.name)} not found`)),
			)

			await providerA.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			})

			// B must be re-pointed at the replacement with the replacement's settings,
			// not left buffered on the deleted profile's name and configuration.
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("replacement-profile")
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "repl-url",
			})
			expect((await providerB.getState()).currentApiConfigName).toBe("replacement-profile")

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should re-pin siblings by name only and log when the replacement profile cannot be resolved", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(providerA, "log")

			// B pins the doomed profile without an overlay (a fresh pin via setValue).
			await providerB.setValue("currentApiConfigName", "doomed-profile")

			// A has no profile pin of its own; the shared selection names the doomed profile.
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			await providerA.contextProxy.setValue("listApiConfigMeta", [
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "replacement-profile",
				id: "replacement-id",
				apiProvider: providerIdentifiers.openrouter,
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// The resolution rejects: the re-pin must fall back to the replacement name
			// alone and log the miss.
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockRejectedValue(
				new Error("profile store unavailable"),
			)

			await providerA.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			})

			// B is re-pointed at the replacement by name, without settings it cannot
			// resolve, and the miss is logged for diagnosis.
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("replacement-profile")
			expect(providerB["viewLocalState"].apiConfiguration).toBeUndefined()
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Unable to resolve API profile 'replacement-profile'"),
			)

			await providerA.dispose()
			await providerB.dispose()
		})
	})

	describe("provider profile activation", () => {
		it("should serve the activated profile settings through getState when activating an upserted profile", async () => {
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
			// The upsert/activation path clears the view-local overlay rather than
			// snapshotting the activated settings into it, so the shared store remains
			// the single source getState() serves.
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()

			await provider.dispose()
		})

		it("should keep a sibling pinned to another profile on its own settings after a different profile activates", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// B pins profile-y without an overlay (a fresh pin via setValue).
			await providerB.setValue("currentApiConfigName", "profile-y")

			// A activates profile-x: the shared store takes x's settings.
			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "y-id", name: "profile-y", apiProvider: providerIdentifiers.openrouter },
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
			])
			// The snapshot resolves each sibling's pinned profile through A's manager.
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) =>
					args.name === "profile-y"
						? ({
								name: "profile-y",
								id: "y-id",
								apiProvider: providerIdentifiers.openrouter,
								openRouterApiKey: "y-key",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
						: ({
								name: "profile-x",
								id: "x-id",
								apiProvider: providerIdentifiers.anthropic,
								anthropicBaseUrl: "x-url",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>),
			)

			await providerA.activateProviderProfile({ name: "profile-x" })

			// A serves x's settings under its own pin...
			const aState = await providerA.getState()
			expect(aState.currentApiConfigName).toBe("profile-x")
			// anthropicBaseUrl is a non-secret PROVIDER_SETTINGS_KEYS key, so the mock shared store serves
			// it back through getProviderSettings(); the api key itself is a SECRET_STATE_KEYS entry and
			// would not round-trip through the mock, so the fixture avoids it.
			expect(aState.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			})

			// ...and B keeps its own pin on its own profile's settings: the snapshot
			// written before the shared write must shield B from A's activation.
			const bState = await providerB.getState()
			expect(bState.currentApiConfigName).toBe("profile-y")
			expect(bState.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "y-key",
			})
			// The snapshot is the profile-y settings resolved through A's manager:
			// pin the known values, not just the presence of an overlay.
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject({
				id: "y-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "y-key",
			})

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should leave a sibling's pre-existing overlay untouched when a different profile activates", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// B pins profile-y and already carries a custom overlay on top of the pin:
			// the overlay is newer than any shared write, so the snapshot must not
			// replace it with the pin's stock settings.
			await providerB.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "custom-model",
				openRouterApiKey: "custom-key",
			})
			await providerB.setValue("currentApiConfigName", "profile-y")

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "y-id", name: "profile-y", apiProvider: providerIdentifiers.openrouter },
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) =>
					args.name === "profile-y"
						? ({
								name: "profile-y",
								id: "y-id",
								apiProvider: providerIdentifiers.openrouter,
								openRouterApiKey: "y-key",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
						: ({
								name: "profile-x",
								id: "x-id",
								apiProvider: providerIdentifiers.anthropic,
								anthropicBaseUrl: "x-url",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>),
			)

			await providerA.activateProviderProfile({ name: "profile-x" })

			// B keeps its own pin and its custom overlay: the snapshot excludes views
			// that already buffer an overlay, so the activation never replaces the
			// customization with the pin's stock settings.
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("profile-y")
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "custom-model",
				openRouterApiKey: "custom-key",
			})

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should not snapshot the activating view's own overlay during its activation", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)

			// A pins profile-y without an overlay and activates profile-x. A self
			// snapshot would write y's stock settings into A's buffer and post A's
			// state before the activation's own overlay clear and post: A must end
			// the activation with a cleared buffer and exactly its own single post.
			await providerA.setValue("currentApiConfigName", "profile-y")

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "y-id", name: "profile-y", apiProvider: providerIdentifiers.openrouter },
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) =>
					args.name === "profile-y"
						? ({
								name: "profile-y",
								id: "y-id",
								apiProvider: providerIdentifiers.openrouter,
								openRouterApiKey: "y-key",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
						: ({
								name: "profile-x",
								id: "x-id",
								apiProvider: providerIdentifiers.anthropic,
								anthropicBaseUrl: "x-url",
							} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>),
			)

			const postSpy = vi.spyOn(providerA, "postStateToWebview").mockResolvedValue(undefined)

			await providerA.activateProviderProfile({ name: "profile-x" })

			expect(providerA["viewLocalState"].currentApiConfigName).toBe("profile-x")
			expect(providerA["viewLocalState"].apiConfiguration).toBeUndefined()
			expect(postSpy).toHaveBeenCalledTimes(1)

			postSpy.mockRestore()
			await providerA.dispose()
		})

		it("should serve a sibling pinned to the activated profile through the refresh, not the snapshot", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))

			// B is pinned to the very profile A activates, with no overlay. The
			// refresh path (after the shared write), not the pre-write snapshot,
			// must bring B's buffer up to date: B receives exactly one state post.
			await providerB.setValue("currentApiConfigName", "profile-x")

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
				{ id: "y-id", name: "profile-y", apiProvider: providerIdentifiers.openrouter },
			])
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)

			const postB = vi.spyOn(providerB, "postStateToWebview").mockResolvedValue(undefined)

			await providerA.activateProviderProfile({ name: "profile-x" })

			// B's buffer holds the activated profile's settings...
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			})
			// ...and the refresh is the sole writer: exactly one post, not a snapshot
			// plus refresh double write.
			expect(postB).toHaveBeenCalledTimes(1)

			postB.mockRestore()
			await providerA.dispose()
			await providerB.dispose()
		})

		it("should leave the sibling overlay untouched and log when the pinned profile cannot be resolved", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
			)
			const providerB = new ClineProvider(mockContext, mockOutputChannel, "editor", new ContextProxy(mockContext))
			const logSpy = vi.spyOn(providerA, "log")

			// B pins profile-y without an overlay; the profile cannot be resolved
			// through A's manager. A wrong snapshot is worse than the pre-write
			// shared values, so the miss must leave B's buffer as is and be logged.
			await providerB.setValue("currentApiConfigName", "profile-y")

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "y-id", name: "profile-y", apiProvider: providerIdentifiers.openrouter },
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockRejectedValue(
				new Error("profile store unavailable"),
			)

			await providerA.activateProviderProfile({ name: "profile-x" })

			expect(providerB["viewLocalState"].apiConfiguration).toBeUndefined()
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Unable to resolve profile 'profile-y'"))

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should drop the view-local overlay when flat provider settings are written through setValues", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			// Seed a pinned overlay (as loadViewState would after a reload).
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "stale-key",
			})
			expect(provider["viewLocalState"].apiConfiguration).toMatchObject({ openRouterApiKey: "stale-key" })

			// A flat provider-settings write reaches the shared store and must not be
			// masked by the pinned overlay in getState().
			await provider.setValues({ apiProvider: providerIdentifiers.zai })

			const state = await provider.getState()
			expect(state.apiConfiguration.apiProvider).toBe("zai")
			expect(state.apiConfiguration).not.toHaveProperty("openRouterApiKey")
			expect(provider["viewLocalState"].apiConfiguration).toBeUndefined()

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
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "state", state: expect.objectContaining({ mode: "architect" }) }),
			)

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
			// Minimal Task double: handleModeSwitch and addClineToStack only touch the fields above.
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

		it("should log and no-op when handleModeSwitch receives an unknown mode slug", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider["resolveWebviewView"](createMockWebviewView())
			const logSpy = vi.spyOn(provider, "log")

			await provider.handleModeSwitch("bogus-slug")

			// Unknown slugs are rejected before any durable write: nothing is persisted under
			// the view and no profile mutation is queued.
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unknown mode "bogus-slug"'))
			expect(mockContext.globalState.get("viewStates")).toBeUndefined()

			await provider.dispose()
		})

		// K1: a no-task switch captures its target before any task is focused; a task gains
		// focus before the queued mutation runs. The view-level durable write and the
		// ModeChanged broadcast belong to the view and must still happen.
		it("should keep the view-level effects when a no-task switch is captured before a task gains focus", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider["resolveWebviewView"](createMockWebviewView())
			await provider["setViewStateId"]("k1-view")
			const modeChangedSpy = vi.fn()
			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)
			const makeTask = (taskId: string) => ({
				taskId,
				_taskMode: "code",
				emit: vi.fn(),
				saveClineMessages: vi.fn().mockResolvedValue(undefined),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			})
			// Minimal Task double: addClineToStack only touches the fields above, so the
			// structural cast stands in for the omitted Task internals.
			vi.spyOn(provider.customModesManager, "getCustomModes").mockImplementationOnce(async () => {
				await provider.addClineToStack(makeTask("late-focus-task") as unknown as Task)
				return []
			})

			await provider.handleModeSwitch("architect")

			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider.contextProxy.getValue("viewStates")).toEqual(
				expect.objectContaining({
					"k1-view": expect.objectContaining({ mode: "architect" }),
				}),
			)
			expect(modeChangedSpy).toHaveBeenCalledWith("architect")

			await provider.dispose()
		})

		// K2: a non-focused switch with a saved mode config in the mocks must not load it:
		// the task-scoped switch applies to the task only, and the view-level profile load
		// stays behind the view-scoped guard.
		it("should skip the mode profile load for a non-focused switch even when a saved config exists", async () => {
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
			// Minimal Task double: handleModeSwitch and addClineToStack only touch the fields above.
			await provider.addClineToStack(makeTask("focused-task") as unknown as Task)
			const backgroundTask = makeTask("background-task")
			await provider["setViewStateId"]("k2-view")
			await provider.saveViewState("mode", "code")
			const modeChangedSpy = vi.fn()
			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)
			const k2Entry: ProviderSettingsEntry = {
				id: "k2-profile-id",
				name: "k2-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const k2Settings: ProviderSettingsWithId & { name: string } = {
				id: "k2-profile-id",
				name: "k2-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "k2-key",
			}
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValueOnce("k2-profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValueOnce([k2Entry])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValueOnce(k2Settings)
			const activateProfileSpy = vi.spyOn(provider.providerSettingsManager, "activateProfile")

			await provider.handleModeSwitch("architect", backgroundTask as unknown as Task)

			// The task-scoped switch still lands on the background task...
			expect(backgroundTask.emit).toHaveBeenCalledWith(
				RooCodeEventName.TaskModeSwitched,
				"background-task",
				"architect",
			)
			// ...but the view-level profile load stays untouched: no mode profile lookup, no
			// activation, no durable list rewrite, no viewStates write, and an unchanged buffer.
			expect(provider.providerSettingsManager.getModeConfigId).not.toHaveBeenCalled()
			expect(activateProfileSpy).not.toHaveBeenCalled()
			expect(provider.contextProxy.getValue("listApiConfigMeta")).toEqual([])
			expect(modeChangedSpy).not.toHaveBeenCalled()
			expect(mockContext.globalState.get("viewStates")).toEqual(
				expect.objectContaining({
					"k2-view": expect.objectContaining({ mode: "code" }),
				}),
			)
			expect(provider["viewLocalState"]).toEqual({ mode: "code" })

			await provider.dispose()
		})

		it("should roll back the shared mode write when the durable write fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			// The shared store already carries a mode, so the rollback has a concrete value
			// to restore.
			await provider.contextProxy.setValue("mode", "code")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue").mockImplementation(async (key, value) => {
				// Only the fresh durable mode write fails; the rollback write succeeds.
				if (key === "mode" && value !== "code") throw new Error("durable write failed")
			})
			// The provider's async initialization can record stray writes on the spy
			// before this test's mutation starts; start the assertion window clean.
			setValueSpy.mockClear()

			await expect(provider.handleModeSwitch("ask")).rejects.toThrow("durable write failed")

			// The failed write was rolled back to the previous shared mode, so the shared
			// store cannot be left with the new mode's half-applied state.
			const modeWrites = setValueSpy.mock.calls.filter(([key]) => key === "mode")
			expect(modeWrites).toEqual([
				["mode", "ask"],
				["mode", "code"],
			])

			await provider.dispose()
		})

		it("should log the rollback failure and rethrow the original error when the rollback also fails", async () => {
			const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
			await provider.contextProxy.setValue("mode", "code")
			const appendLine = vi.spyOn(mockOutputChannel, "appendLine")
			const durableError = new Error("durable write failed")
			vi.spyOn(provider.contextProxy, "setValue").mockImplementation(async (key) => {
				if (key === "mode") throw durableError
			})

			await expect(provider.handleModeSwitch("ask")).rejects.toThrow("durable write failed")

			// The rollback failure is logged with its own message and the original error
			// still propagates: a failed switch must not be swallowed into a logged no-op.
			expect(appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to roll back shared mode"))
			expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Failed to persist mode "ask"'))

			await provider.dispose()
		})
	})
})
