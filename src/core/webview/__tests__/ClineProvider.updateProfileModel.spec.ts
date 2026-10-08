// npx vitest run core/webview/__tests__/ClineProvider.updateProfileModel.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { Task } from "../../task/Task"

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
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
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
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(),
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(""),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
}))

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (
		this: Record<string, unknown>,
		options: { historyItem?: { id: string }; apiConfiguration?: ProviderSettings } | undefined,
	) {
		this.historyItem = options?.historyItem
		this.abortTask = vi.fn()
		this.handleWebviewAskResponse = vi.fn()
		this.clineMessages = []
		this.apiConversationHistory = []
		this.overwriteClineMessages = vi.fn()
		this.overwriteApiConversationHistory = vi.fn()
		this.taskId = options?.historyItem?.id || "test-task-id"
		this.emit = vi.fn()
		this.setTaskApiConfigName = vi.fn()
		this.updateApiConfiguration = vi.fn().mockImplementation((newConfig: ProviderSettings) => {
			this.apiConfiguration = newConfig
		})
		this.apiConfiguration = options?.apiConfiguration || {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
		}
	}),
}))

vi.mock("../../../i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../i18n")>()),
	t: (key: string) => key,
}))

vi.mock("@roo-code/cloud", () => ({
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://api.roocode.com"),
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isCloudAgent: false,
				isAuthenticated: vi.fn().mockReturnValue(false),
				getAllowList: vi.fn().mockReturnValue({ allowAll: true }),
				getOrganizationSettings: vi.fn().mockReturnValue(undefined),
				getUserInfo: vi.fn().mockReturnValue(null),
				on: vi.fn(),
				off: vi.fn(),
			}
		},
	},
}))

