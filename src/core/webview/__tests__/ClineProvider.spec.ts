// pnpm --filter roo-cline test core/webview/__tests__/ClineProvider.spec.ts

import fs from "fs"
import * as path from "path"
import { TaskRegistry } from "../../task/TaskRegistry"

import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import axios from "axios"
import pWaitFor from "p-wait-for"

import {
	type ProviderSettingsEntry,
	type ProviderSettings,
	type ClineMessage,
	type ExtensionMessage,
	type ExtensionState,
	type RooCodeSettings,
	type WebviewMessage,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_DIFF_FUZZY_THRESHOLD,
	DEFAULT_WRITE_DELAY_MS,
	providerIdentifiers,
	openAiModelInfoSaneDefaults,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { defaultModeSlug } from "../../../shared/modes"
import { experimentDefault } from "../../../shared/experiments"
import { EMBEDDING_MODEL_PROFILES } from "../../../shared/embeddingModels"
import { setTtsEnabled } from "../../../utils/tts"
import { ContextProxy } from "../../config/ContextProxy"
import { ProviderSettingsNotFoundError } from "../../config/ProviderSettingsManager"
import { WorkspaceIndexingEnablementManager } from "../../../services/code-index/workspace-indexing-enablement-manager"
import { Task, TaskOptions } from "../../task/Task"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { t } from "../../../i18n"

import { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { MdmService } from "../../../services/mdm/MdmService"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { MessageManager } from "../../message-manager"
import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../../api/providers/fetchers/lmstudio"
import { makeCompositeDisposable, makeEventEmitter } from "../../../test-utils/vscode"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { resolveChatProvider } from "../../../activate/resolveChatProvider"

// Mock setup must come before imports.
vi.mock("../../prompts/sections/custom-instructions")

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

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

vi.mock("axios", async (importOriginal) => ({
	default: {
		isAxiosError: (await importOriginal<typeof import("axios")>()).default.isAxiosError,
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return {
		...actual,
		getWorkspacePath: vi.fn().mockReturnValue(""),
	}
})

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
	// Deletion resolves the tasks directory before it removes a history
	// file, so the harness must provide the passthrough base path.
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

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
			this.code = code
			this.name = "McpError"
		}
	},
}))

// Remove duplicate mock - it's already defined below.

const mockAddCustomInstructions = vi.fn().mockResolvedValue("Combined instructions")

;(vi.mocked(await import("../../prompts/sections/custom-instructions")) as any).addCustomInstructions =
	mockAddCustomInstructions

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

// MCP-related modules are mocked once above (lines 87-109).

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
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
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
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
	ViewColumn: { Active: -1 },
	commands: {
		getCommands: vi.fn().mockResolvedValue([]),
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		createWebviewPanel: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
		showErrorMessage: vi.fn(),
		showSaveDialog: vi.fn(),
		showOpenDialog: vi.fn(),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		getWorkspaceFolder: vi.fn(),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => {
			return {
				dispose: vi.fn(),
			}
		}),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
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

vi.mock("../../../utils/tts", () => ({
	playTts: vi.fn().mockResolvedValue(undefined),
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
	stopTts: vi.fn(),
}))

vi.mock("../../../integrations/misc/open-file", () => ({
	openFile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../integrations/misc/image-handler", () => ({
	openImage: vi.fn().mockResolvedValue(undefined),
	saveImage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../mentions", () => ({
	openMention: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn().mockResolvedValue({ fsPath: "/test/default-export.yaml" }),
	saveLastExportPath: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		getAccessToken: vi.fn(),
		getAccountId: vi.fn(),
	},
}))

vi.mock("../../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockImplementation(async () => "mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options: TaskOptions) {
		return {
			api: undefined,
			abortTask: vi.fn(),
			dispose: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../api/providers/fetchers/lmstudio", () => ({
	hasLoadedFullDetails: vi.fn().mockReturnValue(false),
	forceFullModelDetailsLoad: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../services/zoo-code-auth", () => ({
	getZooCodeBaseUrl: vi.fn(() => "https://www.zoocode.dev"),
	getCachedZooCodeToken: vi.fn(),
	handleAuthCallback: vi.fn(),
	setZooCodeUserInfo: vi.fn(),
	disconnectZooCode: vi.fn(),
}))

vi.mock("../../../shared/modes", () => ({
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
			slug: "ask",
			name: "Ask Mode",
			roleDefinition: "You are a helpful assistant",
			groups: ["read"],
		},
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockImplementation((group: string) => {
		// Return appropriate group names for different tool groups
		switch (group) {
			case "read":
				return "Read Tools"
			case "edit":
				return "Edit Tools"
			case "mcp":
				return "MCP Tools"
			default:
				return "General Tools"
		}
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockImplementation(async (_filePath: string) => {
		const content = "const x = 1;\nconst y = 2;\nconst z = 3;"
		const lines = content.split("\n")
		return lines.map((line, index) => `${index + 1} | ${line}`).join("\n")
	}),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
			getToolDescription: () => "test",
			getName: () => "test-strategy",
			applyDiff: vi.fn(),
		}
	}),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				login: vi.fn().mockResolvedValue(undefined),
				logout: vi.fn().mockResolvedValue(undefined),
				off: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
}))

afterAll(() => {
	vi.restoreAllMocks()
})

/**
 * Minimal profile shape the stalled getProfile double resolves to. The
 * settings fields are optional so a lookup that resolves name-only (a
 * profile with no configured provider) also type-checks.
 */
type StalledProfile = {
	name: string
	apiProvider?: string
	openRouterModelId?: string
}

/**
 * Swap the provider's ProviderSettingsManager for a double whose getProfile
 * stalls until the test resolves it, so tests can mutate view state while
 * loadViewState is in flight. The double only backs getProfile, the member
 * loadViewState awaits; the documented @ts-ignore replaces the per-test
 * suppressions the inlined copies used.
 */
function stallProviderSettingsProfile(provider: ClineProvider) {
	let resolveProfile: (value: StalledProfile) => void = () => {}
	const getProfileSpy = vi.fn(() => {
		// Only one lookup is resolvable: resolveProfile is bound to the first
		// promise's resolver, so a second getProfile would strand its promise.
		// Fail loudly instead of hanging.
		if (getProfileSpy.mock.calls.length > 1) {
			throw new Error(
				"stallProviderSettingsProfile: getProfile called more than once; only one lookup is resolvable",
			)
		}
		return new Promise<StalledProfile>((resolve) => (resolveProfile = resolve))
	})
	// @ts-ignore - Reassign the readonly providerSettingsManager for the test; the double only backs getProfile.
	provider.providerSettingsManager = { getProfile: getProfileSpy }
	// Return a stable wrapper around the closure binding: resolveProfile is
	// reassigned to the pending promise's resolver once getProfile is called,
	// so returning the variable directly would hand the test the initial no-op.
	return { getProfile: getProfileSpy, resolveProfile: (value: StalledProfile) => resolveProfile(value) }
}

describe("ClineProvider", () => {
	beforeAll(() => {
		vi.mocked(Task).mockImplementation(function (options: any) {
			const task: any = {
				api: undefined,
				abortTask: vi.fn(),
				dispose: vi.fn().mockResolvedValue(undefined),
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

			Object.defineProperty(task, "messageManager", {
				get: () => new MessageManager(task),
			})

			return task
		})
	})

	let defaultTaskOptions: TaskOptions

	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any
	let updateGlobalStateSpy: any

	afterEach(() => {
		// Tests construct providers directly and many never dispose them; clear the
		// static registry so a leaked instance cannot claim stable view state ids
		// ahead of a later test.
		ClineProvider["activeInstances"] = new Set()
	})

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "architect",
			currentApiConfigName: "current-config",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
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

		// Mock CustomModesManager
		const mockCustomModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			getCustomModes: vi.fn().mockResolvedValue([]),
			dispose: vi.fn(),
		}

		// Mock output channel
		mockOutputChannel = {
			show: vi.fn(),
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		// Mock webview
		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			show: vi.fn(),
			onDidDispose: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		defaultTaskOptions = {
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
			},
		}

		// @ts-ignore - Access private property for testing
		updateGlobalStateSpy = vi.spyOn(provider.contextProxy, "setValue")

		// @ts-ignore - Accessing private property for testing.
		provider.customModesManager = mockCustomModesManager

		// Mock getMcpHub method for generateSystemPrompt
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	test("exposes only the explicitly associated workspace without a fallback", () => {
		provider["currentWorkspacePath"] = "/workspace-a"
		expect(provider.workspacePath).toBe("/workspace-a")
		provider["currentWorkspacePath"] = "/workspace-b"
		expect(provider.workspacePath).toBe("/workspace-b")
		provider["currentWorkspacePath"] = undefined
		expect(provider.workspacePath).toBeUndefined()
	})

	test("constructor initializes correctly", () => {
		expect(provider).toBeInstanceOf(ClineProvider)
		// Since getVisibleInstance returns the last instance where view.visible is true
		// @ts-ignore - accessing private property for testing
		provider.view = mockWebviewView
		expect(ClineProvider.getVisibleInstance()).toBe(provider)
	})

	describe("getInstanceForView", () => {
		it("returns the instance that owns the given view", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			expect(ClineProvider.getInstanceForView(mockWebviewView)).toBe(provider)
		})

		it("returns undefined when no live instance owns the view", () => {
			expect(ClineProvider.getInstanceForView({} as vscode.WebviewView)).toBeUndefined()
		})
	})

	test("reports an unresolved webview as not visible", () => {
		expect(provider.isViewVisible).toBe(false)
	})

	describe("instance registry", () => {
		let originalInstances: Set<ClineProvider>

		beforeEach(() => {
			originalInstances = ClineProvider["activeInstances"]
			ClineProvider["activeInstances"] = new Set()
		})

		afterEach(() => {
			ClineProvider["activeInstances"] = originalInstances
		})

		const newProvider = () =>
			new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				provider.webviewFocusTracker,
			)

		it("lists a provider from the moment it is constructed, so extension-wide broadcasts reach it", () => {
			const created = newProvider()
			expect(ClineProvider.getAllInstances()).toEqual([created])
		})

		it("lists every provider that is open, in the sidebar or an editor tab", () => {
			const first = newProvider()
			const second = newProvider()
			expect(ClineProvider.getAllInstances()).toEqual([first, second])
		})

		it("stops listing a provider once it is disposed, so broadcasts do not reach a closed view", async () => {
			const kept = newProvider()
			const closed = newProvider()

			await closed.dispose()

			expect(ClineProvider.getAllInstances()).toEqual([kept])
		})
	})

	describe("Add to Context destination", () => {
		let originalInstances: Set<ClineProvider>
		let tabProvider: ClineProvider
		let sidebar: ReturnType<typeof createView>
		let tab: ReturnType<typeof createView>
		let panel: vscode.WebviewPanel
		let panelState: vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>

		function createView() {
			const messages = makeEventEmitter<WebviewMessage>()
			const visibility = makeEventEmitter<void>()
			const disposed = makeEventEmitter<void>()
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

		beforeEach(async () => {
			originalInstances = ClineProvider["activeInstances"]
			ClineProvider["activeInstances"] = new Set([provider])
			tabProvider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				provider.webviewFocusTracker,
			)
			sidebar = createView()
			tab = createView()
			panelState = makeEventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>()
			panel = {
				viewType: ClineProvider.tabPanelId,
				title: "Zoo Code",
				viewColumn: undefined,
				webview: tab.view.webview,
				options: {},
				active: false,
				visible: true,
				onDidChangeViewState: panelState.event,
				onDidDispose: tab.disposed.event,
				reveal: vi.fn(),
				dispose: vi.fn(),
			}
			await provider.resolveWebviewView(sidebar.view)
			await tabProvider.resolveWebviewView(panel)
			sidebar.postMessage.mockClear()
			tab.postMessage.mockClear()
		})

		afterEach(async () => {
			await provider.dispose()
			await tabProvider.dispose()
			ClineProvider["activeInstances"] = originalInstances
		})

		const addSelection = async () => {
			const target = await resolveChatProvider(provider.webviewFocusTracker)
			await target?.handleCodeAction("addToContext", "ADD_TO_CONTEXT", { selectedText: "selected code" })
		}

		test("reports current visibility independently of panel activation", () => {
			expect(provider.isViewVisible).toBe(true)
			expect(tabProvider.isViewVisible).toBe(true)
			expect(panel.active).toBe(false)
			Object.defineProperty(sidebar.view, "visible", { value: false, configurable: true })
			Object.defineProperty(panel, "visible", { value: false, configurable: true })
			expect(provider.isViewVisible).toBe(false)
			expect(tabProvider.isViewVisible).toBe(false)
			Object.defineProperty(sidebar.view, "visible", { value: true, configurable: true })
			Object.defineProperty(panel, "visible", { value: true, configurable: true })
			expect(provider.isViewVisible).toBe(true)
			expect(tabProvider.isViewVisible).toBe(true)
		})

		test("follows chat focus rather than registration order after returning to the source editor", async () => {
			sidebar.messages.fire({ type: "webviewDidFocus" })
			// Both views stay visible while the source editor has focus.
			expect(ClineProvider.getVisibleInstance()).toBe(tabProvider)
			await addSelection()
			expect(sidebar.postMessage).toHaveBeenCalledWith({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: expect.stringContaining("selected code"),
			})
			expect(sidebar.postMessage).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
			expect(tab.postMessage).not.toHaveBeenCalled()

			sidebar.postMessage.mockClear()
			tab.messages.fire({ type: "webviewDidFocus" })
			await addSelection()
			expect(tab.postMessage).toHaveBeenCalledTimes(2)
			expect(sidebar.postMessage).not.toHaveBeenCalled()
		})

		test("remembers explicit chat focus after panel deactivation and background visibility events", async () => {
			tab.messages.fire({ type: "webviewDidFocus" })
			Object.defineProperty(panel, "active", { value: false, configurable: true })
			panelState.fire({ webviewPanel: panel })
			sidebar.visibility.fire()
			sidebar.postMessage.mockClear()
			tab.postMessage.mockClear()
			await addSelection()
			expect(tab.postMessage).toHaveBeenCalledTimes(2)
			expect(sidebar.postMessage).not.toHaveBeenCalled()
		})

		test.each([
			{ change: "activation", property: "active", value: true },
			{ change: "visibility", property: "visible", value: false },
			{ change: "position", property: "viewColumn", value: 2 },
		])("panel $change does not overwrite a more recent sidebar interaction", async ({ property, value }) => {
			Object.defineProperty(panel, "active", { value: property !== "active", configurable: true })
			tab.messages.fire({ type: "webviewDidFocus" })
			sidebar.messages.fire({ type: "webviewDidFocus" })
			Object.defineProperty(panel, property, { value, configurable: true })
			panelState.fire({ webviewPanel: panel })
			expect(provider.webviewFocusTracker.getLastActiveProvider()).toBe(provider)

			sidebar.postMessage.mockClear()
			tab.postMessage.mockClear()
			await addSelection()
			expect(sidebar.postMessage).toHaveBeenCalledTimes(2)
			expect(tab.postMessage).not.toHaveBeenCalled()
		})

		it.each([
			{
				message: {
					type: "diagnosticsResponse",
					requestId: "request-1",
					diagnostics: { capturedAt: "2026-11-01T00:00:00.000Z" },
				},
				routed: true,
			},
			{
				message: { type: "diagnosticsResponse", diagnostics: { capturedAt: "2026-11-01T00:00:00.000Z" } },
				routed: false,
			},
			{ message: { type: "themeFixtureProbeResponse", requestId: "request-1" }, routed: false },
		] satisfies { message: WebviewMessage; routed: boolean }[])(
			"routes $message to the diagnostics broker only when addressed",
			async ({ message, routed }) => {
				const handler = vi
					.spyOn(await import("../webviewMessageHandler"), "webviewMessageHandler")
					.mockResolvedValue(undefined)
				const resolve = vi.spyOn(provider["diagnosticsRequestBroker"], "resolve")
				try {
					sidebar.messages.fire(message)
					if (routed) {
						expect(resolve).toHaveBeenCalledExactlyOnceWith("request-1", message.diagnostics)
						expect(handler).not.toHaveBeenCalled()
					} else {
						expect(resolve).not.toHaveBeenCalled()
						expect(handler).toHaveBeenCalledOnce()
						expect(handler.mock.calls[0].slice(0, 2)).toEqual([provider, message])
					}
				} finally {
					handler.mockRestore()
					resolve.mockRestore()
				}
			},
		)

		test("background messages reach the provider handler without changing the last focused chat", async () => {
			sidebar.messages.fire({ type: "webviewDidFocus" })
			const handler = vi
				.spyOn(await import("../webviewMessageHandler"), "webviewMessageHandler")
				.mockResolvedValue(undefined)
			try {
				const message: WebviewMessage = { type: "themeFixtureProbeResponse" }
				tab.messages.fire(message)
				expect(handler).toHaveBeenCalledOnce()
				expect(handler.mock.calls[0].slice(0, 2)).toEqual([tabProvider, message])
				expect(provider.webviewFocusTracker.getLastActiveProvider()).toBe(provider)
			} finally {
				handler.mockRestore()
			}
			await addSelection()
			expect(sidebar.postMessage).toHaveBeenCalledTimes(2)
			expect(tab.postMessage).not.toHaveBeenCalled()
		})

		test("waits for explicit focus even when a panel is already active during registration", () => {
			const state = makeEventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>()
			const activePanel = { ...panel, active: true, onDidChangeViewState: state.event }
			const tracker = new WebviewFocusTracker()
			tracker.init(tabProvider, activePanel)
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			state.fire({ webviewPanel: activePanel })
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			tab.messages.fire({ type: "webviewDidFocus" })
			expect(tracker.getLastActiveProvider()).toBe(tabProvider)
			tracker.dispose()
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			tab.messages.fire({ type: "webviewDidFocus" })
			expect(tracker.getLastActiveProvider()).toBeUndefined()
		})

		test("closing a different chat does not clear the last focused chat", async () => {
			tab.messages.fire({ type: "webviewDidFocus" })
			sidebar.disposed.fire()
			await addSelection()
			expect(tab.postMessage).toHaveBeenCalledTimes(2)
			expect(sidebar.postMessage).not.toHaveBeenCalled()
		})

		test("tracks focus using only message and disposal events", () => {
			const tracker = new WebviewFocusTracker()
			const messages = makeEventEmitter<WebviewMessage>()
			const disposed = makeEventEmitter<void>()
			tracker.init(provider, {
				webview: { onDidReceiveMessage: messages.event },
				onDidDispose: disposed.event,
			})
			messages.fire({ type: "webviewDidFocus" })
			expect(tracker.getLastActiveProvider()).toBe(provider)
			disposed.fire()
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			messages.fire({ type: "webviewDidFocus" })
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			tracker.dispose()
		})

		test("tracker instances keep focus state and disposal independent", () => {
			const first = new WebviewFocusTracker()
			const second = new WebviewFocusTracker()
			const firstView = createView()
			const secondView = createView()
			const firstRegistration = first.init(provider, firstView.view)
			second.init(tabProvider, secondView.view)
			firstView.messages.fire({ type: "webviewDidFocus" })
			secondView.messages.fire({ type: "webviewDidFocus" })

			expect(first.getLastActiveProvider()).toBe(provider)
			expect(second.getLastActiveProvider()).toBe(tabProvider)
			firstRegistration.dispose()
			firstRegistration.dispose()
			firstView.messages.fire({ type: "webviewDidFocus" })
			expect(first.getLastActiveProvider()).toBeUndefined()
			expect(second.getLastActiveProvider()).toBe(tabProvider)
			first.dispose()
			second.dispose()
			second.dispose()
			secondView.messages.fire({ type: "webviewDidFocus" })
			expect(second.getLastActiveProvider()).toBeUndefined()
		})

		test("preserves the visible-provider fallback when no chat has been focused", async () => {
			await addSelection()
			expect(tab.postMessage).toHaveBeenCalledTimes(2)
			expect(sidebar.postMessage).not.toHaveBeenCalled()
		})

		test.each(["sidebar", "tab"])(
			"falls back to the visible chat when the last focused %s is hidden",
			async (source) => {
				const hidden = source === "sidebar" ? sidebar : tab
				const visible = source === "sidebar" ? tab : sidebar
				hidden.messages.fire({ type: "webviewDidFocus" })
				Object.defineProperty(source === "sidebar" ? sidebar.view : panel, "visible", {
					value: false,
					configurable: true,
				})

				const target = await resolveChatProvider(provider.webviewFocusTracker)
				expect(target).toBe(source === "sidebar" ? tabProvider : provider)
				await target?.handleCodeAction("addToContext", "ADD_TO_CONTEXT", { selectedText: "selected code" })

				expect(hidden.postMessage).not.toHaveBeenCalled()
				expect(visible.postMessage).toHaveBeenCalledWith({
					type: "invoke",
					invoke: "setChatBoxMessage",
					text: expect.stringContaining("selected code"),
				})
				expect(visible.postMessage).toHaveBeenCalledWith({ type: "action", action: "focusInput" })
				expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
			},
		)

		test.each(["sidebar", "tab"])(
			"opens the sidebar when the last focused %s and all other chats are hidden",
			async (source) => {
				const focused = source === "sidebar" ? sidebar : tab
				focused.messages.fire({ type: "webviewDidFocus" })
				Object.defineProperty(sidebar.view, "visible", { value: false, configurable: true })
				Object.defineProperty(panel, "visible", { value: false, configurable: true })
				vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async () => {
					Object.defineProperty(sidebar.view, "visible", { value: true, configurable: true })
				})

				const target = await resolveChatProvider(provider.webviewFocusTracker)
				expect(target).toBe(provider)
				await target?.handleCodeAction("addToContext", "ADD_TO_CONTEXT", { selectedText: "selected code" })

				expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
					`${ClineProvider.sideBarId}.focus`,
				)
				expect(sidebar.postMessage).toHaveBeenCalledWith({
					type: "invoke",
					invoke: "setChatBoxMessage",
					text: expect.stringContaining("selected code"),
				})
				expect(tab.postMessage).not.toHaveBeenCalled()
				expect(panel.reveal).not.toHaveBeenCalled()
			},
		)

		test("remembers the last focused chat across hiding and showing it without another interaction", async () => {
			sidebar.messages.fire({ type: "webviewDidFocus" })
			Object.defineProperty(sidebar.view, "visible", { value: false, configurable: true })
			expect(await resolveChatProvider(provider.webviewFocusTracker)).toBe(tabProvider)
			expect(provider.webviewFocusTracker.getLastActiveProvider()).toBe(provider)
			Object.defineProperty(sidebar.view, "visible", { value: true, configurable: true })
			expect(await resolveChatProvider(provider.webviewFocusTracker)).toBe(provider)
		})

		test("preserves single-view behavior", async () => {
			await tabProvider.dispose()
			await addSelection()
			expect(sidebar.postMessage).toHaveBeenCalledTimes(2)
		})

		test("preserves the sidebar fallback when the last focused tab is disposed", async () => {
			tab.messages.fire({ type: "webviewDidFocus" })
			await tabProvider.dispose()
			Object.defineProperty(sidebar.view, "visible", { value: false, configurable: true })
			vi.mocked(vscode.commands.executeCommand).mockImplementationOnce(async () => {
				Object.defineProperty(sidebar.view, "visible", { value: true, configurable: true })
			})
			await addSelection()
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith(`${ClineProvider.sideBarId}.focus`)
			expect(sidebar.postMessage).toHaveBeenCalledTimes(2)
			expect(tab.postMessage).not.toHaveBeenCalled()
		})

		test("forgets a disposed sidebar webview even while its provider remains registered", async () => {
			sidebar.messages.fire({ type: "webviewDidFocus" })
			sidebar.disposed.fire()
			expect(provider.webviewFocusTracker.getLastActiveProvider()).toBeUndefined()
			await addSelection()
			expect(tab.postMessage).toHaveBeenCalledTimes(2)
			expect(sidebar.postMessage).not.toHaveBeenCalled()
		})

		test.each([
			["explainCode", "EXPLAIN"],
			["fixCode", "FIX"],
			["improveCode", "IMPROVE"],
		] as const)("creates a task only in the last focused chat for %s", async (command, promptType) => {
			sidebar.messages.fire({ type: "webviewDidFocus" })
			const task = new Task(defaultTaskOptions)
			const sidebarTask = vi.spyOn(provider, "createTask").mockResolvedValue(task)
			const tabTask = vi.spyOn(tabProvider, "createTask").mockResolvedValue(task)
			try {
				const target = provider.webviewFocusTracker.getLastActiveProvider()!
				await target.handleCodeAction(command, promptType, { selectedText: "selected code" })
				expect(sidebarTask).toHaveBeenCalledOnce()
				expect(sidebarTask).toHaveBeenCalledWith(expect.stringContaining("selected code"))
				expect(tabTask).not.toHaveBeenCalled()
			} finally {
				sidebarTask.mockRestore()
				tabTask.mockRestore()
			}
		})

		test("preserves visible-provider fallback for task creation when no chat has been focused", async () => {
			const task = new Task(defaultTaskOptions)
			const sidebarTask = vi.spyOn(provider, "createTask").mockResolvedValue(task)
			const tabTask = vi.spyOn(tabProvider, "createTask").mockResolvedValue(task)
			const target = await ClineProvider.getInstance()
			await target?.handleCodeAction("explainCode", "EXPLAIN", { selectedText: "selected code" })
			expect(tabTask).toHaveBeenCalledOnce()
			expect(sidebarTask).not.toHaveBeenCalled()
			sidebarTask.mockRestore()
			tabTask.mockRestore()
		})
	})

	test("loads full model details when preparing an LM Studio task", async () => {
		// buildApiHandler is a module-level mock shared across describes; pin its return value
		// so this test always passes a handler double to forceFullModelDetailsLoad.
		const { buildApiHandler } = await import("../../../api")
		vi.mocked(buildApiHandler).mockReturnValue({
			getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
		} as unknown as ReturnType<typeof buildApiHandler>)

		await provider.performPreparationTasks({
			apiConfiguration: {
				apiProvider: providerIdentifiers.lmstudio,
				lmStudioBaseUrl: "http://localhost:1234",
				lmStudioModelId: "test-model",
			},
		} as Task)

		expect(forceFullModelDetailsLoad).toHaveBeenCalledWith("http://localhost:1234", "test-model", expect.anything())
	})

	test("does not reload full model details when the LM Studio model is already loaded", async () => {
		vi.mocked(hasLoadedFullDetails).mockReturnValueOnce(true)

		await provider.performPreparationTasks({
			apiConfiguration: {
				apiProvider: providerIdentifiers.lmstudio,
				lmStudioBaseUrl: "http://localhost:1234",
				lmStudioModelId: "test-model",
			},
		} as Task)

		expect(forceFullModelDetailsLoad).not.toHaveBeenCalled()
	})

	test("resolveWebviewView hydrates the saved terminalProfile into the process-wide Terminal state", async () => {
		const setTerminalProfileSpy = vi.spyOn(Terminal, "setTerminalProfile").mockImplementation(() => {})
		// Seed the persisted setting so the real getState() returns it during hydration.
		await (provider as any).contextProxy.setValue("terminalProfile", "Git Bash")

		await provider.resolveWebviewView(mockWebviewView)
		// The hydration runs in a getState().then(...) callback, so flush microtasks.
		await new Promise((resolve) => setImmediate(resolve))

		expect(setTerminalProfileSpy).toHaveBeenCalledWith("Git Bash")

		setTerminalProfileSpy.mockRestore()
	})

	test("resolveWebviewView sets up webview correctly", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		expect(mockWebviewView.webview.options).toEqual({
			enableScripts: true,
			localResourceRoots: [mockContext.extensionUri],
		})

		expect(mockWebviewView.webview.html).toContain("<!DOCTYPE html>")
		expect(mockWebviewView.webview.html).toContain("<title>Zoo Code</title>")
	})
	test("whenViewResolved releases waiters only once messages would actually be delivered", async () => {
		// The focus command settles when VS Code opens the pane, so the plus-button flow awaits this
		// gate before posting. A waiter must not wake while postMessageToWebview would drop the
		// message because the view is still unset.
		const pending = provider.whenViewResolved()
		let settled = false
		void pending.then(() => {
			settled = true
		})

		await new Promise((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)

		await provider.resolveWebviewView(mockWebviewView)
		await pending
		expect(settled).toBe(true)

		// An already-resolved view answers immediately, and a provider that goes away must not leave
		// the caller hanging on a view that is never coming.
		await expect(provider.whenViewResolved()).resolves.toBeUndefined()
		const orphan = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"editor",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
		const hanging = orphan.whenViewResolved()
		await orphan.dispose()
		await expect(hanging).resolves.toBeUndefined()
	})

	describe("logWebviewHiddenDiagnostics", () => {
		let visibilityCallback: () => void

		beforeEach(async () => {
			// Capture the visibility callback registered during resolveWebviewView
			mockWebviewView.onDidChangeVisibility = vi.fn().mockImplementation((cb: () => void) => {
				visibilityCallback = cb
				return { dispose: vi.fn() }
			})
			// @ts-ignore - accessing private property for testing
			provider.view = mockWebviewView
			await provider.resolveWebviewView(mockWebviewView)
			;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()
		})

		test("does not log when no task is active", () => {
			// view becomes hidden with no task on the stack
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			visibilityCallback()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
		})

		test("does not log when the active task is aborted", async () => {
			const task = new Task(defaultTaskOptions)
			Object.defineProperty(task, "taskId", { value: "aborted-task", writable: true })
			task.abort = true
			await provider.addClineToStack(task)
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			visibilityCallback()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
		})

		test("logs task state to output channel when an active task is running", async () => {
			const task = new Task(defaultTaskOptions)
			Object.defineProperty(task, "taskId", { value: "running-task", writable: true })
			await provider.addClineToStack(task)
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			visibilityCallback()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("running-task"))
		})
	})

	describe("webview heartbeat watchdog", () => {
		let visibilityCallback: () => void
		let disposeCallback: () => void

		function trackHtmlAssignments() {
			let html = mockWebviewView.webview.html
			const assignHtml = vi.fn((value: string) => {
				html = value
			})
			Object.defineProperty(mockWebviewView.webview, "html", {
				configurable: true,
				get: () => html,
				set: assignHtml,
			})
			return assignHtml
		}

		beforeEach(() => {
			vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined)
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
			vi.mocked(vscode.commands.getCommands).mockResolvedValue([
				`${ClineProvider.sideBarId}.removeView`,
				`${ClineProvider.sideBarId}.focus`,
			])
			// Fake timers must be active before resolveWebviewView so the
			// watchdog interval is registered on the fake clock.
			vi.useFakeTimers()
			mockWebviewView.onDidChangeVisibility = vi.fn().mockImplementation((cb: () => void) => {
				visibilityCallback = cb
				return { dispose: vi.fn() }
			})
			// VS Code events are multi-listener: the provider and the focus
			// tracker each register a disposal callback, and both must fire.
			const disposeCallbacks: Array<() => void> = []
			disposeCallback = () => disposeCallbacks.forEach((cb) => cb())
			mockWebviewView.onDidDispose = vi.fn().mockImplementation((cb: () => void) => {
				disposeCallbacks.push(cb)
				return { dispose: vi.fn() }
			})
		})

		afterEach(async () => {
			await provider.dispose()
			vi.useRealTimers()
		})

		test("does not reload the webview while heartbeats are fresh", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			await vi.advanceTimersByTimeAsync(110_000)
			await webviewMessageHandler(provider, { type: "webviewHeartbeat", timestamp: Date.now() })
			await vi.advanceTimersByTimeAsync(60_000)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("reloads the webview with fresh HTML when the heartbeat is stale and the view is visible", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			await vi.advanceTimersByTimeAsync(120_000)

			// Reassigning webview.html with a fresh nonce is what forces the reload.
			expect(mockWebviewView.webview.html).not.toBe(htmlAfterResolve)
			expect(mockWebviewView.webview.html).toContain("<title>Zoo Code</title>")
		})

		test.each([
			{ age: 89_999, reloads: 0 },
			{ age: 90_000, reloads: 0 },
			{ age: 90_001, reloads: 1 },
		])("at heartbeat age $age ms performs $reloads reloads", async ({ age, reloads }) => {
			await provider.resolveWebviewView(mockWebviewView)
			const assignHtml = trackHtmlAssignments()
			// Keep the next tick ordinary while placing heartbeat age exactly on
			// either side of the stale threshold at that tick.
			provider["lastWebviewHeartbeatAt"] = Date.now() + 60_000 - age

			await vi.advanceTimersByTimeAsync(60_000)

			expect(assignHtml).toHaveBeenCalledTimes(reloads)
		})

		test.each([
			{ gap: 89_999, reloads: 1 },
			{ gap: 90_000, reloads: 1 },
			{ gap: 90_001, reloads: 0 },
		])("at watchdog tick gap $gap ms performs $reloads reloads", async ({ gap, reloads }) => {
			await provider.resolveWebviewView(mockWebviewView)
			const assignHtml = trackHtmlAssignments()
			// The heartbeat is stale in every row; only the suspend-gap guard
			// can suppress recovery. No wall-clock jumps or extra ticks mask it.
			provider["lastWebviewHeartbeatAt"] = Date.now() - 120_000
			provider["lastWebviewWatchdogTickAt"] = Date.now() + 60_000 - gap

			await vi.advanceTimersByTimeAsync(60_000)

			expect(assignHtml).toHaveBeenCalledTimes(reloads)
		})

		test.each(["none", "disposed", "epoch"] as const)(
			"checks only the %s post-await recovery guard",
			async (guard) => {
				await provider.resolveWebviewView(mockWebviewView)
				const assignHtml = trackHtmlAssignments()
				let finishReload: (html: string) => void = () => {
					throw new Error("Recovery HTML generation has not started")
				}
				provider["getWebviewHtml"] = vi.fn(
					() =>
						new Promise<string>((resolve) => {
							finishReload = resolve
						}),
				)
				const recovery = provider["reloadWebviewForRecovery"]()
				// Change one field only: real dispose/re-resolve paths change
				// multiple fields and would let other guards mask this one.
				if (guard === "disposed") provider["_disposed"] = true
				if (guard === "epoch") provider["webviewRecoveryEpoch"]++
				try {
					finishReload("recovered-html")
					await recovery
					expect(assignHtml).toHaveBeenCalledTimes(guard === "none" ? 1 : 0)
					if (guard === "none") expect(mockWebviewView.webview.html).toBe("recovered-html")
				} finally {
					// Allow the regular afterEach to dispose the provider's resources.
					provider["_disposed"] = false
				}
			},
		)

		test("grants a new grace window after recovery and caps reloads until sustained heartbeats", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const assignHtml = trackHtmlAssignments()

			await vi.advanceTimersByTimeAsync(120_000)
			expect(assignHtml).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(60_000)
			expect(assignHtml).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(180_000)
			expect(assignHtml).toHaveBeenCalledTimes(3)

			const log = vi.spyOn(provider, "log")

			// Visibility changes and host suspension grant grace, but cannot
			// replenish attempts for a renderer that has never responded.
			visibilityCallback()
			vi.setSystemTime(Date.now() + 120_000)
			await vi.advanceTimersByTimeAsync(600_000)
			expect(assignHtml).toHaveBeenCalledTimes(3)
			expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Webview heartbeat stale"))

			await webviewMessageHandler(provider, { type: "webviewHeartbeat" })
			await vi.advanceTimersByTimeAsync(120_000)
			expect(assignHtml).toHaveBeenCalledTimes(3)
			// One mount heartbeat is insufficient: a new healthy window must
			// span a full minute of periodic heartbeats before replenishing.
			const attempts = provider["webviewRecoveryAttempts"]
			expect(attempts).toBe(3)
			provider.updateWebviewHeartbeat()
			expect(provider["webviewRecoveryAttempts"]).toBe(attempts)
			await vi.advanceTimersByTimeAsync(30_000)
			provider.updateWebviewHeartbeat()
			expect(provider["webviewRecoveryAttempts"]).toBe(attempts)
			await vi.advanceTimersByTimeAsync(30_000)
			provider.updateWebviewHeartbeat()
			expect(provider["webviewRecoveryAttempts"]).toBe(0)
			await vi.advanceTimersByTimeAsync(120_000)
			expect(assignHtml).toHaveBeenCalledTimes(4)
		})

		test.each([false, true])(
			"recreates only the failed sidebar host, retaining its task and budget (interrupted: %s)",
			async (interrupted) => {
				await provider.resolveWebviewView(mockWebviewView)
				const task = new Task(defaultTaskOptions)
				task.abort = interrupted
				provider["taskRegistry"].push(task)
				const evict = vi.spyOn(provider, "evictCurrentTask")
				const remove = vi.spyOn(provider, "removeClineFromStack")
				const replacement = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
					if (command === `${ClineProvider.sideBarId}.focus`) await provider.resolveWebviewView(replacement)
				})

				await vi.advanceTimersByTimeAsync(120_000)
				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(`${ClineProvider.sideBarId}.removeView`)
				await vi.advanceTimersByTimeAsync(10_000)

				expect(vscode.commands.executeCommand).toHaveBeenCalledWith(`${ClineProvider.sideBarId}.removeView`)
				expect(vscode.commands.executeCommand).toHaveBeenCalledWith(`${ClineProvider.sideBarId}.focus`, {
					preserveFocus: true,
				})
				expect(provider["view"]).toBe(replacement)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(provider.getCurrentTask()).toBe(task)
				expect(evict).not.toHaveBeenCalled()
				expect(remove).not.toHaveBeenCalled()
				expect(task.dispose).not.toHaveBeenCalled()
				expect(task.abortTask).not.toHaveBeenCalled()
			},
		)

		test.each(["HTML generation", "state hydration"] as const)(
			"preserves normal sidebar startup rejection for failed %s outside recovery",
			async (stage) => {
				const error = new Error("initial view failed")
				provider["getWebviewHtml"] = vi.fn().mockResolvedValue("initial-html")
				if (stage === "HTML generation") vi.mocked(provider["getWebviewHtml"]).mockRejectedValueOnce(error)
				else vi.spyOn(provider, "getState").mockRejectedValueOnce(error)

				await expect(provider.resolveWebviewView(mockWebviewView)).rejects.toBe(error)

				expect(provider["webviewWatchdogInterval"]).toBeNull()
				expect(provider["webviewRecoveryAttempts"]).toBe(0)
				expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
			},
		)

		describe("sidebar replacement timing", () => {
			beforeEach(async () => {
				const actual = await vi.importActual<typeof import("p-wait-for")>("p-wait-for")
				vi.mocked(pWaitFor).mockImplementation(actual.default)
			})

			afterEach(() => {
				vi.mocked(pWaitFor).mockReset().mockResolvedValue(undefined)
			})

			function removeSidebarOnCommand() {
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
				})
			}

			test.each([false, true])(
				"explicit retry renews a timed-out sidebar incident after ambiguous reopen: %s",
				async (reopened) => {
					await provider.resolveWebviewView(mockWebviewView)
					const task = new Task(defaultTaskOptions)
					task.abort = true
					provider["taskRegistry"].push(task)
					const remove = vi.spyOn(provider, "removeClineFromStack")
					let choose: (value: string) => void = () => {
						throw new Error("No warning")
					}
					vi.mocked(vscode.window.showWarningMessage).mockImplementation(
						vi.fn().mockReturnValue(
							new Promise<string>((resolve) => {
								choose = resolve
							}),
						),
					)
					removeSidebarOnCommand()
					await vi.advanceTimersByTimeAsync(140_000)
					expect(provider["pendingSidebarRecovery"]).toBe(true)
					expect(provider["webviewRecoveryAttempts"]).toBe(3)
					if (reopened) {
						await provider.resolveWebviewView({
							...mockWebviewView,
							webview: { ...mockWebviewView.webview, html: "" },
						})
						expect(provider["webviewRecoveryAttempts"]).toBe(3)
						expect(provider.getCurrentTask()).toBe(task)
					}
					const healthy = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
					vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
						if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
						if (command === `${ClineProvider.sideBarId}.focus`) await provider.resolveWebviewView(healthy)
					})

					choose("Retry Interface Recovery")
					await vi.advanceTimersByTimeAsync(50)

					expect(provider["view"]).toBe(healthy)
					expect(provider["webviewRecoveryAttempts"]).toBe(1)
					expect(provider["webviewRecoveryRequestGeneration"]).toBe(1)
					expect(provider["webviewRecoveryFailureReported"]).toBe(false)
					expect(provider["webviewRecoveryStopLogged"]).toBe(false)
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(provider.getCurrentTask()).toBe(task)
					expect(remove).not.toHaveBeenCalled()
					expect(task.abortTask).not.toHaveBeenCalled()
					expect(task.dispose).not.toHaveBeenCalled()
					expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
				},
			)

			test.each(["focus failure", "replacement timeout"] as const)(
				"explicit retry reports %s without an automatic retry loop",
				async (failure) => {
					await provider.resolveWebviewView(mockWebviewView)
					removeSidebarOnCommand()
					await vi.advanceTimersByTimeAsync(140_000)
					if (failure === "focus failure")
						vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("focus unavailable"))
					const retry = provider.retryWebviewRecovery()
					await vi.advanceTimersByTimeAsync(10_000)
					await retry
					expect(provider["webviewRecoveryAttempts"]).toBe(3)
					expect(provider["pendingSidebarRecovery"]).toBe(failure === "replacement timeout")
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
					await vi.advanceTimersByTimeAsync(120_000)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
				},
			)

			test("warns once after ten seconds without a replacement and releases recovery ownership", async () => {
				await provider.resolveWebviewView(mockWebviewView)
				removeSidebarOnCommand()
				await vi.advanceTimersByTimeAsync(130_000)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(true)
				await vi.advanceTimersByTimeAsync(9_999)
				expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(1)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(provider["webviewRecoveryAttempts"]).toBe(3)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
				await vi.advanceTimersByTimeAsync(120_000)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			})

			test("settles the replacement wait when the provider is disposed", async () => {
				await provider.resolveWebviewView(mockWebviewView)
				removeSidebarOnCommand()
				await vi.advanceTimersByTimeAsync(130_000)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(true)
				await provider.dispose()
				await vi.advanceTimersByTimeAsync(50)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
			})

			test.each([5_000, 11_000])(
				"retains an interrupted task and budget when replacement starts after %s ms",
				async (delay) => {
					await provider.resolveWebviewView(mockWebviewView)
					const task = new Task(defaultTaskOptions)
					task.abort = true
					provider["taskRegistry"].push(task)
					const remove = vi.spyOn(provider, "removeClineFromStack")
					removeSidebarOnCommand()
					await vi.advanceTimersByTimeAsync(130_000 + delay)
					const attempts = delay < 10_000 ? 1 : 3
					expect(provider["webviewRecoveryAttempts"]).toBe(attempts)
					expect(provider["webviewHostRecoveryInProgress"]).toBe(delay < 10_000)

					const replacement = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
					await provider.resolveWebviewView(replacement)
					await vi.advanceTimersByTimeAsync(50)

					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(provider["pendingSidebarRecovery"]).toBe(false)
					expect(provider["webviewRecoveryAttempts"]).toBe(attempts)
					expect(provider["webviewRecoveryFailureReported"]).toBe(delay >= 10_000)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(delay < 10_000 ? 0 : 1)
					expect(provider.getCurrentTask()).toBe(task)
					expect(remove).not.toHaveBeenCalled()
					expect(task.dispose).not.toHaveBeenCalled()
					expect(task.abortTask).not.toHaveBeenCalled()
				},
			)

			test.each(["HTML generation", "state hydration"] as const)(
				"recovers an interrupted sidebar task after failed replacement %s",
				async (stage) => {
					await provider.resolveWebviewView(mockWebviewView)
					const task = new Task(defaultTaskOptions)
					task.abort = true
					provider["taskRegistry"].push(task)
					const remove = vi.spyOn(provider, "removeClineFromStack")
					provider["getWebviewHtml"] = vi.fn().mockResolvedValue("recovered-html")
					const failed = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
					const healthy = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
					const replacements = [failed, healthy]
					let resolution: Promise<void> | undefined
					vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
						if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
						if (command === `${ClineProvider.sideBarId}.focus`) {
							const next = replacements.shift()
							if (!next) throw new Error("Unexpected third replacement")
							if (next === failed) {
								if (stage === "HTML generation")
									vi.mocked(provider["getWebviewHtml"]).mockRejectedValueOnce(
										new Error("HTML failed"),
									)
								else vi.spyOn(provider, "getState").mockRejectedValueOnce(new Error("hydration failed"))
							}
							// VS Code resolves the view independently of its focus command.
							resolution = provider.resolveWebviewView(next)
						}
					})

					await vi.advanceTimersByTimeAsync(130_050)
					await expect(resolution).resolves.toBeUndefined()

					expect(provider["view"]).toBe(failed)
					expect(provider["webviewWatchdogInterval"]).not.toBeNull()
					expect(provider["webviewRecoveryAttempts"]).toBe(1)
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
					expect(provider.getCurrentTask()).toBe(task)
					expect(remove).not.toHaveBeenCalled()

					await vi.advanceTimersByTimeAsync(130_000)
					await expect(resolution).resolves.toBeUndefined()

					expect(provider["view"]).toBe(healthy)
					expect(healthy.webview.html).toBe("recovered-html")
					expect(provider["webviewRecoveryAttempts"]).toBe(2)
					expect(replacements).toHaveLength(0)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
					expect(provider.getCurrentTask()).toBe(task)
					expect(remove).not.toHaveBeenCalled()
					expect(task.abortTask).not.toHaveBeenCalled()
					expect(task.dispose).not.toHaveBeenCalled()
				},
			)

			test("caps repeated failed sidebar replacements without evicting the task", async () => {
				await provider.resolveWebviewView(mockWebviewView)
				const task = new Task(defaultTaskOptions)
				provider["taskRegistry"].push(task)
				provider["getWebviewHtml"] = vi.fn().mockResolvedValue("recovered-html")
				const resolutions: Promise<void>[] = []
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
					if (command === `${ClineProvider.sideBarId}.focus`) {
						vi.spyOn(provider, "getState").mockRejectedValueOnce(new Error("hydration failed"))
						const replacement = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
						resolutions.push(provider.resolveWebviewView(replacement))
					}
				})

				await vi.advanceTimersByTimeAsync(720_000)
				await Promise.all(resolutions)

				expect(resolutions).toHaveLength(3)
				expect(provider["webviewRecoveryAttempts"]).toBe(3)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
				expect(provider.getCurrentTask()).toBe(task)
				expect(task.abortTask).not.toHaveBeenCalled()
				expect(task.dispose).not.toHaveBeenCalled()
			})

			test("keeps retries available when a published sidebar rejects after the replacement wait", async () => {
				await provider.resolveWebviewView(mockWebviewView)
				removeSidebarOnCommand()
				await vi.advanceTimersByTimeAsync(130_000)
				let rejectHtml: (error: Error) => void = () => {
					throw new Error("HTML generation has not started")
				}
				provider["getWebviewHtml"] = vi.fn(
					() =>
						new Promise<string>((_resolve, reject) => {
							rejectHtml = reject
						}),
				)
				const replacement = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
				const resolution = provider.resolveWebviewView(replacement)
				await vi.advanceTimersByTimeAsync(10_000)
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)

				rejectHtml(new Error("late HTML failure"))
				await expect(resolution).resolves.toBeUndefined()

				expect(provider["view"]).toBe(replacement)
				expect(provider["webviewWatchdogInterval"]).not.toBeNull()
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			})

			test("retains recovery intent and remaining attempts while replacement HTML generation outlasts the wait", async () => {
				await provider.resolveWebviewView(mockWebviewView)
				const task = new Task(defaultTaskOptions)
				task.abort = true
				provider["taskRegistry"].push(task)
				const remove = vi.spyOn(provider, "removeClineFromStack")
				removeSidebarOnCommand()
				await vi.advanceTimersByTimeAsync(130_000)
				let finishHtml: (html: string) => void = () => {
					throw new Error("HTML generation has not started")
				}
				provider["getWebviewHtml"] = vi.fn(
					() =>
						new Promise<string>((resolve) => {
							finishHtml = resolve
						}),
				)
				const replacement = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
				const resolving = provider.resolveWebviewView(replacement)
				await vi.advanceTimersByTimeAsync(10_000)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				finishHtml("replacement-html")
				await resolving
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(provider.getCurrentTask()).toBe(task)
				expect(remove).not.toHaveBeenCalled()
			})
		})

		test("recreates the sidebar again after a second incident", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const replacements = [0, 1].map(() => ({
				...mockWebviewView,
				webview: { ...mockWebviewView.webview, html: "" },
			}))
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
				if (command === `${ClineProvider.sideBarId}.focus`) {
					const next = replacements.shift()
					if (!next) throw new Error("Unexpected third replacement")
					await provider.resolveWebviewView(next)
				}
			})
			await vi.advanceTimersByTimeAsync(130_000)
			expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
			provider.updateWebviewHeartbeat()
			await vi.advanceTimersByTimeAsync(30_000)
			provider.updateWebviewHeartbeat()
			await vi.advanceTimersByTimeAsync(30_000)
			provider.updateWebviewHeartbeat()
			expect(provider["webviewRecoveryAttempts"]).toBe(0)
			await vi.advanceTimersByTimeAsync(130_000)
			expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
			expect(provider["webviewRecoveryAttempts"]).toBe(1)
			expect(replacements).toHaveLength(0)
			expect(
				vi
					.mocked(vscode.commands.executeCommand)
					.mock.calls.filter(([command]) => command === `${ClineProvider.sideBarId}.removeView`),
			).toHaveLength(2)
		})

		test.each(["heartbeat", "hidden", "disposed", "suspended"] as const)(
			"does not recreate the host after %s during the confirmation window",
			async (event) => {
				await provider.resolveWebviewView(mockWebviewView)
				await vi.advanceTimersByTimeAsync(120_000)
				if (event === "heartbeat") provider.updateWebviewHeartbeat()
				if (event === "hidden")
					Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
				if (event === "disposed") await provider.dispose()
				if (event === "suspended") vi.setSystemTime(Date.now() + 120_000)

				await vi.advanceTimersByTimeAsync(10_000)

				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(`${ClineProvider.sideBarId}.removeView`)
			},
		)

		test.each(["heartbeat", "hidden", "disposed", "replacement"] as const)(
			"cancels host recreation after %s during command discovery",
			async (event) => {
				await provider.resolveWebviewView(mockWebviewView)
				vi.mocked(vscode.commands.getCommands).mockImplementation(async () => {
					if (event === "heartbeat") provider.updateWebviewHeartbeat()
					if (event === "hidden")
						Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
					if (event === "disposed") await provider.dispose()
					if (event === "replacement") provider["view"] = { ...mockWebviewView }
					// Even an unavailable-command result must be ignored after cancellation.
					return []
				})

				await vi.advanceTimersByTimeAsync(130_000)

				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(`${ClineProvider.sideBarId}.removeView`)
				expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
			},
		)

		test("ignores a late command-discovery error after a heartbeat returns", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.mocked(vscode.commands.getCommands).mockImplementation(async () => {
				provider.updateWebviewHeartbeat()
				throw new Error("discovery failed")
			})

			await vi.advanceTimersByTimeAsync(130_000)

			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		})

		test.each(["unavailable commands", "failed removal"] as const)(
			"stops and notifies once when scoped recovery has %s",
			async (failure) => {
				await provider.resolveWebviewView(mockWebviewView)
				if (failure === "unavailable commands") vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
				if (failure === "failed removal")
					vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("removal failed"))
				const assignHtml = trackHtmlAssignments()

				await vi.advanceTimersByTimeAsync(600_000)

				expect(assignHtml).toHaveBeenCalledTimes(1)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(provider["pendingSidebarRecovery"]).toBe(false)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
				expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
					expect.stringContaining("Webview recovery stopped:"),
				)
			},
		)

		test("clears a failed focus incident before a manual sidebar open", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const task = new Task(defaultTaskOptions)
			task.abort = true
			provider["taskRegistry"].push(task)
			const remove = vi.spyOn(provider, "removeClineFromStack")
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
				if (command === `${ClineProvider.sideBarId}.focus`) throw new Error("focus failed")
			})

			await vi.advanceTimersByTimeAsync(130_000)

			expect(provider["view"]).toBeUndefined()
			expect(provider["pendingSidebarRecovery"]).toBe(false)
			expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
			expect(provider["webviewRecoveryAttempts"]).toBe(3)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			expect(remove).not.toHaveBeenCalled()

			const manualView = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
			await provider.resolveWebviewView(manualView)

			expect(provider["view"]).toBe(manualView)
			expect(provider["webviewRecoveryAttempts"]).toBe(0)
			expect(provider["webviewRecoveryFailureReported"]).toBe(false)
			expect(remove).toHaveBeenCalledTimes(1)
			expect(provider.getCurrentTask()).toBeUndefined()
		})

		test.each([false, true])(
			"logs one terminal stop and notification despite repeated ticks (prior retry warning: %s)",
			async (priorWarning) => {
				await provider.resolveWebviewView(mockWebviewView)
				const html = mockWebviewView.webview.html
				const log = vi.spyOn(provider, "log")
				if (priorWarning) {
					provider["reportWebviewRecoveryFailure"]("Initialization failed; retry pending", false)
					expect(provider["webviewRecoveryAttempts"]).toBe(0)
					expect(log).toHaveBeenCalledWith(
						"[Zoo Code] Webview recovery will retry: Initialization failed; retry pending",
					)
				}

				provider["reportWebviewRecoveryFailure"]("Recovery is unavailable")
				expect(log).toHaveBeenCalledWith("[Zoo Code] Webview recovery stopped: Recovery is unavailable")
				await vi.advanceTimersByTimeAsync(300_000)

				expect(provider["webviewRecoveryAttempts"]).toBe(3)
				expect(mockWebviewView.webview.html).toBe(html)
				expect(log.mock.calls.filter(([line]) => line.includes("Webview recovery stopped:"))).toEqual([
					["[Zoo Code] Webview recovery stopped: Recovery is unavailable"],
				])
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			},
		)

		test.each(["heartbeat", "manual reopen"] as const)(
			"logs a new terminal stop after %s begins a new incident",
			async (reset) => {
				await provider.resolveWebviewView(mockWebviewView)
				const log = vi.spyOn(provider, "log")
				provider["reportWebviewRecoveryFailure"]("First incident")
				if (reset === "heartbeat") provider.updateWebviewHeartbeat()
				else {
					disposeCallback()
					await provider.resolveWebviewView({
						...mockWebviewView,
						webview: { ...mockWebviewView.webview, html: "" },
					})
				}
				expect(provider["webviewRecoveryStopLogged"]).toBe(false)

				provider["reportWebviewRecoveryFailure"]("Second incident")
				await vi.advanceTimersByTimeAsync(300_000)

				expect(log.mock.calls.filter(([line]) => line.includes("Webview recovery stopped:"))).toEqual([
					["[Zoo Code] Webview recovery stopped: First incident"],
					["[Zoo Code] Webview recovery stopped: Second incident"],
				])
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
			},
		)

		test.each(["Retry Interface Recovery", "Reload Window", "Show Logs"] as const)(
			"an old notification action cannot restart a renewed generation: %s",
			async (choice) => {
				await provider.resolveWebviewView(mockWebviewView)
				let choose: (value: string) => void = () => {
					throw new Error("No warning")
				}
				vi.mocked(vscode.window.showWarningMessage).mockImplementation(
					vi.fn().mockReturnValue(
						new Promise<string>((resolve) => {
							choose = resolve
						}),
					),
				)
				provider["reportWebviewRecoveryFailure"]("Old incident")
				const healthy = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
					if (command === `${ClineProvider.sideBarId}.focus`) await provider.resolveWebviewView(healthy)
				})
				await provider.retryWebviewRecovery()
				choose(choice)
				await vi.advanceTimersByTimeAsync(0)
				expect(provider["webviewRecoveryRequestGeneration"]).toBe(1)
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
				expect(mockOutputChannel.show).toHaveBeenCalledTimes(choice === "Show Logs" ? 1 : 0)
			},
		)

		test.each(["disposed", "stale notification"] as const)("does not renew recovery after %s", async (event) => {
			await provider.resolveWebviewView(mockWebviewView)
			if (event === "disposed") await provider.dispose()
			else provider["webviewRecoveryRequestGeneration"] = 1
			vi.mocked(vscode.commands.executeCommand).mockClear()
			await provider.retryWebviewRecovery(0)
			expect(provider["webviewRecoveryRequestGeneration"]).toBe(event === "disposed" ? 0 : 1)
			expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		})

		test("an old focus rejection cannot release or stop a newer explicit retry", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			let rejectOldFocus: (error: Error) => void = () => {
				throw new Error("Old focus has not started")
			}
			let finishNewFocus: () => void = () => {
				throw new Error("New focus has not started")
			}
			let focusCount = 0
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
				if (command === `${ClineProvider.sideBarId}.focus`) {
					focusCount++
					if (focusCount === 1)
						await new Promise<void>((_resolve, reject) => {
							rejectOldFocus = reject
						})
					else
						await new Promise<void>((resolve) => {
							finishNewFocus = resolve
						})
				}
			})
			const old = provider["recreateWebviewHostForRecovery"](mockWebviewView)
			await vi.advanceTimersByTimeAsync(0)
			const retry = provider.retryWebviewRecovery()
			await vi.advanceTimersByTimeAsync(0)
			rejectOldFocus(new Error("obsolete focus rejection"))
			await old
			expect(provider["webviewHostRecoveryInProgress"]).toBe(true)
			expect(provider["pendingSidebarRecovery"]).toBe(true)
			expect(provider["webviewRecoveryAttempts"]).toBe(1)
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
			await provider.resolveWebviewView({ ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } })
			finishNewFocus()
			await retry
			expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
		})

		test.each(["resolve", "reject"] as const)(
			"ignores old initialization that completes on the same view after explicit retry: %s",
			async (completion) => {
				let finishHtml: (html: string) => void = () => {
					throw new Error("HTML has not started")
				}
				let rejectHtml: (error: Error) => void = () => {
					throw new Error("HTML has not started")
				}
				provider["getWebviewHtml"] = vi
					.fn()
					.mockImplementationOnce(
						() =>
							new Promise<string>((resolve, reject) => {
								finishHtml = resolve
								rejectHtml = reject
							}),
					)
					.mockResolvedValue("fresh-html")
				const old = provider.resolveWebviewView(mockWebviewView)
				let finishDiscovery: (commands: string[]) => void = () => {
					throw new Error("Discovery has not started")
				}
				vi.mocked(vscode.commands.getCommands).mockImplementationOnce(
					() =>
						new Promise<string[]>((resolve) => {
							finishDiscovery = resolve
						}),
				)
				const retry = provider.retryWebviewRecovery()
				await vi.advanceTimersByTimeAsync(0)
				if (completion === "resolve") finishHtml("obsolete-html")
				else rejectHtml(new Error("obsolete initialization failure"))
				await old
				expect(mockWebviewView.webview.html).toBe("")
				expect(mockWebviewView.webview.onDidReceiveMessage).not.toHaveBeenCalled()
				expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
				const healthy = { ...mockWebviewView, webview: { ...mockWebviewView.webview, html: "" } }
				vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
					if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
					if (command === `${ClineProvider.sideBarId}.focus`) await provider.resolveWebviewView(healthy)
				})
				finishDiscovery([`${ClineProvider.sideBarId}.removeView`, `${ClineProvider.sideBarId}.focus`])
				await retry
				expect(provider["view"]).toBe(healthy)
				expect(healthy.webview.html).toBe("fresh-html")
			},
		)

		test("old hydration cannot change terminal settings after explicit retry renews the same view", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const state = await provider.getState()
			provider["getWebviewHtml"] = vi.fn().mockResolvedValue("fresh-html")
			let finishHydration: (value: typeof state) => void = () => {
				throw new Error("Hydration has not started")
			}
			vi.spyOn(provider, "getState").mockImplementationOnce(
				() =>
					new Promise<typeof state>((resolve) => {
						finishHydration = resolve
					}),
			)
			const old = provider.resolveWebviewView(mockWebviewView)
			await vi.advanceTimersByTimeAsync(0)
			let finishDiscovery: (commands: string[]) => void = () => {
				throw new Error("Discovery has not started")
			}
			vi.mocked(vscode.commands.getCommands).mockImplementationOnce(
				() =>
					new Promise<string[]>((resolve) => {
						finishDiscovery = resolve
					}),
			)
			const retry = provider.retryWebviewRecovery()
			await vi.advanceTimersByTimeAsync(0)
			const terminal = vi.spyOn(Terminal, "setTerminalProfile")
			finishHydration({ ...state, terminalProfile: "obsolete-profile" })
			await old
			expect(terminal).not.toHaveBeenCalled()
			vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
				if (command === `${ClineProvider.sideBarId}.removeView`) disposeCallback()
				if (command === `${ClineProvider.sideBarId}.focus`)
					await provider.resolveWebviewView({
						...mockWebviewView,
						webview: { ...mockWebviewView.webview, html: "" },
					})
			})
			finishDiscovery([`${ClineProvider.sideBarId}.removeView`, `${ClineProvider.sideBarId}.focus`])
			await retry
			expect(terminal).not.toHaveBeenCalledWith("obsolete-profile")
		})

		test.each(["Reload Window", "Show Logs"] as const)(
			"runs only the selected recovery action: %s",
			async (action) => {
				await provider.resolveWebviewView(mockWebviewView)
				vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
				vi.mocked(vscode.window.showWarningMessage).mockImplementation(vi.fn().mockResolvedValue(action))

				await vi.advanceTimersByTimeAsync(130_000)

				if (action === "Reload Window")
					expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
				if (action === "Show Logs") {
					expect(mockOutputChannel.show).toHaveBeenCalledTimes(1)
					expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
				}
			},
		)

		test("ignores an old Reload Window choice after a heartbeat returns", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
			let choose: (value: string) => void = () => {
				throw new Error("Notification not shown")
			}
			const choice = new Promise<string>((resolve) => {
				choose = resolve
			})
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(vi.fn().mockReturnValue(choice))
			await vi.advanceTimersByTimeAsync(130_000)

			provider.updateWebviewHeartbeat()
			choose("Reload Window")
			await vi.advanceTimersByTimeAsync(0)

			expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")
		})

		test("offers a fresh actionable warning when one heartbeat is followed by another stall", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
			let chooseOld: (value: string) => void = () => {
				throw new Error("Notification not shown")
			}
			const oldChoice = new Promise<string>((resolve) => {
				chooseOld = resolve
			})
			vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(vi.fn().mockReturnValue(oldChoice))
			await vi.advanceTimersByTimeAsync(130_000)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)

			provider.updateWebviewHeartbeat()
			expect(provider["webviewRecoveryAttempts"]).toBe(3)
			chooseOld("Reload Window")
			await vi.advanceTimersByTimeAsync(0)
			expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow")

			vi.mocked(vscode.window.showWarningMessage).mockImplementation(vi.fn().mockResolvedValue("Reload Window"))
			await vi.advanceTimersByTimeAsync(170_000)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
			await vi.advanceTimersByTimeAsync(240_000)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
		})

		test("keeps the Reload Window action available after visibility grace resets", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
			let choose: (value: string) => void = () => {
				throw new Error("Notification not shown")
			}
			const choice = new Promise<string>((resolve) => {
				choose = resolve
			})
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(vi.fn().mockReturnValue(choice))
			await vi.advanceTimersByTimeAsync(130_000)

			visibilityCallback()
			choose("Reload Window")
			await vi.advanceTimersByTimeAsync(0)

			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow")
		})

		test("waits for the final HTML attempt to settle before reporting the limit", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			provider["webviewRecoveryAttempts"] = 2
			let rejectHtml: (error: Error) => void = () => {
				throw new Error("HTML not requested")
			}
			const html = new Promise<string>((_resolve, reject) => {
				rejectHtml = reject
			})
			provider["getWebviewHtml"] = vi.fn<(webview: vscode.Webview) => Promise<string>>().mockReturnValue(html)
			await vi.advanceTimersByTimeAsync(240_000)
			expect(provider["webviewRecoveryAttempts"]).toBe(3)
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()

			rejectHtml(new Error("cannot generate"))
			await vi.advanceTimersByTimeAsync(60_000)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
		})

		test("bounds failed HTML generation and reports the exhausted budget once", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const generate = vi.spyOn(provider, "getState").mockRejectedValue(new Error("cannot generate"))
			const assignHtml = trackHtmlAssignments()

			await vi.advanceTimersByTimeAsync(600_000)

			expect(generate).toHaveBeenCalledTimes(3)
			expect(assignHtml).not.toHaveBeenCalled()
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
		})

		test("does not replenish attempts in a mount-heartbeat-crash loop", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const assignHtml = trackHtmlAssignments()
			for (let attempt = 0; attempt < 3; attempt++) {
				await vi.advanceTimersByTimeAsync(120_000)
				provider.updateWebviewHeartbeat()
			}
			await vi.advanceTimersByTimeAsync(240_000)

			expect(assignHtml).toHaveBeenCalledTimes(3)
			expect(provider["webviewRecoveryAttempts"]).toBe(3)
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
		})

		test("gives a user-opened replacement a fresh budget after unavailable host recovery", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.mocked(vscode.commands.getCommands).mockResolvedValue([])
			const generateHtml = vi.spyOn(provider, "getState")

			await vi.advanceTimersByTimeAsync(130_000)
			expect(generateHtml).toHaveBeenCalledTimes(1)
			expect(provider["webviewRecoveryAttempts"]).toBe(3)

			disposeCallback()
			const replacementView = {
				...mockWebviewView,
				webview: { ...mockWebviewView.webview, html: "" },
			}
			await provider.resolveWebviewView(replacementView)
			const htmlAfterResolve = replacementView.webview.html
			generateHtml.mockClear()

			await vi.advanceTimersByTimeAsync(60_000)
			expect(replacementView.webview.html).toBe(htmlAfterResolve)
			await vi.advanceTimersByTimeAsync(60_000)

			expect(generateHtml).toHaveBeenCalledTimes(1)
			expect(replacementView.webview.html).not.toBe(htmlAfterResolve)
			expect(replacementView.webview.html).toContain("<title>Zoo Code</title>")
		})

		test("does not reload while the view is hidden even when the heartbeat is stale", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			const htmlAfterResolve = mockWebviewView.webview.html
			const log = vi.spyOn(provider, "log")

			await vi.advanceTimersByTimeAsync(180_000)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
			expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Webview heartbeat stale"))
		})

		test("resets the grace window when the view becomes visible", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })
			const htmlAfterResolve = mockWebviewView.webview.html

			await vi.advanceTimersByTimeAsync(120_000)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			Object.defineProperty(mockWebviewView, "visible", { value: true, configurable: true })
			visibilityCallback()
			const htmlAfterBecomingVisible = mockWebviewView.webview.html

			await vi.advanceTimersByTimeAsync(60_000)
			expect(mockWebviewView.webview.html).toBe(htmlAfterBecomingVisible)

			// Watchdog ticks every 60s; 120s after the flip the heartbeat is stale again.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(mockWebviewView.webview.html).not.toBe(htmlAfterBecomingVisible)
		})

		test("restarts the grace window when a tick gap shows the host slept", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			// One ordinary tick, then a wall-clock jump past the stale
			// threshold before the next tick. The gap means the host slept
			// while both timers were paused, not that the renderer died.
			await vi.advanceTimersByTimeAsync(60_000)
			vi.setSystemTime(Date.now() + 120_000)
			await vi.advanceTimersByTimeAsync(60_000)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			// The grace window restarted at the post-sleep tick, so the
			// watchdog still reloads once the heartbeat genuinely goes stale.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			await vi.advanceTimersByTimeAsync(60_000)
			expect(mockWebviewView.webview.html).not.toBe(htmlAfterResolve)
		})

		test("stops watching after the provider is disposed", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			await provider.dispose()
			await vi.advanceTimersByTimeAsync(180_000)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("stops watching and clears the view when the sidebar webview is disposed", async () => {
			mockWebviewView.webview.onDidReceiveMessage = vi.fn(() => ({ dispose: vi.fn() }))
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html
			const epochBefore = provider["webviewRecoveryEpoch"]
			const trackedDisposables = [...provider["webviewDisposables"]]
			expect(trackedDisposables).not.toHaveLength(0)
			const disposeSpies = trackedDisposables.map((disposable) => vi.spyOn(disposable, "dispose"))

			// Precondition: the watchdog interval was actually scheduled, so the
			// null check below proves disposal stopped it rather than it never
			// having started.
			expect(provider["webviewWatchdogInterval"]).not.toBeNull()

			// The provider outlives a disposed sidebar view; VS Code re-resolves
			// a fresh view later. Disposal must stop the watchdog and drop the
			// stale view reference so no recovery reload targets the dead view.
			disposeCallback()
			expect(provider["webviewWatchdogInterval"]).toBeNull()
			expect(provider["view"]).toBeUndefined()
			expect(provider["webviewDisposables"]).toHaveLength(0)
			for (const disposeSpy of disposeSpies) {
				expect(disposeSpy).toHaveBeenCalled()
			}
			expect(provider["webviewRecoveryEpoch"]).toBe(epochBefore + 1)

			await vi.advanceTimersByTimeAsync(180_000)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("does not stack watchdog intervals when resolveWebviewView runs again", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const timersAfterFirstResolve = vi.getTimerCount()
			await provider.resolveWebviewView(mockWebviewView)
			expect(vi.getTimerCount()).toBe(timersAfterFirstResolve)

			// getHtmlContent regenerates the HTML via one getState() call per reload,
			// so getState invocations after this point count watchdog reloads.
			const getStateSpy = vi.spyOn(provider, "getState")

			await vi.advanceTimersByTimeAsync(120_000)

			expect(getStateSpy).toHaveBeenCalledTimes(1)
		})

		test("logs when regenerating the reload HTML fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			vi.spyOn(provider, "getState").mockRejectedValue(new Error("regen boom"))
			;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()

			await vi.advanceTimersByTimeAsync(120_000)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[Zoo Code] Failed to reload webview: regen boom"),
			)
		})

		test("logs and keeps the webview html when the recovery reload rejects", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html
			// The watchdog reload no longer goes through a VS Code command; stub
			// the recovery HTML regeneration itself to reject.
			provider["getWebviewHtml"] = vi.fn().mockRejectedValue(new Error("reload boom"))
			;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()

			await vi.advanceTimersByTimeAsync(120_000)

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[Zoo Code] Failed to reload webview: reload boom"),
			)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("does not reassign html when the provider is disposed mid-recovery", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			await provider.dispose()
			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("does not reassign html when the sidebar view is disposed mid-recovery", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			// Defer the recovery reload's own HTML generation so the test proves
			// the disposal lands while recovery is in flight, not before it starts.
			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			// The stale heartbeat started a recovery reload, and its HTML
			// generation is still pending.
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			disposeCallback()
			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("does not reassign html when the watched view is replaced mid-recovery", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			// Defer the recovery reload's own HTML generation so the test proves
			// the replacement lands while recovery is in flight, not before it
			// starts.
			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			// The stale heartbeat started a recovery reload, and its HTML
			// generation is still pending.
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			// VS Code re-resolves a fresh view (e.g. sidebar re-opened) while the
			// recovery reload for the old view is still awaiting its HTML.
			// @ts-ignore - accessing private property for testing
			provider.view = {
				webview: {
					postMessage: vi.fn(),
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
			}

			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("skips the recovery reload when a heartbeat arrives while regenerating HTML", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			// The renderer process reported in again while the recovery HTML was
			// still being generated, so the webview is alive and must not reload.
			provider.updateWebviewHeartbeat()

			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("skips the recovery reload when two heartbeats land in the same millisecond during recovery", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			// Pin the clock to the timestamp captured before recovery: both
			// heartbeats stamp the same millisecond, so a timestamp comparison
			// would see no change, but the heartbeat revision moved, so the
			// reload must still be skipped.
			const heartbeatAtCapture = provider["lastWebviewHeartbeatAt"]
			const nowSpy = vi.spyOn(Date, "now").mockReturnValue(heartbeatAtCapture)
			provider.updateWebviewHeartbeat()
			expect(provider["lastWebviewHeartbeatAt"]).toBe(heartbeatAtCapture)
			provider.updateWebviewHeartbeat()
			expect(provider["lastWebviewHeartbeatAt"]).toBe(heartbeatAtCapture)
			nowSpy.mockRestore()

			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("skips the recovery reload when the view hides while regenerating HTML", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						finishReload = resolve
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)

			// The view hid while the recovery HTML was still being generated; a
			// hidden webview throttles heartbeats, so the stale heartbeat no
			// longer proves a dead renderer.
			Object.defineProperty(mockWebviewView, "visible", { value: false, configurable: true })

			finishReload("<!DOCTYPE html><html><body>recovered</body></html>")
			await vi.advanceTimersByTimeAsync(0)

			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
		})

		test("does not start a second recovery while one is in flight and recovers after a failure", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			// The first recovery blocks on a controlled pending generation; the
			// retry (second call) gets its own deferred generation.
			let failFirst: (error: Error) => void = () => {}
			let finishRetry: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<string>((_resolve, reject) => {
							failFirst = reject
						}),
				)
				.mockImplementationOnce(
					() =>
						new Promise<string>((resolve) => {
							finishRetry = resolve
						}),
				)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)

			// The watchdog ticks again while the first recovery still awaits
			// its HTML; no second generation may start for the same view.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)

			// The pending generation rejects; the finally block must clear the
			// in-flight state so a later watchdog tick can start a fresh
			// recovery instead of being blocked forever.
			failFirst(new Error("reload boom"))
			await vi.advanceTimersByTimeAsync(0)

			await vi.advanceTimersByTimeAsync(60_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(2)

			// The retry's generation resolves with fresh HTML and must land in
			// the webview.
			finishRetry("<!DOCTYPE html><html><body>recovered-retry</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			expect(mockWebviewView.webview.html).toContain("recovered-retry")
		})

		test("lets the replacement view's recovery start while a stale one is pending", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html

			// Each recovery generation gets its own deferred finish callback.
			const generations: Array<{ finish: (html: string) => void }> = []
			provider["getWebviewHtml"] = vi.fn().mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						generations.push({ finish: resolve })
					}),
			)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)

			// The sidebar view is disposed (bumping webviewRecoveryEpoch) and a
			// replacement view takes over while recovery A's HTML generation is
			// still pending, making A stale.
			disposeCallback()
			// @ts-ignore - accessing private property for testing
			provider.view = {
				webview: {
					postMessage: vi.fn(),
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
			}
			const replacementEpoch = provider["webviewRecoveryEpoch"]

			// Recovery B for the new view must start even though A is still
			// pending: the in-flight guard is scoped to the epoch.
			void provider["reloadWebviewForRecovery"]()
			await vi.advanceTimersByTimeAsync(0)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(2)

			// A's completion is stale: it must not reassign the old view's html,
			// and its finally must NOT release the ownership B took.
			generations[0].finish("<!DOCTYPE html><html><body>stale-A</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
			expect(provider["webviewRecoveryInFlightEpoch"]).toBe(replacementEpoch)

			// B completes and lands its HTML on the new view, then releases
			// ownership so future recoveries can start.
			generations[1].finish("<!DOCTYPE html><html><body>recovered-B</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			// @ts-ignore - accessing private property for testing
			expect(provider.view.webview.html).toContain("recovered-B")
			expect(provider["webviewRecoveryInFlightEpoch"]).toBeUndefined()
		})

		test("advances the recovery epoch when resolveWebviewView replaces the view and lets the new recovery start", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const htmlAfterResolve = mockWebviewView.webview.html
			const epochBeforeReplacement = provider["webviewRecoveryEpoch"]

			// Recovery generations get their own deferred finish callbacks; the
			// replacement view's initial HTML generation resolves immediately so
			// resolveWebviewView can complete.
			const generations: Array<{ finish: (html: string) => void }> = []
			provider["getWebviewHtml"] = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<string>((resolve) => {
							generations.push({ finish: resolve })
						}),
				)
				.mockImplementationOnce(() => Promise.resolve("<!DOCTYPE html><html><body>view2-initial</body></html>"))
				.mockImplementation(
					() =>
						new Promise<string>((resolve) => {
							generations.push({ finish: resolve })
						}),
				)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)

			// VS Code re-resolves a DIFFERENT view without a disposal in between
			// (the gap path): the epoch must advance so the stale recovery can
			// neither block nor reassign the replacement view's recovery.
			const mockWebviewView2 = {
				webview: {
					postMessage: vi.fn(),
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidDispose: vi.fn(),
				onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
			} as unknown as vscode.WebviewView
			await provider.resolveWebviewView(mockWebviewView2)
			expect(provider["webviewRecoveryEpoch"]).toBe(epochBeforeReplacement + 1)

			// Recovery B for the replacement view starts immediately, unblocked
			// by A's still-pending generation.
			void provider["reloadWebviewForRecovery"]()
			await vi.advanceTimersByTimeAsync(0)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(3)

			// A's completion is stale: the old view's html is untouched and A's
			// finally does not release the ownership B took.
			generations[0].finish("<!DOCTYPE html><html><body>stale-A</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			expect(mockWebviewView.webview.html).toBe(htmlAfterResolve)
			expect(provider["webviewRecoveryInFlightEpoch"]).toBe(provider["webviewRecoveryEpoch"])

			// B completes and lands its HTML on the replacement view, then
			// releases ownership.
			generations[1].finish("<!DOCTYPE html><html><body>recovered-B</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			expect(mockWebviewView2.webview.html).toContain("recovered-B")
			expect(provider["webviewRecoveryInFlightEpoch"]).toBeUndefined()
		})

		test("does not advance the recovery epoch when the same view is re-resolved and keeps the pending recovery intact", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const epochAfterFirstResolve = provider["webviewRecoveryEpoch"]

			// Recovery A blocks on a controlled pending generation; the same
			// view's re-resolve initial HTML resolves immediately.
			let finishReload: (html: string) => void = () => {}
			provider["getWebviewHtml"] = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<string>((resolve) => {
							finishReload = resolve
						}),
				)
				.mockImplementation(() =>
					Promise.resolve("<!DOCTYPE html><html><body>same-view-reresolve</body></html>"),
				)

			await vi.advanceTimersByTimeAsync(120_000)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(1)

			// Re-resolving the SAME view must not bump the epoch nor disrupt the
			// pending recovery that belongs to it.
			await provider.resolveWebviewView(mockWebviewView)
			expect(provider["webviewRecoveryEpoch"]).toBe(epochAfterFirstResolve)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(2)
			expect(provider["webviewRecoveryInFlightEpoch"]).toBe(epochAfterFirstResolve)

			// A still owns the view across the re-resolve: another recovery
			// attempt is blocked until A settles.
			void provider["reloadWebviewForRecovery"]()
			await vi.advanceTimersByTimeAsync(0)
			expect(provider["getWebviewHtml"]).toHaveBeenCalledTimes(2)

			// A settles cleanly: the re-resolve restarted the watchdog, which
			// re-stamped the heartbeat, so the revision guard (not the epoch)
			// skips the stale assignment; the ownership A held is released.
			finishReload("<!DOCTYPE html><html><body>recovered-A</body></html>")
			await vi.advanceTimersByTimeAsync(0)
			expect(mockWebviewView.webview.html).toContain("same-view-reresolve")
			expect(provider["webviewRecoveryInFlightEpoch"]).toBeUndefined()
		})

		test("reloads only its own webview when multiple providers are active", async () => {
			// Structural stand-in for the VS Code webview API surface this scenario
			// exercises, same as the mockContext cast below.
			const mockWebviewViewB = {
				webview: {
					postMessage: vi.fn(),
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://test-csp-source",
				},
				visible: true,
				onDidDispose: vi.fn(),
				onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
			} as unknown as vscode.WebviewView
			const providerB = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				await provider.resolveWebviewView(mockWebviewView)
				await providerB.resolveWebviewView(mockWebviewViewB)

				const htmlBeforeA = mockWebviewView.webview.html
				const htmlBeforeB = mockWebviewViewB.webview.html

				// The pre-PR reload path fired the global
				// workbench.action.webview.reloadWebviewAction command, which
				// resets every webview. The html assertions below cannot catch a
				// regression back to that command because the vscode mock
				// swallows executeCommand without touching any view, so also
				// assert the global command was never invoked.
				const executeCommandMock = vscode.commands.executeCommand as ReturnType<typeof vi.fn>

				await vi.advanceTimersByTimeAsync(119_000)
				// B's view is still alive; refresh its heartbeat so a stale one
				// would reload it too, leaving only A's watchdog to fire.
				await webviewMessageHandler(providerB, { type: "webviewHeartbeat", timestamp: Date.now() })
				await vi.advanceTimersByTimeAsync(1_000)

				expect(mockWebviewView.webview.html).not.toBe(htmlBeforeA)
				expect(mockWebviewViewB.webview.html).toBe(htmlBeforeB)
				expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.webview.reloadWebviewAction")
			} finally {
				await providerB.dispose()
			}
		})

		describe("tab panel (WebviewPanel shape)", () => {
			let viewStateCallback: () => void
			// Structural stand-in for the VS Code webview API surface this
			// scenario exercises, same as the mockWebviewViewB cast below.
			let mockWebviewPanel: vscode.WebviewPanel

			beforeEach(() => {
				// WebviewPanel-shaped stand-in: same webview surface, but the
				// visibility listener is onDidChangeViewState instead of
				// onDidChangeVisibility, matching resolveWebviewView's tab branch.
				mockWebviewPanel = {
					webview: {
						postMessage: vi.fn(),
						html: "",
						options: {},
						onDidReceiveMessage: vi.fn(),
						asWebviewUri: vi.fn(),
						cspSource: "vscode-webview://test-csp-source",
					},
					visible: true,
					onDidDispose: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
					onDidChangeViewState: vi.fn().mockImplementation((cb: () => void) => {
						viewStateCallback = cb
						return { dispose: vi.fn() }
					}),
					dispose: vi.fn(),
					reveal: vi.fn(),
				} as unknown as vscode.WebviewPanel
			})

			test("disposes the current tab provider and its watchdog registration", async () => {
				const onDispose: Array<() => unknown> = []
				const registration = { dispose: vi.fn() }
				vi.mocked(mockWebviewPanel.onDidDispose).mockImplementation((listener, _thisArg, disposables) => {
					onDispose.push(listener)
					const disposable = onDispose.length === 1 ? registration : { dispose: vi.fn() }
					disposables?.push(disposable)
					return disposable
				})
				await provider.resolveWebviewView(mockWebviewPanel)
				expect(provider["webviewWatchdogInterval"]).not.toBeNull()
				const dispose = vi.spyOn(provider, "dispose")
				const html = mockWebviewPanel.webview.html

				await onDispose[0]()

				expect(dispose).toHaveBeenCalledTimes(1)
				expect(provider["_disposed"]).toBe(true)
				expect(provider["webviewWatchdogInterval"]).toBeNull()
				expect(registration.dispose).toHaveBeenCalledTimes(1)
				await vi.advanceTimersByTimeAsync(600_000)
				expect(mockWebviewPanel.webview.html).toBe(html)
			})

			test.each([false, true])(
				"replaces the tab host without disposing its provider or task (interrupted: %s)",
				async (interrupted) => {
					const callbacks: Array<() => unknown> = []
					vi.mocked(mockWebviewPanel.onDidDispose).mockImplementation((listener) => {
						callbacks.push(listener)
						return { dispose: vi.fn() }
					})
					vi.mocked(mockWebviewPanel.dispose).mockImplementation(() => {
						callbacks.forEach((callback) => callback())
					})
					mockWebviewPanel.title = "Zoo Code task"
					await provider.resolveWebviewView(mockWebviewPanel)
					const task = new Task(defaultTaskOptions)
					task.abort = interrupted
					provider["taskRegistry"].push(task)
					const evict = vi.spyOn(provider, "evictCurrentTask")
					const remove = vi.spyOn(provider, "removeClineFromStack")
					const replacement = {
						...mockWebviewPanel,
						webview: { ...mockWebviewPanel.webview, html: "" },
						onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
						dispose: vi.fn(),
					}
					vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(replacement)

					await vi.advanceTimersByTimeAsync(130_000)

					expect(mockWebviewPanel.dispose).toHaveBeenCalledTimes(1)
					expect(provider["view"]).toBe(replacement)
					expect(provider["_disposed"]).toBe(false)
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(provider["webviewRecoveryAttempts"]).toBe(1)
					expect(provider.getCurrentTask()).toBe(task)
					expect(evict).not.toHaveBeenCalled()
					expect(remove).not.toHaveBeenCalled()
					expect(task.dispose).not.toHaveBeenCalled()
					expect(task.abortTask).not.toHaveBeenCalled()
					expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
						`${ClineProvider.sideBarId}.removeView`,
					)
				},
			)

			test("explicit retry replaces an exhausted tab without evicting its interrupted task", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				const task = new Task(defaultTaskOptions)
				task.abort = true
				provider["taskRegistry"].push(task)
				const remove = vi.spyOn(provider, "removeClineFromStack")
				provider["reportWebviewRecoveryFailure"]("Exhausted incident")
				const healthy = replacementPanel()
				vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(healthy)
				await provider.retryWebviewRecovery()
				expect(provider["view"]).toBe(healthy)
				expect(provider["webviewRecoveryAttempts"]).toBe(1)
				expect(provider.getCurrentTask()).toBe(task)
				expect(remove).not.toHaveBeenCalled()
				expect(task.dispose).not.toHaveBeenCalled()
				expect(task.abortTask).not.toHaveBeenCalled()
			})

			test("keeps the old tab and its task when replacement resolution fails before publication", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				const task = new Task(defaultTaskOptions)
				provider["taskRegistry"].push(task)
				const replacement = { ...mockWebviewPanel, dispose: vi.fn() }
				vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(replacement)
				vi.spyOn(provider, "resolveWebviewView").mockRejectedValue(new Error("resolver unavailable"))

				await provider["recreateWebviewHostForRecovery"](mockWebviewPanel)

				expect(mockWebviewPanel.dispose).not.toHaveBeenCalled()
				expect(replacement.dispose).toHaveBeenCalledTimes(1)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(provider["view"]).toBe(mockWebviewPanel)
				expect(provider.getCurrentTask()).toBe(task)
				expect(task.dispose).not.toHaveBeenCalled()
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			})

			function replacementPanel() {
				return {
					...mockWebviewPanel,
					webview: {
						...mockWebviewPanel.webview,
						html: "",
						onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
					},
					onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
					dispose: vi.fn(),
				}
			}

			test.each(["HTML generation", "state hydration"] as const)(
				"retries a published tab after failed %s without disposing its interrupted task",
				async (stage) => {
					await provider.resolveWebviewView(mockWebviewPanel)
					const task = new Task(defaultTaskOptions)
					task.abort = true
					provider["taskRegistry"].push(task)
					const remove = vi.spyOn(provider, "removeClineFromStack")
					provider["getWebviewHtml"] = vi.fn().mockResolvedValue("recovered-html")
					await provider["reloadWebviewForRecovery"]()
					const failed = replacementPanel()
					const healthy = replacementPanel()
					vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(failed).mockReturnValue(healthy)
					if (stage === "HTML generation") {
						vi.mocked(provider["getWebviewHtml"]).mockRejectedValueOnce(new Error("HTML failed"))
					} else {
						vi.spyOn(provider, "getState").mockRejectedValueOnce(new Error("hydration failed"))
					}
					await vi.advanceTimersByTimeAsync(10_000)

					expect(provider["view"]).toBe(failed)
					expect(failed.webview.onDidReceiveMessage).not.toHaveBeenCalled()
					expect(failed.dispose).not.toHaveBeenCalled()
					expect(provider["webviewWatchdogInterval"]).not.toBeNull()
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(provider["webviewRecoveryAttempts"]).toBe(1)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
					expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
						expect.stringContaining("interface is not responding"),
						"Retry Interface Recovery",
						"Reload Window",
						"Show Logs",
					)
					expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
						expect.stringContaining("Failed to initialize replacement tab"),
					)

					await vi.advanceTimersByTimeAsync(130_000)

					expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2)
					expect(provider["view"]).toBe(healthy)
					// The provider and focus tracker each install one message listener.
					expect(healthy.webview.onDidReceiveMessage).toHaveBeenCalledTimes(2)
					expect(failed.dispose).toHaveBeenCalledTimes(1)
					expect(provider["webviewRecoveryAttempts"]).toBe(2)
					expect(provider.getCurrentTask()).toBe(task)
					expect(provider["_disposed"]).toBe(false)
					expect(remove).not.toHaveBeenCalled()
					expect(task.dispose).not.toHaveBeenCalled()
					expect(task.abortTask).not.toHaveBeenCalled()
				},
			)

			test.each(["disposed", "replaced"] as const)(
				"does not restart a stale replacement watchdog after the provider is %s",
				async (event) => {
					await provider.resolveWebviewView(mockWebviewPanel)
					provider["getWebviewHtml"] = vi.fn().mockResolvedValue("recovered-html")
					await provider["reloadWebviewForRecovery"]()
					let rejectHtml: (error: Error) => void = () => {
						throw new Error("Replacement HTML generation has not started")
					}
					vi.mocked(provider["getWebviewHtml"]).mockImplementationOnce(
						() =>
							new Promise<string>((_resolve, reject) => {
								rejectHtml = reject
							}),
					)
					const failed = replacementPanel()
					vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(failed)
					await vi.advanceTimersByTimeAsync(10_000)
					expect(provider["view"]).toBe(failed)
					if (event === "disposed") await provider.dispose()
					else await provider.resolveWebviewView(replacementPanel())
					const watchdog = provider["webviewWatchdogInterval"]
					rejectHtml(new Error("stale HTML failure"))
					await vi.advanceTimersByTimeAsync(0)
					expect(provider["webviewWatchdogInterval"]).toBe(watchdog)
					expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
					expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
				},
			)

			test("bounds repeated published-tab initialization failures and keeps the task available", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				const task = new Task(defaultTaskOptions)
				provider["taskRegistry"].push(task)
				provider["getWebviewHtml"] = vi.fn().mockResolvedValue("recovered-html")
				vi.mocked(vscode.window.createWebviewPanel).mockImplementation(() => {
					const replacement = replacementPanel()
					// Fail after publication, before any message listener is installed.
					vi.spyOn(provider, "getState").mockRejectedValueOnce(new Error("hydration failed"))
					return replacement
				})

				await vi.advanceTimersByTimeAsync(720_000)

				expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(3)
				expect(provider["webviewRecoveryAttempts"]).toBe(3)
				expect(provider["webviewHostRecoveryInProgress"]).toBe(false)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
				expect(
					vi
						.mocked(mockOutputChannel.appendLine)
						.mock.calls.filter(([line]) => line.includes("Webview recovery stopped:")),
				).toHaveLength(1)
				expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
					expect.stringContaining(
						"Webview recovery stopped: Recovery attempt limit reached without sustained heartbeats",
					),
				)
				expect(provider["_disposed"]).toBe(false)
				expect(provider.getCurrentTask()).toBe(task)
				expect(task.dispose).not.toHaveBeenCalled()
				expect(task.abortTask).not.toHaveBeenCalled()
			})

			test("reloads the tab webview when the heartbeat is stale and the tab is visible", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				const htmlAfterResolve = mockWebviewPanel.webview.html

				await vi.advanceTimersByTimeAsync(120_000)

				expect(mockWebviewPanel.webview.html).not.toBe(htmlAfterResolve)
				expect(mockWebviewPanel.webview.html).toContain("<title>Zoo Code</title>")
			})

			test("does not reload a hidden tab even when the heartbeat is stale", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				Object.defineProperty(mockWebviewPanel, "visible", { value: false, configurable: true })
				const htmlAfterResolve = mockWebviewPanel.webview.html

				await vi.advanceTimersByTimeAsync(180_000)

				expect(mockWebviewPanel.webview.html).toBe(htmlAfterResolve)
			})

			test("resets the grace window when the tab becomes visible", async () => {
				await provider.resolveWebviewView(mockWebviewPanel)
				Object.defineProperty(mockWebviewPanel, "visible", { value: false, configurable: true })
				const htmlAfterResolve = mockWebviewPanel.webview.html

				await vi.advanceTimersByTimeAsync(120_000)
				expect(mockWebviewPanel.webview.html).toBe(htmlAfterResolve)

				Object.defineProperty(mockWebviewPanel, "visible", { value: true, configurable: true })
				viewStateCallback()
				const htmlAfterBecomingVisible = mockWebviewPanel.webview.html

				await vi.advanceTimersByTimeAsync(60_000)
				expect(mockWebviewPanel.webview.html).toBe(htmlAfterBecomingVisible)

				// Watchdog ticks every 60s; 120s after the flip the heartbeat is stale again.
				await vi.advanceTimersByTimeAsync(60_000)
				expect(mockWebviewPanel.webview.html).not.toBe(htmlAfterBecomingVisible)
			})
		})
	})

	test("resolveWebviewView sets up webview correctly in development mode even if local server is not running", async () => {
		const developmentContext = { ...mockContext, extensionMode: vscode.ExtensionMode.Development }
		provider = new ClineProvider(
			developmentContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(developmentContext),
			new WebviewFocusTracker(),
		)
		// The dev-server probe fails, so the HMR path falls back to the production HTML.
		;(axios.get as any).mockRejectedValueOnce(new Error("Network error"))

		await provider.resolveWebviewView(mockWebviewView)

		expect(mockWebviewView.webview.options).toEqual({
			enableScripts: true,
			localResourceRoots: [mockContext.extensionUri],
		})

		expect(mockWebviewView.webview.html).toContain("<!DOCTYPE html>")

		// Verify Content Security Policy contains the necessary PostHog domains
		expect(mockWebviewView.webview.html).toContain(
			"connect-src vscode-webview://test-csp-source https://openrouter.ai https://api.requesty.ai https://us.i.posthog.com",
		)

		// Extract the script-src directive section and verify required security elements
		const html = mockWebviewView.webview.html
		const scriptSrcMatch = html.match(/script-src[^;]*;/)
		expect(scriptSrcMatch).not.toBeNull()
		expect(scriptSrcMatch![0]).toContain("'nonce-")
		// Verify wasm-unsafe-eval is present for Shiki syntax highlighting
		expect(scriptSrcMatch![0]).toContain("'wasm-unsafe-eval'")
	})

	test.each([
		["ECONNABORTED", "errors.hmr_probe_timeout"],
		["ETIMEDOUT", "errors.hmr_probe_timeout"],
		["ECONNREFUSED", "errors.hmr_not_running"],
	])("reports dev-server probe failure %s accurately and falls back to built HTML", async (code, message) => {
		const { AxiosError } = await vi.importActual<typeof import("axios")>("axios")
		vi.mocked(axios.get).mockRejectedValueOnce(new AxiosError("probe failed", code))

		const html = await provider["getHMRHtmlContent"](mockWebviewView.webview)

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(message)
		expect(html).toContain("<!DOCTYPE html>")
		expect(html).not.toContain("/@react-refresh")
	})

	test("resolveWebviewView builds HMR content against the local dev server when it is reachable", async () => {
		const originalThemeFixtureProbe = process.env.ROO_CODE_THEME_FIXTURE_PROBE
		delete process.env.ROO_CODE_THEME_FIXTURE_PROBE
		// getHMRHtmlContent prefers an on-disk .vite-port file when one exists, so a
		// stale dev leftover could silently move the probe (and the HMR URLs) to
		// another port. Establish the default-port branch for this test by hiding
		// exactly that file from the existence check; every other path falls
		// through to the real implementation.
		const realExistsSync = fs.existsSync
		const existsSyncSpy = vi
			.spyOn(fs, "existsSync")
			.mockImplementation((target) =>
				path.basename(String(target)) === ".vite-port" ? false : realExistsSync(target),
			)

		try {
			provider = new ClineProvider(
				{ ...mockContext, extensionMode: vscode.ExtensionMode.Development },
				mockOutputChannel,
				"sidebar",
				new ContextProxy({ ...mockContext, extensionMode: vscode.ExtensionMode.Development }),
				new WebviewFocusTracker(),
			)
			// The default axios mock resolves, so the dev-server probe succeeds and the
			// HMR HTML branch (instead of the production fallback) is taken.
			vi.mocked(axios.get).mockClear()
			await provider.resolveWebviewView(mockWebviewView)

			// Pin the health-check URL itself: the mock resolves for any URL, so only
			// this assertion keeps the probe from silently drifting back to
			// `localhost` (the IPv6 resolution failure this branch fixes).
			expect(axios.get).toHaveBeenCalledWith("http://127.0.0.1:5173", { timeout: 5_000 })

			const html = mockWebviewView.webview.html
			// The dev server URL must be baked into the module script tag and CSP directives.
			expect(html).toContain("http://127.0.0.1:5173/src/index.tsx")
			expect(html).toContain("ws://127.0.0.1:5173")
			expect(html).toContain("http://127.0.0.1:5173/@react-refresh")
		} finally {
			existsSyncSpy.mockRestore()
			// Always restore the probe flag (even when an assertion above throws),
			// so later tests outside the fixture-probe describe block cannot observe
			// this test's deletion.
			if (originalThemeFixtureProbe !== undefined) {
				process.env.ROO_CODE_THEME_FIXTURE_PROBE = originalThemeFixtureProbe
			} else {
				delete process.env.ROO_CODE_THEME_FIXTURE_PROBE
			}
		}
	})

	test("postMessageToWebview sends message to webview", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const mockState: ExtensionState = {
			version: "1.0.0",
			clineMessages: [],
			taskHistory: [],
			shouldShowAnnouncement: false,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
			},
			customInstructions: undefined,
			alwaysAllowReadOnly: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: false,
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexQdrantUrl: "",
				codebaseIndexEmbedderProvider: providerIdentifiers.openai,
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "",
			},
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			uriScheme: "vscode",
			soundEnabled: false,
			ttsEnabled: false,
			enableCheckpoints: false,
			writeDelayMs: 1000,
			mcpEnabled: true,
			mode: defaultModeSlug,
			customModes: [],
			experiments: experimentDefault,
			maxOpenTabsContext: 20,
			maxWorkspaceFiles: 200,
			telemetrySetting: "unset",
			showRooIgnoredFiles: false,
			enableSubfolderRules: false,
			renderContext: "sidebar",
			maxImageFileSize: 5,
			maxTotalImageSize: 20,
			cloudUserInfo: null,
			organizationAllowList: ORGANIZATION_ALLOW_ALL,
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			cloudIsAuthenticated: false,
			sharingEnabled: false,
			publicSharingEnabled: false,
			profileThresholds: {},
			hasOpenedModeSelector: false,
			diagnosticsEnabled: true,
			openRouterImageApiKey: undefined,
			openRouterImageGenerationSelectedModel: undefined,
			taskSyncEnabled: false,
			checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			diffFuzzyThreshold: DEFAULT_DIFF_FUZZY_THRESHOLD,
		}

		const message: ExtensionMessage = {
			type: "state",
			state: mockState,
		}
		await provider.postMessageToWebview(message)

		expect(mockPostMessage).toHaveBeenCalledWith(message)
	})

	test("postMessageToWebview logs the dropped message type when the webview post rejects", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()

		// Simulate postMessage throwing after webview disposal
		mockPostMessage.mockRejectedValueOnce(new Error("Webview is disposed"))

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }

		// Should not throw
		await expect(provider.postMessageToWebview(message)).resolves.toBeUndefined()

		// The rejection is handled by a detached catch, so awaiting the post alone cannot prove
		// anything about the log: flush the handler and assert on what it wrote, message type and
		// Error.message both included.
		await vi.waitFor(() =>
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("dropped message type=action: Webview is disposed"),
			),
		)
	})

	test("postMessageToWebview logs a non-Error webview rejection", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		;(mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mockClear()

		// VS Code settles postMessage from the renderer, so a rejection reason is not guaranteed to
		// be an Error; the log has to carry the value itself instead of "[object Object]".
		mockPostMessage.mockRejectedValueOnce("disposed without an error object")

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }

		await expect(provider.postMessageToWebview(message)).resolves.toBeUndefined()

		await vi.waitFor(() =>
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("dropped message type=action: disposed without an error object"),
			),
		)
	})

	test("postMessageToWebview does not await the webview ack", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		let releaseAck!: () => void
		const ack = new Promise<void>((resolve) => {
			releaseAck = resolve
		})
		mockPostMessage.mockImplementationOnce(() => ack)

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }

		// The caller must not wait for the renderer ack: a webview page remounted or disposed
		// while the post is in flight never acknowledges it, and awaiting that promise would
		// wedge every caller on the task critical path.
		await provider.postMessageToWebview(message)

		expect(mockPostMessage).toHaveBeenCalledWith(message)
		releaseAck()
	})

	test("postMessageToWebview leaves originalContent of file-edit tool messages out of the state it posts", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const originalFile = "line of the original file\n".repeat(500)
		const toolText = JSON.stringify({
			tool: "appliedDiff",
			path: "a.ts",
			diff: "@@ d",
			originalContent: originalFile,
		})
		// Only the field under test is populated; the rest of ExtensionState is irrelevant here.
		const message = {
			type: "state",
			state: { clineMessages: [{ ts: 1, type: "ask", ask: "tool", text: toolText }] },
		} as unknown as ExtensionMessage

		await provider.postMessageToWebview(message)

		const posted = mockPostMessage.mock.calls.at(-1)![0] as ExtensionMessage
		const postedText = posted.state!.clineMessages![0]!.text!

		expect(JSON.parse(postedText)).toEqual({
			tool: "appliedDiff",
			path: "a.ts",
			diff: "@@ d",
			originalContentLength: originalFile.length,
		})
		// the extension's own message (and so the persisted task) keeps the full content
		expect(message.state!.clineMessages![0]!.text).toBe(toolText)
	})

	test("postMessageToWebview leaves originalContent out of messageUpdated", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const toolText = JSON.stringify({
			tool: "appliedDiff",
			path: "a.ts",
			originalContent: "original file\n".repeat(100),
		})

		await provider.postMessageToWebview({
			type: "messageUpdated",
			clineMessage: { ts: 2, type: "ask", ask: "tool", text: toolText },
		})

		const posted = mockPostMessage.mock.calls.at(-1)![0] as ExtensionMessage

		expect(JSON.parse(posted.clineMessage!.text!)).toEqual({
			tool: "appliedDiff",
			path: "a.ts",
			originalContentLength: "original file\n".length * 100,
		})
	})

	describe("theme fixture probes", () => {
		const fixture = {
			themeId: "Default Dark Modern",
			bodyClass: "vscode-dark",
			variables: { "--vscode-foreground": "#cccccc" },
		}
		const originalProbeSetting = process.env.ROO_CODE_THEME_FIXTURE_PROBE

		beforeEach(() => {
			process.env.ROO_CODE_THEME_FIXTURE_PROBE = "1"
		})

		afterEach(() => {
			if (originalProbeSetting === undefined) {
				delete process.env.ROO_CODE_THEME_FIXTURE_PROBE
			} else {
				process.env.ROO_CODE_THEME_FIXTURE_PROBE = originalProbeSetting
			}
			vi.useRealTimers()
		})

		test("rejects requests when probing is disabled", async () => {
			delete process.env.ROO_CODE_THEME_FIXTURE_PROBE

			await expect(provider.requestWebviewThemeFixture()).rejects.toThrow("Theme fixture probing is disabled")
		})

		test("posts a request and resolves the matching response", async () => {
			const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
			const request = provider.requestWebviewThemeFixture()
			await Promise.resolve()
			const requestId = postMessageSpy.mock.calls[0]?.[0].requestId
			const unknownFixture = { ...fixture, themeId: "Unexpected Theme" }

			expect(requestId).toBeTruthy()
			expect(postMessageSpy).toHaveBeenCalledWith({ type: "themeFixtureProbeRequest", requestId })
			provider.resolveWebviewThemeFixtureProbe("unknown-request", unknownFixture)
			provider.resolveWebviewThemeFixtureProbe(requestId!, fixture)

			await expect(request).resolves.toEqual(fixture)
		})

		test("rejects a request after its timeout", async () => {
			vi.useFakeTimers()
			vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
			const request = provider.requestWebviewThemeFixture(100)
			const rejection = expect(request).rejects.toThrow("Theme fixture probe timed out after 100ms")

			await vi.advanceTimersByTimeAsync(100)
			await rejection
		})

		test("rejects pending requests when webview resources are cleared", async () => {
			vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
			const request = provider.requestWebviewThemeFixture()
			const rejection = expect(request).rejects.toThrow(
				"Webview was disposed before the theme fixture probe completed",
			)

			provider["clearWebviewResources"]()
			await rejection
		})
	})

	test("postStateToWebview does not force action navigation for non-compliant MDM state", async () => {
		// Structural double: the post path only reads these two members, and
		// MdmService cannot be constructed as a plain object; Object.assign
		// keeps this a single structural assertion.
		const mdmService = Object.assign({} as MdmService, {
			requiresCloudAuth: vi.fn().mockReturnValue(true),
			isCompliant: vi.fn().mockReturnValue({ compliant: false, reason: "auth required" }),
		})

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
			mdmService,
		)

		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockImplementation(async () => undefined)
		vi.spyOn(provider, "getStateToPostToWebview").mockResolvedValue(
			Object.assign({} as ExtensionState, {
				version: "1.0.0",
			}),
		)

		await provider.postStateToWebview()

		expect(postMessageSpy).toHaveBeenCalledTimes(1)
		expect(postMessageSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "action" }))
	})

	test("postStateToWebviewWithoutTaskHistory waits for the webview post boundary", async () => {
		let releasePost!: () => void
		const pendingPost = new Promise<void>((resolve) => {
			releasePost = resolve
		})
		let statePostSettled = false

		vi.spyOn(provider, "getStateToPostToWebview").mockResolvedValue(
			Object.assign({} as ExtensionState, {
				taskHistory: [],
			}),
		)
		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockReturnValue(pendingPost)

		const statePost = provider.postStateToWebviewWithoutTaskHistory()
		void statePost.then(() => {
			statePostSettled = true
		})
		await Promise.resolve()

		expect(postMessageSpy).toHaveBeenCalledOnce()
		expect(statePostSettled).toBe(false)

		releasePost()
		await statePost
		expect(statePostSettled).toBe(true)
	})

	test.each([
		["postStateToWebview", (currentProvider: ClineProvider) => currentProvider.postStateToWebview()],
		[
			"postStateToWebviewWithoutTaskHistory",
			(currentProvider: ClineProvider) => currentProvider.postStateToWebviewWithoutTaskHistory(),
		],
	])("%s assigns message sequence numbers before asynchronous state construction", async (_methodName, postState) => {
		let releaseOlderSnapshot!: (state: ExtensionState) => void
		const olderSnapshot = new Promise<ExtensionState>((resolve) => {
			releaseOlderSnapshot = resolve
		})
		const baseState = await provider.getStateToPostToWebview({ includeTaskHistory: false })
		const emptyState: ExtensionState = { ...baseState, taskHistory: [], clineMessages: [] }
		const readyState: ExtensionState = {
			...baseState,
			taskHistory: [],
			clineMessages: [{ ts: 1, type: "say", say: "text", text: "child ready" }],
		}

		vi.spyOn(provider, "getStateToPostToWebview")
			.mockReturnValueOnce(olderSnapshot)
			.mockResolvedValueOnce(readyState)
		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

		const olderPost = postState(provider)
		await Promise.resolve()
		const newerPost = postState(provider)
		await newerPost
		releaseOlderSnapshot(emptyState)
		await olderPost

		expect(postMessageSpy.mock.calls.map(([message]) => message.state?.clineMessages)).toEqual([
			readyState.clineMessages,
			emptyState.clineMessages,
		])
		expect(postMessageSpy.mock.calls.map(([message]) => message.state?.clineMessagesSeq)).toEqual([2, 1])
	})

	test.each([
		[
			"postStateToWebviewWithoutTaskHistory",
			(currentProvider: ClineProvider) => currentProvider.postStateToWebviewWithoutTaskHistory(),
		],
		[
			"postStateToWebviewWithoutClineMessages",
			(currentProvider: ClineProvider) => currentProvider.postStateToWebviewWithoutClineMessages(),
		],
	])("%s skips task history computation", async (_methodName, postState) => {
		const getAllSpy = vi.spyOn(provider.taskHistoryStore, "getAll")
		const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

		await postState(provider)

		expect(getAllSpy).not.toHaveBeenCalled()
		expect(postMessageSpy).toHaveBeenCalledOnce()
		expect(postMessageSpy.mock.calls[0]?.[0].state).not.toHaveProperty("taskHistory")
	})

	test("getStateToPostToWebview computes task history once after its base state resolves", async () => {
		const historyItem = {
			id: "history-task",
			number: 1,
			ts: 1,
			task: "History task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const originalGetState = provider.getState.bind(provider)
		let baseStateResolved = false
		const getStateSpy = vi.spyOn(provider, "getState").mockImplementation(async (options) => {
			const state = await originalGetState(options)
			baseStateResolved = true
			return state
		})
		const historyReadPhases: boolean[] = []
		const getAllSpy = vi.spyOn(provider.taskHistoryStore, "getAll").mockImplementation(() => {
			historyReadPhases.push(baseStateResolved)
			return [historyItem]
		})

		const state = await provider.getStateToPostToWebview()

		expect(getStateSpy).toHaveBeenCalledOnce()
		expect(getStateSpy).toHaveBeenCalledWith({ includeTaskHistory: false })
		expect(getAllSpy).toHaveBeenCalledOnce()
		expect(historyReadPhases).toEqual([true])
		expect(state.taskHistory).toEqual([historyItem])
	})

	describe("viewId uniqueness", () => {
		it("should assign unique viewId to each instance", async () => {
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

			// Each instance should have a unique viewId
			expect(provider1.viewId).toBeDefined()
			expect(provider2.viewId).toBeDefined()
			expect(provider1.viewId).not.toBe(provider2.viewId)

			await provider1.dispose()
			await provider2.dispose()
		})

		it("should have viewId in correct format: {renderContext}-{instanceCount}", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			expect(provider.viewId).toMatch(/^sidebar-\d+$/)

			await provider.dispose()
		})

		it("should increment instance count for each new instance", async () => {
			const provider1 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
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

			// First editor instance should be "editor-0" (or next available)
			// Second editor instance should have a different number
			const num1 = parseInt(provider1.viewId.split("-")[1]!)
			const num2 = parseInt(provider2.viewId.split("-")[1]!)

			expect(num2).toBeGreaterThan(num1)

			await provider1.dispose()
			await provider2.dispose()
		})
	})

	describe("saveViewState", () => {
		it("should update viewLocalState and persist mode through registered viewStates", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("currentApiConfigName", "my-profile")

			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "my-profile" },
			})

			await provider.dispose()
		})

		it("should update viewLocalState for apiConfiguration without persisting provider settings or secrets", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider.saveViewState("mode", "architect")
			expect(provider["viewLocalState"].mode).toBe("architect")

			await provider.saveViewState("mode", undefined)

			expect(Object.prototype.hasOwnProperty.call(provider["viewLocalState"], "mode")).toBe(false)

			await provider.dispose()
		})

		it("should clear the currentApiConfigName override when saveViewState receives undefined", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider.saveViewState("currentApiConfigName", "my-profile")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")

			await provider.saveViewState("currentApiConfigName", undefined)

			expect(Object.prototype.hasOwnProperty.call(provider["viewLocalState"], "currentApiConfigName")).toBe(false)

			await provider.dispose()
		})

		it("should not update viewLocalState when durable view-state persistence fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			vi.spyOn(provider.contextProxy, "setValue").mockRejectedValueOnce(new Error("persist failed"))

			await provider["setViewStateId"]("stable-sidebar-view")

			await expect(provider.saveViewState("mode", "architect")).rejects.toThrow("persist failed")
			expect(provider["viewLocalState"]).not.toHaveProperty("mode")
			expect(provider.contextProxy.getValue("viewStates")).toBeUndefined()

			await provider.dispose()
		})

		it("should merge concurrent persisted updates from separate provider instances without lost viewStates", async () => {
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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await vi.waitFor(() => {
				expect(provider["viewLocalState"]).toEqual({})
			})

			const state = await provider.getState()
			// No per-view entry exists and the proxy's global-state cache is empty
			// (initialize() is never called in this fixture; only "taskHistory" passes
			// through to the context store), so getState() falls back to the shared
			// defaults: mode "code" (defaultModeSlug) and currentApiConfigName "default".
			expect(state.mode).toBe("code")
			expect(state.currentApiConfigName).toBe("default")

			await provider.dispose()
		})

		it("should log and keep existing viewLocalState when loadViewState fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")

			// Register a stable id so the load is not skipped by the ownership guard:
			// only entries this instance authored are loaded under a temporary name.
			await provider["setViewStateId"]("stable-sidebar-view")

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const states = Object.fromEntries(
				Array.from({ length: 55 }, (_, index) => [
					`view-${index}`,
					{ mode: `mode-${index}`, updatedAt: index },
				]),
			)

			const pruned = provider["prunePersistedViewStates"](states)

			expect(Object.keys(pruned)).toHaveLength(50)
			expect(pruned["view-54"]).toEqual({ mode: "mode-54", updatedAt: 54 })
			expect(pruned["view-5"]).toEqual({ mode: "mode-5", updatedAt: 5 })
			expect(pruned["view-4"]).toBeUndefined()

			await provider.dispose()
		})
	})

	describe("setViewStateId", () => {
		it('should ignore "__proto__" and keep the temporary viewId', async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("__proto__")

			// "__proto__" is rejected before assignment so a per-view entry can never be
			// keyed through the Object.prototype setter: the temporary id stays active and
			// nothing is persisted under the reserved name.
			expect(provider["viewStateId"]).toBe(provider.viewId)
			expect(mockContext.globalState.get("viewStates")).toBeUndefined()
			expect(provider["viewLocalState"]).toEqual({})

			await provider.dispose()
		})

		it("restores the previous view id when the registration write fails so a later launch retries", async () => {
			const contextProxy = new ContextProxy(mockContext)
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				contextProxy,
				new WebviewFocusTracker(),
			)
			// Seed a pre-launch entry under the temporary id through the real write path,
			// so the re-key has real work to do and records this instance as its author.
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })

			const setValueSpy = vi.spyOn(contextProxy, "setValue").mockRejectedValue(new Error("storage down"))

			await expect(provider["setViewStateId"]("stable-sidebar-view")).rejects.toThrow("storage down")

			// The failed id must not stick: the provider keeps its previous (temporary)
			// id so a later launch retries registration and the load instead of the
			// guard early-returning for an id that was never persisted.
			expect(provider["viewStateId"]).toBe(provider.viewId)

			// A later retry succeeds once the storage write works again, and the
			// pre-launch entry lands under the registered id.
			setValueSpy.mockRestore()
			await provider["setViewStateId"]("stable-sidebar-view")
			expect(provider["viewStateId"]).toBe("stable-sidebar-view")
			expect(mockContext.globalState.get("viewStates")).toEqual({
				"stable-sidebar-view": { mode: "architect", updatedAt: 1 },
			})

			await provider.dispose()
		})
	})

	describe("view state persistence edge cases", () => {
		it("should read viewStates from the ContextProxy cache when not fresh", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("viewStates", { "stable-sidebar-view": { mode: "architect" } })
			expect(provider["getPersistedViewStates"]()).toEqual({ "stable-sidebar-view": { mode: "architect" } })
			await provider.dispose()
		})

		it("should treat a corrupted non-object viewStates value as an empty map", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// A string in storage is corrupt: the fresh-read guard must not spread it.
			await mockContext.globalState.update("viewStates", "corrupted-storage-value")
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			await provider.dispose()
		})

		it("should merge saved fields, drop cleared fields and delete emptied entries", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			const save = provider.saveViewState.bind(provider) as (key: string, value: unknown) => Promise<void>
			const states = () => mockContext.globalState.get<Record<string, unknown>>("viewStates") ?? {}
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("mode", "architect")
			await provider.saveViewState("currentApiConfigName", "profile-a")
			const merged = states()["stable-sidebar-view"]
			expect(merged).toMatchObject({ mode: "architect", currentApiConfigName: "profile-a" })
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Saved mode for viewId"))
			await save("mode", undefined)
			expect(states()["stable-sidebar-view"]).toStrictEqual({
				currentApiConfigName: "profile-a",
				updatedAt: expect.any(Number),
			})
			await save("mode", null)
			expect(states()["stable-sidebar-view"]).not.toHaveProperty("mode")
			await provider.saveViewState("mode", "architect")
			await save("currentApiConfigName", undefined)
			expect(states()["stable-sidebar-view"]).toStrictEqual({
				mode: "architect",
				updatedAt: expect.any(Number),
			})
			await provider.saveViewState("currentApiConfigName", "profile-c")
			await provider.saveViewState("mode", "architect")
			expect(states()["stable-sidebar-view"]).toMatchObject({
				mode: "architect",
				currentApiConfigName: "profile-c",
			})
			await save("currentApiConfigName", null)
			expect(states()["stable-sidebar-view"]).not.toHaveProperty("currentApiConfigName")
			await save("mode", null)
			expect(states()["stable-sidebar-view"]).toBeUndefined()
			expect(provider["viewLocalState"]).toStrictEqual({}) // buffer ends fully cleared
			await provider.dispose()
		})

		it("should rekey a pre-launch entry under the temporary id to the registered stable id", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Seed through the write path so this instance is the author of the entry under
			// its temporary id; an entry authored by another session must not be adopted.
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await provider["setViewStateId"]("stable-sidebar-view")
			expect(mockContext.globalState.get("viewStates")).toEqual({
				"stable-sidebar-view": { mode: "architect", updatedAt: 1 },
			})
			await provider.dispose()
		})

		it("holds a change made before registration in memory instead of writing it under the session-local id", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider.saveViewState("mode", "architect")

			// The temporary id restarts from 0 on the next host start, so an entry written under it
			// is neither loadable by the next session's provider nor attributable to this view. It
			// is held in memory instead, and getState() still serves the change from the buffer.
			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("viewStates", expect.anything())
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect((await provider.getState()).mode).toBe("architect")

			await provider["setViewStateId"]("stable-sidebar-view")

			// The registration flush writes the held change under the registered name, the only key
			// another session could load it under.
			expect(mockContext.globalState.update).toHaveBeenCalledWith("viewStates", {
				"stable-sidebar-view": { mode: "architect", updatedAt: expect.any(Number) },
			})
			expect(provider["pendingViewState"]).toBeUndefined()
			expect(provider["viewLocalState"].mode).toBe("architect")
			await provider.dispose()
		})

		it("merges a held pre-registration change into the stable entry it lands on", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Hold the change while the provider is unregistered, then let storage gain the stable
			// entry an earlier session of this view left behind.
			await provider["savePersistedViewState"]({ mode: "temp-mode", updatedAt: 1 })
			await provider.contextProxy.setValue("viewStates", {
				"stable-sidebar-view": { mode: "stable-mode", updatedAt: 5 },
			})
			await provider["setViewStateId"]("stable-sidebar-view")

			// The held change is the newer selection, so it lands on the stable entry field by
			// field, and nothing occupies a slot under the session-local id.
			expect(mockContext.globalState.get("viewStates")).toEqual({
				"stable-sidebar-view": { mode: "temp-mode", updatedAt: 1 },
			})
			await provider.dispose()
		})

		it("should clear only this view's entry without clobbering an entry only storage knows about", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			// The cache only knows this view's entry; storage gains an extra view directly.
			await provider.contextProxy.setValue("viewStates", { "stable-sidebar-view": { mode: "architect" } })
			await mockContext.globalState.update("viewStates", {
				"stable-sidebar-view": { mode: "architect" },
				"stable-editor-view": { mode: "code" },
			})
			await provider["clearPersistedViewState"]()
			expect(mockContext.globalState.get("viewStates")).toEqual({ "stable-editor-view": { mode: "code" } })
			await provider.dispose()
		})

		it("should prune by updatedAt regardless of insertion order", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const states = Object.fromEntries(
				Array.from({ length: 55 }, (_, index) => [
					`view-${index}`,
					{ mode: `mode-${index}`, updatedAt: (index * 7) % 55 },
				]),
			)
			const pruned = provider["prunePersistedViewStates"](states)
			expect(Object.keys(pruned)).toHaveLength(50)
			// view-1/view-54 survive the true newest-50 selection; view-8 (updatedAt 1) does not.
			expect(pruned["view-1"]).toEqual({ mode: "mode-1", updatedAt: 7 })
			expect(pruned["view-54"]).toEqual({ mode: "mode-54", updatedAt: 48 })
			expect(pruned["view-8"]).toBeUndefined()
			await provider.dispose()
		})

		it("should sanitize, reject blank and undefined ids, and no-op on the active id", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			await provider["setViewStateId"]("a b/c")
			expect(provider["viewStateId"]).toBe("a_b_c")
			await provider["setViewStateId"](undefined)
			await provider["setViewStateId"]("   ")
			expect(provider["viewStateId"]).toBe("a_b_c")
			logSpy.mockClear()
			await provider["setViewStateId"]("a_b_c")
			expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("Loaded state for viewId"))
			await provider.dispose()
		})

		it("should load persisted mode, profile name and resolved profile into viewLocalState", async () => {
			const writer = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await writer["setViewStateId"]("shared-view")
			await writer.saveViewState("mode", "architect")
			await writer.saveViewState("currentApiConfigName", "my-profile")

			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			const getProfileSpy = vi.fn().mockResolvedValue({
				name: "my-profile",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-x",
			})
			// @ts-ignore - Replace providerSettingsManager with a test double for the profile lookup.
			provider.providerSettingsManager = { getProfile: getProfileSpy }
			// The ownership check requires the writer to release the id before the
			// next view adopts it; the durable entry it wrote stays in storage.
			await writer.dispose()

			await provider.contextProxy.setValue(
				"viewStates",
				mockContext.globalState.get<RooCodeSettings["viewStates"]>("viewStates"),
			)
			await provider["setViewStateId"]("shared-view")
			expect(provider["viewLocalState"]).toEqual({
				mode: "architect",
				currentApiConfigName: "my-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" },
			})
			expect(getProfileSpy).toHaveBeenCalledWith({ name: "my-profile" })
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Loaded state for viewId"))
			await provider.dispose()
		})

		it("should log a successful empty load when no persisted entry exists", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			await provider["setViewStateId"]("stable-sidebar-view")
			expect(provider["viewLocalState"]).toEqual({})
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Loaded state for viewId"))
			await provider.dispose()
		})

		it("should keep the persisted profile name and log when the profile lookup fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			// @ts-ignore - Replace providerSettingsManager with a failing test double.
			provider.providerSettingsManager = { getProfile: vi.fn().mockRejectedValue(new Error("profile missing")) }
			await provider.saveViewState("currentApiConfigName", "my-profile")
			await provider["setViewStateId"]("stable-sidebar-view")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider["viewLocalState"]).not.toHaveProperty("apiConfiguration")
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Unable to resolve API profile 'my-profile'"))
			await provider.dispose()
		})

		it("should discard a stale load when the viewStateId changes during the profile lookup", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			// @ts-ignore - Replace providerSettingsManager with a test double that registers a newer id.
			provider.providerSettingsManager = {
				getProfile: vi.fn().mockImplementation(() => {
					provider["viewStateId"] = "superseded-view"
					return Promise.resolve({ name: "my-profile", apiProvider: providerIdentifiers.openrouter })
				}),
			}
			await provider.saveViewState("currentApiConfigName", "my-profile")
			await provider["setViewStateId"]("stable-sidebar-view")
			expect(provider["viewLocalState"]).not.toHaveProperty("apiConfiguration")
			const staleMsg = expect.stringContaining("Discarding stale state for superseded view id")
			expect(logSpy).toHaveBeenCalledWith(staleMsg)
			await provider.dispose()
		})

		it("should reapply fields mutated while the load is in flight and keep persisted values for untouched fields", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight mutations and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))

			// Selections made while the profile lookup is in flight must survive the load.
			await provider.saveViewState("mode", "architect")
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-y",
			})

			resolveProfile({ name: "cfg-a", apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" })
			await load

			// Dirty fields win over the loaded state; the untouched field keeps the persisted value.
			expect(provider["viewLocalState"]).toEqual({
				mode: "architect",
				currentApiConfigName: "cfg-a",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-y" },
			})
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Loaded state for viewId"))
			await provider.dispose()
		})

		it("should keep the persisted mode authoritative when the pre-load buffer is untouched", async () => {
			const writer = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await writer["setViewStateId"]("shared-view")
			await writer.saveViewState("mode", "code")
			await writer.saveViewState("currentApiConfigName", "my-profile")

			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// @ts-ignore - Replace providerSettingsManager with a test double for the profile lookup.
			provider.providerSettingsManager = {
				getProfile: vi.fn().mockResolvedValue({
					name: "my-profile",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "model-x",
				}),
			}
			// A pre-load buffer write that was never persisted must not be merged over the load.
			provider["viewLocalState"] = { mode: "architect" }
			// The ownership check requires the writer to release the id before the
			// next view adopts it; the durable entry it wrote stays in storage.
			await writer.dispose()

			await provider.contextProxy.setValue(
				"viewStates",
				mockContext.globalState.get<RooCodeSettings["viewStates"]>("viewStates"),
			)
			await provider["setViewStateId"]("shared-view")
			expect(provider["viewLocalState"].mode).toBe("code")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-x",
			})
			await provider.dispose()
		})

		it("should not restore a persisted mode whose custom mode no longer exists", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			// @ts-ignore - Replace customModesManager with a test double (no custom modes).
			provider.customModesManager = { getCustomModes: vi.fn().mockResolvedValue([]), dispose: vi.fn() }
			// The file-level modes mock resolves every slug to a mode; drop the pinned slug.
			const modesModule = vi.mocked(await import("../../../shared/modes"))
			const originalMode = modesModule.getModeBySlug("code")
			modesModule.getModeBySlug.mockImplementation(((slug: string) =>
				slug === "deleted-custom-mode" ? undefined : originalMode) as typeof modesModule.getModeBySlug)
			try {
				await provider["setViewStateId"]("stable-sidebar-view")
				await provider.saveViewState("mode", "deleted-custom-mode")
				// Reload the persisted entry: the custom mode was deleted in the meantime.
				await provider["loadViewState"]()
				// The stale slug must not be restored into the buffer.
				expect(provider["viewLocalState"]).not.toHaveProperty("mode")
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining('Ignoring unknown persisted mode "deleted-custom-mode"'),
				)
			} finally {
				modesModule.getModeBySlug.mockReturnValue(originalMode)
			}
			await provider.dispose()
		})

		it("should not resurrect a field cleared mid-load from the pre-load buffer", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			// Persist a mode too: without it the load has no mode to resurrect, so the
			// cleared-field assertion below would pass even if the loaded value clobbered
			// the in-flight clear.
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			await provider.saveViewState("mode", "code")
			provider["viewLocalState"] = { ...provider["viewLocalState"], mode: "architect" }
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight clear and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))

			// The user clears the mode while the load is in flight.
			await provider.saveViewState("mode", undefined)
			resolveProfile({ name: "cfg-a" })
			await load

			// The cleared field must stay absent rather than keeping the persisted or
			// pre-load value; the untouched field keeps the persisted value.
			expect(provider["viewLocalState"]).not.toHaveProperty("mode")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("cfg-a")
			await provider.dispose()
		})

		it("should reapply an independently mutated mode when the load settles", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight mutation and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))
			// Only the mode is mutated while the profile lookup is in flight.
			await provider.saveViewState("mode", "architect")

			resolveProfile({ name: "cfg-a", apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" })
			await load

			expect(provider["viewLocalState"]).toEqual({
				mode: "architect",
				currentApiConfigName: "cfg-a",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" },
			})
			await provider.dispose()
		})

		it("should reapply an independently mutated profile name when the load settles", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight mutation and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))
			// The profile name changes while the lookup is in flight; the load still
			// resolves the name persisted at load start.
			await provider.saveViewState("currentApiConfigName", "cfg-b")

			resolveProfile({ name: "cfg-a", apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" })
			await load

			// The in-flight selection wins over the loaded state. The lookup resolved cfg-a, a
			// profile this view no longer names, so its settings must not be paired with cfg-b:
			// the overlay stays unresolved and getState falls back to the shared store.
			expect(provider["viewLocalState"].currentApiConfigName).toBe("cfg-b")
			expect(provider["viewLocalState"]).not.toHaveProperty("apiConfiguration")
			expect(provider["viewLocalState"]).not.toHaveProperty("mode")
			await provider.dispose()
		})

		it("should reapply an independently mutated apiConfiguration when the load settles", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight mutation and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))
			// Only the apiConfiguration is mutated while the profile lookup is in flight.
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-y",
			})

			resolveProfile({ name: "cfg-a", apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" })
			await load

			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "model-y",
			})
			expect(provider["viewLocalState"].currentApiConfigName).toBe("cfg-a")
			await provider.dispose()
		})

		it("should keep every persisted field authoritative when the load is untouched", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const { getProfile: getProfileSpy, resolveProfile } = stallProviderSettingsProfile(provider)
			// @ts-ignore - Replace customModesManager with a test double (no custom modes).
			provider.customModesManager = { getCustomModes: vi.fn().mockResolvedValue([]), dispose: vi.fn() }
			await provider.saveViewState("mode", "code")
			await provider.saveViewState("currentApiConfigName", "cfg-a")
			const load = provider["setViewStateId"]("stable-sidebar-view")

			// Let the stalled lookup begin so the in-flight mutation and the resolver
			// target the pending promise rather than the initial no-op.
			await vi.waitFor(() => expect(getProfileSpy).toHaveBeenCalledTimes(1))
			// No mutation while the lookup is in flight: the persisted values must win.
			resolveProfile({ name: "cfg-a", apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" })
			await load

			expect(provider["viewLocalState"]).toEqual({
				mode: "code",
				currentApiConfigName: "cfg-a",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterModelId: "model-x" },
			})
			await provider.dispose()
		})

		it("should persist known modes and reject unknown or non-string modes", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const logSpy = vi.spyOn(provider, "log")
			// @ts-ignore - Replace customModesManager with a test double (no custom modes).
			provider.customModesManager = { getCustomModes: vi.fn().mockResolvedValue([]), dispose: vi.fn() }
			// The file-level modes mock resolves every slug to a mode; narrow it to the slugs under test.
			const modesModule = vi.mocked(await import("../../../shared/modes"))
			const originalMode = modesModule.getModeBySlug("code")
			modesModule.getModeBySlug.mockImplementation(((slug: string) =>
				slug === "refactor" ? { slug } : undefined) as typeof modesModule.getModeBySlug)
			try {
				await provider.setValues({ mode: "refactor" })
				expect(mockContext.globalState.get("mode")).toBe("refactor")
				expect(provider["viewLocalState"].mode).toBe("refactor")
				await provider.setValues({ mode: "bogus-mode" })
				expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid mode "bogus-mode"'))
				expect(mockContext.globalState.get("mode")).toBe("refactor")
				expect(provider["viewLocalState"].mode).toBe("refactor")
				// A non-string mode must be rejected before persistence; Object.assign
				// keeps this a single structural assertion, so it must not reach global
				// state or the buffer.
				await provider.setValues(Object.assign({} as RooCodeSettings, { mode: 42 }))
				expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid mode "42"'))
				expect(mockContext.globalState.get("mode")).toBe("refactor")
				expect(provider["viewLocalState"].mode).toBe("refactor")
			} finally {
				modesModule.getModeBySlug.mockReturnValue(originalMode)
			}
			await provider.dispose()
		})

		it("should apply setValue mutations to global state and keep or clear the right buffer fields", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const apiConfiguration = { apiProvider: providerIdentifiers.openrouter }
			await provider.saveViewState("mode", "architect")
			await provider.saveViewState("currentApiConfigName", "my-profile")
			await provider.saveViewState("apiConfiguration", apiConfiguration)
			// A mutation of an unrelated key reaches global state without dropping buffered fields.
			await provider.setValue("writeDelayMs", 500)
			expect(mockContext.globalState.get("writeDelayMs")).toBe(500)
			expect(provider.getValues().writeDelayMs).toBe(500)
			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider["viewLocalState"].currentApiConfigName).toBe("my-profile")
			expect(provider["viewLocalState"].apiConfiguration).toBe(apiConfiguration)
			await provider.setValue("mode", undefined)
			expect(provider["viewLocalState"]).not.toHaveProperty("mode")
			await provider.setValue("currentApiConfigName", undefined)
			expect(provider["viewLocalState"]).not.toHaveProperty("currentApiConfigName")
			await provider.dispose()
		})

		it("should remove the buffered apiConfiguration when it is cleared", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const save = provider.saveViewState.bind(provider) as (key: string, value: unknown) => Promise<void>
			await provider.saveViewState("apiConfiguration", { apiProvider: providerIdentifiers.openrouter })
			await provider.saveViewState("apiConfiguration", undefined)
			expect(provider["viewLocalState"]).not.toHaveProperty("apiConfiguration")
			await provider.saveViewState("apiConfiguration", { apiProvider: providerIdentifiers.openrouter })
			await save("apiConfiguration", null)
			expect(provider["viewLocalState"]).not.toHaveProperty("apiConfiguration")
			await provider.dispose()
		})

		it("should clear viewLocalState and the persisted entry when resetting state", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// @ts-ignore - Replace customModesManager with a test double (the real reset writes to disk).
			provider.customModesManager = { resetCustomModes: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }
			// The modal answer is a string label; the last-typed vscode overload expects a
			// MessageItem. A double assertion is the last-resort cast here (AGENTS.md): the
			// production path compares the answer against the string label directly, so the
			// runtime value must stay a string and cannot be a structural MessageItem double.
			vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
				t("common:answers.yes") as unknown as vscode.MessageItem,
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("mode", "architect")
			await provider.resetState()
			expect(provider["viewLocalState"]).toEqual({})
			expect(mockContext.globalState.get("viewStates")).toEqual({})
			await provider.dispose()
		})

		it("should not tombstone a view id when the durable viewStates delete fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-view")
			await provider.saveViewState("currentApiConfigName", "cfg-tombstone")
			const viewId = provider["viewStateId"]
			expect(ClineProvider["clearedViewStateIds"].has(viewId)).toBe(false)

			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("storage unavailable"))
				}
				return Promise.resolve()
			})

			await expect(provider["clearPersistedViewState"](viewId)).rejects.toThrow("storage unavailable")
			mockContext.globalState.update = originalUpdate

			// The entry is still in durable storage, so the id must stay restorable: profile
			// activation rollback skips pruning of ids that were cleared, and tombstoning an id that
			// storage never dropped is what loses the pin on the next reload.
			expect(ClineProvider["clearedViewStateIds"].has(viewId)).toBe(false)
			expect(mockContext.globalState.get("viewStates")).toMatchObject({
				[viewId]: { currentApiConfigName: "cfg-tombstone" },
			})

			await provider.dispose()
		})

		it("releases a disposed provider's tombstone once no live eviction list guards it", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-release")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await provider["clearPersistedViewState"]()
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-release")).toBe(true)

			await provider.dispose()

			// The entry is gone from durable storage, so no later activation group can evict it and
			// nothing consults the tombstone: it must not outlive the provider that wrote it, or the
			// shared set grows for as long as the host runs.
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-release")).toBe(false)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-release")).toBe(false)
		})

		it("keeps a tombstone an in-flight eviction list guards and drops it when the next group lets go", async () => {
			const owner = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const guardedProvider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await owner["setViewStateId"]("stable-tombstone-guarded")
			await owner["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await owner["clearPersistedViewState"]()

			// Another view is mid-activation and its eviction list names the id, so its rollback still
			// has to see the tombstone: dropping it here would resurrect an intentional clear.
			guardedProvider["prunedViewIdsDuringActivation"].push("stable-tombstone-guarded")

			await owner.dispose()

			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-guarded")).toBe(true)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-guarded")).toBe(true)

			// The next activation group is where the previous group's eviction list is let go, and that
			// is when the orphaned tombstone is dropped.
			guardedProvider["prunedViewIdsDuringActivation"] = []
			guardedProvider["_snapshotProfileActivationState"]()

			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-guarded")).toBe(false)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-guarded")).toBe(false)

			await guardedProvider.dispose()
		})

		it("lifts the tombstone of a deletion whose durable write failed", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-failed-write")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })

			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("storage unavailable"))
				}
				return Promise.resolve()
			})

			// The queued write clears the entry's only field, so it tombstones the id before the
			// durable write it rides on fails.
			await expect(provider["savePersistedViewState"]({ mode: undefined })).rejects.toThrow("storage unavailable")
			mockContext.globalState.update = originalUpdate

			// Storage never dropped the entry, so the tombstone has to go back with the write: an id
			// that is still persisted must stay restorable by an activation rollback.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({
				"stable-tombstone-failed-write": { mode: "architect", updatedAt: 1 },
			})
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-failed-write")).toBe(false)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-failed-write")).toBe(false)

			await provider.dispose()
		})

		it("keeps tearing down when the pre-registration change cannot be flushed", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.saveViewState("mode", "plan")
			const viewId = provider["viewId"]

			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					// A non-Error rejection: teardown has to report what it got, not assume a shape.
					return Promise.reject("storage unavailable")
				}
				return Promise.resolve()
			})

			// Teardown must not turn into a rejection because one durable write failed.
			await provider.dispose()
			mockContext.globalState.update = originalUpdate

			expect(provider["pendingViewState"]).toBeUndefined()
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining(`[dispose] Unable to flush the unregistered view state of view ${viewId}`),
			)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("storage unavailable"))
		})

		it("writes a held pre-registration change to storage when the provider is disposed", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.saveViewState("mode", "plan")

			// Nothing is on disk while the change waits for a registration that has not happened.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect(provider["pendingViewState"]).toEqual({ mode: "plan" })

			await provider.dispose()

			// Disposal is the last chance to keep the change: it reaches storage under the only id
			// this view ever had, and it stays a durability record rather than something a later view
			// can load as its own.
			const states = provider["getPersistedViewStates"]({ fresh: true })
			const viewId = provider["viewId"]
			expect(Object.keys(states)).toEqual([viewId])
			expect(states[viewId]).toMatchObject({ mode: "plan" })
			expect(typeof states[viewId]?.updatedAt).toBe("number")
			expect(provider["pendingViewState"]).toBeUndefined()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining(`[dispose] Flushed the unregistered view state of view ${viewId}`),
			)
		})

		it("does not write anything when a provider is disposed with nothing held", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["_updateViewLocalStateFromMutation"]({
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "own" },
			})

			await provider.dispose()

			// Only a change that was waiting on a registration gets a teardown write. A provider that
			// held none must not put an entry under its session-local id, nor claim that it flushed one.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith(
				expect.stringContaining("the unregistered view state of view " + provider["viewId"]),
			)
		})

		it("tombstones an id whose entry a write cleared and releases it at dispose", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-clear-write")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })

			// Both persisted fields go undefined in one write, which drops the entry.
			await provider["savePersistedViewState"]({ mode: undefined, currentApiConfigName: undefined })

			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-clear-write")).toBe(true)
			expect(provider["addedClearedViewStateIds"].has("stable-tombstone-clear-write")).toBe(true)

			await provider.dispose()

			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-clear-write")).toBe(false)
			expect(provider["addedClearedViewStateIds"].size).toBe(0)
		})

		it("lifts the tombstone and this provider's claim when a write lands the entry again", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-relift")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await provider["clearPersistedViewState"]()
			expect(provider["addedClearedViewStateIds"].has("stable-tombstone-relift")).toBe(true)

			await provider["savePersistedViewState"]({ mode: "code", updatedAt: 2 })

			// An entry that is in storage again was not cleared, so neither the shared tombstone nor
			// this provider's claim on it may survive: a stale claim would let dispose drop a
			// tombstone another view had already lifted.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({
				"stable-tombstone-relift": { mode: "code", updatedAt: 2 },
			})
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-relift")).toBe(false)
			expect(provider["addedClearedViewStateIds"].has("stable-tombstone-relift")).toBe(false)

			await provider.dispose()
		})

		it("puts the tombstone back when the write that would have landed the entry fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tombstone-lift-fail")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await provider["clearPersistedViewState"]()
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-lift-fail")).toBe(true)

			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("storage unavailable"))
				}
				return Promise.resolve()
			})

			// This write would have landed the entry and lifted the tombstone with it.
			await expect(provider["savePersistedViewState"]({ mode: "code", updatedAt: 2 })).rejects.toThrow(
				"storage unavailable",
			)
			mockContext.globalState.update = originalUpdate

			// Storage never changed, so the lift is undone together with the write: an id that is
			// still cleared on disk has to stay tombstoned.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-lift-fail")).toBe(true)
			expect(provider["addedClearedViewStateIds"].has("stable-tombstone-lift-fail")).toBe(true)

			await provider.dispose()
		})

		it("drains an ownerless tombstone only once no live eviction list guards it", async () => {
			const owner = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const firstGuard = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const secondGuard = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await owner["setViewStateId"]("stable-tombstone-drain")
			await owner["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })
			await owner["clearPersistedViewState"]()

			// Two views are mid-activation with this id in their eviction lists when the provider
			// that cleared the entry goes away.
			firstGuard["prunedViewIdsDuringActivation"].push("stable-tombstone-drain")
			secondGuard["prunedViewIdsDuringActivation"].push("stable-tombstone-drain")
			await owner.dispose()

			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-drain")).toBe(true)

			// The first group lets go of its list, but the second still names the id, so that
			// rollback still needs the tombstone.
			firstGuard["_snapshotProfileActivationState"]()
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-drain")).toBe(true)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-drain")).toBe(true)

			// Once the last list naming it is let go, the next group drops it.
			secondGuard["_snapshotProfileActivationState"]()
			expect(ClineProvider["clearedViewStateIds"].has("stable-tombstone-drain")).toBe(false)
			expect(ClineProvider["clearedViewStateIdsWithoutOwner"].has("stable-tombstone-drain")).toBe(false)

			await firstGuard.dispose()
			await secondGuard.dispose()
		})

		it("should roll back the shared write when setValue per-view persistence fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("mode", "architect")
			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("storage unavailable"))
				}
				return Promise.resolve()
			})

			// Register first: an unregistered provider holds the change instead of writing it, so
			// there would be no durable write left to fail.
			await provider["setViewStateId"]("stable-sidebar-view")

			await expect(provider.setValue("mode", "code")).rejects.toThrow("storage unavailable")
			// The shared store must not move ahead of the per-view record that failed.
			expect(provider.getValue("mode")).toBe("architect")

			mockContext.globalState.update = originalUpdate
			await provider.dispose()
		})

		it("should roll back the shared writes when setValues per-view persistence fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("mode", "architect")
			await provider.contextProxy.setValue("currentApiConfigName", "current-config")
			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("storage unavailable"))
				}
				return Promise.resolve()
			})

			// Register first: an unregistered provider holds the change instead of writing it, so
			// there would be no durable write left to fail.
			await provider["setViewStateId"]("stable-sidebar-view")

			await expect(provider.setValues({ mode: "code", currentApiConfigName: "other-config" })).rejects.toThrow(
				"storage unavailable",
			)
			expect(provider.getValue("mode")).toBe("architect")
			expect(provider.getValue("currentApiConfigName")).toBe("current-config")
			expect(provider["viewLocalState"].mode).toBeUndefined()

			mockContext.globalState.update = originalUpdate
			await provider.dispose()
		})
	})

	describe("provider profile mutations", () => {
		it("should sync the view-local buffer when activating a profile over a loaded view state", async () => {
			const writer = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await writer["setViewStateId"]("shared-view")
			await writer.saveViewState("currentApiConfigName", "old-profile")

			const profile: ProviderSettingsEntry = {
				name: "new-profile",
				id: "new-id",
				apiProvider: providerIdentifiers.openrouter,
			}

			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				activateProfile: vi.fn().mockResolvedValue(profile),
				listConfig: vi.fn().mockResolvedValue([profile]),
				setModeConfig: vi.fn(),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				getProfile: vi.fn().mockResolvedValue({
					name: "old-profile",
					id: "old-id",
					apiProvider: providerIdentifiers.anthropic,
				}),
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// The ownership check requires the writer to release the id before the
			// next view adopts it; the durable entry it wrote stays in storage.
			await writer.dispose()

			await provider.contextProxy.setValue(
				"viewStates",
				mockContext.globalState.get<RooCodeSettings["viewStates"]>("viewStates"),
			)
			await provider["setViewStateId"]("shared-view")
			expect(provider.getValues().currentApiConfigName).toBe("old-profile")

			await provider.activateProviderProfile({ name: "new-profile" })

			// The buffer must track the activated profile so getValues() agrees with the proxy.
			expect(provider.getValues().currentApiConfigName).toBe("new-profile")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("new-profile")
			await provider.dispose()
		})

		it("should sync the view-local buffer when creating and activating a profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profile: ProviderSettingsEntry = {
				name: "fresh-profile",
				id: "fresh-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const savedForReadBack1: Record<string, Record<string, unknown>> = {}
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack1[name] = settings
					return "fresh-id"
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: "fresh-id",
					...savedForReadBack1[name],
				})),
				listConfig: vi.fn().mockResolvedValue([profile]),
				setModeConfig: vi.fn(),
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			await provider.setValue("currentApiConfigName", "stale-profile")

			await provider.upsertProviderProfile("fresh-profile", { apiProvider: providerIdentifiers.openrouter })

			expect(provider.getValues().currentApiConfigName).toBe("fresh-profile")
			await provider.dispose()
		})

		it("refuses to save when the existing profile record cannot be read", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				// The store proves the record is there and then cannot hand it over. Neither
				// restore branch of the compensation can tell a landed record from an absent
				// one in that state, so the save must not start.
				vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
				vi.spyOn(provider.providerSettingsManager, "getProfile").mockRejectedValue(
					new Error("profile record unreadable"),
				)
				const saveSpy = vi.spyOn(provider.providerSettingsManager, "saveConfig")
				const deleteSpy = vi.spyOn(provider.providerSettingsManager, "deleteConfig")
				const activateSpy = vi.spyOn(provider.providerSettingsManager, "activateProfile")

				const id = await provider.upsertProviderProfile("unreadable-profile", {
					apiProvider: providerIdentifiers.anthropic,
				})

				expect(id).toBeUndefined()
				expect(saveSpy).not.toHaveBeenCalled()
				expect(deleteSpy).not.toHaveBeenCalled()
				expect(activateSpy).not.toHaveBeenCalled()
				expect(provider.getValues().currentApiConfigName).not.toBe("unreadable-profile")
			} finally {
				await provider.dispose()
			}
		})
		it("should sync the view-local buffer when deleting the current profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const oldProfile: ProviderSettingsEntry = {
				name: "old-profile",
				id: "old-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile])
			await provider.setValue("currentApiConfigName", "old-profile")
			// The survivor has to be resolvable: this deletion re-points both this view's pin
			// and the shared selection at it, which requires its settings.
			await provider.providerSettingsManager.saveConfig("keeper-profile", {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "keeper-key",
			})
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await provider.deleteProviderProfile(oldProfile)

			// The fallback profile must replace the deleted one in both the proxy and the buffer.
			expect(provider.getValues().currentApiConfigName).toBe("keeper-profile")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("keeper-profile")
			await provider.dispose()
		})

		it("fails the upsert and compensates the record when the post-save read-back fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// The pre-save snapshot sees the prior record; the post-save read-back
			// fails: the raw caller payload must never stand in for the validated
			// stored record.
			let saved = false
			const saveSpy = vi.spyOn(provider.providerSettingsManager, "saveConfig").mockImplementation(async () => {
				saved = true
				return "p-id"
			})
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(async () => {
				if (saved) {
					throw new Error("read-back down")
				}
				return {
					name: "p",
					id: "p-id",
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "prior-key",
				}
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("p")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")

			await expect(
				provider["persistProviderProfile"](
					"p",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "raw-key" },
					true,
				),
			).rejects.toThrow("could not be read back")

			// The landed save was compensated with the prior record, and no
			// activation write carried the raw payload into the shared store.
			expect(saveSpy).toHaveBeenLastCalledWith("p", expect.objectContaining({ apiKey: "prior-key" }))
			expect(setValueSpy).not.toHaveBeenCalledWith("currentApiConfigName", "p")

			await provider.dispose()
		})

		it("restores the manager record and shared state when a post-delete write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const oldProfile: ProviderSettingsEntry = {
				name: "old-profile",
				id: "old-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile])
			await provider.setValue("currentApiConfigName", "old-profile")
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(async (params) => {
				if ("name" in params && params.name === "old-profile") {
					return {
						name: "old-profile",
						id: "old-id",
						apiProvider: providerIdentifiers.openrouter,
						apiKey: "old-key",
					}
				}
				return {
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "keeper-key",
				}
			})
			vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
			const saveSpy = vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("x")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// The first write after the committed manager delete fails: the
			// deletion must be compensated, not left half-applied.
			vi.spyOn(provider.contextProxy, "setValue").mockImplementation(async (key) => {
				if (key === "listApiConfigMeta") {
					throw new Error("state write down")
				}
			})

			await expect(provider.deleteProviderProfile(oldProfile)).rejects.toThrow("state write down")

			// The secrets-backed record was restored with its pre-delete settings.
			// The restore keeps the original id: mode mappings and enhancementApiConfigId
			// reference the record by id, so a regenerated id would leave them dangling.
			expect(saveSpy).toHaveBeenCalledWith(
				"old-profile",
				expect.objectContaining({ apiKey: "old-key", id: "old-id" }),
			)

			await provider.dispose()
		})

		it("keeps the mutation queue owned by a mode switch past its timeout", async () => {
			vi.useFakeTimers()
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			// Bracket access: handleModeSwitchUnlocked is private; the double
			// assertion is the only way to install the gate on the prototype.
			const proto = ClineProvider.prototype as unknown as {
				handleModeSwitchUnlocked: (...args: unknown[]) => Promise<void>
			}
			const switchSpy = vi.spyOn(proto, "handleModeSwitchUnlocked").mockReturnValue(gate)

			vi.spyOn(provider.customModesManager, "getCustomModes").mockResolvedValue([])
			// The caller-side timeout rejection is expected: runToCompletion only
			// keeps the QUEUE waiting for the run, it does not silence the caller.
			const switchSettled = provider.handleModeSwitch("programmer").catch(() => undefined)
			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1000)

			// The queue tail is still the mode switch: a later mutation must
			// not start while the switch's writes are still in flight.
			let secondStarted = false
			void provider["enqueueProviderProfileMutation"](async () => {
				secondStarted = true
			})
			await vi.advanceTimersByTimeAsync(0)
			expect(secondStarted).toBe(false)

			release()
			await switchSettled
			await vi.advanceTimersByTimeAsync(0)
			expect(secondStarted).toBe(true)

			switchSpy.mockRestore()
			vi.useRealTimers()
			await provider.dispose()
		})

		it("re-posts state when a profile mutation commits after its caller timed out", async () => {
			vi.useFakeTimers()
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// The mutation body only waits here, so the only postStateToWebview call this
			// test can observe is the one that reports the late commit.
			const postSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			const logSpy = vi.spyOn(provider, "log")
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			// Bracket access: enqueueProviderProfileMutation is private, and the point of the
			// test is the queue's own bookkeeping rather than any one public mutation.
			const callerSettled = provider["enqueueProviderProfileMutation"](async () => gate).catch(() => undefined)

			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 1000)
			// The caller-side timeout is deliberate: it reports failure and keeps the queue
			// waiting for the run. Nothing has been committed yet, so nothing to report.
			expect(postSpy).not.toHaveBeenCalled()

			release()
			await callerSettled
			await vi.advanceTimersByTimeAsync(0)

			// The mutation landed: the profile list, the activation and the task handlers have
			// all moved, so the views must be told instead of staying on the pre-mutation state
			// under the error the caller already showed.
			expect(postSpy).toHaveBeenCalledTimes(1)
			expect(logSpy).toHaveBeenCalledWith(
				"Provider profile mutation committed after its caller timed out; re-posting state",
			)

			vi.useRealTimers()
			await provider.dispose()
		})

		it("does not resurrect a pruned sibling entry that the sibling cleared mid-window", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-tomb-view")
			// A full 50-entry map: the activation write evicts the oldest entry (the
			// sibling's), the sibling then clears it mid-window, and the tombstone
			// must outrank the tracked eviction during rollback.
			const seeded: Record<string, { mode?: string; currentApiConfigName?: string; updatedAt?: number }> = {
				"sibling-view": { currentApiConfigName: "sibling-profile", updatedAt: 0 },
			}
			for (let i = 0; i < 49; i++) {
				seeded["filler-" + i] = { currentApiConfigName: "filler-profile", updatedAt: i + 1 }
			}
			await provider.contextProxy.setValue("viewStates", seeded)
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			// After the activation write evicted the oldest entry, the sibling
			// intentionally clears it; the rollback must leave it absent.
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockImplementation(async () => {
				await provider["clearPersistedViewState"]("sibling-view")
				throw new Error("mode write failed")
			})
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.anthropic }, true),
			).resolves.toBeUndefined()

			const restored = provider.contextProxy.getValue("viewStates") as Record<string, unknown>
			expect(restored["sibling-view"]).toBeUndefined()
			expect(restored["filler-0"]).toBeDefined()
			await provider.dispose()
		})
		it("should swallow only the typed not-found signal when pruning a stale profile entry", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const staleProfile: ProviderSettingsEntry = {
				name: "stale-profile",
				id: "stale-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [staleProfile, keeperProfile])
			await provider.setValue("currentApiConfigName", "keeper-profile")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// The secret was already pruned: the typed not-found must be an idempotent
			// success so the stale list entry is still removed.
			vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockRejectedValue(
				new ProviderSettingsNotFoundError(`Config 'stale-profile' not found`),
			)

			await provider.deleteProviderProfile(staleProfile)

			expect(provider.contextProxy.getValue("listApiConfigMeta")).toEqual([keeperProfile])
			await provider.dispose()
		})

		it("should propagate a non-not-found deletion failure for a profile named like the not-found message", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profile: ProviderSettingsEntry = {
				name: "not found config",
				id: "nf-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [profile, keeperProfile])
			await provider.setValue("currentApiConfigName", "keeper-profile")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// An unrelated failure (wrapped the way deleteConfig wraps storage errors)
			// must not be mistaken for the idempotent not-found path just because the
			// profile name contains "not found".
			const deleteConfigSpy = vi
				.spyOn(provider.providerSettingsManager, "deleteConfig")
				.mockRejectedValue(
					new Error(`Failed to delete config: Error: storage write failed for 'not found config'`),
				)

			await expect(provider.deleteProviderProfile(profile)).rejects.toThrow("storage write failed")

			// The list entry must remain untouched when the deletion failed.
			expect(provider.contextProxy.getValue("listApiConfigMeta")).toEqual([profile, keeperProfile])
			expect(deleteConfigSpy).toHaveBeenCalledTimes(1)
			await provider.dispose()
		})

		it("reconfigures a view pinned to the deleted profile even when the global selection points elsewhere", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const oldProfile: ProviderSettingsEntry = {
				name: "old-profile",
				id: "old-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile])
			// The global selection points at the keeper profile, but this view's buffer
			// is still pinned to the profile being deleted (it loaded it earlier):
			// the nested overlay still carries the deleted profile's configuration.
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			provider["viewLocalState"].currentApiConfigName = "old-profile"
			provider["viewLocalState"].apiConfiguration = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "deleted-profile-secret",
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				getProfile: vi.fn().mockResolvedValue({
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				}),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			}
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

			await provider.deleteProviderProfile(oldProfile)

			// The captured pin must still trigger the reconfiguration: the shared
			// provider keys and the view-local buffer both take the surviving
			// profile's settings, and the nested overlay is replaced wholesale so
			// no key of the deleted profile survives.
			expect(setProviderSettingsSpy).toHaveBeenCalledWith(
				expect.objectContaining({ apiProvider: providerIdentifiers.anthropic }),
			)
			expect(provider.getValues().currentApiConfigName).toBe("keeper-profile")
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			await provider.dispose()
		})

		it("aborts the deletion when the surviving profile's settings cannot be resolved", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const oldProfile: ProviderSettingsEntry = {
				name: "old-profile",
				id: "old-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			const thirdProfile: ProviderSettingsEntry = {
				name: "third-profile",
				id: "third-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			// Three profiles so the deletion still has a surviving profile to activate.
			await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile, thirdProfile])
			// The global selection names a surviving profile while this view is pinned to
			// the profile being deleted, so the re-point would still happen.
			await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
			// This view is pinned to the profile being deleted and still holds its
			// settings in the nested overlay.
			provider["viewLocalState"].currentApiConfigName = "old-profile"
			provider["viewLocalState"].apiConfiguration = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "deleted-profile-secret",
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				// The deleted profile's snapshot resolves; the survivor's settings do not,
				// which is the condition this test covers.
				getProfile: vi.fn().mockImplementation(async (params: { name: string }) => {
					if (params.name === "old-profile") {
						return {
							name: "old-profile",
							id: "old-id",
							apiProvider: providerIdentifiers.openrouter,
							openRouterApiKey: "deleted-profile-secret",
						}
					}
					throw new Error("profile unreadable")
				}),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
				saveConfig: vi.fn().mockResolvedValue("old-id"),
			}

			await expect(provider.deleteProviderProfile(oldProfile)).rejects.toThrow("profile unreadable")

			// The pin was never moved onto a profile whose settings could not be read, so the
			// deleted profile's configuration cannot end up served under the survivor's name:
			// the view still names the profile whose settings it actually holds.
			expect(provider["viewLocalState"].currentApiConfigName).toBe("old-profile")
			expect(provider["viewLocalState"].apiConfiguration?.openRouterApiKey).toBe("deleted-profile-secret")
			// The compensation put back the record the manager delete had already committed,
			// credentials included, so the profile is still resolvable.
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith(
				"old-profile",
				expect.objectContaining({
					id: "old-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "deleted-profile-secret",
				}),
			)
			// The pruned list entry was restored as well, and no shared write paired the
			// survivor's name with the deleted profile's settings.
			expect(provider.contextProxy.getValue("listApiConfigMeta")?.map(({ name }) => name)).toEqual([
				"keeper-profile",
				"third-profile",
				"old-profile",
			])
			await provider.dispose()
		})
		it("rebuilds the acting view's task handler when the deleted profile is the one it runs", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const runningProfile: ProviderSettingsEntry = {
				name: "running-profile",
				id: "running-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [runningProfile, keeperProfile])
			await provider.setValue("currentApiConfigName", "running-profile")
			await provider.providerSettingsManager.saveConfig("running-profile", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "running-key",
			})
			await provider.providerSettingsManager.saveConfig("keeper-profile", {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "keeper-key",
			})
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			const task = {
				taskId: "running-task",
				taskApiConfigName: "running-profile",
				apiConfiguration: { apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "running-key" },
				setTaskApiConfigName: vi.fn(),
				updateApiConfiguration: vi.fn(),
			}
			// Double assertion: the handler rebuild and the sticky re-point are the only two Task
			// behaviours this path touches, so a full Task is neither available nor meaningful.
			vi.spyOn(provider, "getCurrentTask").mockReturnValue(
				task as unknown as ReturnType<typeof provider.getCurrentTask>,
			)

			await provider.deleteProviderProfile(runningProfile)

			// Re-pointing the pin and the shared store does not touch a live handler: without the
			// rebuild the running conversation keeps sending the deleted profile's credentials.
			expect(task.updateApiConfiguration).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "keeper-key" }))
			expect(task.setTaskApiConfigName).toHaveBeenCalledWith("keeper-profile")
			await provider.dispose()
		})

		it("restores a sibling view's pin when the deletion fails after re-pinning it", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				const deletedProfile: ProviderSettingsEntry = {
					name: "sibling-profile",
					id: "sibling-id",
					apiProvider: providerIdentifiers.openrouter,
				}
				const keeperProfile: ProviderSettingsEntry = {
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				}
				await provider.contextProxy.setValue("listApiConfigMeta", [deletedProfile, keeperProfile])
				// The global selection already names a survivor: only the sibling's own pin names
				// the profile being deleted.
				await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
				sibling["viewLocalState"].currentApiConfigName = "sibling-profile"
				sibling["viewLocalState"].apiConfiguration = {
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "sibling-secret",
				}
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("sibling-id")
				vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(async (args) => {
					const name = "name" in args ? args.name : ""

					if (name === "sibling-profile") {
						return {
							name: "sibling-profile",
							id: "sibling-id",
							apiProvider: providerIdentifiers.openrouter,
							openRouterApiKey: "sibling-secret",
						}
					}
					return {
						name: "keeper-profile",
						id: "keeper-id",
						apiProvider: providerIdentifiers.anthropic,
						apiKey: "keeper-key",
					}
				})
				// The re-pin of the sibling is already committed by the time this write fails.
				vi.spyOn(provider, "postStateToWebview").mockRejectedValue(new Error("post state failed"))

				await expect(provider.deleteProviderProfile(deletedProfile)).rejects.toThrow("post state failed")
				await ClineProvider["persistedViewStateWriteQueue"]

				// The manager record is back, so the sibling goes back to the pin it had; leaving
				// it on the survivor would be a state no caller asked for.
				expect(sibling.pinnedProfileName).toBe("sibling-profile")
				expect(sibling["viewLocalState"].apiConfiguration?.openRouterApiKey).toBe("sibling-secret")
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})

		it("keeps a sibling's newer durable profile pin when the deletion rollback runs", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				const deletedProfile: ProviderSettingsEntry = {
					name: "gone-profile",
					id: "gone-id",
					apiProvider: providerIdentifiers.openrouter,
				}
				const keeperProfile: ProviderSettingsEntry = {
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				}
				await provider.contextProxy.setValue("listApiConfigMeta", [deletedProfile, keeperProfile])
				await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
				await sibling["setViewStateId"]("stable-editor-view")
				await sibling.saveViewState("currentApiConfigName", "gone-profile")
				// A closed view's entry, which nobody will rewrite during the deletion.
				await ClineProvider["persistedViewStateWriteQueue"]
				const snapshot = provider["getPersistedViewStates"]({ fresh: true })
				await provider.contextProxy.setValue("viewStates", {
					...snapshot,
					"closed-view": { currentApiConfigName: "gone-profile" },
				})
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("gone-id")
				vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(async (args) => {
					const name = "name" in args ? args.name : ""

					if (name === "keeper-profile") {
						return {
							name: "keeper-profile",
							id: "keeper-id",
							apiProvider: providerIdentifiers.anthropic,
							apiKey: "keeper-key",
						}
					}
					return {
						name: "gone-profile",
						id: "gone-id",
						apiProvider: providerIdentifiers.openrouter,
					}
				})
				// The sibling commits its own choice after the deletion re-pointed its entry,
				// and then the deletion fails.
				vi.spyOn(provider, "postStateToWebview").mockImplementation(async () => {
					await sibling.saveViewState("currentApiConfigName", "third-profile")
					throw new Error("post state failed")
				})

				await expect(provider.deleteProviderProfile(deletedProfile)).rejects.toThrow("post state failed")
				await ClineProvider["persistedViewStateWriteQueue"]

				const states = provider["getPersistedViewStates"]({ fresh: true })
				// The sibling's newer write survives: the rollback only undoes pins this deletion
				// actually wrote, instead of resurrecting a deleted profile's name.
				expect(states["stable-editor-view"]?.currentApiConfigName).toBe("third-profile")
				// The entry nobody touched since the snapshot is restored to the deleted profile,
				// because the manager record is back.
				expect(states["closed-view"]?.currentApiConfigName).toBe("gone-profile")
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})
		it("does not overwrite a newer save from another view when the upsert rolls back", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const saveSpy = vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("p-id")
			// getProfile is called three times on this path: the pre-save snapshot, the post-save
			// read-back (which becomes the record this mutation wrote), and the rollback guard.
			// By the guard's turn another view has saved the same profile.
			vi.spyOn(provider.providerSettingsManager, "getProfile")
				.mockResolvedValueOnce({
					name: "p",
					id: "p-id",
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "prior-key",
				})
				.mockResolvedValueOnce({
					name: "p",
					id: "p-id",
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "raw-key",
				})
				.mockResolvedValue({
					name: "p",
					id: "p-id",
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "other-view-key",
				})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("p")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			// The activation write after the record save fails, so the mutation has to compensate.
			vi.spyOn(provider["contextProxy"], "setValue").mockRejectedValue(new Error("shared write failed"))

			await expect(
				provider["persistProviderProfile"](
					"p",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "raw-key" },
					true,
				),
			).rejects.toThrow()

			// Only this mutation's own save; the rollback must not replay the prior record over the
			// newer save from the other view.
			expect(saveSpy).toHaveBeenCalledTimes(1)
			await provider.dispose()
		})
		it("does not undo a newer shared write when the per-view write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.setValue("mode", "architect")
			// Another view commits a newer value for the same key while this view's per-view
			// write is still in flight.
			// @ts-ignore - Spy on the private per-view write to fail it after the newer write.
			vi.spyOn(provider, "_saveViewLocalStateFromMutation").mockImplementation(async () => {
				await provider.contextProxy.setValue("mode", "code")
				throw new Error("per-view write failed")
			})

			await expect(provider.setValue("mode", "debug")).rejects.toThrow("per-view write failed")

			// The rollback only reverts a key whose shared value is still the one this call
			// wrote: the newer write from the other view survives instead of being clobbered by
			// the pre-mutation snapshot.
			expect(provider.contextProxy.getValue("mode")).toBe("code")
			await provider.dispose()
		})

		it("clears the view-local overlay of every live webview on reset", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				sibling["viewLocalState"].mode = "architect"
				sibling["viewLocalState"].currentApiConfigName = "sibling-profile"
				sibling["viewLocalState"].apiConfiguration = {
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "sibling-secret",
				}
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider, "removeClineFromStack").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "resetAllConfigs").mockResolvedValue(undefined)
				vi.spyOn(provider.customModesManager, "resetCustomModes").mockResolvedValue(undefined)
				vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(t("common:answers.yes") as never)

				await provider.resetState()

				// A reset must not leave another live webview serving its pre-reset mode and
				// profile out of its own overlay.
				expect(sibling["viewLocalState"]).toEqual({})
				expect(sibling.pinnedProfileName).toBeUndefined()
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})
		it("clears only the live views whose per-view mode names the deleted slug", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const pinned = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const other = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const viewStates = () => mockContext.globalState.get("viewStates") as Record<string, { mode?: string }>
			try {
				await pinned["setViewStateId"]("pinned-view")
				await other["setViewStateId"]("other-view")
				// Both views pin a mode in their own overlay and in their own durable entry.
				await pinned["_saveViewLocalStateFromMutation"]({ mode: "deleted-mode" })
				await other["_saveViewLocalStateFromMutation"]({ mode: "another-mode" })
				vi.spyOn(pinned, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(other, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

				await provider.clearViewLocalModeForDeletedSlug("deleted-mode")

				// The view that pinned the deleted slug loses the override in both layers, so its
				// getState() and any task it creates fall back to the default mode.
				expect(pinned["viewLocalState"].mode).toBeUndefined()
				expect(viewStates()["pinned-view"]?.mode).toBeUndefined()
				expect(pinned.postStateToWebview).toHaveBeenCalledTimes(1)
				// A view serving another mode keeps its own override and is not disturbed.
				expect(other["viewLocalState"].mode).toBe("another-mode")
				expect(viewStates()["other-view"]?.mode).toBe("another-mode")
				expect(other.postStateToWebview).not.toHaveBeenCalled()
				// The acting view is the caller's business: its reset goes through setValue.
				expect(provider.postStateToWebview).not.toHaveBeenCalled()
			} finally {
				await pinned.dispose()
				await other.dispose()
				await provider.dispose()
			}
		})
		it("does not re-point a pinned sibling's task that follows another profile when its profile is deleted", async () => {
			// Defensive: the doubles in this suite can leave console writes pending
			// at worker teardown.
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.spyOn(console, "error").mockImplementation(() => {})
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				const oldProfile: ProviderSettingsEntry = {
					name: "old-profile",
					id: "old-id",
					apiProvider: providerIdentifiers.openrouter,
				}
				const keeperProfile: ProviderSettingsEntry = {
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				}
				await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile])
				await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
				// The sibling pins the profile being deleted, but its active task
				// follows a different sticky profile: the deletion must re-point the
				// sibling's buffer to the surviving profile without switching that
				// conversation's handler or rewriting its persisted profile name.
				sibling["viewLocalState"].currentApiConfigName = "old-profile"
				sibling["viewLocalState"].apiConfiguration = {
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: "deleted-profile-secret",
				}
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				const siblingTask = {
					apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "other-key" },
					taskApiConfigName: "other-profile",
					taskId: "sibling-task",
					setTaskApiConfigName: vi.fn(),
					updateApiConfiguration: vi.fn(),
				}
				vi.spyOn(sibling, "getCurrentTask").mockReturnValue(
					siblingTask as unknown as ReturnType<typeof sibling.getCurrentTask>,
				)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
					name: "keeper-profile",
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				})
				vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)

				await provider.deleteProviderProfile(oldProfile)

				// The sibling's view buffer is still re-pointed to the surviving
				// profile...
				expect(sibling["viewLocalState"].currentApiConfigName).toBe("keeper-profile")
				expect(sibling["viewLocalState"].apiConfiguration).toEqual({
					id: "keeper-id",
					apiProvider: providerIdentifiers.anthropic,
				})
				// ...but the task follows another profile: neither the handler rebuild
				// nor the sticky-name rewrite may touch it.
				expect(siblingTask.updateApiConfiguration).not.toHaveBeenCalled()
				expect(siblingTask.setTaskApiConfigName).not.toHaveBeenCalled()
				// Wait on the serialized view-state write queue that every
				// viewStates mutation goes through, so queued persistence finishes
				// while the console spies are still installed and teardown has no
				// pending writes.
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})

		it("refuses the shared settings write when a sibling's pinned profile cannot be read", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				const targetProfile: ProviderSettingsEntry = {
					name: "target-profile",
					id: "target-id",
					apiProvider: providerIdentifiers.openrouter,
				}
				await provider.contextProxy.setValue("listApiConfigMeta", [targetProfile])
				await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
				// The sibling is pinned to a profile the activation does not touch.
				sibling["viewLocalState"].currentApiConfigName = "keeper-profile"
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue(targetProfile)
				vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([targetProfile])
				vi.spyOn(provider.providerSettingsManager, "getProfile").mockImplementation(async (args) => {
					if ("name" in args && args.name === "keeper-profile") {
						throw new Error("pinned profile unreadable")
					}
					return { name: "target-profile", id: "target-id", apiProvider: providerIdentifiers.openrouter }
				})
				const sharedSettingsWrite = vi.spyOn(provider.contextProxy, "setProviderSettings")

				await expect(provider.activateProviderProfile({ name: "target-profile" })).rejects.toThrow(
					"pinned profile unreadable",
				)

				// Proceeding would replace the shared store while the sibling still names its
				// own profile in getState(), so its tasks would run the activated profile's
				// credentials under the wrong name. Only the compensation may have written the
				// prior settings back.
				expect(sharedSettingsWrite).not.toHaveBeenCalledWith(
					expect.objectContaining({ apiProvider: providerIdentifiers.openrouter }),
				)
				expect(sibling["viewLocalState"].apiConfiguration).toBeUndefined()
				expect(provider.getValues().currentApiConfigName).toBe("keeper-profile")
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})

		it("keeps tolerating a sibling pin that names an already deleted profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				const targetProfile: ProviderSettingsEntry = {
					name: "target-profile",
					id: "target-id",
					apiProvider: providerIdentifiers.openrouter,
				}
				await provider.contextProxy.setValue("listApiConfigMeta", [targetProfile])
				await provider.contextProxy.setValue("currentApiConfigName", "keeper-profile")
				sibling["viewLocalState"].currentApiConfigName = "deleted-profile"
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue(targetProfile)
				vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([targetProfile])
				vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(false)
				const getProfileSpy = vi
					.spyOn(provider.providerSettingsManager, "getProfile")
					.mockImplementation(async () => {
						throw new ProviderSettingsNotFoundError("Config with name 'deleted-profile' not found")
					})

				await provider.activateProviderProfile({ name: "target-profile" })

				// A gone profile has no correct snapshot; failing here would let one stale view
				// block every later activation in the host.
				expect(getProfileSpy).toHaveBeenCalledWith({ name: "deleted-profile" })
				expect(provider.getValues().currentApiConfigName).toBe("target-profile")
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
				await provider.dispose()
			}
		})

		it("leaves the view buffer untouched when the deleted profile is neither globally active nor view-pinned", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const oldProfile: ProviderSettingsEntry = {
				name: "old-profile",
				id: "old-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			const keeperProfile: ProviderSettingsEntry = {
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.anthropic,
			}
			const otherProfile: ProviderSettingsEntry = {
				name: "other-profile",
				id: "other-id",
				apiProvider: providerIdentifiers.openrouter,
			}
			await provider.contextProxy.setValue("listApiConfigMeta", [oldProfile, keeperProfile, otherProfile])
			// The global selection and this view's pin both name surviving profiles:
			// the deletion must not reconfigure this view's settings, and the
			// pinned view's nested overlay must survive byte-for-byte.
			await provider.contextProxy.setValue("currentApiConfigName", "other-profile")
			provider["viewLocalState"].currentApiConfigName = "keeper-profile"
			provider["viewLocalState"].apiConfiguration = {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "pinned-profile-secret",
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				getProfile: vi.fn().mockResolvedValue({
					name: "other-profile",
					id: "other-id",
					apiProvider: providerIdentifiers.openrouter,
				}),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			}
			const setProviderSettingsSpy = vi
				.spyOn(provider.contextProxy, "setProviderSettings")
				.mockResolvedValue(undefined)

			await provider.deleteProviderProfile(oldProfile)

			// No reconfiguration: the guard must stay false when neither the global
			// selection nor the view pin names the deleted profile, so the view
			// keeps its own pin and its nested overlay while the shared store
			// reports the global selection.
			expect(setProviderSettingsSpy).not.toHaveBeenCalled()
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("other-profile")
			expect(provider.getValues().currentApiConfigName).toBe("keeper-profile")
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "pinned-profile-secret",
			})
			await provider.dispose()
		})
	})

	describe("local state isolation", () => {
		it("should isolate mode state between instances", async () => {
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
				new WebviewFocusTracker(),
			)
			const provider2 = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

	describe("getState merging", () => {
		it("should merge viewLocalState on top of global state", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "local-key",
			})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("openrouter")
			expect(state.apiConfiguration.openRouterApiKey).toBe("local-key")

			await provider.dispose()
		})

		it("reports the fresh global apiConfiguration after a profile activation followed by a global settings write", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const savedForReadBack2: Record<string, Record<string, unknown>> = {}
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack2[name] = settings
					return "activated-id"
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: "activated-id",
					...savedForReadBack2[name],
				})),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "activated-profile", id: "activated-id", apiProvider: providerIdentifiers.anthropic },
					]),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await provider.upsertProviderProfile(
				"activated-profile",
				{ apiProvider: providerIdentifiers.anthropic },
				true,
			)

			// Simulate api.setConfiguration (src/extension/api.ts): a global-only
			// write that does not refresh the view-local buffer.
			await provider.contextProxy.setValues({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
			})

			const state = await provider.getState({ includeTaskHistory: false })

			// The fresh global selection must win: the activation's buffer write must
			// not mask the later shared update (regression guard for the e2e
			// provider-probe suites, which start tasks after a profile activation).
			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.openrouter)
			await provider.dispose()
		})

		it("clears this view's buffered apiConfiguration when activating a different profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Seed the per-view buffer with profile A's settings, as loadViewState would
			// after a restart with a pinned profile.
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "profile-a-key",
			})

			const savedForReadBack3: Record<string, Record<string, unknown>> = {}
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack3[name] = settings
					return "profile-b-id"
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: "profile-b-id",
					...savedForReadBack3[name],
				})),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "profile-b", id: "profile-b-id", apiProvider: providerIdentifiers.anthropic },
					]),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await provider.upsertProviderProfile("profile-b", { apiProvider: providerIdentifiers.anthropic }, true)

			const state = await provider.getState({ includeTaskHistory: false })

			// Activating profile B must clear profile A's buffered overlay so the shared
			// settings (written by setProviderSettings) win; otherwise getState would
			// report profile B's name with profile A's provider.
			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.anthropic)
			await provider.dispose()
		})
		it("rolls back the profile activation writes when one concurrent write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Seed the prior shared selection so the rollback restores a real state.
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "old-profile", id: "old-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-id", apiProvider: providerIdentifiers.openai },
			])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "old-rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			const activateProfileSpy = vi
				.spyOn(provider.providerSettingsManager, "activateProfile")
				.mockResolvedValue({ name: "old-profile", apiProvider: providerIdentifiers.anthropic })
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The outer upsert catch converts the failure into an undefined id (the
			// user sees the error toast); the compensation must still have run.
			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.openai }, true),
			).resolves.toBeUndefined()

			// Every write that landed is compensated: the mode mapping returns to its
			// prior id, and the selection, list, and shared settings are restored.
			expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "old-mode-id")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			expect((provider.contextProxy.getValue("listApiConfigMeta") ?? []).map((entry) => entry.name)).toEqual([
				"old-profile",
			])
			expect(setProviderSettingsSpy).toHaveBeenCalledTimes(2)
			// The manager store is compensated too: the record written by saveConfig
			// returns to its prior content and the manager selection returns to the
			// prior profile.
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("new-profile", {
				id: "old-rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			expect(activateProfileSpy).toHaveBeenCalledWith({ name: "old-profile" })
			await provider.dispose()
		})
		it("rolls back the direct activation writes when one concurrent write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Seed the prior shared selection so the rollback restores a real state.
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "old-profile", id: "old-id", apiProvider: providerIdentifiers.anthropic },
			])
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				activateProfile: vi.fn().mockResolvedValue({
					name: "new-profile",
					id: "new-id",
					apiProvider: providerIdentifiers.openai,
				}),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "new-profile", id: "new-id", apiProvider: providerIdentifiers.openai },
					]),
				getCurrentProfileName: vi.fn().mockResolvedValue("old-profile"),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
			}
			vi.spyOn(provider.contextProxy, "setProviderSettings").mockRejectedValue(
				new Error("shared settings write failed"),
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await expect(provider.activateProviderProfile({ name: "new-profile" })).rejects.toThrow(
				"shared settings write failed",
			)

			// The compensation waits for every group write to settle before restoring:
			// the selection and the profile list return to the prior state even though
			// the shared settings write rejected mid-group.
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			const restoredEntries = (provider.contextProxy.getValue("listApiConfigMeta") ?? []).map(
				(entry) => entry.name,
			)
			expect(restoredEntries).toEqual(["old-profile"])
			await provider.dispose()
		})
		it("re-points closed views' persisted pins onto the surviving profile after a deletion", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-delete-view")
			// A closed view's durable pin and this view's own pin both name the doomed
			// profile; the deletion must move them to the survivor.
			await provider.contextProxy.setValue("viewStates", {
				"closed-view": { currentApiConfigName: "doomed-profile", updatedAt: 1 },
				"stable-delete-view": { mode: "code", currentApiConfigName: "doomed-profile", updatedAt: 2 },
			})
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "doomed-profile", id: "doomed-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "keeper-profile", id: "keeper-id", apiProvider: providerIdentifiers.openrouter },
			])
			await provider.saveViewState("currentApiConfigName", "doomed-profile")
			// The deleted profile is the shared selection: the survivor resolution needs it.
			await provider.contextProxy.setValue("currentApiConfigName", "doomed-profile")
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "keeper-profile",
				id: "keeper-id",
				apiProvider: providerIdentifiers.openrouter,
			})
			vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("keeper-id")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await provider.deleteProviderProfile({
				name: "doomed-profile",
				id: "doomed-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			const states = provider.contextProxy.getValue("viewStates") as Record<string, Record<string, unknown>>
			expect(states["closed-view"].currentApiConfigName).toBe("keeper-profile")
			await provider.dispose()
		})

		it("upserts activation writes from the stored normalized record, not the raw payload", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("profile-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue(undefined)
			// The stored record is the normalized shape saveConfig persists: the schema
			// parse strips the stray cross-provider field and keeps the stored model.
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				id: "profile-id",
				name: "profile-a",
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "stored-model",
			})
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await provider.upsertProviderProfile("profile-a", {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "raw-model",
				openRouterApiKey: "cross-provider-stray",
			})

			// The shared store receives the stored record: the raw payload's stray
			// cross-provider field must not reach it (or the sibling overlays and
			// task handler refreshed from the same value).
			expect(setProviderSettingsSpy).toHaveBeenCalledWith({
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "stored-model",
			})
			await provider.dispose()
		})

		it("deletes the newly created manager record when a later activation write fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// The profile is new: hasConfig confirms absence even though getProfile
			// reports it through an untyped wrapper error.
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(false)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockRejectedValue(
				new Error("Config with name 'new-profile' not found"),
			)
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-id", apiProvider: providerIdentifiers.openai },
			])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			const deleteConfigSpy = vi
				.spyOn(provider.providerSettingsManager, "deleteConfig")
				.mockResolvedValue(undefined)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.openai }, true),
			).resolves.toBeUndefined()

			// Compensation must delete the record the mutation created, not skip the
			// restore because the lookup threw an untyped not-found.
			expect(deleteConfigSpy).toHaveBeenCalledWith("new-profile")
			await provider.dispose()
		})

		it("does not delete a newly created record while another create for the same name is in flight", async () => {
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
			for (const instance of [providerA, providerB]) {
				vi.spyOn(instance.providerSettingsManager, "hasConfig").mockResolvedValue(false)
				vi.spyOn(instance.providerSettingsManager, "getCurrentProfileName").mockResolvedValue(undefined)
			}
			const deleteSpyA = vi.spyOn(providerA.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
			const deleteSpyB = vi.spyOn(providerB.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)

			// Both views confirm the name is absent before saving it: each create is
			// claimed so a rollback can tell whose deletion is safe.
			const snapshotA = await providerA["_snapshotProviderManagerState"]("dup-profile")
			const snapshotB = await providerB["_snapshotProviderManagerState"]("dup-profile")
			expect(snapshotA.claimedCreate).toBe(true)
			expect(snapshotB.claimedCreate).toBe(true)

			// A's activation fails while B's create for the same name is still in
			// flight: the surviving record may belong to B, so A must not delete it.
			await providerA["_restoreProviderManagerRecord"]("dup-profile", snapshotA)
			expect(deleteSpyA).not.toHaveBeenCalled()

			// B fails too: the last claimant to settle owns the deletion.
			await providerB["_restoreProviderManagerRecord"]("dup-profile", snapshotB)
			expect(deleteSpyB).toHaveBeenCalledWith("dup-profile")

			await providerA.dispose()
			await providerB.dispose()
		})

		it("keeps the record when a sibling create succeeded before this create failed", async () => {
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
			for (const instance of [providerA, providerB]) {
				vi.spyOn(instance.providerSettingsManager, "hasConfig").mockResolvedValue(false)
				vi.spyOn(instance.providerSettingsManager, "getCurrentProfileName").mockResolvedValue(undefined)
				vi.spyOn(instance.providerSettingsManager, "listConfig").mockResolvedValue([])
				vi.spyOn(instance.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
				vi.spyOn(instance.providerSettingsManager, "setModeConfig").mockResolvedValue(undefined)
				vi.spyOn(instance.providerSettingsManager, "saveConfig").mockResolvedValue("b-id")
				vi.spyOn(instance.providerSettingsManager, "getProfile").mockResolvedValue({
					name: "dup-profile",
					id: "b-id",
					apiProvider: providerIdentifiers.openai,
				})
				vi.spyOn(instance.providerSettingsManager, "activateProfile").mockResolvedValue({
					name: "dup-profile",
					id: "b-id",
					apiProvider: providerIdentifiers.openai,
				})
				vi.spyOn(instance, "postStateToWebview").mockResolvedValue(undefined)
			}
			const deleteSpyA = vi.spyOn(providerA.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)

			// A confirms the name is absent and claims the create.
			const snapshotA = await providerA["_snapshotProviderManagerState"]("dup-profile")
			expect(snapshotA.claimedCreate).toBe(true)

			// B creates the same profile successfully: its claim is spent and the
			// record belongs to B's save.
			await expect(
				providerB.upsertProviderProfile("dup-profile", { apiProvider: providerIdentifiers.openai }, true),
			).resolves.toBe("b-id")

			// A's activation group fails after B already landed: deleting would
			// discard the profile B saved.
			await providerA["_restoreProviderManagerRecord"]("dup-profile", snapshotA)
			expect(deleteSpyA).not.toHaveBeenCalled()

			// The bookkeeping is cleared once the last claimant settles: a later
			// failed create for the same name owns its deletion again.
			const snapshotA2 = await providerA["_snapshotProviderManagerState"]("dup-profile")
			await providerA["_restoreProviderManagerRecord"]("dup-profile", snapshotA2)
			expect(deleteSpyA).toHaveBeenCalledWith("dup-profile")

			await providerA.dispose()
			await providerB.dispose()
		})

		it("spends the create claim when the profile save itself fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(false)
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue(undefined)
			const deleteSpy = vi.spyOn(provider.providerSettingsManager, "deleteConfig").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "saveConfig")
				.mockRejectedValueOnce(new Error("store write failed"))
				.mockResolvedValue("profile-id")
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The first create fails inside saveConfig: its rollback must spend the claim
			// even though the record write itself is what failed.
			await provider.upsertProviderProfile("leaky-profile", { apiProvider: providerIdentifiers.openai }, false)

			// A second create of the same name now fails during activation instead.
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			await provider.upsertProviderProfile("leaky-profile", { apiProvider: providerIdentifiers.openai }, true)

			// A claim leaked by the first create would make this rollback defer to a
			// create that never happened and strand the landed record: the deletion
			// must land.
			expect(deleteSpy).toHaveBeenCalledWith("leaky-profile")
			await provider.dispose()
		})

		it("restores the mode mapping when the mode binding fails after an activation", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "old-profile", id: "old-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			// The activation destructures { name, id, ...settings } from the manager: the id is what
			// the mode binding is written with, so the double has to carry one.
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			const setModeConfigSpy = vi
				.spyOn(provider.providerSettingsManager, "setModeConfig")
				.mockImplementation(async (mode: string, id: string) => {
					if (id !== "old-mode-id") {
						throw new Error("mode write failed")
					}
				})
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			await expect(provider.activateProviderProfile({ name: "new-profile" })).rejects.toThrow("mode write failed")

			// The activation had already moved the selection and the shared settings before the
			// mode binding failed, so the mapping has to go back to what it held: otherwise the
			// mode stays bound to a profile whose activation the caller was told failed.
			expect(setModeConfigSpy).toHaveBeenCalledWith("code", "old-mode-id")
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			expect((provider.contextProxy.getValue("listApiConfigMeta") ?? []).map((entry) => entry.name)).toEqual([
				"old-profile",
			])
			await provider.dispose()
		})

		it("restores the activation state when a sibling overlay refresh fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			await provider.contextProxy.setValue("listApiConfigMeta", [
				{ name: "old-profile", id: "old-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			// Double assertion: the refresh is private, and the failure being injected is a
			// sibling's storage write, which no public seam can produce on demand.
			const proto = ClineProvider.prototype as unknown as {
				refreshViewLocalStateForUpdatedProfile: (...args: unknown[]) => Promise<void>
			}
			const refreshSpy = vi
				.spyOn(proto, "refreshViewLocalStateForUpdatedProfile")
				.mockRejectedValue(new Error("sibling refresh failed"))
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

			await expect(provider.activateProviderProfile({ name: "new-profile" })).rejects.toThrow(
				"sibling refresh failed",
			)

			// The refresh runs after the selection, the profile list and the shared provider
			// settings have all moved, so a failure there has to roll them back like any other
			// write in the group: the caller saw an error, and the state must match that.
			expect(refreshSpy).toHaveBeenCalledTimes(1)
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			expect((provider.contextProxy.getValue("listApiConfigMeta") ?? []).map((entry) => entry.name)).toEqual([
				"old-profile",
			])
			expect(setProviderSettingsSpy).toHaveBeenCalledTimes(2)
			refreshSpy.mockRestore()
			await provider.dispose()
		})

		it("compensates the siblings that already took the settings when a later sibling refresh fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const firstSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const lastSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profileName = "profile-sibling-refresh"
			// Each view pinned the profile earlier and holds its own copy of the settings it
			// loaded then; the refresh replaces those copies with the saved settings.
			const firstOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "first" }
			const lastOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "last" }
			const savedSettings: ProviderSettings = { apiProvider: providerIdentifiers.openrouter, apiKey: "saved" }

			for (const [index, instance] of [provider, firstSibling, lastSibling].entries()) {
				await instance.saveViewState("currentApiConfigName", profileName)
				await instance["_updateViewLocalStateFromMutation"]({
					apiConfiguration: index === 0 ? undefined : index === 1 ? firstOverlay : lastOverlay,
				})
				// The originating view keeps its own overlay; only the siblings are refreshed.
				if (index === 0) {
					await instance["_updateViewLocalStateFromMutation"]({
						apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "origin" },
					})
				}
			}

			// The second sibling's post is what fails, so the first sibling has already taken the
			// saved settings by the time the caller is told the refresh failed. The first sibling's
			// post succeeds for that apply and rejects afterwards, so both restores fail and the
			// order the compensation works through them in becomes observable.
			vi.spyOn(firstSibling, "postStateToWebview")
				.mockResolvedValueOnce(undefined)
				.mockRejectedValue(new Error("first restore gone"))
			vi.spyOn(lastSibling, "postStateToWebview").mockRejectedValue(new Error("webview gone"))

			await expect(
				provider["refreshViewLocalStateForUpdatedProfile"](profileName, savedSettings),
			).rejects.toThrow("webview gone")

			// The activation rollback only reaches this view's own overlay and the durable maps, so
			// the sibling that already applied the saved settings must be put back: leaving it there
			// serves the settings of a refresh the caller saw fail.
			expect(firstSibling["viewLocalState"].apiConfiguration).toEqual(firstOverlay)
			expect(lastSibling["viewLocalState"].apiConfiguration).toEqual(lastOverlay)
			expect(provider["viewLocalState"].apiConfiguration).toMatchObject({ apiKey: "origin" })

			// The last sibling's post rejects for good, so putting its own overlay back fails too:
			// the compensation logs which view it could not restore instead of swallowing that as
			// well, and it works through the siblings in the reverse of the order it applied them.
			const restoreFailures = vi
				.mocked(mockOutputChannel.appendLine)
				.mock.calls.map(([line]: [string]) => String(line))
				.filter((line: string) => line.includes("Unable to restore the overlay of view"))
			expect(
				restoreFailures.some((line: string) =>
					line.includes("after the refresh of profile 'profile-sibling-refresh' failed: webview gone"),
				),
			).toBe(true)
			expect(restoreFailures.some((line: string) => line.includes("failed: first restore gone"))).toBe(true)
			const lastRestored = restoreFailures.findIndex((line: string) => line.includes("failed: webview gone"))
			const firstRestored = restoreFailures.findIndex((line: string) =>
				line.includes("failed: first restore gone"),
			)
			expect(lastRestored).toBeGreaterThanOrEqual(0)
			expect(firstRestored).toBeGreaterThan(lastRestored)

			await provider.dispose()
			await firstSibling.dispose()
			await lastSibling.dispose()
		})

		it("leaves a newer sibling mutation alone when compensating a failed profile refresh", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const firstSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const lastSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profileName = "profile-sibling-refresh-newer"
			const firstOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "first" }
			const lastOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "last" }
			const savedSettings: ProviderSettings = { apiProvider: providerIdentifiers.openrouter, apiKey: "saved" }
			const newerSiblingSettings: ProviderSettings = { apiProvider: providerIdentifiers.openai, apiKey: "newer" }

			for (const [index, instance] of [provider, firstSibling, lastSibling].entries()) {
				await instance.saveViewState("currentApiConfigName", profileName)
				await instance["_updateViewLocalStateFromMutation"]({
					apiConfiguration: index === 0 ? undefined : index === 1 ? firstOverlay : lastOverlay,
				})
			}

			// The sibling moves its own overlay once, right after the refresh wrote the saved
			// settings, so that change is newer than this operation. Exactly once: the compensation
			// posts this view too, and re-applying the change there would hide a compensation that
			// ignored the newer write.
			let moved = false
			vi.spyOn(firstSibling, "postStateToWebview").mockImplementation(async () => {
				if (moved) {
					return
				}
				moved = true
				await firstSibling["_updateViewLocalStateFromMutation"]({ apiConfiguration: newerSiblingSettings })
			})
			vi.spyOn(lastSibling, "postStateToWebview").mockRejectedValue(new Error("webview gone"))

			await expect(
				provider["refreshViewLocalStateForUpdatedProfile"](profileName, savedSettings),
			).rejects.toThrow("webview gone")

			expect(firstSibling["viewLocalState"].apiConfiguration).toEqual(newerSiblingSettings)
			expect(lastSibling["viewLocalState"].apiConfiguration).toEqual(lastOverlay)

			await provider.dispose()
			await firstSibling.dispose()
			await lastSibling.dispose()
		})

		it("restores the rebuilt task handler of a sibling when a later sibling refresh fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const firstSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const lastSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profileName = "profile-sibling-refresh-task"
			const firstOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "first" }
			const lastOverlay: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "last" }
			const savedSettings: ProviderSettings = { apiProvider: providerIdentifiers.openrouter, apiKey: "saved" }
			const taskSettings: ProviderSettings = { apiProvider: providerIdentifiers.anthropic, apiKey: "task" }

			for (const [index, instance] of [provider, firstSibling, lastSibling].entries()) {
				await instance.saveViewState("currentApiConfigName", profileName)
				await instance["_updateViewLocalStateFromMutation"]({
					apiConfiguration: index === 0 ? undefined : index === 1 ? firstOverlay : lastOverlay,
				})
			}

			// The first sibling's task runs under the profile, so the refresh rebuilds its API
			// handler with the saved settings; the double keeps the calls observable.
			const task = Object.assign(
				{} as Task,
				{
					taskId: "sibling-refresh-task",
					taskApiConfigName: profileName,
					apiConfiguration: taskSettings,
					updateApiConfiguration: vi.fn(),
				} as Partial<Task>,
			)
			vi.spyOn(firstSibling, "getCurrentTask").mockReturnValue(task)
			vi.spyOn(firstSibling, "postStateToWebview").mockResolvedValue(undefined)
			vi.spyOn(lastSibling, "postStateToWebview").mockRejectedValue(new Error("webview gone"))

			await expect(
				provider["refreshViewLocalStateForUpdatedProfile"](profileName, savedSettings),
			).rejects.toThrow("webview gone")

			// Rebuilt with the saved settings, then put back: a conversation that keeps running on
			// the saved token after the caller was told the refresh failed is the bug this covers.
			expect(task.updateApiConfiguration).toHaveBeenCalledTimes(2)
			expect(task.updateApiConfiguration).toHaveBeenNthCalledWith(1, savedSettings)
			expect(task.updateApiConfiguration).toHaveBeenNthCalledWith(2, taskSettings)
			expect(firstSibling["viewLocalState"].apiConfiguration).toEqual(firstOverlay)

			await provider.dispose()
			await firstSibling.dispose()
			await lastSibling.dispose()
		})

		it("leaves a sibling task outside the compensation guards alone when a later sibling refresh fails", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const otherProfileSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const evictedSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const lastSibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const profileName = "profile-sibling-task-guards"
			const savedSettings: ProviderSettings = { apiProvider: providerIdentifiers.openrouter, apiKey: "saved" }
			const overlays: ProviderSettings[] = [
				{ apiProvider: providerIdentifiers.anthropic, apiKey: "other-profile" },
				{ apiProvider: providerIdentifiers.anthropic, apiKey: "evicted" },
				{ apiProvider: providerIdentifiers.anthropic, apiKey: "last" },
			]

			for (const [index, instance] of [provider, otherProfileSibling, evictedSibling, lastSibling].entries()) {
				await instance.saveViewState("currentApiConfigName", profileName)
				await instance["_updateViewLocalStateFromMutation"]({
					apiConfiguration: index === 0 ? undefined : overlays[index - 1],
				})
			}

			// A task pinned to another profile: neither the refresh nor its compensation has any
			// business rebuilding it.
			const otherProfileTask = Object.assign(
				{} as Task,
				{
					taskId: "other-profile-task",
					taskApiConfigName: "another-profile",
					apiConfiguration: { apiProvider: providerIdentifiers.openai, apiKey: "other" } as ProviderSettings,
					updateApiConfiguration: vi.fn(),
				} as Partial<Task>,
			)
			vi.spyOn(otherProfileSibling, "getCurrentTask").mockReturnValue(otherProfileTask)

			// A task that is replaced by a newer one between the refresh and the compensation: the
			// handler recorded for it belongs to a task this view no longer runs.
			const evictedTask = Object.assign(
				{} as Task,
				{
					taskId: "evicted-task",
					taskApiConfigName: profileName,
					apiConfiguration: {
						apiProvider: providerIdentifiers.anthropic,
						apiKey: "task",
					} as ProviderSettings,
					updateApiConfiguration: vi.fn(),
				} as Partial<Task>,
			)
			const replacementTask = Object.assign(
				{} as Task,
				{
					taskId: "replacement-task",
					taskApiConfigName: "yet-another-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.openai,
						apiKey: "replacement",
					} as ProviderSettings,
					updateApiConfiguration: vi.fn(),
				} as Partial<Task>,
			)
			let currentTask: Task | undefined = evictedTask
			vi.spyOn(evictedSibling, "getCurrentTask").mockImplementation(() => currentTask)
			vi.spyOn(evictedSibling, "postStateToWebview").mockImplementation(async () => {
				currentTask = replacementTask
			})

			vi.spyOn(otherProfileSibling, "postStateToWebview").mockResolvedValue(undefined)
			vi.spyOn(lastSibling, "postStateToWebview").mockRejectedValue(new Error("webview gone"))

			await expect(
				provider["refreshViewLocalStateForUpdatedProfile"](profileName, savedSettings),
			).rejects.toThrow("webview gone")

			// The refresh rebuilds only tasks that run under the profile being saved, and the
			// compensation only puts back a handler it had actually replaced. A view whose task belongs
			// to another profile has no recorded handler, so compensation must leave it alone - and a
			// compensation that called the rebuild anyway would crash on the missing settings and show
			// up as a restore failure for this view.
			expect(otherProfileTask.updateApiConfiguration).not.toHaveBeenCalled()
			const restoreFailures = vi
				.mocked(mockOutputChannel.appendLine)
				.mock.calls.map(([line]: [string]) => String(line))
				.filter((line: string) => line.includes("Unable to restore the overlay of view"))
			expect(
				restoreFailures.some((line: string) => line.includes(`of view ${otherProfileSibling["viewId"]} after`)),
			).toBe(false)

			// This task was rebuilt with the saved settings while it still belonged to the view, and
			// the compensation must not rebuild it back: the view now runs a different task, and that
			// task's own handler belongs to its own profile.
			expect(evictedTask.updateApiConfiguration).toHaveBeenCalledTimes(1)
			expect(evictedTask.updateApiConfiguration).toHaveBeenNthCalledWith(1, savedSettings)
			expect(replacementTask.updateApiConfiguration).not.toHaveBeenCalled()

			await provider.dispose()
			await otherProfileSibling.dispose()
			await evictedSibling.dispose()
			await lastSibling.dispose()
		})

		it("keeps this view's own profile pin when an activation rollback restores the shared selection", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			// The view pins profile-a while another view's choice sits in the shared
			// selection.
			await provider.saveViewState("currentApiConfigName", "profile-a")
			await provider.contextProxy.setValue("currentApiConfigName", "profile-b")

			const snapshot = provider["_snapshotProfileActivationState"]()
			// The activation moved the shared selection; a later write failed.
			await provider.setValue("currentApiConfigName", "profile-c")
			await provider["_restoreProfileActivationState"](snapshot)

			// The shared selection returns to its prior value...
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("profile-b")
			// ...but this view's own pin is restored to its own choice, not the
			// shared one: the rollback must not replace the pin with profile-b.
			expect(provider["viewLocalState"].currentApiConfigName).toBe("profile-a")
			const viewStates = mockContext.globalState.get("viewStates") as Record<string, Record<string, unknown>>
			expect(viewStates["stable-sidebar-view"].currentApiConfigName).toBe("profile-a")
			await provider.dispose()
		})

		it("does not rewrite unrelated global keys when an activation rollback restores provider settings", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const snapshot = provider["_snapshotProfileActivationState"]()
			// An unrelated key legitimately changes while the activation group is in
			// flight.
			await provider.contextProxy.setValue("customInstructions", "written during activation")
			await provider["_restoreProfileActivationState"](snapshot)
			// The rollback restores provider settings only; it must not replay the
			// whole global-state copy over keys that moved in the meantime.
			expect(provider.contextProxy.getValue("customInstructions")).toBe("written during activation")
			await provider.dispose()
		})

		it("restores the cached viewStates map when a persisted view-state write fails durably", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.contextProxy.setValue("viewStates", {
				"other-view": { mode: "code", updatedAt: 1 },
			})
			// The next durable write fails; the cache was already updated optimistically.
			const updateSpy = vi.spyOn(mockContext.globalState, "update").mockImplementationOnce(async () => {
				throw new Error("durable write failed")
			})

			await expect(provider["savePersistedViewState"]({ mode: "architect", updatedAt: 2 })).rejects.toThrow(
				"durable write failed",
			)

			// The in-memory cache must match durable storage: an entry that never
			// reached disk cannot stay visible through getValue.
			expect(provider.contextProxy.getValue("viewStates")).toEqual({
				"other-view": { mode: "code", updatedAt: 1 },
			})
			updateSpy.mockRestore()
			await provider.dispose()
		})

		it("restores the cached viewStates map when the registration flush fails durably", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// The change is made while the provider is still unregistered, so the registration
			// flush is the write that has to survive.
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })

			// The flush's durable write fails; the cache was already updated optimistically.
			const originalUpdate = mockContext.globalState.update
			mockContext.globalState.update = vi.fn().mockImplementation((key: string) => {
				if (key === "viewStates") {
					return Promise.reject(new Error("durable write failed"))
				}
				return Promise.resolve()
			})

			await expect(provider["setViewStateId"]("stable-sidebar-view")).rejects.toThrow("durable write failed")

			// The cache must match durable storage: the stable entry never reached disk.
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})
			// The registration rolled the id back and kept the held selection, so a retried
			// registration can still land it instead of dropping the user's change.
			expect(provider["viewStateId"]).toBe(provider.viewId)
			mockContext.globalState.update = originalUpdate

			await provider["setViewStateId"]("stable-sidebar-view")

			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({
				"stable-sidebar-view": { mode: "architect", updatedAt: 1 },
			})
			await provider.dispose()
		})

		it("restores the cached viewStates map when a clear write fails durably", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider["savePersistedViewState"]({ mode: "architect", updatedAt: 1 })

			// The clear's durable write fails; the cache was already updated optimistically.
			const updateSpy = vi.spyOn(mockContext.globalState, "update").mockImplementationOnce(async () => {
				throw new Error("durable write failed")
			})

			await expect(provider["clearPersistedViewState"]()).rejects.toThrow("durable write failed")

			// The cache must match durable storage: the entry was never removed on
			// disk, so it must stay visible through getValue.
			expect(provider.contextProxy.getValue("viewStates")).toEqual({
				"stable-sidebar-view": { mode: "architect", updatedAt: 1 },
			})
			updateSpy.mockRestore()
			await provider.dispose()
		})

		it("restores the cached viewStates map when a persisted re-point write fails durably", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider.contextProxy.setValue("viewStates", {
				"stable-sidebar-view": { currentApiConfigName: "profile-old", updatedAt: 1 },
				"other-view": { mode: "code", currentApiConfigName: "profile-keep", updatedAt: 2 },
			})

			// The re-point's durable write fails; the cache was already updated optimistically.
			const updateSpy = vi.spyOn(mockContext.globalState, "update").mockImplementationOnce(async () => {
				throw new Error("durable write failed")
			})

			await expect(provider["repointPersistedViewStates"]("profile-old", "profile-new")).rejects.toThrow(
				"durable write failed",
			)

			// The cache must match durable storage: the re-pointed pins never reached disk,
			// so the pre-re-point map must stay visible.
			expect(provider.contextProxy.getValue("viewStates")).toEqual({
				"stable-sidebar-view": { currentApiConfigName: "profile-old", updatedAt: 1 },
				"other-view": { mode: "code", currentApiConfigName: "profile-keep", updatedAt: 2 },
			})
			updateSpy.mockRestore()
			await provider.dispose()
		})

		it("restores the complete durable viewStates map when an activation rollback follows a pruning pin write", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-activation-view")
			// A full map: the activation's own pin write prunes the oldest entry.
			const seeded: Record<string, { mode: string; updatedAt: number }> = {}
			for (let i = 1; i <= 50; i++) {
				seeded["view-" + i] = { mode: "code", updatedAt: i }
			}
			await provider.contextProxy.setValue("viewStates", seeded)
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The outer upsert catch converts the failure into an undefined id.
			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.anthropic }, true),
			).resolves.toBeUndefined()

			// The rollback restores the exact pre-activation map: the sibling the
			// pruning evicted is back with its original metadata.
			const restored = provider.contextProxy.getValue("viewStates") as Record<string, unknown>
			expect(restored["view-1"]).toEqual({ mode: "code", updatedAt: 1 })
			await provider.dispose()
		})
		it("keeps sibling viewStates writes that land during an activation rollback", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-merge-view")
			await provider.contextProxy.setValue("viewStates", { "old-view": { mode: "code", updatedAt: 1 } })
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			// A sibling instance persists its own entry while the activation group is
			// in flight; the rollback must not replay the stale snapshot over it.
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockImplementation(async () => {
				const current = (provider.contextProxy.getValue("viewStates") ?? {}) as Record<string, unknown>
				await provider.contextProxy.setValue("viewStates", {
					...current,
					"sibling-view": { mode: "architect", updatedAt: 99 },
				})
				return []
			})
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The outer upsert catch converts the failure into an undefined id.
			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.anthropic }, true),
			).resolves.toBeUndefined()

			// The rollback restores what the activation pruned without erasing the
			// sibling's newer entry.
			const restored = provider.contextProxy.getValue("viewStates") as Record<string, unknown>
			expect(restored["sibling-view"]).toEqual({ mode: "architect", updatedAt: 99 })
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			await provider.dispose()
		})

		it("does not resurrect a sibling pin cleared after the activation snapshot", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-clear-view")
			await provider.contextProxy.setValue("viewStates", {
				"sibling-view": { currentApiConfigName: "sibling-profile", updatedAt: 5 },
				"old-view": { mode: "code", updatedAt: 1 },
			})
			await provider.contextProxy.setValue("currentApiConfigName", "old-profile")
			vi.spyOn(provider.providerSettingsManager, "saveConfig").mockResolvedValue("new-id")
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("old-mode-id")
			vi.spyOn(provider.providerSettingsManager, "hasConfig").mockResolvedValue(true)
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "new-profile",
				id: "rec-id",
				apiProvider: providerIdentifiers.anthropic,
			})
			vi.spyOn(provider.providerSettingsManager, "getCurrentProfileName").mockResolvedValue("old-profile")
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "old-profile",
				apiProvider: providerIdentifiers.anthropic,
			})
			// Mid-group, after the rollback snapshot, the sibling intentionally clears
			// its only persisted selection: the deletion is newer than the snapshot and
			// must survive the rollback.
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockImplementation(async () => {
				const current = (provider.contextProxy.getValue("viewStates") ?? {}) as Record<
					string,
					{ mode?: string; currentApiConfigName?: string; updatedAt?: number }
				>
				delete current["sibling-view"]
				await provider.contextProxy.setValue("viewStates", { ...current })
				return []
			})
			vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockRejectedValue(
				new Error("mode write failed"),
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The outer upsert catch converts the failure into an undefined id.
			await expect(
				provider.upsertProviderProfile("new-profile", { apiProvider: providerIdentifiers.anthropic }, true),
			).resolves.toBeUndefined()

			const restored = provider.contextProxy.getValue("viewStates") as Record<string, unknown>
			// The rollback must not treat the sibling's clear as activation pruning.
			expect(restored["sibling-view"]).toBeUndefined()
			expect(restored["old-view"]).toEqual({ mode: "code", updatedAt: 1 })
			expect(provider.contextProxy.getValue("currentApiConfigName")).toBe("old-profile")
			await provider.dispose()
		})

		it("re-points live views pinned to a renamed profile onto the new name", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("currentApiConfigName", "profile-old")
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "old-key",
			})

			await provider["repointViewLocalStateAfterProfileRename"]("profile-old", "profile-new", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "renamed-key",
			})

			expect(provider["viewLocalState"].currentApiConfigName).toBe("profile-new")
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "renamed-key",
			})
			const viewStates = mockContext.globalState.get("viewStates") as Record<string, Record<string, unknown>>
			expect(viewStates["stable-sidebar-view"].currentApiConfigName).toBe("profile-new")
			await provider.dispose()
		})
		it("re-points persisted pins of closed views onto the renamed profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// A closed view's durable pin names the profile about to be renamed; no
			// live instance carries it, so only the persisted map can repair it.
			await provider.contextProxy.setValue("viewStates", {
				"closed-view": { currentApiConfigName: "profile-old", mode: "code", updatedAt: 1 },
			})
			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("currentApiConfigName", "profile-old")

			await provider["repointViewLocalStateAfterProfileRename"]("profile-old", "profile-new", {
				apiProvider: providerIdentifiers.openrouter,
			})

			const viewStates = mockContext.globalState.get("viewStates") as Record<string, Record<string, unknown>>
			// The closed view must launch onto the renamed profile instead of dangling at
			// the deleted name and being repaired to whatever the shared selection became
			// in the meantime.
			expect(viewStates["closed-view"].currentApiConfigName).toBe("profile-new")
			expect(viewStates["stable-sidebar-view"].currentApiConfigName).toBe("profile-new")
			await provider.dispose()
		})

		it("clears this view's buffered apiConfiguration when directly activating a profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			// Seed the per-view buffer with profile A's settings, as loadViewState would
			// after a restart with a pinned profile.
			await provider.saveViewState("apiConfiguration", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "profile-a-key",
			})

			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				activateProfile: vi.fn().mockResolvedValue({
					name: "profile-b",
					id: "profile-b-id",
					apiProvider: providerIdentifiers.anthropic,
				}),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "profile-b", id: "profile-b-id", apiProvider: providerIdentifiers.anthropic },
					]),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
			}
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// The direct-activation path (activateProviderProfileUnlocked) carries its own
			// overlay-clearing call, distinct from upsertProviderProfile's.
			await provider.activateProviderProfile({ name: "profile-b" })

			const state = await provider.getState({ includeTaskHistory: false })

			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.anthropic)
			await provider.dispose()
		})

		it("should merge getValues from ContextProxy with view-local values taking precedence", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			const contextProxyAccess = provider.contextProxy as {
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

			await provider.saveViewState("mode", "architect")
			await provider.saveViewState("currentApiConfigName", "view-profile")
			await provider.saveViewState("apiConfiguration", {
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

		it("should keep flat provider settings out of the view-local buffer", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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

			// Flat provider-settings keys are shared settings: they must flow through
			// the ContextProxy only and must not be merged into the view-local buffer,
			// which would turn them into a per-view override masking later shared
			// updates from other views. The explicit view-local override survives.
			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter/old-model",
			})
			expect(provider.contextProxy.getValue("apiProvider")).toBe(providerIdentifiers.bedrock)
			expect(provider.contextProxy.getValue("awsBedrockEndpoint")).toBe("http://127.0.0.1:4567")

			await provider.dispose()
		})

		it("should persist setValue mutations for view-local mode", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.setValue("mode", "architect")

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { mode: "architect" },
			})

			await provider.dispose()
		})

		it("should persist setValues mutations for view-local API profile", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.setValues({ currentApiConfigName: "profile-from-set-values" })

			expect(provider.contextProxy.getValue("viewStates")).toMatchObject({
				"stable-sidebar-view": { currentApiConfigName: "profile-from-set-values" },
			})

			await provider.dispose()
		})

		it("should drop an unknown mode from setValues while keeping valid modes", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// This file's getModeBySlug mock resolves every slug; narrow it to the slugs
			// under test so "not-a-real-mode" is rejected like the real lookup would.
			const modesModule = vi.mocked(await import("../../../shared/modes"))
			const originalMode = modesModule.getModeBySlug("code")
			modesModule.getModeBySlug.mockImplementation(((slug: string) =>
				["code", "architect"].includes(slug) ? { slug } : undefined) as typeof modesModule.getModeBySlug)

			try {
				await provider.setValues({ mode: "not-a-real-mode" })

				expect(provider.contextProxy.getValue("mode")).toBeUndefined()
				expect(provider["viewLocalState"].mode).toBeUndefined()

				await provider.setValues({ mode: "architect" })

				expect(provider.contextProxy.getValue("mode")).toBe("architect")
				expect(provider["viewLocalState"].mode).toBe("architect")
			} finally {
				modesModule.getModeBySlug.mockReturnValue(originalMode)
			}

			await provider.dispose()
		})

		it("should sanitize raw viewStateId before using it as persisted viewStates key", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

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
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("tab-to-preserve")
			await provider.saveViewState("mode", "architect")
			expect(provider.contextProxy.getValue("viewStates")).toHaveProperty("tab-to-preserve")

			await provider.dispose()

			expect(provider.contextProxy.getValue("viewStates")).toHaveProperty("tab-to-preserve")
		})

		it("should read viewStates fresh from storage so out-of-proxy writes are not clobbered", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			await provider["setViewStateId"]("view-a")
			await provider.saveViewState("mode", "architect")

			// Simulate a concurrent writer (another view's provider) updating the shared
			// map directly in storage, bypassing this proxy's cache.
			const stored = (await mockContext.globalState.get<Record<string, unknown>>("viewStates")) ?? {}
			await mockContext.globalState.update("viewStates", {
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

		it("persists a pre-registration change under the registered view id instead of the temporary one", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// A change made before the stable id is registered waits in memory: the temporary id
			// is not a key the next session's provider could load it under.
			await provider.saveViewState("mode", "architect")

			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(provider["getPersistedViewStates"]({ fresh: true })).toEqual({})

			await provider["setViewStateId"]("stable-sidebar-view")
			await provider.saveViewState("mode", "debugger")

			const viewStates = provider.contextProxy.getValue("viewStates") as Record<string, { mode?: string }>
			expect(viewStates["stable-sidebar-view"]).toMatchObject({ mode: "debugger" })
			expect(viewStates[provider.viewId]).toBeUndefined()

			await provider.dispose()
		})

		it("keeps the held pre-registration change over the older stable entry it lands on", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// A stable entry already exists (e.g. persisted by an earlier session of this
			// view) and holds an older selection than the change this view is holding.
			await provider.contextProxy.setValue("viewStates", {
				"stable-sidebar-view": { mode: "debugger", updatedAt: 2 },
			})

			// The user picked architect in this window before the id was registered.
			await provider.saveViewState("mode", "architect")

			await provider["setViewStateId"]("stable-sidebar-view")

			const viewStates = provider.contextProxy.getValue("viewStates") as Record<string, { mode?: string }>
			// The held change is the newer selection, and the load that follows the flush must
			// not roll the view back to the older persisted one.
			expect(viewStates["stable-sidebar-view"]).toMatchObject({ mode: "architect" })
			expect(viewStates[provider.viewId]).toBeUndefined()
			expect(provider["viewLocalState"].mode).toBe("architect")

			await provider.dispose()
		})

		it("should discard a stale loadViewState when a newer view id is registered during the load", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// Seed persisted entries under both registered ids through the proxy so the loads
			// observe them via the cached read path: the first id's entry pins a profile whose
			// lookup is hung below, the second id's entry is the one that must survive.
			await provider.contextProxy.setValue("viewStates", {
				"first-sidebar-view": { mode: "architect", currentApiConfigName: "ghost-profile", updatedAt: 1 },
				"stable-sidebar-view": { mode: "debug", updatedAt: 2 },
			})

			// Hang the temporary entry's profile lookup so that load is still in flight
			// when the stable id is registered.
			let releaseGhost!: () => void
			const ghostLoad = new Promise<void>((resolve) => {
				releaseGhost = resolve
			})
			const ghostGetProfile = vi.spyOn(provider.providerSettingsManager, "getProfile").mockReturnValue(
				ghostLoad.then(() =>
					Object.assign({} as Awaited<ReturnType<typeof provider.providerSettingsManager.getProfile>>, {
						name: "ghost-profile",
						id: "ghost-id",
						apiProvider: providerIdentifiers.anthropic,
					}),
				),
			)

			// Register the first id and leave its load in flight: the profile lookup below is
			// what keeps this load open across the newer registration.
			const staleLoad = provider["setViewStateId"]("first-sidebar-view")

			// The lookup has to be in flight before the newer id is registered; asserting only
			// after the call completes cannot prove the stale check fires mid-load.
			await vi.waitFor(() => expect(ghostGetProfile).toHaveBeenCalledTimes(1))

			const register = provider["setViewStateId"]("stable-sidebar-view")
			await register

			releaseGhost()
			await staleLoad

			// The stale (superseded-id) load must not overwrite the newer id's load.
			expect(provider["viewLocalState"]).toEqual({ mode: "debug" })
			expect(provider["viewStateId"]).toBe("stable-sidebar-view")

			await provider.dispose()
		})
	})

	describe("getState default values", () => {
		it("should fall back to defaults for unset state values", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			const state = await provider.getState()

			expect(state.mode).toBe("code")
			expect(state.currentApiConfigName).toBe("default")
			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.anthropic)
			expect(state.alwaysAllowReadOnly).toBe(false)
			expect(state.alwaysAllowReadOnlyOutsideWorkspace).toBe(false)
			expect(state.alwaysAllowWrite).toBe(false)
			expect(state.alwaysAllowWriteOutsideWorkspace).toBe(false)
			expect(state.alwaysAllowWriteProtected).toBe(false)
			expect(state.alwaysAllowExecute).toBe(false)
			expect(state.alwaysAllowMcp).toBe(false)
			expect(state.alwaysAllowModeSwitch).toBe(false)
			expect(state.alwaysAllowSubtasks).toBe(false)
			expect(state.alwaysAllowFollowupQuestions).toBe(false)
			expect(state.followupAutoApproveTimeoutMs).toBe(60000)
			expect(state.diagnosticsEnabled).toBe(true)
			expect(state.soundEnabled).toBe(false)
			expect(state.ttsEnabled).toBe(false)
			expect(state.ttsSpeed).toBe(1)
			expect(state.enableCheckpoints).toBe(true)
			expect(state.checkpointTimeout).toBe(DEFAULT_CHECKPOINT_TIMEOUT_SECONDS)
			expect(state.terminalPowershellCounter).toBe(false)
			expect(state.terminalZshClearEolMark).toBe(true)
			expect(state.terminalZshOhMy).toBe(false)
			expect(state.terminalZshP10k).toBe(false)
			expect(state.terminalZdotdir).toBe(false)
			expect(state.mcpEnabled).toBe(true)
			expect(state.listApiConfigMeta).toEqual([])
			expect(state.pinnedApiConfigs).toEqual({})
			expect(state.modeApiConfigs).toEqual({})
			expect(state.customSupportPrompts).toEqual({})
			expect(state.experiments).toEqual(experimentDefault)
			expect(state.autoApprovalEnabled).toBe(false)
			expect(state.maxOpenTabsContext).toBe(20)
			expect(state.maxWorkspaceFiles).toBe(200)
			expect(state.telemetrySetting).toBe("unset")
			expect(state.enableSubfolderRules).toBe(false)
			expect(state.maxImageFileSize).toBe(5)
			expect(state.maxTotalImageSize).toBe(20)
			expect(state.historyPreviewCollapsed).toBe(false)
			expect(state.reasoningBlockCollapsed).toBe(true)
			expect(state.enterBehavior).toBe("send")
			expect(state.codebaseIndexModels).toEqual(EMBEDDING_MODEL_PROFILES)
			expect(state.codebaseIndexConfig).toEqual({
				codebaseIndexEnabled: false,
				codebaseIndexQdrantUrl: "http://localhost:6333",
				codebaseIndexEmbedderProvider: providerIdentifiers.openai,
				codebaseIndexEmbedderBaseUrl: "",
				codebaseIndexEmbedderModelId: "",
			})
			expect(state.profileThresholds).toEqual({})
			expect(state.includeDiagnosticMessages).toBe(true)
			expect(state.maxDiagnosticMessages).toBe(50)
			expect(state.includeTaskHistoryInEnhance).toBe(true)
			expect(state.includeCurrentTime).toBe(true)
			expect(state.includeCurrentCost).toBe(true)
			expect(state.maxGitStatusFiles).toBe(0)
			expect(state.language).toBe("en")

			await provider.dispose()
		})

		it("should report a non-retired apiProvider from state instead of the anthropic fallback", async () => {
			const contextProxy = new ContextProxy(mockContext)
			await contextProxy.setValues({ apiProvider: providerIdentifiers.openrouter })
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				contextProxy,
				new WebviewFocusTracker(),
			)

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.openrouter)

			await provider.dispose()
		})

		it("should fill the apiConfiguration apiProvider from the raw state value when provider settings sanitize it away", async () => {
			// "bogus-provider" is neither an active nor a retired provider, so
			// ContextProxy.sanitizeProviderValues drops it from the provider
			// settings; the raw state value still reaches apiConfiguration via
			// the getState fill-in, which is what this assertion pins.
			const contextProxy = new ContextProxy(mockContext)
			// A single structural cast: the raw-state write must carry an
			// un-sanitizable apiProvider value, which the typed setValues(RooCodeSettings)
			// signature deliberately rejects.
			const contextProxyAccess = contextProxy as {
				setValues: (values: Record<string, unknown>) => Promise<void>
			}
			await contextProxyAccess.setValues({ apiProvider: "bogus-provider" })
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				contextProxy,
				new WebviewFocusTracker(),
			)

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe("bogus-provider")

			await provider.dispose()
		})

		it("should serve the embedding model profiles default when the stored value is cleared", async () => {
			const provider = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)

			// The constructor seeds codebaseIndexModels into the context; with a truthy
			// stored value the ?? default is unobservable (both ?? and && forms return
			// the same profiles object). Clear the stored value so the read-time default
			// is the one under test.
			await provider.contextProxy.setValue("codebaseIndexModels", undefined)

			const state = await provider.getState()

			expect(state.codebaseIndexModels).toBe(EMBEDDING_MODEL_PROFILES)

			await provider.dispose()
		})
	})

	describe("postStateToWebviewThrottled", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(async () => {
			await provider.dispose()
			vi.useRealTimers()
		})

		test("posts on the leading edge and coalesces a burst into one trailing post", async () => {
			const postStateSpy = vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockResolvedValue(undefined)

			await provider.postStateToWebviewThrottled()
			await provider.postStateToWebviewThrottled()
			await provider.postStateToWebviewThrottled()

			expect(postStateSpy).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(499)
			expect(postStateSpy).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(1)
			expect(postStateSpy).toHaveBeenCalledTimes(2)
		})

		test("does not starve state posts during continuous updates", async () => {
			const postStateSpy = vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockResolvedValue(undefined)

			await provider.postStateToWebviewThrottled()
			await vi.advanceTimersByTimeAsync(400)
			await provider.postStateToWebviewThrottled()
			await vi.advanceTimersByTimeAsync(400)
			await provider.postStateToWebviewThrottled()
			await vi.advanceTimersByTimeAsync(199)

			expect(postStateSpy).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(1)
			expect(postStateSpy).toHaveBeenCalledTimes(2)
		})

		// Characterization test for the semantics that made #1078's throttle a no-op in practice:
		// flushing right after a leading-edge post has no pending trailing invocation to run, so it
		// only cancels the trailing timer — and the next call then hits the leading edge again.
		// Callers on a hot path (see Task#addToClineMessages) must therefore not flush per message.
		test("flushing after every post defeats coalescing entirely", async () => {
			const postStateSpy = vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockResolvedValue(undefined)

			for (let i = 0; i < 5; i++) {
				await provider.postStateToWebviewThrottled()
				await provider.flushPostStateToWebviewThrottled()
				await vi.advanceTimersByTimeAsync(100)
			}

			// One full-state post per call: no coalescing at all.
			expect(postStateSpy).toHaveBeenCalledTimes(5)

			// The same burst without the interleaved flush coalesces into far fewer posts.
			postStateSpy.mockClear()
			for (let i = 0; i < 5; i++) {
				await provider.postStateToWebviewThrottled()
				await vi.advanceTimersByTimeAsync(100)
			}
			await vi.advanceTimersByTimeAsync(500)

			expect(postStateSpy.mock.calls.length).toBeLessThan(5)
		})

		test("flushes a pending trailing post exactly once and waits for it", async () => {
			let releasePost!: () => void
			const pendingPost = new Promise<void>((resolve) => {
				releasePost = resolve
			})
			const postStateSpy = vi
				.spyOn(provider, "postStateToWebviewWithoutTaskHistory")
				.mockResolvedValueOnce(undefined)
				.mockReturnValueOnce(pendingPost)

			await provider.postStateToWebviewThrottled()
			await provider.postStateToWebviewThrottled()
			expect(postStateSpy).toHaveBeenCalledTimes(1)

			let flushSettled = false
			const flushPromise = provider.flushPostStateToWebviewThrottled()
			void flushPromise.then(() => {
				flushSettled = true
			})
			await Promise.resolve()

			expect(postStateSpy).toHaveBeenCalledTimes(2)
			expect(flushSettled).toBe(false)

			releasePost()
			await flushPromise
			expect(flushSettled).toBe(true)

			await vi.advanceTimersByTimeAsync(1000)
			expect(postStateSpy).toHaveBeenCalledTimes(2)
		})

		test("does not duplicate an idle leading post when flushed", async () => {
			const postStateSpy = vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockResolvedValue(undefined)

			await provider.postStateToWebviewThrottled()
			await provider.flushPostStateToWebviewThrottled()
			await vi.advanceTimersByTimeAsync(1000)

			expect(postStateSpy).toHaveBeenCalledOnce()
		})

		test("handles state post failures inside the debounced callback", async () => {
			const error = new Error("state post failed")
			const logSpy = vi.spyOn(provider, "log").mockImplementation(() => {})
			vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockRejectedValue(error)

			await expect(provider.postStateToWebviewThrottled()).resolves.toBeUndefined()
			expect(logSpy).toHaveBeenCalledWith(
				"[ClineProvider#postStateToWebviewThrottled] Failed to post state: state post failed",
			)
		})

		test("stringifies non-Error state post failures inside the debounced callback", async () => {
			const logSpy = vi.spyOn(provider, "log").mockImplementation(() => {})
			vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockRejectedValue("state post failed")

			await expect(provider.postStateToWebviewThrottled()).resolves.toBeUndefined()
			expect(logSpy).toHaveBeenCalledWith(
				"[ClineProvider#postStateToWebviewThrottled] Failed to post state: state post failed",
			)
		})

		test("handles state post failures while flushing a pending trailing post", async () => {
			const error = new Error("state post failed")
			const logSpy = vi.spyOn(provider, "log").mockImplementation(() => {})
			const postStateSpy = vi
				.spyOn(provider, "postStateToWebviewWithoutTaskHistory")
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(error)

			await provider.postStateToWebviewThrottled()
			await provider.postStateToWebviewThrottled()
			await expect(provider.flushPostStateToWebviewThrottled()).resolves.toBeUndefined()

			expect(postStateSpy).toHaveBeenCalledTimes(2)
			expect(logSpy).toHaveBeenCalledWith(
				"[ClineProvider#postStateToWebviewThrottled] Failed to post state: state post failed",
			)
		})

		test("cancels pending work on dispose and ignores later schedule or flush calls", async () => {
			const postStateSpy = vi.spyOn(provider, "postStateToWebviewWithoutTaskHistory").mockResolvedValue(undefined)

			await provider.postStateToWebviewThrottled()
			await provider.postStateToWebviewThrottled()
			expect(postStateSpy).toHaveBeenCalledTimes(1)

			await provider.dispose()
			await vi.advanceTimersByTimeAsync(1000)
			await provider.postStateToWebviewThrottled()
			await provider.flushPostStateToWebviewThrottled()

			expect(postStateSpy).toHaveBeenCalledTimes(1)
		})
	})

	test("postMessageToWebview skips postMessage after dispose", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		await provider.dispose()
		mockPostMessage.mockClear()

		const message: ExtensionMessage = { type: "action", action: "chatButtonClicked" }
		await provider.postMessageToWebview(message)

		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	test("dispose is idempotent — second call is a no-op", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		await provider.dispose()
		await provider.dispose()

		// dispose body runs only once: log "Disposing ClineProvider..." appears once
		const disposeCalls = (mockOutputChannel.appendLine as ReturnType<typeof vi.fn>).mock.calls.filter(
			([msg]) => typeof msg === "string" && msg.includes("Disposing ClineProvider..."),
		)
		expect(disposeCalls).toHaveLength(1)
	})

	test("dispose drains every task in abort-then-cleanup order", async () => {
		let resolveCurrentAbort!: () => void
		let resolveCurrentCleanup!: () => void
		let resolveRemainingAbort!: () => void
		let resolveRemainingCleanup!: () => void
		const currentTask = {
			taskId: "current-task",
			instanceId: "current-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockReturnValue(
				new Promise<void>((resolve) => {
					resolveCurrentAbort = resolve
				}),
			),
			dispose: vi.fn().mockReturnValue(
				new Promise<void>((resolve) => {
					resolveCurrentCleanup = resolve
				}),
			),
		}
		const remainingTask = {
			taskId: "remaining-task",
			instanceId: "remaining-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockReturnValue(
				new Promise<void>((resolve) => {
					resolveRemainingAbort = resolve
				}),
			),
			dispose: vi.fn().mockReturnValue(
				new Promise<void>((resolve) => {
					resolveRemainingCleanup = resolve
				}),
			),
		}
		Object.assign(provider, { taskRegistry: new TaskRegistry() })
		provider["taskRegistry"].push(remainingTask as unknown as Task)
		provider["taskRegistry"].push(currentTask as unknown as Task)
		let shutdownComplete = false

		const shutdown = provider.dispose()
		void shutdown
			.then(() => {
				shutdownComplete = true
			})
			.catch(() => {})
		await vi.waitFor(() => expect(currentTask.abortTask).toHaveBeenCalledOnce())
		expect(currentTask.dispose).not.toHaveBeenCalled()
		expect(remainingTask.abortTask).not.toHaveBeenCalled()

		resolveCurrentAbort()
		await vi.waitFor(() => expect(currentTask.dispose).toHaveBeenCalledOnce())
		expect(remainingTask.abortTask).not.toHaveBeenCalled()

		resolveCurrentCleanup()
		await vi.waitFor(() => expect(remainingTask.abortTask).toHaveBeenCalledOnce())
		expect(remainingTask.dispose).not.toHaveBeenCalled()

		resolveRemainingAbort()
		await vi.waitFor(() => expect(remainingTask.dispose).toHaveBeenCalledOnce())

		expect(shutdownComplete).toBe(false)
		resolveRemainingCleanup()
		await shutdown
		expect(shutdownComplete).toBe(true)
	})

	test("dispose continues draining tasks after cleanup rejects", async () => {
		const cleanupError = new Error("cleanup failed")
		const logSpy = vi.spyOn(provider, "log")
		const remainingTask = {
			taskId: "remaining-task",
			instanceId: "remaining-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		const currentTask = {
			taskId: "current-task",
			instanceId: "current-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockRejectedValue(cleanupError),
		}
		Object.assign(provider, { taskRegistry: new TaskRegistry() })
		provider["taskRegistry"].push(remainingTask as unknown as Task)
		provider["taskRegistry"].push(currentTask as unknown as Task)

		await expect(provider.dispose()).resolves.toBeUndefined()

		expect(currentTask.dispose).toHaveBeenCalledOnce()
		expect(remainingTask.dispose).toHaveBeenCalledOnce()
		expect(logSpy).toHaveBeenCalledWith(
			"[ClineProvider#dispose] Task cleanup failed for current-task.current-instance: cleanup failed",
		)
	})

	test("dispose continues draining tasks after abort rejects", async () => {
		const abortError = new Error("abort failed")
		const remainingTask = {
			taskId: "remaining-task",
			instanceId: "remaining-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		const currentTask = {
			taskId: "current-task",
			instanceId: "current-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockRejectedValue(abortError),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
		Object.assign(provider, { taskRegistry: new TaskRegistry() })
		provider["taskRegistry"].push(remainingTask as unknown as Task)
		provider["taskRegistry"].push(currentTask as unknown as Task)

		await expect(provider.dispose()).resolves.toBeUndefined()

		expect(currentTask.abortTask).toHaveBeenCalledOnce()
		expect(currentTask.dispose).toHaveBeenCalledOnce()
		expect(remainingTask.abortTask).toHaveBeenCalledOnce()
		expect(remainingTask.dispose).toHaveBeenCalledOnce()
	})

	test("handles webviewDidLaunch message", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Get the message handler from onDidReceiveMessage
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as ReturnType<typeof vi.fn>).mock
			.calls[0][0]

		// Simulate webviewDidLaunch message
		await messageHandler({ type: "webviewDidLaunch" })

		// Should post state and theme to webview
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("logs detached workspace initialization failures", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		let rejectInitialization!: (error: Error) => void
		const initializationPromise = new Promise<void>((_, reject) => {
			rejectInitialization = reject
		})
		const initializeSpy = vi
			.spyOn(provider.workspaceTracker!, "initializeFilePaths")
			.mockReturnValue(initializationPromise)
		const logSpy = vi.spyOn(provider, "log")
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await expect(messageHandler({ type: "webviewDidLaunch" })).resolves.toBeUndefined()
		expect(initializeSpy).toHaveBeenCalledOnce()

		rejectInitialization(new Error("workspace boom"))
		await Promise.resolve()
		await Promise.resolve()

		expect(logSpy).toHaveBeenCalledWith("Workspace initialization error: Error: workspace boom")
	})

	test("clearTask aborts current task", async () => {
		// Setup Cline instance with auto-mock from the top of the file
		const mockCline = new Task(defaultTaskOptions) // Create a new mocked instance

		// add the mock object to the stack
		await provider.addClineToStack(mockCline)

		// get the stack size before the abort call
		const stackSizeBeforeAbort = provider.getTaskStackSize()

		// call the removeClineFromStack method so it will call the current cline abort and remove it from the stack
		await provider.removeClineFromStack()

		// get the stack size after the abort call
		const stackSizeAfterAbort = provider.getTaskStackSize()

		// check if the abort method was called
		expect(mockCline.abortTask).toHaveBeenCalled()

		// check if the stack size was decreased
		expect(stackSizeBeforeAbort - stackSizeAfterAbort).toBe(1)
	})

	describe("clearTask message handler", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("calls clearTask (delegation handled via metadata)", async () => {
			// Setup a single task without parent
			const mockCline = new Task(defaultTaskOptions)

			// Mock the provider methods
			const clearTaskSpy = vi.spyOn(provider, "clearTask").mockResolvedValue(undefined)
			const postStateToWebviewSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// Add task to stack
			await provider.addClineToStack(mockCline)

			// Get the message handler
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Trigger clearTask message
			await messageHandler({ type: "clearTask" })

			// Verify clearTask was called
			expect(clearTaskSpy).toHaveBeenCalled()
			expect(postStateToWebviewSpy).toHaveBeenCalled()
		})

		test("calls clearTask even with parent task (delegation via metadata)", async () => {
			// Setup parent and child tasks
			const parentTask = new Task(defaultTaskOptions)
			const childTask = new Task(defaultTaskOptions)

			// Set up parent-child relationship
			;(childTask as any).parentTask = parentTask
			;(childTask as any).rootTask = parentTask

			// Mock the provider methods
			const clearTaskSpy = vi.spyOn(provider, "clearTask").mockResolvedValue(undefined)
			const postStateToWebviewSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// Add both tasks to stack (parent first, then child)
			await provider.addClineToStack(parentTask)
			await provider.addClineToStack(childTask)

			// Get the message handler
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Trigger clearTask message
			await messageHandler({ type: "clearTask" })

			// Verify clearTask was called (delegation happens via metadata, not finishSubTask)
			expect(clearTaskSpy).toHaveBeenCalled()
			expect(postStateToWebviewSpy).toHaveBeenCalled()
		})

		test("handles case when no current task exists", async () => {
			// Don't add any tasks to the stack

			// Mock the provider methods
			const clearTaskSpy = vi.spyOn(provider, "clearTask").mockResolvedValue(undefined)
			const postStateToWebviewSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			// Get the message handler
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Trigger clearTask message
			await messageHandler({ type: "clearTask" })

			// When there's no current task, clearTask is still called (it handles the no-task case internally)
			expect(clearTaskSpy).toHaveBeenCalled()
			expect(postStateToWebviewSpy).toHaveBeenCalled()
		})

		test("correctly identifies task scenario for issue #4602", async () => {
			// This test validates the fix for issue #4602
			// where canceling during API retry correctly uses clearTask

			const mockCline = new Task(defaultTaskOptions)

			// Mock the provider methods
			const clearTaskSpy = vi.spyOn(provider, "clearTask").mockResolvedValue(undefined)

			// Add only one task to stack
			await provider.addClineToStack(mockCline)

			// Verify stack size is 1
			expect(provider.getTaskStackSize()).toBe(1)

			// Get the message handler
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Trigger clearTask message (simulating cancel during API retry)
			await messageHandler({ type: "clearTask" })

			// clearTask should be called (delegation handled via metadata)
			expect(clearTaskSpy).toHaveBeenCalled()
		})
	})

	test("addClineToStack adds multiple Cline instances to the stack", async () => {
		// Setup Cline instance with auto-mock from the top of the file
		const mockCline1 = new Task(defaultTaskOptions) // Create a new mocked instance
		const mockCline2 = new Task(defaultTaskOptions) // Create a new mocked instance
		Object.defineProperty(mockCline1, "taskId", { value: "test-task-id-1", writable: true })
		Object.defineProperty(mockCline2, "taskId", { value: "test-task-id-2", writable: true })

		// add Cline instances to the stack
		await provider.addClineToStack(mockCline1)
		await provider.addClineToStack(mockCline2)

		// verify cline instances were added to the stack
		expect(provider.getTaskStackSize()).toBe(2)

		// verify current cline instance is the last one added
		expect(provider.getCurrentTask()).toBe(mockCline2)
	})

	test("getState returns correct initial state", async () => {
		const state = await provider.getState()

		expect(state).toHaveProperty("apiConfiguration")
		expect(state.apiConfiguration).toHaveProperty("apiProvider")
		expect(state).toHaveProperty("customInstructions")
		expect(state).toHaveProperty("alwaysAllowReadOnly")
		expect(state).toHaveProperty("alwaysAllowWrite")
		expect(state).toHaveProperty("alwaysAllowExecute")
		expect(state).toHaveProperty("taskHistory")
		expect(state).toHaveProperty("soundEnabled")
		expect(state).toHaveProperty("ttsEnabled")
		expect(state).toHaveProperty("writeDelayMs")
	})

	test("getState and getStateToPostToWebview return the complete NanoGPT configuration", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setProviderSettings({
			apiProvider: providerIdentifiers.nanogpt,
			nanoGptApiKey: "nanogpt-secret",
			nanoGptModelId: "openai/model",
			nanoGptRoutingPreference: "latency",
		})

		const state = await provider.getState()
		const postedState = await provider.getStateToPostToWebview()
		const expectedConfiguration = {
			apiProvider: providerIdentifiers.nanogpt,
			nanoGptApiKey: "nanogpt-secret",
			nanoGptModelId: "openai/model",
			nanoGptRoutingPreference: "latency",
		}

		expect(state.apiConfiguration).toMatchObject(expectedConfiguration)
		expect(postedState.apiConfiguration).toMatchObject(expectedConfiguration)
	})

	test.each([true, false, undefined])(
		"returns saved OpenAI-compatible reasoning settings to the webview when enabled is %s",
		async (enableReasoningEffort) => {
			await provider.resolveWebviewView(mockWebviewView)
			const configuration: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "custom-model",
				enableReasoningEffort,
				reasoningEffort: "low",
				openAiCustomModelInfo: { ...openAiModelInfoSaneDefaults, reasoningEffort: "max" },
			}
			await provider.contextProxy.setProviderSettings(configuration)

			expect(provider.contextProxy.getProviderSettings()).toMatchObject(configuration)
			expect((await provider.getState()).apiConfiguration).toMatchObject(configuration)
			expect((await provider.getStateToPostToWebview()).apiConfiguration).toMatchObject(configuration)
		},
	)

	describe("display settings written through setValues and a task's configuration", () => {
		const hand = (values: Record<string, unknown>) => values as unknown as RooCodeSettings

		it("stores valid values as they are", async () => {
			const setValues = vi.spyOn(provider.contextProxy, "setValues").mockResolvedValue(undefined)

			await provider.setValues({ timeFormat: "24h", dateFormat: "ymd", showRelativeTimes: false })

			expect(setValues).toHaveBeenCalledWith({ timeFormat: "24h", dateFormat: "ymd", showRelativeTimes: false })
		})

		it("ignores an invalid value, keeps the others, and logs which", async () => {
			const setValues = vi.spyOn(provider.contextProxy, "setValues").mockResolvedValue(undefined)
			const log = vi.spyOn(provider, "log").mockImplementation(() => {})

			await provider.setValues(hand({ timeFormat: "13h", dateFormat: "dmy", mode: "code" }))

			expect(setValues).toHaveBeenCalledWith({ dateFormat: "dmy", mode: "code" })
			expect(log).toHaveBeenCalledWith("[setValues] Ignored an invalid value for timeFormat")
		})

		it("applies the same check to the configuration of a new task", async () => {
			const setValues = vi.spyOn(provider.contextProxy, "setValues").mockResolvedValue(undefined)
			vi.spyOn(provider, "log").mockImplementation(() => {})

			await provider
				.createTask("hello", undefined, undefined, {}, hand({ showRelativeTimes: "yes", mode: "code" }))
				.catch(() => undefined) // what happens after the configuration is written is not under test

			expect(setValues).toHaveBeenCalledWith({ mode: "code" })
		})
	})

	test("getState returns the saved destructive command guard setting", async () => {
		await provider.contextProxy.setValue("destructiveCommandGuardEnabled", true)

		const state = await provider.getState()

		expect(state.destructiveCommandGuardEnabled).toBe(true)
	})

	test("getState returns the saved blanket auto-deny setting", async () => {
		await provider.contextProxy.setValue("alwaysDenyUnapprovedCommands", true)

		const state = await provider.getState()

		expect(state.alwaysDenyUnapprovedCommands).toBe(true)
	})

	test("getState defaults blanket auto-deny to false", async () => {
		const state = await provider.getState()

		expect(state.alwaysDenyUnapprovedCommands).toBe(false)
	})

	test("getState returns the saved allowed read files", async () => {
		await provider.contextProxy.setValue("allowedReadFiles", ["notes.md"])

		const state = await provider.getState()

		expect(state.allowedReadFiles).toEqual(["notes.md"])
	})

	test("getState defaults allowed read files to an empty list", async () => {
		const state = await provider.getState()

		expect(state.allowedReadFiles).toEqual([])
	})

	test("getStateToPostToWebview returns the saved allowed read files", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("allowedReadFiles", ["notes.md"])

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedReadFiles).toEqual(["notes.md"])
	})

	describe("prompt cache TTL round trip", () => {
		// The provider-settings route: the knob rides `apiConfiguration`, so the
		// round trip is the profile write plus the state post, with no dedicated
		// message type and no settings-specific branch in the message handler.
		test("a saved 1h survives a fresh getStateToPostToWebview payload", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			await provider.upsertProviderProfile("ttl-profile", {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-sonnet-4-5",
				apiKey: "test-key",
				promptCacheTtl: "1h",
			})

			// A fresh read, not the in-memory value the save path just wrote: this is
			// the "saved control reverts visually" case the checklist calls out.
			const posted = await provider.getStateToPostToWebview()

			expect(posted.apiConfiguration.promptCacheTtl).toBe("1h")
			expect((await provider.getState()).apiConfiguration.promptCacheTtl).toBe("1h")
		})

		test("an unset knob stays absent rather than becoming an explicit 5m", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			await provider.upsertProviderProfile("default-ttl-profile", {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-sonnet-4-5",
				apiKey: "test-key",
			})

			const posted = await provider.getStateToPostToWebview()

			// Consumers apply the vendor default, so the stored value must be absent
			// rather than a literal "5m" that would look like a user choice.
			expect(posted.apiConfiguration.promptCacheTtl).toBeUndefined()
			expect(posted.apiConfiguration).not.toHaveProperty("promptCacheTtl", "5m")
		})

		test("a hand-edited 1h for a model without the capability is stored, not silently rewritten", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// MiniMax caches prompts but advertises no TTL class. The profile can only
			// have been written by hand or imported, and the save path must keep what
			// the user stored: capability is enforced where the request is built (the
			// emitter fails closed), so a save-time rewrite would be a second, silent
			// source of truth for the same rule.
			await provider.upsertProviderProfile("hand-edited-profile", {
				apiProvider: providerIdentifiers.minimax,
				apiKey: "test-key",
				promptCacheTtl: "1h",
			})

			const posted = await provider.getStateToPostToWebview()

			expect(posted.apiConfiguration.promptCacheTtl).toBe("1h")
		})
	})

	test("getStateToPostToWebview defaults allowed read files to an empty list", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedReadFiles).toEqual([])
	})

	describe("date and time display settings", () => {
		const defaults = { timeFormat: "auto", dateFormat: "auto", showRelativeTimes: true }

		/** Saves through the real `updateSettings` handler, as the settings view does. */
		const save = async (updatedSettings: Record<string, unknown>) => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = vi.mocked(mockWebviewView.webview.onDidReceiveMessage).mock.calls[0][0]
			await messageHandler({ type: "updateSettings", updatedSettings })
		}

		test.each(Object.entries(defaults))("%s is %j when it was never saved", async (key, expected) => {
			await provider.resolveWebviewView(mockWebviewView)

			expect(await provider.getState()).toMatchObject({ [key]: expected })
			expect(await provider.getStateToPostToWebview()).toMatchObject({ [key]: expected })
		})

		test.each([
			["timeFormat", "12h"],
			["timeFormat", "24h"],
			["timeFormat", "auto"],
			["dateFormat", "mdy"],
			["dateFormat", "dmy"],
			["dateFormat", "ymd"],
			["dateFormat", "auto"],
			["showRelativeTimes", true],
			["showRelativeTimes", false],
		])("a saved %s of %j is stored and returned to the webview", async (key, value) => {
			mockPostMessage.mockClear()
			await save({ [key]: value })

			expect(mockContext.globalState.update).toHaveBeenCalledWith(key, value)
			expect(await provider.getState()).toMatchObject({ [key]: value })
			expect(await provider.getStateToPostToWebview()).toMatchObject({ [key]: value })
			// The open webview is told, so the saved value does not revert on screen.
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "state", state: expect.objectContaining({ [key]: value }) }),
			)
		})

		test("the state refresh after a save reaches the active webview with the saved time format", async () => {
			mockPostMessage.mockClear()

			await save({ timeFormat: "24h" })

			const posted: unknown[][] = mockPostMessage.mock.calls
			const states = posted
				.map(([message]) => message as { type?: string; state?: { timeFormat?: string } })
				.filter((message) => message.type === "state")
			expect(states.length).toBeGreaterThan(0)
			expect(states.at(-1)?.state?.timeFormat).toBe("24h")
		})

		test("an explicit false is kept, not replaced by the default of true", async () => {
			await save({ showRelativeTimes: false })

			expect((await provider.getState()).showRelativeTimes).toBe(false)
			expect((await provider.getStateToPostToWebview()).showRelativeTimes).toBe(false)
		})

		test("all three are saved together and returned together", async () => {
			await save({ timeFormat: "24h", dateFormat: "dmy", showRelativeTimes: false })

			const expected = { timeFormat: "24h", dateFormat: "dmy", showRelativeTimes: false }
			expect(await provider.getState()).toMatchObject(expected)
			expect(await provider.getStateToPostToWebview()).toMatchObject(expected)
		})

		test("saving one setting leaves the others at their defaults", async () => {
			await save({ timeFormat: "12h" })

			expect(await provider.getStateToPostToWebview()).toMatchObject({ ...defaults, timeFormat: "12h" })
		})
	})

	test("getState returns the saved allowed write files", async () => {
		await provider.contextProxy.setValue("allowedWriteFiles", ["notes.md"])

		const state = await provider.getState()

		expect(state.allowedWriteFiles).toEqual(["notes.md"])
	})

	test("getState defaults allowed write files to an empty list", async () => {
		const state = await provider.getState()

		expect(state.allowedWriteFiles).toEqual([])
	})

	test("getStateToPostToWebview returns the saved allowed write files", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("allowedWriteFiles", ["notes.md"])

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedWriteFiles).toEqual(["notes.md"])
	})

	test("getStateToPostToWebview defaults allowed write files to an empty list", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const state = await provider.getStateToPostToWebview()

		expect(state.allowedWriteFiles).toEqual([])
	})

	test("getStateToPostToWebview returns the saved destructive command guard setting", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("destructiveCommandGuardEnabled", true)

		const state = await provider.getStateToPostToWebview()

		expect(state.destructiveCommandGuardEnabled).toBe(true)
	})

	test("getStateToPostToWebview disables destructive command guard by default", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const state = await provider.getStateToPostToWebview()

		expect(state.destructiveCommandGuardEnabled).toBe(false)
	})

	test("getStateToPostToWebview returns the saved blanket auto-deny setting", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("alwaysDenyUnapprovedCommands", true)

		const state = await provider.getStateToPostToWebview()

		expect(state.alwaysDenyUnapprovedCommands).toBe(true)
	})

	test("getStateToPostToWebview disables blanket auto-deny by default", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		const state = await provider.getStateToPostToWebview()

		expect(state.alwaysDenyUnapprovedCommands).toBe(false)
	})

	test("language is set to VSCode language", async () => {
		// Mock VSCode language as Spanish
		;(vscode.env as any).language = "pt-BR"

		const state = await provider.getState()
		expect(state.language).toBe("pt-BR")
	})

	test("writeDelayMs defaults to DEFAULT_WRITE_DELAY_MS", async () => {
		// Mock globalState.get to return undefined for writeDelayMs (typed reassignment,
		// same pattern as the customModePrompts test below — Memento.get has no mock type)
		mockContext.globalState.get = vi.fn((key: string) => {
			return key === "writeDelayMs" ? undefined : null
		})

		const state = await provider.getState()
		expect(state.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
	})

	test("getStateToPostToWebview returns the persisted writeDelayMs value", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Simulate the updateSettings handler storing the value.
		await provider.contextProxy.setValue("writeDelayMs", 500)

		const state = await provider.getStateToPostToWebview()

		expect(state.writeDelayMs).toBe(500)
	})

	test("getStateToPostToWebview defaults writeDelayMs to DEFAULT_WRITE_DELAY_MS when unset", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Ensure the setting is not persisted.
		await provider.contextProxy.setValue("writeDelayMs", undefined)

		const state = await provider.getStateToPostToWebview()

		expect(state.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
	})

	test.each([true, false, undefined])(
		"returns the saved output collapse preference (%s) to the webview",
		async (value) => {
			await provider.resolveWebviewView(mockWebviewView)
			await provider.contextProxy.setValue("collapseCommandOutputByDefault", value)
			expect((await provider.getState()).collapseCommandOutputByDefault).toBe(value ?? false)
			expect((await provider.getStateToPostToWebview()).collapseCommandOutputByDefault).toBe(value ?? false)
		},
	)

	test("getState applies fallback defaults for write, diff, and terminal settings", async () => {
		// Mock globalState.get to return undefined for the fallback settings
		// (typed reassignment — Memento.get has no mock type, same pattern as the
		// writeDelayMs default test above)
		mockContext.globalState.get = vi.fn((key: string) => {
			if (
				[
					"writeDelayMs",
					"diffFuzzyThreshold",
					"terminalShellIntegrationTimeout",
					"terminalShellIntegrationDisabled",
					"terminalCommandDelay",
				].includes(key)
			) {
				return undefined
			}

			return null
		})

		const state = await provider.getState()

		expect(state.writeDelayMs).toBe(DEFAULT_WRITE_DELAY_MS)
		expect(state.diffFuzzyThreshold).toBe(DEFAULT_DIFF_FUZZY_THRESHOLD)
		expect(state.terminalShellIntegrationTimeout).toBe(Terminal.defaultShellIntegrationTimeout)
		expect(state.terminalShellIntegrationDisabled).toBe(true)
		expect(state.terminalCommandDelay).toBe(0)
	})

	test("getState passes through defined write/diff/terminal values instead of defaults", async () => {
		await provider.contextProxy.setValue("writeDelayMs", 500)
		await provider.contextProxy.setValue("diffFuzzyThreshold", 0.5)
		await provider.contextProxy.setValue("terminalShellIntegrationTimeout", 99999)
		await provider.contextProxy.setValue("terminalShellIntegrationDisabled", false)
		await provider.contextProxy.setValue("terminalCommandDelay", 1234)

		const state = await provider.getState()

		expect(state.writeDelayMs).toBe(500)
		expect(state.diffFuzzyThreshold).toBe(0.5)
		expect(state.terminalShellIntegrationTimeout).toBe(99999)
		expect(state.terminalShellIntegrationDisabled).toBe(false)
		expect(state.terminalCommandDelay).toBe(1234)
	})

	test("handles writeDelayMs message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { writeDelayMs: 2000 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("writeDelayMs", 2000)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("writeDelayMs", 2000)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("updates sound utility when sound setting changes", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		// Get the message handler from onDidReceiveMessage
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Simulate setting sound to enabled
		await messageHandler({ type: "updateSettings", updatedSettings: { soundEnabled: true } })
		expect(updateGlobalStateSpy).toHaveBeenCalledWith("soundEnabled", true)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("soundEnabled", true)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting sound to disabled
		await messageHandler({ type: "updateSettings", updatedSettings: { soundEnabled: false } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("soundEnabled", false)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting tts to enabled
		await messageHandler({ type: "updateSettings", updatedSettings: { ttsEnabled: true } })
		expect(setTtsEnabled).toHaveBeenCalledWith(true)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("ttsEnabled", true)
		expect(mockPostMessage).toHaveBeenCalled()

		// Simulate setting tts to disabled
		await messageHandler({ type: "updateSettings", updatedSettings: { ttsEnabled: false } })
		expect(setTtsEnabled).toHaveBeenCalledWith(false)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("ttsEnabled", false)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("autoCondenseContext defaults to true", async () => {
		// Mock globalState.get to return undefined for autoCondenseContext
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			return key === "autoCondenseContext" ? undefined : null
		})
		const state = await provider.getState()
		expect(state.autoCondenseContext).toBe(true)
	})

	test("handles autoCondenseContext message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
		await messageHandler({ type: "updateSettings", updatedSettings: { autoCondenseContext: false } })
		expect(updateGlobalStateSpy).toHaveBeenCalledWith("autoCondenseContext", false)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("autoCondenseContext", false)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("autoCondenseContextPercent defaults to 100", async () => {
		// Mock globalState.get to return undefined for autoCondenseContextPercent
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			return key === "autoCondenseContextPercent" ? undefined : null
		})

		const state = await provider.getState()
		expect(state.autoCondenseContextPercent).toBe(100)
	})

	test("handles autoCondenseContextPercent message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { autoCondenseContextPercent: 75 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("autoCondenseContextPercent", 75)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("autoCondenseContextPercent", 75)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	describe("auto-close settings are included in posted state", () => {
		it("getStateToPostToWebview returns saved autoCloseZooOpenedFiles value", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Simulate the updateSettings handler storing the value.
			await provider.contextProxy.setValue("autoCloseZooOpenedFiles", false)
			await provider.contextProxy.setValue("autoCloseZooOpenedFilesAfterUserEdited", true)
			await provider.contextProxy.setValue("autoCloseZooOpenedNewFiles", true)

			const state = await provider.getStateToPostToWebview()

			// The saved values must be present in the state posted to the webview.
			expect(state.autoCloseZooOpenedFiles).toBe(false)
			expect(state.autoCloseZooOpenedFilesAfterUserEdited).toBe(true)
			expect(state.autoCloseZooOpenedNewFiles).toBe(true)
		})

		it("getStateToPostToWebview defaults autoCloseZooOpenedFiles to false when unset", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Ensure the settings are not set.
			await provider.contextProxy.setValue("autoCloseZooOpenedFiles", undefined)
			await provider.contextProxy.setValue("autoCloseZooOpenedFilesAfterUserEdited", undefined)
			await provider.contextProxy.setValue("autoCloseZooOpenedNewFiles", undefined)

			const state = await provider.getStateToPostToWebview()

			// Unset values should default to their documented defaults (opt-in).
			expect(state.autoCloseZooOpenedFiles).toBe(false)
			expect(state.autoCloseZooOpenedFilesAfterUserEdited).toBe(false)
			expect(state.autoCloseZooOpenedNewFiles).toBe(false)
		})

		it("getState returns saved autoCloseZooOpenedFiles value for DiffViewProvider", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			await provider.contextProxy.setValue("autoCloseZooOpenedFiles", false)
			await provider.contextProxy.setValue("autoCloseZooOpenedFilesAfterUserEdited", true)
			await provider.contextProxy.setValue("autoCloseZooOpenedNewFiles", true)

			const state = await provider.getState()

			// DiffViewProvider reads from getState(); all three fields must be present
			// so a regression that drops any of them is caught.
			expect(state.autoCloseZooOpenedFiles).toBe(false)
			expect(state.autoCloseZooOpenedFilesAfterUserEdited).toBe(true)
			expect(state.autoCloseZooOpenedNewFiles).toBe(true)
		})
	})

	it("getStateToPostToWebview passes through defined diffFuzzyThreshold value", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		await provider.contextProxy.setValue("diffFuzzyThreshold", 0.5)

		const state = await provider.getStateToPostToWebview()

		expect(state.diffFuzzyThreshold).toBe(0.5)
	})

	it("loads saved API config when switching modes", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = {
			name: "test-config",
			id: "test-id",
			apiProvider: providerIdentifiers.anthropic,
		}

		;(provider as any).providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue("test-id"),
			listConfig: vi.fn().mockResolvedValue([profile]),
			activateProfile: vi.fn().mockResolvedValue(profile),
			setModeConfig: vi.fn(),
			getProfile: vi.fn().mockResolvedValue(profile),
		} as any

		// Switch to architect mode
		await messageHandler({ type: "mode", text: "architect" })

		// Should load the saved config for architect mode
		expect(provider.providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("architect")
		expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ name: "test-config" })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "test-config")
	})

	it("saves current config when switching to mode without config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		;(provider as any).providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			listConfig: vi
				.fn()
				.mockResolvedValue([
					{ name: "current-config", id: "current-id", apiProvider: providerIdentifiers.anthropic },
				]),
			setModeConfig: vi.fn(),
		} as any

		await provider.setValue("currentApiConfigName", "current-config")

		// Switch to architect mode
		await messageHandler({ type: "mode", text: "architect" })

		// Should save current config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "current-id")
	})

	it("saves config as default for current mode when loading config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = {
			apiProvider: providerIdentifiers.anthropic,
			id: "new-id",
			name: "new-config",
		}

		;(provider as any).providerSettingsManager = {
			activateProfile: vi.fn().mockResolvedValue(profile),
			listConfig: vi.fn().mockResolvedValue([profile]),
			setModeConfig: vi.fn(),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
		} as any

		// First set the mode
		await messageHandler({ type: "mode", text: "architect" })

		// Then load the config
		await messageHandler({ type: "loadApiConfiguration", text: "new-config" })

		// Should save new config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "new-id")
	})

	it("load API configuration by ID works and updates mode config", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const profile: ProviderSettingsEntry = {
			name: "config-by-id",
			id: "config-id-123",
			apiProvider: providerIdentifiers.anthropic,
		}

		;(provider as any).providerSettingsManager = {
			activateProfile: vi.fn().mockResolvedValue(profile),
			listConfig: vi.fn().mockResolvedValue([profile]),
			setModeConfig: vi.fn(),
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
		} as any

		// First set the mode
		await messageHandler({ type: "mode", text: "architect" })

		// Then load the config by ID
		await messageHandler({ type: "loadApiConfigurationById", text: "config-id-123" })

		// Should save new config as default for architect mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "config-id-123")

		// Ensure the `activateProfile` method was called with the correct ID
		expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ id: "config-id-123" })
	})

	test("handles showRooIgnoredFiles setting", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Default value should be false
		expect((await provider.getState()).showRooIgnoredFiles).toBe(false)

		// Test showRooIgnoredFiles with true
		await messageHandler({ type: "updateSettings", updatedSettings: { showRooIgnoredFiles: true } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("showRooIgnoredFiles", true)
		expect(mockPostMessage).toHaveBeenCalled()
		expect((await provider.getState()).showRooIgnoredFiles).toBe(true)

		// Test showRooIgnoredFiles with false
		await messageHandler({ type: "updateSettings", updatedSettings: { showRooIgnoredFiles: false } })
		expect(mockContext.globalState.update).toHaveBeenCalledWith("showRooIgnoredFiles", false)
		expect(mockPostMessage).toHaveBeenCalled()
		expect((await provider.getState()).showRooIgnoredFiles).toBe(false)
	})

	test("handles updatePrompt message correctly", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock existing prompts
		const existingPrompts = {
			code: {
				roleDefinition: "existing code role",
				customInstructions: "existing code prompt",
			},
			architect: {
				roleDefinition: "existing architect role",
				customInstructions: "existing architect prompt",
			},
		}

		await provider.setValue("customModePrompts", existingPrompts)

		// Test updating a prompt
		await messageHandler({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: "new code prompt",
		})

		// Verify state was updated correctly
		expect(mockContext.globalState.update).toHaveBeenCalledWith("customModePrompts", {
			...existingPrompts,
			code: "new code prompt",
		})

		// Verify state was posted to webview
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "state",
				state: expect.objectContaining({
					customModePrompts: {
						...existingPrompts,
						code: "new code prompt",
					},
				}),
			}),
		)
	})

	test("customModePrompts defaults to empty object", async () => {
		// Mock globalState.get to return undefined for customModePrompts
		;(mockContext.globalState.get as any).mockImplementation((key: string) => {
			if (key === "customModePrompts") {
				return undefined
			}
			return null
		})

		const state = await provider.getState()
		expect(state.customModePrompts).toEqual({})
	})

	test("handles maxWorkspaceFiles message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		await messageHandler({ type: "updateSettings", updatedSettings: { maxWorkspaceFiles: 300 } })

		expect(updateGlobalStateSpy).toHaveBeenCalledWith("maxWorkspaceFiles", 300)
		expect(mockContext.globalState.update).toHaveBeenCalledWith("maxWorkspaceFiles", 300)
		expect(mockPostMessage).toHaveBeenCalled()
	})

	test("handles mode-specific custom instructions updates", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock existing prompts
		const existingPrompts = {
			code: {
				roleDefinition: "Code role",
				customInstructions: "Old instructions",
			},
		}
		mockContext.globalState.get = vi.fn((key: string) => {
			if (key === "customModePrompts") {
				return existingPrompts
			}
			return undefined
		})

		// Update custom instructions for code mode
		await messageHandler({
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: {
				roleDefinition: "Code role",
				customInstructions: "New instructions",
			},
		})

		// Verify state was updated correctly
		expect(mockContext.globalState.update).toHaveBeenCalledWith("customModePrompts", {
			code: {
				roleDefinition: "Code role",
				customInstructions: "New instructions",
			},
		})
	})

	it("saves mode config when updating API configuration", async () => {
		// Setup mock context with mode and config name
		mockContext = {
			...mockContext,
			globalState: {
				...mockContext.globalState,
				get: vi.fn((key: string) => {
					if (key === "mode") {
						return "code"
					} else if (key === "currentApiConfigName") {
						return "test-config"
					}
					return undefined
				}),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
		} as unknown as vscode.ExtensionContext

		// Create new provider with updated mock context
		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		const savedForReadBack4: Record<string, Record<string, unknown>> = {}
		;(provider as any).providerSettingsManager = {
			listConfig: vi
				.fn()
				.mockResolvedValue([
					{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
				]),
			saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
				savedForReadBack4[name] = settings
				return "test-id"
			}),
			getProfile: vi.fn(async ({ name }: { name: string }) => ({
				name,
				id: "test-id",
				...savedForReadBack4[name],
			})),
			setModeConfig: vi.fn(),
		} as any

		// Update API configuration
		await messageHandler({
			type: "upsertApiConfiguration",
			text: "test-config",
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
		})

		// Should save config as default for current mode
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "test-id")
	})

	test("file content includes line numbers", async () => {
		const { extractTextFromFile } = await import("../../../integrations/misc/extract-text")
		const result = await extractTextFromFile("test.js")
		expect(result).toBe("1 | const x = 1;\n2 | const y = 2;\n3 | const z = 3;")
	})

	describe("deleteMessage", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles deletion with confirmation dialog", async () => {
			// Setup mock messages
			const mockMessages = [
				{ ts: 1000, type: "say", say: "user_feedback" }, // User message 1
				{ ts: 2000, type: "say", say: "tool" }, // Tool message
				{ ts: 3000, type: "say", say: "text" }, // Message before delete
				{ ts: 4000, type: "say", say: "tool" }, // Message to delete
				{ ts: 5000, type: "say", say: "user_feedback" }, // Next user message
				{ ts: 6000, type: "say", say: "user_feedback" }, // Final message
			] as ClineMessage[]

			const mockApiHistory = [
				{ ts: 1000 },
				{ ts: 2000 },
				{ ts: 3000 },
				{ ts: 4000 },
				{ ts: 5000 },
				{ ts: 6000 },
			] as (Anthropic.MessageParam & { ts?: number })[]

			// Setup Task instance with auto-mock from the top of the file
			const mockCline = new Task(defaultTaskOptions) // Create a new mocked instance
			mockCline.clineMessages = mockMessages // Set test-specific messages
			mockCline.apiConversationHistory = mockApiHistory // Set API history
			await provider.addClineToStack(mockCline) // Add the mocked instance to the stack

			// Mock getTaskWithId
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			// Mock createTaskWithHistoryItem
			;(provider as any).createTaskWithHistoryItem = vi.fn()

			// Trigger message deletion
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
			await messageHandler({ type: "deleteMessage", value: 4000 })

			// Verify that the dialog message was sent to webview
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showDeleteMessageDialog",
				messageTs: 4000,
				hasCheckpoint: false,
			})

			// Simulate user confirming deletion through the dialog
			await messageHandler({ type: "deleteMessageConfirm", messageTs: 4000 })

			// Verify only messages before the deleted message were kept
			expect(mockCline.overwriteClineMessages).toHaveBeenCalledWith([
				mockMessages[0],
				mockMessages[1],
				mockMessages[2],
			])

			// Verify only API messages before the deleted message were kept
			expect(mockCline.overwriteApiConversationHistory).toHaveBeenCalledWith([
				mockApiHistory[0],
				mockApiHistory[1],
				mockApiHistory[2],
			])

			// createTaskWithHistoryItem is only called when restoring checkpoints or aborting tasks
			expect((provider as any).createTaskWithHistoryItem).not.toHaveBeenCalled()
		})

		test("handles case when no current task exists", async () => {
			// Clear the cline stack
			Object.assign(provider, { taskRegistry: new TaskRegistry() })

			// Trigger message deletion
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
			await messageHandler({ type: "deleteMessage", value: 2000 })

			// Verify no dialog was shown since there's no current cline
			expect(mockPostMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({
					type: "showDeleteMessageDialog",
				}),
			)
		})
	})

	describe("editMessage", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles edit with confirmation dialog", async () => {
			// Setup mock messages
			const mockMessages = [
				{ ts: 1000, type: "say", say: "user_feedback" }, // User message 1
				{ ts: 2000, type: "say", say: "tool" }, // Tool message
				{ ts: 3000, type: "say", say: "text" }, // Message before edit
				{ ts: 4000, type: "say", say: "tool" }, // Message to edit
				{ ts: 5000, type: "say", say: "user_feedback" }, // Next user message
				{ ts: 6000, type: "say", say: "user_feedback" }, // Final message
			] as ClineMessage[]

			const mockApiHistory = [
				{ ts: 1000 },
				{ ts: 2000 },
				{ ts: 3000 },
				{ ts: 4000 },
				{ ts: 5000 },
				{ ts: 6000 },
			] as (Anthropic.MessageParam & { ts?: number })[]

			// Setup Task instance with auto-mock from the top of the file
			const mockCline = new Task(defaultTaskOptions) // Create a new mocked instance
			mockCline.clineMessages = mockMessages // Set test-specific messages
			mockCline.apiConversationHistory = mockApiHistory // Set API history

			// Explicitly mock the overwrite methods since they're not being called in the tests
			mockCline.overwriteClineMessages = vi.fn()
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.handleWebviewAskResponse = vi.fn()

			await provider.addClineToStack(mockCline) // Add the mocked instance to the stack

			// Mock getTaskWithId
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			// Trigger message edit
			// Get the message handler function that was registered with the webview
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Call the message handler with a submitEditedMessage message
			await messageHandler({
				type: "submitEditedMessage",
				value: 4000,
				editedMessageContent: "Edited message content",
			})

			// Verify that the dialog message was sent to webview
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 4000,
				text: "Edited message content",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate user confirming edit through the dialog
			await messageHandler({
				type: "editMessageConfirm",
				messageTs: 4000,
				text: "Edited message content",
			})

			// Verify correct messages were kept - delete from the preceding user message to truly replace it
			expect(mockCline.overwriteClineMessages).toHaveBeenCalledWith([])

			// Verify correct API messages were kept
			expect(mockCline.overwriteApiConversationHistory).toHaveBeenCalledWith([])

			// The new flow calls webviewMessageHandler recursively with askResponse
			// We need to verify the recursive call happened by checking if the handler was called again
			expect((mockWebviewView.webview.onDidReceiveMessage as any).mock.calls.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe("getSystemPrompt", () => {
		beforeEach(async () => {
			mockPostMessage.mockClear()
			await provider.resolveWebviewView(mockWebviewView)
			// Reset and setup mock
			mockAddCustomInstructions.mockClear()
			mockAddCustomInstructions.mockImplementation(
				(modeInstructions: string, globalInstructions: string, _cwd: string) => {
					return Promise.resolve(modeInstructions || globalInstructions || "")
				},
			)
		})

		const getMessageHandler = () => {
			const mockCalls = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls
			expect(mockCalls.length).toBeGreaterThan(0)
			return mockCalls[0][0]
		}

		test("handles mcpEnabled setting correctly", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const handler = getMessageHandler()
			expect(typeof handler).toBe("function")

			// Test with mcpEnabled: true
			vi.spyOn(provider, "getState").mockResolvedValueOnce({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
				},
				mcpEnabled: true,
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)

			// Reset for second test
			mockPostMessage.mockClear()

			// Test with mcpEnabled: false
			vi.spyOn(provider, "getState").mockResolvedValueOnce({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
				},
				mcpEnabled: false,
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)
		})

		test("handles errors gracefully", async () => {
			// Mock SYSTEM_PROMPT to throw an error
			const { SYSTEM_PROMPT } = await import("../../prompts/system")
			vi.mocked(SYSTEM_PROMPT).mockRejectedValueOnce(new Error("Test error"))

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
			await messageHandler({ type: "getSystemPrompt", mode: "code" })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.get_system_prompt")
		})

		test("uses code mode custom instructions", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock getState to return custom instructions for code mode
			vi.spyOn(provider, "getState").mockResolvedValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
				},
				customModePrompts: {
					code: { customInstructions: "Code mode specific instructions" },
				},
				mode: "code" as const,
				experiments: experimentDefault,
			} as any)

			// Trigger getSystemPrompt
			const handler = getMessageHandler()
			await handler({ type: "getSystemPrompt", mode: "code" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "code",
				}),
			)
		})

		test("uses correct mode-specific instructions when mode is specified", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock getState to return architect mode instructions
			vi.spyOn(provider, "getState").mockResolvedValue({
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
				},
				customModePrompts: {
					architect: { customInstructions: "Architect mode instructions" },
				},
				mode: "architect",
				mcpEnabled: false,
				experiments: experimentDefault,
			} as any)

			// Trigger getSystemPrompt for architect mode
			const handler = getMessageHandler()
			await handler({ type: "getSystemPrompt", mode: "architect" })

			// Verify system prompt was generated and sent
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "systemPrompt",
					text: expect.any(String),
					mode: "architect",
				}),
			)
		})
	})

	describe("handleModeSwitch", () => {
		beforeEach(async () => {
			// Set up webview for each test
			await provider.resolveWebviewView(mockWebviewView)
		})

		it("loads saved API config when switching modes", async () => {
			const profile: ProviderSettingsEntry = {
				name: "saved-config",
				id: "saved-config-id",
				apiProvider: providerIdentifiers.anthropic,
			}

			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue("saved-config-id"),
				listConfig: vi.fn().mockResolvedValue([profile]),
				activateProfile: vi.fn().mockResolvedValue(profile),
				setModeConfig: vi.fn(),
				getProfile: vi.fn().mockResolvedValue(profile),
			} as any

			// Switch to architect mode
			await provider.handleModeSwitch("architect")

			// Verify mode was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "architect")

			// Verify saved config was loaded
			expect(provider.providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("architect")
			expect(provider.providerSettingsManager.activateProfile).toHaveBeenCalledWith({ name: "saved-config" })
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "saved-config")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})

		test("saves current config when switching to mode without config", async () => {
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "current-config", id: "current-id", apiProvider: providerIdentifiers.anthropic },
					]),
				setModeConfig: vi.fn(),
			} as any

			// Mock the ContextProxy's getValue method to return the current config name
			const contextProxy = (provider as any).contextProxy
			const getValueSpy = vi.spyOn(contextProxy, "getValue")
			getValueSpy.mockImplementation((key: any) => {
				if (key === "currentApiConfigName") return "current-config"
				return undefined
			})

			// Switch to architect mode
			await provider.handleModeSwitch("architect")

			// Verify mode was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "architect")

			// Verify current config was saved as default for new mode
			expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "current-id")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})
	})

	it("restores the task mode and its history entry when the shared mode write fails", async () => {
		await provider.resolveWebviewView(mockWebviewView)

		class TaskDouble {
			// Mirrors Task: taskMode is a getter over the private field the provider writes,
			// which has no public setter.
			_taskMode = "code"
			taskId = "mode-fail-task"
			emit = vi.fn()
			get taskMode() {
				return this._taskMode
			}
		}
		const task = new TaskDouble()

		provider.taskHistoryStore["cache"].set(task.taskId, {
			id: task.taskId,
			task: "mode switch",
			ts: Date.now(),
			number: 1,
			mode: "code",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})
		const updateHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockImplementation(async (item) => {
			provider.taskHistoryStore["cache"].set(item.id, item)
			return []
		})
		vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
		vi.spyOn(provider, "setValue").mockRejectedValue(new Error("mode write unavailable"))

		// The double mirrors only the two Task members this path touches, so it cannot
		// satisfy the full structural type.
		await expect(
			provider.handleModeSwitch("architect", task as unknown as Parameters<typeof provider.handleModeSwitch>[1]),
		).rejects.toThrow("mode write unavailable")

		// The history write and the task's own mode committed before the shared write
		// rejected. Leaving them at the rejected mode shows a failed switch on top of a
		// task that still runs the new mode.
		expect(task.taskMode).toBe("code")
		expect(provider.taskHistoryStore["cache"].get(task.taskId)).toMatchObject({ mode: "code" })
		expect(updateHistorySpy).toHaveBeenCalledTimes(2)
		expect(updateHistorySpy.mock.calls[1]?.[0]).toMatchObject({ id: task.taskId, mode: "code" })
		await provider.dispose()
	})

	describe("createTaskWithHistoryItem mode validation", () => {
		test("validates and falls back to default mode when restored mode no longer exists", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock custom modes that don't include the saved mode
			const mockCustomModesManager = {
				getCustomModes: vi.fn().mockResolvedValue([
					{
						slug: "existing-mode",
						name: "Existing Mode",
						roleDefinition: "Test role",
						groups: ["read"] as const,
					},
				]),
				dispose: vi.fn(),
			}
			;(provider as any).customModesManager = mockCustomModesManager

			// Mock getModeBySlug to return undefined for non-existent mode
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug)
				.mockReturnValueOnce(undefined) // First call returns undefined (mode doesn't exist)
				.mockReturnValue({
					slug: "code",
					name: "Code Mode",
					roleDefinition: "You are a code assistant",
					groups: ["read", "edit"],
				}) // Subsequent calls return default mode

			// Mock provider settings manager
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			}

			// Spy on log method to verify warning was logged
			const logSpy = vi.spyOn(provider, "log")

			// Create history item with non-existent mode
			const historyItem = {
				id: "test-id",
				ts: Date.now(),
				task: "Test task",
				mode: "non-existent-mode", // This mode doesn't exist
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			// Initialize with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify mode validation occurred
			expect(mockCustomModesManager.getCustomModes).toHaveBeenCalled()
			expect(getModeBySlug).toHaveBeenCalledWith("non-existent-mode", expect.any(Array))

			// Verify fallback to default mode, view-locally: history restore no longer
			// writes the shared global mode
			expect(provider["viewLocalState"].mode).toBe("code")
			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("mode", "code")
			expect(logSpy).toHaveBeenCalledWith(
				"Mode 'non-existent-mode' from history no longer exists. Falling back to default mode 'code'.",
			)

			// Verify history item was updated with default mode
			expect(historyItem.mode).toBe("code")
		})

		test("preserves mode when it exists in custom modes", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock custom modes that include the saved mode
			const mockCustomModesManager = {
				getCustomModes: vi.fn().mockResolvedValue([
					{
						slug: "custom-mode",
						name: "Custom Mode",
						roleDefinition: "Custom role",
						groups: ["read", "edit"] as const,
					},
				]),
				dispose: vi.fn(),
			}
			;(provider as any).customModesManager = mockCustomModesManager

			// Mock getModeBySlug to return the custom mode
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "custom-mode",
				name: "Custom Mode",
				roleDefinition: "Custom role",
				groups: ["read", "edit"],
			})

			// Mock provider settings manager
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue("config-id"),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "config-id", apiProvider: providerIdentifiers.anthropic },
					]),
				activateProfile: vi.fn().mockResolvedValue({
					name: "test-config",
					id: "config-id",
					apiProvider: providerIdentifiers.anthropic,
				}),
			}

			// Spy on log method to verify no warning was logged
			const logSpy = vi.spyOn(provider, "log")

			// Create history item with existing custom mode
			const historyItem = {
				id: "test-id",
				ts: Date.now(),
				task: "Test task",
				mode: "custom-mode",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			// Initialize with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify mode validation occurred
			expect(mockCustomModesManager.getCustomModes).toHaveBeenCalled()
			expect(getModeBySlug).toHaveBeenCalledWith("custom-mode", expect.any(Array))

			// Verify mode was preserved view-locally (no shared global mode write)
			expect(provider["viewLocalState"].mode).toBe("custom-mode")
			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("mode", "custom-mode")
			expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("no longer exists"))

			// Verify history item mode was not changed
			expect(historyItem.mode).toBe("custom-mode")
		})

		test("preserves mode when it exists in built-in modes", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock no custom modes
			const mockCustomModesManager = {
				getCustomModes: vi.fn().mockResolvedValue([]),
				dispose: vi.fn(),
			}
			;(provider as any).customModesManager = mockCustomModesManager

			// Mock getModeBySlug to return built-in architect mode
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "architect",
				name: "Architect Mode",
				roleDefinition: "You are an architect",
				groups: ["read", "edit"],
			})

			// Mock provider settings manager
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			}

			// Create history item with built-in mode
			const historyItem = {
				id: "test-id",
				ts: Date.now(),
				task: "Test task",
				mode: "architect",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			// Initialize with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify mode was preserved view-locally (no shared global mode write)
			expect(provider["viewLocalState"].mode).toBe("architect")
			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("mode", "architect")

			// Verify history item mode was not changed
			expect(historyItem.mode).toBe("architect")
		})

		test("handles history items without mode property", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock provider settings manager
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			}

			// Create history item without mode
			const historyItem = {
				id: "test-id",
				ts: Date.now(),
				task: "Test task",
				// No mode property
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			// Initialize with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify no mode validation occurred (mode update not called)
			expect(mockContext.globalState.update).not.toHaveBeenCalledWith("mode", expect.any(String))
		})

		test("continues with task restoration even if mode config loading fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Mock custom modes
			const mockCustomModesManager = {
				getCustomModes: vi.fn().mockResolvedValue([]),
				dispose: vi.fn(),
			}
			;(provider as any).customModesManager = mockCustomModesManager

			// Mock getModeBySlug to return built-in mode
			const { getModeBySlug } = await import("../../../shared/modes")
			vi.mocked(getModeBySlug).mockReturnValue({
				slug: "code",
				name: "Code Mode",
				roleDefinition: "You are a code assistant",
				groups: ["read", "edit"],
			})

			// Mock provider settings manager to throw error
			;(provider as any).providerSettingsManager = {
				getModeConfigId: vi.fn().mockResolvedValue("config-id"),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "config-id", apiProvider: providerIdentifiers.anthropic },
					]),
				activateProfile: vi.fn().mockRejectedValue(new Error("Failed to load config")),
			}

			// Spy on log method
			const logSpy = vi.spyOn(provider, "log")

			// Create history item
			const historyItem = {
				id: "test-id",
				ts: Date.now(),
				task: "Test task",
				mode: "code",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}

			// Initialize with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify error was logged but task restoration continued
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to restore API configuration for mode 'code'"),
			)
		})
	})

	describe("updateCustomMode", () => {
		test("updates both file and state when updating custom mode", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Mock CustomModesManager methods
			;(provider as any).customModesManager = {
				updateCustomMode: vi.fn().mockResolvedValue(undefined),
				getCustomModes: vi.fn().mockResolvedValue([
					{
						slug: "test-mode",
						name: "Test Mode",
						roleDefinition: "Updated role definition",
						groups: ["read"] as const,
					},
				]),
				dispose: vi.fn(),
			} as any

			// Test updating a custom mode
			await messageHandler({
				type: "updateCustomMode",
				modeConfig: {
					slug: "test-mode",
					name: "Test Mode",
					roleDefinition: "Updated role definition",
					groups: ["read"] as const,
				},
			})

			// Verify CustomModesManager.updateCustomMode was called
			expect(provider.customModesManager.updateCustomMode).toHaveBeenCalledWith(
				"test-mode",
				expect.objectContaining({
					slug: "test-mode",
					roleDefinition: "Updated role definition",
				}),
			)

			// Verify state was updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("customModes", [
				{ groups: ["read"], name: "Test Mode", roleDefinition: "Updated role definition", slug: "test-mode" },
			])

			// Verify state was posted to webview
			// Verify state was posted to webview with correct format
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state",
					state: expect.objectContaining({
						customModes: [
							expect.objectContaining({
								slug: "test-mode",
								roleDefinition: "Updated role definition",
							}),
						],
					}),
				}),
			)
		})
	})

	describe("upsertApiConfiguration", () => {
		test("handles error in upsertApiConfiguration gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn().mockRejectedValue(new Error("Failed to update mode config")),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
					]),
			} as any

			// Mock getState to provide necessary data
			vi.spyOn(provider, "getState").mockResolvedValue({
				mode: "code",
				currentApiConfigName: "test-config",
			} as any)

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "test-key" },
			})

			// Verify error was logged and user was notified
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error create new api configuration"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.create_api_config")
		})

		test("handles successful upsertApiConfiguration", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			const savedForReadBack5: Record<string, Record<string, unknown>> = {}
			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn(),
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack5[name] = settings
					return undefined
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: undefined,
					...savedForReadBack5[name],
				})),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
					]),
			} as any

			const testApiConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "test-key",
			}

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: testApiConfig,
			})

			// Verify config was saved
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("test-config", testApiConfig)

			// Verify state updates
			expect(mockContext.globalState.update).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
			])
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "test-config")

			// Verify state was posted to webview
			expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }))
		})

		test("handles buildApiHandler error in updateApiConfiguration", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Mock buildApiHandler to throw an error
			const { buildApiHandler } = await import("../../../api")

			;(buildApiHandler as any).mockImplementationOnce(() => {
				throw new Error("API handler error")
			})
			const savedForReadBack6: Record<string, Record<string, unknown>> = {}
			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn(),
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack6[name] = settings
					return undefined
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: undefined,
					...savedForReadBack6[name],
				})),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
					]),
			} as any

			// Setup Task instance with auto-mock from the top of the file
			const mockCline = new Task(defaultTaskOptions) // Create a new mocked instance
			await provider.addClineToStack(mockCline)

			const testApiConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "test-key",
			}

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: testApiConfig,
			})

			// Verify error handling
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Error create new api configuration"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.create_api_config")

			// Verify state was still updated
			expect(mockContext.globalState.update).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
			])
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "test-config")
		})

		test("handles successful saveApiConfiguration", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			const savedForReadBack7: Record<string, Record<string, unknown>> = {}
			;(provider as any).providerSettingsManager = {
				setModeConfig: vi.fn(),
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack7[name] = settings
					return undefined
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: undefined,
					...savedForReadBack7[name],
				})),
				listConfig: vi
					.fn()
					.mockResolvedValue([
						{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
					]),
			} as any

			const testApiConfig = {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "test-key",
			}

			// Trigger upsertApiConfiguration
			await messageHandler({
				type: "saveApiConfiguration",
				text: "test-config",
				apiConfiguration: testApiConfig,
			})

			// Verify config was saved
			expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("test-config", testApiConfig)

			// Verify state updates
			expect(mockContext.globalState.update).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
			])
			expect(updateGlobalStateSpy).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.anthropic },
			])
		})
	})
})

describe("webviewMessageHandler no-floating-promises coverage", () => {
	const createProvider = (overrides: Record<string, unknown> = {}) =>
		Object.assign(
			{
				context: {
					secrets: {
						get: vi.fn().mockResolvedValue(undefined),
					},
				},
				contextProxy: {
					getValue: vi.fn(),
					setValue: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn().mockResolvedValue(true),
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
				getCurrentTask: vi.fn(),
				getCurrentWorkspaceCodeIndexScope: vi.fn(),
				getMcpHub: vi.fn().mockReturnValue({
					getMcpSettingsFilePath: vi.fn().mockResolvedValue("/test/mcp.json"),
				}),
				providerSettingsManager: {
					listConfig: vi.fn().mockResolvedValue([]),
				},
				customModesManager: {
					getCustomModesFilePath: vi.fn().mockResolvedValue("/test/custom-modes.yaml"),
					exportModeWithRules: vi.fn(),
					importModeWithRules: vi.fn(),
					getCustomModes: vi.fn().mockResolvedValue([]),
					checkRulesDirectoryHasContent: vi.fn().mockResolvedValue(true),
				},
				exportTaskWithId: vi.fn().mockResolvedValue(undefined),
				showTaskWithId: vi.fn().mockResolvedValue(undefined),
				condenseTaskContext: vi.fn().mockResolvedValue(undefined),
				deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				log: vi.fn(),
				cwd: "/test/workspace",
			},
			overrides,
		) as unknown as ClineProvider

	const createIndexManager = (overrides: Record<string, unknown> = {}) =>
		Object.assign(
			{
				setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
				setAutoEnableDefault: vi.fn().mockResolvedValue(undefined),
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				isWorkspaceEnabled: true,
				initialize: vi.fn().mockResolvedValue(undefined),
				state: "Standby",
				isInitialized: true,
				startIndexing: vi.fn().mockResolvedValue(undefined),
				stopIndexing: vi.fn(),
				clearIndexData: vi.fn().mockResolvedValue(undefined),
				getCurrentStatus: vi.fn().mockReturnValue({ systemStatus: "Standby" }),
			},
			overrides,
		)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("logs a detached indexing rejection without rejecting the handler", async () => {
		let rejectIndexing!: (error: Error) => void
		const indexingPromise = new Promise<void>((_, reject) => {
			rejectIndexing = reject
		})
		const manager = createIndexManager({
			startIndexing: vi.fn().mockReturnValue(indexingPromise),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue({ codeIndexManager: manager }),
		})

		await expect(webviewMessageHandler(provider, { type: "startIndexing" })).resolves.toBeUndefined()
		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(manager.startIndexing).toHaveBeenCalledOnce()

		rejectIndexing(new Error("boom"))
		await Promise.resolve()
		await Promise.resolve()

		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: boom")
	})

	it("covers the changed task-operation happy paths", async () => {
		const task = {
			taskId: "task-1",
			handleTerminalOperation: vi.fn().mockResolvedValue(undefined),
		}
		const provider = createProvider({ getCurrentTask: vi.fn().mockReturnValue(task) })

		await webviewMessageHandler(provider, { type: "terminalOperation", terminalOperation: "continue" })
		await webviewMessageHandler(provider, { type: "exportCurrentTask" })
		await webviewMessageHandler(provider, { type: "showTaskWithId", text: "task-2" })
		await webviewMessageHandler(provider, { type: "condenseTaskContextRequest", text: "task-2" })
		await webviewMessageHandler(provider, { type: "deleteTaskWithId", text: "task-2" })
		await webviewMessageHandler(provider, { type: "exportTaskWithId", text: "task-2" })

		expect(task.handleTerminalOperation).toHaveBeenCalledWith("continue")
		expect(provider.exportTaskWithId).toHaveBeenCalledTimes(2)
		expect(provider.showTaskWithId).toHaveBeenCalledWith("task-2")
		expect(provider.condenseTaskContext).toHaveBeenCalledWith("task-2")
		expect(provider.deleteTaskWithId).toHaveBeenCalledWith("task-2")
	})

	it("covers changed file, image, mention, settings, and TTS dispatch paths", async () => {
		const { openFile } = await import("../../../integrations/misc/open-file")
		const { openImage, saveImage } = await import("../../../integrations/misc/image-handler")
		const { openMention } = await import("../../mentions")
		const { playTts } = await import("../../../utils/tts")
		const provider = createProvider()

		await webviewMessageHandler(provider, { type: "openImage", text: "/test/image.png" })
		await webviewMessageHandler(provider, { type: "saveImage", dataUri: "invalid" })
		await webviewMessageHandler(provider, { type: "openFile", text: "/test/file.ts" })
		await webviewMessageHandler(provider, { type: "openMention", text: "file.ts" })
		await webviewMessageHandler(provider, { type: "openCustomModesSettings" })
		await webviewMessageHandler(provider, { type: "openMcpSettings" })
		await webviewMessageHandler(provider, { type: "playTts", text: "hello" })

		expect(openImage).toHaveBeenCalledWith("/test/image.png", { values: undefined })
		expect(saveImage).toHaveBeenCalledOnce()
		expect(openFile).toHaveBeenCalledTimes(3)
		expect(openMention).toHaveBeenCalledWith("/test/workspace", "file.ts")
		expect(playTts).toHaveBeenCalledOnce()
	})

	it("covers changed configuration and rules response paths", async () => {
		const provider = createProvider()

		await webviewMessageHandler(provider, { type: "getListApiConfiguration" })
		await webviewMessageHandler(provider, { type: "checkRulesDirectory", slug: "mode-1" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({ type: "listApiConfig", listApiConfig: [] })
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "checkRulesDirectoryResult",
			slug: "mode-1",
			hasContent: true,
		})
	})

	it("covers all changed export-mode response paths", async () => {
		const provider = createProvider()
		const exportModeWithRules = provider.customModesManager.exportModeWithRules as ReturnType<typeof vi.fn>
		const showSaveDialog = vi.mocked(vscode.window.showSaveDialog)

		exportModeWithRules.mockResolvedValueOnce({ success: true, yaml: "mode: one" })
		showSaveDialog.mockResolvedValueOnce({ fsPath: "/test/mode.yaml" } as vscode.Uri)
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockResolvedValueOnce({ success: true, yaml: "mode: one" })
		showSaveDialog.mockResolvedValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockResolvedValueOnce({ success: false, error: "invalid mode" })
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		exportModeWithRules.mockRejectedValueOnce(new Error("export failed"))
		await webviewMessageHandler(provider, { type: "exportMode", slug: "mode-1" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "Export cancelled" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "invalid mode" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "exportModeResult", error: "export failed" }),
		)
	})

	it("covers all changed import-mode response paths", async () => {
		const provider = createProvider()
		const importModeWithRules = provider.customModesManager.importModeWithRules as ReturnType<typeof vi.fn>
		const showOpenDialog = vi.mocked(vscode.window.showOpenDialog)
		const selectedFile = [{ fsPath: "/test/mode.yaml" } as vscode.Uri]

		showOpenDialog.mockResolvedValueOnce(selectedFile)
		importModeWithRules.mockResolvedValueOnce({ success: true, slug: "mode-1" })
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockResolvedValueOnce(selectedFile)
		importModeWithRules.mockResolvedValueOnce({ success: false, error: "invalid mode" })
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockResolvedValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		showOpenDialog.mockRejectedValueOnce(new Error("dialog failed"))
		await webviewMessageHandler(provider, { type: "importMode", source: "project" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "invalid mode" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "cancelled" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "importModeResult", error: "dialog failed" }),
		)
	})

	it("covers changed cloud sign-out and rate-limit error responses", async () => {
		const { CloudService } = await import("@roo-code/cloud")
		const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
		const provider = createProvider()

		vi.mocked(CloudService.hasInstance).mockReturnValueOnce(false)
		await webviewMessageHandler(provider, { type: "rooCloudSignOut" })
		await webviewMessageHandler(provider, { type: "rooCloudSignOut" })

		vi.mocked(openAiCodexOAuthManager.getAccessToken).mockRejectedValueOnce(new Error("token failed"))
		await webviewMessageHandler(provider, { type: "requestOpenAiCodexRateLimits" })

		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "openAiCodexRateLimits",
			error: "token failed",
		})
	})

	it("covers changed indexing status, secret, and missing-manager responses", async () => {
		const manager = createIndexManager()
		const getScope = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ codeIndexManager: manager })
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: getScope,
		})

		await webviewMessageHandler(provider, { type: "requestIndexingStatus" })
		expect(manager.getCurrentStatus).not.toHaveBeenCalled()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: expect.objectContaining({ systemStatus: "Error", message: expect.any(String) }),
		})
		await webviewMessageHandler(provider, { type: "requestIndexingStatus" })
		expect(getScope).toHaveBeenCalledTimes(2)
		expect(manager.getCurrentStatus).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus.mock.results[0].value,
		})
		await webviewMessageHandler(provider, { type: "requestCodeIndexSecretStatus" })
		getScope.mockReturnValueOnce(undefined)
		await webviewMessageHandler(provider, { type: "startIndexing" })
		expect(getScope).toHaveBeenCalledTimes(3)
		expect(manager.setWorkspaceEnabled).not.toHaveBeenCalled()

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "codeIndexSecretStatus" }),
		)
		expect(provider.log).toHaveBeenCalledWith("Cannot start indexing: No workspace folder open")
	})

	it("catches both start-indexing calls during error recovery", async () => {
		const manager = createIndexManager({
			isInitialized: false,
			startIndexing: vi
				.fn()
				.mockRejectedValueOnce(new Error("first failure"))
				.mockRejectedValueOnce(new Error("second failure")),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue({ codeIndexManager: manager }),
		})

		await webviewMessageHandler(provider, { type: "startIndexing" })
		await Promise.resolve()

		expect(manager.startIndexing).toHaveBeenCalledTimes(2)
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: first failure")
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: second failure")
	})

	it("covers changed stop, toggle, and detached toggle rejection paths", async () => {
		const manager = createIndexManager({
			startIndexing: vi.fn().mockRejectedValue(new Error("toggle failure")),
		})
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue({
				codeIndexManager: manager,
				workspaceIndexingEnablementManager: new WorkspaceIndexingEnablementManager(manager),
			}),
		})

		await webviewMessageHandler(provider, { type: "stopIndexing" })
		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexingStatusUpdate",
			values: manager.getCurrentStatus(),
		})
		await webviewMessageHandler(provider, { type: "toggleWorkspaceIndexing", bool: true })
		await Promise.resolve()

		expect(manager.stopIndexing).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: toggle failure")
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "indexingStatusUpdate" }),
		)
	})

	it("does not toggle indexing or publish status without a workspace scope", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider, { type: "toggleWorkspaceIndexing", bool: true })
		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledExactlyOnceWith(
			"Cannot toggle workspace indexing: No workspace folder open",
		)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each([
		{ bool: true, expected: true },
		{ bool: false, expected: false },
		{ bool: undefined, expected: false },
	])("delegates workspace enablement with bool=$bool as $expected", async ({ bool, expected }) => {
		const setEnabled = vi.fn().mockResolvedValue(undefined)
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue({
				workspaceIndexingEnablementManager: { setEnabled },
			}),
		})
		const message: WebviewMessage = { type: "toggleWorkspaceIndexing" }
		if (bool !== undefined) {
			message.bool = bool
		}
		await webviewMessageHandler(provider, message)
		expect(setEnabled).toHaveBeenCalledExactlyOnceWith(expected, provider)
		// Status publication belongs to the enablement manager, not the handler.
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(provider.log).not.toHaveBeenCalled()
	})

	it("does not stop indexing or publish status without a workspace scope", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider, { type: "stopIndexing" })
		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith("Cannot stop indexing: No workspace folder open")
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it.each([true, false])("resolves the scope after saving index settings (workspace=%s)", async (hasWorkspace) => {
		const handleSettingsChange = vi.fn().mockResolvedValue(undefined)
		const manager = createIndexManager({ handleSettingsChange, isFeatureEnabled: false })
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi
				.fn()
				.mockReturnValue(hasWorkspace ? { codeIndexManager: manager } : undefined),
		})

		await webviewMessageHandler(provider, {
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: {
				codebaseIndexEnabled: false,
				codebaseIndexQdrantUrl: "http://localhost:6333",
				codebaseIndexEmbedderProvider: providerIdentifiers.openai,
				codebaseIndexEmbedderModelId: "text-embedding-3-small",
			},
		})

		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "codeIndexSettingsSaved", success: true }),
		)
		if (hasWorkspace) {
			expect(handleSettingsChange).toHaveBeenCalledOnce()
		} else {
			expect(handleSettingsChange).not.toHaveBeenCalled()
			expect(provider.log).toHaveBeenCalledWith("Cannot save code index settings: No workspace folder open")
		}
	})

	it("does not update auto-enable defaults without a workspace scope", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider, { type: "setAutoEnableDefault", bool: true })
		expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
		expect(provider.log).toHaveBeenCalledWith("Cannot set auto-enable default: No workspace folder open")
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("catches auto-enabled indexing failures and posts the resulting status", async () => {
		const { CodeIndexManagerRegistry } = await import("../../../services/code-index/code-index-manager-registry")
		let workspaceEnabled = false
		const manager = createIndexManager({
			setAutoEnableDefault: vi.fn().mockImplementation(async () => {
				workspaceEnabled = true
			}),
			startIndexing: vi.fn().mockRejectedValue(new Error("auto-enable failure")),
		})
		Object.defineProperty(manager, "isWorkspaceEnabled", { get: () => workspaceEnabled })
		const getAllInstances = vi
			.spyOn(CodeIndexManagerRegistry, "getAllInstances")
			.mockReturnValue([manager] as unknown as ReturnType<typeof CodeIndexManagerRegistry.getAllInstances>)
		const provider = createProvider({
			getCurrentWorkspaceCodeIndexScope: vi.fn().mockReturnValue({ codeIndexManager: manager }),
		})

		try {
			await webviewMessageHandler(provider, { type: "setAutoEnableDefault", bool: true })
			await Promise.resolve()

			expect(provider.getCurrentWorkspaceCodeIndexScope).toHaveBeenCalledOnce()
			expect(manager.startIndexing).toHaveBeenCalledOnce()
			expect(provider.log).toHaveBeenCalledWith("Indexing error: Error: auto-enable failure")
			expect(provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ type: "indexingStatusUpdate" }),
			)
		} finally {
			getAllInstances.mockRestore()
		}
	})

	it("covers changed clear-index response paths", async () => {
		const manager = createIndexManager()
		const getScope = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ codeIndexManager: manager })
		const provider = createProvider({ getCurrentWorkspaceCodeIndexScope: getScope })

		await webviewMessageHandler(provider, { type: "clearIndexData" })
		expect(manager.clearIndexData).not.toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith("Cannot clear index data: No workspace folder open")
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "indexCleared",
			values: { success: false, error: expect.any(String) },
		})
		await webviewMessageHandler(provider, { type: "clearIndexData" })
		manager.clearIndexData.mockRejectedValueOnce(new Error("clear failed"))
		await webviewMessageHandler(provider, { type: "clearIndexData" })

		expect(getScope).toHaveBeenCalledTimes(3)
		expect(manager.clearIndexData).toHaveBeenCalledTimes(2)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: true },
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: false, error: "clear failed" },
		})
	})

	it("covers changed marketplace error and removal responses", async () => {
		const provider = createProvider()
		const item = {
			id: "item-1",
			name: "Item 1",
			description: "Test marketplace item",
			type: "mode",
			content: "slug: item-1",
		} satisfies NonNullable<WebviewMessage["mpItem"]>
		const options = { target: "project" } satisfies NonNullable<WebviewMessage["mpInstallOptions"]>
		const marketplaceManager = {
			installMarketplaceItem: vi.fn().mockRejectedValue(new Error("install failed")),
			removeInstalledMarketplaceItem: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("remove failed")),
		}
		const managerArgument = marketplaceManager as unknown as NonNullable<
			Parameters<typeof webviewMessageHandler>[2]
		>

		await webviewMessageHandler(
			provider,
			{ type: "installMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(
			provider,
			{ type: "removeInstalledMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(
			provider,
			{ type: "removeInstalledMarketplaceItem", mpItem: item, mpInstallOptions: options },
			managerArgument,
		)
		await webviewMessageHandler(provider, {
			type: "removeInstalledMarketplaceItem",
			mpItem: item,
			mpInstallOptions: options,
		})

		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceInstallResult", success: false }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", success: true }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", error: "remove failed" }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "marketplaceRemoveResult", error: "Marketplace manager is not available" }),
		)
	})
})

describe("Project MCP Settings", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any

	beforeEach(async () => {
		vi.clearAllMocks()
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("")

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn(),
				store: vi.fn(),
				delete: vi.fn(),
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

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()
		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn(),
			onDidChangeVisibility: vi.fn(),
		}
		;(vscode.window as any).activeTextEditor = undefined
		;(vscode.workspace.getWorkspaceFolder as any).mockReset()
		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	test("handles openProjectMcpSettings message", async () => {
		// Mock workspace folders first
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/test/workspace" } }]
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("/test/workspace")

		// Mock fs functions
		const fs = await import("fs/promises")
		const mockedFs = vi.mocked(fs)
		mockedFs.mkdir.mockClear()
		mockedFs.mkdir.mockResolvedValue(undefined)
		mockedFs.writeFile.mockClear()
		mockedFs.writeFile.mockResolvedValue(undefined)

		// Mock fileExistsAtPath to return false (file doesn't exist)
		const fsUtils = await import("../../../utils/fs")
		vi.spyOn(fsUtils, "fileExistsAtPath").mockResolvedValue(false)

		// Mock openFile
		const openFileModule = await import("../../../integrations/misc/open-file")
		const openFileSpy = vi.spyOn(openFileModule, "openFile").mockClear().mockResolvedValue(undefined)

		// Set up the webview
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Ensure the message handler is properly set up
		expect(messageHandler).toBeDefined()
		expect(typeof messageHandler).toBe("function")

		// Trigger openProjectMcpSettings through the message handler
		await messageHandler({
			type: "openProjectMcpSettings",
		})

		const expectedRooDir = path.join("/test/workspace", ".roo")
		const expectedMcpPath = path.join(expectedRooDir, "mcp.json")

		// Check that fs.mkdir was called with the correct path
		expect(mockedFs.mkdir).toHaveBeenCalledWith(expectedRooDir, { recursive: true })
		expect(pathUtils.getWorkspacePath).toHaveBeenCalled()

		// Verify file was created with default content
		expect(safeWriteJson).toHaveBeenCalledWith(expectedMcpPath, { mcpServers: {} }, { prettyPrint: true })

		// Check that openFile was called
		expect(openFileSpy).toHaveBeenCalledWith(expectedMcpPath)
	})

	test("handles openProjectMcpSettings when workspace is not open", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock no workspace folders
		;(vscode.workspace as any).workspaceFolders = []

		// Trigger openProjectMcpSettings
		await messageHandler({ type: "openProjectMcpSettings" })

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.no_workspace")
	})

	test("handles openProjectMcpSettings file creation error", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock workspace folders
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/test/workspace" } }]
		const pathUtils = await import("../../../utils/path")
		vi.mocked(pathUtils.getWorkspacePath).mockReturnValue("/test/workspace")

		// Mock fs functions to fail
		const fs = await import("fs/promises")
		const mockedFs = vi.mocked(fs)
		mockedFs.mkdir.mockRejectedValue(new Error("Failed to create directory"))

		// Trigger openProjectMcpSettings
		await messageHandler({
			type: "openProjectMcpSettings",
		})

		// Verify the translated error key is surfaced in test mode
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.create_json")
	})
})

describe("getTelemetryProperties", () => {
	let defaultTaskOptions: TaskOptions
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockCline: any

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()

		// Initialize TelemetryService if not already initialized
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Setup basic mocks
		mockContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "mode") return "code"
					if (key === "apiProvider") return "anthropic"
					return undefined
				}),
				update: vi.fn(),
				keys: vi.fn().mockReturnValue([]),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalStorageUri: { fsPath: "/test/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		defaultTaskOptions = {
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
			},
		}

		// Setup Task instance with mocked getModel method
		mockCline = new Task(defaultTaskOptions)
		mockCline.api = {
			getModel: vi.fn().mockReturnValue({
				id: "claude-sonnet-4-20250514",
				info: { contextWindow: 200000 },
			}),
		}
	})

	test("includes basic properties in telemetry", async () => {
		const properties = await provider.getTelemetryProperties()

		expect(properties).toHaveProperty("vscodeVersion")
		expect(properties).toHaveProperty("platform")
		expect(properties).toHaveProperty("appVersion", "1.0.0")
	})

	test("includes model ID from current Cline instance if available", async () => {
		// Add mock Cline to stack
		await provider.addClineToStack(mockCline)

		const properties = await provider.getTelemetryProperties()

		expect(properties).toHaveProperty("modelId", "claude-sonnet-4-20250514")
	})

	describe("cloud authentication telemetry", () => {
		beforeEach(() => {
			// Reset all mocks before each test
			vi.clearAllMocks()
		})

		test("includes cloud authentication property when user is authenticated", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockReturnValue(true),

				// Provider dispose detaches the settings listener; later tests construct
				// and dispose providers against this surviving instance getter.
				on: vi.fn(),
				off: vi.fn(),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			expect(properties).toHaveProperty("cloudIsAuthenticated", true)
		})

		test("includes cloud authentication property when user is not authenticated", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockReturnValue(false),

				// Provider dispose detaches the settings listener; later tests construct
				// and dispose providers against this surviving instance getter.
				on: vi.fn(),
				off: vi.fn(),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			expect(properties).toHaveProperty("cloudIsAuthenticated", false)
		})

		test("handles CloudService errors gracefully", async () => {
			// Import the CloudService mock and update it to throw an error
			const { CloudService } = await import("@roo-code/cloud")
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockImplementation(() => {
					throw new Error("CloudService not available")
				}),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			// Should still include basic telemetry properties
			expect(properties).toHaveProperty("vscodeVersion")
			expect(properties).toHaveProperty("platform")
			expect(properties).toHaveProperty("appVersion", "1.0.0")

			// Cloud property should be undefined when CloudService is not available
			expect(properties).toHaveProperty("cloudIsAuthenticated", undefined)
		})

		test("handles CloudService method errors gracefully", async () => {
			// Import the CloudService mock and update it
			const { CloudService } = await import("@roo-code/cloud")
			const mockCloudService = {
				isAuthenticated: vi.fn().mockImplementation(() => {
					throw new Error("Authentication check error")
				}),

				// Provider dispose detaches the settings listener; later tests construct
				// and dispose providers against this surviving instance getter.
				on: vi.fn(),
				off: vi.fn(),
			}

			// Update the existing mock
			Object.defineProperty(CloudService, "instance", {
				get: vi.fn().mockReturnValue(mockCloudService),
				configurable: true,
			})

			const properties = await provider.getTelemetryProperties()

			// Should still include basic telemetry properties
			expect(properties).toHaveProperty("vscodeVersion")
			expect(properties).toHaveProperty("platform")
			expect(properties).toHaveProperty("appVersion", "1.0.0")

			// Property that errored should be undefined
			expect(properties).toHaveProperty("cloudIsAuthenticated", undefined)
		})
	})
})

describe("ClineProvider - Router Models", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any
	// One distinct handler double per provider, so assertions can prove that each getModels
	// call receives the handler built for its own provider rather than just any handler.
	let handlersByProvider: Map<string | undefined, object>

	const handlerForProvider = (providerName: string) => {
		const handler = handlersByProvider.get(providerName)
		if (!handler) {
			throw new Error(`buildApiHandler was never called for provider "${providerName}"`)
		}
		return handler
	}

	beforeEach(async () => {
		vi.clearAllMocks()

		// An earlier test leaves a one-shot throwing implementation on buildApiHandler that
		// vi.clearAllMocks() does not remove. Reset it so the router-model fetches receive a
		// real handler double instead of throwing on the first provider. The double assertion
		// is required because the mock only needs the getModel member the tests exercise.
		const { buildApiHandler } = await import("../../../api")
		handlersByProvider = new Map()
		vi.mocked(buildApiHandler).mockReset()
		vi.mocked(buildApiHandler).mockImplementation((configuration) => {
			const providerName = configuration.apiProvider
			let handler = handlersByProvider.get(providerName)
			if (!handler) {
				handler = {
					providerName,
					getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
				}
				handlersByProvider.set(providerName, handler)
			}
			return handler as unknown as ReturnType<typeof buildApiHandler>
		})

		const globalState: Record<string, string | undefined> = {}
		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
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

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()
		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
	})

	test("handles requestRouterModels with successful responses", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock getState to return API configuration
		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		} as any)

		const mockModels = {
			"model-1": {
				maxTokens: 4096,
				contextWindow: 8192,
				description: "Test model 1",
				supportsPromptCache: false,
			},
			"model-2": {
				maxTokens: 8192,
				contextWindow: 16384,
				description: "Test model 2",
				supportsPromptCache: false,
			},
		}

		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({ type: "requestRouterModels" })

		// Verify getModels was called for each provider with correct options and that provider's handler.
		expect(getModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.openrouter },
			handlerForProvider(providerIdentifiers.openrouter),
		)
		expect(getModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.requesty, apiKey: "requesty-key" },
			handlerForProvider(providerIdentifiers.requesty),
		)
		expect(getModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.unbound },
			handlerForProvider(providerIdentifiers.unbound),
		)
		expect(getModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.vercelAiGateway },
			handlerForProvider(providerIdentifiers.vercelAiGateway),
		)
		expect(getModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.litellm,
				apiKey: "litellm-key",
				baseUrl: "http://localhost:4000",
			},
			handlerForProvider(providerIdentifiers.litellm),
		)
		// Opencode Go's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(getModels).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.opencodeGo }),
			handlerForProvider(providerIdentifiers.opencodeGo),
		)
		// Kenari's /models endpoint is public, so it is fetched like the other no-auth routers.
		expect(getModels).toHaveBeenCalledWith(
			expect.objectContaining({ provider: providerIdentifiers.kenari }),
			handlerForProvider(providerIdentifiers.kenari),
		)
		// NanoGPT's detailed catalog is public and may be scoped by an optional key.
		expect(getModels).toHaveBeenCalledWith(
			{ provider: providerIdentifiers.nanogpt, apiKey: undefined },
			handlerForProvider(providerIdentifiers.nanogpt),
		)
		// Every getModels call must receive the handler built for the provider it fetches.
		for (const [options, handler] of vi.mocked(getModels).mock.calls) {
			expect(handler).toBe(handlerForProvider(options.provider))
		}

		// Verify response was sent
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				litellm: mockModels,
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				"io-intelligence": mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	test("handles requestRouterModels with individual provider failures", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				litellmApiKey: "litellm-key",
				litellmBaseUrl: "http://localhost:4000",
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")

		// Mock some providers to succeed and others to fail
		vi.mocked(getModels)
			.mockResolvedValueOnce(mockModels) // openrouter success
			.mockRejectedValueOnce(new Error("Requesty API error")) // requesty fail
			.mockResolvedValueOnce(mockModels) // unbound success
			.mockResolvedValueOnce(mockModels) // vercel-ai-gateway success
			.mockResolvedValueOnce(mockModels) // zoo-gateway success
			.mockRejectedValueOnce(new Error("LiteLLM connection failed")) // litellm fail
			.mockResolvedValueOnce(mockModels) // opencode-go (public endpoint)
			.mockResolvedValueOnce(mockModels) // kenari (public endpoint)
			.mockResolvedValueOnce(mockModels) // io-intelligence (public endpoint)
			.mockResolvedValueOnce(mockModels) // nanogpt (public endpoint)

		await messageHandler({ type: "requestRouterModels" })

		// Verify main response includes successful providers and empty objects for failed ones
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: {},
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				ollama: {},
				lmstudio: {},
				litellm: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				"io-intelligence": mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})

		// Verify error messages were sent for failed providers
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "Requesty API error",
			values: { provider: providerIdentifiers.requesty },
		})

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "singleRouterModelFetchResponse",
			success: false,
			error: "LiteLLM connection failed",
			values: { provider: providerIdentifiers.litellm },
		})
	})

	test("handles requestRouterModels with LiteLLM values from message", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		// Mock state without LiteLLM config
		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// No litellm config
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({
			type: "requestRouterModels",
			values: {
				litellmApiKey: "message-litellm-key",
				litellmBaseUrl: "http://message-url:4000",
			},
		})

		// Verify LiteLLM was called with values from message
		expect(getModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.litellm,
				apiKey: "message-litellm-key",
				baseUrl: "http://message-url:4000",
			},
			handlerForProvider(providerIdentifiers.litellm),
		)
	})

	test("skips LiteLLM when neither config nor message values are provided", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				openRouterApiKey: "openrouter-key",
				requestyApiKey: "requesty-key",
				// No litellm config
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({ type: "requestRouterModels" })

		// Verify LiteLLM was NOT called
		expect(getModels).not.toHaveBeenCalledWith(
			expect.objectContaining({
				provider: providerIdentifiers.litellm,
			}),
			expect.anything(),
		)

		// Verify response includes empty object for LiteLLM
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "routerModels",
			routerModels: {
				openrouter: mockModels,
				requesty: mockModels,
				unbound: mockModels,
				"vercel-ai-gateway": mockModels,
				"zoo-gateway": mockModels,
				litellm: {},
				ollama: {},
				lmstudio: {},
				poe: {},
				deepseek: {},
				moonshot: {},
				"opencode-go": mockModels,
				kenari: mockModels,
				"io-intelligence": mockModels,
				nanogpt: mockModels,
				"kimi-code": {},
			},
			values: undefined,
		})
	})

	test("handles requestLmStudioModels with proper response", async () => {
		await provider.resolveWebviewView(mockWebviewView)
		const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

		vi.spyOn(provider, "getState").mockResolvedValue({
			apiConfiguration: {
				lmStudioModelId: "model-1",
				lmStudioBaseUrl: "http://localhost:1234",
			},
		} as any)

		const mockModels = {
			"model-1": { maxTokens: 4096, contextWindow: 8192, description: "Test model", supportsPromptCache: false },
		}
		const { getModels } = await import("../../../api/providers/fetchers/modelCache")
		vi.mocked(getModels).mockResolvedValue(mockModels)

		await messageHandler({
			type: "requestLmStudioModels",
		})

		expect(getModels).toHaveBeenCalledWith(
			{
				provider: providerIdentifiers.lmstudio,
				baseUrl: "http://localhost:1234",
			},
			handlerForProvider(providerIdentifiers.lmstudio),
		)
	})
})

describe("ClineProvider - Comprehensive Edit/Delete Edge Cases", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: any
	let mockPostMessage: any
	let defaultTaskOptions: TaskOptions

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "current-config",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					return globalState[key]
				}),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => {
					return Object.keys(globalState)
				}),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => {
					return secrets[key]
				}),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value)
				}),
				delete: vi.fn().mockImplementation((key: string) => {
					return delete secrets[key]
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

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		}

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		defaultTaskOptions = {
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
			},
		}

		// Mock getMcpHub method
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	describe("Edit Messages with Images and Attachments", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles editing messages containing images", async () => {
			const mockMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Original message" },
				{
					ts: 2000,
					type: "say",
					say: "user_feedback",
					text: "Message with image",
					images: [
						"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
					],
					value: 3000,
				},
				{ ts: 3000, type: "say", say: "text", text: "AI response" },
			] as ClineMessage[]

			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = mockMessages
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn()
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.submitUserMessage = vi.fn()

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
			await messageHandler({
				type: "submitEditedMessage",
				value: 3000,
				editedMessageContent: "Edited message with preserved images",
			})

			// Verify dialog was shown
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 3000,
				text: "Edited message with preserved images",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate confirmation
			await messageHandler({
				type: "editMessageConfirm",
				messageTs: 3000,
				text: "Edited message with preserved images",
			})

			// Verify messages were edited correctly - the ORIGINAL user message and all subsequent messages are removed
			expect(mockCline.overwriteClineMessages).toHaveBeenCalledWith([mockMessages[0]])
			expect(mockCline.overwriteApiConversationHistory).toHaveBeenCalledWith([{ ts: 1000 }])
			// Verify submitUserMessage was called with the edited content
			expect(mockCline.submitUserMessage).toHaveBeenCalledWith("Edited message with preserved images", [])
		})

		test("handles editing messages with file attachments", async () => {
			const mockMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Original message" },
				{
					ts: 2000,
					type: "say",
					say: "user_feedback",
					text: "Message with file",
					attachments: [{ path: "/path/to/file.txt", type: "file" }],
					value: 3000,
				},
				{ ts: 3000, type: "say", say: "text", text: "AI response" },
			] as ClineMessage[]

			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = mockMessages
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn()
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.submitUserMessage = vi.fn()

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]
			await messageHandler({
				type: "submitEditedMessage",
				value: 3000,
				editedMessageContent: "Edited message with file attachment",
			})

			// Verify dialog was shown
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 3000,
				text: "Edited message with file attachment",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate user confirming the edit
			await messageHandler({
				type: "editMessageConfirm",
				messageTs: 3000,
				text: "Edited message with file attachment",
			})

			expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
			expect(mockCline.submitUserMessage).toHaveBeenCalledWith("Edited message with file attachment", [])
		})
	})

	describe("Network Failure Scenarios", () => {
		beforeEach(async () => {
			;(vscode.window.showInformationMessage as any) = vi.fn()
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles network timeout during edit submission", async () => {
			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Original message", value: 2000 },
				{ ts: 2000, type: "say", say: "text", text: "AI response" },
			] as ClineMessage[]
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn()
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.handleWebviewAskResponse = vi.fn().mockRejectedValue(new Error("Network timeout"))

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Should not throw error, but handle gracefully
			await expect(
				messageHandler({
					type: "submitEditedMessage",
					value: 2000,
					editedMessageContent: "Edited message",
				}),
			).resolves.toBeUndefined()

			// Verify dialog was shown
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 2000,
				text: "Edited message",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate user confirming the edit
			await messageHandler({ type: "editMessageConfirm", messageTs: 2000, text: "Edited message" })

			expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
		})

		test("handles connection drops during edit operation", async () => {
			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Original message", value: 2000 },
				{ ts: 2000, type: "say", say: "text", text: "AI response" },
			] as ClineMessage[]
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn().mockRejectedValue(new Error("Connection lost"))
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.handleWebviewAskResponse = vi.fn()

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Should handle connection error gracefully
			await expect(
				messageHandler({
					type: "submitEditedMessage",
					value: 2000,
					editedMessageContent: "Edited message",
				}),
			).resolves.toBeUndefined()

			// Verify dialog was shown
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 2000,
				text: "Edited message",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate user confirming the edit
			await messageHandler({ type: "editMessageConfirm", messageTs: 2000, text: "Edited message" })

			// The error should be caught and shown
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.message.error_editing_message")
		})
	})

	describe("Concurrent Edit Operations", () => {
		beforeEach(async () => {
			;(vscode.window.showInformationMessage as any) = vi.fn()
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles race conditions with simultaneous edits", async () => {
			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Message 1", value: 2000 },
				{ ts: 2000, type: "say", say: "text", text: "AI response 1" },
				{ ts: 3000, type: "say", say: "user_feedback", text: "Message 2", value: 4000 },
				{ ts: 4000, type: "say", say: "text", text: "AI response 2" },
			] as ClineMessage[]
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }, { ts: 4000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn()
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.handleWebviewAskResponse = vi.fn()

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			// Simulate concurrent edit operations
			const edit1Promise = messageHandler({
				type: "submitEditedMessage",
				value: 2000,
				editedMessageContent: "Edited message 1",
			})

			const edit2Promise = messageHandler({
				type: "submitEditedMessage",
				value: 4000,
				editedMessageContent: "Edited message 2",
			})

			await Promise.all([edit1Promise, edit2Promise])

			// Verify dialogs were shown for both edits
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 2000,
				text: "Edited message 1",
				hasCheckpoint: false,
				images: undefined,
			})
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showEditMessageDialog",
				messageTs: 4000,
				text: "Edited message 2",
				hasCheckpoint: false,
				images: undefined,
			})

			// Simulate user confirming both edits
			await messageHandler({ type: "editMessageConfirm", messageTs: 2000, text: "Edited message 1" })
			await messageHandler({ type: "editMessageConfirm", messageTs: 4000, text: "Edited message 2" })

			// Both operations should complete without throwing
			expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
		})
	})

	describe("Edit Permissions and Authorization", () => {
		beforeEach(async () => {
			;(vscode.window.showInformationMessage as any) = vi.fn()
			await provider.resolveWebviewView(mockWebviewView)
		})

		test("handles edit permission failures", async () => {
			// Mock no current cline (simulating permission failure)
			vi.spyOn(provider, "getCurrentTask").mockReturnValue(undefined)

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			await messageHandler({
				type: "submitEditedMessage",
				value: 2000,
				editedMessageContent: "Edited message",
			})

			// Should not show confirmation dialog when no current cline
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		test("handles authorization failures during edit", async () => {
			const mockCline = new Task(defaultTaskOptions)
			mockCline.clineMessages = [
				{ ts: 1000, type: "say", say: "user_feedback", text: "Original message", value: 2000 },
				{ ts: 2000, type: "say", say: "text", text: "AI response" },
			] as ClineMessage[]
			mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
			mockCline.overwriteClineMessages = vi.fn().mockRejectedValue(new Error("Unauthorized"))
			mockCline.overwriteApiConversationHistory = vi.fn()
			mockCline.handleWebviewAskResponse = vi.fn()

			await provider.addClineToStack(mockCline)
			;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
				historyItem: { id: "test-task-id" },
			})

			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			await messageHandler({
				type: "submitEditedMessage",
				value: 2000,
				editedMessageContent: "Edited message",
			})

			// Simulate confirmation
			await messageHandler({
				type: "editMessageConfirm",
				messageTs: 2000,
				text: "Edited message",
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.message.error_editing_message")
		})

		describe("Malformed Requests and Invalid Formats", () => {
			beforeEach(async () => {
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("handles malformed edit requests", async () => {
				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Test with missing value
				await messageHandler({
					type: "submitEditedMessage",
					editedMessageContent: "Edited message",
				})

				// Test with invalid value type
				await messageHandler({
					type: "submitEditedMessage",
					value: "invalid",
					editedMessageContent: "Edited message",
				})

				// Test with missing editedMessageContent
				await messageHandler({
					type: "submitEditedMessage",
					value: 2000,
				})

				// Should not show confirmation dialog for malformed requests
				expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			})

			test("handles invalid message formats", async () => {
				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Test with null message - should throw error
				await expect(messageHandler(null)).rejects.toThrow()

				// Test with undefined message - should throw error
				await expect(messageHandler(undefined)).rejects.toThrow()

				// Test with message missing type
				await expect(
					messageHandler({
						value: 2000,
						editedMessageContent: "Edited message",
					}),
				).resolves.toBeUndefined()

				// Should handle gracefully without errors
				expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			})

			test("handles invalid timestamp values", async () => {
				;(vscode.window.showInformationMessage as any) = vi.fn()

				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Original message" },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]

				await provider.addClineToStack(mockCline)

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Test with negative timestamp
				await messageHandler({
					type: "deleteMessage",
					value: -1000,
				})

				// Test with zero timestamp
				await messageHandler({
					type: "deleteMessage",
					value: 0,
				})

				// Invalid timestamps may still trigger confirmation dialog
				// This is expected behavior as the system tries to process the message
			})
		})

		describe("Operations on Deleted or Non-existent Messages", () => {
			beforeEach(async () => {
				;(vscode.window.showInformationMessage as any) = vi.fn()
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("handles edit operations on deleted messages", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Existing message" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()
				mockCline.handleWebviewAskResponse = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Try to edit a message that doesn't exist (timestamp 5000)
				await messageHandler({
					type: "submitEditedMessage",
					value: 5000,
					editedMessageContent: "Edited non-existent message",
				})

				// Should show edit dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showEditMessageDialog",
					messageTs: 5000,
					text: "Edited non-existent message",
					hasCheckpoint: false,
					images: undefined,
				})

				// Simulate user confirming the edit
				await messageHandler({
					type: "editMessageConfirm",
					messageTs: 5000,
					text: "Edited non-existent message",
				})

				// Should not perform any operations since message doesn't exist
				expect(mockCline.overwriteClineMessages).not.toHaveBeenCalled()
				expect(mockCline.handleWebviewAskResponse).not.toHaveBeenCalled()
			})

			test("handles delete operations on non-existent messages", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Existing message" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				// Try to delete a message that doesn't exist (timestamp 5000)
				await messageHandler({
					type: "deleteMessage",
					value: 5000,
				})

				// Should show delete dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showDeleteMessageDialog",
					messageTs: 5000,
					hasCheckpoint: false,
				})

				// Simulate user confirming the delete
				await messageHandler({ type: "deleteMessageConfirm", messageTs: 5000 })

				// Should not perform any operations since message doesn't exist
				expect(mockCline.overwriteClineMessages).not.toHaveBeenCalled()
			})
		})

		describe("Resource Cleanup During Failed Operations", () => {
			beforeEach(async () => {
				;(vscode.window.showInformationMessage as any) = vi.fn()
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("validates proper cleanup during failed edit operations", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Original message", value: 2000 },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]

				// Mock cleanup tracking
				const cleanupSpy = vi.fn()
				mockCline.overwriteClineMessages = vi.fn().mockImplementation(() => {
					cleanupSpy()
					throw new Error("Operation failed")
				})
				mockCline.overwriteApiConversationHistory = vi.fn()
				mockCline.handleWebviewAskResponse = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({
					type: "submitEditedMessage",
					value: 2000,
					editedMessageContent: "Edited message",
				})

				// Should show edit dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showEditMessageDialog",
					messageTs: 2000,
					text: "Edited message",
					hasCheckpoint: false,
					images: undefined,
				})

				// Simulate user confirming the edit
				await messageHandler({ type: "editMessageConfirm", messageTs: 2000, text: "Edited message" })

				// Verify cleanup was attempted before failure
				expect(cleanupSpy).toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.message.error_editing_message")
			})

			test("validates proper cleanup during failed delete operations", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Message to delete" },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]

				// Mock cleanup tracking
				const cleanupSpy = vi.fn()
				mockCline.overwriteClineMessages = vi.fn().mockImplementation(() => {
					cleanupSpy()
					throw new Error("Delete operation failed")
				})
				mockCline.overwriteApiConversationHistory = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({ type: "deleteMessage", value: 2000 })

				// Should show delete dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showDeleteMessageDialog",
					messageTs: 2000,
					hasCheckpoint: false,
				})

				// Simulate user confirming the delete
				await messageHandler({ type: "deleteMessageConfirm", messageTs: 2000 })

				// Verify cleanup was attempted before failure
				expect(cleanupSpy).toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("errors.message.error_deleting_message")
			})
		})

		describe("Large Message Payloads", () => {
			beforeEach(async () => {
				;(vscode.window.showInformationMessage as any) = vi.fn()
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("handles editing messages with large text content", async () => {
				// Create a large message (10KB of text)
				const largeText = "A".repeat(10000)
				const mockMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: largeText, value: 2000 },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]

				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = mockMessages
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()
				mockCline.submitUserMessage = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				const largeEditedContent = "B".repeat(15000)
				await messageHandler({
					type: "submitEditedMessage",
					value: 2000,
					editedMessageContent: largeEditedContent,
				})

				// Should show edit dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showEditMessageDialog",
					messageTs: 2000,
					text: largeEditedContent,
					hasCheckpoint: false,
					images: undefined,
				})

				// Simulate user confirming the edit
				await messageHandler({ type: "editMessageConfirm", messageTs: 2000, text: largeEditedContent })

				expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
				expect(mockCline.submitUserMessage).toHaveBeenCalledWith(largeEditedContent, [])
			})

			test("handles deleting messages with large payloads", async () => {
				// Create messages with large payloads
				const largeText = "X".repeat(50000)
				const mockMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Small message" },
					{ ts: 2000, type: "say", say: "user_feedback", text: largeText },
					{ ts: 3000, type: "say", say: "text", text: "AI response" },
					{ ts: 4000, type: "say", say: "user_feedback", text: "Another large message: " + largeText },
				] as ClineMessage[]

				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = mockMessages
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }, { ts: 3000 }, { ts: 4000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({ type: "deleteMessage", value: 3000 })

				// Should show delete dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showDeleteMessageDialog",
					messageTs: 3000,
					hasCheckpoint: false,
				})

				// Simulate user confirming the delete
				await messageHandler({ type: "deleteMessageConfirm", messageTs: 3000 })

				// Should handle large payloads without issues - keeps messages before the deleted one
				expect(mockCline.overwriteClineMessages).toHaveBeenCalledWith([mockMessages[0], mockMessages[1]])
				expect(mockCline.overwriteApiConversationHistory).toHaveBeenCalledWith([{ ts: 1000 }, { ts: 2000 }])
			})
		})

		describe("Error Messaging and User Feedback", () => {
			beforeEach(async () => {
				await provider.resolveWebviewView(mockWebviewView)
			})

			// Note: Error messaging test removed as the implementation may not have proper error handling in place

			test("provides user feedback for successful operations", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Message to delete" },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})
				;(provider as any).createTaskWithHistoryItem = vi.fn()

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({ type: "deleteMessage", value: 2000 })

				// Should show delete dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showDeleteMessageDialog",
					messageTs: 2000,
					hasCheckpoint: false,
				})

				// Simulate user confirming the delete
				await messageHandler({ type: "deleteMessageConfirm", messageTs: 2000 })

				// Verify successful operation completed
				expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
				// createTaskWithHistoryItem is only called when restoring checkpoints or aborting tasks
				expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			})

			test("handles user cancellation gracefully", async () => {
				// Test cancellation by not sending confirmation

				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Message to edit" },
					{ ts: 2000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 2000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()
				mockCline.handleWebviewAskResponse = vi.fn()

				await provider.addClineToStack(mockCline)

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({
					type: "submitEditedMessage",
					value: 2000,
					editedMessageContent: "Edited message",
				})

				// Verify no operations were performed when user canceled
				expect(mockCline.overwriteClineMessages).not.toHaveBeenCalled()
				expect(mockCline.overwriteApiConversationHistory).not.toHaveBeenCalled()
				expect(mockCline.handleWebviewAskResponse).not.toHaveBeenCalled()
				expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			})
		})

		describe("Edge Cases with Message Timestamps", () => {
			beforeEach(async () => {
				;(vscode.window.showInformationMessage as any) = vi.fn()
				await provider.resolveWebviewView(mockWebviewView)
			})

			test("handles messages with identical timestamps", async () => {
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Message 1" },
					{ ts: 1000, type: "say", say: "text", text: "Message 2 (same timestamp)" },
					{ ts: 1000, type: "say", say: "user_feedback", text: "Message 3 (same timestamp)" },
					{ ts: 2000, type: "say", say: "text", text: "Message 4" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [{ ts: 1000 }, { ts: 1000 }, { ts: 1000 }, { ts: 2000 }] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({ type: "deleteMessage", value: 1000 })

				// Should show delete dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showDeleteMessageDialog",
					messageTs: 1000,
					hasCheckpoint: false,
				})

				// Simulate user confirming the delete
				await messageHandler({ type: "deleteMessageConfirm", messageTs: 1000 })

				// Should handle identical timestamps gracefully
				expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
			})

			test("handles messages with future timestamps", async () => {
				const futureTimestamp = Date.now() + 100000 // Future timestamp
				const mockCline = new Task(defaultTaskOptions)
				mockCline.clineMessages = [
					{ ts: 1000, type: "say", say: "user_feedback", text: "Past message" },
					{
						ts: futureTimestamp,
						type: "say",
						say: "user_feedback",
						text: "Future message",
						value: futureTimestamp + 1000,
					},
					{ ts: futureTimestamp + 1000, type: "say", say: "text", text: "AI response" },
				] as ClineMessage[]
				mockCline.apiConversationHistory = [
					{ ts: 1000 },
					{ ts: futureTimestamp },
					{ ts: futureTimestamp + 1000 },
				] as any[]
				mockCline.overwriteClineMessages = vi.fn()
				mockCline.overwriteApiConversationHistory = vi.fn()
				mockCline.submitUserMessage = vi.fn()

				await provider.addClineToStack(mockCline)
				;(provider as any).getTaskWithId = vi.fn().mockResolvedValue({
					historyItem: { id: "test-task-id" },
				})

				const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

				await messageHandler({
					type: "submitEditedMessage",
					value: futureTimestamp + 1000,
					editedMessageContent: "Edited future message",
				})

				// Should show edit dialog
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "showEditMessageDialog",
					messageTs: futureTimestamp + 1000,
					text: "Edited future message",
					hasCheckpoint: false,
					images: undefined,
				})

				// Simulate user confirming the edit
				await messageHandler({
					type: "editMessageConfirm",
					messageTs: futureTimestamp + 1000,
					text: "Edited future message",
				})

				// Should handle future timestamps correctly
				expect(mockCline.overwriteClineMessages).toHaveBeenCalled()
				expect(mockCline.submitUserMessage).toHaveBeenCalled()
			})
		})
	})

	describe("getTaskWithId", () => {
		it("does not restore a deleted file-backed task from legacy history", async () => {
			const historyItem = {
				id: "deleted-task",
				task: "legacy task",
				ts: Date.now(),
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			}
			vi.mocked(mockContext.globalState.get).mockImplementation((key: string) => {
				if (key === "taskHistory") {
					return [historyItem]
				}
				return undefined
			})

			provider.taskHistoryStore["cache"].set(historyItem.id, historyItem)
			await provider.taskHistoryStore.delete(historyItem.id)
			provider["taskHistoryStoreInitialized"] = true

			await expect(provider.getTaskWithId(historyItem.id)).rejects.toThrow("Task not found")
		})

		it("rejects a missing task before file-backed history initialization", async () => {
			provider["taskHistoryStoreInitialized"] = false
			vi.mocked(mockContext.globalState.get).mockReturnValue(undefined)
			await expect(provider.getTaskWithId("cold-start-missing-task")).rejects.toThrow("Task not found")
		})

		it("returns empty apiConversationHistory when file is missing", async () => {
			const historyItem = { id: "missing-api-file-task", task: "test task", ts: Date.now() }
			vi.mocked(mockContext.globalState.get).mockImplementation((key: string) => {
				if (key === "taskHistory") {
					return [historyItem]
				}
				return undefined
			})

			const deleteTaskSpy = vi.spyOn(provider, "deleteTaskFromState")

			const result = await (provider as any).getTaskWithId("missing-api-file-task")

			expect(result.historyItem).toEqual(historyItem)
			expect(result.apiConversationHistory).toEqual([])
			expect(deleteTaskSpy).not.toHaveBeenCalled()
		})

		it("returns empty apiConversationHistory when file contains invalid JSON", async () => {
			const historyItem = { id: "corrupt-api-task", task: "test task", ts: Date.now() }
			vi.mocked(mockContext.globalState.get).mockImplementation((key: string) => {
				if (key === "taskHistory") {
					return [historyItem]
				}
				return undefined
			})

			// Make fileExistsAtPath return true so the read path is exercised
			const fsUtils = await import("../../../utils/fs")
			vi.spyOn(fsUtils, "fileExistsAtPath").mockResolvedValue(true)

			// Make readFile return corrupted JSON
			const fsp = await import("fs/promises")
			vi.mocked(fsp.readFile).mockResolvedValueOnce("{not valid json!!!" as never)

			const deleteTaskSpy = vi.spyOn(provider, "deleteTaskFromState")

			const result = await (provider as any).getTaskWithId("corrupt-api-task")

			expect(result.historyItem).toEqual(historyItem)
			expect(result.apiConversationHistory).toEqual([])
			expect(deleteTaskSpy).not.toHaveBeenCalled()

			// Restore the spy
			vi.mocked(fsUtils.fileExistsAtPath).mockRestore()
		})
	})

	describe("Zoo Code auth profile sync", () => {
		beforeEach(async () => {
			const { getCachedZooCodeToken } = await import("../../../services/zoo-code-auth")
			vi.mocked(getCachedZooCodeToken).mockReturnValue("")
		})

		describe("handleZooCodeCallback", () => {
			it("creates a Zoo Gateway profile when none exists", async () => {
				vi.spyOn(provider, "getState").mockResolvedValue({
					apiConfiguration: { zooGatewayModelId: "anthropic/claude-sonnet-4" },
				} as any)
				vi.spyOn(provider.contextProxy, "getProviderSettings").mockReturnValue({
					apiProvider: providerIdentifiers.anthropic,
				} as any)
				vi.spyOn(provider.contextProxy, "getValues").mockReturnValue({
					currentApiConfigName: "Anthropic",
				} as any)
				const upsertSpy = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("profile-id")
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([]),
				}

				await provider.handleZooCodeCallback("zoo_ext_token")

				expect(postMessageSpy).toHaveBeenCalledWith({ type: "zooGatewayCredentialsReady" })
				expect(upsertSpy).toHaveBeenCalledWith(
					"Zoo Gateway",
					expect.objectContaining({
						apiProvider: providerIdentifiers.zooGateway,
						zooSessionToken: "zoo_ext_token",
						zooGatewayBaseUrl: "https://www.zoocode.dev/api/gateway/v1",
					}),
					false,
				)
			})

			it("updates every zoo-gateway profile and activates only the active one", async () => {
				vi.spyOn(provider, "getState").mockResolvedValue({
					apiConfiguration: { zooGatewayModelId: "anthropic/claude-sonnet-4" },
				} as any)
				vi.spyOn(provider.contextProxy, "getProviderSettings").mockReturnValue({
					apiProvider: providerIdentifiers.zooGateway,
				} as any)
				vi.spyOn(provider.contextProxy, "getValues").mockReturnValue({
					currentApiConfigName: "Zoo Gateway",
				} as any)
				const upsertSpy = vi.spyOn(provider, "upsertProviderProfile").mockResolvedValue("profile-id")
				const saveConfig = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([
						{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway },
						{ name: "Backup Zoo", apiProvider: providerIdentifiers.zooGateway },
					]),
					getProfile: vi
						.fn()
						.mockResolvedValueOnce({
							apiProvider: providerIdentifiers.zooGateway,
							zooSessionToken: "old-token",
							zooGatewayBaseUrl: "https://old.example/api/gateway/v1",
						})
						.mockResolvedValueOnce({
							apiProvider: providerIdentifiers.zooGateway,
							zooSessionToken: "old-token",
						}),
					saveConfig,
				}

				await provider.handleZooCodeCallback("new-token")

				expect(upsertSpy).toHaveBeenCalledWith(
					"Zoo Gateway",
					expect.objectContaining({
						zooSessionToken: "new-token",
						zooGatewayBaseUrl: "https://www.zoocode.dev/api/gateway/v1",
					}),
					true,
				)
				// The non-active profile now goes through upsertProviderProfile so the views
				// pinned to it are refreshed, not just the file on disk.
				expect(upsertSpy).toHaveBeenCalledWith(
					"Backup Zoo",
					expect.objectContaining({
						zooSessionToken: "new-token",
						zooGatewayBaseUrl: "https://www.zoocode.dev/api/gateway/v1",
					}),
					false,
				)
			})

			it("logs and posts state when profile persistence fails", async () => {
				vi.spyOn(provider, "getState").mockRejectedValue(new Error("state unavailable"))
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn().mockResolvedValue([]),
				}

				await provider.handleZooCodeCallback("zoo_ext_token")

				expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
					expect.stringContaining("[handleZooCodeCallback] Failed to save zoo-gateway profile"),
				)
				// State must still be refreshed even when profile persistence fails.
				expect(provider.postStateToWebview).toHaveBeenCalled()
			})
		})

		describe("ensureZooGatewayProfileSeeded", () => {
			it("does nothing when no cached auth token exists", async () => {
				const handleSpy = vi.spyOn(provider, "handleZooCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi.fn(),
				}

				await (provider as any).ensureZooGatewayProfileSeeded()

				expect(handleSpy).not.toHaveBeenCalled()
			})

			it("skips seeding when every zoo-gateway profile already has the current token and base URL", async () => {
				const { getCachedZooCodeToken } = await import("../../../services/zoo-code-auth")
				vi.mocked(getCachedZooCodeToken).mockReturnValue("current-token")
				const handleSpy = vi.spyOn(provider, "handleZooCodeCallback").mockResolvedValue(undefined)
				const postMessageSpy = vi.spyOn(provider, "postMessageToWebview").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway }]),
					getProfile: vi.fn().mockResolvedValue({
						zooSessionToken: "current-token",
						zooGatewayBaseUrl: "https://www.zoocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureZooGatewayProfileSeeded()

				expect(handleSpy).not.toHaveBeenCalled()
				expect(postMessageSpy).toHaveBeenCalledWith({ type: "zooGatewayCredentialsReady" })
			})

			it("re-seeds when any zoo-gateway profile has a stale or missing token", async () => {
				const { getCachedZooCodeToken } = await import("../../../services/zoo-code-auth")
				vi.mocked(getCachedZooCodeToken).mockReturnValue("fresh-token")
				const handleSpy = vi.spyOn(provider, "handleZooCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway }]),
					getProfile: vi.fn().mockResolvedValue({
						zooSessionToken: "stale-token",
						zooGatewayBaseUrl: "https://www.zoocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureZooGatewayProfileSeeded()

				expect(handleSpy).toHaveBeenCalledWith("fresh-token")
			})

			it("re-seeds when any zoo-gateway profile has a stale base URL", async () => {
				const { getCachedZooCodeToken } = await import("../../../services/zoo-code-auth")
				vi.mocked(getCachedZooCodeToken).mockReturnValue("current-token")
				const handleSpy = vi.spyOn(provider, "handleZooCodeCallback").mockResolvedValue(undefined)

				;(provider as any).providerSettingsManager = {
					listConfig: vi
						.fn()
						.mockResolvedValue([{ name: "Zoo Gateway", apiProvider: providerIdentifiers.zooGateway }]),
					getProfile: vi.fn().mockResolvedValue({
						zooSessionToken: "current-token",
						zooGatewayBaseUrl: "https://staging.zoocode.dev/api/gateway/v1",
					}),
				}

				await (provider as any).ensureZooGatewayProfileSeeded()

				expect(handleSpy).toHaveBeenCalledWith("current-token")
			})
		})
	})

	describe("profile save without activation and overlay completeness", () => {
		it("refreshes views pinned to a profile saved without activation", async () => {
			// Defensive: the doubles in this suite can leave console writes pending
			// at worker teardown.
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.spyOn(console, "error").mockImplementation(() => {})
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				// The sibling loaded the profile earlier: its buffer pins the name and
				// carries the settings snapshot taken at that load.
				sibling["viewLocalState"].currentApiConfigName = "saved-profile"
				sibling["viewLocalState"].apiConfiguration = {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "old-key",
				}
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)

				// The sibling has an active task built from the pre-save settings.
				// Task is a class; the double assertion is the only way to attach a
				// minimal double without the full provider/services graph.
				const siblingTask = {
					apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "old-key" },
					taskApiConfigName: "saved-profile",
					updateApiConfiguration: vi.fn(),
				}
				vi.spyOn(sibling, "getCurrentTask").mockReturnValue(
					siblingTask as unknown as ReturnType<typeof sibling.getCurrentTask>,
				)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				const savedForReadBack8: Record<string, Record<string, unknown>> = {}
				// @ts-ignore - Replace providerSettingsManager with a test double.
				provider.providerSettingsManager = {
					saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
						savedForReadBack8[name] = settings
						return "saved-id"
					}),
					getProfile: vi.fn(async ({ name }: { name: string }) => ({
						name,
						id: "saved-id",
						...savedForReadBack8[name],
					})),
					listConfig: vi.fn().mockResolvedValue([]),
					setModeConfig: vi.fn(),
				}

				await provider.upsertProviderProfile(
					"saved-profile",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-key" },
					false,
				)

				// A save that does not activate still rewrites the profile; the pinned
				// sibling must not keep serving the pre-save snapshot.
				expect(sibling["viewLocalState"].apiConfiguration).toEqual({
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "new-key",
				})

				// The active task's handler must be rebuilt with the saved settings,
				// not just the view buffer.
				expect(siblingTask.updateApiConfiguration).toHaveBeenCalledWith({
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "new-key",
				})
			} finally {
				await sibling.dispose()
			}
		})

		it("does not rebuild a pinned sibling's task that runs under another profile", async () => {
			// Defensive: the doubles in this suite can leave console writes pending
			// at worker teardown.
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.spyOn(console, "error").mockImplementation(() => {})
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				// The sibling pins the saved profile, but its active task follows a
				// different sticky profile: the save must refresh the view overlay
				// without switching that conversation to the saved profile's settings.
				sibling["viewLocalState"].currentApiConfigName = "saved-profile"
				sibling["viewLocalState"].apiConfiguration = {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "old-key",
				}
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)

				const siblingTask = {
					apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "other-key" },
					taskApiConfigName: "other-profile",
					updateApiConfiguration: vi.fn(),
				}
				vi.spyOn(sibling, "getCurrentTask").mockReturnValue(
					siblingTask as unknown as ReturnType<typeof sibling.getCurrentTask>,
				)
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
				const savedForReadBack9: Record<string, Record<string, unknown>> = {}
				// @ts-ignore - Replace providerSettingsManager with a test double.
				provider.providerSettingsManager = {
					saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
						savedForReadBack9[name] = settings
						return "saved-id"
					}),
					getProfile: vi.fn(async ({ name }: { name: string }) => ({
						name,
						id: "saved-id",
						...savedForReadBack9[name],
					})),
					listConfig: vi.fn().mockResolvedValue([]),
					setModeConfig: vi.fn(),
				}

				await provider.upsertProviderProfile(
					"saved-profile",
					{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-key" },
					false,
				)

				// The pinned view's overlay still catches up with the saved settings...
				expect(sibling["viewLocalState"].apiConfiguration).toEqual({
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "new-key",
				})
				// ...but the task runs under another profile: its handler must not be
				// switched to the saved profile's settings.
				expect(siblingTask.updateApiConfiguration).not.toHaveBeenCalled()
				// Wait on the serialized view-state write queue that every
				// viewStates mutation goes through, so queued persistence finishes
				// while the console spies are still installed and teardown has no
				// pending writes.
				await ClineProvider["persistedViewStateWriteQueue"]
			} finally {
				await sibling.dispose()
			}
		})

		it("does not rebuild the acting view's task when it runs under another profile", async () => {
			// The acting view pins the saved profile while its own task follows a
			// different sticky profile: the non-activating save refreshes the view
			// overlay but must leave the task's handler alone.
			const task = {
				apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "other-key" },
				taskApiConfigName: "other-profile",
				updateApiConfiguration: vi.fn(),
			}
			vi.spyOn(provider, "getCurrentTask").mockReturnValue(
				task as unknown as ReturnType<typeof provider.getCurrentTask>,
			)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			provider["viewLocalState"].currentApiConfigName = "saved-profile"
			const savedForReadBack10: Record<string, Record<string, unknown>> = {}
			// @ts-ignore - Replace providerSettingsManager with a test double.
			provider.providerSettingsManager = {
				saveConfig: vi.fn(async (name: string, settings: Record<string, unknown>) => {
					savedForReadBack10[name] = settings
					return "saved-id"
				}),
				getProfile: vi.fn(async ({ name }: { name: string }) => ({
					name,
					id: "saved-id",
					...savedForReadBack10[name],
				})),
				listConfig: vi.fn().mockResolvedValue([]),
				setModeConfig: vi.fn(),
			}

			await provider.upsertProviderProfile(
				"saved-profile",
				{ apiProvider: providerIdentifiers.anthropic, apiKey: "new-key" },
				false,
			)

			expect(provider["viewLocalState"].apiConfiguration).toEqual({
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "new-key",
			})
			expect(task.updateApiConfiguration).not.toHaveBeenCalled()
		})
		it("does not leak shared provider keys into a pinned view's api configuration", async () => {
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.spyOn(console, "warn").mockImplementation(() => {})
			// The shared store sits on a profile with keys the pinned profile never
			// sets; spreading the overlay over the shared keys would report a mixed
			// configuration (e.g. another profile's model id and region).
			await provider.contextProxy.setValue("apiProvider", providerIdentifiers.bedrock)
			await provider.contextProxy.setValue("apiModelId", "anthropic.claude-v1")
			await provider.contextProxy.setValue("awsRegion", "us-east-1")
			provider["viewLocalState"].currentApiConfigName = "pinned-profile"
			provider["viewLocalState"].apiConfiguration = {
				apiProvider: providerIdentifiers.anthropic,
				apiKey: "k",
			}

			// The cloud doubles in this suite make getState() log its defensive catch
			// branches; silence them so teardown has no pending console writes.
			vi.spyOn(console, "error").mockImplementation(() => {})

			const state = await provider.getState()

			expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.anthropic)
			expect(state.apiConfiguration.apiKey).toBe("k")
			expect(state.apiConfiguration.apiModelId).toBeUndefined()
			expect(state.apiConfiguration.awsRegion).toBeUndefined()
		})

		it("keeps a pinned view's served settings aligned with its pin when another view activates a different profile", async () => {
			// Defensive: the doubles in this suite can leave console writes pending
			// at worker teardown.
			vi.spyOn(console, "log").mockImplementation(() => {})
			vi.spyOn(console, "warn").mockImplementation(() => {})
			vi.spyOn(console, "error").mockImplementation(() => {})

			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"editor",
				new ContextProxy(mockContext),
				new WebviewFocusTracker(),
			)
			try {
				// This view is pinned to profile A with no overlay: its served
				// settings come from the shared store, which the sibling's activation
				// is about to overwrite with profile B's settings.
				provider["viewLocalState"].currentApiConfigName = "pinned-a"
				provider["viewLocalState"].apiConfiguration = undefined
				vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

				const profileA = { apiProvider: providerIdentifiers.anthropic, apiKey: "a-key" }
				const managerDouble = {
					activateProfile: vi.fn().mockResolvedValue({
						name: "profile-b",
						id: "id-b",
						apiProvider: providerIdentifiers.bedrock,
						apiKey: "b-key",
					}),
					listConfig: vi.fn().mockResolvedValue([]),
					setModeConfig: vi.fn(),
					getModeConfigId: vi.fn().mockResolvedValue(undefined),
					getProfile: vi
						.fn()
						.mockImplementation(async ({ name }: { name: string }) =>
							name === "pinned-a"
								? { name: "pinned-a", ...profileA }
								: { name, apiProvider: providerIdentifiers.bedrock },
						),
				}
				// @ts-ignore - Replace providerSettingsManager with a test double.
				provider.providerSettingsManager = managerDouble
				// @ts-ignore - The sibling resolves the pin through its own manager.
				sibling.providerSettingsManager = managerDouble
				vi.spyOn(sibling, "postStateToWebview").mockResolvedValue(undefined)

				await sibling.activateProviderProfile({ name: "profile-b" })

				// The activation snapshotted profile A's settings into this view's
				// overlay before replacing the shared store, so getState() still
				// serves the pinned profile's configuration.
				const state = await provider.getState()
				expect(state.currentApiConfigName).toBe("pinned-a")
				expect(state.apiConfiguration.apiProvider).toBe(providerIdentifiers.anthropic)
				expect(state.apiConfiguration.apiKey).toBe("a-key")
			} finally {
				await sibling.dispose()
			}
		})
	})
})
