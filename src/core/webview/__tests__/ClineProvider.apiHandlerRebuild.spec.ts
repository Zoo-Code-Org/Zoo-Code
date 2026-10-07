// npx vitest core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts

import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"
import { getModelId, RooCodeEventName, type ProviderSettings, type ProviderSettingsEntry } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import type { Mode } from "../../../shared/modes"
import { Task, TaskOptions } from "../../task/Task"
import { ClineProvider } from "../ClineProvider"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Mock setup
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

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
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

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(function () {
			return {
				initializeFilePaths: vi.fn(),
				dispose: vi.fn(),
			}
		}),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function (options) {
		const mockTask = {
			api: undefined,
			abortTask: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			clineMessages: [],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			taskId: options?.historyItem?.id || "test-task-id",
			emit: vi.fn(),
			setTaskApiConfigName: vi.fn(),
			updateApiConfiguration: vi.fn().mockImplementation(function (this: any, newConfig: any) {
				this.apiConfiguration = newConfig
			}),
		}
		// Define apiConfiguration as a property so tests can read it
		Object.defineProperty(mockTask, "apiConfiguration", {
			value: options?.apiConfiguration || {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			},
			writable: true,
			configurable: true,
		})
		return mockTask
	}),
}))

vi.mock("../../../i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../i18n")>()),
	t: (key: string) => key,
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

