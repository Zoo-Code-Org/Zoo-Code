// Integration test verifying that Task.ts passes its AbortController signal
// through metadata to the API handler's createMessage() method.

import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import type { GlobalState, ProviderSettings, ModelInfo } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"

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
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation((filePath) => {
			if (filePath.includes("ui_messages.json")) {
				return Promise.resolve(JSON.stringify([]))
			}
			if (filePath.includes("api_conversation_history.json")) {
				return Promise.resolve("[]")
			}
			return Promise.resolve("")
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
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
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

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
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

// Capture the metadata passed to createMessage for assertions
let capturedMetadata: any = null

describe("Task abort signal passing", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		capturedMetadata = null

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => {
					if (key === "taskHistory") {
						return []
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

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
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
		) as any

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.getTaskWithId = vi.fn().mockImplementation(async (id) => ({
			historyItem: {
				id,
				ts: Date.now(),
				task: "test",
				tokensIn: 100,
				tokensOut: 200,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0.001,
			},
			taskDirPath: "/mock/storage/path/tasks/123",
			apiConversationHistoryFilePath: "/mock/storage/path/tasks/123/api_conversation_history.json",
			uiMessagesFilePath: "/mock/storage/path/tasks/123/ui_messages.json",
			apiConversationHistory: [],
		}))

		vi.clearAllMocks()
	})

	describe("abortSignal in createMessage metadata", () => {
		it("should pass AbortController signal through metadata to API handler's createMessage()", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test abort signal passing",
				startTask: false,
			})

			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			// Mock createMessage to capture the metadata argument
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { type: "text", text: "response" }
				},
				async next() {
					return { done: true, value: undefined as any }
				},
				async return() {
					return { done: true, value: undefined }
				},
			} as unknown as AsyncGenerator<ApiStreamChunk>

			const createMessageSpy = vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

			const iterator = task.attemptApiRequest(0)
			await iterator.next()

			// Verify that createMessage was called with metadata containing abortSignal
			expect(createMessageSpy).toHaveBeenCalled()
			const callArgs = createMessageSpy.mock.calls[0]!
			const passedMetadata = callArgs[2] as any

			expect(passedMetadata).toBeDefined()
			expect(passedMetadata.taskId).toBe(task.taskId)
			expect(passedMetadata.abortSignal).toBeDefined()
			expect(passedMetadata.abortSignal).toBeInstanceOf(AbortSignal)
		})

		it("should have an abortable signal in the metadata", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test abortable signal",
				startTask: false,
			})

			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { type: "text", text: "response" }
				},
				async next() {
					return { done: true, value: undefined as any }
				},
				async return() {
					return { done: true, value: undefined }
				},
			} as unknown as AsyncGenerator<ApiStreamChunk>

			vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

			const iterator = task.attemptApiRequest(0)
			await iterator.next()

			const callArgs = (task.api.createMessage as any).mock.calls[0]!
			const passedMetadata = callArgs[2] as any

			// Signal should NOT be aborted initially
			expect(passedMetadata.abortSignal.aborted).toBe(false)

			// Simulate calling cancelCurrentRequest() which aborts the controller
			task.cancelCurrentRequest()

			// Now the signal should be aborted
			expect(passedMetadata.abortSignal.aborted).toBe(true)
		})

		it("should pass metadata with all expected fields including abortSignal", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test full metadata",
				startTask: false,
			})

			vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("mock system prompt")

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { type: "text", text: "response" }
				},
				async next() {
					return { done: true, value: undefined as any }
				},
				async return() {
					return { done: true, value: undefined }
				},
			} as unknown as AsyncGenerator<ApiStreamChunk>

			vi.spyOn(task.api, "createMessage").mockReturnValue(mockStream)

			const iterator = task.attemptApiRequest(0)
			await iterator.next()

			const callArgs = (task.api.createMessage as any).mock.calls[0]!
			const passedMetadata = callArgs[2] as any

			// Verify all expected fields are present
			expect(passedMetadata.taskId).toBeDefined()
			expect(passedMetadata.abortSignal).toBeInstanceOf(AbortSignal)
			expect(typeof passedMetadata.taskId).toBe("string")
		})
	})
})
