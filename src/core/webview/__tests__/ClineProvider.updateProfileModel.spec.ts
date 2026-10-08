// npx vitest run core/webview/__tests__/ClineProvider.updateProfileModel.spec.ts

import * as vscode from "vscode"
import { makeCompositeDisposable } from "../../../test-utils/vscode"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService } from "@roo-code/cloud"
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
		this.instanceId = options?.historyItem?.id ? `${options.historyItem.id}-instance` : "test-instance-id"
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

const { mockCloudInstance } = vi.hoisted(() => ({
	mockCloudInstance: {
		isCloudAgent: false,
		isAuthenticated: vi.fn().mockReturnValue(false),
		getAllowList: vi.fn().mockReturnValue({ allowAll: true }),
		getOrganizationSettings: vi.fn().mockReturnValue(undefined),
		getUserInfo: vi.fn().mockReturnValue(null),
		on: vi.fn(),
		off: vi.fn(),
	},
}))

vi.mock("@roo-code/cloud", () => ({
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://api.roocode.com"),
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return mockCloudInstance
		},
	},
}))

type StoredProfile = ProviderSettings & { name: string; id: string }

describe("ClineProvider - updateProfileModel", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView

	let storedProfiles: Record<string, StoredProfile> = {}

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

	const mockStoredProfile = (profile: ProviderSettings & { name?: string }) => {
		const name = profile.name || "test-config"
		storedProfiles[name] = { name, id: "test-id", ...profile }
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		mockCloudInstance.isAuthenticated.mockReturnValue(false)
		mockCloudInstance.getOrganizationSettings.mockReturnValue(undefined)
		mockCloudInstance.getAllowList.mockReturnValue({ allowAll: true })

		storedProfiles = {
			"test-config": {
				name: "test-config",
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			},
		}

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
				saveConfig: vi.fn().mockImplementation(async (name: string, config: ProviderSettings) => {
					storedProfiles[name] = { name, id: (config as Partial<StoredProfile>).id || "test-id", ...config }
					return "test-id"
				}),
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
				getProfile: vi.fn().mockImplementation(async (params: { name: string } | { id: string }) => {
					const targetName = "name" in params ? params.name : "test-config"
					return (
						storedProfiles[targetName] || {
							name: targetName,
							id: "test-id",
							apiProvider: providerIdentifiers.openrouter,
							openRouterModelId: "openai/gpt-4",
						}
					)
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

	it("treats a profile without apiProvider as OpenRouter and normalizes apiProvider when saving", async () => {
		mockStoredProfile({})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})

		expect(manager().saveConfig).toHaveBeenCalledWith("test-config", {
			id: "test-id",
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "x/y",
		})
		expect(provider.contextProxy.getValues().apiProvider).toBe(providerIdentifiers.openrouter)
	})

	it("normalizes apiProvider to OpenRouter when rebuilding task handler for provider-less profile", async () => {
		const mockTask = new Task({} as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(mockTask, "taskApiConfigName", { value: "test-config" })
		await provider.addClineToStack(mockTask)
		mockStoredProfile({})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
		})

		expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
			expect.objectContaining({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "x/y",
			}),
		)
	})

	it("ignores non-null values for reset-only keys while updating model selection", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			reasoningEffort: "low",
			modelMaxTokens: 4096,
			modelMaxThinkingTokens: 2048,
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "x/y",
			reasoningEffort: "high",
			modelMaxTokens: 8192,
			modelMaxThinkingTokens: 4096,
		})

		const saved = manager().saveConfig.mock.calls[0][1]
		expect(saved.openRouterModelId).toBe("x/y")
		expect(saved.reasoningEffort).toBe("low")
		expect(saved.modelMaxTokens).toBe(4096)
		expect(saved.modelMaxThinkingTokens).toBe(2048)
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

	it("rejects a model update when the authenticated organization policy is unavailable or throws", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "allowed/model" })
		mockCloudInstance.isAuthenticated.mockReturnValue(true)
		mockCloudInstance.getOrganizationSettings.mockImplementation(() => {
			throw new Error("Failed to fetch settings")
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "blocked/model",
		})

		expect(manager().saveConfig).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.violated_organization_allowlist")
	})

	it("allows a model update when an authenticated session has no organization settings (defaults to ORGANIZATION_ALLOW_ALL)", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "stored/model" })
		mockCloudInstance.isAuthenticated.mockReturnValue(true)
		mockCloudInstance.getOrganizationSettings.mockReturnValue(undefined)

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "new/model",
		})

		expect(manager().saveConfig).toHaveBeenCalledWith(
			"test-config",
			expect.objectContaining({
				openRouterModelId: "new/model",
			}),
		)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
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

		manager().saveConfig.mockImplementationOnce(async (name: string, config: ProviderSettings) => {
			storedProfiles[name] = { name, id: (config as Partial<StoredProfile>).id || "test-id", ...config }
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

	it("enforces organization allow-list when authenticated through CloudService", async () => {
		mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "allowed/model" })
		mockCloudInstance.isAuthenticated.mockReturnValue(true)
		mockCloudInstance.getOrganizationSettings.mockReturnValue({
			allowList: {
				allowAll: false,
				providers: { [providerIdentifiers.openrouter]: { allowAll: false, models: ["allowed/model"] } },
			},
		} as unknown as ReturnType<typeof mockCloudInstance.getOrganizationSettings>)

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "blocked/model",
		})
		expect(manager().saveConfig).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.violated_organization_allowlist")

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "allowed/model",
		})
		expect(manager().saveConfig).toHaveBeenCalledTimes(1)
		expect(manager().saveConfig).toHaveBeenCalledWith(
			"test-config",
			expect.objectContaining({ openRouterModelId: "allowed/model" }),
		)
	})

	it("rolls back saved profile and prevents handler rebuild when mutation signal aborts during context update", async () => {
		const mockTask = new Task({} as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(mockTask, "taskApiConfigName", { value: "test-config" })
		await provider.addClineToStack(mockTask)

		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		const controller = new AbortController()
		provider["enqueueProviderProfileMutation"] = vi.fn().mockImplementation(async (fn) => {
			return fn(controller.signal)
		})

		const originalSetProviderSettings = provider.contextProxy.setProviderSettings.bind(provider.contextProxy)
		vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementationOnce(async (settings) => {
			await originalSetProviderSettings(settings)
			controller.abort()
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		expect(manager().saveConfig).toHaveBeenCalledTimes(2)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			2,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4", openRouterApiKey: "my-key" }),
		)
		expect(provider.contextProxy.getValues().openRouterModelId).toBe("openai/gpt-4")
		expect(mockTask.updateApiConfiguration).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})

	it("rolls back saved profile and restores context when contextProxy.setProviderSettings fails", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		let setSettingsCalls = 0
		const originalSetProviderSettings = provider.contextProxy.setProviderSettings.bind(provider.contextProxy)
		vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementation(async (settings) => {
			setSettingsCalls++
			if (setSettingsCalls === 1) {
				throw new Error("Context secret storage write failed")
			}
			return originalSetProviderSettings(settings)
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		expect(manager().saveConfig).toHaveBeenCalledTimes(2)
		expect(manager().saveConfig).toHaveBeenNthCalledWith(
			2,
			"test-config",
			expect.objectContaining({ openRouterModelId: "openai/gpt-4", openRouterApiKey: "my-key" }),
		)
		expect(provider.contextProxy.setProviderSettings).toHaveBeenCalledTimes(2)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})

	it("aborts active and queued profile mutations upon provider disposal", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		const mockTask = new Task({} as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(mockTask, "taskApiConfigName", { value: "test-config" })
		await provider.addClineToStack(mockTask)

		let resolveBlockedMutation!: () => void
		const mutationBlockedPromise = new Promise<void>((resolve) => {
			resolveBlockedMutation = resolve
		})

		const originalSetProviderSettings = provider.contextProxy.setProviderSettings.bind(provider.contextProxy)
		let setSettingsCalls = 0
		vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementation(async (settings) => {
			setSettingsCalls++
			if (setSettingsCalls === 1) {
				await mutationBlockedPromise
			}
			return originalSetProviderSettings(settings)
		})

		const postStateSpy = vi.spyOn(provider, "postStateToWebview")

		// Start mutation 1 (will be blocked in setProviderSettings)
		const mutation1 = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		// Give mutation 1 a tick to enter setProviderSettings
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Enqueue mutation 2 while mutation 1 is still blocked
		const mutation2 = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-5",
		})

		// Dispose provider while mutation 1 is active and mutation 2 is queued
		await provider.dispose()

		// Release the blocked mutation 1
		resolveBlockedMutation()

		await Promise.all([mutation1, mutation2])

		// Active mutation 1 aborted and rolled back to gpt-4
		// Queued mutation 2 aborted without ever saving gpt-5
		expect(storedProfiles["test-config"].openRouterModelId).toBe("openai/gpt-4")
		expect(mockTask.updateApiConfiguration).not.toHaveBeenCalled()
		expect(postStateSpy).not.toHaveBeenCalled()
	})

	it("serializes queued mutations behind timed-out in-flight mutation and its rollback", async () => {
		vi.useFakeTimers()
		try {
			mockStoredProfile({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
				openRouterApiKey: "my-key",
			})

			let resolveStalledMutation!: () => void
			const stalledMutationPromise = new Promise<void>((resolve) => {
				resolveStalledMutation = resolve
			})

			const originalSetProviderSettings = provider.contextProxy.setProviderSettings.bind(provider.contextProxy)
			let setSettingsCalls = 0
			vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementation(async (settings) => {
				setSettingsCalls++
				if (setSettingsCalls === 1) {
					await stalledMutationPromise
				}
				return originalSetProviderSettings(settings)
			})

			// Start mutation 1
			const mutation1 = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "openai/gpt-4.5",
			})

			// Advance timers past PENDING_OPERATION_TIMEOUT_MS so mutation 1 caller times out
			await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS + 100)
			await mutation1

			// At this point mutation 1 timed out, but its underlying run is STILL held by stalledMutationPromise.
			// Start mutation 2:
			let mutation2Started = false
			const originalSaveConfig = manager().saveConfig.getMockImplementation()!
			manager().saveConfig.mockImplementation(async (name: string, config: ProviderSettings) => {
				if (config.openRouterModelId === "openai/gpt-5") {
					mutation2Started = true
				}
				return originalSaveConfig(name, config)
			})

			const mutation2 = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "openai/gpt-5",
			})

			// Allow microtasks to run
			await vi.advanceTimersByTimeAsync(10)

			// Mutation 2 must NOT have entered saveConfig yet because mutation 1 has not settled!
			expect(mutation2Started).toBe(false)

			// Now release mutation 1, allowing it to rollback and settle
			resolveStalledMutation()
			await vi.advanceTimersByTimeAsync(100)
			await mutation2

			// Mutation 2 must have now executed and its save must be the final state!
			expect(storedProfiles["test-config"].openRouterModelId).toBe("openai/gpt-5")
		} finally {
			vi.useRealTimers()
		}
	})

	it("preserves newer profile saved by another provider instance and skips rollback", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			openRouterApiKey: "my-key",
		})

		vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementation(async () => {
			// Simulate another provider instance updating the stored profile to a newer model
			storedProfiles["test-config"] = {
				name: "test-config",
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-5",
				openRouterApiKey: "other-key",
			}
			throw new Error("Context secret storage write failed")
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		// Since stored profile was updated by another instance to gpt-5,
		// rollback must NOT overwrite it with gpt-4!
		expect(storedProfiles["test-config"].openRouterModelId).toBe("openai/gpt-5")
		expect(storedProfiles["test-config"].openRouterApiKey).toBe("other-key")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})

	it("rolls back saved profile even if patch contains unallowed or skipped keys", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
			reasoningEffort: "low",
		})

		vi.spyOn(provider.contextProxy, "setProviderSettings").mockRejectedValue(
			new Error("Context secret storage write failed"),
		)

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-5",
			reasoningEffort: "high",
			unallowedKey: "some-value",
		})

		// Since saveConfig succeeded with gpt-5 (and reasoningEffort kept as "low"),
		// but setProviderSettings threw, rollback should execute and restore gpt-4!
		expect(storedProfiles["test-config"].openRouterModelId).toBe("openai/gpt-4")
		expect(storedProfiles["test-config"].reasoningEffort).toBe("low")
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
	})

	it("does not update task handler or sticky profile if task changed during update", async () => {
		mockStoredProfile({
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
		})

		const task1 = new Task({ historyItem: { id: "task-1" } } as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(task1, "taskApiConfigName", { value: "test-config" })
		await provider.addClineToStack(task1)

		const task2 = new Task({ historyItem: { id: "task-2" } } as unknown as ConstructorParameters<typeof Task>[0])
		Object.defineProperty(task2, "taskApiConfigName", { value: "test-config" })

		const originalSetProviderSettings = provider.contextProxy.setProviderSettings.bind(provider.contextProxy)
		vi.spyOn(provider.contextProxy, "setProviderSettings").mockImplementationOnce(async (settings) => {
			await originalSetProviderSettings(settings)
			// Simulate task replacement (e.g. delegation child activation)
			await provider.removeClineFromStack()
			await provider.addClineToStack(task2)
		})

		await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
			openRouterModelId: "openai/gpt-4.5",
		})

		// Neither task1 nor task2 should have had updateApiConfiguration called with new model
		expect(task1.updateApiConfiguration).not.toHaveBeenCalled()
		expect(task2.updateApiConfiguration).not.toHaveBeenCalled()
		expect(task2.setTaskApiConfigName).not.toHaveBeenCalled()
	})

	it("aborts queued upsertProviderProfile without saving after provider disposal", async () => {
		let resolveFirstMutation!: () => void
		const firstMutationBlocked = new Promise<void>((resolve) => {
			resolveFirstMutation = resolve
		})

		// Block provider mutation queue with a long-running mutation
		const firstMutation = provider["enqueueProviderProfileMutation"](async () => {
			await firstMutationBlocked
		})

		// Queue an upsert behind the blocked mutation
		const upsertPromise = provider.upsertProviderProfile("new-profile", {
			apiProvider: providerIdentifiers.openrouter,
			openRouterModelId: "openai/gpt-4",
		} as ProviderSettings)

		// Dispose the provider
		await provider.dispose()

		// Release first mutation
		resolveFirstMutation()

		await Promise.allSettled([firstMutation, upsertPromise])

		// upsert should not have saved anything to new-profile
		expect(storedProfiles["new-profile"]).toBeUndefined()
	})
})
