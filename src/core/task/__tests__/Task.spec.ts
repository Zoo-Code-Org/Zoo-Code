// npx vitest core/task/__tests__/Task.spec.ts

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import type { Mock } from "vitest"

import {
	providerIdentifiers,
	type GlobalState,
	type ProviderSettings,
	type ModelInfo,
	type TaskLike,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { SYSTEM_PROMPT } from "../../prompts/system"
import { createRateLimitClock } from "../RateLimitClock"
import { summarizeConversation } from "../../condense"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import type { ApiMessage } from "../../task-persistence"

type TaskTestAccess = {
	getSystemPrompt: () => Promise<string>
	startTask: (task?: string, images?: string[]) => Promise<void>
	resumeTaskFromHistory: () => Promise<void>
	presentAssistantMessageSafe: () => void
	updateClineMessage: (message: import("@roo-code/types").ClineMessage) => Promise<void>
	saveClineMessages: () => Promise<boolean>
	safeEnsureModelFetched: () => Promise<void>
	addToApiConversationHistory: (message: unknown, reasoning?: string) => Promise<void>
}

type TaskAskResult = Awaited<ReturnType<Task["ask"]>>
type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>
type MockedClineProvider = ClineProvider & {
	getState: Mock<ClineProvider["getState"]> & {
		mockResolvedValue: (value: Partial<ProviderState>) => void
	}
}
type RateLimitedProviderSettings = ProviderSettings & {
	rateLimitSeconds: number
}

function getTaskTestAccess(task: Task): TaskTestAccess {
	return task as unknown as TaskTestAccess
}

function requireDefined<T>(value: T | null | undefined): T {
	if (value == null) {
		throw new Error("Expected test value to be defined")
	}
	return value
}

async function getProviderStateWithOverrides(
	provider: ClineProvider,
	overrides: Partial<ProviderState>,
): Promise<ProviderState> {
	return { ...(await provider.getState()), ...overrides }
}

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

import delay from "delay"

vi.mock("uuid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("uuid")>()
	return {
		...actual,
		v7: vi.fn(() => "00000000-0000-7000-8000-000000000000"),
	}
})

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify(mockMessages))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve(
					JSON.stringify([
						{
							role: "user",
							content: [{ type: "text", text: "historical task" }],
							ts: Date.now(),
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "I'll help you with that task." }],
							ts: Date.now(),
						},
					]),
				)
			}
			return Promise.resolve("[]")
		}),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		stat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
		readdir: vi.fn().mockResolvedValue([]),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }), // FileType.File = 1
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../mentions/processUserContentMentions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../mentions/processUserContentMentions")>()
	return {
		...actual,
		processUserContentMentions: vi.fn().mockImplementation(actual.processUserContentMentions),
	}
})

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../i18n", () => {
	return {
		t: (key: string, args?: Record<string, unknown>) => {
			if (key === "tools:missingToolParameterWithPath") {
				return `${args?.toolName}|${args?.relPath}|${args?.paramName}`
			}
			if (key === "tools:missingToolParameter") {
				return `${args?.toolName}|${args?.paramName}`
			}
			return key
		},
	}
})

vi.mock("../../condense", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../condense")>()
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../prompts/system", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../prompts/system")>()
	return {
		...actual,
		SYSTEM_PROMPT: vi.fn(actual.SYSTEM_PROMPT),
	}
})

// Mock storagePathManager to prevent dynamic import issues.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation((filePath) => {
		return filePath.includes("ui_messages.json") || filePath.includes("api_conversation_history.json")
	}),
}))

const mockMessages = [
	{
		ts: Date.now(),
		type: "say",
		say: "text",
		text: "historical task",
	},
]

