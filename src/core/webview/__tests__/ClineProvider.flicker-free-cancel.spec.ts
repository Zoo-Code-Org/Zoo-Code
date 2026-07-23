import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { ClineProvider } from "../ClineProvider"
import { Task } from "../../task/Task"
import { ContextProxy } from "../../config/ContextProxy"
import type { ProviderSettings, HistoryItem } from "@roo-code/types"

// Mock dependencies
vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn().mockReturnValue([]),
				update: vi.fn().mockResolvedValue(undefined),
			})),
			workspaceFolders: [],
			onDidChangeConfiguration: vi.fn(() => mockDisposable),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return {
				event: vi.fn(),
				fire: vi.fn(),
			}
		}),
		Disposable: {
			from: vi.fn(),
		},
		window: {
			showErrorMessage: vi.fn(),
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
		},
		Uri: {
			file: vi.fn().mockReturnValue({ toString: () => "file://test" }),
		},
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation(function () {
		return {
			taskId: "mock-task-id",
			instanceId: "mock-instance-id",
			abortTask: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
	}),
}))
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
			unregisterClient: vi.fn(),
		}),
		unregisterProvider: vi.fn(),
	},
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(function () {
		return {
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))
vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			setProvider: vi.fn(),
			captureTaskCreated: vi.fn(),
		},
	},
}))

// Mock CloudService
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(false),
		instance: {
			isAuthenticated: vi.fn().mockReturnValue(false),
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://api.roo-code.com"),
}))

vi.mock("../../../shared/embeddingModels", () => ({
	EMBEDDING_MODEL_PROFILES: [],
}))

vi.mock("../../../shared/modes", () => ({
	modes: [{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", groups: ["read", "edit"] }],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockReturnValue("General Tools"),
	defaultModeSlug: "code",
}))

vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
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

vi.mock("axios", () => ({
	default: { get: vi.fn().mockResolvedValue({ data: { data: [] } }), post: vi.fn() },
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockImplementation(async () => "mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("file content"),
}))

vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(function () {
		return { getName: () => "test-strategy", applyDiff: vi.fn() }
	}),
}))

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: { InvalidRequest: "InvalidRequest", MethodNotFound: "MethodNotFound", InternalError: "InternalError" },
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
			this.name = "McpError"
		}
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(function () {
		return {
			connect: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			listTools: vi.fn().mockResolvedValue({ tools: [] }),
			callTool: vi.fn().mockResolvedValue({ content: [] }),
		}
	}),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function () {
		return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }
	}),
}))

vi.mock("../../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(function () {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		}
	}),
}))

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		TaskHistoryStore: vi.fn().mockImplementation(function () {
			return {
				initialize: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				initialized: Promise.resolve(),
				get: vi.fn().mockReturnValue(undefined),
				getAll: vi.fn().mockReturnValue([]),
				upsert: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
				deleteMany: vi.fn().mockResolvedValue(undefined),
				migrateFromGlobalState: vi.fn().mockResolvedValue(undefined),
			}
		}),
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi.fn().mockResolvedValue(undefined),
		saveTaskMessages: vi.fn().mockResolvedValue(undefined),
	}
})

