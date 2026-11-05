import { WebviewFocusTracker } from "../WebviewFocusTracker"
// npx vitest run core/webview/__tests__/ClineProvider.sticky-profile.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { ClineProvider } from "../ClineProvider"
import type { Task } from "../../task/Task"
import { ContextProxy } from "../../config/ContextProxy"
import type { HistoryItem } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Disposable: { from: (...subscriptions: vscode.Disposable[]) => makeCompositeDisposable(...subscriptions) },
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
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

// Create a counter for unique task IDs.
let taskIdCounter = 0

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options) {
		return {
			taskId: options.taskId || `test-task-id-${++taskIdCounter}`,
			saveClineMessages: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			getTaskNumber: vi.fn().mockReturnValue(0),
			setTaskNumber: vi.fn(),
			setParentTask: vi.fn(),
			setRootTask: vi.fn(),
			emit: vi.fn(),
			parentTask: options.parentTask,
			updateApiConfiguration: vi.fn(),
			setTaskApiConfigName: vi.fn(),
			_taskApiConfigName: options.historyItem?.apiConfigName,
			taskApiConfigName: options.historyItem?.apiConfigName,
		}
	}),
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../utils/safeWriteJson")

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return {
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
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://app.roocode.com"),
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
	],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => {
			return defaultPath
		}),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
			}
		},
	},
}))