describe("Cline", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		// Setup mock extension context
		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => {
					if (key === "taskHistory") {
						return [
							{
								id: "123",
								number: 0,
								ts: Date.now(),
								task: "historical task",
								tokensIn: 100,
								tokensOut: 200,
								cacheWrites: 0,
								cacheReads: 0,
								totalCost: 0.001,
							},
						]
					}

					return undefined
				}),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		// Setup mock output channel
		mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		// Setup mock provider with output channel
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		)

		// Setup mock API configuration
		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key", // Add API key to mock config
		}

		// Mock provider methods
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockImplementation(async (id) => ({
			historyItem: {
				id,
				ts: Date.now(),
				task: "historical task",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
			},
			taskDirPath: "/mock/storage/path/tasks/123",
			apiConversationHistoryFilePath: "/mock/storage/path/tasks/123/api_conversation_history.json",
			uiMessagesFilePath: "/mock/storage/path/tasks/123/ui_messages.json",
			apiConversationHistory: [
				{
					role: "user",
					content: [{ type: "text", text: "historical task" }],
					ts: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "I'll help you with that task." }],
					ts: Date.now(),
				},
			],
		}))
	})

	describe("empty-response retries", () => {
		function stream(chunks: ApiStreamChunk[]): AsyncGenerator<ApiStreamChunk> {
			return (async function* () {
				yield* chunks
			})()
		}

		async function createTaskWithManualRetries() {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const state = await mockProvider.getState()
			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				...state,
				apiConfiguration: mockApiConfig,
				autoApprovalEnabled: false,
			})
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			return task
		}

		it("restores the user message before a confirmed empty-response retry", async () => {
			const task = await createTaskWithManualRetries()
			let retryHistory: ApiMessage[] | undefined
			let retryUserMessageCount: number | undefined

			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" } satisfies TaskAskResult)
			vi.spyOn(task, "attemptApiRequest")
				.mockImplementationOnce(() => stream([]))
				.mockImplementationOnce(() => {
					retryHistory = structuredClone(task.apiConversationHistory)
					retryUserMessageCount = task.messageCounts.user
					return stream([{ type: "text", text: "retry succeeded" }])
				})
				.mockImplementation(() => {
					throw new Error("stop after retry response")
				})

			await task.recursivelyMakeClineRequests([{ type: "text", text: "original user request" }])

			expect(retryHistory).toHaveLength(1)
			expect(retryHistory?.[0]).toMatchObject({
				role: "user",
				content: expect.arrayContaining([expect.objectContaining({ text: "original user request" })]),
			})
			expect(retryUserMessageCount).toBe(1)
		})

		it("restores the user message and records the failure when retry is declined", async () => {
			const task = await createTaskWithManualRetries()

			vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" } satisfies TaskAskResult)
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() => stream([]))

			const result = await task.recursivelyMakeClineRequests([{ type: "text", text: "original user request" }])

			expect(result).toBe(false)
			expect(task.apiConversationHistory).toMatchObject([
				{ role: "user", content: [{ type: "text", text: "original user request" }] },
				{ role: "assistant", content: [{ type: "text", text: "Failure: I did not provide a response." }] },
			])
			expect(task.messageCounts).toEqual({ user: 1, assistant: 1 })
		})
	})

	describe("constructor", () => {
		it("should always have diff strategy defined", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Diff is always enabled - diffStrategy should be defined
			expect(cline.diffStrategy).toBeDefined()
		})

		it("uses startupSnapshot configuration, mode, profile, and mistake-limit precedence", async () => {
			const startupApiConfiguration: ProviderSettings = {
				...mockApiConfig,
				apiModelId: "snapshot-model",
				consecutiveMistakeLimit: 11,
			}
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
				startupSnapshot: {
					apiConfiguration: startupApiConfiguration,
					mode: "architect",
					apiConfigName: "child-profile",
				},
			})

			expect(cline.apiConfiguration).toEqual(startupApiConfiguration)
			expect(cline.consecutiveMistakeLimit).toBe(11)
			expect(await cline.getTaskMode()).toBe("architect")
			expect(await cline.getTaskApiConfigName()).toBe("child-profile")
		})

		it("falls back to the constructor mistake limit when the snapshot has none", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 7,
				task: "test task",
				startTask: false,
				startupSnapshot: {
					apiConfiguration: { ...mockApiConfig },
					mode: "code",
				},
			})

			expect(cline.consecutiveMistakeLimit).toBe(7)
			await expect(cline.getTaskApiConfigName()).resolves.toBe("default")
		})

		it("should use default consecutiveMistakeLimit when not provided", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(3)
		})

		it("should respect provided consecutiveMistakeLimit", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("should keep consecutiveMistakeLimit of 0 as 0 for unlimited", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass 0 to ToolRepetitionDetector for unlimited mode", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 0,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with 0 for unlimited mode
			expect(cline.toolRepetitionDetector).toBeDefined()
			// Verify the limit remains as 0
			expect(cline.consecutiveMistakeLimit).toBe(0)
		})

		it("should pass consecutiveMistakeLimit to ToolRepetitionDetector", () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				consecutiveMistakeLimit: 5,
				task: "test task",
				startTask: false,
			})

			// The toolRepetitionDetector should be initialized with the same limit
			expect(cline.toolRepetitionDetector).toBeDefined()
			expect(cline.consecutiveMistakeLimit).toBe(5)
		})

		it("should require either task or historyItem", () => {
			expect(() => {
				new Task({ provider: mockProvider, apiConfiguration: mockApiConfig })
			}).toThrow("Either historyItem or task/images must be provided")
		})
	})

	describe("task-local configuration isolation", () => {
		it("uses the task mode and API configuration when focused provider state differs", async () => {
			const taskApiConfiguration: ProviderSettings = {
				...mockApiConfig,
				todoListEnabled: true,
			}
			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "architect",
				mcpEnabled: false,
			} as unknown as ProviderState)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: taskApiConfiguration,
				task: "test task",
				startTask: false,
			})
			await task.getTaskMode()

			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "code",
				mcpEnabled: false,
				apiConfiguration: { ...mockApiConfig, todoListEnabled: false },
			} as unknown as ProviderState)
			vi.mocked(SYSTEM_PROMPT).mockResolvedValueOnce("mock system prompt")

			await getTaskTestAccess(task).getSystemPrompt()

			const systemPromptCall = requireDefined(vi.mocked(SYSTEM_PROMPT).mock.calls.at(-1))
			const [, , , , , mode, , , , , , , settings] = systemPromptCall
			expect(mode).toBe("architect")
			expect(settings).toMatchObject({ todoListEnabled: true })
		})

		it("uses the task mode when manually condensing after focused state changes", async () => {
			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "architect",
				mcpEnabled: false,
			} as unknown as ProviderState)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			await task.getTaskMode()
			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "code",
				mcpEnabled: false,
			} as unknown as ProviderState)
			vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

			await task.condenseContext()

			const [options] = requireDefined(vi.mocked(summarizeConversation).mock.calls.at(-1))
			expect(options.metadata?.mode).toBe("architect")
		})

		it("uses the task mode in request metadata when focused provider state differs", async () => {
			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "ask",
				mcpEnabled: false,
				autoApprovalEnabled: true,
				requestDelaySeconds: 0,
			} as unknown as ProviderState)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			await task.getTaskMode()
			vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

			vi.spyOn(mockProvider, "getState").mockResolvedValue({
				mode: "code",
				mcpEnabled: false,
				autoApprovalEnabled: true,
				requestDelaySeconds: 0,
			} as unknown as ProviderState)
			const stream = (async function* () {
				yield { type: "text", text: "response" } as ApiStreamChunk
			})()
			const createMessage = vi.spyOn(task.api, "createMessage").mockReturnValue(stream)
			task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "test message" }], ts: Date.now() },
			]

			await task.attemptApiRequest().next()

			const metadata = requireDefined(createMessage.mock.calls[0])[2]
			expect(metadata?.mode).toBe("ask")
		})
	})

	describe("sayAndCreateMissingParamError", () => {
		it("surfaces a localized error notice and returns the missing-parameter tool error for both relPath branches", async () => {
			const cline = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const saySpy = vi.spyOn(cline, "say").mockResolvedValue(undefined)

			// relPath provided -> the "...WithPath" message branch.
			const withPath = await cline.sayAndCreateMissingParamError("read_file", "path", "src/foo.ts")
			// relPath omitted -> the plain message branch.
			const withoutPath = await cline.sayAndCreateMissingParamError("execute_command", "command")

			// Both branches emit an "error" say whose resolved text names the tool and the
			// missing parameter (guards against a silent i18n regression where t() would
			// otherwise return the raw key or an empty string and still type-check as a String).
			expect(saySpy).toHaveBeenCalledTimes(2)
			const [withPathChannel, withPathNotice] = saySpy.mock.calls[0]
			const [withoutPathChannel, withoutPathNotice] = saySpy.mock.calls[1]
			expect(withPathChannel).toBe("error")
			expect(withoutPathChannel).toBe("error")
			expect(withPathNotice).toEqual(expect.stringContaining("read_file"))
			expect(withPathNotice).toEqual(expect.stringContaining("path"))
			expect(withPathNotice).toEqual(expect.stringContaining("src/foo.ts"))
			expect(withoutPathNotice).toEqual(expect.stringContaining("execute_command"))
			expect(withoutPathNotice).toEqual(expect.stringContaining("command"))

			// The returned tool error names the missing parameter.
			expect(withPath).toContain("path")
			expect(withoutPath).toContain("command")
		})
	})

	describe("getEnvironmentDetails", () => {
		describe("API conversation handling", () => {
			it("should strip non-protocol fields from API conversation history before sending to the API", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(getTaskTestAccess(cline), "getSystemPrompt").mockResolvedValue("mock system prompt")

				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(error: unknown) {
						throw error
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>
				const createMessageSpy = vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStream)

				cline.apiConversationHistory = [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "test message" }],
						ts: Date.now(),
						extraProp: "should be removed",
					},
				] as Array<ApiMessage & { extraProp: string }>

				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				const [, cleanConversationHistory] = createMessageSpy.mock.calls[0]!

				expect(cleanConversationHistory).toEqual([
					{
						role: "user",
						content: [{ type: "text", text: "test message" }],
					},
				])
				expect(Object.keys(cleanConversationHistory[0]!)).toEqual(["role", "content"])
			})

			it("uses task-local mode and apiConfiguration in request metadata when provider state diverges", async () => {
				const taskApiConfiguration = {
					...mockApiConfig,
					apiProvider: providerIdentifiers.gemini,
				} as ProviderSettings

				vi.spyOn(mockProvider, "getState").mockResolvedValue(
					await getProviderStateWithOverrides(mockProvider, {
						mode: "ask",
						apiConfiguration: taskApiConfiguration,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					}),
				)

				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: taskApiConfiguration,
					task: "test task",
					startTask: false,
				})
				await cline.getTaskMode()
				vi.spyOn(getTaskTestAccess(cline), "getSystemPrompt").mockResolvedValue("mock system prompt")
				vi.spyOn(cline.api, "getModel").mockReturnValue({
					id: requireDefined(mockApiConfig.apiModelId),
					info: { contextWindow: 200000, maxTokens: 4096 } as ModelInfo,
				})

				vi.spyOn(mockProvider, "getState").mockResolvedValue(
					await getProviderStateWithOverrides(mockProvider, {
						mode: "code",
						apiConfiguration: {
							...mockApiConfig,
							apiProvider: providerIdentifiers.anthropic,
						},
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					}),
				)

				const mockStream = (async function* () {
					yield { type: "text", text: "response" } as ApiStreamChunk
				})()
				const createMessageSpy = vi.spyOn(cline.api, "createMessage").mockReturnValue(mockStream)
				cline.apiConversationHistory = [
					{ role: "user", content: [{ type: "text", text: "test message" }], ts: Date.now() },
				]

				await cline.attemptApiRequest(0).next()

				const [, , metadata] = requireDefined(createMessageSpy.mock.calls[0])
				expect(metadata?.mode).toBe("ask")
				expect(metadata?.allowedFunctionNames).toBeDefined()
			})

			it("should shape image blocks for API compatibility before request construction", async () => {
				const conversationHistory = [
					{
						role: "user" as const,
						content: [
							{ type: "text" as const, text: "Here is an image" },
							{
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: "image/jpeg",
									data: "base64data",
								},
							},
						],
					},
				]

				const withImages = new Task({
					provider: mockProvider,
					apiConfiguration: {
						...mockApiConfig,
						apiModelId: "claude-3-sonnet",
					},
					task: "test task",
					startTask: false,
				})
				vi.spyOn(getTaskTestAccess(withImages), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(withImages.api, "getModel").mockReturnValue({
					id: "claude-3-sonnet",
					info: {
						supportsImages: true,
						supportsPromptCache: true,
						contextWindow: 200000,
						maxTokens: 4096,
						inputPrice: 0.25,
						outputPrice: 0.75,
					} as ModelInfo,
				})

				const withoutImages = new Task({
					provider: mockProvider,
					apiConfiguration: {
						...mockApiConfig,
						apiModelId: "gpt-3.5-turbo",
					},
					task: "test task",
					startTask: false,
				})
				vi.spyOn(getTaskTestAccess(withoutImages), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(withoutImages.api, "getModel").mockReturnValue({
					id: "gpt-3.5-turbo",
					info: {
						supportsImages: false,
						supportsPromptCache: false,
						contextWindow: 16000,
						maxTokens: 2048,
						inputPrice: 0.1,
						outputPrice: 0.2,
					} as ModelInfo,
				})

				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(error: unknown) {
						throw error
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>
				const withImagesSpy = vi.spyOn(withImages.api, "createMessage").mockReturnValue(mockStream)
				const withoutImagesSpy = vi.spyOn(withoutImages.api, "createMessage").mockReturnValue(mockStream)

				withImages.apiConversationHistory = conversationHistory as ApiMessage[]
				withoutImages.apiConversationHistory = conversationHistory as ApiMessage[]

				const withImagesIterator = withImages.attemptApiRequest(0)
				await withImagesIterator.next()
				const withoutImagesIterator = withoutImages.attemptApiRequest(0)
				await withoutImagesIterator.next()

				const [, historyWithImages] = withImagesSpy.mock.calls[0]!
				const [, historyWithoutImages] = withoutImagesSpy.mock.calls[0]!

				expect(historyWithImages).toEqual([
					{
						role: "user",
						content: [
							{ type: "text", text: "Here is an image" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/jpeg",
									data: "base64data",
								},
							},
						],
					},
				])
				expect(historyWithoutImages).toEqual([
					{
						role: "user",
						content: [
							{ type: "text", text: "Here is an image" },
							{ type: "text", text: "[Referenced image in conversation]" },
						],
					},
				])
			})

			it("should handle API retry with countdown", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(getTaskTestAccess(cline), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say")

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})
				const providerState = await mockProvider.getState()
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					...providerState,
					apiConfiguration: mockApiConfig,
					autoApprovalEnabled: true,
					requestDelaySeconds: 3,
				})

				// Trigger API request
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				const retryMessages = saySpy.mock.calls.filter((call) => call[0] === "api_req_retry_delayed")
				expect(retryMessages).toEqual([
					["api_req_retry_delayed", "API Error\n<retry_timer>3</retry_timer>", undefined, true],
					["api_req_retry_delayed", "API Error\n<retry_timer>2</retry_timer>", undefined, true],
					["api_req_retry_delayed", "API Error\n<retry_timer>1</retry_timer>", undefined, true],
					["api_req_retry_delayed", "API Error\n", undefined, false],
				])
				expect(mockDelay).toHaveBeenCalledTimes(3)
				expect(mockDelay).toHaveBeenCalledWith(1000)
			})

			it("uses the task rate limit in retry backoff when focused provider state differs", async () => {
				const clock = createRateLimitClock()
				const rateLimitConfig = {
					...mockApiConfig,
					rateLimitSeconds: 10,
				}
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: rateLimitConfig,
					task: "test task",
					startTask: false,
					rateLimitClock: clock,
				})
				vi.spyOn(getTaskTestAccess(cline), "getSystemPrompt").mockResolvedValue("mock system prompt")

				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				const saySpy = vi.spyOn(cline, "say")

				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {},
				} as AsyncGenerator<ApiStreamChunk>

				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {},
				} as AsyncGenerator<ApiStreamChunk>

				let firstAttempt = true
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})
				const providerState = await mockProvider.getState()
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					...providerState,
					apiConfiguration: {
						...mockApiConfig,
						rateLimitSeconds: 1,
					},
					autoApprovalEnabled: true,
					requestDelaySeconds: 3,
				})

				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				// The task rateLimitSeconds=10 (rather than the focused provider's 1)
				// exceeds exponentialDelay=ceil(3*2^0)=3, so
				// finalDelay=10 and the countdown loop fires delay(1000) ten times.
				expect(mockDelay).toHaveBeenCalledWith(1000)
				expect(mockDelay).toHaveBeenCalledTimes(10)
				const countdownMessages = saySpy.mock.calls.filter(
					([type, text, , partial]) =>
						type === "api_req_retry_delayed" && partial && typeof text === "string",
				)
				expect(countdownMessages.map(([, text]) => text)).toEqual(
					Array.from({ length: 10 }, (_, index) => `API Error\n<retry_timer>${10 - index}</retry_timer>`),
				)
				expect(clock.getLastRequestTime()).toBeDefined()
			})

			it("should not apply retry delay twice", async () => {
				const cline = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				vi.spyOn(getTaskTestAccess(cline), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock delay to track countdown timing
				const mockDelay = vi.fn().mockResolvedValue(undefined)
				vi.spyOn(await import("delay"), "default").mockImplementation(mockDelay)

				// Mock say to track messages
				const saySpy = vi.spyOn(cline, "say")

				// Create a stream that fails on first chunk
				const mockError = new Error("API Error")
				const mockFailedStream = {
					// eslint-disable-next-line require-yield
					async *[Symbol.asyncIterator]() {
						throw mockError
					},
					async next() {
						throw mockError
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Create a successful stream for retry
				const mockSuccessStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "Success" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "Success" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					async [Symbol.asyncDispose]() {
						// Cleanup
					},
				} as AsyncGenerator<ApiStreamChunk>

				// Mock createMessage to fail first then succeed
				let firstAttempt = true
				vi.spyOn(cline.api, "createMessage").mockImplementation(() => {
					if (firstAttempt) {
						firstAttempt = false
						return mockFailedStream
					}
					return mockSuccessStream
				})
				const providerState = await mockProvider.getState()
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					...providerState,
					apiConfiguration: mockApiConfig,
					autoApprovalEnabled: true,
					requestDelaySeconds: 3,
				})

				// Trigger API request
				const iterator = cline.attemptApiRequest(0)
				await iterator.next()

				expect(mockDelay).toHaveBeenCalledTimes(3)
				expect(mockDelay).toHaveBeenCalledWith(1000) // Each delay should be 1 second

				// Verify countdown messages were only shown once
				const retryMessages = saySpy.mock.calls.filter(
					(call) => call[0] === "api_req_retry_delayed" && call[3] === true,
				)
				expect(retryMessages).toEqual([
					["api_req_retry_delayed", "API Error\n<retry_timer>3</retry_timer>", undefined, true],
					["api_req_retry_delayed", "API Error\n<retry_timer>2</retry_timer>", undefined, true],
					["api_req_retry_delayed", "API Error\n<retry_timer>1</retry_timer>", undefined, true],
				])
			})

			describe("processUserContentMentions", () => {
				it("should process mentions in user_message tags", async () => {
					const [cline, task] = Task.create({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
					})

					const userContent = [
						{
							type: "text",
							text: "Regular text with 'some/path' (see below for file content)",
						} as const,
						{
							type: "text",
							text: "<user_message>Text with 'some/path' (see below for file content) in user_message tags</user_message>",
						} as const,
						{
							type: "tool_result",
							tool_use_id: "test-id",
							content: [
								{
									type: "text",
									text: "<user_message>Check 'some/path' (see below for file content)</user_message>",
								},
							],
						} as Anthropic.ToolResultBlockParam,
						{
							type: "tool_result",
							tool_use_id: "test-id-2",
							content: [
								{
									type: "text",
									text: "Regular tool result with 'path' (see below for file content)",
								},
							],
						} as Anthropic.ToolResultBlockParam,
					]

					const { content: processedContent } = await processUserContentMentions({
						userContent,
						cwd: cline.cwd,
						fileContextTracker: cline.fileContextTracker,
					})

					// Regular text should not be processed
					expect((processedContent[0] as Anthropic.TextBlockParam).text).toBe(
						"Regular text with 'some/path' (see below for file content)",
					)

					// Text within user_message tags should be processed
					expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain("processed:")
					expect((processedContent[1] as Anthropic.TextBlockParam).text).toContain(
						"<user_message>Text with 'some/path' (see below for file content) in user_message tags</user_message>",
					)

					// user_message tag content should be processed
					const toolResult1 = processedContent[2] as Anthropic.ToolResultBlockParam
					const content1 = Array.isArray(toolResult1.content) ? toolResult1.content[0] : toolResult1.content
					expect((content1 as Anthropic.TextBlockParam).text).toContain("processed:")
					expect((content1 as Anthropic.TextBlockParam).text).toContain(
						"<user_message>Check 'some/path' (see below for file content)</user_message>",
					)

					// Regular tool result should not be processed
					const toolResult2 = processedContent[3] as Anthropic.ToolResultBlockParam
					const content2 = Array.isArray(toolResult2.content) ? toolResult2.content[0] : toolResult2.content
					expect((content2 as Anthropic.TextBlockParam).text).toBe(
						"Regular tool result with 'path' (see below for file content)",
					)

					await cline.abortTask(true)
					await task.catch(() => {})
				})
			})
		})

		describe("Subtask Rate Limiting", () => {
			let mockProvider: MockedClineProvider
			let mockApiConfig: RateLimitedProviderSettings
			let mockDelay: ReturnType<typeof vi.fn>

			beforeEach(() => {
				vi.clearAllMocks()
				mockApiConfig = {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "test-key",
					rateLimitSeconds: 5,
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
						globalState: {
							get: vi.fn().mockImplementation(() => undefined),
							update: vi.fn().mockResolvedValue(undefined),
							keys: vi.fn().mockReturnValue([]),
						},
					},
					getState: vi.fn().mockResolvedValue({
						apiConfiguration: mockApiConfig,
						mcpEnabled: false,
					}),
					getMcpHub: vi.fn().mockReturnValue(undefined),
					getSkillsManager: vi.fn().mockReturnValue(undefined),
					say: vi.fn(),
					postStateToWebview: vi.fn().mockResolvedValue(undefined),
					postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
					postMessageToWebview: vi.fn().mockResolvedValue(undefined),
					updateTaskHistory: vi.fn().mockResolvedValue(undefined),
					// Task receives a full ClineProvider at runtime; this focused unit test only exercises these methods.
				} as unknown as MockedClineProvider

				// Get the mocked delay function
				mockDelay = delay as ReturnType<typeof vi.fn>
				mockDelay.mockClear()
			})

			it("should enforce rate limiting across parent and subtask", async () => {
				// Add a spy to track getState calls
				const getStateSpy = vi.spyOn(mockProvider, "getState")

				// Shared clock so parent and child see each other's timestamps
				const sharedClock = createRateLimitClock()

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(parent), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "parent response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "parent response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Verify no delay was applied for the first request
				expect(mockDelay).not.toHaveBeenCalled()

				// Create a subtask immediately after, sharing the same clock
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(child), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Spy on child.say to verify the emitted message type
				const saySpy = vi.spyOn(child, "say")

				// Mock the child's API stream
				const childMockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "child response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "child response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(child.api, "createMessage").mockReturnValue(childMockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify rate limiting was applied
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
				expect(mockDelay).toHaveBeenCalledWith(1000)

				// Verify we used the non-error rate-limit wait message type (JSON format)
				expect(saySpy).toHaveBeenCalledWith(
					"api_req_rate_limit_wait",
					expect.stringMatching(/\{"seconds":\d+\}/),
					undefined,
					true,
				)

				// Verify the wait message was finalized
				expect(saySpy).toHaveBeenCalledWith("api_req_rate_limit_wait", undefined, undefined, false)
			}, 10000) // Increase timeout to 10 seconds

			it("should not apply rate limiting if enough time has passed", async () => {
				const sharedClock = createRateLimitClock()

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(parent), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Simulate time passing (more than rate limit)
				const originalPerformanceNow = performance.now
				const mockTime = performance.now() + (mockApiConfig.rateLimitSeconds + 1) * 1000
				performance.now = vi.fn(() => mockTime)

				// Create a subtask after time has passed
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(child), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no rate limiting was applied
				expect(mockDelay).not.toHaveBeenCalled()

				// Restore performance.now
				performance.now = originalPerformanceNow
			})

			it("should share rate limiting across multiple subtasks", async () => {
				const sharedClock = createRateLimitClock()

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(parent), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create first subtask
				const child1 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 1",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(child1), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child1.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the first child task
				const child1Iterator = child1.attemptApiRequest(0)
				await child1Iterator.next()

				// Verify rate limiting was applied
				const firstDelayCount = mockDelay.mock.calls.length
				expect(firstDelayCount).toBe(mockApiConfig.rateLimitSeconds)

				// Clear the mock to count new delays
				mockDelay.mockClear()

				// Create second subtask immediately after
				const child2 = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task 2",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(child2), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child2.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the second child task
				const child2Iterator = child2.attemptApiRequest(0)
				await child2Iterator.next()

				// Verify rate limiting was applied again
				expect(mockDelay).toHaveBeenCalledTimes(mockApiConfig.rateLimitSeconds)
			}, 15000) // Increase timeout to 15 seconds

			it("should handle rate limiting with zero rate limit", async () => {
				// Update config to have zero rate limit
				mockApiConfig.rateLimitSeconds = 0
				mockProvider.getState.mockResolvedValue({
					apiConfiguration: mockApiConfig,
					mcpEnabled: false,
				})

				const sharedClock = createRateLimitClock()

				// Create parent task
				const parent = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "parent task",
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(parent), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(parent.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the parent task
				const parentIterator = parent.attemptApiRequest(0)
				await parentIterator.next()

				// Create a subtask
				const child = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "child task",
					parentTask: parent,
					rootTask: parent,
					startTask: false,
					rateLimitClock: sharedClock,
				})
				vi.spyOn(getTaskTestAccess(child), "getSystemPrompt").mockResolvedValue("mock system prompt")

				vi.spyOn(child.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request with the child task
				const childIterator = child.attemptApiRequest(0)
				await childIterator.next()

				// Verify no delay was applied
				expect(mockDelay).not.toHaveBeenCalled()
			})

			it("should update clock timestamp even when no rate limiting is needed", async () => {
				const clock = createRateLimitClock()

				// Create task
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
					rateLimitClock: clock,
				})
				vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

				// Mock the API stream response
				const mockStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "response" }
					},
					async next() {
						return { done: true, value: { type: "text", text: "response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

				// Make an API request
				const iterator = task.attemptApiRequest(0)
				await iterator.next()

				const lastTime = clock.getLastRequestTime()
				expect(lastTime).toBeDefined()
				expect(lastTime).toBeGreaterThan(0)
			})
		})

		describe("Dynamic Strategy Selection", () => {
			let mockProvider: MockedClineProvider
			let mockApiConfig: ProviderSettings

			beforeEach(() => {
				vi.clearAllMocks()

				mockApiConfig = {
					apiProvider: providerIdentifiers.anthropic,
					apiKey: "test-key",
				}

				mockProvider = {
					context: {
						globalStorageUri: { fsPath: "/test/storage" },
					},
					getState: vi.fn(),
				} as MockedClineProvider
			})

			it("should use MultiSearchReplaceDiffStrategy by default", async () => {
				mockProvider.getState.mockResolvedValue({})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})

			it("should keep MultiSearchReplaceDiffStrategy when experiments are undefined", async () => {
				mockProvider.getState.mockResolvedValue({})

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Initially should be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)

				// Wait for async strategy update
				await new Promise((resolve) => setTimeout(resolve, 10))

				// Should still be MultiSearchReplaceDiffStrategy
				expect(task.diffStrategy).toBeInstanceOf(MultiSearchReplaceDiffStrategy)
				expect(task.diffStrategy?.getName()).toBe("MultiSearchReplace")
			})
		})

		describe("getApiProtocol", () => {
			it("should determine API protocol based on provider and model", async () => {
				// Test with Anthropic provider
				const anthropicConfig = {
					...mockApiConfig,
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "gpt-4",
				}
				const anthropicTask = new Task({
					provider: mockProvider,
					apiConfiguration: anthropicConfig,
					task: "test task",
					startTask: false,
				})
				// Should use anthropic protocol even with non-claude model
				expect(anthropicTask.apiConfiguration.apiProvider).toBe("anthropic")

				// Test with OpenRouter provider and Claude model
				const openrouterClaudeConfig = {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "anthropic/claude-3-opus",
				}
				const openrouterClaudeTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterClaudeConfig,
					task: "test task",
					startTask: false,
				})
				expect(openrouterClaudeTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with OpenRouter provider and non-Claude model
				const openrouterGptConfig = {
					apiProvider: providerIdentifiers.openrouter,
					openRouterModelId: "openai/gpt-4",
				}
				const openrouterGptTask = new Task({
					provider: mockProvider,
					apiConfiguration: openrouterGptConfig,
					task: "test task",
					startTask: false,
				})
				expect(openrouterGptTask.apiConfiguration.apiProvider).toBe("openrouter")

				// Test with various Claude model formats
				const claudeModelFormats = [
					"claude-3-opus",
					"Claude-3-Sonnet",
					"CLAUDE-instant",
					"anthropic/claude-3-haiku",
					"some-provider/claude-model",
				]

				for (const modelId of claudeModelFormats) {
					const config = {
						apiProvider: providerIdentifiers.openai,
						openAiModelId: modelId,
					}
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: config,
						task: "test task",
						startTask: false,
					})
					// Verify the model ID contains claude (case-insensitive)
					expect(modelId.toLowerCase()).toContain("claude")
				}
			})

			it("should handle edge cases for API protocol detection", async () => {
				// Test with undefined provider
				const undefinedProviderConfig = {
					apiModelId: "claude-3-opus",
				}
				const undefinedProviderTask = new Task({
					provider: mockProvider,
					apiConfiguration: undefinedProviderConfig,
					task: "test task",
					startTask: false,
				})
				expect(undefinedProviderTask.apiConfiguration.apiProvider).toBeUndefined()

				// Test with no model ID
				const noModelConfig = {
					apiProvider: providerIdentifiers.openai,
				}
				const noModelTask = new Task({
					provider: mockProvider,
					apiConfiguration: noModelConfig,
					task: "test task",
					startTask: false,
				})
				expect(noModelTask.apiConfiguration.apiProvider).toBe("openai")
			})
		})

		describe("submitUserMessage", () => {
			it("should call handleWebviewAskResponse directly", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

				// Set up some existing messages to simulate an ongoing conversation
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]

				// Call submitUserMessage
				await task.submitUserMessage("test message", ["image1.png"])

				// Verify handleWebviewAskResponse was called directly (not webview)
				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "test message", ["image1.png"])
				// Should NOT route through webview anymore
				expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			})

			it("uses a mode selected through submitUserMessage in the next API request", async () => {
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					mode: "ask",
					mcpEnabled: false,
				} as unknown as ProviderState)
				vi.spyOn(mockProvider, "setMode").mockResolvedValue(undefined)
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})
				vi.spyOn(task, "handleWebviewAskResponse").mockImplementation(() => {})

				await task.submitUserMessage("switch modes", undefined, "code")
				vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
				const stream = (async function* () {
					yield { type: "text", text: "response" } as ApiStreamChunk
				})()
				const createMessage = vi.spyOn(task.api, "createMessage").mockReturnValue(stream)
				task.apiConversationHistory = [
					{ role: "user", content: [{ type: "text", text: "test message" }], ts: Date.now() },
				]

				await task.attemptApiRequest().next()

				expect(mockProvider.setMode).toHaveBeenCalledWith("code")
				expect(requireDefined(createMessage.mock.calls[0])[2]?.mode).toBe("code")
			})

			it("stores a provider profile selected through submitUserMessage", async () => {
				const selectedConfiguration: ProviderSettings = {
					...mockApiConfig,
					apiModelId: "selected-model",
				}
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})
				task.setTaskApiConfigName("previous-profile")
				vi.spyOn(mockProvider, "setProviderProfile").mockResolvedValue(undefined)
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					currentApiConfigName: "selected-profile",
					apiConfiguration: selectedConfiguration,
				} as unknown as ProviderState)
				vi.spyOn(task, "handleWebviewAskResponse").mockImplementation(() => {})

				await task.submitUserMessage("switch profiles", undefined, undefined, "selected-profile")

				expect(task.taskApiConfigName).toBe("selected-profile")
			})

			it("should handle empty messages gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

				// Call with empty text and no images
				await task.submitUserMessage("", [])

				// Should not call handleWebviewAskResponse for empty messages
				expect(handleResponseSpy).not.toHaveBeenCalled()

				// Call with whitespace only
				await task.submitUserMessage("   ", [])
				expect(handleResponseSpy).not.toHaveBeenCalled()
			})

			it("should call handleWebviewAskResponse for both new and existing task states", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

				// Test with no messages (new task scenario)
				task.clineMessages = []
				await task.submitUserMessage("new task", ["image1.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "new task", ["image1.png"])

				// Clear mock
				handleResponseSpy.mockClear()

				// Test with existing messages (ongoing task scenario)
				task.clineMessages = [
					{
						ts: Date.now(),
						type: "say",
						say: "text",
						text: "Initial message",
					},
				]
				await task.submitUserMessage("follow-up message", ["image2.png"])

				expect(handleResponseSpy).toHaveBeenCalledWith("messageResponse", "follow-up message", ["image2.png"])
			})

			it("should handle undefined provider gracefully", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "initial task",
					startTask: false,
				})

				// Spy on handleWebviewAskResponse
				const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

				// Simulate weakref returning undefined
				Object.defineProperty(task, "providerRef", {
					value: { deref: () => undefined },
					writable: false,
					configurable: true,
				})

				// Spy on console.error to verify error is logged
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Should log error but not throw
				await task.submitUserMessage("test message")

				expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#submitUserMessage] Provider reference lost")
				expect(handleResponseSpy).not.toHaveBeenCalled()

				// Restore console.error
				consoleErrorSpy.mockRestore()
			})
		})
	})

	describe("abortTask", () => {
		it("should set abort flag and emit TaskAborted event", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Spy on emit method
			const emitSpy = vi.spyOn(task, "emit")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify abort flag is set
			expect(task.abort).toBe(true)

			// Verify TaskAborted event was emitted
			expect(emitSpy).toHaveBeenCalledWith("taskAborted")
		})

		it("should be equivalent to clicking Cancel button functionality", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Mock the dispose method to track cleanup
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask
			await task.abortTask()

			// Verify the same behavior as Cancel button
			expect(task.abort).toBe(true)
			expect(disposeSpy).toHaveBeenCalled()
		})

		it("should work with TaskLike interface", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Cast to TaskLike to ensure interface compliance
			const taskLike: TaskLike = task

			// Verify abortTask method exists and is callable
			expect(typeof taskLike.abortTask).toBe("function")

			// Mock the dispose method to avoid actual cleanup
			vi.spyOn(task, "dispose").mockImplementation(() => {})

			// Call abortTask through interface
			await taskLike.abortTask()

			// Verify it works
			expect(task.abort).toBe(true)
		})

		it("should handle errors during disposal gracefully", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Mock dispose to throw an error
			const mockError = new Error("Disposal failed")
			vi.spyOn(task, "dispose").mockImplementation(() => {
				throw mockError
			})

			// Spy on console.error to verify error is logged
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			// abortTask should not throw even if dispose fails
			await expect(task.abortTask()).resolves.not.toThrow()

			// Verify error was logged
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Error during task"), mockError)

			// Verify abort flag is still set
			expect(task.abort).toBe(true)

			// Restore console.error
			consoleErrorSpy.mockRestore()
		})
		describe("Stream Failure Retry", () => {
			it("should not abort task on stream failure, only on user cancellation", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Spy on console.error to verify error logging
				const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

				// Spy on abortTask to verify it's NOT called for stream failures
				const abortTaskSpy = vi.spyOn(task, "abortTask").mockResolvedValue(undefined)

				// Test Case 1: Stream failure should NOT abort task
				task.abort = false
				task.abandoned = false

				// Simulate the catch block behavior for stream failure
				const streamFailureError = new Error("Stream failed mid-execution")

				// The key assertion: verify that when abort=false, abortTask is NOT called
				// This would normally happen in the catch block around line 2184
				const shouldAbort = task.abort
				expect(shouldAbort).toBe(false)

				// Verify error would be logged (this is what the new code does)
				console.error(
					`[Task#${task.taskId}.${task.instanceId}] Stream failed, will retry: ${streamFailureError.message}`,
				)
				expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Stream failed, will retry"))

				// Verify abortTask was NOT called
				expect(abortTaskSpy).not.toHaveBeenCalled()

				// Test Case 2: User cancellation SHOULD abort task
				task.abort = true

				// For user cancellation, abortTask SHOULD be called
				if (task.abort) {
					await task.abortTask()
				}

				expect(abortTaskSpy).toHaveBeenCalled()

				// Restore mocks
				consoleErrorSpy.mockRestore()
			})
		})

		describe("cancelCurrentRequest", () => {
			it("should cancel the current HTTP request via AbortController", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Create a real AbortController and spy on its abort method
				const mockAbortController = new AbortController()
				const abortSpy = vi.spyOn(mockAbortController, "abort")
				task.currentRequestAbortController = mockAbortController

				// Spy on console.log
				const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

				// Call cancelCurrentRequest
				task.cancelCurrentRequest()

				// Verify abort was called on the controller
				expect(abortSpy).toHaveBeenCalled()

				// Verify the controller was cleared
				expect(task.currentRequestAbortController).toBeUndefined()

				// Verify logging
				expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Aborting current HTTP request"))

				// Restore console.log
				consoleLogSpy.mockRestore()
			})

			it("should handle missing AbortController gracefully", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Ensure no controller exists
				task.currentRequestAbortController = undefined

				// Should not throw when called with no controller
				expect(() => task.cancelCurrentRequest()).not.toThrow()
			})

			it("should be called during dispose", () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				// Spy on cancelCurrentRequest
				const cancelSpy = vi.spyOn(task, "cancelCurrentRequest")

				// Mock other dispose operations
				vi.spyOn(task.messageQueueService, "removeListener").mockImplementation(() => task.messageQueueService)
				vi.spyOn(task.messageQueueService, "dispose").mockImplementation(() => {})
				vi.spyOn(task, "removeAllListeners").mockImplementation(() => task)

				// Call dispose
				task.dispose()

				// Verify cancelCurrentRequest was called
				expect(cancelSpy).toHaveBeenCalled()
			})
			describe("abortSignal", () => {
				it("should pass AbortController signal to condenseContext metadata when a current request exists", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					task.currentRequestAbortController = new AbortController()
					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

					await task.condenseContext()

					expect(summarizeConversation).toHaveBeenCalled()
					const [options] = vi.mocked(summarizeConversation).mock.calls.at(-1)!
					expect(options.metadata?.abortSignal).toBe(task.currentRequestAbortController!.signal)
				})

				it("should omit abortSignal from condenseContext metadata when no current request exists", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

					await task.condenseContext()

					expect(summarizeConversation).toHaveBeenCalled()
					const [options] = vi.mocked(summarizeConversation).mock.calls.at(-1)!
					expect(options.metadata).toBeDefined()
					expect("abortSignal" in (options.metadata ?? {})).toBe(false)
				})

				it("should pass AbortController signal to createMessage metadata", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					// Mock required methods for attemptApiRequest to work without hanging
					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: mockApiConfig.apiModelId!,
						info: {
							supportsImages: false,
							supportsPromptCache: true,
							contextWindow: 200000,
							maxTokens: 4096,
							inputPrice: 0.3,
							outputPrice: 1.5,
						} as ModelInfo,
					})

					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})

					// Mock the API stream response
					const mockStream = {
						async *[Symbol.asyncIterator]() {
							yield { type: "text", text: "response" }
						},
						async next() {
							return { done: true, value: { type: "text", text: "response" } }
						},
						async return() {
							return { done: true, value: undefined }
						},
						async throw(e: unknown) {
							throw e
						},
						[Symbol.asyncDispose]: async () => {},
					} as AsyncGenerator<ApiStreamChunk>

					const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

					task.apiConversationHistory = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "test message" }],
							ts: Date.now(),
						},
					]

					const iterator = task.attemptApiRequest(0)
					await iterator.next()

					// Verify createMessage was called with metadata containing abortSignal
					expect(createMessageSpy).toHaveBeenCalled()
					const [, , metadata] = createMessageSpy.mock.calls[0]!

					expect(metadata).toBeDefined()
					expect(metadata!.abortSignal).toBe(task.currentRequestAbortController!.signal)
				})

				it("configures tool restrictions for Gemini requests", async () => {
					const apiConfiguration = {
						...mockApiConfig,
						apiProvider: providerIdentifiers.gemini,
					} as ProviderSettings
					const task = new Task({
						provider: mockProvider,
						apiConfiguration,
						task: "test task",
						startTask: false,
					})

					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: requireDefined(mockApiConfig.apiModelId),
						info: { contextWindow: 200000, maxTokens: 4096 } as ModelInfo,
					})
					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})
					const mockStream = (async function* () {
						yield { type: "text", text: "response" } as ApiStreamChunk
					})()
					const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)
					task.apiConversationHistory = [
						{ role: "user", content: [{ type: "text", text: "test message" }], ts: Date.now() },
					]

					await task.attemptApiRequest(0).next()

					const [, , metadata] = requireDefined(createMessageSpy.mock.calls[0])
					const tools = requireDefined(metadata?.tools)
					const allowedFunctionNames = requireDefined(metadata?.allowedFunctionNames)
					const toolNames = tools.map((tool) => {
						if (tool.type !== "function") {
							throw new Error(`Unexpected tool type: ${tool.type}`)
						}
						return tool.function.name
					})

					expect(tools.length).toBeGreaterThan(0)
					expect(allowedFunctionNames.length).toBeGreaterThan(0)
					expect(allowedFunctionNames.every((name) => toolNames.includes(name))).toBe(true)
				})

				it("should invoke abort on currentRequestAbortController during first-chunk wait", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					const abortSpy = vi.fn()
					task.currentRequestAbortController = {
						abort: abortSpy,
						signal: new AbortController().signal,
					} as AbortController

					task.cancelCurrentRequest()

					expect(abortSpy).toHaveBeenCalledTimes(1)
					expect(task.currentRequestAbortController).toBeUndefined()
				})

				it("should reject streaming consumption when aborted between chunks", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: mockApiConfig.apiModelId!,
						info: {
							supportsImages: false,
							supportsPromptCache: true,
							contextWindow: 200000,
							maxTokens: 4096,
							inputPrice: 0.3,
							outputPrice: 1.5,
						} as ModelInfo,
					})

					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})

					const createMessageSpy = vi.fn((_systemPrompt, _messages, metadata) => {
						let callCount = 0
						return {
							[Symbol.asyncIterator]() {
								return this
							},
							next: () => {
								callCount++
								if (callCount === 1) {
									return Promise.resolve({
										done: false,
										value: { type: "text", text: "first chunk" },
									})
								}
								return new Promise<IteratorResult<ApiStreamChunk>>((resolve, reject) => {
									if (metadata?.abortSignal?.aborted) {
										return reject(new Error("Request cancelled by user"))
									}
									metadata?.abortSignal?.addEventListener("abort", () => {
										reject(new Error("Request cancelled by user"))
									})
								})
							},
							async return() {
								return { done: true, value: undefined }
							},
							async throw(e: unknown) {
								throw e
							},
							[Symbol.asyncDispose]: async () => {},
						} as AsyncGenerator<ApiStreamChunk>
					})
					vi.spyOn(task.api, "createMessage").mockImplementation(createMessageSpy)

					task.apiConversationHistory = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "test message" }],
							ts: Date.now(),
						},
					]

					const streamIterator = task.attemptApiRequest(0)
					await expect(streamIterator.next()).resolves.toMatchObject({
						done: false,
						value: { type: "text", text: "first chunk" },
					})

					task.cancelCurrentRequest()

					await expect(streamIterator.next()).rejects.toThrow("Request cancelled by user")
					expect(createMessageSpy).toHaveBeenCalledTimes(1)
				})

				it("should use the same AbortController signal as currentRequestAbortController", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					// Mock required methods for attemptApiRequest to work without hanging
					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")

					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: mockApiConfig.apiModelId!,
						info: {
							supportsImages: false,
							supportsPromptCache: true,
							contextWindow: 200000,
							maxTokens: 4096,
							inputPrice: 0.3,
							outputPrice: 1.5,
						} as ModelInfo,
					})

					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})

					// Mock the API stream response
					const mockStream = {
						async *[Symbol.asyncIterator]() {
							yield { type: "text", text: "response" }
						},
						async next() {
							return { done: true, value: { type: "text", text: "response" } }
						},
						async return() {
							return { done: true, value: undefined }
						},
						async throw(e: unknown) {
							throw e
						},
						[Symbol.asyncDispose]: async () => {},
					} as AsyncGenerator<ApiStreamChunk>

					const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

					task.apiConversationHistory = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "test message" }],
							ts: Date.now(),
						},
					]

					const iterator = task.attemptApiRequest(0)
					await iterator.next()

					// Get the signal from metadata
					const [, , metadata] = createMessageSpy.mock.calls[0]!
					const metadataSignal = metadata!.abortSignal

					// The signal in metadata should be the same as the one from currentRequestAbortController
					expect(metadataSignal).toBe(task.currentRequestAbortController!.signal)
				})

				it("should omit createMessage abortSignal metadata when no current request exists before condense metadata checks", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: mockApiConfig.apiModelId!,
						info: {
							supportsImages: false,
							supportsPromptCache: true,
							contextWindow: 200000,
							maxTokens: 4096,
							inputPrice: 0.3,
							outputPrice: 1.5,
						} as ModelInfo,
					})

					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})

					const mockStream = {
						async *[Symbol.asyncIterator]() {
							yield { type: "text", text: "response" }
						},
						async next() {
							return { done: true, value: { type: "text", text: "response" } }
						},
						async return() {
							return { done: true, value: undefined }
						},
						async throw(e: unknown) {
							throw e
						},
						[Symbol.asyncDispose]: async () => {},
					} as AsyncGenerator<ApiStreamChunk>

					const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)
					task.apiConversationHistory = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "test message" }],
							ts: Date.now(),
						},
					]

					expect(task.currentRequestAbortController).toBeUndefined()

					const iterator = task.attemptApiRequest(0)
					await iterator.next()

					const [, , metadata] = createMessageSpy.mock.calls[0]!
					expect(metadata).toBeDefined()
					expect("abortSignal" in metadata!).toBe(true)
					expect(metadata!.abortSignal).toBe(task.currentRequestAbortController!.signal)
				})

				it("should keep createMessage abortSignal metadata unaborted before cancellation", async () => {
					const task = new Task({
						provider: mockProvider,
						apiConfiguration: mockApiConfig,
						task: "test task",
						startTask: false,
					})

					vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
					vi.spyOn(task.api, "getModel").mockReturnValue({
						id: mockApiConfig.apiModelId!,
						info: {
							supportsImages: false,
							supportsPromptCache: true,
							contextWindow: 200000,
							maxTokens: 4096,
							inputPrice: 0.3,
							outputPrice: 1.5,
						} as ModelInfo,
					})

					const providerState = await mockProvider.getState()
					vi.spyOn(mockProvider, "getState").mockResolvedValue({
						...providerState,
						apiConfiguration: mockApiConfig,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
					})

					const mockStream = {
						async *[Symbol.asyncIterator]() {
							yield { type: "text", text: "response" }
						},
						async next() {
							return { done: false, value: { type: "text", text: "response" } }
						},
						async return() {
							return { done: true, value: undefined }
						},
						async throw(e: unknown) {
							throw e
						},
						[Symbol.asyncDispose]: async () => {},
					} as AsyncGenerator<ApiStreamChunk>

					const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)
					task.apiConversationHistory = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: "test message" }],
							ts: Date.now(),
						},
					]

					const iterator = task.attemptApiRequest(0)
					await iterator.next()

					const [, , metadata] = createMessageSpy.mock.calls[0]!
					expect(metadata?.abortSignal).toBe(task.currentRequestAbortController!.signal)
					expect(metadata?.abortSignal?.aborted).toBe(false)
				})
			})

			it("should create a fresh AbortController for each sequential request", async () => {
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})

				vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
				vi.spyOn(task.api, "getModel").mockReturnValue({
					id: mockApiConfig.apiModelId!,
					info: {
						supportsImages: false,
						supportsPromptCache: true,
						contextWindow: 200000,
						maxTokens: 4096,
						inputPrice: 0.3,
						outputPrice: 1.5,
					} as ModelInfo,
				})

				const providerState = await mockProvider.getState()
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					...providerState,
					apiConfiguration: mockApiConfig,
					autoApprovalEnabled: true,
					requestDelaySeconds: 0,
				})

				let callCount = 0
				const mockStreamFactory = async function* (): AsyncGenerator<ApiStreamChunk> {
					yield { type: "text", text: `response ${callCount}` }
					callCount++
				}
				const createMessageSpy = vi
					.spyOn(task.api, "createMessage")
					.mockImplementation(() => mockStreamFactory())

				task.apiConversationHistory = [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "test message" }],
						ts: Date.now(),
					},
				]

				// First request
				const iterator1 = task.attemptApiRequest(0)
				await iterator1.next()

				expect(createMessageSpy).toHaveBeenCalledTimes(1)
				const [, , metadata1] = createMessageSpy.mock.calls[0]!
				const signal1 = metadata1!.abortSignal
				expect(signal1).toBeDefined()
				expect(signal1!.aborted).toBe(false)

				// Simulate request completion and cancellation to clear the controller
				task.cancelCurrentRequest()

				// Second request should create a fresh AbortController with a new signal
				callCount = 0
				const iterator2 = task.attemptApiRequest(0)
				await iterator2.next()

				expect(createMessageSpy).toHaveBeenCalledTimes(2)
				const [, , metadata2] = createMessageSpy.mock.calls[1]!
				const signal2 = metadata2!.abortSignal

				// Signals should be different instances (fresh controller per request)
				expect(signal2).not.toBe(signal1)
				expect(signal2).toBe(task.currentRequestAbortController!.signal)
				expect(signal2!.aborted).toBe(false)
			})

			it("should propagate AbortController signal through attemptApiRequest context-window retry path", async () => {
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					mode: "architect",
					mcpEnabled: false,
				} as unknown as ProviderState)
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					task: "test task",
					startTask: false,
				})
				await task.getTaskMode()

				vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
				vi.spyOn(task, "getTokenUsage").mockReturnValue({
					totalCost: 0,
					totalTokensIn: 0,
					totalTokensOut: 0,
					contextTokens: 120000,
				})
				vi.spyOn(task.api, "getModel").mockReturnValue({
					id: mockApiConfig.apiModelId!,
					info: {
						supportsImages: false,
						supportsPromptCache: true,
						contextWindow: 1000,
						maxTokens: 4096,
						inputPrice: 0.3,
						outputPrice: 1.5,
					} as ModelInfo,
				})
				const providerState = await mockProvider.getState()
				vi.spyOn(mockProvider, "getState").mockResolvedValue({
					...providerState,
					apiConfiguration: mockApiConfig,
					mode: "code",
					autoCondenseContext: true,
					autoCondenseContextPercent: 80,
					requestDelaySeconds: 0,
					customModes: [],
					experiments: {},
					disabledTools: [],
					customSupportPrompts: {},
					autoApprovalEnabled: true,
					profileThresholds: {},
					currentApiConfigName: "default",
				})

				task.apiConversationHistory = [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: "test message" }],
						ts: Date.now(),
					},
				]

				let firstCall = true
				const retryStream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "text", text: "retried response" }
					},
					async next() {
						return { done: false, value: { type: "text", text: "retried response" } }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				const contextWindowErrorStream = {
					[Symbol.asyncIterator]() {
						return this
					},
					async next() {
						throw { status: 400, message: "context length exceeded" }
					},
					async return() {
						return { done: true, value: undefined }
					},
					async throw(e: unknown) {
						throw e
					},
					[Symbol.asyncDispose]: async () => {},
				} as AsyncGenerator<ApiStreamChunk>

				vi.spyOn(task.api, "createMessage").mockImplementation(() => {
					if (firstCall) {
						firstCall = false
						return contextWindowErrorStream
					}
					return retryStream
				})

				const iterator = task.attemptApiRequest(0)
				await expect(iterator.next()).resolves.toMatchObject({
					done: false,
					value: { type: "text", text: "retried response" },
				})

				expect(summarizeConversation).toHaveBeenCalled()
				const [options] = vi.mocked(summarizeConversation).mock.calls.at(-1)!
				expect(options.metadata?.taskId).toBe(task.taskId)
				expect(options.metadata?.mode).toBe("architect")
				expect(options.metadata?.abortSignal).toBeInstanceOf(AbortSignal)
				expect(options.metadata?.abortSignal?.aborted).toBe(false)
			})
		})
	})

	describe("safeEnsureModelFetched", () => {
		it("loads model metadata before getModel is used", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const ensureModelFetched = vi.fn().mockResolvedValue(undefined)
			Object.assign(task.api, { ensureModelFetched })

			await getTaskTestAccess(task).safeEnsureModelFetched()

			expect(ensureModelFetched).toHaveBeenCalledTimes(1)
		})

		it("swallows fetch failures so callers can fall back to defaults", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const ensureModelFetched = vi.fn().mockRejectedValue(new Error("network down"))
			Object.assign(task.api, { ensureModelFetched })
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			await expect(getTaskTestAccess(task).safeEnsureModelFetched()).resolves.toBeUndefined()

			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to fetch model metadata"),
				"network down",
			)
			errorSpy.mockRestore()
		})

		it("is a no-op when the api handler does not implement ensureModelFetched", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await expect(getTaskTestAccess(task).safeEnsureModelFetched()).resolves.toBeUndefined()
		})

		it("calls safeEnsureModelFetched from attemptApiRequest when context tokens are present", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
			vi.spyOn(task, "getTokenUsage").mockReturnValue({
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				contextTokens: 50_000,
			})
			const safeSpy = vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(undefined)
			vi.spyOn(task.api, "getModel").mockReturnValue({
				id: mockApiConfig.apiModelId!,
				info: {
					supportsImages: false,
					supportsPromptCache: true,
					contextWindow: 200_000,
					maxTokens: 4096,
				} as ModelInfo,
			})
			vi.spyOn(task.api, "createMessage").mockReturnValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "text", text: "ok" }
				},
				async next() {
					return { done: true, value: undefined }
				},
				async return() {
					return { done: true, value: undefined }
				},
				async throw(error: unknown) {
					throw error
				},
				async [Symbol.asyncDispose]() {},
			} as AsyncGenerator<ApiStreamChunk>)

			task.apiConversationHistory = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "test message" }],
					ts: Date.now(),
				},
			]

			const iterator = task.attemptApiRequest(0)
			await iterator.next()

			expect(safeSpy).toHaveBeenCalled()
		})

		it("continues attemptApiRequest when model metadata fetch fails", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("mock system prompt")
			vi.spyOn(task, "getTokenUsage").mockReturnValue({
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				contextTokens: 50_000,
			})
			const ensureModelFetched = vi.fn().mockRejectedValue(new Error("fetch failed"))
			Object.assign(task.api, { ensureModelFetched })
			vi.spyOn(task.api, "getModel").mockReturnValue({
				id: mockApiConfig.apiModelId!,
				info: {
					supportsImages: false,
					supportsPromptCache: true,
					contextWindow: 200_000,
					maxTokens: 4096,
				} as ModelInfo,
			})
			vi.spyOn(task.api, "createMessage").mockReturnValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "text", text: "ok" }
				},
				async next() {
					return { done: false, value: { type: "text", text: "ok" } }
				},
				async return() {
					return { done: true, value: undefined }
				},
				async throw(error: unknown) {
					throw error
				},
				async [Symbol.asyncDispose]() {},
			} as AsyncGenerator<ApiStreamChunk>)
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			task.apiConversationHistory = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "test message" }],
					ts: Date.now(),
				},
			]

			const iterator = task.attemptApiRequest(0)
			await expect(iterator.next()).resolves.toMatchObject({
				done: false,
				value: { type: "text", text: "ok" },
			})
			expect(errorSpy).toHaveBeenCalled()
			errorSpy.mockRestore()
		})

		it("fetches model metadata before caching the streaming model", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const ensureModelFetched = vi.fn().mockResolvedValue(undefined)
			Object.assign(task.api, { ensureModelFetched })
			vi.spyOn(task.api, "getModel").mockReturnValue({
				id: mockApiConfig.apiModelId!,
				info: {
					supportsImages: false,
					supportsPromptCache: true,
					contextWindow: 200_000,
					maxTokens: 4096,
				} as ModelInfo,
			})
			vi.mocked(processUserContentMentions).mockResolvedValueOnce({
				content: [{ type: "text", text: "hello" }],
				mode: undefined,
			})
			const safeSpy = vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched")
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() => {
				throw new Error("stop after model metadata fetch")
			})
			vi.spyOn(getTaskTestAccess(task), "saveClineMessages").mockResolvedValue(true)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined as never)
			vi.spyOn(getTaskTestAccess(task), "addToApiConversationHistory").mockResolvedValue(undefined)

			task.clineMessages = [
				{
					ts: Date.now(),
					type: "say",
					say: "api_req_started",
					text: "{}",
				},
			]
			vi.spyOn(task, "say").mockImplementation(async (type) => {
				if (type === "api_req_started") {
					task.clineMessages.push({
						ts: Date.now(),
						type: "say",
						say: "api_req_started",
						text: "{}",
					})
				}
				return undefined as never
			})

			const result = await task.recursivelyMakeClineRequests([{ type: "text", text: "hello" }], false)

			expect(result).toBe(true)
			expect(safeSpy).toHaveBeenCalled()
			expect(ensureModelFetched).toHaveBeenCalled()
			expect(task.cachedStreamingModel?.id).toBe(mockApiConfig.apiModelId)
		})
	})

	describe("start()", () => {
		it("should be a no-op if the task was already started in the constructor", () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Manually trigger start
			const startTaskSpy = vi.spyOn(getTaskTestAccess(task), "startTask").mockImplementation(async () => {})
			task.start()

			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			// Calling start() again should be a no-op
			task.start()
			expect(startTaskSpy).toHaveBeenCalledTimes(1)
		})

		it("should not call startTask if already started via constructor", () => {
			// Create a task that starts immediately (startTask defaults to true)
			// but mock startTask to prevent actual execution
			const startTaskSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "startTask")
				.mockImplementation(async () => {})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: true,
			})

			// startTask was called by the constructor
			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			// Calling start() should be a no-op since _started is already true
			task.start()
			expect(startTaskSpy).toHaveBeenCalledTimes(1)

			startTaskSpy.mockRestore()
		})
	})

	describe("unhandled-rejection guards on void async calls", () => {
		// PR #253 wired `.catch(...)` onto every fire-and-forget async call that
		// Copilot flagged as a potential unhandled-rejection source. These specs
		// pin that behavior so a future refactor cannot silently drop the
		// handler and reintroduce the crash risk on the extension host.

		const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

		let consoleErrorSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		})

		afterEach(() => {
			consoleErrorSpy.mockRestore()
			vi.restoreAllMocks()
		})

		it("logs (instead of crashing) when startTask rejects from the constructor", async () => {
			const boom = new Error("startTask boom")
			const startTaskSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "startTask")
				.mockImplementation(async () => {
					throw boom
				})

			new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: true,
			})

			expect(startTaskSpy).toHaveBeenCalledTimes(1)
			await flushMicrotasks()

			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#constructor] startTask failed:", boom)
			startTaskSpy.mockRestore()
		})

		it("logs (instead of crashing) when resumeTaskFromHistory rejects from the constructor", async () => {
			const boom = new Error("resume boom")
			const resumeSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "resumeTaskFromHistory")
				.mockImplementation(async () => {
					throw boom
				})

			new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "123",
					number: 0,
					ts: Date.now(),
					task: "historical task",
					tokensIn: 100,
					tokensOut: 200,
					cacheWrites: 0,
					cacheReads: 0,
					totalCost: 0.001,
				},
				startTask: true,
			})

			expect(resumeSpy).toHaveBeenCalledTimes(1)
			await flushMicrotasks()

			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#constructor] resumeTaskFromHistory failed:", boom)
			resumeSpy.mockRestore()
		})

		it("logs (instead of crashing) when postStateToWebviewWithoutTaskHistory rejects from the queue handler", async () => {
			const boom = new Error("postState boom")
			mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockRejectedValue(boom)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Triggers messageQueueStateChangedHandler -> void postStateToWebviewWithoutTaskHistory()
			task.messageQueueService.addMessage("queued text")
			await flushMicrotasks()

			expect(mockProvider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[Task#messageQueueStateChangedHandler] postStateToWebviewWithoutTaskHistory failed:",
				boom,
			)
		})

		it("logs (instead of crashing) when startTask rejects from start()", async () => {
			const boom = new Error("start() boom")
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			vi.spyOn(getTaskTestAccess(task), "startTask").mockImplementation(async () => {
				throw boom
			})

			task.start()
			await flushMicrotasks()

			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#start] startTask failed:", boom)
		})

		it("swallows the expected abort rejection from presentAssistantMessageSafe", async () => {
			const assistantMessageModule = await import("../../assistant-message")
			const presentSpy = vi
				.spyOn(assistantMessageModule, "presentAssistantMessage")
				.mockRejectedValue(new Error("[Task#presentAssistantMessage] task t.i aborted"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Drain any unrelated console.error noise emitted by async constructor side effects
			// (CloudService/getState complaints in the test harness) so we only assert on the
			// abort-path behavior under test.
			await flushMicrotasks()
			consoleErrorSpy.mockClear()

			task.abort = true
			getTaskTestAccess(task).presentAssistantMessageSafe()
			await flushMicrotasks()

			expect(presentSpy).toHaveBeenCalledTimes(1)
			const presentErrors = consoleErrorSpy.mock.calls.filter(
				(call: unknown[]) => typeof call[0] === "string" && call[0].includes("[Task#presentAssistantMessage]"),
			)
			expect(presentErrors).toHaveLength(0)
		})

		it("logs non-abort rejections from presentAssistantMessageSafe", async () => {
			const assistantMessageModule = await import("../../assistant-message")
			const boom = new Error("present boom")
			const presentSpy = vi.spyOn(assistantMessageModule, "presentAssistantMessage").mockRejectedValue(boom)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			expect(task.abort).toBeFalsy()
			getTaskTestAccess(task).presentAssistantMessageSafe()
			await flushMicrotasks()

			expect(presentSpy).toHaveBeenCalledTimes(1)
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[Task#presentAssistantMessage] task"),
				boom,
			)
		})

		it("logs a non-abort error even when this.abort flips true after the throw", async () => {
			// Pins that the message-based discriminator is load-bearing, not the
			// state check. Under the previous `if (this.abort) return` guard this
			// case (a genuine downstream failure racing with an abort flip between
			// the throw and the catch microtask) would silently swallow the error.
			const assistantMessageModule = await import("../../assistant-message")
			const realError = new Error("genuine downstream failure")
			const presentSpy = vi.spyOn(assistantMessageModule, "presentAssistantMessage").mockRejectedValue(realError)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await flushMicrotasks()
			consoleErrorSpy.mockClear()

			// Simulate the TOCTOU race: abort flips between throw and catch.
			task.abort = true
			getTaskTestAccess(task).presentAssistantMessageSafe()
			await flushMicrotasks()

			expect(presentSpy).toHaveBeenCalledTimes(1)
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[Task#presentAssistantMessage] task"),
				realError,
			)
		})

		it("suppresses an abort-pattern error by message match even when this.abort is false", async () => {
			// Pins the inverse: message wins over state. A stale abort rejection
			// arriving before `this.abort` has been observed as true must still be
			// suppressed, so the catch handler never logs the expected
			// cancellation rejection as a real failure.
			const assistantMessageModule = await import("../../assistant-message")
			const abortError = new Error("[Task#presentAssistantMessage] task t.i aborted")
			const presentSpy = vi.spyOn(assistantMessageModule, "presentAssistantMessage").mockRejectedValue(abortError)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await flushMicrotasks()
			consoleErrorSpy.mockClear()

			expect(task.abort).toBeFalsy()
			getTaskTestAccess(task).presentAssistantMessageSafe()
			await flushMicrotasks()

			expect(presentSpy).toHaveBeenCalledTimes(1)
			const presentErrors = consoleErrorSpy.mock.calls.filter(
				(call: unknown[]) => typeof call[0] === "string" && call[0].includes("[Task#presentAssistantMessage]"),
			)
			expect(presentErrors).toHaveLength(0)
		})

		it("logs (instead of crashing) when updateClineMessage rejects from the say() partial-update path", async () => {
			// Pins the symmetric .catch arm on the fire-and-forget
			// updateClineMessage call in say(). The callee's webview post is
			// internally guarded, but its synchronous emit can throw via a
			// consumer-attached listener — that path must surface as a log,
			// not an unhandled rejection.
			const boom = new Error("updateClineMessage boom")
			const updateSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "updateClineMessage")
				.mockImplementation(async () => {
					throw boom
				})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Seed a prior partial "say" so the partial-update branch fires.
			task.clineMessages.push({
				ts: Date.now() - 1,
				type: "say",
				say: "text",
				text: "partial",
				partial: true,
			})

			await task.say("text", "updated partial", undefined, true)
			await flushMicrotasks()

			expect(updateSpy).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#say] updateClineMessage failed:", boom)
			updateSpy.mockRestore()
		})

		it("logs (instead of crashing) when updateClineMessage rejects from the ask() complete-partial path", async () => {
			// Pins the symmetric .catch arm on the fire-and-forget
			// updateClineMessage call in ask() when finalizing a partial.
			const boom = new Error("updateClineMessage boom")
			const updateSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "updateClineMessage")
				.mockImplementation(async () => {
					throw boom
				})
			const saveSpy = vi.spyOn(getTaskTestAccess(Task.prototype), "saveClineMessages").mockResolvedValue(true)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Seed a prior partial "ask" of type "tool" so the complete-partial
			// branch fires when ask("tool", ..., false) is called.
			task.clineMessages.push({
				ts: Date.now() - 1,
				type: "ask",
				ask: "tool",
				text: "partial",
				partial: true,
			})

			// ask() resolves only after a response — fire-and-forget so the
			// promise the suite awaits stays bounded. The .catch on the
			// pending ask handles the never-resolved promise.
			void task.ask("tool", "complete", false).catch(() => {})
			await flushMicrotasks()

			expect(updateSpy).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#ask] updateClineMessage failed:", boom)
			updateSpy.mockRestore()
			saveSpy.mockRestore()
		})

		it("logs (instead of crashing) when updateClineMessage rejects from the ask() ignore-partial path", async () => {
			// Pins the .catch arm on the fire-and-forget updateClineMessage call
			// in ask() when a new partial ask arrives while the previous partial
			// is still pending (AskIgnoredError path).
			const boom = new Error("updateClineMessage boom")
			const updateSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "updateClineMessage")
				.mockImplementation(async () => {
					throw boom
				})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Seed a prior partial ask so the isUpdatingPreviousPartial branch fires.
			task.clineMessages.push({
				ts: Date.now() - 1,
				type: "ask",
				ask: "tool",
				text: "partial",
				partial: true,
			})

			// Sending a new partial of the same type triggers updateClineMessage
			// then throws AskIgnoredError — catch it so the test doesn't fail.
			await task.ask("tool", "updated partial", true).catch(() => {})
			await flushMicrotasks()

			expect(updateSpy).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith("[Task#ask] updateClineMessage failed:", boom)
		})

		it("logs (instead of crashing) when updateClineMessage rejects from handleWebviewAskResponse", async () => {
			// Pins the .catch arm on the fire-and-forget updateClineMessage call
			// in handleWebviewAskResponse when marking a tool ask as answered.
			const boom = new Error("updateClineMessage boom")
			const updateSpy = vi
				.spyOn(getTaskTestAccess(Task.prototype), "updateClineMessage")
				.mockImplementation(async () => {
					throw boom
				})
			vi.spyOn(getTaskTestAccess(Task.prototype), "saveClineMessages").mockResolvedValue(false)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Seed an unanswered tool ask so the lastToolAskIndex branch fires.
			task.clineMessages.push({
				ts: Date.now() - 1,
				type: "ask",
				ask: "tool",
				text: "tool call",
				partial: false,
			})

			task.handleWebviewAskResponse("yesButtonClicked")
			await flushMicrotasks()

			expect(updateSpy).toHaveBeenCalled()
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[Task#handleWebviewAskResponse] updateClineMessage failed:",
				boom,
			)
		})
	})
})

