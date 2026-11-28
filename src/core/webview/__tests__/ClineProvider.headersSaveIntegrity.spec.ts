// pnpm --filter roo-cline test src/core/webview/__tests__/ClineProvider.headersSaveIntegrity.spec.ts
//
// Persistence-integrity fault injection for the webview Save path of provider profile
// headers (issue #2770). Save posts `upsertApiConfiguration`, which runs through
// `upsertProviderProfile` -> `ProviderSettingsManager.saveConfig` -> `secrets.store`.
// Each test injects a deterministic interruption or rollback failure around that path
// and asserts that no partial or stale header state is ever persisted, and that
// recovery restores the correct headers.

import { vi } from "vitest"

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
	McpError: class McpError extends Error {},
}))

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

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => delayFn
	delayFn.range = () => delayFn
	return { default: delayFn }
})

vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	return {
		...actual,
		ExtensionContext: vi.fn(),
		OutputChannel: vi.fn(),
		WebviewView: vi.fn(),
		Disposable: { from: vi.fn() },
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
			onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
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
	}
})

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
		getAccessToken: vi.fn().mockResolvedValue(undefined),
		getAccountId: vi.fn(),
	},
}))

vi.mock("../../../integrations/openai-codex/rate-limits", () => ({
	fetchOpenAiCodexRateLimitInfo: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
		}
	}),
}))

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
	extractTextFromFile: vi.fn().mockResolvedValue([]),
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
	getCachedZooCodeToken: vi.fn().mockResolvedValue(undefined),
	handleAuthCallback: vi.fn(),
	setZooCodeUserInfo: vi.fn(),
	disconnectZooCode: vi.fn(),
}))