describe("ClineProvider flicker-free cancel", () => {
	let provider: ClineProvider
	let mockContext: any
	let mockOutputChannel: any
	let mockTask1: any
	let mockTask2: any
	let consoleLogSpy: ReturnType<typeof vi.spyOn>
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	const mockApiConfig: ProviderSettings = {
		apiProvider: "anthropic",
		apiKey: "test-key",
	} as ProviderSettings

	beforeAll(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterAll(() => {
		consoleLogSpy.mockRestore()
		consoleErrorSpy.mockRestore()
	})

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock extension context
		mockContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: "/test/storage" },
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			extensionUri: { fsPath: "/test/extension" },
		}

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}

		// Setup mock context proxy
		const mockContextProxy = {
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn().mockReturnValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			getProviderSettings: vi.fn().mockReturnValue(mockApiConfig),
			extensionUri: mockContext.extensionUri,
			globalStorageUri: mockContext.globalStorageUri,
		}

		// Create provider instance
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", mockContextProxy as any)

		// Mock provider methods
		provider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: mockApiConfig,
			mode: "code",
		})

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		// Mock private method using any cast
		;(provider as any).updateGlobalState = vi.fn().mockResolvedValue(undefined)
		provider.activateProviderProfile = vi.fn().mockResolvedValue(undefined)
		provider.performPreparationTasks = vi.fn().mockResolvedValue(undefined)
		provider.getTaskWithId = vi.fn().mockImplementation((id) =>
			Promise.resolve({
				historyItem: {
					id,
					number: 1,
					ts: Date.now(),
					task: "test task",
					tokensIn: 100,
					tokensOut: 200,
					totalCost: 0.001,
					workspace: "/test/workspace",
				},
			}),
		)

		// Setup mock tasks
		mockTask1 = {
			taskId: "task-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			dispose: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		mockTask2 = {
			taskId: "task-1", // Same ID for rehydration scenario
			instanceId: "instance-2", // Different instance
			emit: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		// Mock Task constructor
		vi.mocked(Task).mockImplementation(function () {
			return mockTask2 as any
		})
	})

	afterEach(async () => {
		await provider.dispose()
	})

	it("should not remove current task from stack when rehydrating same taskId", async () => {
		// Setup: Add a task to the stack first
		;(provider as any).clineStack = [mockTask1]

		// Mock event listeners for cleanup
		;(provider as any).taskEventListeners = new WeakMap()
		const mockCleanupFunctions = [vi.fn(), vi.fn()]
		;(provider as any).taskEventListeners.set(mockTask1, mockCleanupFunctions)

		// Spy on removeClineFromStack to verify it's NOT called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack")

		// Create history item with same taskId as current task
		const historyItem: HistoryItem = {
			id: "task-1", // Same as mockTask1.taskId
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Create task with history item (should rehydrate in-place)
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should NOT be called
		expect(removeClineFromStackSpy).not.toHaveBeenCalled()

		// Verify the task was replaced in-place
		expect((provider as any).clineStack).toHaveLength(1)
		expect((provider as any).clineStack[0]).toBe(mockTask2)

		// Verify old event listeners were cleaned up
		expect(mockCleanupFunctions[0]).toHaveBeenCalled()
		expect(mockCleanupFunctions[1]).toHaveBeenCalled()

		// Verify new task received focus event
		expect(mockTask2.emit).toHaveBeenCalledWith("taskFocused")
	})

	it("should remove task from stack when creating different task", async () => {
		// Setup: Add a task to the stack first
		;(provider as any).clineStack = [mockTask1]

		// Spy on removeClineFromStack to verify it IS called
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockImplementation(async () => {
			;(provider as any).clineStack.pop()
		})

		// Create history item with different taskId
		const historyItem: HistoryItem = {
			id: "task-2", // Different from mockTask1.taskId
			number: 2,
			task: "different task",
			ts: Date.now(),
			tokensIn: 150,
			tokensOut: 250,
			totalCost: 0.002,
			workspace: "/test/workspace",
		}

		// Act: Create task with different history item
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should be called
		expect(removeClineFromStackSpy).toHaveBeenCalled()
	})

	it("should handle empty stack gracefully during rehydration attempt", async () => {
		// Setup: Empty stack
		;(provider as any).clineStack = []

		// Spy on removeClineFromStack
		const removeClineFromStackSpy = vi.spyOn(provider, "removeClineFromStack").mockImplementation(async () => {
			;(provider as any).clineStack.pop()
		})

		// Create history item
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Should not error and should call removeClineFromStack
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: removeClineFromStack should be called (no current task to rehydrate)
		expect(removeClineFromStackSpy).toHaveBeenCalled()
	})

	it("should maintain task stack integrity during flicker-free replacement", async () => {
		// Setup: Stack with multiple tasks
		const mockParentTask = {
			taskId: "parent-task",
			instanceId: "parent-instance",
			emit: vi.fn(),
		}

		;(provider as any).clineStack = [mockParentTask, mockTask1]
		;(provider as any).taskEventListeners = new WeakMap()
		;(provider as any).taskEventListeners.set(mockTask1, [vi.fn()])

		// Act: Rehydrate the current (top) task
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: Stack should maintain parent task and replace current task
		expect((provider as any).clineStack).toHaveLength(2)
		expect((provider as any).clineStack[0]).toBe(mockParentTask)
		expect((provider as any).clineStack[1]).toBe(mockTask2)
	})

	it("marks a cancelled delegated child as interrupted and keeps parent delegated (preserving resume path)", async () => {
		const mockRootTask = { taskId: "root-1" }
		const mockParentTask = { taskId: "parent-1" }
		const childHistory: HistoryItem = {
			id: "child-1",
			number: 2,
			task: "child task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			parentTaskId: "parent-1",
			rootTaskId: "root-1",
			status: "active",
		}
		const parentHistory: HistoryItem = {
			id: "parent-1",
			number: 1,
			task: "parent task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
		}

		Object.assign(mockTask1, {
			taskId: "child-1",
			instanceId: "instance-child",
			rootTask: mockRootTask,
			parentTask: mockParentTask,
			parentTaskId: "parent-1",
			cancelCurrentRequest: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
		})
		;(provider as any).clineStack = [mockTask1]
		provider.getTaskWithId = vi.fn().mockImplementation((id) => {
			if (id === "child-1") {
				return Promise.resolve({ historyItem: childHistory })
			}
			if (id === "parent-1") {
				return Promise.resolve({ historyItem: parentHistory })
			}
			throw new Error(`unexpected task lookup: ${id}`)
		}) as any

		const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])
		const createTaskWithHistoryItemSpy = vi
			.spyOn(provider, "createTaskWithHistoryItem")
			.mockResolvedValue(undefined as any)

		await provider.cancelTask()

		// Child is marked interrupted, not detached
		expect(updateTaskHistorySpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				status: "interrupted",
			}),
		)
		// Parent is NOT transitioned to active — it stays delegated
		expect(updateTaskHistorySpy).not.toHaveBeenCalledWith(expect.objectContaining({ id: "parent-1" }))
		// Rehydrated child keeps its parent link so it can resume and report back
		expect(createTaskWithHistoryItemSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				parentTaskId: "parent-1",
				rootTaskId: "root-1",
			}),
		)
	})

	it("detaches runtime parent links when delegated parent detach fails", async () => {
		const mockRootTask = { taskId: "root-1" }
		const mockParentTask = { taskId: "parent-1" }
		const childHistory: HistoryItem = {
			id: "child-1",
			number: 2,
			task: "child task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			parentTaskId: "parent-1",
			rootTaskId: "root-1",
		}

		Object.assign(mockTask1, {
			taskId: "child-1",
			instanceId: "instance-child",
			rootTask: mockRootTask,
			parentTask: mockParentTask,
			parentTaskId: "parent-1",
			cancelCurrentRequest: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
		})
		;(provider as any).clineStack = [mockTask1]
		provider.getTaskWithId = vi.fn().mockImplementation((id) => {
			if (id === "child-1") {
				return Promise.resolve({ historyItem: childHistory })
			}
			if (id === "parent-1") {
				return Promise.reject(new Error("parent lookup failed"))
			}
			throw new Error(`unexpected task lookup: ${id}`)
		}) as any

		const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])
		const createTaskWithHistoryItemSpy = vi
			.spyOn(provider, "createTaskWithHistoryItem")
			.mockResolvedValue(undefined as any)

		await provider.cancelTask()

		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("[cancelTask] Failed to mark child interrupted for child-1: parent lookup failed"),
		)
		expect(updateTaskHistorySpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				parentTaskId: undefined,
				rootTaskId: undefined,
			}),
		)
		expect(createTaskWithHistoryItemSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				parentTaskId: undefined,
				rootTaskId: undefined,
				parentTask: undefined,
				rootTask: undefined,
			}),
		)
		expect((provider as any).cancelledDelegationChildIds.has("child-1")).toBe(true)
	})

	it("does not rehydrate a cancelled child when standalone persistence also fails", async () => {
		const childHistory: HistoryItem = {
			id: "child-1",
			number: 2,
			task: "child task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			parentTaskId: "parent-1",
			rootTaskId: "root-1",
		}

		Object.assign(mockTask1, {
			taskId: "child-1",
			instanceId: "instance-child",
			parentTaskId: "parent-1",
			cancelCurrentRequest: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
		})
		;(provider as any).clineStack = [mockTask1]
		provider.getTaskWithId = vi.fn().mockImplementation((id) => {
			if (id === "child-1") {
				return Promise.resolve({ historyItem: childHistory })
			}
			if (id === "parent-1") {
				return Promise.reject(new Error("parent lookup failed"))
			}
			throw new Error(`unexpected task lookup: ${id}`)
		}) as any

		vi.spyOn(provider, "updateTaskHistory").mockRejectedValue(new Error("standalone persist failed"))
		const createTaskWithHistoryItemSpy = vi
			.spyOn(provider, "createTaskWithHistoryItem")
			.mockResolvedValue(undefined as any)

		await expect(provider.cancelTask()).rejects.toThrow("standalone persist failed")
		expect(createTaskWithHistoryItemSpy).not.toHaveBeenCalled()
		expect((provider as any).cancelledDelegationChildIds.has("child-1")).toBe(true)
	})

	it("marks a cancelled delegated child as 'interrupted' and keeps parent delegated", async () => {
		const childHistory: HistoryItem = {
			id: "child-1",
			number: 2,
			task: "child task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			parentTaskId: "parent-1",
			rootTaskId: "root-1",
			status: "active",
		}
		const parentHistory: HistoryItem = {
			id: "parent-1",
			number: 1,
			task: "parent task",
			ts: Date.now(),
			tokensIn: 10,
			tokensOut: 20,
			totalCost: 0.001,
			workspace: "/test/workspace",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
		}

		Object.assign(mockTask1, {
			taskId: "child-1",
			instanceId: "instance-child",
			rootTask: { taskId: "root-1" },
			parentTask: { taskId: "parent-1" },
			parentTaskId: "parent-1",
			cancelCurrentRequest: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			isStreaming: false,
			didFinishAbortingStream: true,
			isWaitingForFirstChunk: false,
		})
		;(provider as any).clineStack = [mockTask1]
		provider.getTaskWithId = vi.fn().mockImplementation((id) => {
			if (id === "child-1") return Promise.resolve({ historyItem: childHistory })
			if (id === "parent-1") return Promise.resolve({ historyItem: parentHistory })
			throw new Error(`unexpected task lookup: ${id}`)
		}) as any

		const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])
		const createTaskWithHistoryItemSpy = vi
			.spyOn(provider, "createTaskWithHistoryItem")
			.mockResolvedValue(undefined as any)

		await provider.cancelTask()

		// Child should be marked interrupted, not have its parent link severed
		expect(updateTaskHistorySpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				status: "interrupted",
			}),
		)

		// Parent should remain delegated with awaitingChildId intact
		expect(updateTaskHistorySpy).not.toHaveBeenCalledWith(expect.objectContaining({ id: "parent-1" }))

		// Rehydrated child retains parent link
		expect(createTaskWithHistoryItemSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "child-1",
				parentTaskId: "parent-1",
				rootTaskId: "root-1",
			}),
		)
	})

	it("removeClineFromStack never mutates delegation metadata (pure lifecycle after refactor)", async () => {
		// After the refactor, removeClineFromStack() is pure lifecycle: pop, abort, clean up.
		// Delegation state is owned by reopenParentFromDelegation() and markDelegatedChildInterrupted().
		const childTask = {
			taskId: "child-1",
			instanceId: "inst-child",
			parentTaskId: "parent-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}
		;(provider as any).clineStack = [childTask]
		;(provider as any).taskEventListeners = new Map()

		provider.getTaskWithId = vi.fn() as any
		const updateTaskHistorySpy = vi.spyOn(provider, "updateTaskHistory").mockResolvedValue([])

		await (provider as any).removeClineFromStack()

		expect((provider as any).clineStack).toHaveLength(0)
		expect(childTask.abortTask).toHaveBeenCalledWith(true)
		// No history writes — lifecycle only
		expect(updateTaskHistorySpy).not.toHaveBeenCalled()
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
	})

	afterAll(() => {
		vi.restoreAllMocks()
	})
})
