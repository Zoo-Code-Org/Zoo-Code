// npx vitest core/task/__tests__/Task.teardown.spec.ts
// Setup prelude, the Cline-provider beforeEach and the console-error spies are copied verbatim
// from Task.spec.ts; the 13 tests below are byte-identical to the 430 lines this unit used to
// insert into Task.spec.ts, so Task.spec.ts returns to main's own content.

import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
// npx vitest core/task/__tests__/Task.spec.ts

import * as fsReal from "fs"
import * as os from "os"
import * as path from "path"

import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	providerIdentifiers,
	type ClineMessage,
	type GlobalState,
	type ProviderSettings,
	type ModelInfo,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ApiStreamChunk } from "../../../api/transform/stream"
import { ContextProxy } from "../../config/ContextProxy"
import type { ApiMessage } from "../../task-persistence"
import type { RequestPolicySnapshot } from "../../prompts/tools/effective-tool-policy"
import { asyncStreamFrom } from "../../../test-utils/stream"

type TaskTestAccess = {
	getSystemPrompt: (requestState: ProviderState | undefined, requestModelInfo?: ModelInfo) => Promise<string>
	handleContextWindowExceededError: (requestModelInfo: ModelInfo) => Promise<void>
	getEnabledMcpToolsCount: () => Promise<{ enabledToolCount: number; enabledServerCount: number }>
	initiateTaskLoop: (userContent: Anthropic.Messages.ContentBlockParam[]) => Promise<void>
	startTask: (task?: string, images?: string[]) => Promise<void>
	resumeTaskFromHistory: () => Promise<void>
	presentAssistantMessageSafe: () => void
	hasCompleteToolResultsForCurrentTurn: () => boolean
	addToClineMessages: (message: import("@roo-code/types").ClineMessage) => Promise<void>
	updateClineMessage: (message: import("@roo-code/types").ClineMessage) => Promise<void>
	saveClineMessages: () => Promise<boolean>
	safeEnsureModelFetched: () => Promise<ModelInfo>
	backoffAndAnnounce: (retryAttempt: number, error: unknown) => Promise<void>
	requestPolicySnapshot?: RequestPolicySnapshot
	getFilesReadByRooSafely: (context: string) => Promise<string[] | undefined>
	addToApiConversationHistory: (message: unknown, reasoning?: string) => Promise<void>
	resetAssistantMessagePersistence: () => void
	buildCleanConversationHistory: (
		messages: ApiMessage[],
		requestModelInfo: ModelInfo,
	) => Array<{ role: string; content: unknown } | { type: "reasoning"; encrypted_content: string }>
	attemptApiRequestWithActiveApi: () => AsyncGenerator<ApiStreamChunk>
	condenseContextWithActiveApi: () => Promise<void>
	retiredApis: Set<unknown>
}

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>
function getTaskTestAccess(task: Task): TaskTestAccess {
	return task as unknown as TaskTestAccess
}

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

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