vi.mock("../../../shared/modes", () => ({
	modes: [
		{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", groups: ["read", "edit"] },
		{ slug: "architect", name: "Architect Mode", roleDefinition: "You are an architect", groups: ["read", "edit"] },
		{ slug: "ask", name: "Ask Mode", roleDefinition: "You are a helpful assistant", groups: ["read"] },
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockReturnValue("General Tools"),
	defaultModeSlug: "code",
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

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

import * as vscode from "vscode"

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ContextProxy } from "../../config/ContextProxy"
import { ProviderSettingsManager } from "../../config/ProviderSettingsManager"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { ClineProvider } from "../ClineProvider"
import type { TaskOptions } from "../../task/Task"

const SECRETS_KEY = "roo_cline_config_api_config"

const seededProfile = (openAiHeaders: Record<string, string>) => ({
	currentApiConfigName: "current-config",
	apiConfigs: {
		"current-config": {
			id: "seed-id",
			apiProvider: providerIdentifiers.openai,
			openAiBaseUrl: "https://seed.example/v1",
			openAiHeaders,
		},
	},
	modeApiConfigs: { code: "seed-id", architect: "seed-id", ask: "seed-id" },
	migrations: {
		rateLimitSecondsMigrated: true,
		openAiHeadersMigrated: true,
		consecutiveMistakeLimitMigrated: true,
		toolRepetitionLimitsMigrated: true,
		todoListEnabledMigrated: true,
		claudeCodeLegacySettingsMigrated: true,
		routerProviderMigrated: true,
	},
})

describe("ClineProvider header save integrity (issue #2770)", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: ReturnType<typeof vi.fn>
	let onDidReceiveMessage: ReturnType<typeof vi.fn>
	let secrets: Record<string, string>
	let messageHandler: (message: unknown) => Promise<void>

	const storedProfiles = () => JSON.parse(secrets[SECRETS_KEY]).apiConfigs["current-config"]

	const saveHeaders = (openAiHeaders: Record<string, string>) =>
		messageHandler({
			type: "upsertApiConfiguration",
			text: "current-config",
			apiConfiguration: {
				apiProvider: providerIdentifiers.openai,
				openAiBaseUrl: "https://seed.example/v1",
				openAiHeaders,
			} as ProviderSettings,
		})

	beforeEach(async () => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		secrets = { [SECRETS_KEY]: JSON.stringify(seededProfile({ "X-Keep": "old" })) }

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "current-config",
		}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: { fsPath: "/test/path" } as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (globalState[key] = value)
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
					return (secrets[key] = value as string)
				}),
				delete: vi.fn().mockImplementation((key: string) => delete secrets[key]),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: { packageJSON: { version: "1.0.0" } },
			globalStorageUri: { fsPath: "/test/storage/path" },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			show: vi.fn(),
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()
		onDidReceiveMessage = vi.fn()

		// The double cast lists the members this harness uses; the full WebviewView
		// shape is not needed for the save-path tests.
		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage,
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			show: vi.fn(),
			onDidDispose: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
			onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		} as unknown as vscode.WebviewView

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)
		provider["initialModeConfigIds"] = Promise.resolve({})
		;(provider as unknown as { customModesManager: unknown }).customModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
			getCustomModes: vi.fn().mockResolvedValue([]),
			dispose: vi.fn(),
		}
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue({ contents: [] }),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})

		await provider.resolveWebviewView(mockWebviewView)
		messageHandler = vi.mocked(onDidReceiveMessage).mock.calls[0][0]
	})

	afterAll(() => {
		vi.restoreAllMocks()
	})

	test("a rollback failure on the profile write leaves the stored headers intact, and recovery persists the new ones", async () => {
		// Fault: the very next secrets write fails (deterministic message-send/persist failure).
		vi.mocked(mockContext.secrets.store).mockImplementationOnce((_key: string) =>
			Promise.reject(new Error("EIO: write failed")),
		)

		await saveHeaders({ "X-New": "fresh" })

		// The failure is surfaced to the user, not swallowed.
		expect(vscode.window.showErrorMessage).toHaveBeenCalled()

		// No partial or stale state was persisted: the stored headers are still the seeded ones.
		expect(storedProfiles().openAiHeaders).toEqual({ "X-Keep": "old" })
		expect(storedProfiles().id).toBe("seed-id")

		// Recovery: the same save succeeds once the fault clears (the one-shot fault is spent).
		await saveHeaders({ "X-New": "fresh" })

		const manager = new ProviderSettingsManager(mockContext)
		const profile = await manager.getProfile({ name: "current-config" })
		expect(profile.openAiHeaders).toEqual({ "X-New": "fresh" })
	}, 20000)

	test("a save interrupted mid-write cannot lose a later save's headers", async () => {
		// Fault: the first profile write hangs (deterministic interruption), while a second
		// save with different headers is issued right away.
		let releaseFirstWrite: (() => void) | undefined
		const storeCalls = vi.mocked(mockContext.secrets.store).mockImplementationOnce(
			(key: string, value: string) =>
				new Promise<void>((resolve) => {
					releaseFirstWrite = () => {
						secrets[key] = value
						resolve()
					}
				}),
		)

		const slowSave = saveHeaders({ "X-Slow": "a" })
		const fastSave = saveHeaders({ "X-Fast": "b" })

		// Wait until the interrupted write is in flight.
		await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined())

		// While the first write is in flight, the stored blob still holds the seeded headers.
		expect(storedProfiles().openAiHeaders).toEqual({ "X-Keep": "old" })

		// The interrupted write eventually lands, and the queued save then runs after it:
		// the lock serializes both writes, so the later save wins.
		releaseFirstWrite?.()
		await Promise.all([slowSave, fastSave])

		const manager = new ProviderSettingsManager(mockContext)
		const profile = await manager.getProfile({ name: "current-config" })
		expect(profile.openAiHeaders).toEqual({ "X-Fast": "b" })

		expect(storeCalls.mock.calls.length).toBeGreaterThanOrEqual(2)
	}, 20000)

	test("a webview notification failure after a save does not lose the saved headers", async () => {
		// Fault: the post-save state push fails.
		mockPostMessage.mockRejectedValue(new Error("webview is gone"))

		await saveHeaders({ "X-Kept": "saved" })

		// The save already reached storage; the notification failure only surfaces an error.
		const manager = new ProviderSettingsManager(mockContext)
		const profile = await manager.getProfile({ name: "current-config" })
		expect(profile.openAiHeaders).toEqual({ "X-Kept": "saved" })
	}, 20000)

	test("a clean save persists the headers exactly as sent, including a removal to none", async () => {
		await saveHeaders({ "X-Edit": "edited" })
		expect(storedProfiles().openAiHeaders).toEqual({ "X-Edit": "edited" })

		await saveHeaders({})
		expect(storedProfiles().openAiHeaders).toEqual({})
	}, 20000)
})
