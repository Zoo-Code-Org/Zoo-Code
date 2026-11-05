// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.parallelMode.spec.ts

import * as vscode from "vscode"

import {
	type HistoryItem,
	type ProviderSettingsEntry,
	type ProviderSettingsWithId,
	PROVIDER_SETTINGS_KEYS,
	RooCodeEventName,
	type RooCodeSettings,
	providerIdentifiers,
} from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { ProviderSettingsNotFoundError } from "../../config/ProviderSettingsManager"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
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

		// Mirrors the real ContextProxy contract: every key in the state cache is
		// served as-is, so values written via setValue round-trip — including the
		// durable viewStates map that ClineProvider rewrites directly (a canned key
		// list here would let a stale-snapshot regression hide from every test).
		getValues = vi.fn().mockImplementation(() => ({
			...defaultState,
			...this.stateCache,
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

vi.mock("../../config/ProviderSettingsManager", async (importOriginal) => {
	// The real error class, not a double: the snapshot discriminates a pin naming a deleted
	// profile with `instanceof ProviderSettingsNotFoundError`. The original-module import can
	// hand back a partially initialized module for this chain, which would leave the export
	// undefined and make every production `instanceof` check throw, so declare a fallback the
	// production import resolves to.
	const actual = await importOriginal<typeof import("../../config/ProviderSettingsManager")>()

	class NotFoundFallback extends Error {
		constructor(message: string) {
			super(message)
			this.name = "ProviderSettingsNotFoundError"
		}
	}

	const ProviderSettingsNotFound = actual.ProviderSettingsNotFoundError ?? NotFoundFallback

	return {
		ProviderSettingsNotFoundError: ProviderSettingsNotFound,
		ProviderSettingsManager: vi.fn().mockImplementation(function () {
			// The real manager keeps a gate of its own in the secrets-backed profiles file: the profile
			// its store selects and the complete mode -> profile id mapping. This double carries the same
			// two values so a test can read what the store reports after a partial mutation, which is
			// what the delete compensation gates its own restore on.
			const gate: { currentApiConfigName: string; modeApiConfigs: Record<string, string | undefined> } = {
				currentApiConfigName: "default",
				modeApiConfigs: {},
			}
			return {
				// The profile writer joins the manager's cross-instance critical section around the store
				// write; this double runs the callback inline because no second view competes here.
				runExclusiveAcrossInstances: (cb: () => Promise<unknown>) => cb(),
				saveConfig: vi.fn().mockResolvedValue("test-id"),
				listConfig: vi.fn().mockResolvedValue([]),
				getProfile: vi.fn().mockResolvedValue({}),
				activateProfile: vi.fn().mockImplementation(async (args: { name?: string; id?: string }) => {
					const name = args.name ?? "default"
					gate.currentApiConfigName = name
					return {
						name,
						id: args.id ?? "test-id",
						apiProvider: providerIdentifiers.anthropic,
					}
				}),
				setModeConfig: vi.fn().mockImplementation(async (mode: string, configId: string | undefined) => {
					if (configId === undefined) {
						delete gate.modeApiConfigs[mode]
					} else {
						gate.modeApiConfigs[mode] = configId
					}
				}),
				getModeConfigId: vi.fn().mockImplementation(async (mode: string) => gate.modeApiConfigs[mode]),
				getSelectionAndModeConfigs: vi.fn().mockImplementation(async () => ({
					currentApiConfigName: gate.currentApiConfigName,
					modeApiConfigs: { ...gate.modeApiConfigs },
				})),
				resetAllConfigs: vi.fn().mockResolvedValue(undefined),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
				// The delete path classifies a rejected getProfile snapshot as absence with hasConfig; the
				// per-test spies below reject lookups for profiles the scenario does not carry, so
				// absence is what this double reports.
				hasConfig: vi.fn().mockResolvedValue(false),
			}
		}),
	}
})

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

		it("should drop malformed stored entries before pruning", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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

		it("should drop corrupt viewStates entries on read so subsequent writes do not reject", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			// Corrupt entries (null, or a torn non-object value) can land in the durable map:
			// they must be dropped at the read boundary, not throw in the prune sort when a
			// mode/profile write re-reads the map fresh.
			await mockContext.globalState.update("viewStates", {
				"view-null": null,
				"view-valid": { mode: "code", updatedAt: 1 },
			})

			await provider["setViewStateId"]("view-writer")
			await provider.saveViewState("mode", "architect")

			// One drop: the exact singular message (a substring assertion cannot tell
			// "entry" from "entries"), so the wording is pinned verbatim.
			expect(logSpy).toHaveBeenCalledWith("[getPersistedViewStates] dropped 1 invalid viewStates entry")

			// The first fresh read already removed the null entry, so seed two new corrupt
			// entries (a torn non-object value and a null) for the next fresh read.
			const states = mockContext.globalState.get("viewStates") as Record<string, unknown>
			// Write through the proxy so the provider's cache and the durable map stay
			// in step for the next fresh read.
			// Simulate a torn/corrupt durable write: the map type forbids such entries,
			// which is exactly what a torn write can leave behind (double assertion).
			await provider.contextProxy.setValue("viewStates", {
				...states,
				"view-torn": "torn-write",
				"view-null2": null,
			} as unknown as RooCodeSettings["viewStates"])
			await provider.saveViewState("mode", "build")

			// Two drops: the exact plural message must survive the second fresh read.
			expect(logSpy).toHaveBeenCalledWith("[getPersistedViewStates] dropped 2 invalid viewStates entries")

			const statesAfter = mockContext.globalState.get("viewStates") as Record<string, unknown>
			expect(statesAfter["view-null"]).toBeUndefined()
			expect(statesAfter["view-torn"]).toBeUndefined()
			expect(statesAfter["view-null2"]).toBeUndefined()
			expect(statesAfter["view-valid"]).toEqual({ mode: "code", updatedAt: 1 })
			expect(statesAfter["view-writer"]).toEqual({ mode: "build", updatedAt: expect.any(Number) })

			// A clean re-read must not log a drop: the log must stay tied to dropped > 0.
			await provider.saveViewState("mode", "debugger")
			expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("dropped 0"))

			// Release the provider from the static instance registry so later tests' cross-
			// instance broadcasts do not iterate a provider bound to this test's context.
			await provider.dispose()
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

	describe("profile mutations", () => {
		it("should synchronize viewLocalState when activateProviderProfile mutates ContextProxy", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "test-id", name: "saved-profile", apiProvider: providerIdentifiers.bedrock },
			])

			// The activation write is built from the stored record (saveConfig normalization
			// contract): repoint getProfile at what saveConfig wrote, mirroring the real
			// manager's round-trip.
			const savedRecords = new Map<string, Record<string, unknown>>()
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockImplementation(async (configName, config) => {
				savedRecords.set(configName, { name: configName, id: "test-id", ...config })
				return "test-id"
			})
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) => {
					const record = savedRecords.get(String(args.name))
					return (record ?? { name: args.name, id: "test-id" }) as unknown as Awaited<
						ReturnType<typeof provider.providerSettingsManager.getProfile>
					>
				},
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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

		it("should keep the re-pointed viewStates entry when the deleting view pins a surviving profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// This view pins a surviving profile (unrelated pin: the fallback branch),
			// while the shared selection names the profile about to be deleted.
			provider["viewLocalState"] = {
				currentApiConfigName: "keeper-profile",
			}
			await provider.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "doomed-id", name: "doomed-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "keeper-id", name: "keeper-profile", apiProvider: providerIdentifiers.openrouter },
			])
			// A sibling's durable pin names the deleted profile: the re-point pass runs
			// before the fallback's shared writes, and a stale full-snapshot replay would
			// undo it by rewriting the pre-re-point map back into the store.
			await mockContext.globalState.update("viewStates", {
				"view-deleted": { mode: "architect", currentApiConfigName: "doomed-profile", updatedAt: 2 },
			})
			// Pin the branch itself: a view following a shared selection that names the
			// deleted profile would take the activation path, so a pinned view must take
			// the fallback. The fallback resolves the survivor's settings through the
			// profile manager and writes them to the shared provider settings.
			const activateSpy = vi.spyOn(provider, "activateProviderProfile")
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(
				async (_args: { name?: string; id?: string }) =>
					({
						name: "keeper-profile",
						id: "keeper-id",
						apiProvider: providerIdentifiers.openrouter,
						openRouterApiKey: "keeper-key",
					}) as unknown as Awaited<ReturnType<typeof provider.providerSettingsManager.getProfile>>,
			)

			await provider.deleteProviderProfile({
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			})

			// The re-pointed sibling entry survives the fallback's targeted writes ...
			expect(mockContext.globalState.get("viewStates")).toMatchObject({
				"view-deleted": { mode: "architect", currentApiConfigName: "keeper-profile" },
			})
			// ... the shared selection moves to the replacement ...
			expect(mockContext.globalState.get("currentApiConfigName")).toBe("keeper-profile")
			// ... and this view's own pin is left untouched.
			expect(provider["viewLocalState"].currentApiConfigName).toBe("keeper-profile")
			// The view took the fallback, not the activation path ...
			expect(activateSpy).not.toHaveBeenCalled()
			// ... and the shared provider settings carry the survivor's configuration
			// instead of the deleted profile's.
			expect(provider.contextProxy.getProviderSettings()).toMatchObject({
				openRouterApiKey: "keeper-key",
			})

			await provider.dispose()
		})

		it("should not write viewStates when re-pointing skips a corrupt stored entry", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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

		it("should activate the replacement when the shared selection references the deleted profile and the view has no pin", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("currentApiConfigName", "deleted-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ id: "deleted-id", name: "deleted-profile", apiProvider: providerIdentifiers.anthropic },
				{ id: "replacement-id", name: "replacement-profile", apiProvider: providerIdentifiers.openrouter },
			])
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
			const activateSpy = vi.spyOn(provider, "activateProviderProfile")

			await provider.deleteProviderProfile({
				id: "deleted-id",
				name: "deleted-profile",
				apiProvider: providerIdentifiers.anthropic,
			})

			// The shared selection referenced the deleted profile, so the unpinned view takes
			// the activation path and adopts the replacement profile.
			expect(activateSpy).toHaveBeenCalledWith({ name: "replacement-profile" })
			expect(await provider.getState()).toMatchObject({ currentApiConfigName: "replacement-profile" })

			await provider.dispose()
		})

		it("should refresh the pinned view through activation when it pinned the deleted profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			// B has an active task built from the doomed profile's settings: the posted
			// state prefers the task's own apiConfiguration, so the re-pin must rebuild
			// the task's handler and re-point its sticky profile name too.
			const siblingTask = {
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "doomed-key" },
				taskApiConfigName: "doomed-profile",
				updateApiConfiguration: vi.fn(),
				setTaskApiConfigName: vi.fn(),
			}
			vi.spyOn(providerB, "getCurrentTask").mockReturnValue(
				siblingTask as unknown as ReturnType<typeof providerB.getCurrentTask>,
			)

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
						: // A profile the store no longer has fails with the manager's typed
							// ProviderSettingsNotFoundError (getProfile does exactly that), and the
							// sibling-overlay guard tolerates a pin naming such a profile because the
							// deletion re-points that view itself; a plain Error here reads as a store
							// failure and fails the whole deletion closed.
							Promise.reject(new ProviderSettingsNotFoundError(`profile ${String(args.name)} not found`)),
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
			// The active task's handler is rebuilt with the replacement's settings and
			// its sticky profile name re-points to the replacement: without this the
			// running conversation keeps sending the deleted profile's configuration.
			// objectContaining: the replacement's settings carry the profile id alongside
			// the provider fields (the name is stripped, the id is not).
			expect(siblingTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.openrouter,
					openRouterBaseUrl: "repl-url",
				}),
			)
			expect(siblingTask.setTaskApiConfigName).toHaveBeenCalledWith("replacement-profile")

			await providerA.dispose()
			await providerB.dispose()
		})

		// A4 regression: renaming a sibling's pin without the replacement's settings shows one
		// profile while the sibling's requests keep using the deleted profile's credentials.
		it("aborts the deletion when a live sibling's replacement settings cannot be resolved", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			// The replacement’s settings cannot be resolved. Re-pointing by name alone is what the
			// finding rejects, so the deletion fails closed and the compensation below runs.
			// Only the replacement’s settings are unresolvable. The doomed profile’s own record is
			// returned, so the pre-delete snapshot is a real record and the compensation below has
			// something to restore; a blanket rejection made the record restore unobservable - the
			// snapshot was classified absent and that leg never ran.
			const doomedRecord = {
				name: "doomed-profile",
				id: "doomed-id",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			}
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) => {
					if (args.name === "doomed-profile") {
						return doomedRecord as unknown as Awaited<
							ReturnType<typeof providerA.providerSettingsManager.getProfile>
						>
					}
					return Promise.reject(new Error("profile replacement-profile not found"))
				},
			)
			const saveConfigSpy = vi
				.spyOn(providerA.providerSettingsManager, "saveConfig")
				.mockResolvedValue("doomed-id")

			await expect(
				providerA.deleteProviderProfile({
					id: "doomed-id",
					name: "doomed-profile",
					apiProvider: providerIdentifiers.anthropic,
				}),
			).rejects.toThrow("Unable to resolve API profile 'replacement-profile'")

			// B is left whole: the deletion aborted, so its pin still names the profile it was
			// pinned to and the overlay under that pin carries that profile’s own settings.
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("doomed-profile")
			// With the doomed record readable, B keeps its own pin *and* its own settings: the overlay
			// carries the doomed profile’s credentials rather than the replacement’s. A sibling left
			// naming its old profile while serving the replacement’s provider and key is the
			// half-state this finding is about.
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject({
				id: "doomed-id",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			})
			// The committed manager delete is compensated: the shared profile list is restored
			// with the deleted profile back in it.
			expect(providerA.getProviderProfileEntries().map(({ name }) => name)).toContain("doomed-profile")
			// The list entry coming back is only half the restore: the secrets-backed record must come
			// back too, under its original id, or the restored entry names a profile whose settings
			// are gone. This is the leg the blanket rejection above used to skip.
			expect(saveConfigSpy).toHaveBeenCalledWith(
				"doomed-profile",
				expect.objectContaining({ id: "doomed-id", apiKey: "doomed-key" }),
			)
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Unable to resolve API profile 'replacement-profile'"),
			)

			await providerA.dispose()
			await providerB.dispose()
		})

		// A4 regression: the deletion's shared write must not leave a sibling pinned to a third
		// profile reporting that pin's name together with the replacement's settings.
		it("snapshots a sibling's own profile settings before rewriting shared settings on delete", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const keeperEntry: ProviderSettingsEntry = {
				id: "keeper-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const thirdEntry: ProviderSettingsEntry = {
				id: "third-id",
				name: "third-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const keeperSettings = { apiProvider: providerIdentifiers.openrouter, openRouterBaseUrl: "keeper-url" }
			const thirdSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "third-key" }

			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, keeperEntry, thirdEntry])
			// The doomed profile is the globally selected one, so the shared provider keys below
			// carry its settings until the deletion replaces them.
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			// A pins a third profile: a view pinned to the deleted profile or with no pin of its
			// own would have taken the activation branch instead.
			await providerA.saveViewState("currentApiConfigName", "third-profile")
			// B pins that same third profile and holds no API overlay of its own. saveViewState, not
			// setValue: setValue writes the shared store first and only then the view-local pin, so
			// this setup line would also move the shared selection onto the third profile. The
			// deletion below reads that shared value fresh; with one shared cache the snapshot branch
			// this test covers would stop running while the test still passed.
			await providerB.saveViewState("currentApiConfigName", "third-profile")

			vi.spyOn(providerA.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([keeperEntry, thirdEntry])
			const getProfile = async (args: { name?: string; id?: string }) => {
				if (args.name === "keeper-profile") {
					return { name: "keeper-profile", id: "keeper-id", ...keeperSettings } as unknown as Awaited<
						ReturnType<typeof providerA.providerSettingsManager.getProfile>
					>
				}
				if (args.name === "third-profile") {
					return { name: "third-profile", id: "third-id", ...thirdSettings } as unknown as Awaited<
						ReturnType<typeof providerA.providerSettingsManager.getProfile>
					>
				}
				return Promise.reject(new Error("profile doomed-profile not found"))
			}
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockImplementation(getProfile)
			vi.spyOn(providerB.providerSettingsManager, "getProfile").mockImplementation(getProfile)

			await providerA.deleteProviderProfile(doomedEntry)

			// The shared selection and shared provider keys moved onto the keeper, while B keeps
			// its own pin together with its own settings: without the pre-write snapshot B would
			// serve third-profile's name with keeper-profile's provider and credentials.
			expect(providerA.contextProxy.getValue("currentApiConfigName")).toBe("keeper-profile")
			expect(providerA.contextProxy.getProviderSettings()).toMatchObject(keeperSettings)
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("third-profile")
			expect(providerB["viewLocalState"].apiConfiguration).toMatchObject(thirdSettings)
			const siblingState = await providerB.getState()
			expect(siblingState.currentApiConfigName).toBe("third-profile")
			expect(siblingState.apiConfiguration).toMatchObject(thirdSettings)

			await providerA.dispose()
			await providerB.dispose()
		})

		// The manager owns a gate of its own - the profile its store selects and the mode -> profile
		// id mapping - and activating the replacement rewrites both. The restores for the record,
		// list, shared selection, shared settings and view pins cannot reach that gate, so this test
		// reads all three surfaces the compensation owns after the replacement activation landed.
		it("restores the manager selection and mode configs when a later delete write fails", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			// The double answers a name-only activation with "test-id", so the keeper entry carries
			// that same id: the id the activation writes into the mode mapping is then the id the
			// compensation compares the manager’s current report against.
			const keeperEntry: ProviderSettingsEntry = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const doomedRecord: ProviderSettingsWithId & { name: string } = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			}
			const keeperRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "keeper-url",
			}
			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, keeperEntry])
			// The doomed profile is the globally selected one, so the deletion activates the
			// replacement, and that activation is what moves the manager gate.
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")

			const manager = providerA.providerSettingsManager
			await manager.activateProfile({ name: "doomed-profile" })
			await manager.setModeConfig("code", "doomed-id")
			await manager.setModeConfig("architect", "doomed-id")
			// The ask mapping already names the id the replacement activation is about to write into
			// the mode mapping. Nothing this deletion does change ask, so the restore has to leave it
			// alone even though it points at the activated profile - only a mapping whose value this
			// deletion actually moved is a restore target.
			await manager.setModeConfig("ask", "test-id")
			const gateBefore = await manager.getSelectionAndModeConfigs()
			expect(gateBefore).toEqual({
				currentApiConfigName: "doomed-profile",
				modeApiConfigs: { architect: "doomed-id", ask: "test-id", code: "doomed-id" },
			})

			vi.spyOn(manager, "listConfig").mockResolvedValue([keeperEntry])
			vi.spyOn(manager, "getProfile").mockImplementation(async (args: { name?: string; id?: string }) =>
				args.name === "keeper-profile" ? keeperRecord : doomedRecord,
			)
			const saveConfigSpy = vi.spyOn(manager, "saveConfig").mockResolvedValue("doomed-id")
			// The activation commits its own gate writes first - the store selection, the shared
			// provider keys, and the mode mapping for the mode it activated into - and only then posts
			// state. Fail that post so the whole activation, gate included, had landed by the time
			// compensation starts. (The view is unpinned, so the deletion takes the activation path and
			// returns straight after it; this is the last write that path makes.)
			// The seeded gate writes would otherwise count against the assertions below.
			vi.mocked(manager.activateProfile).mockClear()
			vi.mocked(manager.setModeConfig).mockClear()

			vi.spyOn(providerA, "postStateToWebview").mockRejectedValueOnce(new Error("state post failed"))

			await expect(providerA.deleteProviderProfile(doomedEntry)).rejects.toThrow("state post failed")

			// Surface one: the secrets-backed record, back under its original id.
			expect(saveConfigSpy).toHaveBeenCalledWith(
				"doomed-profile",
				expect.objectContaining({ id: "doomed-id", apiKey: "doomed-key" }),
			)
			// Surfaces two and three: the store’s own selection and every mode mapping, each put
			// back through the manager’s own write paths - activateProfile for the selection,
			// setModeConfig for the mappings - so the gate ends exactly where it was before the
			// deletion moved it.
			expect(await manager.getSelectionAndModeConfigs()).toEqual(gateBefore)
			expect(manager.activateProfile).toHaveBeenLastCalledWith({ name: "doomed-profile" })

			// Surfaces three, second half: the mapping this deletion moved comes back through the
			// manager’s own write path, and the mapping it did not move is left untouched rather
			// than replayed just because it happens to name the activated profile.
			expect(manager.setModeConfig).toHaveBeenCalledWith("code", "doomed-id")
			expect(manager.setModeConfig).not.toHaveBeenCalledWith("ask", "test-id")

			await providerA.dispose()
		})

		// The manager gate restores only while the manager still reports what this deletion wrote. A
		// concurrent activation that lands between the replacement activation and the failure owns the
		// gate by then, so replaying the pre-delete selection over it would undo that newer work.
		it("leaves the manager gate alone when a concurrent activation moved it during the delete", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const keeperEntry: ProviderSettingsEntry = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const doomedRecord: ProviderSettingsWithId & { name: string } = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			}
			const keeperRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "keeper-url",
			}
			const laterRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "later-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "later-url",
			}
			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, keeperEntry])
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")

			const manager = providerA.providerSettingsManager
			await manager.activateProfile({ name: "doomed-profile" })
			await manager.setModeConfig("code", "doomed-id")
			await manager.setModeConfig("architect", "doomed-id")
			const gateBefore = await manager.getSelectionAndModeConfigs()
			expect(gateBefore).toEqual({
				currentApiConfigName: "doomed-profile",
				modeApiConfigs: { architect: "doomed-id", code: "doomed-id" },
			})
			// The seeded gate writes above are not part of the deletion under test, so the manager spy
			// history starts here: the assertions below are about the writes the deletion and its
			// compensation make, not about the setup that seeded the gate.
			vi.mocked(manager.activateProfile).mockClear()
			vi.mocked(manager.setModeConfig).mockClear()
			vi.mocked(manager.getSelectionAndModeConfigs).mockClear()
			const gateAfterConcurrentActivation = {
				currentApiConfigName: "later-profile",
				modeApiConfigs: { architect: "later-id", code: "later-id" },
			}

			vi.spyOn(manager, "listConfig").mockResolvedValue([keeperEntry])
			const saveConfigSpy = vi.spyOn(manager, "saveConfig").mockResolvedValue("doomed-id")
			vi.spyOn(manager, "getProfile").mockImplementation(async (args: { name?: string; id?: string }) => {
				if (args.name === "keeper-profile") {
					return keeperRecord
				}
				if (args.name === "later-profile") {
					return laterRecord
				}
				return doomedRecord
			})
			const setModeConfigSpy = vi.spyOn(manager, "setModeConfig")
			// The replacement activation lands on the gate, and then this view's own post fails. The
			// post doubles as the window where a sibling activation lands on the same manager: it points
			// the gate at a third profile (a different id, so the mode gate has something to compare
			// against) and only then rejects, which is the order a concurrent write really has.
			const postSpy = vi.spyOn(providerA, "postStateToWebview").mockImplementationOnce(async () => {
				await manager.activateProfile({ id: "later-id", name: "later-profile" })
				await manager.setModeConfig("architect", "later-id")
				await manager.setModeConfig("code", "later-id")
				throw new Error("state post failed")
			})
			const logSpy = vi.spyOn(providerA, "log")

			await expect(providerA.deleteProviderProfile(doomedEntry)).rejects.toThrow("state post failed")
			expect(postSpy).toHaveBeenCalledOnce()

			// The record and the list come back - the deletion committed them - but the gate keeps the
			// concurrent owner's selection and mappings: replaying this deletion's pre-delete values over
			// them would silently revert a write the deletion never made.
			expect(saveConfigSpy).toHaveBeenCalledWith(
				"doomed-profile",
				expect.objectContaining({ id: "doomed-id", apiKey: "doomed-key" }),
			)
			expect(providerA.getProviderProfileEntries().map(({ name }) => name)).toContain("doomed-profile")
			expect(await manager.getSelectionAndModeConfigs()).toEqual(gateAfterConcurrentActivation)
			expect(manager.activateProfile).not.toHaveBeenCalledWith({ name: "doomed-profile" })
			expect(setModeConfigSpy).not.toHaveBeenCalledWith("code", "doomed-id")
			expect(setModeConfigSpy).not.toHaveBeenCalledWith("architect", "doomed-id")
			expect(logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("failed to restore the manager selection and mode configs"),
			)

			await providerA.dispose()
		})

		// Restoring the manager gate is best effort, like every other restore in this compensation: a
		// manager that cannot be read must not stop the shared selection, the shared provider settings,
		// the profile list or the view pin from being put back, and the caller still sees the deletion
		// own failure.
		it("keeps the other restores running when the manager gate cannot be read back", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const ghostEntry: ProviderSettingsEntry = {
				id: "test-id",
				name: "ghost-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const doomedSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "doomed-key" }
			const ghostSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "ghost-key" }
			const doomedRecord: ProviderSettingsWithId & { name: string } = {
				id: "doomed-id",
				name: "doomed-profile",
				...doomedSettings,
			}
			const ghostRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "ghost-profile",
				...ghostSettings,
			}
			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, ghostEntry])
			await providerA.contextProxy.setValue("modeApiConfigs", { architect: "doomed-id", code: "doomed-id" })
			await providerA.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			await providerA.contextProxy.setProviderSettings(doomedSettings)
			await providerA.saveViewState("currentApiConfigName", "doomed-profile")
			providerA["viewLocalState"] = {
				mode: "code",
				currentApiConfigName: "doomed-profile",
				apiConfiguration: doomedSettings,
			}

			const manager = providerA.providerSettingsManager
			vi.spyOn(manager, "listConfig").mockResolvedValue([ghostEntry])
			vi.spyOn(manager, "getProfile").mockImplementation(async (args: { name?: string; id?: string }) =>
				args.name === "ghost-profile" ? ghostRecord : doomedRecord,
			)
			// The pre-delete snapshot read succeeds; the read that opens the compensation is the one
			// that fails, so the gate restores cannot even be attempted.
			let gateReads = 0
			const gateReadSpy = vi.spyOn(manager, "getSelectionAndModeConfigs").mockImplementation(async () => {
				gateReads++
				if (gateReads === 2) {
					throw new Error("gate read failed")
				}
				return {
					currentApiConfigName: "doomed-profile",
					modeApiConfigs: { architect: "doomed-id", code: "doomed-id" },
				}
			})
			const setValueSpy = vi.spyOn(providerA.contextProxy, "setValue")
			const setProviderSettingsSpy = vi.spyOn(providerA.contextProxy, "setProviderSettings")
			const logSpy = vi.spyOn(providerA, "log")
			// The view pins the doomed profile, so the deletion takes the activation branch, and that
			// activation last write is the one that fails - the point at which the compensation runs.
			vi.spyOn(providerA, "postStateToWebview").mockRejectedValueOnce(new Error("state post failed"))

			await expect(providerA.deleteProviderProfile(doomedEntry)).rejects.toThrow("state post failed")

			expect(gateReadSpy).toHaveBeenCalledTimes(2)
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("failed to restore the manager selection and mode configs: gate read failed"),
			)
			expect(manager.activateProfile).not.toHaveBeenCalledWith({ name: "doomed-profile" })
			// The restores behind the gate are independent of it: the deleted record comes back, the
			// shared metadata, selection and provider settings are put back, and this view pin is merged
			// back onto the deleted profile rather than left on the replacement.
			expect(setValueSpy).toHaveBeenCalledWith("currentApiConfigName", "doomed-profile")
			expect(setValueSpy).toHaveBeenCalledWith(
				"listApiConfigMeta",
				expect.arrayContaining([ghostEntry, doomedEntry]),
			)
			expect(setProviderSettingsSpy).toHaveBeenCalledWith(doomedSettings)
			// The pin restore is a durable merge, not an in-memory rewrite: the entry this view pinned
			// before the deletion is back on the deleted profile, while the live overlay of the view that
			// ran the activation keeps the replacement it activated into.
			const durablePins = mockContext.globalState.get("viewStates") as Record<
				string,
				{ currentApiConfigName?: string } | undefined
			>
			expect(Object.values(durablePins).some((pin) => pin?.currentApiConfigName === "doomed-profile")).toBe(true)

			await providerA.dispose()
		})

		// The deletion activates whatever the shared selection names, even a profile the durable list
		// does not carry - a stale selection is possible when another instance pruned a profile. The
		// pre-delete gate snapshot reads that target back out of the pre-delete entries, so it has to
		// tolerate the target being absent instead of assuming an id is there.
		it("completes the deletion when the shared selection names a profile the list does not carry", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const keeperEntry: ProviderSettingsEntry = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const doomedRecord: ProviderSettingsWithId & { name: string } = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			}
			const ghostRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "ghost-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "ghost-url",
			}
			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, keeperEntry])
			// A selection the durable list does not name, and not the deleted profile, so it becomes the
			// activation target as-is and the snapshot lookup for it comes up empty.
			await providerA.contextProxy.setValue("currentApiConfigName", "ghost-profile")

			const manager = providerA.providerSettingsManager
			vi.spyOn(manager, "listConfig").mockResolvedValue([keeperEntry])
			vi.spyOn(manager, "getProfile").mockImplementation(async (args: { name?: string; id?: string }) =>
				args.name === "ghost-profile" ? ghostRecord : doomedRecord,
			)
			vi.spyOn(manager, "deleteConfig").mockResolvedValue(undefined)
			const gateBefore = await manager.getSelectionAndModeConfigs()

			await providerA.deleteProviderProfile(doomedEntry)

			// The deletion completes and hands the manager the selection it was told to activate.
			expect(manager.activateProfile).toHaveBeenLastCalledWith({ name: "ghost-profile" })
			expect(await manager.getSelectionAndModeConfigs()).toEqual({
				currentApiConfigName: "ghost-profile",
				modeApiConfigs: { code: "test-id" },
			})
			// The snapshot the compensation would restore from is the pre-delete gate, and reading it
			// alongside an absent activation target is the case that must not throw.
			expect(gateBefore).toEqual({ currentApiConfigName: "default", modeApiConfigs: {} })
			expect(providerA.getProviderProfileEntries().map(({ name }) => name)).toEqual(["keeper-profile"])

			await providerA.dispose()
		})

		// Two of the three manager-gate guards are about ownership rather than values: the gate is
		// restored only while this deletion owns it. Here the manager already selected the profile
		// the deletion goes on to activate, and the one mapping that changed between the snapshot
		// and the failure was cleared by somebody else, so neither half of the gate is this
		// deletion’s write to undo.
		it("leaves the manager gate alone when it already selected the profile the deletion activates", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const doomedEntry: ProviderSettingsEntry = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
			}
			const keeperEntry: ProviderSettingsEntry = {
				id: "test-id",
				name: "keeper-profile",
				apiProvider: providerIdentifiers.openrouter,
			}
			const doomedRecord: ProviderSettingsWithId & { name: string } = {
				id: "doomed-id",
				name: "doomed-profile",
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "doomed-key",
			}
			const ghostRecord: ProviderSettingsWithId & { name: string } = {
				id: "test-id",
				name: "ghost-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterBaseUrl: "ghost-url",
			}
			await providerA.contextProxy.setValue("listApiConfigMeta", [doomedEntry, keeperEntry])
			// The shared selection names a profile the durable entry list does not carry, so the
			// deletion activates that profile and finds no pre-delete entry to read an id from.
			await providerA.contextProxy.setValue("currentApiConfigName", "ghost-profile")
			const manager = providerA.providerSettingsManager
			// The manager already points at the very profile this deletion will activate, and it
			// maps architect onto the doomed profile.
			await manager.activateProfile({ name: "ghost-profile" })
			await manager.setModeConfig("architect", "doomed-id")
			const gateBefore = await manager.getSelectionAndModeConfigs()
			expect(gateBefore).toEqual({
				currentApiConfigName: "ghost-profile",
				modeApiConfigs: { architect: "doomed-id" },
			})
			vi.spyOn(manager, "listConfig").mockResolvedValue([keeperEntry])
			vi.spyOn(manager, "getProfile").mockImplementation(async (args: { name?: string; id?: string }) =>
				args.name === "doomed-profile" ? doomedRecord : ghostRecord,
			)
			const saveConfigSpy = vi.spyOn(manager, "saveConfig").mockResolvedValue("doomed-id")
			vi.spyOn(manager, "deleteConfig").mockResolvedValue(undefined)
			const logSpy = vi.spyOn(providerA, "log")
			// The seeded gate writes would otherwise count against the assertions below.
			vi.mocked(manager.activateProfile).mockClear()
			vi.mocked(manager.setModeConfig).mockClear()
			// The activation commits its own gate writes; before its last write an unrelated mutation
			// clears the architect mapping, and that last write then fails, so compensation starts
			// with a gate whose selection this deletion never moved and whose changed mapping it did
			// not make.
			vi.spyOn(providerA, "postStateToWebview").mockImplementationOnce(async () => {
				await manager.setModeConfig("architect", undefined)
				throw new Error("state post failed")
			})
			await expect(providerA.deleteProviderProfile(doomedEntry)).rejects.toThrow("state post failed")
			// The record restore is untouched by any of this.
			expect(saveConfigSpy).toHaveBeenCalledWith(
				"doomed-profile",
				expect.objectContaining({ id: "doomed-id", apiKey: "doomed-key" }),
			)
			// The selection half stays where the activation put it, and activateProfile ran once -
			// the activation itself - instead of a second time with the snapshot value.
			expect(manager.activateProfile).toHaveBeenCalledTimes(1)
			expect(manager.activateProfile).toHaveBeenLastCalledWith({ name: "ghost-profile" })
			// The mapping half is left alone too: architect was cleared by the other mutation, and
			// with no pre-delete entry for the activated profile there is nothing that identifies any
			// mapping as this deletion’s write to replay.
			expect(manager.setModeConfig).not.toHaveBeenCalledWith("architect", "doomed-id")
			expect(await manager.getSelectionAndModeConfigs()).toEqual({
				currentApiConfigName: "ghost-profile",
				modeApiConfigs: { code: "test-id" },
			})
			expect(logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("failed to restore the manager selection and mode configs"),
			)
			await providerA.dispose()
		})
	})

	describe("provider profile activation", () => {
		it("should serve the activated profile settings through getState when activating an upserted profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			// Repoint the manager round-trip: the activation write reads the stored
			// record back after saveConfig (normalization contract), so getProfile must
			// serve what saveConfig wrote.
			const savedRecords = new Map<string, Record<string, unknown>>()
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockImplementation(async (configName, config) => {
				savedRecords.set(configName, { name: configName, id: "zai-profile-id", ...config })
				return "zai-profile-id"
			})
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(
				async (args: { name?: string; id?: string }) => {
					const record = savedRecords.get(String(args.name))
					return (record ?? { name: args.name, id: "zai-profile-id" }) as unknown as Awaited<
						ReturnType<typeof provider.providerSettingsManager.getProfile>
					>
				},
			)
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
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
				new WebviewFocusTracker(),
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
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

		it("should abort the shared settings write when a sibling's pin cannot be resolved", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			// The sibling's pin cannot be resolved, so no overlay can shield it from the write.
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockRejectedValue(
				new Error("profile store unavailable"),
			)
			const setSharedSettingsSpy = vi.spyOn(providerA.contextProxy, "setProviderSettings")

			// The activation must fail instead of writing the shared store: B would otherwise
			// report pin "profile-y" with profile-x's settings and start tasks on them.
			await expect(providerA.activateProviderProfile({ name: "profile-x" })).rejects.toThrow(
				/pinned profile\(s\) could not be resolved: profile-y/,
			)

			expect(setSharedSettingsSpy).not.toHaveBeenCalled()
			expect(providerA.contextProxy.getValue("currentApiConfigName")).not.toBe("profile-x")
			// B keeps its own pin and no overlay: unchanged from before the aborted write.
			expect(providerB["viewLocalState"].currentApiConfigName).toBe("profile-y")
			expect(providerB["viewLocalState"].apiConfiguration).toBeUndefined()

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should still write the shared store when a sibling pins a deleted profile", async () => {
			const providerA = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await providerB.setValue("currentApiConfigName", "deleted-profile")

			vi.spyOn(providerA.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-x",
				id: "x-id",
				apiProvider: providerIdentifiers.anthropic,
				anthropicBaseUrl: "x-url",
			} as unknown as Awaited<ReturnType<typeof providerA.providerSettingsManager.getProfile>>)
			vi.spyOn(providerA.providerSettingsManager, "listConfig").mockResolvedValue([
				{ id: "x-id", name: "profile-x", apiProvider: providerIdentifiers.anthropic },
			])
			// The sibling pins a profile the store no longer has: the deletion path re-points
			// that view itself, so this activation must not be blocked by one stale pin.
			vi.spyOn(providerA.providerSettingsManager, "getProfile").mockRejectedValue(
				new ProviderSettingsNotFoundError("Config 'deleted-profile' not found"),
			)
			const setSharedSettingsSpy = vi.spyOn(providerA.contextProxy, "setProviderSettings")

			await expect(providerA.activateProviderProfile({ name: "profile-x" })).resolves.not.toThrow()

			// The shared write proceeded, so the activation is not hostage to the stale pin.
			expect(setSharedSettingsSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					anthropicBaseUrl: "x-url",
				}),
			)
			expect(providerA.contextProxy.getValue("currentApiConfigName")).toBe("profile-x")

			await providerA.dispose()
			await providerB.dispose()
		})

		it("should drop the view-local overlay when flat provider settings are written through setValues", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const getModeConfigIdSpy = vi.spyOn(provider.providerSettingsManager, "getModeConfigId")

			await provider.resolveWebviewView(createMockWebviewView(postMessage))
			postMessage.mockClear()

			await provider.handleModeSwitch("architect")

			expect(getModeConfigIdSpy).not.toHaveBeenCalled()
			// The locked path still posts the switched state — assert the payload so a
			// regression that posts nothing (or a stale pre-switch state) fails here.
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state",
					state: expect.objectContaining({ mode: "architect" }),
				}),
			)

			await provider.dispose()
		})

		it("should activate configured mode profile when switching modes", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const modeChangedSpy = vi.fn()

			provider.on(RooCodeEventName.ModeChanged, modeChangedSpy)

			await provider.handleModeSwitch("architect")

			expect(modeChangedSpy).toHaveBeenCalledWith("architect")

			await provider.dispose()
		})

		// A4 regression: non-focused target task
		it("should scope mode switches for non-focused tasks to the task only", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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

		// A4 regression: the history write runs before the TaskModeSwitched emit, so a listener
		// that throws on that emit must not leave the persisted item on the new mode.
		it("should roll task history back when a TaskModeSwitched listener throws", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["resolveWebviewView"](createMockWebviewView())
			const task = {
				taskId: "emit-throw-task",
				_taskMode: "code",
				// The mode-switch emit is the reachable thrower here: it runs on the mode that the
				// history write above already persisted. addClineToStack emits on the same task, so
				// only the mode-switch event throws.
				emit: vi.fn((event: RooCodeEventName) => {
					if (event === RooCodeEventName.TaskModeSwitched) {
						throw new Error("TaskModeSwitched listener down")
					}
				}),
				saveClineMessages: vi.fn().mockResolvedValue(undefined),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}
			// Minimal Task double: handleModeSwitch only touches the fields above.
			await provider.addClineToStack(task as unknown as Task)
			await provider["setViewStateId"]("emit-throw-view")
			await provider.saveViewState("mode", "code")
			const seedItem: HistoryItem = {
				id: "emit-throw-task",
				number: 1,
				ts: 1,
				task: "seed prompt",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
			}
			// Double assertion: getTaskHistoryItem is private and has no typed accessor, and the
			// seeded item is what makes the history write land before the throw. The spy is taken
			// on this instance rather than the prototype so it cannot leak into a later test.
			const historyApi = provider as unknown as {
				getTaskHistoryItem: (id: string) => HistoryItem | undefined
			}
			const historySpy = vi.spyOn(historyApi, "getTaskHistoryItem").mockReturnValue(seedItem)
			const updateSpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([seedItem])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])

			await expect(provider.handleModeSwitch("architect", task as unknown as Task)).rejects.toThrow(
				"TaskModeSwitched listener down",
			)

			// The switch wrote architect into history first and then undid it: the last write
			// carries the pre-switch mode, so history cannot keep a mode the task never took.
			expect(updateSpy).toHaveBeenCalledTimes(2)
			expect(updateSpy.mock.calls[0][0]).toMatchObject({ mode: "architect" })
			expect(updateSpy.mock.calls[1][0]).toMatchObject({ mode: "code" })
			// The in-memory task mode was never moved: the emit threw before that write.
			expect(task._taskMode).toBe("code")

			updateSpy.mockRestore()
			historySpy.mockRestore()
			await provider.dispose()
		})

		it("should log and no-op when handleModeSwitch receives an unknown mode slug", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["resolveWebviewView"](createMockWebviewView())
			const logSpy = vi.spyOn(provider, "log")

			await provider.handleModeSwitch("bogus-slug")

			// Unknown slugs are rejected before any durable write: nothing is persisted under
			// the view and no profile mutation is queued.
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unknown mode "bogus-slug"'))
			expect(mockContext.globalState.get("viewStates")).toBeUndefined()

			await provider.dispose()
		})

		it("should ignore a custom mode deleted while the switch waits for the mutation queue", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["resolveWebviewView"](createMockWebviewView())
			await provider["setViewStateId"]("deleted-mode-view")
			await provider.setValue("mode", "code")
			const logSpy = vi.spyOn(provider, "log")

			// The file-level getModeBySlug mock ignores its customModes argument (and returns
			// null for unknown slugs), so make the lookup custom-mode aware for this test.
			const modesModule = vi.mocked(await import("../../../shared/modes"))
			const originalGetModeBySlug = modesModule.getModeBySlug.getMockImplementation()
			type TestMode = { slug: string; name: string; roleDefinition: string; groups: string[] }
			let customModes: TestMode[] = [
				{ slug: "ephemeral-mode", name: "Ephemeral Mode", roleDefinition: "Test Role", groups: [] },
			]
			modesModule.getModeBySlug.mockImplementation(
				((slug: string, custom?: TestMode[]) =>
					custom?.find((mode) => mode.slug === slug) ??
					modesModule.modes.find((mode) => mode.slug === slug) ??
					null) as typeof modesModule.getModeBySlug,
			)
			const getCustomModesSpy = vi
				.spyOn(provider.customModesManager, "getCustomModes")
				.mockImplementation(async () => customModes as never)

			try {
				// Hold the queue so the switch is queued while the mode is still present.
				let releaseQueue!: () => void
				const queueGate = new Promise<void>((resolve) => {
					releaseQueue = resolve
				})
				const queueHolder = provider["enqueueProviderProfileMutation"](
					async () => {
						await queueGate
					},
					{ runToCompletion: true },
				)

				const switchRun = provider.handleModeSwitch("ephemeral-mode", null)

				// The mode is deleted while the switch is still waiting for the queue: the re-read
				// inside the queued callback is what notices, a pre-queue check cannot.
				customModes = []
				releaseQueue()
				await queueHolder
				await switchRun

				expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring unknown mode "ephemeral-mode"'))
				// Nothing was pinned or written for the deleted slug.
				expect(provider["viewLocalState"].mode).toBe("code")
				expect(provider.getValue("mode")).toBe("code")
			} finally {
				getCustomModesSpy.mockRestore()

				if (originalGetModeBySlug) {
					modesModule.getModeBySlug.mockImplementation(originalGetModeBySlug)
				}
			}

			await provider.dispose()
		})

		it("should route a custom-mode deletion through the mutation queue", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["resolveWebviewView"](createMockWebviewView())
			// The CustomModesManager double in this file has no deleteCustomMode member, so it is
			// installed on the instance instead of spied.
			const deleteSpy = vi.fn().mockResolvedValue(undefined)
			Object.assign(provider.customModesManager, { deleteCustomMode: deleteSpy })

			// Hold the queue: a deletion that bypasses it would run here, while a queued
			// mode switch is still pending.
			let releaseQueue!: () => void
			const queueGate = new Promise<void>((resolve) => {
				releaseQueue = resolve
			})
			const queueHolder = provider["enqueueProviderProfileMutation"](
				async () => {
					await queueGate
				},
				{ runToCompletion: true },
			)

			const deletion = provider.deleteCustomMode("ephemeral-mode")
			await Promise.resolve()
			expect(deleteSpy).not.toHaveBeenCalled()

			releaseQueue()
			await queueHolder
			await deletion
			expect(deleteSpy).toHaveBeenCalledWith("ephemeral-mode")

			await provider.dispose()
		})

		// K1: a no-task switch captures its target before any task is focused; a task gains
		// focus before the queued mutation runs. The view-level durable write and the
		// ModeChanged broadcast belong to the view and must still happen.
		it("should keep the view-level effects when a no-task switch is captured before a task gains focus", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// The shared store already carries a mode, so the rollback has a concrete value
			// to restore.
			await provider.contextProxy.setValue("mode", "code")
			// The mock mirrors the double's setValue and fails only at the durable flush, after the
			// state cache and the store both hold the new value: that is the half-applied shape the
			// shared restore compensates (a key the failed write never landed is left alone). Only
			// the fresh mode write fails; the rollback write succeeds. Delegating to the double's own
			// setValue instead would recurse, because spying on an existing mock reuses it.
			// Double assertion: the proxy double keeps its state cache in a private field, and the
			// failure has to land after that write.
			const stateCache = provider.contextProxy["stateCache"] as unknown as Record<string, unknown>
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue").mockImplementation(async (key, value) => {
				if (value === undefined || value === null) {
					delete stateCache[key]
				} else {
					stateCache[key] = value
				}
				await mockContext.globalState.update(key, value)
				if (key === "mode" && value !== "code") {
					throw new Error("durable write failed")
				}
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

			setValueSpy.mockRestore()
			await provider.dispose()
		})

		it("should log the rollback failure and rethrow the original error when the rollback also fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("mode", "code")
			const appendLine = vi.spyOn(mockOutputChannel, "appendLine")
			const durableError = new Error("durable write failed")
			// Same shape as the test above - the value lands in the cache and the store, and the
			// durable flush fails - except that every mode write fails here, the rollback's own
			// attempt included. Only a shared value of ours can need a rollback, and only a failing
			// rollback can need logging.
			const stateCache = provider.contextProxy["stateCache"] as unknown as Record<string, unknown>
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue").mockImplementation(async (key, value) => {
				if (value === undefined || value === null) {
					delete stateCache[key]
				} else {
					stateCache[key] = value
				}
				await mockContext.globalState.update(key, value)
				if (key === "mode") {
					throw durableError
				}
			})

			await expect(provider.handleModeSwitch("ask")).rejects.toThrow("durable write failed")

			// The rollback failure is logged with its own message and the original error
			// still propagates: a failed switch must not be swallowed into a logged no-op.
			// The shared restore now runs inside setValue's own compensation (the
			// reconcile skips it once the setter already compensated), so the failure
			// surfaces under the setter's rollback log.
			expect(appendLine).toHaveBeenCalledWith(expect.stringContaining("Shared-state rollback after failed"))
			expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Failed to persist mode "ask"'))

			setValueSpy.mockRestore()
			appendLine.mockRestore()
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
				new WebviewFocusTracker(),
			)
			const provider2 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const provider3 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
				new WebviewFocusTracker(),
			)
			const provider2 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

		it("should keep resetting siblings when one sibling's state post fails", async () => {
			vi.mocked(vscode.window.showInformationMessage).mockImplementationOnce(
				async (_message: string, _options: unknown, ...items: vscode.MessageItem[]) => items[0],
			)
			const caller = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const failingSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const laterSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await caller.resolveWebviewView(createMockWebviewView())
			await laterSibling.resolveWebviewView(createMockWebviewView())
			await failingSibling.saveViewState("mode", "architect")
			await laterSibling.saveViewState("mode", "debugger")
			// State generation throws for the failing sibling mid-reset (e.g. through a
			// settings-file write in customModesManager.getCustomModes): the broadcast must
			// still reach the later sibling instead of aborting.
			vi.spyOn(failingSibling, "postStateToWebview").mockRejectedValue(new Error("state generation failed"))
			const logSpy = vi.spyOn(caller, "log")

			await caller.resetState()

			// The failing sibling's buffer was cleared before its post failed ...
			expect(failingSibling["viewLocalState"]).toEqual({})
			// ... the broadcast continued to the later sibling and cleared it too ...
			expect(laterSibling["viewLocalState"]).toEqual({})
			// ... and the failure was logged by the caller.
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("failed to post reset state to a sibling view"))

			await caller.dispose()
			await failingSibling.dispose()
			await laterSibling.dispose()
		})

		it("clears the buffer of a first-constructed saving provider after a queued reset", async () => {
			// The saver is constructed first so the broadcast reaches its buffer before the
			// caller does: with the clear queued behind the in-flight save, the buffer must
			// still end empty and the durable map cleared even though the save writes its
			// captured pin back into the buffer when its durable write completes.
			const saver = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const caller = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await saver.resolveWebviewView(createMockWebviewView())
			await caller.resolveWebviewView(createMockWebviewView())

			let resolveWrite: (value: undefined) => void = () => {}
			const writeGate = new Promise<undefined>((resolve) => (resolveWrite = resolve))
			// The proxy's setValue is already a vi.fn: vi.spyOn on it would return the same
			// function, so a delegating spy would recurse into itself. Wrap the mock's
			// existing implementation instead: gate the non-clear write, then delegate to
			// the original store write so the stalled save still reaches storage.
			const setValueMock = vi.mocked(saver.contextProxy.setValue)
			const originalSetValueImplementation = setValueMock.getMockImplementation()
			setValueMock.mockImplementation(async (key, value): Promise<void> => {
				if (key === "viewStates" && value !== undefined) {
					await writeGate
				}
				await originalSetValueImplementation?.(key, value)
			})
			const setValueSpy = setValueMock

			const save = saver.saveViewState("mode", "architect")
			await vi.waitFor(() => expect(setValueSpy).toHaveBeenCalledWith("viewStates", expect.anything()))

			const broadcast = caller.broadcastResetToAllInstances()

			resolveWrite(undefined)
			await save
			await broadcast

			expect(mockContext.globalState.get("viewStates")).toBeUndefined()
			expect(saver["viewLocalState"]).toEqual({})

			await caller.dispose()
			await saver.dispose()
		})

		it("should order the broadcast clear after an in-flight view-state save", async () => {
			const caller = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const saver = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await caller.resolveWebviewView(createMockWebviewView())
			await saver.resolveWebviewView(createMockWebviewView())

			// Stall the saver's durable write so the broadcast's clear lands while it is
			// still in the serialized write queue: a direct (un-queued) clear would let
			// the save run after the clear and re-create its captured per-view pin. The
			// stalled write still reaches storage once the gate opens, so the storage
			// assertion below only passes if the clear actually ran after the save.
			let resolveWrite: (value: undefined) => void = () => {}
			const writeGate = new Promise<undefined>((resolve) => (resolveWrite = resolve))
			// The proxy's setValue is already a vi.fn: vi.spyOn on it would return the same
			// function, so a delegating spy would recurse into itself. Wrap the mock's
			// existing implementation instead: gate the non-clear write, then delegate to
			// the original store write so the stalled save still reaches storage.
			const setValueMock = vi.mocked(saver.contextProxy.setValue)
			const originalSetValueImplementation = setValueMock.getMockImplementation()
			setValueMock.mockImplementation(async (key, value): Promise<void> => {
				if (key === "viewStates" && value !== undefined) {
					await writeGate
				}
				await originalSetValueImplementation?.(key, value)
			})
			const setValueSpy = setValueMock

			const save = saver.saveViewState("mode", "architect")
			await vi.waitFor(() => expect(setValueSpy).toHaveBeenCalledWith("viewStates", expect.anything()))

			const broadcast = caller.broadcastResetToAllInstances()

			// The clear is queued behind the in-flight save, so the broadcast only settles
			// once the stalled write completes.
			resolveWrite(undefined)
			await save
			await broadcast

			// The clear won: the save's captured pin was not resurrected after the reset.
			expect(mockContext.globalState.get("viewStates")).toBeUndefined()
			expect(saver["viewLocalState"]).toEqual({})

			await caller.dispose()
			await saver.dispose()
		})
	})

	describe("_clearViewLocalState", () => {
		it("should clear all view-local state values", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// Should not throw even if viewLocalState is already empty
			expect(provider["_clearViewLocalState"]()).toBeUndefined()
			expect(provider["viewLocalState"]).toEqual({})

			await provider.dispose()
		})
	})
})
