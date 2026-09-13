// cd src && npx vitest run core/task/__tests__/Task.persistence.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
	RooCodeEventName,
	type ClineMessage,
	type GlobalState,
	type PendingTaskAction,
	type ProviderSettings,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import type { Anthropic } from "@anthropic-ai/sdk"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { attemptCompletionTool, type AttemptCompletionCallbacks } from "../../tools/AttemptCompletionTool"
import type { AttemptCompletionToolUse } from "../../../shared/tools"

type TaskPersistenceAccess = {
	addToApiConversationHistory: (message: Anthropic.MessageParam) => Promise<void>
	resetAssistantMessagePersistence: () => void
	resolveAssistantMessagePersistence: (result: boolean) => void
	assistantMessagePersistenceCancellation?: { resolve: () => void }
	resumeTaskFromHistory: () => Promise<void>
	resumePendingTaskAction: (action: PendingTaskAction) => Promise<void>
	saveClineMessages: () => Promise<boolean>
	initiateTaskLoop: (userContent: Anthropic.Messages.ContentBlockParam[]) => Promise<void>
}

function getTaskPersistenceAccess(task: Task): TaskPersistenceAccess {
	return task as unknown as TaskPersistenceAccess
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockPWaitFor,
} = vi.hoisted(() => ({
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
	mockTaskMetadata: vi.fn().mockResolvedValue({
		historyItem: { id: "test-id", ts: Date.now(), task: "test" },
		tokenUsage: {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		},
	}),
	mockPWaitFor: vi.fn().mockResolvedValue(undefined),
}))

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		default: {
			mkdir: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue("[]"),
			unlink: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
		},
	}
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		saveApiMessages: mockSaveApiMessages,
		saveTaskMessages: mockSaveTaskMessages,
		readApiMessages: mockReadApiMessages,
		readTaskMessages: mockReadTaskMessages,
		taskMetadata: mockTaskMetadata,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				get: vi.fn(),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				reconcile: vi.fn().mockResolvedValue(undefined),
				initialized: Promise.resolve(),
			}
		}),
	}
})

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
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
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
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Task persistence", () => {
	let mockProvider: ClineProvider & Record<string, any>
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
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
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as ClineProvider & Record<string, any>

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postClineMessageAppended = vi.fn().mockResolvedValue(undefined)
		mockProvider.postClineMessageUpdated = vi.fn().mockResolvedValue(undefined)
		mockProvider.postClineMessagesSnapshot = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.log = vi.fn()
	})

	describe("real Task/provider transcript adapters", () => {
		const historyItem = {
			id: "same-task",
			number: 1,
			ts: 1,
			task: "Same task, distinct instances",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const message = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "text", text })
		const createTask = () =>
			new Task({ provider: mockProvider, apiConfiguration: mockApiConfig, historyItem, startTask: false })

		beforeEach(() => {
			// Keep the real constructor, registry, producer methods and transport. Only
			// editor I/O, persistence and generic metadata services are test doubles.
			mockProvider.postClineMessageAppended = ClineProvider.prototype.postClineMessageAppended
			mockProvider.postClineMessageUpdated = ClineProvider.prototype.postClineMessageUpdated
			mockProvider.postClineMessagesSnapshot = ClineProvider.prototype.postClineMessagesSnapshot
		})

		it("publishes new focus before preparation and clears it before removal cleanup", async () => {
			const task = createTask()
			const post = vi.mocked(mockProvider.postMessageToWebview)
			const preparing = createDeferred<void>()
			const preparation = createDeferred<void>()
			const generation = mockProvider["clineMessagesTransport"].generation
			vi.spyOn(mockProvider, "performPreparationTasks").mockImplementationOnce(async () => {
				preparing.resolve()
				await preparation.promise
			})
			const adding = mockProvider.addClineToStack(task)
			try {
				// The post invocation and invalidation precede even the first async continuation.
				expect(post).toHaveBeenCalledWith({
					type: "clineMessagesFocus",
					taskId: task.taskId,
					taskInstanceId: task.instanceId,
				})
				expect(mockProvider["clineMessagesTransport"].generation).toBe(generation + 1)
				await preparing.promise
			} finally {
				preparation.resolve()
				await adding
			}
			const abortStarted = createDeferred<void>()
			const abort = createDeferred<void>()
			vi.spyOn(task, "abortTask").mockImplementation(async () => {
				abortStarted.resolve()
				await abort.promise
			})
			const removing = mockProvider.removeClineFromStack()
			try {
				expect(mockProvider.getCurrentTask()).toBeUndefined()
				expect(post).toHaveBeenLastCalledWith({
					type: "clineMessagesFocus",
					taskId: undefined,
					taskInstanceId: undefined,
				})
				await abortStarted.promise
				expect(mockProvider["clineMessagesTransport"]["state"].sequences.has(task.taskId)).toBe(false)
			} finally {
				abort.resolve()
				await removing
			}
		})

		it.each([
			"clineMessagesSnapshotStart",
			"clineMessagesSnapshotChunk",
			"clineMessagesSnapshotEnd",
			"clineMessageAppended",
			"clineMessageUpdated",
		] as const)("publishes replacement before cleanup/preparation while old %s is held", async (heldType) => {
			const oldTask = createTask()
			oldTask.clineMessages = [message("old")]
			await mockProvider.addClineToStack(oldTask)
			oldTask["saveClineMessages"] = vi.fn().mockResolvedValue(true)
			const held = createDeferred<void>()
			const started = createDeferred<void>()
			const abort = createDeferred<void>()
			const preparing = createDeferred<void>()
			const preparation = createDeferred<void>()
			let activeSends = 0
			let maximumSends = 0
			const post = vi.mocked(mockProvider.postMessageToWebview).mockImplementation(async (frame) => {
				// Task initialization also posts unrelated metadata/actions outside this FIFO.
				if (frame.taskInstanceId === undefined || frame.type === "clineMessagesFocus") return
				activeSends++
				maximumSends = Math.max(maximumSends, activeSends)
				if (frame.type === heldType && frame.taskInstanceId === oldTask.instanceId) {
					started.resolve()
					await held.promise
				}
				activeSends--
			})
			post.mockClear()
			const active =
				heldType === "clineMessageAppended"
					? oldTask["addToClineMessages"](message("held append"))
					: heldType === "clineMessageUpdated"
						? oldTask["updateClineMessage"](message("held update"))
						: oldTask.overwriteClineMessages([message("held snapshot")], false)
			await started.promise
			const queued = oldTask["updateClineMessage"](message("queued old update"))
			const transport = mockProvider["clineMessagesTransport"]
			const oldGeneration = transport.generation
			const abortSpy = vi.spyOn(oldTask, "abortTask").mockImplementation(async () => {
				const replacement = mockProvider.getCurrentTask()!
				expect(replacement).not.toBe(oldTask)
				expect(replacement.taskId).toBe(oldTask.taskId)
				expect(replacement.instanceId).not.toBe(oldTask.instanceId)
				expect(transport.generation).toBe(oldGeneration + 1)
				expect(post).toHaveBeenLastCalledWith({
					type: "clineMessagesFocus",
					taskId: oldTask.taskId,
					taskInstanceId: replacement.instanceId,
				})
				await abort.promise
			})
			vi.spyOn(mockProvider, "performPreparationTasks").mockImplementation(async () => {
				preparing.resolve()
				await preparation.promise
			})
			const replacing = mockProvider.createTaskWithHistoryItem(historyItem, { startTask: false })
			try {
				await vi.waitFor(() => expect(abortSpy).toHaveBeenCalledOnce())
				await queued // Invalidated callers settle even though the physical post remains held.
				expect(transport["payloads"].size).toBe(0)
				expect(activeSends).toBe(1)
				abort.resolve()
				await preparing.promise
				const beforeRelease = post.mock.calls.length
				held.resolve()
				await active
				expect(post.mock.calls).toHaveLength(beforeRelease) // No old suffix after replacement.
				preparation.resolve()
				const replacement = await replacing
				const newFrames = post.mock.calls
					.slice(beforeRelease)
					.map(([frame]) => frame)
					.filter((frame) => frame.type !== "clineMessagesFocus")
				expect(newFrames.filter((frame) => frame.type !== "state").map((frame) => frame.type)).toEqual([
					"clineMessagesSnapshotStart",
					"clineMessagesSnapshotEnd",
				])
				expect(
					newFrames
						.filter((frame) => frame.type !== "state")
						.every((frame) => frame.taskInstanceId === replacement.instanceId),
				).toBe(true)
				const heldFrame = post.mock.calls.find(([frame]) => frame.type === heldType)![0]
				expect(heldFrame.taskInstanceId).toBe(oldTask.instanceId)
				expect(maximumSends).toBe(1)
				expect(transport["callers"].size).toBe(0)
			} finally {
				held.resolve()
				abort.resolve()
				preparation.resolve()
				await Promise.all([active, queued, replacing])
			}
		})

		it("rejects delayed old producers with the current generation and recovers through new Task producers", async () => {
			vi.useFakeTimers()
			const oldTask = createTask()
			const replacement = createTask()
			const saved = createDeferred<boolean>()
			try {
				await mockProvider.addClineToStack(oldTask)
				oldTask["saveClineMessages"] = vi.fn().mockReturnValueOnce(saved.promise).mockResolvedValue(true)
				replacement["saveClineMessages"] = vi.fn().mockResolvedValue(true)
				await oldTask["updateClineMessage"]({ ...message("leading"), partial: true })
				await oldTask["updateClineMessage"]({ ...message("delayed trailing"), partial: true })
				const overwrite = oldTask.overwriteClineMessages([message("delayed persisted snapshot")])
				// Requeue a trailing callback after overwrite's deliberate cancellation.
				await oldTask["updateClineMessage"]({ ...message("leading again"), partial: true })
				await oldTask["updateClineMessage"]({ ...message("delayed trailing"), partial: true })
				await mockProvider.addClineToStack(replacement)
				const post = vi.mocked(mockProvider.postMessageToWebview)
				post.mockClear()
				const transport = mockProvider["clineMessagesTransport"]
				const before = transport["state"]
				saved.resolve(true)
				await overwrite
				await vi.advanceTimersByTimeAsync(500)
				await oldTask["addToClineMessages"](message("late append"))
				await oldTask["updateClineMessage"](message("late final update"))
				await mockProvider.postClineMessagesSnapshot(oldTask.taskId, {
					generation: transport.generation,
					taskInstanceId: oldTask.instanceId,
					bumpSeq: true,
				})
				expect(post).not.toHaveBeenCalled()
				expect(transport["state"]).toBe(before)

				await replacement.overwriteClineMessages([message("recovered")], false)
				await replacement["addToClineMessages"]({ ...message("new append"), ts: 2 })
				await replacement["updateClineMessage"]({ ...message("new update"), ts: 2 })
				const frames = post.mock.calls.map(([frame]) => frame)
				expect(frames.map((frame) => frame.type)).toEqual([
					"clineMessagesSnapshotStart",
					"clineMessagesSnapshotChunk",
					"clineMessagesSnapshotEnd",
					"clineMessageAppended",
					"clineMessageUpdated",
				])
				expect(frames.every((frame) => frame.taskInstanceId === replacement.instanceId)).toBe(true)
				const seq = before.sequences.get(replacement.taskId) ?? 0
				expect(frames.map((frame) => frame.clineMessagesSeq)).toEqual([
					seq + 1,
					seq + 1,
					seq + 1,
					seq + 2,
					seq + 3,
				])
			} finally {
				saved.resolve(true)
				oldTask["debouncedPostPartialMessageUpdate"].cancel()
				replacement["debouncedPostPartialMessageUpdate"].cancel()
				vi.useRealTimers()
			}
		})
	})

	// ── saveApiConversationHistory (via retrySaveApiConversationHistory) ──

	describe("saveApiConversationHistory", () => {
		it("returns true on success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce([])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			})

			const result = await task.retrySaveApiConversationHistory()
			expect(result).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledWith(expect.objectContaining({ merge: true }))
		})

		it("uses authoritative replacement for explicit API history overwrites", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await task.overwriteApiConversationHistory([{ role: "user", content: "replacement" }])

			expect(mockSaveApiMessages).toHaveBeenCalledWith(expect.objectContaining({ merge: false }))
		})

		it("can hydrate API history without persisting it", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await task.overwriteApiConversationHistory([{ role: "user", content: "merged" }], false)

			expect(task.apiConversationHistory).toEqual([
				expect.objectContaining({ role: "user", content: "merged", messageId: expect.any(String) }),
			])
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("returns false on failure", async () => {
			vi.useFakeTimers()

			// All 3 retry attempts must fail for retrySaveApiConversationHistory to return false
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockRejectedValueOnce(new Error("fail 3"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)

			vi.useRealTimers()
		})

		it("succeeds on 2nd retry attempt", async () => {
			vi.useFakeTimers()

			mockSaveApiMessages.mockRejectedValueOnce(new Error("fail 1")).mockResolvedValueOnce(undefined) // succeeds on 2nd try

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)

			vi.useRealTimers()
		})

		it("snapshots the array before passing to saveApiMessages", async () => {
			mockSaveApiMessages.mockResolvedValueOnce([])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const originalMsg = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "snapshot test" }],
			}
			task.apiConversationHistory.push(originalMsg)

			await task.retrySaveApiConversationHistory()

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveApiMessages.mock.calls[0][0]
			// The messages passed should be a COPY, not the live reference
			expect(callArgs.messages).not.toBe(task.apiConversationHistory)
			// But the content should be the same
			expect(callArgs.messages).toEqual(task.apiConversationHistory)
		})

		it("settles the current assistant persistence boundary only for assistant messages", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const privateTask = getTaskPersistenceAccess(task)
			const waiting = task.waitForCurrentAssistantMessagePersistence()
			let settled = false
			void waiting.then(() => {
				settled = true
			})

			await privateTask.addToApiConversationHistory({ role: "user", content: "hello" })
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(settled).toBe(false)

			await privateTask.addToApiConversationHistory({ role: "assistant", content: "done" })
			await expect(waiting).resolves.toBe(true)
			expect(task.assistantMessageSavedToHistory).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)
		})

		it("invalidates a cached successful persistence result when the generation is disposed", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			await getTaskPersistenceAccess(task).addToApiConversationHistory({ role: "assistant", content: "done" })

			await expect(task.waitForCurrentAssistantMessagePersistence()).resolves.toBe(true)
			void task.dispose()
			await expect(task.waitForCurrentAssistantMessagePersistence()).resolves.toBe(false)
		})

		it("shares one retry operation across concurrent persistence waiters", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("initial write failed"))
				.mockResolvedValueOnce(undefined)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({ role: "assistant", content: "done" })
				const first = task.waitForCurrentAssistantMessagePersistence()
				const second = task.waitForCurrentAssistantMessagePersistence()

				await vi.runAllTimersAsync()
				await expect(Promise.all([first, second])).resolves.toEqual([true, true])
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)
			} finally {
				vi.useRealTimers()
			}
		})

		it("lets same-turn cancellation win over a successful persistence result", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const privateTask = getTaskPersistenceAccess(task)
			const waiting = task.waitForCurrentAssistantMessagePersistence()

			privateTask.resolveAssistantMessagePersistence(true)
			privateTask.assistantMessagePersistenceCancellation?.resolve()

			await expect(waiting).resolves.toBe(false)
		})

		it("emits TaskCompleted only after API history persistence succeeds", async () => {
			const saveDeferred = createDeferred<void>()
			mockSaveApiMessages.mockReturnValueOnce(saveDeferred.promise)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const privateTask = getTaskPersistenceAccess(task)
			const completionCallId = "completion-call"
			let saveSettled = false
			let completionEmitted = false
			let saving: Promise<void> | undefined

			try {
				vi.spyOn(task, "say").mockResolvedValue(undefined)
				vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
				vi.spyOn(task, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
				vi.spyOn(task, "flushTelemetryInstallment").mockImplementation(() => undefined)
				task.on(RooCodeEventName.TaskCompleted, () => {
					completionEmitted = true
				})

				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					id: completionCallId,
					name: "attempt_completion",
					params: { result: "done" },
					nativeArgs: { result: "done" },
					partial: false,
				}
				const callbacks: AttemptCompletionCallbacks = {
					askApproval: vi.fn(),
					handleError: vi.fn(),
					pushToolResult: vi.fn(),
					askFinishSubTaskApproval: vi.fn(),
					toolDescription: vi.fn(),
					toolCallId: completionCallId,
				}

				const handlingCompletion = attemptCompletionTool.handle(task, block, callbacks)
				await vi.waitFor(() => expect(task.ask).toHaveBeenCalled())

				expect(callbacks.handleError).not.toHaveBeenCalled()
				expect(completionEmitted).toBe(false)
				expect(mockSaveApiMessages).not.toHaveBeenCalled()

				saving = privateTask.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: completionCallId,
							name: "attempt_completion",
							input: { result: "done" },
						},
					],
				})
				void saving.finally(() => {
					saveSettled = true
				})
				await vi.waitFor(() => expect(mockSaveApiMessages).toHaveBeenCalledTimes(1))
				const saveRequest = mockSaveApiMessages.mock.calls[0][0]
				expect(saveRequest.taskId).toBe(task.taskId)
				expect(saveRequest.messages).toEqual([
					expect.objectContaining({
						role: "assistant",
						content: expect.arrayContaining([
							expect.objectContaining({
								type: "tool_use",
								id: completionCallId,
								name: "attempt_completion",
							}),
						]),
					}),
				])
				expect(saveSettled).toBe(false)
				expect(completionEmitted).toBe(false)

				saveDeferred.resolve(undefined)
				await Promise.all([saving, handlingCompletion])

				expect(callbacks.handleError).not.toHaveBeenCalled()
				expect(completionEmitted).toBe(true)
			} finally {
				saveDeferred.resolve(undefined)
				await saving
			}
		})

		it("does not emit TaskCompleted when API history persistence exhausts its retries", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockRejectedValue(new Error("write failed"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const completionCallId = "failed-completion-call"
			const privateTask = getTaskPersistenceAccess(task)
			const callbacks: AttemptCompletionCallbacks = {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
				askFinishSubTaskApproval: vi.fn(),
				toolDescription: vi.fn(),
				toolCallId: completionCallId,
			}
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
			vi.spyOn(task, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
			vi.spyOn(task, "flushTelemetryInstallment").mockImplementation(() => undefined)
			const completionListener = vi.fn()
			task.on(RooCodeEventName.TaskCompleted, completionListener)

			try {
				await privateTask.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: completionCallId,
							name: "attempt_completion",
							input: { result: "done" },
						},
					],
				})

				const handlingCompletion = attemptCompletionTool.handle(
					task,
					{
						type: "tool_use",
						id: completionCallId,
						name: "attempt_completion",
						params: { result: "done" },
						nativeArgs: { result: "done" },
						partial: false,
					},
					callbacks,
				)
				await vi.runAllTimersAsync()
				await handlingCompletion

				expect(mockSaveApiMessages).toHaveBeenCalledTimes(4)
				expect(completionListener).not.toHaveBeenCalled()
				expect(callbacks.handleError).toHaveBeenCalledWith(
					"persisting task completion",
					expect.objectContaining({
						message: "Failed to persist API conversation history before task completion",
					}),
				)
			} finally {
				mockSaveApiMessages.mockResolvedValue(undefined)
				vi.useRealTimers()
			}
		})

		it("emits TaskCompleted after a failed assistant save succeeds on retry", async () => {
			vi.useFakeTimers()
			const retryDeferred = createDeferred<void>()
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("initial write failed"))
				.mockReturnValueOnce(retryDeferred.promise)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const completionCallId = "retried-completion-call"
			const callbacks: AttemptCompletionCallbacks = {
				askApproval: vi.fn(),
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
				askFinishSubTaskApproval: vi.fn(),
				toolDescription: vi.fn(),
				toolCallId: completionCallId,
			}
			vi.spyOn(task, "say").mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
			vi.spyOn(task, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
			vi.spyOn(task, "flushTelemetryInstallment").mockImplementation(() => undefined)
			const completionListener = vi.fn()
			task.on(RooCodeEventName.TaskCompleted, completionListener)

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: completionCallId,
							name: "attempt_completion",
							input: { result: "done" },
						},
					],
				})

				const handlingCompletion = attemptCompletionTool.handle(
					task,
					{
						type: "tool_use",
						id: completionCallId,
						name: "attempt_completion",
						params: { result: "done" },
						nativeArgs: { result: "done" },
						partial: false,
					},
					callbacks,
				)
				expect(completionListener).not.toHaveBeenCalled()

				// Advance past the 100 ms retry delay so the retry save starts.
				await vi.advanceTimersByTimeAsync(150)
				await vi.waitFor(() => expect(mockSaveApiMessages).toHaveBeenCalledTimes(2))
				// Completion must not fire while the retry save is still in-flight.
				expect(completionListener).not.toHaveBeenCalled()

				// Settle the retry save; completion should follow.
				retryDeferred.resolve(undefined)
				await handlingCompletion

				expect(callbacks.handleError).not.toHaveBeenCalled()
				expect(completionListener).toHaveBeenCalledTimes(1)
				expect(task.assistantMessageSavedToHistory).toBe(true)
				expect(vi.mocked(mockSaveApiMessages).mock.invocationCallOrder[1]).toBeLessThan(
					vi.mocked(completionListener).mock.invocationCallOrder[0],
				)
			} finally {
				retryDeferred.resolve(undefined)
				vi.useRealTimers()
			}
		})

		it("settles a pending assistant persistence wait when the task is disposed", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const waiting = task.waitForCurrentAssistantMessagePersistence()
			void task.dispose()

			await expect(waiting).resolves.toBe(false)
		})

		it("cancels a persistence wait while failed history is awaiting retry", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockRejectedValueOnce(new Error("write failed"))
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "completion" }],
				})
				const waiting = task.waitForCurrentAssistantMessagePersistence()

				await vi.advanceTimersByTimeAsync(50)
				void task.dispose()

				await expect(waiting).resolves.toBe(false)
				await Promise.resolve()
				expect(vi.getTimerCount()).toBe(0)
				await vi.runAllTimersAsync()
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it("settles the previous persistence generation when a new request resets the barrier", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			const waiting = task.waitForCurrentAssistantMessagePersistence()

			getTaskPersistenceAccess(task).resetAssistantMessagePersistence()

			await expect(waiting).resolves.toBe(false)
			void task.dispose()
		})

		it("does not retry when cancelled after the delay resolves but before persistence starts", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockRejectedValueOnce(new Error("initial write failed")).mockResolvedValue(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "message" }],
				})
				const waiting = task.waitForCurrentAssistantMessagePersistence()

				// Resolve the delay without flushing its promise continuation, then cancel at the save boundary.
				await Promise.resolve()
				vi.advanceTimersByTime(100)
				void task.dispose()

				await expect(waiting).resolves.toBe(false)
				expect(task.assistantMessageSavedToHistory).toBe(false)
				await vi.runAllTimersAsync()

				expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not mark persistence ready when cancelled during a retry write", async () => {
			vi.useFakeTimers()
			const retrySave = createDeferred<void>()
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("initial write failed"))
				.mockReturnValueOnce(retrySave.promise)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "message" }],
				})
				const waiting = task.waitForCurrentAssistantMessagePersistence()

				await vi.advanceTimersByTimeAsync(100)
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)
				void task.dispose()
				retrySave.resolve(undefined)

				await expect(waiting).resolves.toBe(false)
				expect(task.assistantMessageSavedToHistory).toBe(false)
			} finally {
				retrySave.resolve(undefined)
				vi.useRealTimers()
			}
		})

		it("retries failed assistant persistence before flushing dependent tool results", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("initial assistant write failed"))
				.mockResolvedValue(undefined)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
				})
				task.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]

				const flushing = task.flushPendingToolResultsToHistory()
				await vi.runAllTimersAsync()

				await expect(flushing).resolves.toBe(true)
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)
				expect(task.assistantMessageSavedToHistory).toBe(true)
				expect(task.userMessageContent).toEqual([])
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not wait or flush dependent tool results after abort", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			task.abort = true
			task.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]
			const waitForPersistence = vi.spyOn(task, "waitForCurrentAssistantMessagePersistence")

			await expect(task.flushPendingToolResultsToHistory()).resolves.toBe(false)
			expect(waitForPersistence).not.toHaveBeenCalled()
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("does not flush dependent tool results when the persistence barrier is cancelled", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})
			task.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]
			vi.spyOn(task, "waitForCurrentAssistantMessagePersistence").mockResolvedValue(false)

			await expect(task.flushPendingToolResultsToHistory()).resolves.toBe(false)
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("does not flush dependent tool results when assistant persistence retries are exhausted", async () => {
			vi.useFakeTimers()
			mockSaveApiMessages.mockRejectedValue(new Error("assistant write failed"))
			const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			try {
				await getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
				})
				task.userMessageContent = [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }]

				const flushing = task.flushPendingToolResultsToHistory()
				await vi.runAllTimersAsync()

				await expect(flushing).resolves.toBe(false)
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(4)
				expect(task.assistantMessageSavedToHistory).toBe(false)
				expect(task.userMessageContent).toHaveLength(1)
				expect(consoleWarn).toHaveBeenCalledWith(
					expect.stringContaining("failed to persist assistant message"),
					expect.any(Error),
				)
			} finally {
				consoleWarn.mockRestore()
				mockSaveApiMessages.mockResolvedValue(undefined)
				vi.useRealTimers()
			}
		})
	})

	// ── saveClineMessages ────────────────────────────────────────────────

	describe("saveClineMessages", () => {
		it("returns true on success", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce([])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveClineMessages()
			expect(result).toBe(true)
			expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ merge: true }))
		})

		it("uses authoritative replacement for explicit UI history overwrites", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await task.overwriteClineMessages([{ ts: 1, type: "say", say: "text", text: "replacement" }])

			expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ merge: false }))
		})

		it("can hydrate UI history without persisting it", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			await task.overwriteClineMessages([{ ts: 1, type: "say", say: "text", text: "merged" }], false)

			expect(task.clineMessages).toEqual([
				expect.objectContaining({ ts: 1, text: "merged", messageId: expect.any(String) }),
			])
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
		})

		it("returns false on failure", async () => {
			mockSaveTaskMessages.mockRejectedValueOnce(new Error("write error"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveClineMessages()
			expect(result).toBe(false)
		})

		it("snapshots the array before passing to saveTaskMessages", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce([])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.clineMessages.push({
				type: "say",
				say: "text",
				text: "snapshot test",
				ts: Date.now(),
			})

			await (task as Record<string, any>).saveClineMessages()

			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveTaskMessages.mock.calls[0][0]
			// The messages passed should be a COPY, not the live reference
			expect(callArgs.messages).not.toBe(task.clineMessages)
			// But the content should be the same
			expect(callArgs.messages).toEqual(task.clineMessages)
		})

		it("preserves an existing lifecycle status during metadata saves", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce([])
			mockTaskMetadata.mockResolvedValueOnce({
				historyItem: {
					id: "task-with-advanced-status",
					ts: Date.now(),
					task: "test",
					status: "interrupted",
					tokensIn: 10,
				},
				tokenUsage: {
					totalTokensIn: 10,
					totalTokensOut: 0,
					totalCacheWrites: 0,
					totalCacheReads: 0,
					totalCost: 0,
					contextTokens: 0,
				},
			})

			const updateTaskHistory = vi.fn().mockResolvedValue([])
			const taskHistoryStore = {
				get: vi.fn().mockReturnValue({ id: "task-with-advanced-status", status: "completed" }),
			}
			const provider = { ...mockProvider, updateTaskHistory, taskHistoryStore }
			const task = new Task({
				provider: provider as any,
				apiConfiguration: mockApiConfig,
				taskId: "task-with-advanced-status",
				task: "test task",
				startTask: false,
				initialStatus: "interrupted",
			})

			await (task as Record<string, any>).saveClineMessages()

			expect(updateTaskHistory).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "task-with-advanced-status",
					status: "completed",
					tokensIn: 10,
				}),
			)
		})
	})

	// ── abortTask history hydration guard ─────────────────────────────────

	describe("abortTask", () => {
		it("skips persistence when a history task aborts before messages load", async () => {
			const messagesDeferred = createDeferred<ClineMessage[]>()
			mockReadTaskMessages.mockReturnValueOnce(messagesDeferred.promise)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "history-task",
					number: 1,
					ts: Date.now(),
					task: "Original task title",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})

			const resumePromise = task.run().catch(() => {})

			await task.abortTask()

			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
			expect(mockProvider.updateTaskHistory).not.toHaveBeenCalled()

			messagesDeferred.resolve([])
			await resumePromise
		})

		it("persists a history task when messages load before abort", async () => {
			const messages = [
				{
					ts: Date.now(),
					type: "say" as const,
					say: "text" as const,
					text: "Loaded task message",
				},
			] satisfies ClineMessage[]
			const messagesDeferred = createDeferred<typeof messages>()
			mockReadTaskMessages.mockReturnValueOnce(messagesDeferred.promise).mockResolvedValue(messages)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "history-task",
					number: 1,
					ts: Date.now(),
					task: "Original task title",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })

			mockReadApiMessages.mockResolvedValue([
				{
					role: "user",
					content: [{ type: "text", text: "Original task" }],
				},
			])

			const resumePromise = getTaskPersistenceAccess(task).resumeTaskFromHistory()
			messagesDeferred.resolve(messages)
			await resumePromise

			const saveCallsBeforeAbort = mockSaveTaskMessages.mock.calls.length
			expect(saveCallsBeforeAbort).toBeGreaterThan(0)
			expect(mockProvider.updateTaskHistory).toHaveBeenCalled()

			await task.abortTask()
			expect(mockSaveTaskMessages.mock.calls.length).toBeGreaterThan(saveCallsBeforeAbort)
		})

		it("persists an empty non-history task when aborted", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "New task",
				startTask: false,
			})
			const saveClineMessagesSpy = vi.spyOn(getTaskPersistenceAccess(task), "saveClineMessages")

			await task.abortTask()

			expect(saveClineMessagesSpy).toHaveBeenCalledTimes(1)
			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1)
		})
	})

	// ── resumeTaskFromHistory — interrupted tool calls must be recorded as errors ──

	describe("resumeTaskFromHistory interrupted tool calls", () => {
		const interruptedToolResultContent = "Task was interrupted before this tool call could be completed."

		it("marks synthetic tool_results from an interrupted assistant turn as errors", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "interrupted-subtask",
					number: 1,
					ts: Date.now(),
					task: "Interrupted subtask",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
				initialStatus: "interrupted",
			})
			// Stop the resume flow right before the agentic loop so the test only
			// exercises history reconstruction; the loop would make a real API call.
			const initiateTaskLoopSpy = vi
				.spyOn(getTaskPersistenceAccess(task), "initiateTaskLoop")
				.mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })

			// The persisted history ends with an assistant turn whose tool calls
			// (attempt_completion) were never answered because the task was
			// interrupted. See: https://github.com/Zoo-Code-Org/Zoo-Code/issues/1283
			mockReadApiMessages.mockResolvedValue([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Wrapping up" },
						{
							type: "tool_use",
							id: "toolu_interrupted_1",
							name: "attempt_completion",
							input: { result: "done" },
						},
					],
				},
			])

			await getTaskPersistenceAccess(task).resumeTaskFromHistory()

			expect(initiateTaskLoopSpy).toHaveBeenCalledTimes(1)
			const newUserContent = initiateTaskLoopSpy.mock.calls[0][0]
			const toolResults = newUserContent.filter((block) => block.type === "tool_result")
			// The synthetic tool_result must be recorded as an error so the history
			// cannot be misread as a successful completion of the interrupted call.
			expect(toolResults).toEqual([
				{
					type: "tool_result",
					tool_use_id: "toolu_interrupted_1",
					content: interruptedToolResultContent,
					is_error: true,
				},
			])
		})

		it("marks missing tool_results for an interrupted trailing user turn as errors", async () => {
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "interrupted-subtask-2",
					number: 2,
					ts: Date.now(),
					task: "Interrupted subtask 2",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
				initialStatus: "interrupted",
			})
			const initiateTaskLoopSpy = vi
				.spyOn(getTaskPersistenceAccess(task), "initiateTaskLoop")
				.mockResolvedValue(undefined)
			vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })

			// The persisted history ends with a user turn that only answered the
			// first of two parallel tool calls.
			mockReadApiMessages.mockResolvedValue([
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_int_a",
							name: "execute_command",
							input: { command: "ls" },
						},
						{ type: "tool_use", id: "toolu_int_b", name: "read_file", input: { path: "a.txt" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_int_a",
							content: "partial result",
						},
					],
				},
			])

			await getTaskPersistenceAccess(task).resumeTaskFromHistory()

			expect(initiateTaskLoopSpy).toHaveBeenCalledTimes(1)
			const newUserContent = initiateTaskLoopSpy.mock.calls[0][0]
			const toolResults = newUserContent.filter((block) => block.type === "tool_result")
			// The pre-existing result is preserved untouched; the synthesized one
			// for the unanswered tool call is marked as an error.
			expect(toolResults).toEqual([
				{
					type: "tool_result",
					tool_use_id: "toolu_int_a",
					content: "partial result",
				},
				{
					type: "tool_result",
					tool_use_id: "toolu_int_b",
					content: interruptedToolResultContent,
					is_error: true,
				},
			])
		})
	})

	describe("pending action resume", () => {
		const pendingAction: PendingTaskAction = {
			kind: "finish_subtask",
			actionId: "finish-action",
			approvalText: JSON.stringify({ tool: "finishTask" }),
			parentTaskId: "parent-1",
			result: "Done",
		}

		it("awaits the hydrated snapshot before replaying an unresolved pending action instead of a generic resume ask", async () => {
			const messages: ClineMessage[] = [
				{ ts: 1, type: "say", say: "text", text: "Child" },
				{ ts: 2, type: "ask", ask: "tool", text: pendingAction.approvalText },
			]
			mockReadTaskMessages.mockResolvedValue(messages)
			mockReadApiMessages.mockResolvedValue([
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "finish-action", name: "attempt_completion", input: {} }],
				},
			])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})
			const events: string[] = []
			const replay = vi
				.spyOn(getTaskPersistenceAccess(task), "resumePendingTaskAction")
				.mockImplementation(async () => {
					events.push("replay")
					expect(task.isInitialized).toBe(true)
				})
			const ask = vi.spyOn(task, "ask")
			const snapshotStarted = createDeferred<void>()
			const snapshotDeferred = createDeferred<void>()
			const snapshot = vi.mocked(mockProvider.postClineMessagesSnapshot).mockImplementationOnce(async () => {
				events.push("snapshot started")
				snapshotStarted.resolve()
				await snapshotDeferred.promise
				events.push("snapshot resolved")
			})

			const resumePromise = getTaskPersistenceAccess(task)
				.resumeTaskFromHistory()
				.then(() => {
					events.push("resume finished")
				})
			try {
				// An explicit entry signal avoids polling or guessed microtask counts. Racing resume settlement
				// also makes a swapped branch that returns before the snapshot fail without hanging the test.
				await Promise.race([snapshotStarted.promise, resumePromise])
				expect(snapshot).toHaveBeenCalledExactlyOnceWith(task.taskId, {
					bumpSeq: true,
					taskInstanceId: task.instanceId,
				})
				expect(events).toEqual(["snapshot started"])
				expect(replay).not.toHaveBeenCalled()
				expect(ask).not.toHaveBeenCalled()
				expect(task.isInitialized).toBe(false)
				expect(task.clineMessages).toEqual([expect.objectContaining({ text: "Child" })])
				expect(task.apiConversationHistory).toEqual([
					expect.objectContaining({
						role: "assistant",
						content: [{ type: "tool_use", id: "finish-action", name: "attempt_completion", input: {} }],
					}),
				])
			} finally {
				snapshotDeferred.resolve()
				await resumePromise
			}

			expect(events).toEqual(["snapshot started", "snapshot resolved", "replay", "resume finished"])
			expect(replay).toHaveBeenCalledExactlyOnceWith(pendingAction)
			expect(ask).not.toHaveBeenCalled()
			expect(task.clineMessages).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ text: pendingAction.approvalText })]),
			)
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
		})

		it("reconciles an already-persisted tool result before generic resume", async () => {
			mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Child" }])
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }] },
			])
			mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(true)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})
			vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
			vi.spyOn(getTaskPersistenceAccess(task), "initiateTaskLoop").mockResolvedValue(undefined)
			const replay = vi.spyOn(getTaskPersistenceAccess(task), "resumePendingTaskAction")

			await getTaskPersistenceAccess(task).resumeTaskFromHistory()

			expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledWith("child-1", "finish-action")
			expect(replay).not.toHaveBeenCalled()
			expect(task.ask).toHaveBeenCalledWith("resume_task")
		})

		it.each(["abort", "abandoned"] as const)(
			"does not publish resumed history when %s occurs during pending-action reconciliation",
			async (flag) => {
				mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Child" }])
				mockReadApiMessages.mockResolvedValue([
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
					},
				])
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem: {
						id: "child-1",
						number: 1,
						ts: 1,
						task: "Child",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						pendingAction,
					},
					startTask: false,
				})
				const clearing = createDeferred<boolean>()
				mockProvider.clearPendingTaskAction = vi.fn().mockReturnValueOnce(clearing.promise)
				const ask = vi.spyOn(task, "ask")
				const replay = vi.spyOn(getTaskPersistenceAccess(task), "resumePendingTaskAction")
				const resumePromise = task.run()

				await vi.waitFor(() => expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledOnce())
				task[flag] = true
				clearing.resolve(true)
				await resumePromise

				expect(mockProvider.postClineMessagesSnapshot).not.toHaveBeenCalled()
				expect(ask).not.toHaveBeenCalled()
				expect(replay).not.toHaveBeenCalled()
				expect(mockSaveTaskMessages).not.toHaveBeenCalled()
			},
		)

		it("clears pending metadata after the matching tool result is saved", async () => {
			mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(true)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})

			await getTaskPersistenceAccess(task).addToApiConversationHistory({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
			})

			expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledWith("child-1", "finish-action")
		})

		it("retries a rejected tool-result save before clearing pending metadata", async () => {
			vi.useFakeTimers()
			try {
				mockSaveApiMessages
					.mockRejectedValueOnce(new Error("temporary failure"))
					.mockResolvedValueOnce(undefined)
				mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(true)
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem: {
						id: "child-1",
						number: 1,
						ts: 1,
						task: "Child",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						pendingAction,
					},
					startTask: false,
				})

				const saving = getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
				})
				await vi.advanceTimersByTimeAsync(0)
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(100)
				await saving
				expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)
				expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledWith("child-1", "finish-action")
			} finally {
				vi.useRealTimers()
			}
		})

		it("reconciles stale in-memory metadata after an idempotent clear without clearing a newer action", async () => {
			mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(false)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})
			const storeGet = vi.mocked(mockProvider.taskHistoryStore.get)
			storeGet.mockReturnValueOnce(undefined)

			await getTaskPersistenceAccess(task).addToApiConversationHistory({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
			})

			const taskState = task as unknown as { pendingAction?: PendingTaskAction }
			expect(taskState.pendingAction).toBeUndefined()

			const newerAction: PendingTaskAction = { ...pendingAction, actionId: "newer-action" }
			task.setPendingTaskAction(pendingAction)
			storeGet.mockReturnValueOnce({
				id: "child-1",
				number: 1,
				ts: 1,
				task: "Child",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				pendingAction: newerAction,
			})
			await getTaskPersistenceAccess(task).addToApiConversationHistory({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied again" }],
			})

			expect(taskState.pendingAction).toEqual(newerAction)
		})

		it("does not clear a newer in-memory action after the matching clear finishes", async () => {
			let finishClear!: (cleared: boolean) => void
			const clearing = new Promise<boolean>((resolve) => {
				finishClear = resolve
			})
			mockProvider.clearPendingTaskAction = vi.fn(() => clearing)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})
			const newerAction: PendingTaskAction = { ...pendingAction, actionId: "newer-action" }

			const saving = getTaskPersistenceAccess(task).addToApiConversationHistory({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
			})
			await vi.waitFor(() => expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledTimes(1))
			task.setPendingTaskAction(newerAction)
			finishClear(true)
			await saving

			expect((task as unknown as { pendingAction?: PendingTaskAction }).pendingAction).toEqual(newerAction)
		})

		it("leaves a newer action untouched when an obsolete durable result arrives", async () => {
			mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(true)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})
			const newerAction: PendingTaskAction = { ...pendingAction, actionId: "newer-action" }
			task.setPendingTaskAction(newerAction)

			await getTaskPersistenceAccess(task).addToApiConversationHistory({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Late denial" }],
			})

			expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
			expect((task as unknown as { pendingAction?: PendingTaskAction }).pendingAction).toEqual(newerAction)
		})

		it("retains the pending action when clearing metadata throws after a durable save", async () => {
			const clearError = new Error("metadata store unavailable")
			mockProvider.clearPendingTaskAction = vi.fn().mockRejectedValue(clearError)
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction,
				},
				startTask: false,
			})

			await expect(
				getTaskPersistenceAccess(task).addToApiConversationHistory({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "finish-action", content: "Denied" }],
				}),
			).resolves.toBeUndefined()

			expect((task as unknown as { pendingAction?: PendingTaskAction }).pendingAction).toEqual(pendingAction)
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining("Failed to clear pending action for child-1"),
				clearError,
			)
			consoleError.mockRestore()
		})

		it("completes the deny-with-feedback lifecycle using the sanitized action id", async () => {
			const rawToolUseId = "finish.action/with spaces"
			const sanitizedActionId = "finish_action_with_spaces"
			const lifecycleAction: PendingTaskAction = {
				...pendingAction,
				actionId: sanitizedActionId,
			}
			mockProvider.clearPendingTaskAction = vi.fn().mockResolvedValue(true)
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "child-1",
					number: 1,
					ts: 1,
					task: "Child",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					pendingAction: lifecycleAction,
				},
				startTask: false,
			})
			vi.spyOn(task, "ask").mockResolvedValue({
				response: "messageResponse",
				text: "Please revise",
				queuedMessageId: "queued-lifecycle",
			})
			const persist = vi.spyOn(task, "persistQueuedFeedbackAndAcknowledge").mockResolvedValue(true)
			const initiate = vi
				.spyOn(getTaskPersistenceAccess(task), "initiateTaskLoop")
				.mockImplementation(async (content) => {
					await getTaskPersistenceAccess(task).addToApiConversationHistory({ role: "user", content })
				})

			await getTaskPersistenceAccess(task).resumePendingTaskAction(lifecycleAction)

			expect(rawToolUseId).not.toBe(sanitizedActionId)
			expect(persist).toHaveBeenCalledWith("queued-lifecycle", "Please revise", undefined)
			expect(initiate).toHaveBeenCalledWith([
				expect.objectContaining({ type: "tool_result", tool_use_id: sanitizedActionId }),
			])
			expect(mockSaveApiMessages).toHaveBeenCalled()
			expect(mockProvider.clearPendingTaskAction).toHaveBeenCalledWith("child-1", sanitizedActionId)
			expect(persist.mock.invocationCallOrder[0]).toBeLessThan(initiate.mock.invocationCallOrder[0])
		})
	})

	describe("resumeTaskFromHistory", () => {
		it.each(["active", "completed"] as const)(
			"publishes hydrated history before the %s task resume prompt",
			async (status) => {
				const messages = [
					{ ts: 1, type: "say", say: "text", text: "Saved transcript" },
				] satisfies ClineMessage[]
				const apiMessages: Task["apiConversationHistory"] = [{ role: "user", content: "Saved API history" }]
				const apiRead = createDeferred<typeof apiMessages>()
				const snapshotDeferred = createDeferred<void>()
				mockReadTaskMessages.mockResolvedValue(messages)
				mockReadApiMessages.mockReturnValueOnce(apiRead.promise)
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem: {
						id: "history-snapshot",
						number: 1,
						ts: 1,
						task: "Saved task",
						status,
						tokensIn: 10,
						tokensOut: 5,
						totalCost: 0.001,
					},
					initialStatus: status,
					startTask: false,
				})
				const snapshot = vi.mocked(mockProvider.postClineMessagesSnapshot).mockImplementationOnce(() => {
					expect(task.clineMessages).toEqual(messages)
					expect(task.apiConversationHistory).toEqual(apiMessages)
					return snapshotDeferred.promise
				})
				const stopAfterPrompt = new Error("stop after resume prompt")
				const ask = vi.spyOn(task, "ask").mockRejectedValueOnce(stopAfterPrompt)
				const resumePromise = task.run()
				const completion = expect(resumePromise).rejects.toThrow(stopAfterPrompt)

				await vi.waitFor(() => expect(mockReadApiMessages).toHaveBeenCalledOnce())
				expect(snapshot).not.toHaveBeenCalled()
				expect(ask).not.toHaveBeenCalled()
				apiRead.resolve(apiMessages)

				await vi.waitFor(() =>
					expect(snapshot).toHaveBeenCalledWith(task.taskId, {
						bumpSeq: true,
						taskInstanceId: task.instanceId,
					}),
				)
				expect(ask).not.toHaveBeenCalled()
				expect(mockSaveTaskMessages).not.toHaveBeenCalled()
				expect(mockSaveApiMessages).not.toHaveBeenCalled()
				snapshotDeferred.resolve()
				await completion

				expect(snapshot).toHaveBeenCalledOnce()
				expect(ask).toHaveBeenCalledWith(status === "completed" ? "resume_completed_task" : "resume_task")
				expect(mockSaveTaskMessages).not.toHaveBeenCalled()
				expect(mockSaveApiMessages).not.toHaveBeenCalled()
			},
		)

		it.each(["abort", "abandoned"] as const)(
			"does not prompt when %s occurs during resume snapshot delivery",
			async (flag) => {
				mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Saved transcript" }])
				mockReadApiMessages.mockResolvedValue([{ role: "user", content: "Saved API history" }])
				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem: {
						id: "cancel-resume-snapshot",
						number: 1,
						ts: 1,
						task: "Saved task",
						tokensIn: 10,
						tokensOut: 5,
						totalCost: 0.001,
					},
					startTask: false,
				})
				const snapshotDeferred = createDeferred<void>()
				const snapshot = vi
					.mocked(mockProvider.postClineMessagesSnapshot)
					.mockReturnValueOnce(snapshotDeferred.promise)
				const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })
				const resumePromise = task.run()

				await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce())
				task[flag] = true
				snapshotDeferred.resolve()
				await resumePromise

				expect(ask).not.toHaveBeenCalled()
				expect(mockSaveTaskMessages).not.toHaveBeenCalled()
				expect(mockSaveApiMessages).not.toHaveBeenCalled()
			},
		)

		it("does not prompt or persist when the resume snapshot fails", async () => {
			mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Saved transcript" }])
			mockReadApiMessages.mockResolvedValue([{ role: "user", content: "Saved API history" }])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "failed-resume-snapshot",
					number: 1,
					ts: 1,
					task: "Saved task",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			const snapshotError = new Error("resume snapshot failed")
			vi.mocked(mockProvider.postClineMessagesSnapshot).mockRejectedValueOnce(snapshotError)
			const ask = vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" })

			await expect(task.run()).rejects.toThrow(snapshotError)

			expect(ask).not.toHaveBeenCalled()
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("can hydrate and reach the resume prompt without a provider reference", async () => {
			mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Saved transcript" }])
			mockReadApiMessages.mockResolvedValue([{ role: "user", content: "Saved API history" }])
			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "missing-provider-resume",
					number: 1,
					ts: 1,
					task: "Saved task",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			vi.spyOn(task["providerRef"], "deref").mockReturnValue(undefined)
			const stopAfterPrompt = new Error("stop after resume prompt")
			const ask = vi.spyOn(task, "ask").mockRejectedValueOnce(stopAfterPrompt)

			await expect(task.run()).rejects.toThrow(stopAfterPrompt)

			expect(task.clineMessages).toEqual([expect.objectContaining({ text: "Saved transcript" })])
			expect(task.apiConversationHistory).toEqual([expect.objectContaining({ content: "Saved API history" })])
			expect(ask).toHaveBeenCalledWith("resume_task")
			expect(mockProvider.postClineMessagesSnapshot).not.toHaveBeenCalled()
		})

		it.each(["not_found", "invalid", "io_error"] as const)(
			"does not persist when hydration fails with %s",
			async (kind) => {
				mockReadTaskMessages.mockRejectedValue(Object.assign(new Error(`history ${kind}`), { kind }))

				const task = new Task({
					provider: mockProvider,
					apiConfiguration: mockApiConfig,
					historyItem: {
						id: `issue-1279-${kind}`,
						number: 1,
						ts: 1,
						task: "Original task",
						status: "completed",
						tokensIn: 10,
						tokensOut: 5,
						totalCost: 0.001,
					},
					initialStatus: "completed",
					startTask: false,
				})
				const askSpy = vi.spyOn(task, "ask")

				await expect(getTaskPersistenceAccess(task).resumeTaskFromHistory()).rejects.toThrow(`history ${kind}`)
				await task.abortTask(true)

				expect(askSpy).not.toHaveBeenCalled()
				expect(mockSaveTaskMessages).not.toHaveBeenCalled()
				expect(mockProvider.updateTaskHistory).not.toHaveBeenCalled()
				expect(mockProvider.postClineMessagesSnapshot).not.toHaveBeenCalled()
			},
		)

		it("preserves finalized trailing reasoning without rewriting history during hydration", async () => {
			const messages = [
				{ ts: 1, type: "say" as const, say: "text" as const, text: "Original task" },
				{ ts: 2, type: "say" as const, say: "completion_result" as const, text: "Initial result" },
				{ ts: 3, type: "ask" as const, ask: "resume_completed_task" as const },
				{ ts: 4, type: "say" as const, say: "user_feedback" as const, text: "Continue investigating" },
				{
					ts: 5,
					type: "say" as const,
					say: "reasoning" as const,
					text: "Critical current conclusion",
					partial: false,
				},
			]
			mockReadTaskMessages.mockResolvedValue(messages)
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "Continue investigating" }] },
			])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "issue-1279-current",
					number: 1,
					ts: 5,
					task: "Original task",
					status: "completed",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				initialStatus: "completed",
				startTask: false,
			})
			vi.spyOn(task, "ask").mockImplementation(async (type) => {
				expect(type).toBe("resume_completed_task")
				expect(task.clineMessages).toContainEqual(
					expect.objectContaining({ text: "Critical current conclusion", partial: false }),
				)
				throw new Error("stop after hydration")
			})

			await expect(getTaskPersistenceAccess(task).resumeTaskFromHistory()).rejects.toThrow("stop after hydration")
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
		})

		it("removes incomplete trailing reasoning before prompting to resume", async () => {
			mockReadTaskMessages.mockResolvedValue([
				{ ts: 1, type: "say", say: "text", text: "Original task" },
				{ ts: 2, type: "say", say: "reasoning", text: "Incomplete conclusion", partial: true },
			])
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "Original task" }] },
			])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "issue-1279-partial-reasoning",
					number: 1,
					ts: 2,
					task: "Original task",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			vi.spyOn(task, "ask").mockImplementation(async () => {
				expect(task.clineMessages).not.toContainEqual(
					expect.objectContaining({ say: "reasoning", partial: true }),
				)
				throw new Error("stop after hydration")
			})

			await expect(getTaskPersistenceAccess(task).resumeTaskFromHistory()).rejects.toThrow("stop after hydration")
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
		})

		it("stops before hydrating either history when the task is evicted during the API read", async () => {
			const apiMessagesDeferred =
				createDeferred<Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>>()
			mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "UI message" }])
			mockReadApiMessages.mockReturnValue(apiMessagesDeferred.promise)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "issue-1279-evict-during-api-read",
					number: 1,
					ts: 1,
					task: "Original task",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			const resumePromise = getTaskPersistenceAccess(task).resumeTaskFromHistory()
			await vi.waitFor(() => expect(mockReadApiMessages).toHaveBeenCalled())

			await task.abortTask(true)
			mockSaveTaskMessages.mockClear()
			vi.mocked(mockProvider.updateTaskHistory).mockClear()
			apiMessagesDeferred.resolve([{ role: "user", content: [{ type: "text", text: "API message" }] }])
			await resumePromise

			// Neither UI nor API history should have been hydrated or persisted.
			expect(task.clineMessages).toHaveLength(0)
			expect(task.apiConversationHistory).toHaveLength(0)
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
			expect(mockProvider.postClineMessagesSnapshot).not.toHaveBeenCalled()
		})

		it("stops after API history hydration when the task is aborted", async () => {
			const apiMessagesDeferred =
				createDeferred<Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>>()
			mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Original task" }])
			mockReadApiMessages.mockReturnValue(apiMessagesDeferred.promise)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				historyItem: {
					id: "issue-1279-api-abort",
					number: 1,
					ts: 1,
					task: "Original task",
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0.001,
				},
				startTask: false,
			})
			const askSpy = vi.spyOn(task, "ask")
			const resumePromise = getTaskPersistenceAccess(task).resumeTaskFromHistory()
			await vi.waitFor(() => expect(mockReadApiMessages).toHaveBeenCalled())

			await task.abortTask(true)
			// abortTask persists its own cancellation state. Reset those calls so the
			// assertions below isolate work performed by the resumed hydration path.
			mockSaveTaskMessages.mockClear()
			vi.mocked(mockProvider.updateTaskHistory).mockClear()
			apiMessagesDeferred.resolve([{ role: "user", content: [{ type: "text", text: "Original task" }] }])
			await resumePromise

			expect(askSpy).not.toHaveBeenCalled()
			expect(mockSaveTaskMessages).not.toHaveBeenCalled()
			expect(mockProvider.updateTaskHistory).not.toHaveBeenCalled()
			expect(mockProvider.postClineMessagesSnapshot).not.toHaveBeenCalled()
		})
	})

	// ── flushPendingToolResultsToHistory — save failure/success ───────────

	describe("flushPendingToolResultsToHistory persistence", () => {
		it("retains userMessageContent on save failure", async () => {
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk full"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-fail",
					content: "Result that should be retained",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(false)
			// userMessageContent should NOT be cleared on failure
			expect(task.userMessageContent.length).toBeGreaterThan(0)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "tool-fail",
			})
		})

		it("clears userMessageContent on save success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce([])

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-ok",
					content: "Result that should be cleared",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(true)
			// userMessageContent should be cleared on success
			expect(task.userMessageContent).toEqual([])
		})
	})
})