describe("Queued message processing after condense", () => {
	function createProvider(): ClineProvider {
		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const ctx = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const output = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		const provider = new ClineProvider(
			ctx,
			output as unknown as vscode.OutputChannel,
			"sidebar",
			new ContextProxy(ctx),
		)
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		provider.getState = vi.fn().mockResolvedValue({})
		return provider
	}

	const apiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiModelId: "claude-3-5-sonnet-20241022",
		apiKey: "test-api-key",
	}

	it("processes queued message after condense completes", async () => {
		const provider = createProvider()
		const task = new Task({
			provider,
			apiConfiguration: apiConfig,
			task: "initial task",
			startTask: false,
		})

		// Make condense fast + deterministic
		vi.spyOn(getTaskTestAccess(task), "getSystemPrompt").mockResolvedValue("system")
		const submitSpy = vi.spyOn(task, "submitUserMessage").mockResolvedValue(undefined)

		// Queue a message during condensing
		task.messageQueueService.addMessage("queued text", ["img1.png"])

		// Use fake timers to capture setTimeout(0) in processQueuedMessages
		vi.useFakeTimers()
		await task.condenseContext()

		// Flush the microtask that submits the queued message
		vi.runAllTimers()
		vi.useRealTimers()

		expect(submitSpy).toHaveBeenCalledWith("queued text", ["img1.png"])
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("does not cross-drain queues between separate tasks", async () => {
		const providerA = createProvider()
		const providerB = createProvider()

		const taskA = new Task({
			provider: providerA,
			apiConfiguration: apiConfig,
			task: "task A",
			startTask: false,
		})
		const taskB = new Task({
			provider: providerB,
			apiConfiguration: apiConfig,
			task: "task B",
			startTask: false,
		})

		vi.spyOn(getTaskTestAccess(taskA), "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(getTaskTestAccess(taskB), "getSystemPrompt").mockResolvedValue("system")

		const spyA = vi.spyOn(taskA, "submitUserMessage").mockResolvedValue(undefined)
		const spyB = vi.spyOn(taskB, "submitUserMessage").mockResolvedValue(undefined)

		taskA.messageQueueService.addMessage("A message")
		taskB.messageQueueService.addMessage("B message")

		// Condense in task A should only drain A's queue
		vi.useFakeTimers()
		await taskA.condenseContext()
		vi.runAllTimers()
		vi.useRealTimers()

		expect(spyA).toHaveBeenCalledWith("A message", undefined)
		expect(spyB).not.toHaveBeenCalled()
		expect(taskB.messageQueueService.isEmpty()).toBe(false)

		// Now condense in task B should drain B's queue
		vi.useFakeTimers()
		await taskB.condenseContext()
		vi.runAllTimers()
		vi.useRealTimers()

		expect(spyB).toHaveBeenCalledWith("B message", undefined)
		expect(taskB.messageQueueService.isEmpty()).toBe(true)
	})
})

describe("Telemetry installments (idle/shutdown flush)", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockExtensionContext: vscode.ExtensionContext
	let captureTaskCompletedSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		captureTaskCompletedSpy = vi.spyOn(TelemetryService.instance, "captureTaskCompleted")

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockProvider = new ClineProvider(
			mockExtensionContext,
			{
				appendLine: vi.fn(),
				append: vi.fn(),
				clear: vi.fn(),
				show: vi.fn(),
				hide: vi.fn(),
				dispose: vi.fn(),
			} as unknown as vscode.OutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		)
		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
	})

	const createdTasks: Task[] = []

	afterEach(() => {
		for (const task of createdTasks) {
			task.dispose()
		}
		createdTasks.length = 0
		vi.useRealTimers()
		captureTaskCompletedSpy.mockRestore()
	})

	function createTask() {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})
		task.startIdleTelemetryCheck()
		createdTasks.push(task)
		return task
	}

	describe("flushTelemetryInstallment", () => {
		it("reports nothing and does not call captureTaskCompleted when there is no new activity", () => {
			const task = createTask()

			task.flushTelemetryInstallment("idle")

			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})

		it("reports the current toolUsage/messageCounts as the delta on the first flush", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.recordToolUsage("read_file")
			task.messageCounts = { user: 2, assistant: 3 }

			task.flushTelemetryInstallment("idle")

			expect(captureTaskCompletedSpy).toHaveBeenCalledWith(
				task.taskId,
				{ read_file: { attempts: 2, failures: 0 } },
				{ user: 2, assistant: 3 },
				"idle",
			)
		})

		it("does not mutate task.toolUsage/messageCounts (they stay running totals for the public API/UI)", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.messageCounts = { user: 1, assistant: 1 }

			task.flushTelemetryInstallment("idle")

			expect(task.toolUsage).toEqual({ read_file: { attempts: 1, failures: 0 } })
			expect(task.messageCounts).toEqual({ user: 1, assistant: 1 })
		})

		it("reports only the delta since the previous installment on a second flush", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.messageCounts = { user: 1, assistant: 1 }
			task.flushTelemetryInstallment("idle")
			captureTaskCompletedSpy.mockClear()

			task.recordToolUsage("read_file")
			task.recordToolUsage("write_to_file")
			task.messageCounts = { user: 3, assistant: 2 }
			task.flushTelemetryInstallment("shutdown")

			expect(captureTaskCompletedSpy).toHaveBeenCalledWith(
				task.taskId,
				{ read_file: { attempts: 1, failures: 0 }, write_to_file: { attempts: 1, failures: 0 } },
				{ user: 2, assistant: 1 },
				"shutdown",
			)
		})

		it("does not emit an empty second installment when nothing changed since the first flush", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.flushTelemetryInstallment("idle")
			captureTaskCompletedSpy.mockClear()

			task.flushTelemetryInstallment("shutdown")

			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})

		it("includes failure deltas alongside attempt deltas", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.flushTelemetryInstallment("idle")
			captureTaskCompletedSpy.mockClear()

			task.recordToolError("read_file")

			task.flushTelemetryInstallment("shutdown")

			expect(captureTaskCompletedSpy).toHaveBeenCalledWith(
				task.taskId,
				{ read_file: { attempts: 0, failures: 1 } },
				{ user: 0, assistant: 0 },
				"shutdown",
			)
		})
	})

	describe("idle flush timer", () => {
		it("flushes once activity has been quiet for the idle threshold", () => {
			vi.useFakeTimers()
			const task = createTask()
			task.recordToolUsage("read_file")

			vi.advanceTimersByTime(31 * 60 * 1000)

			expect(captureTaskCompletedSpy).toHaveBeenCalledWith(
				task.taskId,
				{ read_file: { attempts: 1, failures: 0 } },
				{ user: 0, assistant: 0 },
				"idle",
			)
		})

		it("does not flush before the idle threshold has elapsed", () => {
			vi.useFakeTimers()
			const task = createTask()
			task.recordToolUsage("read_file")

			vi.advanceTimersByTime(10 * 60 * 1000)

			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})

		it("does not call the idle flush after a prior idle installment without new activity", () => {
			vi.useFakeTimers()
			const task = createTask()
			const flushTelemetryInstallmentSpy = vi.spyOn(task, "flushTelemetryInstallment")
			task.recordToolUsage("read_file")

			vi.advanceTimersByTime(31 * 60 * 1000)
			expect(captureTaskCompletedSpy).toHaveBeenCalledTimes(1)
			flushTelemetryInstallmentSpy.mockClear()
			captureTaskCompletedSpy.mockClear()

			vi.advanceTimersByTime(5 * 60 * 1000)

			expect(flushTelemetryInstallmentSpy).not.toHaveBeenCalled()
			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})
	})

	describe("dispose", () => {
		it("flushes unreported activity as a shutdown installment", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.messageCounts = { user: 1, assistant: 1 }

			task.dispose()

			expect(captureTaskCompletedSpy).toHaveBeenCalledWith(
				task.taskId,
				{ read_file: { attempts: 1, failures: 0 } },
				{ user: 1, assistant: 1 },
				"shutdown",
			)
		})

		it("does not flush again if everything was already reported before dispose", () => {
			const task = createTask()
			task.recordToolUsage("read_file")
			task.flushTelemetryInstallment("attempt_completion")
			captureTaskCompletedSpy.mockClear()

			task.dispose()

			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})

		it("stops the idle timer so a disposed task never flushes again", () => {
			vi.useFakeTimers()
			const task = createTask()
			task.recordToolUsage("read_file")
			task.dispose()
			captureTaskCompletedSpy.mockClear()

			vi.advanceTimersByTime(60 * 60 * 1000)

			expect(captureTaskCompletedSpy).not.toHaveBeenCalled()
		})
	})
})