// Task tests do not exercise indexing; keep workspace resolution and its cache out of this suite.
vi.mock("../../../services/code-index/code-index-manager-registry", () => ({
	CodeIndexManagerRegistry: {
		getOrCreate: vi.fn().mockReturnValue(undefined),
		getAllInstances: vi.fn().mockReturnValue([]),
		disposeAll: vi.fn(),
	},
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

// Model-info stand-in for tests that stub safeEnsureModelFetched and only need
// the settled snapshot to be a defined ModelInfo.
const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 4096,
	supportsPromptCache: true,
}

describe("Task teardown, dispose-time metadata repair and diff-view release", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(async () => {
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
			new WebviewFocusTracker(),
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
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		mockProvider.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
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

	describe("early-return and teardown cleanup", () => {
		let consoleErrorSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		})

		afterEach(() => {
			consoleErrorSpy.mockRestore()
			vi.restoreAllMocks()
		})

		it("retries the failed metadata / task-history stage once, awaited, during dispose", async () => {
			// A metadata or task-history failure is reported separately from the message write,
			// but it must not simply be dropped: the failure is recorded and dispose() awaits
			// one retry before the task stops serving, so a task torn down after a partially
			// successful save does not leave its history entry behind the messages that are
			// already on disk.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			// The retry is held open by a gate. Ungated it settles the moment it starts, so the
			// call-count assertions below would pass whether or not dispose() awaited it. Holding
			// it open is what lets the test observe disposal still waiting on the retry.
			let releaseRetry: (() => void) | undefined
			const retryGate = new Promise<void>((resolve) => {
				releaseRetry = resolve
			})
			const historySpy = vi
				.spyOn(mockProvider, "updateTaskHistory")
				.mockRejectedValueOnce(new Error("history stage unavailable"))
				.mockImplementation(async () => {
					await retryGate
					return []
				})

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// The message write succeeded, so the save still reports success even though the
			// metadata stage failed - and the failure is logged, not swallowed.
			await expect(getTaskTestAccess(task).saveClineMessages()).resolves.toBe(true)
			expect(historySpy).toHaveBeenCalledTimes(1)
			expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to save task metadata:", expect.any(Error))

			let disposalSettled = false
			const disposalFinished = task.dispose().then(() => {
				disposalSettled = true
			})

			try {
				// Drain until disposal settles or the cap is reached. The gate is the only thing holding the
				// retry open, so a disposal that awaits the retry cannot settle inside this loop; a disposal
				// that dropped the awaited call runs the loop out having settled on its own.
				for (let tick = 0; tick < 2000 && !disposalSettled; tick++) {
					await new Promise((wake) => setImmediate(wake))
				}
				expect(historySpy).toHaveBeenCalledTimes(2)
				// dispose() has not resolved while the retry it awaits is still open. Turning the
				// awaited call into a floating one fails here instead of going unnoticed.
				expect(disposalSettled).toBe(false)
			} finally {
				releaseRetry?.()
			}

			await disposalFinished

			// dispose() awaited the retry: by the time it resolves the metadata stage has run
			// again with the recomputed history item for this task.
			expect(disposalSettled).toBe(true)
			expect(historySpy).toHaveBeenCalledTimes(2)
			// The history record is keyed by `id` (the task id), not a taskId field.
			expect(historySpy.mock.calls[1][0]).toEqual(expect.objectContaining({ id: task.taskId }))

			historySpy.mockRestore()
		})

		it("still retries for a task whose stored api config is legitimately absent", async () => {
			// Tasks saved before the api config was recorded have apiConfigName undefined. Their
			// initialization has completed, so the dispose-time repair must still run: gating it on
			// the value rather than on the settled promise drops the retry for every such task.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const historySpy = vi
				.spyOn(mockProvider, "updateTaskHistory")
				.mockRejectedValueOnce(new Error("history stage unavailable"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Bracket access for the private fields: wait for the async api-config
			// initialization to settle, then drop the name - the shape of a task loaded from a
			// history entry saved before the api config was recorded.
			await task["taskApiConfigReady"]
			task["_taskApiConfigName"] = undefined
			expect(task["taskApiConfigReadySettled"]).toBe(true)

			await expect(getTaskTestAccess(task).saveClineMessages()).resolves.toBe(true)
			expect(historySpy).toHaveBeenCalledTimes(1)

			await task.dispose()

			expect(historySpy).toHaveBeenCalledTimes(2)
			historySpy.mockRestore()
		})

		it("treats a released provider as a failed metadata stage instead of a silent success", async () => {
			// providerRef.deref() returns undefined once the provider is gone. Without the guard the
			// two history calls optional-chain to nothing, persistTaskMetadata() returns true and
			// CLEARS pendingTaskMetadataRepair: the history entry then stays behind the messages that
			// are already on disk and disposeOnce() has nothing left to retry on.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const historySpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			// Bracket access for the private field: the flag must start clear so the assertion below
			// proves the failed stage SET it again rather than merely leaving it alone.
			await task["taskApiConfigReady"]
			task["pendingTaskMetadataRepair"] = false
			Object.defineProperty(task, "providerRef", {
				value: { deref: vi.fn().mockReturnValue(undefined) },
				configurable: true,
			})
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			const persisted = await task["persistTaskMetadata"]()

			expect(persisted).toBe(false)
			expect(historySpy).not.toHaveBeenCalled()
			expect(task["pendingTaskMetadataRepair"]).toBe(true)
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no provider to persist task history"))
			errorSpy.mockRestore()
			historySpy.mockRestore()
		})

		it("clears the repair flag and reports success when the metadata stage writes the history entry", async () => {
			// The success side of the stage the row above covers the failure of. The history write
			// lands, the flag disposeOnce() keys off is cleared rather than left alone, and the stage
			// reports success for itself - deliberately separate from the message write's own result,
			// which saveClineMessages() reports on its own.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const historySpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			// Bracket access for the private field: set the flag first so the assertion below proves
			// the stage CLEARED it rather than merely never having set it.
			await task["taskApiConfigReady"]
			task["pendingTaskMetadataRepair"] = true

			const persisted = await task["persistTaskMetadata"]()

			expect(persisted).toBe(true)
			expect(historySpy).toHaveBeenCalledTimes(1)
			expect(task["pendingTaskMetadataRepair"]).toBe(false)
			historySpy.mockRestore()
		})

		it("finishes the synchronous teardown before the dispose-time metadata retry", async () => {
			// The retry has to sit after disposeOnce()'s synchronous section, not in front of it:
			// abortTaskOnce() awaits diffReversionPromise right after void dispose(), an abandoned
			// stream can reach its finally while the retry is in flight and leave the revert decision
			// below false, and direct dispose() callers rely on the abort flag being set
			// synchronously. A task-history write that never settles turns any of those three
			// regressions into an observable hang.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			let releaseHistory: (() => void) | undefined
			const historyGate = new Promise<void>((resolve) => {
				releaseHistory = resolve
			})
			const historySpy = vi
				.spyOn(mockProvider, "updateTaskHistory")
				.mockImplementation(() => historyGate.then(() => []))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			// Let the async api-config initialization settle first: the retry is deliberately
			// skipped while it is pending, which would hide the ordering under test.
			await task["taskApiConfigReady"]
			task["pendingTaskMetadataRepair"] = true
			task.isStreaming = true
			task.diffViewProvider.isEditing = true
			// A modify: disposal reverts it. The edit type decides which release path disposal takes
			// (see the create/modify disposal pair below), and this test is about the ordering.
			task.diffViewProvider.editType = "modify"
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)

			const disposing = task.dispose()
			// No await before this one: dispose() sets the abort flag synchronously, so a retry moved
			// in front of the teardown would park dispose() on the gated task-history write first and
			// this would read false.
			expect(task.abort).toBe(true)

			await new Promise<void>((resolve) => setImmediate(resolve))

			// The teardown completed without waiting for the task-history write.
			expect(task.abort).toBe(true)
			expect(revertSpy).toHaveBeenCalledTimes(1)
			// Bracket access for the private field: abortTaskOnce() awaits this promise right after
			// void dispose(), so it has to exist once the teardown has run.
			expect(task["diffReversionPromise"]).toBeDefined()
			// And the retry has actually started: historySpy is gated, so without this assertion the
			// test cannot tell "the teardown ran first" from "the retry never ran at all".
			expect(historySpy).toHaveBeenCalledTimes(1)

			releaseHistory?.()
			await disposing

			expect(historySpy).toHaveBeenCalledTimes(1)
			historySpy.mockRestore()
			revertSpy.mockRestore()
		})

		it("discards a cancelled create preview instead of saving it through revertChanges", async () => {
			// revertChanges() for a create SAVES the dirty buffer - the partial content the model
			// streamed and nobody approved - before deleting the file, so a failed delete leaves
			// unapproved bytes on disk. A cancelled stream never reached approval, so disposal has to
			// take the discard path, which empties the buffer first.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			await task["taskApiConfigReady"]
			task.isStreaming = true
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)

			await task.dispose()

			expect(discardSpy).toHaveBeenCalledTimes(1)
			expect(revertSpy).not.toHaveBeenCalled()
			revertSpy.mockRestore()
			discardSpy.mockRestore()
		})

		it("still reverts a cancelled modify preview, whose restore is the content already on disk", async () => {
			// The pair of the test above: a modify has prior content, and disposal keeps reverting it
			// so the editor shows what was on disk before the stream started.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			await task["taskApiConfigReady"]
			task.isStreaming = true
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "modify"
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)

			await task.dispose()

			expect(revertSpy).toHaveBeenCalledTimes(1)
			expect(discardSpy).not.toHaveBeenCalled()
			revertSpy.mockRestore()
			discardSpy.mockRestore()
		})

		it("discards a create preview from the stream abort path, not only from disposal", async () => {
			// A cancelled stream never reached approval. abortStream() used to revert unconditionally,
			// and revertChanges()'s create branch SAVES the dirty buffer - the partial model output -
			// before deleting the file, so a failed delete left unapproved bytes on disk. The abort
			// path now shares disposal's release, so this pins it to the discard.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "abort release create",
				startTask: false,
			})
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			// The streaming loop checks this.abort right after the presenter hands off a chunk, so the
			// cancel lands mid-stream and reaches abortStream(-"user_cancelled") with the view open.
			vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
				// Task.abort is a getter over the run-state latch; the method the tree declares is
				// abortTask(), which latches the abort synchronously and returns the shared promise.
				void task.abortTask()
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "partial model output" }]),
			)
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			// Isolation: disposal's own release trigger is gated on isStreaming, so clearing that flag
			// on the way into dispose() leaves the stream-abort path as the only one left that can start
			// a release here. Without the swap the two paths cannot be told apart - abortTaskOnce() voids
			// dispose(), and the call count below could be reporting either one of them.
			const disposeReal = task.dispose.bind(task)
			let disposeCalls = 0
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {
				disposeCalls++
				task.isStreaming = false
				return disposeReal.call(task)
			})

			await task.recursivelyMakeClineRequests([{ type: "text", text: "cancel this stream" }]).catch(() => {})

			// Disposal really ran, so the swap above was exercised rather than vacuous, and every entry
			// into it had its release trigger disabled: the release counted below is the abort path's own.
			expect(disposeCalls).toBeGreaterThan(0)
			const sharedRelease = task["diffReversionPromise"]
			expect(sharedRelease).toBeDefined()
			// It had already settled before this line, so disposal never got the chance to start it.
			await sharedRelease
			expect(discardSpy).toHaveBeenCalledTimes(1)
			expect(revertSpy).not.toHaveBeenCalled()
			revertSpy.mockRestore()
			discardSpy.mockRestore()
			disposeSpy.mockRestore()
		})

		it("reverts a modify preview from the stream abort path, whose restore is the content on disk", async () => {
			// The pair of the test above: a modify has prior content, so the shared release keeps
			// reverting it and shows what was on disk before the stream started.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "abort release modify",
				startTask: false,
			})
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
				// Task.abort is a getter over the run-state latch; the method the tree declares is
				// abortTask(), which latches the abort synchronously and returns the shared promise.
				void task.abortTask()
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "partial model output" }]),
			)
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "modify"
			// Isolation: disposal's own release trigger is gated on isStreaming, so clearing that flag
			// on the way into dispose() leaves the stream-abort path as the only one left that can start
			// a release here. Without the swap the two paths cannot be told apart - abortTaskOnce() voids
			// dispose(), and the call count below could be reporting either one of them.
			const disposeReal = task.dispose.bind(task)
			let disposeCalls = 0
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {
				disposeCalls++
				task.isStreaming = false
				return disposeReal.call(task)
			})

			await task.recursivelyMakeClineRequests([{ type: "text", text: "cancel this stream" }]).catch(() => {})

			// Disposal really ran, so the swap above was exercised rather than vacuous, and every entry
			// into it had its release trigger disabled: the release counted below is the abort path's own.
			expect(disposeCalls).toBeGreaterThan(0)
			const sharedRelease = task["diffReversionPromise"]
			expect(sharedRelease).toBeDefined()
			// It had already settled before this line, so disposal never got the chance to start it.
			await sharedRelease
			expect(revertSpy).toHaveBeenCalledTimes(1)
			expect(discardSpy).not.toHaveBeenCalled()
			revertSpy.mockRestore()
			discardSpy.mockRestore()
			disposeSpy.mockRestore()
		})

		it("surfaces a failed diff release instead of completing the abort as if the workspace were restored", async () => {
			// The ask: a release that failed must not be reported as a completed rollback. Recording and surfacing
			// is the chosen shape - propagating it would make dispose() itself begin rejecting on the path whose
			// own comment says abort must always succeed - so the proof is that the abort still completes AND the
			// user is told the rollback did not happen.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000009")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "abort release failure",
				startTask: false,
			})
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
				void task.abortTask()
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "partial model output" }]),
			)
			vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi
				.spyOn(task.diffViewProvider, "discardUnapprovedStream")
				.mockRejectedValue(new Error("placeholder could not be removed"))
			// Observed, not replaced: replacing say() would change the streaming path this test runs through,
			// so the spy keeps the real implementation and only records the calls.
			const saySpy = vi.spyOn(task, "say")
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			// Isolation as in the two tests above: disposal's own trigger is disabled on the way in, so the
			// release whose failure is reported here can only be the stream-abort path's.
			const disposeReal = task.dispose.bind(task)
			let disposeCalls = 0
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {
				disposeCalls++
				task.isStreaming = false
				return disposeReal.call(task)
			})

			await task.recursivelyMakeClineRequests([{ type: "text", text: "cancel this stream" }]).catch(() => {})
			// abortTask() returns the shared abort promise, so awaiting it again cannot start a second abort;
			// it only guarantees abortTaskOnce() has finished before the assertions below.
			await task.abortTask()

			expect(disposeCalls).toBeGreaterThan(0)
			expect(discardSpy).toHaveBeenCalledTimes(1)
			// The failure is recorded rather than thrown, which is what lets the abort path finish.
			expect(task["diffReversionFailed"]).toBe(true)
			// The promise itself stays resolved: that is the half of the ruling this keeps abort semantics
			// alone for, and awaiting it here fails the test if the release promise ever rejects.
			const sharedRelease = task["diffReversionPromise"]
			expect(sharedRelease).toBeDefined()
			await sharedRelease
			// Exactly one error say carries this release failure; a second would mean the abort reported the
			// same hazard twice.
			const releaseFailureSays = saySpy.mock.calls.filter(
				(call: unknown[]) => call[0] === "error" && String(call[1]).includes("diff view could not be released"),
			)
			expect(releaseFailureSays.length).toBe(1)
			saySpy.mockRestore()
			discardSpy.mockRestore()
			disposeSpy.mockRestore()
		})

		it("reports the release failure through the log when the error say itself fails", async () => {
			// The surfacing block wraps its own say in a catch, so that a failed report does not turn the abort into
			// a rejection either. That fallback only runs when say rejects, so it needs its own case: the first
			// failing-release test leaves say with its real implementation and never reaches it.
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "abort release failure, failing report",
				startTask: false,
			})
			// These two cases are about the release record, not about persistence, and every Task in this file
			// lands in the same task directory (uuid v7 is mocked to one constant), so a persisting test
			// leaves files that the next run reads back. Mocking the two write stages keeps the directory as
			// the run found it.
			vi.spyOn(getTaskTestAccess(task), "saveClineMessages").mockResolvedValue(true)
			vi.spyOn(getTaskTestAccess(task), "addToApiConversationHistory").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
				void task.abortTask()
			})
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() =>
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "partial model output" }]),
			)
			vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi
				.spyOn(task.diffViewProvider, "discardUnapprovedStream")
				.mockRejectedValue(new Error("placeholder could not be removed"))
			// Only the release-failure report rejects. Every other say keeps the real implementation, because
			// replacing say() outright changes the streaming path this test runs through.
			const sayReal = task.say.bind(task)
			const saySpy = vi
				.spyOn(task, "say")
				.mockImplementation((...args) =>
					args[0] === "error" && String(args[1] ?? "").includes("diff view could not be released")
						? Promise.reject(new Error("the error say itself failed"))
						: sayReal(...args),
				)
			const errorLogSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			const disposeReal = task.dispose.bind(task)
			let disposeCalls = 0
			const disposeSpy = vi.spyOn(task, "dispose").mockImplementation(() => {
				disposeCalls++
				task.isStreaming = false
				return disposeReal.call(task)
			})

			await task.recursivelyMakeClineRequests([{ type: "text", text: "cancel this stream" }]).catch(() => {})
			await task.abortTask()

			expect(disposeCalls).toBeGreaterThan(0)
			expect(discardSpy).toHaveBeenCalledTimes(1)
			expect(task["diffReversionFailed"]).toBe(true)
			// The report was attempted once and failed. The abort still ran to the end of its try block, which is
			// what the awaited abortTask() above proves, and the report's own failure went to the log rather than
			// out through abortTask().
			expect(
				saySpy.mock.calls.filter(
					(call: unknown[]) =>
						call[0] === "error" && String(call[1]).includes("diff view could not be released"),
				).length,
			).toBe(1)
			const reportedFailures = errorLogSpy.mock.calls.filter((call: unknown[]) =>
				String(call[0]).includes("Error reporting the failed diff release"),
			)
			expect(reportedFailures.length).toBe(1)
			expect(String(reportedFailures[0][1])).toContain("the error say itself failed")
			saySpy.mockRestore()
			discardSpy.mockRestore()
			disposeSpy.mockRestore()
			errorLogSpy.mockRestore()
		})

		it("clears the release-failure record when the failed stream is retried", async () => {
			// The product"s own way back into a request after a release failed is the mid-stream failure retry:
			// the stream throws, the handler releases the diff view (which fails here), and the same content is
			// pushed back onto the request stack, so the next iteration runs the reset block again after the
			// failure is on the books. A user cancel cannot do this - the run-state abort latch is one-way
			// (latches.abort is set by abortRequested and never cleared), and a new request throws at its own
			// abort check - so this case rides the retry path instead of a second message.
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "failed release, then a stream retry",
				startTask: false,
			})
			// These two cases are about the release record, not about persistence, and every Task in this file
			// lands in the same task directory (uuid v7 is mocked to one constant), so a persisting test
			// leaves files that the next run reads back. Mocking the two write stages keeps the directory as
			// the run found it.
			vi.spyOn(getTaskTestAccess(task), "saveClineMessages").mockResolvedValue(true)
			vi.spyOn(getTaskTestAccess(task), "addToApiConversationHistory").mockResolvedValue(undefined)
			// The request path awaits diffViewProvider.reset() immediately before the reset block, so it has to
			// resolve; the release inside the failure handler is what fails.
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)
			const discardSpy = vi
				.spyOn(task.diffViewProvider, "discardUnapprovedStream")
				.mockRejectedValue(new Error("placeholder could not be removed"))
			// safeEnsureModelFetched is awaited directly after the reset block, so each call is a read of the
			// record at exactly the point where the reset has just run, together with how many releases have
			// happened by then.
			const recordAtModelFetch: { failed: boolean; releases: number }[] = []
			vi.spyOn(getTaskTestAccess(task), "safeEnsureModelFetched").mockImplementation(async () => {
				recordAtModelFetch.push({
					failed: task["diffReversionFailed"],
					releases: discardSpy.mock.calls.length,
				})
				return stubModelInfo
			})
			// First call: one chunk, then the provider stream breaks, which is what routes the request through
			// abortStream on the streaming_failed path rather than through a user cancel.
			// Second call: a clean stream, cancelled at its first presentation so the run ends promptly.
			let streamCalls = 0
			vi.spyOn(task, "attemptApiRequest").mockImplementation(() => {
				streamCalls++
				if (streamCalls === 1) {
					return (async function* (): AsyncGenerator<ApiStreamChunk> {
						yield { type: "text", text: "partial model output" }
						throw new Error("provider stream broke mid-request")
					})()
				}
				return asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "second attempt" }])
			})
			let presentCalls = 0
			vi.spyOn(getTaskTestAccess(task), "presentAssistantMessageSafe").mockImplementation(() => {
				presentCalls++
				if (presentCalls >= 2) {
					void task.abortTask()
				}
			})
			vi.spyOn(getTaskTestAccess(task), "backoffAndAnnounce").mockResolvedValue(undefined)
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"

			await task.recursivelyMakeClineRequests([{ type: "text", text: "stream that fails" }]).catch(() => {})

			// Two model fetches means the retry really re-entered the request path, and the first row shows that a
			// failed release was already on the books before it did.
			expect(recordAtModelFetch.length).toBeGreaterThanOrEqual(2)
			expect(recordAtModelFetch[0]).toEqual({ failed: false, releases: 0 })
			// The pin: at the retry"s model fetch - the first point after the reset block - the record is
			// clear although exactly one failed release has run. Flip the reset from false to true and this row
			// reads { failed: true } instead.
			expect(recordAtModelFetch[1]).toEqual({ failed: false, releases: 1 })
			// Exactly one release ran and it failed, and the retry opened no new one: the settled promise and its
			// record were dropped together, so the session that follows starts clean and can report its own
			// failure instead of inheriting this one.
			expect(discardSpy).toHaveBeenCalledTimes(1)
			expect(task["diffReversionFailed"]).toBe(false)
			expect(task["diffReversionPromise"]).toBeUndefined()
			discardSpy.mockRestore()
		})

		it("starts one release per diff view and hands every later caller the same promise", async () => {
			// Single owner: a release one path already started must not be repeated by the other over
			// the same buffer (a second revertChanges() could roll back content the first release
			// already restored). The promise is stored on the first call and returned afterwards.
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "single release owner",
				startTask: false,
			})
			await task["taskApiConfigReady"]
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			let releaseDiscard: (() => void) | undefined
			const discardGate = new Promise<void>((resolve) => {
				releaseDiscard = resolve
			})
			const discardSpy = vi
				.spyOn(task.diffViewProvider, "discardUnapprovedStream")
				.mockImplementation(() => discardGate)

			const first = task["releaseUnapprovedDiffView"]()
			const second = task["releaseUnapprovedDiffView"]()

			expect(second).toBe(first)
			expect(discardSpy).toHaveBeenCalledTimes(1)

			releaseDiscard?.()
			await first
			discardSpy.mockRestore()
		})

		it("does not start a release when no diff view is open", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "no diff view to release",
				startTask: false,
			})
			await task["taskApiConfigReady"]
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)

			const release = task["releaseUnapprovedDiffView"]()
			await release

			expect(revertSpy).not.toHaveBeenCalled()
			expect(discardSpy).not.toHaveBeenCalled()
			revertSpy.mockRestore()
			discardSpy.mockRestore()
		})

		it("does not roll the same view back again when disposal follows the stream teardown", async () => {
			// The interleaving the single-owner promise exists for: the abort teardown released the
			// view, then disposal runs while isEditing is still true (the mocked release does not reset
			// the provider) and must await that release instead of starting a second one.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "dispose after abort release",
				startTask: false,
			})
			await task["taskApiConfigReady"]
			task.isStreaming = true
			task.diffViewProvider.isEditing = true
			task.diffViewProvider.editType = "create"
			const discardSpy = vi.spyOn(task.diffViewProvider, "discardUnapprovedStream").mockResolvedValue(undefined)
			const revertSpy = vi.spyOn(task.diffViewProvider, "revertChanges").mockResolvedValue(undefined)

			await task["releaseUnapprovedDiffView"]()
			await task.dispose()

			expect(discardSpy).toHaveBeenCalledTimes(1)
			expect(revertSpy).not.toHaveBeenCalled()
			discardSpy.mockRestore()
			revertSpy.mockRestore()
		})

		it("does not block teardown when a pending metadata repair has an unsettled api-config init", async () => {
			// persistTaskMetadata() awaits taskApiConfigReady. For a task whose async api-config
			// initialization never settles, an unconditional dispose-time retry would hang the
			// teardown, so the retry is skipped until that promise settles.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Bracket access for the private fields: this is the pathological construction where
			// the async api-config initialization never resolves, which no public API can produce.
			task["_taskApiConfigName"] = undefined
			task["taskApiConfigReady"] = new Promise<void>(() => {})
			task["pendingTaskMetadataRepair"] = true

			const outcome = await Promise.race([
				task.dispose().then(() => "disposed"),
				new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 2000)),
			])

			expect(outcome).toBe("disposed")
		})

		it("runs the dispose-time metadata retry when the api-config name is already known even if init never settles", async () => {
			// persistTaskMetadata() only awaits taskApiConfigReady while _taskApiConfigName is still
			// undefined. Once the name is known (a handoff, a resumed history item, or an explicit
			// setTaskApiConfigName), the retry cannot block teardown - so skipping it because the
			// promise has not settled leaves the history entry stale for a task that was perfectly
			// able to repair it.
			const taskDir = path.join(os.tmpdir(), "test-storage", "tasks", "00000000-0000-7000-8000-000000000000")
			fsReal.mkdirSync(taskDir, { recursive: true })
			const historySpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Bracket access for the private fields: the pathological combination - a name that is
			// already resolved while the initialization promise never settles - is not reachable
			// through the public API.
			task["_taskApiConfigName"] = "my-profile"
			task["taskApiConfigReady"] = new Promise<void>(() => {})
			task["taskApiConfigReadySettled"] = false
			task["pendingTaskMetadataRepair"] = true

			const outcome = await Promise.race([
				task.dispose().then(() => "disposed"),
				new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 2000)),
			])

			expect(outcome).toBe("disposed")
			expect(historySpy).toHaveBeenCalledTimes(1)
			historySpy.mockRestore()
		})
	})
})
