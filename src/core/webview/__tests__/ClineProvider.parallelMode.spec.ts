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
import { McpServerManager } from "../../../services/mcp/McpServerManager"
import { ClineProvider } from "../ClineProvider"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { TelemetryService } from "@roo-code/telemetry"

import type { McpHub } from "../../../services/mcp/McpHub"
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
vi.mock("../../../services/mcp/McpHub", () => ({
	McpHub: vi.fn().mockImplementation(function () {
		return {
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
			getAllServers: vi.fn().mockReturnValue([]),
		}
	}),
}))

vi.mock("../../../services/mcp/McpServerManager", () => ({
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
vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
}))

// Mock MarketplaceManager
vi.mock("../../../services/marketplace", () => ({
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
	})

	describe("sibling view consistency after a profile activation", () => {
		const makeProvider = () =>
			new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

		// One pair for the whole block: each ClineProvider spins up background managers, and
		// creating a pair per test leaves their console output in flight when the worker tears
		// the environment down (vitest reports it as an unhandled rejection).
		let viewA: ClineProvider
		let viewB: ClineProvider
		let consoleError: ReturnType<typeof vi.spyOn>
		let getProfile: ReturnType<typeof vi.spyOn>
		let providerSettingsSpy: ReturnType<typeof vi.spyOn> | undefined

		beforeAll(() => {
			consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
			viewA = makeProvider()
			viewB = makeProvider()
		})

		afterAll(async () => {
			await viewA.dispose()
			await viewB.dispose()
			consoleError.mockRestore()
		})

		beforeEach(() => {
			viewB["viewLocalState"] = {}
			getProfile = vi.spyOn(viewA.providerSettingsManager, "getProfile").mockResolvedValue(pinnedElsewhere)
		})

		afterEach(() => {
			// Only the per-test spies: a broad restore would also drop the file-level and
			// block-level console spies, and their absence is what lets in-flight console
			// output surface as an unhandled rejection at teardown.
			getProfile.mockRestore()
			providerSettingsSpy?.mockRestore()
		})

		type ProfileFixture = ProviderSettingsWithId & { name: string }

		const activated: ProfileFixture = {
			id: "profile-a-id",
			name: "profile-a",
			apiProvider: providerIdentifiers.openai,
			apiKey: "activated-key",
			openAiBaseUrl: "https://activated.example",
		}

		const pinnedElsewhere: ProfileFixture = {
			id: "profile-b-id",
			name: "profile-b",
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "pinned-b-key",
		}

		it("reloads the pinned profile for a view pinned to a different profile", async () => {
			// Exactly the buffer B is left in after activating "profile-b": the activation pins the
			// name and clears the apiConfiguration overlay, so getState() reads settings from the
			// shared store.
			viewB["viewLocalState"].currentApiConfigName = "profile-b"

			const getProfile = vi.spyOn(viewA.providerSettingsManager, "getProfile").mockResolvedValue(pinnedElsewhere)

			await viewA["refreshViewLocalStateForUpdatedProfile"]("profile-a", activated)

			// Without the reload, B reports the name "profile-b" next to profile-a's settings.
			expect(getProfile).toHaveBeenCalledWith({ name: "profile-b" })
			expect(viewB["viewLocalState"].apiConfiguration).toEqual(pinnedElsewhere)
			expect(viewB["viewLocalState"].currentApiConfigName).toBe("profile-b")
		})

		it("pushes the updated settings into a view pinned to the activated profile", async () => {
			viewB["viewLocalState"].currentApiConfigName = "profile-a"

			await viewA["refreshViewLocalStateForUpdatedProfile"]("profile-a", activated)

			// The activated profile's settings are already in hand; no reload needed.
			expect(getProfile).not.toHaveBeenCalled()
			expect(viewB["viewLocalState"].apiConfiguration).toEqual(activated)
		})

		it("leaves an unpinned view following the shared store", async () => {
			await viewA["refreshViewLocalStateForUpdatedProfile"]("profile-a", activated)

			expect(getProfile).not.toHaveBeenCalled()
			expect(viewB["viewLocalState"].apiConfiguration).toBeUndefined()
		})

		it("does not fill a pinned view's configuration from the shared provider settings", async () => {
			viewB["viewLocalState"].currentApiConfigName = "profile-b"
			viewB["viewLocalState"].apiConfiguration = pinnedElsewhere
			// The shared store holds whichever profile the other view activated last.
			providerSettingsSpy = vi.spyOn(viewB.contextProxy, "getProviderSettings").mockReturnValue(activated)

			const state = await viewB.getState({ includeTaskHistory: false })

			// Merging the shared settings under a complete overlay would hand profile-b's key
			// profile-a's endpoint, and the settings UI would persist that mix back.
			expect(state.apiConfiguration).toEqual(pinnedElsewhere)
			expect(state.apiConfiguration.openAiBaseUrl).toBeUndefined()
		})

		it("refreshes a sibling overlay when the profile is saved without activation", async () => {
			viewB["viewLocalState"].currentApiConfigName = "profile-a"
			const saved: ProfileFixture = { ...activated, zooSessionToken: "fresh-token" }

			await viewA.upsertProviderProfile("profile-a", saved, false)

			// A sign-in refresh writes the token to disk without activating; the pinned view must
			// not keep authenticating with the token cached in its overlay.
			expect(viewB["viewLocalState"].apiConfiguration).toEqual(saved)
		})

		it("refreshes the acting view's own overlay when it saves the pinned profile without activating", async () => {
			viewA["viewLocalState"] = {
				currentApiConfigName: "profile-a",
				apiConfiguration: { ...activated, zooSessionToken: "stale-token" },
			}
			const saved: ProfileFixture = { ...activated, zooSessionToken: "fresh-token" }

			await viewA.upsertProviderProfile("profile-a", saved, false)

			// A non-activating save clears nobody's overlay, so without the includeSelf
			// refresh this view keeps serving the token it just replaced on disk.
			expect(viewA["viewLocalState"].apiConfiguration).toEqual(saved)
			viewA["viewLocalState"] = {}
		})

		it("leaves the acting view's own pin alone when it saves a different profile", async () => {
			viewA["viewLocalState"] = { currentApiConfigName: "profile-b", apiConfiguration: pinnedElsewhere }
			const saved: ProfileFixture = { ...activated, zooSessionToken: "fresh-token" }

			await viewA.upsertProviderProfile("profile-a", saved, false)

			// profile-b is not the profile that changed, so its pinned settings must survive
			// rather than be overwritten with profile-a's.
			expect(viewA["viewLocalState"].apiConfiguration).toEqual(pinnedElsewhere)
			// The pin itself must survive too: a config object that still matches would hide
			// a view that had been re-pointed at the profile that changed.
			expect(viewA["viewLocalState"].currentApiConfigName).toBe("profile-b")
			viewA["viewLocalState"] = {}
		})

		it("still clears the acting view's overlay on the activation path", async () => {
			viewA["viewLocalState"] = {
				currentApiConfigName: "profile-a",
				apiConfiguration: { ...activated, apiKey: "stale-key" },
			}

			await viewA.upsertProviderProfile("profile-a", activated, true)

			// Activation writes the shared store and clears the overlay; includeSelf must not
			// turn that clear back into a refresh.
			expect(viewA["viewLocalState"].apiConfiguration).toBeUndefined()
			viewA["viewLocalState"] = {}
		})
	})

	describe("durable editor view state retention (#1065)", () => {
		it("should preserve persisted viewStates entry when an editor provider is disposed during teardown", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

	describe("shared setting and per-view pin are updated atomically", () => {
		it("restores the shared value when the per-view pin cannot be persisted", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-atomic")
			await provider.setValue("mode", "code")
			expect(provider.getValue("mode")).toBe("code")

			// The per-view pin write (the viewStates entry) fails; by then the shared write
			// has already landed.
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "viewStates") {
					throw new Error("pin persist failed")
				}
				return Promise.resolve()
			})

			await expect(provider.setValue("mode", "architect")).rejects.toThrow("pin persist failed")

			// Compensation: the shared value is back where it was and the view-local buffer
			// never moved, so the two stores still agree.
			expect(provider.getValue("mode")).toBe("code")
			expect(provider["viewLocalState"].mode).toBe("code")
		})

		it("restores every shared value a batch had written when its pin write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-batch")
			await provider.setValue("mode", "code")
			await provider.setValue("currentApiConfigName", "default")

			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "viewStates") {
					throw new Error("pin persist failed")
				}
				return Promise.resolve()
			})

			await expect(
				provider.setValues({ mode: "architect", currentApiConfigName: "profile-b" } as RooCodeSettings),
			).rejects.toThrow("pin persist failed")

			expect(provider.getValue("mode")).toBe("code")
			expect(provider.getValue("currentApiConfigName")).toBe("default")
		})
	})

	describe("profile activation and upsert compensate every durable write", () => {
		it("rolls back every durable write when the per-view pin write fails during an activating upsert", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-upsert-rollback")
			await provider.setValue("currentApiConfigName", "profile-a")

			const previousEntries = [
				{ name: "profile-a", id: "id-a" },
				{ name: "profile-b", id: "id-b" },
			]
			await provider.contextProxy.setValue("listApiConfigMeta", previousEntries)
			const previousSettings = { apiProvider: providerIdentifiers.openrouter, apiKey: "shared-a" }
			await provider.contextProxy.setProviderSettings(previousSettings)

			const manager = provider.providerSettingsManager
			const previousProfile = {
				id: "id-b",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "old-b",
				openAiBaseUrl: "https://old-b",
			}
			vi.spyOn(manager, "getProfile").mockResolvedValue({ name: "profile-b", ...previousProfile })
			vi.spyOn(manager, "getModeConfigId").mockResolvedValue("mode-id-a")
			const saveConfig = vi.spyOn(manager, "saveConfig").mockResolvedValue("id-b")
			const setModeConfig = vi.spyOn(manager, "setModeConfig").mockResolvedValue(undefined)
			vi.spyOn(manager, "listConfig").mockResolvedValue([
				{ name: "profile-a", id: "id-a" },
				{ name: "profile-b", id: "id-b" },
				{ name: "profile-c", id: "id-c" },
			])

			const settingsBeforeUpsert = provider.contextProxy.getProviderSettings()
			const setProviderSettings = vi.spyOn(provider.contextProxy, "setProviderSettings")

			// The shared provider settings fan out to several globalState keys, and the first of
			// them rejects after the profile record, the profile list, the mode mapping, and the
			// shared name had all landed. Later writes are let through so a transient storage
			// failure can be rolled back cleanly.
			let settingsWrites = 0
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "apiKey") {
					settingsWrites += 1
					if (settingsWrites === 1) {
						throw new Error("settings persist failed")
					}
				}
				return Promise.resolve()
			})

			await expect(
				provider.upsertProviderProfile(
					"profile-b",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-b", openAiBaseUrl: "https://new-b" },
					true,
				),
			).resolves.toBeUndefined()

			// Every store the upsert had committed is put back: the profile record, the profile
			// list, the mode mapping, the shared name, and the provider settings the fan-out had
			// already written.
			expect(saveConfig).toHaveBeenLastCalledWith("profile-b", previousProfile)
			expect(setModeConfig).toHaveBeenLastCalledWith("code", "mode-id-a")
			expect(provider.getValue("currentApiConfigName")).toBe("profile-a")
			expect(setProviderSettings).toHaveBeenLastCalledWith(settingsBeforeUpsert)
			expect(provider.contextProxy.getProviderSettings()).toEqual(settingsBeforeUpsert)
			expect(provider.contextProxy.getValue("listApiConfigMeta")).toEqual(previousEntries)
		})

		it("restores the profile list and the manager's current profile when an activation is rejected", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-activate-rollback")
			await provider.setValue("currentApiConfigName", "profile-a")

			const previousEntries = [
				{ name: "profile-a", id: "id-a" },
				{ name: "profile-b", id: "id-b" },
			]
			await provider.contextProxy.setValue("listApiConfigMeta", previousEntries)

			const manager = provider.providerSettingsManager
			vi.spyOn(manager, "getProfile").mockResolvedValue({
				name: "profile-b",
				id: "id-b",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "old-b",
			})
			vi.spyOn(manager, "getModeConfigId").mockResolvedValue("mode-id-a")
			const setModeConfig = vi.spyOn(manager, "setModeConfig").mockResolvedValue(undefined)
			const activateProfile = vi.spyOn(manager, "activateProfile").mockResolvedValue({
				name: "profile-b",
				id: "id-b",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "new-b",
			})
			vi.spyOn(manager, "listConfig").mockResolvedValue([
				{ name: "profile-a", id: "id-a" },
				{ name: "profile-b", id: "id-b" },
				{ name: "profile-c", id: "id-c" },
			])

			// The first per-view persist fails; the compensation writes that follow it are
			// allowed through so a transient storage failure can be rolled back cleanly.
			let failActivationPinWrite = true
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "viewStates" && failActivationPinWrite) {
					failActivationPinWrite = false
					throw new Error("pin persist failed")
				}
				return Promise.resolve()
			})

			await expect(provider.activateProviderProfile({ name: "profile-b" })).rejects.toThrow("pin persist failed")

			// The list write had landed with the third profile in it, and activateProfile had
			// already rewritten the manager's own current-profile record: both are put back, and
			// the mode mapping that never landed is left alone.
			expect(provider.contextProxy.getValue("listApiConfigMeta")).toEqual(previousEntries)
			expect(activateProfile).toHaveBeenLastCalledWith({ name: "profile-a" })
			expect(setModeConfig).not.toHaveBeenCalled()
		})

		it("restores the shared selection and the acting view pin separately when an activating upsert is rejected", async () => {
			// A sibling activation leaves the shared selection on one profile while this view stays
			// pinned to another. Restoring the shared name with setValue moves the pin with it, so the
			// view ends up reporting the shared profile next to its own settings - getState merges the
			// view-local state over the shared state.
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-split-rollback")
			await provider.setValue("currentApiConfigName", "profile-a")
			await provider.contextProxy.setValue("currentApiConfigName", "profile-b")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("profile-a")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("profile-b")

			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "profile-a", id: "id-a" },
				{ name: "profile-b", id: "id-b" },
			])

			const manager = provider.providerSettingsManager
			const previousProfile = {
				id: "id-b",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "old-b",
			}
			vi.spyOn(manager, "getProfile").mockResolvedValue({ name: "profile-b", ...previousProfile })
			vi.spyOn(manager, "getModeConfigId").mockResolvedValue("mode-id-a")
			vi.spyOn(manager, "saveConfig").mockResolvedValue("id-b")
			vi.spyOn(manager, "setModeConfig").mockResolvedValue(undefined)
			vi.spyOn(manager, "listConfig").mockResolvedValue([{ name: "profile-b", id: "id-b" }])

			// The shared provider settings fan out to several globalState keys and the first of them
			// rejects, after the profile record, the profile list, the mode mapping and the shared
			// name had all landed: the compensation runs with the selection already durable.
			let settingsWrites = 0
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "apiKey") {
					settingsWrites += 1
					if (settingsWrites === 1) {
						throw new Error("settings persist failed")
					}
				}
				return Promise.resolve()
			})

			await expect(
				provider.upsertProviderProfile(
					"profile-b",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-b" },
					true,
				),
			).resolves.toBeUndefined()

			// The shared selection returns to the shared pre-operation value and the view keeps the
			// pin it had, rather than inheriting the shared one.
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("profile-b")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("profile-a")
		})

		it("surfaces an explicit inconsistent-state error when the compensation itself fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("tab-inconsistent")
			await provider.setValue("currentApiConfigName", "profile-a")

			const manager = provider.providerSettingsManager
			vi.spyOn(manager, "getProfile").mockResolvedValue({
				name: "profile-b",
				id: "id-b",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "old-b",
			})

			// The first save lands; the compensation that puts the previous record back fails,
			// so the rollback is incomplete.
			vi.spyOn(manager, "saveConfig")
				.mockResolvedValueOnce("id-b")
				.mockRejectedValueOnce(new Error("record restore failed"))

			// Storage stays broken for every per-view persist.
			vi.mocked(mockContext.globalState.update).mockImplementation(async (key: string) => {
				if (key === "viewStates") {
					throw new Error("pin persist failed")
				}
				return Promise.resolve()
			})

			// Returning undefined here would read as "the save failed and nothing changed" while
			// the persisted stores disagree, so the inconsistency is surfaced instead.
			await expect(
				provider.upsertProviderProfile(
					"profile-b",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-b" },
					true,
				),
			).rejects.toThrow(
				/rollback was incomplete[\s\S]*record restore failed[\s\S]*Original failure: pin persist failed/,
			)
		})
	})

	describe("MCP initialization is disposal-aware", () => {
		it("does not attach or register a hub that resolves after the provider was disposed", async () => {
			// Typed double: ClineProvider only ever touches these three hub members, and the
			// real McpHub constructor starts server connections, so it cannot be built here.
			const registerClient = vi.fn()
			const unregisterClient = vi.fn()
			const hub = {
				registerClient,
				unregisterClient,
				getAllServers: vi.fn().mockReturnValue([]),
			} as unknown as McpHub
			let resolveHub: ((value: McpHub) => void) | undefined
			const pendingHub = new Promise<McpHub>((resolve) => {
				resolveHub = resolve
			})
			// Spied locally: this file's vi.mock specifiers for the MCP modules are off by one
			// directory, so the real manager is what ClineProvider imports here.
			const getInstanceSpy = vi.spyOn(McpServerManager, "getInstance").mockReturnValue(pendingHub)

			try {
				const provider = new ClineProvider(
					mockContext,
					mockOutputChannel,
					"editor",
					new ContextProxy(mockContext),
					new WebviewFocusTracker(),
				)

				// The hub is still pending, so nothing may be attached yet.
				expect(provider.getMcpHub()).toBeUndefined()

				await provider.dispose()

				// The hub lands after teardown, once the provider is already gone from
				// McpServerManager.providers: attaching it here would register a client that
				// nothing can ever unregister.
				resolveHub?.(hub)
				await new Promise((resolve) => setTimeout(resolve, 0))

				expect(registerClient).not.toHaveBeenCalled()
				expect(unregisterClient).not.toHaveBeenCalled()
				expect(provider.getMcpHub()).toBeUndefined()
			} finally {
				getInstanceSpy.mockRestore()
			}
		})
	})
})
