// npx vitest core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts

import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"
import { getModelId, RooCodeEventName } from "@roo-code/types"

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
