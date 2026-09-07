// npx vitest core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts

import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"
import { getModelId, RooCodeEventName, type HistoryItem } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import type { Mode } from "../../../shared/modes"
import { Task, TaskOptions } from "../../task/Task"
import { PRODUCTION_PROVIDER_HANDOFF_POLICY } from "../../task-persistence/providerHandoff"
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
	isCompleteTaskHandoffExecutionContext: (execution: unknown) => {
		const candidate = execution as
			| { mode?: unknown; apiConfigName?: unknown; apiConfiguration?: unknown }
			| undefined
		return (
			candidate !== undefined &&
			typeof candidate === "object" &&
			typeof candidate.mode === "string" &&
			candidate.mode.length > 0 &&
			typeof candidate.apiConfigName === "string" &&
			candidate.apiConfigName.length > 0 &&
			candidate.apiConfiguration !== undefined
		)
	},
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
			updateApiConfiguration: vi.fn().mockImplementation(function (
				this: { apiConfiguration?: unknown },
				newConfig: unknown,
			) {
				this.apiConfiguration = newConfig
			}),
			adoptHandoffExecutionContext: vi.fn().mockImplementation(function (
				this: { apiConfiguration?: unknown },
				execution: { mode: string; apiConfigName?: string; apiConfiguration: unknown },
			) {
				this.apiConfiguration = execution.apiConfiguration
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
			// Durable identity present by default: the explicit-clear
			// reconstruction fallback must not engage in these tests.
			getCurrentProfileName: vi.fn().mockResolvedValue("test-config"),
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
			snapshotForHandoff: vi.fn().mockResolvedValue({
				currentApiConfigName: "test-config",
				entries: [
					{
						name: "test-config",
						id: "test-id",
						apiProvider: providerIdentifiers.openrouter,
						modelId: "openai/gpt-4",
					},
				],
				modeApiConfigId: undefined,
				savedProfile: undefined,
			}),
			projectHandoffState: vi.fn().mockResolvedValue(undefined),
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

		test("timed-out mutations abort before writing state and release the caller", async () => {
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
				// The timeout released the caller while the started write stayed
				// owned by the queue; the log records the fenced release.
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						"timed out; the caller is released and later admitted mutations supersede it",
					),
				)
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

		test("pending child preparation applies its profile without posting an empty task state", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			unrelatedTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(unrelatedTask)
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
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue")
			const setProviderSettingsSpy = vi.spyOn(provider.contextProxy, "setProviderSettings")
			postStateSpy.mockClear()

			await provider.handleModeSwitch("ask" as Mode, null, {
				pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
			})

			expect(setValueSpy).toHaveBeenCalledWith("currentApiConfigName", "ask-profile")
			expect(setValueSpy).toHaveBeenCalledWith(
				"listApiConfigMeta",
				expect.arrayContaining([expect.objectContaining({ name: "ask-profile", id: "ask-id" })]),
			)
			expect(setValueSpy.mock.calls.filter(([key]) => key === "listApiConfigMeta")).toHaveLength(2)
			expect(setProviderSettingsSpy).toHaveBeenCalledWith(
				expect.objectContaining({ openRouterModelId: "openai/gpt-4.1-mini" }),
			)
			expect(provider["providerSettingsManager"].activateProfile).toHaveBeenCalledWith({ name: "ask-profile" })
			expect(unrelatedTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(unrelatedTask.setTaskApiConfigName).not.toHaveBeenCalled()
			expect(unrelatedTask["_taskMode"]).toBe("code")
			expect(updateTaskHistorySpy).not.toHaveBeenCalled()
			expect(postStateSpy).not.toHaveBeenCalled()
		})

		test("pending child preparation restores the previous mode when profile lookup rejects", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			unrelatedTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(unrelatedTask)
			await provider.contextProxy.setValue("mode", "code")
			const lookupError = new Error("profile lookup failed")
			provider["providerSettingsManager"].getModeConfigId = vi.fn().mockRejectedValue(lookupError)
			const emitSpy = vi.spyOn(provider, "emit")
			vi.mocked(mockContext.globalState.update).mockClear()

			await expect(
				provider.handleModeSwitch("ask" as Mode, null, {
					pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
				}),
			).rejects.toThrow(lookupError)

			const modeWrites = vi.mocked(mockContext.globalState.update).mock.calls.filter(([key]) => key === "mode")
			expect(modeWrites).toEqual([
				["mode", "ask"],
				["mode", "code"],
			])
			expect(provider.contextProxy.getValue("mode")).toBe("code")
			expect(unrelatedTask["_taskMode"]).toBe("code")
			expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "ask")
			expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
		})

		test("pending child preparation tolerates a current profile missing from configuration metadata", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			await provider.addClineToStack(unrelatedTask)
			await provider.contextProxy.setValue("currentApiConfigName", "missing-config")

			await expect(
				provider.handleModeSwitch("ask" as Mode, null, {
					pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
				}),
			).resolves.toBeUndefined()

			expect(provider["providerSettingsManager"].setModeConfig).not.toHaveBeenCalled()
		})

		test("pending child preparation keeps the current profile when the mode has no saved profile", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			unrelatedTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(unrelatedTask)
			await provider.contextProxy.setValue("currentApiConfigName", "test-config")
			provider["providerSettingsManager"].listConfig = vi.fn().mockResolvedValue([
				{ name: "other-config", id: "other-id", apiProvider: providerIdentifiers.openrouter },
				{ name: "test-config", id: "test-id", apiProvider: providerIdentifiers.openrouter },
			])
			const activateProfileSpy = vi.spyOn(provider["providerSettingsManager"], "activateProfile")
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			postStateSpy.mockClear()

			await provider.handleModeSwitch("ask" as Mode, null, {
				pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
			})

			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "ask")
			expect(provider["providerSettingsManager"].setModeConfig).toHaveBeenCalledWith("ask", "test-id")
			expect(activateProfileSpy).not.toHaveBeenCalled()
			expect(unrelatedTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(unrelatedTask.setTaskApiConfigName).not.toHaveBeenCalled()
			expect(unrelatedTask["_taskMode"]).toBe("code")
			expect(postStateSpy).not.toHaveBeenCalled()
		})

		test("pending child preparation leaves an unsaved mode unassigned without a current profile", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			unrelatedTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(unrelatedTask)
			await provider.contextProxy.setValue("currentApiConfigName", undefined)
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			postStateSpy.mockClear()

			await provider.handleModeSwitch("ask" as Mode, null, {
				pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
			})

			expect(provider["providerSettingsManager"].setModeConfig).not.toHaveBeenCalled()
			expect(unrelatedTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(unrelatedTask["_taskMode"]).toBe("code")
			expect(postStateSpy).not.toHaveBeenCalled()
		})

		test("pending child preparation preserves the locked profile without posting state", async () => {
			const unrelatedTask = new Task(defaultTaskOptions)
			unrelatedTask["_taskMode"] = "code" as Mode
			await provider.addClineToStack(unrelatedTask)
			vi.mocked(mockContext.workspaceState.get).mockReturnValue(true)
			const getModeConfigIdSpy = vi.spyOn(provider["providerSettingsManager"], "getModeConfigId")
			const activateProfileSpy = vi.spyOn(provider["providerSettingsManager"], "activateProfile")
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			postStateSpy.mockClear()

			await provider.handleModeSwitch("ask" as Mode, null, {
				pendingHandoff: PRODUCTION_PROVIDER_HANDOFF_POLICY,
			})

			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "ask")
			expect(getModeConfigIdSpy).not.toHaveBeenCalled()
			expect(activateProfileSpy).not.toHaveBeenCalled()
			expect(unrelatedTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(unrelatedTask.setTaskApiConfigName).not.toHaveBeenCalled()
			expect(unrelatedTask["_taskMode"]).toBe("code")
			expect(postStateSpy).not.toHaveBeenCalled()

			await provider.handleModeSwitch("architect" as Mode, null)
			expect(postStateSpy).not.toHaveBeenCalled()

			await provider.handleModeSwitch("architect" as Mode, unrelatedTask)
			expect(postStateSpy).toHaveBeenCalledOnce()
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

		test("suppresses only explicitly suppressed profile state posts", async () => {
			const mockTask = new Task(defaultTaskOptions)
			await provider.addClineToStack(mockTask)
			const postStateSpy = vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
			postStateSpy.mockClear()

			await provider.activateProviderProfile({ name: "test-config" }, { suppressStatePost: true })
			expect(postStateSpy).not.toHaveBeenCalled()

			await provider.activateProviderProfile({ name: "test-config" })
			expect(postStateSpy).toHaveBeenCalledOnce()
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

	describe("delegateParentAndOpenChild - nested root handoff", () => {
		test("real mode-switch handoff publishes no state and leaves the exposed root task untouched", async () => {
			// Nested registry topology: root at the bottom, parent focused on top.
			const rootTask = new Task(defaultTaskOptions)
			Object.defineProperty(rootTask, "taskId", { value: "root-task-id" })
			rootTask["_taskMode"] = "code" as Mode
			rootTask["_taskApiConfigName"] = "test-config"

			const parentTask = new Task(defaultTaskOptions)
			Object.defineProperty(parentTask, "taskId", { value: "parent-task-id" })
			parentTask["_taskMode"] = "code" as Mode
			Object.defineProperty(parentTask, "flushPendingToolResultsToHistory", {
				value: vi.fn().mockResolvedValue(true),
			})

			await provider.addClineToStack(rootTask)
			await provider.addClineToStack(parentTask)
			expect(provider.getCurrentTask()).toBe(parentTask)

			// External system only: the store executes the delegation updater and
			// returns the parent and root histories.
			const parentHistory: HistoryItem = {
				id: "parent-task-id",
				number: 2,
				ts: 2,
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "active",
				mode: "code",
				childIds: [],
			}
			const rootHistory: HistoryItem = {
				id: "root-task-id",
				number: 1,
				ts: 1,
				task: "Root",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "active",
				mode: "code",
				childIds: ["parent-task-id"],
			}
			const atomicUpdateSpy = vi
				.spyOn(provider.taskHistoryStore, "atomicReadAndUpdate")
				.mockImplementation(async (_taskId: string, updater: (current: HistoryItem) => HistoryItem) => [
					updater(parentHistory),
					rootHistory,
				])

			// createTask double: an inert child whose insertion reproduces the real
			// stack transition through the real addClineToStack.
			const child = new Task({ ...defaultTaskOptions })
			Object.defineProperty(child, "taskId", { value: "child-task-id" })
			child["_taskMode"] = "code" as Mode
			Object.defineProperty(child, "run", { value: vi.fn().mockResolvedValue(undefined) })
			const createTaskSpy = vi.spyOn(provider, "createTask").mockImplementation(async () => {
				await provider.addClineToStack(child)
				return child
			})

			// Snapshot the newly exposed root task before delegation.
			const rootTaskModeBefore = rootTask["_taskMode"]
			const rootApiConfigurationBefore = rootTask.apiConfiguration
			const rootStickyProfileBefore = rootTask["_taskApiConfigName"]
			const rootClineMessagesBefore = rootTask.clineMessages
			const rootApiHistoryBefore = rootTask.apiConversationHistory

			// Spy without replacing the implementation: the handoff must not
			// publish any state.
			const postStateSpy = vi.spyOn(provider, "postStateToWebview")

			const childResult = await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			// Drain the fire-and-forget scheduler so the inert child start settles.
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			expect(childResult).toBe(child)
			expect(createTaskSpy).toHaveBeenCalledWith("Do child work", undefined, parentTask, {
				initialTodos: [],
				initialStatus: "active",
				startTask: false,
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "test-config",
					apiConfiguration: expect.anything(),
				},
			})
			expect(atomicUpdateSpy).toHaveBeenCalledTimes(1)

			// The prepared context became authoritative on the paused child after
			// the durable commit.
			expect(child.adoptHandoffExecutionContext).toHaveBeenCalledWith({
				mode: "ask",
				apiConfigName: "test-config",
				apiConfiguration: expect.anything(),
			})

			// The mode/profile projection is a post-commit legacy write: it happens
			// only after the atomic delegation commit, and no state is published at
			// any point during the delegation.
			expect(mockContext.globalState.update).toHaveBeenCalledWith("mode", "ask")
			const globalUpdateMock = vi.mocked(mockContext.globalState.update)
			const modeWriteIndex = globalUpdateMock.mock.calls.findIndex(([key]) => key === "mode")
			expect(modeWriteIndex).toBeGreaterThanOrEqual(0)
			expect(globalUpdateMock.mock.invocationCallOrder[modeWriteIndex]).toBeGreaterThan(
				atomicUpdateSpy.mock.invocationCallOrder[0],
			)
			expect(postStateSpy).not.toHaveBeenCalled()

			// The stack transitioned parent -> child through the real addClineToStack,
			// exposing the root beneath.
			expect(provider.getCurrentTaskStack()).toEqual(["root-task-id", "child-task-id"])
			expect(provider.getCurrentTask()).toBe(child)

			// The exposed root task kept its identity and values: no mode, profile,
			// API configuration, or history mutation.
			expect(rootTask["_taskMode"]).toBe(rootTaskModeBefore)
			expect(rootTask.apiConfiguration).toBe(rootApiConfigurationBefore)
			expect(rootTask.apiConfiguration).toEqual(rootApiConfigurationBefore)
			expect(rootTask["_taskApiConfigName"]).toBe(rootStickyProfileBefore)
			expect(rootTask.clineMessages).toBe(rootClineMessagesBefore)
			expect(rootTask.apiConversationHistory).toBe(rootApiHistoryBefore)
			expect(rootTask.updateApiConfiguration).not.toHaveBeenCalled()
			expect(rootTask.setTaskApiConfigName).not.toHaveBeenCalled()
		})
	})

	describe("delegateParentAndOpenChild - provider handoff transaction", () => {
		/** Sole-parent topology for transaction-level assertions. */
		async function setupSoleParentDelegation() {
			const parentTask = new Task(defaultTaskOptions)
			Object.defineProperty(parentTask, "taskId", { value: "parent-task-id" })
			parentTask["_taskMode"] = "code" as Mode
			Object.defineProperty(parentTask, "flushPendingToolResultsToHistory", {
				value: vi.fn().mockResolvedValue(true),
			})
			await provider.addClineToStack(parentTask)
			await provider.contextProxy.setValue("mode", "code")

			const child = new Task({ ...defaultTaskOptions })
			Object.defineProperty(child, "taskId", { value: "child-task-id" })
			child["_taskMode"] = "code" as Mode
			Object.defineProperty(child, "run", { value: vi.fn().mockResolvedValue(undefined) })

			const parentHistory: HistoryItem = {
				id: "parent-task-id",
				number: 1,
				ts: 1,
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "active",
				mode: "code",
				childIds: [],
			}
			const atomicUpdateSpy = vi
				.spyOn(provider.taskHistoryStore, "atomicReadAndUpdate")
				.mockImplementation(async (_taskId: string, updater: (current: HistoryItem) => HistoryItem) => [
					updater(parentHistory),
				])
			const createTaskSpy = vi.spyOn(provider, "createTask").mockImplementation(async () => {
				await provider.addClineToStack(child)
				return child
			})

			return { parentTask, child, atomicUpdateSpy, createTaskSpy }
		}

		test("preparation failure keeps the parent current with every store unchanged and publishes nothing", async () => {
			const { parentTask, atomicUpdateSpy, createTaskSpy } = await setupSoleParentDelegation()

			const preparationError = new Error("profile snapshot failed")
			provider["providerSettingsManager"].snapshotForHandoff = vi.fn().mockRejectedValue(preparationError)
			const postStateSpy = vi.spyOn(provider, "postStateToWebview")
			const emitSpy = vi.spyOn(provider, "emit")
			vi.mocked(mockContext.globalState.update).mockClear()
			vi.mocked(mockContext.secrets.store).mockClear()

			await expect(
				provider.delegateParentAndOpenChild({
					parentTaskId: "parent-task-id",
					message: "Do child work",
					initialTodos: [],
					mode: "ask",
				}),
			).rejects.toThrow(preparationError)

			// Fail closed: the parent was never removed.
			expect(provider.getCurrentTask()).toBe(parentTask)
			expect(createTaskSpy).not.toHaveBeenCalled()
			expect(atomicUpdateSpy).not.toHaveBeenCalled()

			// No store was touched and nothing was published.
			expect(mockContext.globalState.update).not.toHaveBeenCalled()
			expect(mockContext.secrets.store).not.toHaveBeenCalled()
			expect(provider["providerSettingsManager"].projectHandoffState).not.toHaveBeenCalled()
			expect(postStateSpy).not.toHaveBeenCalled()
			expect(emitSpy).not.toHaveBeenCalledWith(
				RooCodeEventName.TaskDelegated,
				"parent-task-id",
				expect.anything(),
			)
		})

		test("a saved profile passes the full configuration with its sentinel secret to the child", async () => {
			const { child, atomicUpdateSpy, createTaskSpy } = await setupSoleParentDelegation()

			provider["providerSettingsManager"].snapshotForHandoff = vi.fn().mockResolvedValue({
				currentApiConfigName: "test-config",
				entries: [{ name: "ask-profile", id: "ask-id", apiProvider: providerIdentifiers.openrouter }],
				modeApiConfigId: "ask-id",
				savedProfile: {
					name: "ask-profile",
					id: "ask-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
					openRouterApiKey: "sk-handoff-sentinel-987654",
				},
			})
			vi.mocked(mockContext.globalState.update).mockClear()

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			const creationOptions = createTaskSpy.mock.calls[0]?.[3]
			if (!creationOptions) {
				throw new Error("expected createTask to have been called")
			}
			expect(creationOptions).toMatchObject({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "ask-profile",
				},
			})
			// The full saved profile data — including the provider secret field —
			// reaches the child's construction configuration.
			expect(creationOptions.handoffExecutionContext?.apiConfiguration).toMatchObject({
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4",
				openRouterApiKey: "sk-handoff-sentinel-987654",
			})

			// The prepared context is authoritative on the child after the commit.
			expect(child.adoptHandoffExecutionContext).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: "ask",
					apiConfigName: "ask-profile",
					apiConfiguration: expect.objectContaining({ openRouterApiKey: "sk-handoff-sentinel-987654" }),
				}),
			)

			// Post-commit legacy projections only: current profile and durable mode
			// mapping are written after the atomic commit, never before it.
			expect(mockContext.globalState.update).toHaveBeenCalledWith("currentApiConfigName", "ask-profile")
			expect(provider["providerSettingsManager"].projectHandoffState).toHaveBeenCalledWith({
				intent: { kind: "set", name: "ask-profile" },
				mode: "ask",
				modeConfigId: "ask-id",
			})
			const globalUpdateMock = vi.mocked(mockContext.globalState.update)
			const modeWriteIndex = globalUpdateMock.mock.calls.findIndex(([key]) => key === "mode")
			expect(modeWriteIndex).toBeGreaterThanOrEqual(0)
			expect(globalUpdateMock.mock.invocationCallOrder[modeWriteIndex]).toBeGreaterThan(
				atomicUpdateSpy.mock.invocationCallOrder[0],
			)
		})

		test("the locked profile keeps the current configuration and persists no mode mapping", async () => {
			const { createTaskSpy } = await setupSoleParentDelegation()

			vi.mocked(mockContext.workspaceState.get).mockReturnValue(true)
			vi.mocked(mockContext.globalState.update).mockClear()

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			const creationOptions = createTaskSpy.mock.calls[0]?.[3]
			if (!creationOptions) {
				throw new Error("expected createTask to have been called")
			}
			expect(creationOptions).toMatchObject({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "test-config",
				},
			})
			// Locked: the child continues with the current context configuration.
			expect(creationOptions.handoffExecutionContext?.apiConfiguration).toEqual(
				provider.contextProxy.getProviderSettings(),
			)

			// A locked handoff carries an explicit preserve intent: no profile
			// write at all — and with the pin engaged there is no mode mapping
			// to persist either, so the durable store is never touched.
			expect(provider["providerSettingsManager"].projectHandoffState).not.toHaveBeenCalled()
			expect(provider["providerSettingsManager"].snapshotForHandoff).toHaveBeenCalledWith("ask")
		})

		test("a ContextProxy projection failure keeps the committed child current and publication derives child values", async () => {
			const { child } = await setupSoleParentDelegation()

			const projectionError = new Error("context write failed")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue").mockRejectedValueOnce(projectionError)
			const logSpy = vi.spyOn(provider, "log")

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			// The projection failed at the ContextProxy boundary...
			expect(setValueSpy).toHaveBeenCalled()
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Post-commit handoff projection failed"))

			// ...but the committed child remains current, started, and authoritative.
			expect(provider.getCurrentTask()).toBe(child)
			expect(child.run).toHaveBeenCalledTimes(1)
			const staleMarker = provider["staleProviderHandoffProjection"]
			expect(staleMarker).toMatchObject({ childTaskId: "child-task-id", requestedMode: "ask" })

			// Publication derives the child's execution fields from the prepared
			// context instead of the stale partial global state.
			const state = await provider.getStateToPostToWebview({ includeTaskHistory: false })
			expect(state.mode).toBe("ask")
			expect(state.currentApiConfigName).toBe("test-config")
			expect(state.apiConfiguration).toEqual(staleMarker?.apiConfiguration)
		})

		test("a later successful same-child mode mutation supersedes the stale projection marker", async () => {
			const { child } = await setupSoleParentDelegation()

			const projectionError = new Error("context write failed")
			const setValueSpy = vi.spyOn(provider.contextProxy, "setValue").mockRejectedValueOnce(projectionError)

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			// The failed projection left a stale marker and publication overlays it.
			expect(provider["staleProviderHandoffProjection"]).toMatchObject({ childTaskId: "child-task-id" })
			const stateBefore = await provider.getStateToPostToWebview({ includeTaskHistory: false })
			expect(stateBefore.mode).toBe("ask")

			// The user switches the child's mode: the mutation runs on the same
			// bounded queue and succeeds, so it supersedes the older marker.
			await provider["enqueueProviderProfileMutation"].call(provider, async () => {
				await provider.contextProxy.setValue("mode", "code")
			})

			expect(provider["staleProviderHandoffProjection"]).toBeUndefined()
			// Publication returns the new values, never the stale snapshot.
			const stateAfter = await provider.getStateToPostToWebview({ includeTaskHistory: false })
			expect(stateAfter.mode).toBe("code")
			expect(stateAfter.currentApiConfigName).toBe("test-config")
			expect(setValueSpy).toHaveBeenCalledWith("mode", "code")
			expect(child.run).toHaveBeenCalledTimes(1)
		})

		test("a profile-store projection failure is logged redacted and never undoes the delegation", async () => {
			const { child } = await setupSoleParentDelegation()

			const sentinel = "sk-handoff-sentinel-246810"
			provider["providerSettingsManager"].snapshotForHandoff = vi.fn().mockResolvedValue({
				currentApiConfigName: "test-config",
				entries: [{ name: "ask-profile", id: "ask-id", apiProvider: providerIdentifiers.openrouter }],
				modeApiConfigId: "ask-id",
				savedProfile: {
					name: "ask-profile",
					id: "ask-id",
					apiProvider: providerIdentifiers.openrouter,
					openRouterApiKey: sentinel,
				},
			})
			const projectionError = new Error(`durable store rejected ${sentinel}`)
			provider["providerSettingsManager"].projectHandoffState = vi.fn().mockRejectedValue(projectionError)
			const logSpy = vi.spyOn(provider, "log")

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-task-id",
				message: "Do child work",
				initialTodos: [],
				mode: "ask",
			})
			await Promise.resolve()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))

			// Delegation stays committed; the child started with the exact snapshot.
			expect(provider.getCurrentTask()).toBe(child)
			expect(child.run).toHaveBeenCalledTimes(1)
			expect(child.adoptHandoffExecutionContext).toHaveBeenCalledWith(
				expect.objectContaining({ apiConfiguration: expect.objectContaining({ openRouterApiKey: sentinel }) }),
			)

			// The failure is logged redacted: no secret value appears in any log.
			const logged = logSpy.mock.calls.map((call) => call.join(" ")).join("\n")
			expect(logged).toContain("Post-commit handoff projection failed")
			expect(logged).not.toContain(sentinel)

			// Publication reports the child's saved profile despite the stale global projection.
			const state = await provider.getStateToPostToWebview({ includeTaskHistory: false })
			expect(state.mode).toBe("ask")
			expect(state.currentApiConfigName).toBe("ask-profile")
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

	describe("createTask - one configuration source", () => {
		test("derives the mistake limit from the resolved handoff configuration, not global state", async () => {
			// The pre-handoff global configuration carries a different limit than
			// the prepared handoff profile.
			await provider.contextProxy.setValue("consecutiveMistakeLimit", 7)
			vi.mocked(Task).mockClear()

			await provider.createTask("Child work", undefined, undefined, {
				startTask: false,
				handoffExecutionContext: {
					mode: "code",
					apiConfigName: "handoff-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4",
						consecutiveMistakeLimit: 3,
					},
				},
			})

			// The API handler is built from the resolved handoff configuration;
			// every profile-derived constructor input must come from the SAME
			// source, so the child is constructed with the handoff profile's
			// limit — never the stale global one.
			const constructorOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(constructorOptions?.apiConfiguration).toMatchObject({ consecutiveMistakeLimit: 3 })
			expect(constructorOptions?.consecutiveMistakeLimit).toBe(3)
		})

		test("ordinary (non-handoff) tasks still derive the limit from global state", async () => {
			await provider.contextProxy.setValue("consecutiveMistakeLimit", 7)
			vi.mocked(Task).mockClear()

			await provider.createTask("Ordinary work", undefined, undefined, { startTask: false })

			// Control: without a handoff context the global configuration is the
			// source of truth, unchanged from previous behavior.
			const constructorOptions = vi.mocked(Task).mock.calls.at(-1)?.[0]
			expect(constructorOptions?.apiConfiguration).toMatchObject({ consecutiveMistakeLimit: 7 })
			expect(constructorOptions?.consecutiveMistakeLimit).toBe(7)
		})
	})
})