describe("ClineProvider - Sticky Provider Profile", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: any
	let originalRooCliRuntimeEnv: string | undefined

	beforeEach(async () => {
		vi.clearAllMocks()
		taskIdCounter = 0
		originalRooCliRuntimeEnv = process.env.ROO_CLI_RUNTIME
		delete process.env.ROO_CLI_RUNTIME

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, string | undefined> = {
			mode: "code",
			currentApiConfigName: "default-profile",
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
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => {
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
			onDidDispose: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		} as unknown as vscode.WebviewView

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		// Wait for the async TaskHistoryStore initialization to complete
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Mock getMcpHub method
		provider.getMcpHub = vi.fn().mockReturnValue({
			listTools: vi.fn().mockResolvedValue([]),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
			listResources: vi.fn().mockResolvedValue([]),
			readResource: vi.fn().mockResolvedValue({ contents: [] }),
			getAllServers: vi.fn().mockReturnValue([]),
		})
	})

	afterEach(() => {
		if (originalRooCliRuntimeEnv === undefined) {
			delete process.env.ROO_CLI_RUNTIME
		} else {
			process.env.ROO_CLI_RUNTIME = originalRooCliRuntimeEnv
		}
	})

	describe("activateProviderProfile", () => {
		beforeEach(async () => {
			await provider.resolveWebviewView(mockWebviewView)
		})

		it("should save provider profile to task metadata when switching profiles", async () => {
			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to track calls
			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task history was updated with new provider profile
			expect(updateTaskHistorySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					id: mockTask.taskId,
					apiConfigName: "new-profile",
				}),
			)

			// Verify task's setTaskApiConfigName was called
			expect(mockTask.setTaskApiConfigName).toHaveBeenCalledWith("new-profile")
		})

		it.each([
			{ expectedCurrentTaskId: "test-task-id", applies: true },
			{ expectedCurrentTaskId: "other-task-id", applies: false },
		])(
			"expectedCurrentTaskId $expectedCurrentTaskId rebuilds and sticky-writes the current task: $applies",
			async ({ expectedCurrentTaskId, applies }) => {
				const currentTask = {
					taskId: "test-task-id",
					setTaskApiConfigName: vi.fn<(name: string) => void>(),
					updateApiConfiguration: vi.fn<(settings: unknown) => void>(),
					emit: vi.fn(),
				}
				// Supplies only the members that profile activation touches on the current task.
				vi.spyOn(provider, "getCurrentTask").mockReturnValue(currentTask as unknown as Task)
				await provider.taskHistoryStore.upsert({
					id: currentTask.taskId,
					ts: Date.now(),
					task: "Test task",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				})
				const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
					name: "new-profile",
					id: "new-profile-id",
					apiProvider: providerIdentifiers.anthropic,
				})

				await provider.activateProviderProfile({ name: "new-profile" }, { expectedCurrentTaskId })

				expect(currentTask.updateApiConfiguration).toHaveBeenCalledTimes(applies ? 1 : 0)
				expect(currentTask.setTaskApiConfigName).toHaveBeenCalledTimes(applies ? 1 : 0)
				const stickyWrite = expect.objectContaining({ id: currentTask.taskId, apiConfigName: "new-profile" })
				if (applies) {
					expect(updateTaskHistorySpy).toHaveBeenCalledWith(stickyWrite)
				} else {
					expect(updateTaskHistorySpy).not.toHaveBeenCalled()
				}
			},
		)

		it.each([true, false])(
			"writes the mode default only when persistModeConfig is %s",
			async (persistModeConfig) => {
				vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
					name: "new-profile",
					id: "new-profile-id",
					apiProvider: providerIdentifiers.anthropic,
				})
				const setModeConfigSpy = vi.spyOn(provider.providerSettingsManager, "setModeConfig").mockResolvedValue()
				await provider.contextProxy.setValue("mode", "architect")

				await provider.activateProviderProfile(
					{ name: "new-profile" },
					{ persistModeConfig, expectedCurrentTaskId: "test-task-id" },
				)

				if (persistModeConfig) {
					expect(setModeConfigSpy).toHaveBeenCalledExactlyOnceWith("architect", "new-profile-id")
				} else {
					expect(setModeConfigSpy).not.toHaveBeenCalled()
				}
			},
		)

		it("should update task's taskApiConfigName property when switching profiles", async () => {
			// Create a mock task with initial profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Mock getGlobalState to return task history
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([
				{
					id: mockTask.taskId,
					ts: Date.now(),
					task: "Test task",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
				},
			])

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.openrouter,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			// Switch provider profile
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify task's _taskApiConfigName property was updated
			expect(mockTask._taskApiConfigName).toBe("new-profile")
		})

		it("should update in-memory task profile even if task history item does not exist yet", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			await provider.addClineToStack(mockTask as any)

			// No history item exists yet
			vi.spyOn(provider as any, "getGlobalState").mockReturnValue([])

			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockImplementation(() => {
				return Promise.resolve([])
			})

			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.openrouter,
			})

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.openrouter },
			])

			await provider.activateProviderProfile({ name: "new-profile" })

			// In-memory should still update, even without a history item.
			expect(mockTask._taskApiConfigName).toBe("new-profile")
			// No history item => no updateTaskHistory call.
			expect(updateTaskHistorySpy).not.toHaveBeenCalled()
		})
	})

	describe("createTaskWithHistoryItem", () => {
		it("should restore provider profile from history item when reopening task outside CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
				apiConfigName: "saved-profile", // Saved provider profile
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify provider profile was restored via activateProviderProfile (restore-only: don't persist mode config)
			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "saved-profile" },
				{ persistModeConfig: false, persistTaskHistory: false, expectedCurrentTaskId: historyItem.id },
			)
		})

		it("should not restore an empty task apiConfigName profile from history", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "ask",
				apiConfigName: "default",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "default", id: "default-id" },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()
		})

		it("should skip restoring task apiConfigName from history in CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "saved-profile",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)
			const logSpy = vi.spyOn(provider, "log")

			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "saved-profile", id: "saved-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: "saved-profile" }, expect.anything())
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Skipping restore of provider profile 'saved-profile'"),
			)
		})

		it("should skip restoring mode-based provider config from history in CLI runtime", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			process.env.ROO_CLI_RUNTIME = "1"

			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "code",
			}

			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
			])

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).not.toHaveBeenCalled()
		})

		it("restores the mode-based profile without persisting it as a mode default or touching another task", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				mode: "code",
			}
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
			])
			vi.spyOn(provider.providerSettingsManager, "getProfile").mockResolvedValue({
				name: "mode-profile",
				id: "mode-config-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			await provider.createTaskWithHistoryItem(historyItem)

			expect(activateProviderProfileSpy).toHaveBeenCalledWith(
				{ name: "mode-profile" },
				{ persistModeConfig: false, expectedCurrentTaskId: historyItem.id },
			)
		})

		it("should use current profile if history item has no saved apiConfigName", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item without saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				// No apiConfigName field
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify activateProviderProfile was NOT called for apiConfigName restoration
			// (it might be called for mode-based config, but not for direct apiConfigName)
			const callsForApiConfigName = activateProviderProfileSpy.mock.calls.filter(
				(call) => call[0] && "name" in call[0] && call[0].name === historyItem.apiConfigName,
			)
			expect(callsForApiConfigName.length).toBe(0)
		})

		it("should override mode-based config with task's apiConfigName", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with both mode and apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				mode: "architect", // Mode has a different preferred profile
				apiConfigName: "task-specific-profile", // Task's actual profile
			}

			// Track all activateProviderProfile calls
			const activateCalls: string[] = []
			vi.spyOn(provider, "activateProviderProfile").mockImplementation(async (args) => {
				if ("name" in args) {
					activateCalls.push(args.name)
				}
			})

			// Mock providerSettingsManager methods
			vi.spyOn(provider.providerSettingsManager, "getModeConfigId").mockResolvedValue("mode-config-id")
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "mode-preferred-profile", id: "mode-config-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "task-specific-profile", id: "task-profile-id", apiProvider: providerIdentifiers.openai },
			])

			// Initialize task with history item
			await provider.createTaskWithHistoryItem(historyItem)

			// Verify task's apiConfigName was activated LAST (overriding mode-based config)
			expect(activateCalls[activateCalls.length - 1]).toBe("task-specific-profile")
		})

		it("should handle missing provider profile gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with a provider profile that no longer exists
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "deleted-profile", // Profile that doesn't exist
			}

			// Mock providerSettingsManager.listConfig to return empty (profile doesn't exist)
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([])

			// Mock log to verify warning is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify a warning was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Provider profile 'deleted-profile' from history no longer exists"),
			)
		})
	})

	describe("Task metadata persistence", () => {
		it("should include apiConfigName in task metadata when saving", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task with provider profile
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "test-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Populate the store so persistStickyProviderProfileToCurrentTask finds the task
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to capture the updated history item
			let updatedHistoryItem: any
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				updatedHistoryItem = item
				return Promise.resolve([item])
			})

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Trigger a profile switch
			await provider.activateProviderProfile({ name: "new-profile" })

			// Verify apiConfigName was included in the updated history item
			expect(updatedHistoryItem).toBeDefined()
			expect(updatedHistoryItem.apiConfigName).toBe("new-profile")
		})
	})

	describe("Multiple workspaces isolation", () => {
		it("should preserve task profile when switching profiles in another workspace", async () => {
			// This test verifies that each task retains its designated provider profile
			// so that switching profiles in one workspace doesn't alter other tasks

			await provider.resolveWebviewView(mockWebviewView)

			// Create task 1 with profile A
			const task1 = {
				taskId: "task-1",
				_taskApiConfigName: "profile-a",
				setTaskApiConfigName: vi.fn().mockImplementation(function (this: any, name: string) {
					this._taskApiConfigName = name
				}),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task 1 to stack
			await provider.addClineToStack(task1 as any)

			// Mock getGlobalState to return task history for both tasks
			const taskHistory = [
				{
					id: "task-1",
					ts: Date.now(),
					task: "Task 1",
					number: 1,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-a",
				},
				{
					id: "task-2",
					ts: Date.now(),
					task: "Task 2",
					number: 2,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0,
					apiConfigName: "profile-b",
				},
			]

			// Populate the store
			for (const item of taskHistory) {
				await provider.taskHistoryStore.upsert(item as any)
			}

			// Mock updateTaskHistory
			vi.spyOn(provider, "updateTaskHistory").mockImplementation((item) => {
				const index = taskHistory.findIndex((h) => h.id === item.id)
				if (index >= 0) {
					taskHistory[index] = { ...taskHistory[index], ...item }
				}
				return Promise.resolve(taskHistory)
			})

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "profile-c",
				id: "profile-c-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "profile-a", id: "profile-a-id", apiProvider: providerIdentifiers.anthropic },
				{ name: "profile-b", id: "profile-b-id", apiProvider: providerIdentifiers.openai },
				{ name: "profile-c", id: "profile-c-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Switch task 1's profile to profile C
			await provider.activateProviderProfile({ name: "profile-c" })

			// Verify task 1's profile was updated
			expect(task1._taskApiConfigName).toBe("profile-c")
			expect(taskHistory[0].apiConfigName).toBe("profile-c")

			// Verify task 2's profile remains unchanged
			expect(taskHistory[1].apiConfigName).toBe("profile-b")
		})
	})

	describe("Error handling", () => {
		it("should handle errors gracefully when saving profile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a mock task
			const mockTask = {
				taskId: "test-task-id",
				_taskApiConfigName: "default-profile",
				setTaskApiConfigName: vi.fn(),
				emit: vi.fn(),
				saveClineMessages: vi.fn(),
				clineMessages: [],
				apiConversationHistory: [],
				updateApiConfiguration: vi.fn(),
			}

			// Add task to provider stack
			await provider.addClineToStack(mockTask as any)

			// Populate the store
			await provider.taskHistoryStore.upsert({
				id: mockTask.taskId,
				ts: Date.now(),
				task: "Test task",
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})

			// Mock updateTaskHistory to throw error
			vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("Save failed"))

			// Mock providerSettingsManager.activateProfile
			vi.spyOn(provider.providerSettingsManager, "activateProfile").mockResolvedValue({
				name: "new-profile",
				id: "new-profile-id",
				apiProvider: providerIdentifiers.anthropic,
			})

			// Mock providerSettingsManager.listConfig
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "new-profile", id: "new-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Switch provider profile - should not throw
			await expect(provider.activateProviderProfile({ name: "new-profile" })).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist provider profile switch"))
		})

		it("should handle null/undefined apiConfigName gracefully", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with null apiConfigName
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: null as any, // Invalid apiConfigName
			}

			// Mock activateProviderProfile to track calls
			const activateProviderProfileSpy = vi
				.spyOn(provider, "activateProviderProfile")
				.mockResolvedValue(undefined)

			// Initialize task with history item - should not throw
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify activateProviderProfile was not called with null
			expect(activateProviderProfileSpy).not.toHaveBeenCalledWith({ name: null })
		})
	})

	describe("Profile restoration with activateProfile failure", () => {
		it("should continue task restoration even if activateProviderProfile fails", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Create a history item with saved provider profile
			const historyItem: HistoryItem = {
				id: "test-task-id",
				number: 1,
				ts: Date.now(),
				task: "Test task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
				apiConfigName: "failing-profile",
			}

			// Mock providerSettingsManager.listConfig to return the profile
			vi.spyOn(provider.providerSettingsManager, "listConfig").mockResolvedValue([
				{ name: "failing-profile", id: "failing-profile-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Mock activateProviderProfile to throw error
			vi.spyOn(provider, "activateProviderProfile").mockRejectedValue(new Error("Activation failed"))

			// Mock log to verify error is logged
			const logSpy = vi.spyOn(provider, "log")

			// Initialize task with history item - should not throw even though activation fails
			await expect(provider.createTaskWithHistoryItem(historyItem)).resolves.not.toThrow()

			// Verify error was logged
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to restore API configuration 'failing-profile' for task"),
			)
		})
	})

	describe("deleteProviderProfile", () => {
		it("removes the stored profile so a dangling mode mapping can no longer re-activate it", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Seed the stored profile settings: the default profile plus a child
			// profile (mirroring the cross-profile subtasks e2e scenario), with the
			// "ask" mode mapped to the child profile.
			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			const childId = await provider.providerSettingsManager.saveConfig("subtask-child-profile", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			await provider.providerSettingsManager.setModeConfig("ask", childId)

			// The UI-facing list mirrors the store, as maintained by upsert/activate.
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "subtask-child-profile", id: childId, apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "subtask-child-profile",
			})

			await provider.deleteProviderProfile({
				name: "subtask-child-profile",
				id: childId,
				apiProvider: providerIdentifiers.openrouter,
			})

			// The deleted profile's settings are gone from the manager store.
			const remaining = await provider.providerSettingsManager.listConfig()
			expect(remaining.some((config) => config.name === "subtask-child-profile")).toBe(false)
			await expect(
				provider.providerSettingsManager.getProfile({ name: "subtask-child-profile" }),
			).rejects.toThrow(/subtask-child-profile.*not found/)

			// The mode mapping still points at the deleted id, but it no longer
			// resolves to a stored profile, so handleModeSwitch falls through to the
			// current configuration instead of re-activating the deleted profile.
			const savedConfigId = await provider.providerSettingsManager.getModeConfigId("ask")
			expect(savedConfigId).toBe(childId)
			expect(remaining.find(({ id }) => id === savedConfigId)).toBeUndefined()

			// The deletion alone must have repointed the context at the surviving profile. Assert that
			// before driving any further public path: a later mode switch that happens to repair the
			// selection would otherwise mask a deletion that left currentApiConfigName on the profile
			// it just removed.
			const afterDeletion = provider.contextProxy.getValues()
			expect(afterDeletion.currentApiConfigName).toBe("default")
			expect(afterDeletion.listApiConfigMeta?.map((entry) => entry.name)).toEqual(["default"])

			// Drive the public path the comment above describes instead of asserting only the
			// mapping: switching to the mode that was pinned to the deleted profile must fall
			// through to the surviving profile, not re-activate the deleted one.
			await provider.handleModeSwitch("ask")
			const afterSwitch = provider.contextProxy.getValues()
			expect(afterSwitch.currentApiConfigName).toBe("default")
			expect(afterSwitch.listApiConfigMeta?.map((entry) => entry.name)).toEqual(["default"])
		})

		it("treats an already-gone secret as success so the stale list entry is still pruned", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			// Only the default profile exists in the store: the ghost profile's secret
			// was already gone (e.g. pruned by an earlier run) but its list entry
			// survived.
			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "ghost-profile", id: "ghost-id", apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "ghost-profile",
			})

			// The manager's "not found" rejection must not surface to the caller ...
			await expect(
				provider.deleteProviderProfile({
					name: "ghost-profile",
					id: "ghost-id",
					apiProvider: providerIdentifiers.openrouter,
				}),
			).resolves.not.toThrow()

			// ... it prunes the stale list entry and repoints the selection.
			const values = provider.contextProxy.getValues()
			expect(values.currentApiConfigName).toBe("default")
			expect(values.listApiConfigMeta?.map((entry) => entry.name)).toEqual(["default"])
		})

		it("still refuses to delete the last stored profile when a stale list entry remains", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			// A ghost list entry survives next to the only real profile, so the
			// provider-level "last profile" guard does not fire: the refusal must come
			// from the settings store itself.
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "ghost-profile", id: "ghost-id", apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "default",
			})

			await expect(
				provider.deleteProviderProfile({
					name: "default",
					id: defaultId,
					apiProvider: providerIdentifiers.openrouter,
				}),
			).rejects.toThrow("Cannot delete the last remaining configuration")

			// The refusal must leave the stored record alone. The message, the selection, and the
			// list all stay the same when a regression deletes the record first and then throws
			// this exact error, so the store has to be read directly.
			await expect(provider.providerSettingsManager.getProfile({ name: "default" })).resolves.toBeDefined()
			expect((await provider.providerSettingsManager.listConfig()).map(({ name }) => name)).toEqual(["default"])

			// Nothing was repointed or pruned.
			const values = provider.contextProxy.getValues()
			expect(values.currentApiConfigName).toBe("default")
			expect(values.listApiConfigMeta?.map((entry) => entry.name)).toEqual(["default", "ghost-profile"])
		})

		it("re-points the selection when a sibling view activates the deleted profile mid-deletion", async () => {
			await provider.resolveWebviewView(mockWebviewView)

			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			const childId = await provider.providerSettingsManager.saveConfig("subtask-child-profile", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "subtask-child-profile", id: childId, apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "default",
			})

			// A second view activates the profile this deletion is about to remove while the deletion is
			// in flight. Both views share the extension host's ContextProxy, so from the moment the
			// record is gone the shared selection genuinely names the deleted profile - the deletion has
			// to notice that instead of trusting what it read at entry.
			const manager = provider.providerSettingsManager
			const deleteStoredConfig = manager.deleteConfig.bind(manager)
			manager.deleteConfig = async (name: string) => {
				await provider.contextProxy.setValue("currentApiConfigName", "subtask-child-profile")
				return deleteStoredConfig(name)
			}

			await provider.deleteProviderProfile({
				name: "subtask-child-profile",
				id: childId,
				apiProvider: providerIdentifiers.openrouter,
			})

			const values = provider.contextProxy.getValues()
			expect(values.currentApiConfigName).toBe("default")
			// The shared provider keys still carried the deleted profile's settings when the selection
			// moved onto it, so they must be replaced with the profile the selection now names.
			expect(provider.contextProxy.getProviderSettings().openRouterModelId).toBe("openai/gpt-4.1")
		})

		it("follows a selection a sibling view moved onto another survivor mid-deletion", async () => {
			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			const otherId = await provider.providerSettingsManager.saveConfig("other-survivor", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4o",
			})
			const childId = await provider.providerSettingsManager.saveConfig("subtask-child-profile", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "other-survivor", id: otherId, apiProvider: providerIdentifiers.openrouter },
					{ name: "subtask-child-profile", id: childId, apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "subtask-child-profile",
			})

			await provider.resolveWebviewView(mockWebviewView)

			// This deletion selects the first survivor at entry, because that is what the shared
			// selection names then. A sibling view moves the selection onto a different survivor while
			// the record delete is in flight; that choice is the user's, and the deletion must follow it
			// instead of pushing the selection back onto its own pick.
			const manager = provider.providerSettingsManager
			const deleteStoredConfig = manager.deleteConfig.bind(manager)
			manager.deleteConfig = async (name: string) => {
				await provider.contextProxy.setValue("currentApiConfigName", "other-survivor")
				return deleteStoredConfig(name)
			}

			await provider.deleteProviderProfile({
				name: "subtask-child-profile",
				id: childId,
				apiProvider: providerIdentifiers.openrouter,
			})

			const values = provider.contextProxy.getValues()
			expect(values.currentApiConfigName).toBe("other-survivor")
			expect(values.listApiConfigMeta?.map((entry) => entry.name)).toEqual(["default", "other-survivor"])
		})

		it("leaves a sibling view's shared settings on the survivor it activated mid-deletion", async () => {
			const defaultId = await provider.providerSettingsManager.saveConfig("default", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1",
			})
			const otherId = await provider.providerSettingsManager.saveConfig("other-survivor", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4o",
			})
			const childId = await provider.providerSettingsManager.saveConfig("subtask-child-profile", {
				apiProvider: providerIdentifiers.openrouter,
				openRouterApiKey: "mock-key",
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			await provider.contextProxy.setValues({
				listApiConfigMeta: [
					{ name: "default", id: defaultId, apiProvider: providerIdentifiers.openrouter },
					{ name: "other-survivor", id: otherId, apiProvider: providerIdentifiers.openrouter },
					{ name: "subtask-child-profile", id: childId, apiProvider: providerIdentifiers.openrouter },
				],
				currentApiConfigName: "subtask-child-profile",
			})
			await provider.resolveWebviewView(mockWebviewView)

			// The cross-view half of this deletion is only observable from another view: the deletion names
			// the survivor in the shared store, but whether the survivor's settings actually land in a second
			// view's provider keys is a property of that view. Production builds the tab view on the same
			// ContextProxy as the sidebar view (activate/registerCommands.ts:449 passes the sidebar's
			// contextProxy; ClineProvider.ts:3634 documents that the two views share it while their queues
			// and settings-manager locks stay per instance), so the sibling here shares provider.contextProxy
			// and keeps its own settings-manager, which is exactly the shape that lets it move the selection
			// mid-deletion.
			// resolved webview.
			const siblingView = {
				webview: {
					postMessage: vi.fn(),
					html: "",
					options: {},
					onDidReceiveMessage: vi.fn(),
					asWebviewUri: vi.fn(),
					cspSource: "vscode-webview://sibling-csp-source",
				},
				visible: true,
				onDidDispose: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
				onDidChangeVisibility: vi.fn().mockImplementation(() => {
					return { dispose: vi.fn() }
				}),
			} as unknown as vscode.WebviewView
			const sibling = new ClineProvider(
				mockContext,
				mockOutputChannel,
				"sidebar",
				provider.contextProxy,
				new WebviewFocusTracker(),
			)
			await new Promise((resolve) => setTimeout(resolve, 10))
			sibling.getMcpHub = vi.fn().mockReturnValue({
				listTools: vi.fn().mockResolvedValue([]),
				callTool: vi.fn().mockResolvedValue({ content: [] }),
				listResources: vi.fn().mockResolvedValue([]),
				readResource: vi.fn().mockResolvedValue({ contents: [] }),
				getAllServers: vi.fn().mockReturnValue([]),
			})
			await sibling.resolveWebviewView(siblingView)

			const manager = provider.providerSettingsManager
			const deleteStoredConfig = manager.deleteConfig.bind(manager)
			manager.deleteConfig = async (name: string) => {
				// A sibling view moves the shared selection onto another survivor and activates it there while
				// the record delete is in flight; the deletion must follow that choice instead of pushing its
				// own entry-time pick back onto the sibling's provider keys.
				await provider.contextProxy.setValue("currentApiConfigName", "other-survivor")
				await sibling.activateProviderProfile({ name: "other-survivor" })
				return deleteStoredConfig(name)
			}

			// The sibling is a live entry in ClineProvider's static instance registry, and dispose
			// is what removes it (ClineProvider.ts:1653-1659), so give it back rather than leave a
			// later test to find it through getAllInstances.
			try {
				await provider.deleteProviderProfile({
					name: "subtask-child-profile",
					id: childId,
					apiProvider: providerIdentifiers.openrouter,
				})
			} finally {
				await sibling.dispose()
			}

			expect(sibling.contextProxy.getValues().currentApiConfigName).toBe("other-survivor")
			expect(sibling.contextProxy.getProviderSettings().openRouterModelId).toBe("openai/gpt-4o")
			// The same shared store is what the acting view reads: if the deletion pushed its own entry-time
			// survivor's settings over the sibling's activation, this is where it shows up.
			expect(provider.contextProxy.getProviderSettings().openRouterModelId).toBe("openai/gpt-4o")
		})
	})
})