describe("ClineProvider - updateProfileModel", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView

	const manager = () => {
		const settingsManager = provider["providerSettingsManager"]
		return {
			getProfile: vi.mocked(settingsManager.getProfile),
			saveConfig: vi.mocked(settingsManager.saveConfig),
			activateProfile: vi.mocked(settingsManager.activateProfile),
			setModeConfig: vi.mocked(settingsManager.setModeConfig),
			listConfig: vi.mocked(settingsManager.listConfig),
		}
	}

	const mockStoredProfile = (profile: ProviderSettings & { name?: string }) =>
		manager().getProfile.mockResolvedValue({ name: "test-config", id: "test-id", ...profile })

	beforeEach(async () => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const secrets: Record<string, string> = {}
		mockContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: string) => {
					if (key === "currentApiConfigName") return "test-config"
					if (key === "listApiConfigMeta") {
						return [
							{
								name: "test-config",
								id: "test-id",
								apiProvider: providerIdentifiers.openrouter,
							},
						]
					}
					return undefined
				}),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
				setKeysForSync: vi.fn(),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string) => {
					return (secrets[key] = value)
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
			extensionUri: { fsPath: "/test/extension/path" },
			globalStorageUri: { fsPath: "/test/storage/path" },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockWebviewView = {
			webview: {
				postMessage: vi.fn(),
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation((cb) => {
				cb()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		} as unknown as vscode.WebviewView

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockContext),
			new WebviewFocusTracker(),
		)

		// Test double for providerSettingsManager
		Object.defineProperty(provider, "providerSettingsManager", {
			value: {
				saveConfig: vi.fn().mockResolvedValue("test-id"),
				listConfig: vi.fn().mockResolvedValue([
					{
						name: "test-config",
						id: "test-id",
						apiProvider: providerIdentifiers.openrouter,
						modelId: "openai/gpt-4",
					},
				]),
				setModeConfig: vi.fn(),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				activateProfile: vi.fn().mockResolvedValue({
					name: "test-config",
					id: "test-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				}),
				getProfile: vi.fn().mockResolvedValue({
					name: "test-config",
					id: "test-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				}),
			},
			configurable: true,
			writable: true,
		})

		await provider.contextProxy.setValue("currentApiConfigName", "test-config")
	})

	it("merges the patch onto the stored profile, clearing null fields", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "stored-key",
			reasoningEffort: "high",
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
			reasoningEffort: null,
		})

		expect(manager().getProfile).toHaveBeenCalledWith({ name: "test-config" })
		expect(manager().saveConfig).toHaveBeenCalledTimes(1)
		expect(manager().saveConfig).toHaveBeenCalledWith("test-config", {
			id: "test-id",
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "x/y",
			openRouterApiKey: "stored-key",
			reasoningEffort: undefined,
		})
	})

	it("rejects the update when the stored provider differs from the expected provider", async () => {
		await provider.updateProfileModel("test-config", providerIdentifiers.anthropic, { apiModelId: "x" })

		expect(manager().saveConfig).not.toHaveBeenCalled()
	})

	it("treats a profile without apiProvider as OpenRouter", async () => {
		mockStoredProfile({})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})

		expect(manager().saveConfig).toHaveBeenCalledWith(
			"test-config",
			expect.objectContaining({ openRouterModelId: "x/y" }),
		)
	})

	it("ignores non-setting keys, apiProvider, own __proto__ keys and non-primitive values", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterApiKey: "stored-key" })
		const patch = JSON.parse(
			'{"openRouterModelId":"x/y","notASetting":"evil","apiProvider":"anthropic","__proto__":{"polluted":true},"openRouterApiKey":{"nested":1}}',
		)

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, patch)

		const saved = manager().saveConfig.mock.calls[0][1]
		expect(saved).not.toHaveProperty("notASetting")
		expect(saved).not.toHaveProperty("polluted")
		expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
		expect(saved.apiProvider).toBe(providerIdentifiers.openrouter)
		expect(saved.openRouterApiKey).toBe("stored-key")
		expect(saved.openRouterModelId).toBe("x/y")
	})

	it("ignores patch keys other than model ids and model-selection resets", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterBaseUrl: "https://stored" })

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
			openRouterBaseUrl: "https://evil",
			reasoningEffort: null,
		})

		const saved = manager().saveConfig.mock.calls[0][1]
		expect(saved.openRouterBaseUrl).toBe("https://stored")
		expect(saved.openRouterModelId).toBe("x/y")
	})

	it("rejects a model outside the organization allow-list without saving", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "allowed/model" })
		vi.spyOn(provider, "getState").mockResolvedValue({
			...(await provider.getState()),
			organizationAllowList: {
				allowAll: false,
				providers: { [providerIdentifiers.openrouter]: { allowAll: false, models: ["allowed/model"] } },
			},
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "blocked/model",
		})
		expect(manager().saveConfig).not.toHaveBeenCalled()

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "allowed/model",
		})
		expect(manager().saveConfig).toHaveBeenCalledTimes(1)
	})

	it("rejects a model update when the authenticated organization policy is unavailable", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "allowed/model" })
		provider["getOrganizationAllowListForProfileMutation"] = vi.fn().mockReturnValue(undefined)

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "blocked/model",
		})

		expect(manager().saveConfig).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.violated_organization_allowlist")
	})

	it("drops an update for a profile that is not the visible profile without reading or saving it", async () => {
		await provider.updateProfileModel("other-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})

		expect(manager().getProfile).not.toHaveBeenCalled()
		expect(manager().saveConfig).not.toHaveBeenCalled()
	})

	it("drops a stale update that was queued behind a profile switch", async () => {
		manager().activateProfile.mockResolvedValue({
			name: "other-config",
			id: "other-id",
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "other/model",
		})

		// The webview still shows "test-config" when the model is picked, before the switch lands.
		const switching = provider.activateProviderProfile({ name: "other-config" })
		const updating = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})
		await Promise.all([switching, updating])

		expect(manager().saveConfig).not.toHaveBeenCalled()
		expect(provider.contextProxy.getValues().currentApiConfigName).toBe("other-config")
	})

	it("uses the task's sticky profile name as the visible profile when a task is active without modifying global profile or mode config", async () => {
		// Test double with minimal options
		const mockTask = new Task({} as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(mockTask, "taskApiConfigName", { value: "sticky-config" })
		await provider.addClineToStack(mockTask)
		mockStoredProfile({ name: "sticky-config", apiProvider: providerIdentifiers.openrouter })

		const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

		await provider.updateProfileModel("sticky-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})
		expect(manager().saveConfig).toHaveBeenCalledWith(
			"sticky-config",
			expect.objectContaining({ openRouterModelId: "x/y" }),
		)
		expect(manager().setModeConfig).not.toHaveBeenCalled()
		expect(provider.contextProxy.getValues().currentApiConfigName).toBe("test-config")
		expect(setProviderSettingsSpy).not.toHaveBeenCalled()
		expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
			expect.objectContaining({ openRouterModelId: "x/y" }),
		)

		manager().saveConfig.mockClear()
		// The global profile name is not what the webview is shown while a task is active.
		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/z",
		})
		expect(manager().saveConfig).not.toHaveBeenCalled()
	})

	it("updates contextProxy provider settings when updating the current global profile", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
		})

		const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		expect(setProviderSettingsSpy).toHaveBeenCalledWith(
			expect.objectContaining({ openRouterModelId: "openai/gpt-4.5" }),
		)
		expect(manager().setModeConfig).not.toHaveBeenCalled()
	})

	it("rolls back saved profile if post-save state update fails", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		let listConfigCalls = 0
		manager().listConfig.mockImplementation(async () => {
			listConfigCalls++
			if (listConfigCalls === 1) {
				throw new Error("Global state sync failed")
			}
			return []
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		// First call saves the patched model, second call rolls back to original stored config
		expect(manager().saveConfig).toHaveBeenCalledTimes(2)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			1,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4.5" }),
		)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			2,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4", openRouterApiKey: "my-key" }),
		)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})

	it("rolls back saved profile if mutation signal is aborted after saveConfig", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		const controller = new AbortController()
		provider["enqueueProviderProfileMutation"] = vi.fn().mockImplementation(async (fn) => {
			return fn(controller.signal)
		})

		manager().saveConfig.mockImplementationOnce(async () => {
			controller.abort()
			return "test-id"
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		expect(manager().saveConfig).toHaveBeenCalledTimes(2)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			1,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4.5" }),
		)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			2,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4", openRouterApiKey: "my-key" }),
		)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})
})