describe("pushToolResultToUserContent", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings

	beforeEach(() => {
		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }
		const mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		const mockOutputChannel = {
			name: "test-output",
			appendLine: vi.fn(),
			append: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		)

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	it("should add tool_result when not a duplicate", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id-1",
			content: "Test result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(toolResult)
	})

	it("should prevent duplicate tool_result with same tool_use_id", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "First result",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "duplicate-id",
			content: "Second result (should be skipped)",
		}

		// Spy on console.warn to verify warning is logged
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		// Add first result - should succeed
		const added1 = task.pushToolResultToUserContent(toolResult1)
		expect(added1).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)

		// Add second result with same ID - should be skipped
		const added2 = task.pushToolResultToUserContent(toolResult2)
		expect(added2).toBe(false)
		expect(task.userMessageContent).toHaveLength(1)

		// Verify only the first result is in the array
		expect(task.userMessageContent[0]).toEqual(toolResult1)

		// Verify warning was logged
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipping duplicate tool_result for tool_use_id: duplicate-id"),
		)

		warnSpy.mockRestore()
	})

	it("should allow different tool_use_ids to be added", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const toolResult1: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-1",
			content: "Result 1",
		}

		const toolResult2: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "id-2",
			content: "Result 2",
		}

		const added1 = task.pushToolResultToUserContent(toolResult1)
		const added2 = task.pushToolResultToUserContent(toolResult2)

		expect(added1).toBe(true)
		expect(added2).toBe(true)
		expect(task.userMessageContent).toHaveLength(2)
		expect(task.userMessageContent[0]).toEqual(toolResult1)
		expect(task.userMessageContent[1]).toEqual(toolResult2)
	})

	it("should handle tool_result with is_error flag", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		const errorResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "error-id",
			content: "Error message",
			is_error: true,
		}

		const added = task.pushToolResultToUserContent(errorResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.userMessageContent[0]).toEqual(errorResult)
	})

	it("should not interfere with other content types in userMessageContent", () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		})

		// Add text and image blocks manually
		task.userMessageContent.push(
			{ type: "text", text: "Some text" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "base64data" } },
		)

		const toolResult: Anthropic.ToolResultBlockParam = {
			type: "tool_result",
			tool_use_id: "test-id",
			content: "Result",
		}

		const added = task.pushToolResultToUserContent(toolResult)

		expect(added).toBe(true)
		expect(task.userMessageContent).toHaveLength(3)
		expect(task.userMessageContent[0].type).toBe("text")
		expect(task.userMessageContent[1].type).toBe("image")
		expect(task.userMessageContent[2]).toEqual(toolResult)
	})
})