describe("ClineProvider - API Handler Rebuild Guard", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: any
	let defaultTaskOptions: TaskOptions
	let buildApiHandlerMock: any

	beforeEach(async () => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, any> = {
			mode: "code",
			currentApiConfigName: "test-config",
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
			onDidDispose: vi.fn().mockImplementation((callback) => {
				callback()
				return { dispose: vi.fn() }
			}),
			onDidChangeVisibility: vi.fn().mockImplementation(() => {
				return { dispose: vi.fn() }
			}),
		} as unknown as vscode.WebviewView

		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		// Mock providerSettingsManager
		;(provider as any).providerSettingsManager = {
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
			clearModeConfig: vi.fn(),
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
		}

		// Get the buildApiHandler mock
		const { buildApiHandler } = await import("../../../api")
		buildApiHandlerMock = vi.mocked(buildApiHandler)

		// Setup default mock implementation
		buildApiHandlerMock.mockReturnValue({
			getModel: vi.fn().mockReturnValue({
				id: "openai/gpt-4",
				info: { contextWindow: 128000 },
			}),
		})

		defaultTaskOptions = {
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			},
		}

		await provider.resolveWebviewView(mockWebviewView)
	})

	describe("upsertProviderProfile", () => {
		test("calls updateApiConfiguration when provider/model unchanged but profile settings changed (explicit save)", async () => {
			// Create a task with the current config
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Save settings with SAME provider and model (simulating Save button click)
			await provider.upsertProviderProfile(
				"test-config",
				{
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
					// Other settings that might change
					rateLimitSeconds: 5,
					modelTemperature: 0.7,
				},
				true,
			)

			// Verify updateApiConfiguration was called because we force rebuild on explicit save/switch
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
					rateLimitSeconds: 5,
					modelTemperature: 0.7,
				}),
			)
			// Verify task.apiConfiguration was synchronized
			expect((mockTask as any).apiConfiguration.openRouterModelId).toBe("openai/gpt-4")
			expect((mockTask as any).apiConfiguration.rateLimitSeconds).toBe(5)
			expect((mockTask as any).apiConfiguration.modelTemperature).toBe(0.7)
		})

		test("calls updateApiConfiguration when provider changes", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Change provider to anthropic
			await provider.upsertProviderProfile(
				"test-config",
				{
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
				},
				true,
			)

			// Verify updateApiConfiguration was called since provider changed
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
				}),
			)
		})

		test("calls updateApiConfiguration when model changes", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Change model to different model
			await provider.upsertProviderProfile(
				"test-config",
				{
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "anthropic/claude-3-5-sonnet-20241022",
				},
				true,
			)

			// Verify updateApiConfiguration was called since model changed
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "anthropic/claude-3-5-sonnet-20241022",
				}),
			)
		})

		test("does nothing when no task is running", async () => {
			// Don't add any task to stack
			buildApiHandlerMock.mockClear()

			await provider.upsertProviderProfile(
				"test-config",
				{
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
				true,
			)

			// Should not call buildApiHandler when there's no task
			expect(buildApiHandlerMock).not.toHaveBeenCalled()
		})
	})

	describe("updateProfileModel", () => {
		const manager = () => {
			const settingsManager = provider["providerSettingsManager"]
			return {
				getProfile: vi.mocked(settingsManager.getProfile),
				saveConfig: vi.mocked(settingsManager.saveConfig),
				activateProfile: vi.mocked(settingsManager.activateProfile),
			}
		}

		beforeEach(async () => {
			await provider.contextProxy.setValue("currentApiConfigName", "test-config")
		})

		const mockStoredProfile = (profile: ProviderSettings & { name?: string }) =>
			manager().getProfile.mockResolvedValue({ name: "test-config", id: "test-id", ...profile })

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

		it("uses the task's sticky profile name as the visible profile when a task is active", async () => {
			const mockTask = new Task({ ...defaultTaskOptions })
			Object.defineProperty(mockTask, "taskApiConfigName", { value: "sticky-config" })
			await provider.addClineToStack(mockTask)
			mockStoredProfile({ name: "sticky-config", apiProvider: providerIdentifiers.openrouter })

			await provider.updateProfileModel("sticky-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})
			expect(manager().saveConfig).toHaveBeenCalledWith(
				"sticky-config",
				expect.objectContaining({ openRouterModelId: "x/y" }),
			)

			manager().saveConfig.mockClear()
			// The global profile name is not what the webview is shown while a task is active.
			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/z",
			})
			expect(manager().saveConfig).not.toHaveBeenCalled()
		})

		describe("when the mutation times out while listing profiles", () => {
			const runTimedOutUpdate = async (newerModel?: string) => {
				mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
				// Like the real store, getProfile reflects what saveConfig last wrote.
				manager().saveConfig.mockImplementation(async (profileName, settings) => {
					manager().getProfile.mockResolvedValue({ name: profileName, ...settings })
					return "test-id"
				})
				let resolveList!: (entries: ProviderSettingsEntry[]) => void
				const listing = new Promise<ProviderSettingsEntry[]>((resolve) => {
					resolveList = resolve
				})
				vi.mocked(provider["providerSettingsManager"].listConfig).mockImplementationOnce(() => listing)
				manager().activateProfile.mockResolvedValue({
					name: "other-config",
					id: "other-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "other/model",
				})
				const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")

				const updating = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
					openRouterModelId: "x/y",
				})
				await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS)
				const switching = provider.activateProviderProfile({ name: "other-config" })

				if (newerModel) {
					// A newer selection lands while the timed-out update is still waiting on the listing.
					manager().getProfile.mockResolvedValue({
						name: "test-config",
						id: "test-id",
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: newerModel,
					})
				}

				resolveList([])
				await Promise.all([updating, switching])
				return setValueSpy
			}

			beforeEach(() => vi.useFakeTimers())
			afterEach(() => vi.useRealTimers())

			it("does not activate its profile and rolls back the saved model", async () => {
				const setValueSpy = await runTimedOutUpdate()

				expect(setValueSpy).not.toHaveBeenCalledWith("currentApiConfigName", "test-config")
				expect(provider.contextProxy.getValues().currentApiConfigName).toBe("other-config")
				expect(manager().saveConfig).toHaveBeenCalledTimes(2)
				expect(manager().saveConfig).toHaveBeenLastCalledWith("test-config", {
					id: "test-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				})
			})

			it("does not roll back over a newer selection saved in the meantime", async () => {
				await runTimedOutUpdate("newer/model")

				expect(manager().saveConfig).toHaveBeenCalledTimes(1)
			})
		})

		it("rolls back the saved model when an activation write fails", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			manager().saveConfig.mockImplementation(async (profileName, settings) => {
				manager().getProfile.mockResolvedValue({ name: profileName, ...settings })
				return "test-id"
			})
			vi.mocked(provider["providerSettingsManager"].setModeConfig).mockRejectedValueOnce(new Error("boom"))

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(manager().saveConfig).toHaveBeenCalledTimes(2)
			expect(manager().saveConfig).toHaveBeenLastCalledWith("test-config", {
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			})
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
		})

		it("rolls back the saved model when activation preparation fails", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			manager().saveConfig.mockImplementation(async (profileName, settings) => {
				manager().getProfile.mockResolvedValue({ name: profileName, ...settings })
				return "test-id"
			})
			vi.mocked(provider["providerSettingsManager"].listConfig).mockRejectedValueOnce(new Error("listing failed"))

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(manager().saveConfig).toHaveBeenCalledTimes(2)
			expect(manager().saveConfig).toHaveBeenLastCalledWith("test-config", {
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			})
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
		})

		it("still restores the context settings and logs when restoring the saved profile also fails", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			manager()
				.saveConfig.mockImplementationOnce(async (profileName, settings) => {
					manager().getProfile.mockResolvedValue({ name: profileName, ...settings })
					return "test-id"
				})
				.mockRejectedValueOnce(new Error("restore failed"))
			vi.mocked(provider["providerSettingsManager"].setModeConfig).mockRejectedValueOnce(new Error("boom"))
			const logSpy = vi.spyOn(provider, "log")
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(logSpy).toHaveBeenCalledWith("Profile rollback failed: restore failed")
			expect(setProviderSettingsSpy).toHaveBeenLastCalledWith(
				expect.objectContaining({ openRouterModelId: "openai/gpt-4" }),
			)
			// The original activation error is what gets reported, not the rollback error.
			const errorLog = logSpy.mock.calls.map(([message]) => message).find((m) => m.includes("Error updating"))
			expect(errorLog).toContain("boom")
			expect(errorLog).not.toContain("restore failed")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
		})

		it("clears a mode mapping that did not exist before when an activation write fails", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			vi.mocked(provider["providerSettingsManager"].getModeConfigId).mockResolvedValue(undefined)
			vi.mocked(provider["providerSettingsManager"].setModeConfig).mockResolvedValue(undefined)
			vi.spyOn(provider.contextProxy, "setProviderSettings").mockRejectedValueOnce(new Error("boom"))

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(provider["providerSettingsManager"].clearModeConfig).toHaveBeenCalledTimes(1)
			expect(provider["providerSettingsManager"].clearModeConfig).toHaveBeenCalledWith("architect")
		})

		it("does not undo a newer profile switch when its activation write fails late", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			vi.mocked(provider["providerSettingsManager"].setModeConfig).mockImplementationOnce(async () => {
				await provider.contextProxy.setValue("currentApiConfigName", "other-config")
				throw new Error("boom")
			})

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(provider.contextProxy.getValues().currentApiConfigName).toBe("other-config")
			expect(provider["providerSettingsManager"].clearModeConfig).not.toHaveBeenCalled()
		})

		it("ignores model fields that do not belong to the stored provider", async () => {
			mockStoredProfile({
				apiProvider: providerIdentifiers.lmstudio,
				lmStudioModelId: "model-a",
				lmStudioDraftModelId: "draft-a",
			})

			await provider.updateProfileModel("test-config", providerIdentifiers.lmstudio, {
				lmStudioModelId: "model-b",
				lmStudioDraftModelId: "draft-evil",
				openRouterModelId: "x/y",
			})

			const saved = manager().saveConfig.mock.calls[0][1]
			expect(saved.lmStudioModelId).toBe("model-b")
			expect(saved.lmStudioDraftModelId).toBe("draft-a")
			expect(saved).not.toHaveProperty("openRouterModelId")
		})

		it("rolls back and does not activate when the mutation times out while saving", async () => {
			vi.useFakeTimers()
			try {
				mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
				let releaseSave!: () => void
				const saveGate = new Promise<void>((resolve) => {
					releaseSave = resolve
				})
				manager().saveConfig.mockImplementationOnce(async (profileName, settings) => {
					await saveGate
					manager().getProfile.mockResolvedValue({ name: profileName, ...settings })
					return "test-id"
				})
				manager().activateProfile.mockResolvedValue({
					name: "other-config",
					id: "other-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "other/model",
				})
				const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")

				const updating = provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
					openRouterModelId: "x/y",
				})
				await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS)
				const followUp = provider.activateProviderProfile({ name: "other-config" })

				releaseSave()
				await Promise.all([updating, followUp])

				expect(manager().saveConfig).toHaveBeenCalledTimes(2)
				expect(manager().saveConfig).toHaveBeenLastCalledWith("test-config", {
					id: "test-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				})
				expect(setValueSpy).not.toHaveBeenCalledWith("currentApiConfigName", "test-config")
				expect(provider.contextProxy.getValues().currentApiConfigName).toBe("other-config")
			} finally {
				vi.useRealTimers()
			}
		})

		it("accepts reasoning and token-limit fields only as resets", async () => {
			mockStoredProfile({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
				reasoningEffort: "high",
				modelMaxTokens: 1000,
				modelMaxThinkingTokens: 500,
			})

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
				reasoningEffort: "low",
				modelMaxTokens: 999999999,
				modelMaxThinkingTokens: -1,
			})
			const kept = manager().saveConfig.mock.calls[0][1]
			expect(kept).toMatchObject({ reasoningEffort: "high", modelMaxTokens: 1000, modelMaxThinkingTokens: 500 })

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/z",
				reasoningEffort: null,
				modelMaxTokens: null,
				modelMaxThinkingTokens: null,
			})
			const cleared = manager().saveConfig.mock.calls[1][1]
			expect(cleared.reasoningEffort).toBeUndefined()
			expect(cleared.modelMaxTokens).toBeUndefined()
			expect(cleared.modelMaxThinkingTokens).toBeUndefined()
		})

		it("restores the activation state when an activation write fails", async () => {
			mockStoredProfile({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })
			vi.mocked(provider["providerSettingsManager"].getModeConfigId).mockResolvedValue("prev-mode-id")
			vi.mocked(provider["providerSettingsManager"].setModeConfig)
				.mockRejectedValueOnce(new Error("boom"))
				.mockResolvedValue(undefined)

			await provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
				openRouterModelId: "x/y",
			})

			expect(provider["providerSettingsManager"].setModeConfig).toHaveBeenLastCalledWith(
				expect.anything(),
				"prev-mode-id",
			)
		})

		it("only allows awsCustomArn to be reset, never set", async () => {
			mockStoredProfile({
				apiProvider: providerIdentifiers.bedrock,
				apiModelId: "allowed-model",
				awsCustomArn: "arn:stored",
			})

			await provider.updateProfileModel("test-config", providerIdentifiers.bedrock, {
				apiModelId: "allowed-model",
				awsCustomArn: "arn:attacker",
			})
			expect(manager().saveConfig.mock.calls[0][1].awsCustomArn).toBe("arn:stored")

			await provider.updateProfileModel("test-config", providerIdentifiers.bedrock, {
				apiModelId: "other-model",
				awsCustomArn: "",
			})
			expect(manager().saveConfig.mock.calls[1][1].awsCustomArn).toBe("")
		})

		it("does not save and does not throw when the profile cannot be loaded", async () => {
			manager().getProfile.mockRejectedValue(new Error("not found"))

			await expect(
				provider.updateProfileModel("test-config", providerIdentifiers.openrouter, {
					openRouterModelId: "x/y",
				}),
			).resolves.toBeUndefined()

			expect(manager().saveConfig).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.save_api_config")
		})
	})

	describe("activateProviderProfile", () => {
		test("serializes provider profile mutations without interleaving", async () => {
			const events: string[] = []
			let resolveFirst!: () => void

			provider["providerSettingsManager"].activateProfile = vi
				.fn()
				.mockImplementationOnce(async () => {
					events.push("first:start")
					await new Promise<void>((resolve) => {
						resolveFirst = resolve
					})
					events.push("first:end")
					return {
						name: "first-profile",
						id: "first-id",
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4",
					}
				})
				.mockImplementationOnce(async () => {
					events.push("second:start")
					return {
						name: "second-profile",
						id: "second-id",
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4.1-mini",
					}
				})

			const first = provider.activateProviderProfile({ name: "first-profile" })
			const second = provider.activateProviderProfile({ name: "second-profile" })

			await Promise.resolve()
			expect(events).toEqual(["first:start"])

			resolveFirst()
			await first
			await second

			expect(events).toEqual(["first:start", "first:end", "second:start"])
		})

		test("provider profile mutation rejection does not poison later queued mutations", async () => {
			const firstError = new Error("first profile failed")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")

			provider["providerSettingsManager"].activateProfile = vi
				.fn()
				.mockRejectedValueOnce(firstError)
				.mockResolvedValueOnce({
					name: "second-profile",
					id: "second-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4.1-mini",
				})

			await expect(provider.activateProviderProfile({ name: "first-profile" })).rejects.toThrow(firstError)
			await expect(provider.activateProviderProfile({ name: "second-profile" })).resolves.toBeUndefined()
			expect(setValueSpy).toHaveBeenCalledWith("currentApiConfigName", "second-profile")
		})

		test("timed-out mutations abort before writing state and advance the queue", async () => {
			vi.useFakeTimers()
			const logSpy = vi.spyOn(provider, "log")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")
			let resolveFirst!: () => void
			const firstActivation = new Promise<void>((resolve) => {
				resolveFirst = resolve
			})
			provider["providerSettingsManager"].activateProfile = vi
				.fn()
				.mockImplementationOnce(async () => {
					await firstActivation
					return {
						name: "first-profile",
						id: "first-id",
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4",
					}
				})
				.mockResolvedValueOnce({
					name: "second-profile",
					id: "second-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4.1-mini",
				})

			try {
				const first = provider.activateProviderProfile({ name: "first-profile" })
				const firstResult = expect(first).rejects.toThrow("Provider profile mutation timed out")
				await vi.advanceTimersByTimeAsync(ClineProvider.PENDING_OPERATION_TIMEOUT_MS)
				await firstResult

				// Queue advanced immediately on timeout — second enqueues now.
				const second = provider.activateProviderProfile({ name: "second-profile" })
				// activateProfile not yet called for second (it runs in the next microtask).
				expect(provider["providerSettingsManager"].activateProfile).toHaveBeenCalledTimes(1)

				// Resolve the first activation's inner promise so its in-flight mock can return.
				// The aborted signal prevents it from writing any state.
				resolveFirst()
				await expect(second).resolves.toBeUndefined()
				expect(provider["providerSettingsManager"].activateProfile).toHaveBeenCalledTimes(2)
				// Aborted first activation wrote nothing; only second profile is set.
				expect(setValueSpy).not.toHaveBeenCalledWith("currentApiConfigName", "first-profile")
				expect(setValueSpy).toHaveBeenCalledWith("currentApiConfigName", "second-profile")
				expect(logSpy).toHaveBeenCalledWith("Provider profile mutation timed out; aborting in-flight mutation")
			} finally {
				vi.useRealTimers()
			}
		})

		test("mode switch preserves its default task when queued behind a profile mutation", async () => {
			let releaseProfileActivation!: () => void
			const profileActivation = new Promise<void>((resolve) => {
				releaseProfileActivation = resolve
			})
			provider["providerSettingsManager"].activateProfile = vi.fn().mockImplementationOnce(async () => {
				await profileActivation
				return {
					name: "first-profile",
					id: "first-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				}
			})

			const firstTask = new Task(defaultTaskOptions)
			const secondTask = new Task(defaultTaskOptions)
			Object.defineProperty(firstTask, "taskId", { value: "first-task-id" })
			Object.defineProperty(secondTask, "taskId", { value: "second-task-id" })
			firstTask["_taskMode"] = "code" as Mode
			secondTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(firstTask)

			const profileSwitch = provider.activateProviderProfile({ name: "first-profile" })
			const modeSwitch = provider.handleModeSwitch("ask" as Mode)
			await provider.addClineToStack(secondTask)

			releaseProfileActivation()
			await profileSwitch
			await modeSwitch

			expect(firstTask["_taskMode"]).toBe("ask")
			expect(secondTask["_taskMode"]).toBe("code")
		})

		test("fan-out preparation leaves the focused task untouched", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			await provider.addClineToStack(mockTask)
			provider["providerSettingsManager"].getModeConfigId = vi.fn().mockResolvedValue("ask-id")
			provider["providerSettingsManager"].listConfig = vi
				.fn()
				.mockResolvedValue([{ name: "ask-profile", id: "ask-id", apiProvider: providerIdentifiers.openrouter }])
			provider["providerSettingsManager"].getProfile = vi.fn().mockResolvedValue({
				name: "ask-profile",
				id: "ask-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			provider["providerSettingsManager"].activateProfile = vi.fn().mockResolvedValue({
				name: "ask-profile",
				id: "ask-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4.1-mini",
			})
			const emitSpy = vi.spyOn(provider, "emit")
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")

			await provider.handleModeSwitch("ask" as Mode, null)

			expect(mockTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(mockTask.setTaskApiConfigName).not.toHaveBeenCalled()
			expect(emitSpy).not.toHaveBeenCalledWith(
				RooCodeEventName.ProviderProfileChanged,
				expect.objectContaining({ name: "ask-profile" }),
			)
			expect(postStateSpy).not.toHaveBeenCalled()
			expect(setValueSpy).not.toHaveBeenCalledWith("currentApiConfigName", "ask-profile")
			expect(setProviderSettingsSpy).not.toHaveBeenCalled()
			expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "ask")
			expect(provider["providerSettingsManager"].activateProfile).toHaveBeenCalledWith({ name: "ask-profile" })
		})

		test("calls updateApiConfiguration when provider/model unchanged but settings differ (explicit profile switch)", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
					modelTemperature: 0.3,
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Mock activateProfile to return same provider/model but different non-model setting
			;(provider as any).providerSettingsManager.activateProfile = vi.fn().mockResolvedValue({
				name: "test-config",
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
				modelTemperature: 0.9,
				rateLimitSeconds: 7,
			})

			await provider.activateProviderProfile({ name: "test-config" })

			// Verify updateApiConfiguration was called due to forced rebuild on explicit switch
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				}),
			)
			// Verify task.apiConfiguration was synchronized
			expect((mockTask as any).apiConfiguration.openRouterModelId).toBe("openai/gpt-4")
			expect((mockTask as any).apiConfiguration.modelTemperature).toBe(0.9)
			expect((mockTask as any).apiConfiguration.rateLimitSeconds).toBe(7)
		})

		test("calls updateApiConfiguration when provider changes and syncs task.apiConfiguration", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Mock activateProfile to return different provider
			;(provider as any).providerSettingsManager.activateProfile = vi.fn().mockResolvedValue({
				name: "anthropic-config",
				id: "anthropic-id",
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-sonnet-20241022",
			})

			await provider.activateProviderProfile({ name: "anthropic-config" })

			// Verify updateApiConfiguration was called
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
				}),
			)
			// And task.apiConfiguration synced
			expect((mockTask as any).apiConfiguration.apiProvider).toBe("anthropic")
			expect((mockTask as any).apiConfiguration.apiModelId).toBe("claude-3-5-sonnet-20241022")
		})

		test("calls updateApiConfiguration when model changes and syncs task.apiConfiguration", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// Mock activateProfile to return different model
			;(provider as any).providerSettingsManager.activateProfile = vi.fn().mockResolvedValue({
				name: "test-config",
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "anthropic/claude-3-5-sonnet-20241022",
			})

			await provider.activateProviderProfile({ name: "test-config" })

			// Verify updateApiConfiguration was called
			expect(mockTask.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "anthropic/claude-3-5-sonnet-20241022",
				}),
			)
			// And task.apiConfiguration synced
			expect((mockTask as any).apiConfiguration.apiProvider).toBe("openrouter")
			expect((mockTask as any).apiConfiguration.openRouterModelId).toBe("anthropic/claude-3-5-sonnet-20241022")
		})
	})

	describe("profile switching sequence", () => {
		test("A -> B -> A updates task.apiConfiguration each time", async () => {
			const mockTask = new Task({
				...defaultTaskOptions,
				apiConfiguration: {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				},
			})
			mockTask.api = {
				getModel: vi.fn().mockReturnValue({
					id: "openai/gpt-4",
					info: { contextWindow: 128000 },
				}),
			} as any

			await provider.addClineToStack(mockTask)

			// First switch: A -> B (openrouter -> anthropic)
			;(provider as any).providerSettingsManager.activateProfile = vi.fn().mockResolvedValue({
				name: "anthropic-config",
				id: "anthropic-id",
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-sonnet-20241022",
			})
			await provider.activateProviderProfile({ name: "anthropic-config" })

			expect(mockTask.updateApiConfiguration).toHaveBeenCalled()
			expect((mockTask as any).apiConfiguration.apiProvider).toBe("anthropic")
			expect((mockTask as any).apiConfiguration.apiModelId).toBe("claude-3-5-sonnet-20241022")

			// Second switch: B -> A (anthropic -> openrouter gpt-4)
			;(mockTask.updateApiConfiguration as any).mockClear()
			;(provider as any).providerSettingsManager.activateProfile = vi.fn().mockResolvedValue({
				name: "test-config",
				id: "test-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
			})
			await provider.activateProviderProfile({ name: "test-config" })

			// updateApiConfiguration called again, and apiConfiguration must be updated
			expect(mockTask.updateApiConfiguration).toHaveBeenCalled()
			expect((mockTask as any).apiConfiguration.apiProvider).toBe("openrouter")
			expect((mockTask as any).apiConfiguration.openRouterModelId).toBe("openai/gpt-4")
		})
	})

	describe("getModelId helper", () => {
		test("correctly extracts model ID from different provider configurations", () => {
			expect(getModelId({ apiProvider: providerIdentifiers.openrouter, openRouterModelId: "openai/gpt-4" })).toBe(
				"openai/gpt-4",
			)
			expect(
				getModelId({ apiProvider: providerIdentifiers.anthropic, apiModelId: "claude-3-5-sonnet-20241022" }),
			).toBe("claude-3-5-sonnet-20241022")
			expect(getModelId({ apiProvider: providerIdentifiers.openai, openAiModelId: "gpt-4-turbo" })).toBe(
				"gpt-4-turbo",
			)
			expect(getModelId({ apiProvider: providerIdentifiers.bedrock, apiModelId: "anthropic.claude-v2" })).toBe(
				"anthropic.claude-v2",
			)
		})

		test("returns undefined when no model ID is present", () => {
			expect(getModelId({ apiProvider: providerIdentifiers.anthropic })).toBeUndefined()
			expect(getModelId({})).toBeUndefined()
		})
	})
})
