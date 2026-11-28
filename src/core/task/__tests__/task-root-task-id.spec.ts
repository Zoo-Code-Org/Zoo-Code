// npx vitest run core/task/__tests__/task-root-task-id.spec.ts

import * as os from "os"
import * as path from "path"

import type { ExtensionContext } from "vscode"
import {
	providerIdentifiers,
	type ClineMessage,
	type GlobalState,
	type HistoryItem,
	type ProviderSettings,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"

// CR-1 finding 2 (Task-side contract): an explicit `rootTaskId` option lets a
// caller stamp the authoritative root id when no root TASK OBJECT is live — the
// history-restore case where a task knows its root only as a stored id. The
// option wins over the rootTask-object derivation when provided; when absent
// the derivation is unchanged. A history-restored task always keeps its stored
// rootTaskId.

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
		readFile: vi.fn().mockResolvedValue("[]"),
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

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: { all: [], close: vi.fn(), onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })) },
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: { from: vi.fn() },
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

// Keep taskMetadata real so the persisted historyItem shape is the production
// one; only the fs-touching message write is stubbed (mirrors
// background-stamp-reassert.spec.ts).
vi.mock("../../task-persistence", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...actual,
		saveTaskMessages: vi.fn().mockResolvedValue([]),
	}
})

const ROOT_TASK_ID = "root-task-1"
const OTHER_ROOT_TASK_ID = "root-task-2"
const PARENT_TASK_ID = "parent-task-1"

const taskSay: ClineMessage = { ts: 1, type: "say", say: "text", text: "child task", partial: false }

describe("Task rootTaskId option (CR-1 finding 2)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings
	// Every task this suite constructs directly, so afterEach can dispose
	// them. None of the tests register their tasks with the provider, so
	// provider disposal alone cannot reach them.
	let builtTasks: Task[] = []

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		const mockExtensionContext = {
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
		} as unknown as ExtensionContext

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

		mockContextProxy = new ContextProxy(mockExtensionContext)
		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			mockContextProxy,
			new WebviewFocusTracker(),
		)

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
		mockProvider.flushPostStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(async () => {
		// Dispose every task this suite built, including after a failed
		// assertion: the tests never register their tasks with the provider,
		// so provider disposal alone cannot release them. Disposal runs before
		// restoreAllMocks so the module mocks (fs, storage paths) are still in
		// place for it, and a rejecting dispose must not mask the assertion
		// failure under test.
		//
		// `Task.dispose()` writes to the console, so teardown emits
		// worker->parent console RPCs while the worker is closing. Vitest
		// reports that as `EnvironmentTeardownError: Closing rpc while
		// "onUserConsoleLog" was pending` and exits non-zero even though every
		// test passed. The repo runs with `silent: true`, so silencing it here
		// drops no diagnostic.
		const consoleQuiet = ["log", "info", "warn", "error", "debug"].map((key) =>
			vi.spyOn(console, key as "log").mockImplementation(() => {}),
		)
		try {
			for (const task of builtTasks) {
				await task.dispose().catch(() => {})
			}
			builtTasks = []
			await mockProvider.dispose().catch(() => {})
		} finally {
			for (const spy of consoleQuiet) {
				spy.mockRestore()
			}
		}
		vi.restoreAllMocks()
	})

	it("stamps the provided rootTaskId when no root task object is live", async () => {
		// The CR-2 scenario: a task restored from History has rootTaskId: R with
		// no live reference to R; when it spawns a child the caller stamps R
		// explicitly instead of letting the child inherit the spawner's id.
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "child of a restored task",
			startTask: false,
			rootTaskId: ROOT_TASK_ID,
			parentTask: { taskId: PARENT_TASK_ID } as unknown as Task,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		expect(task.rootTaskId).toBe(ROOT_TASK_ID)
		expect(task.parentTaskId).toBe(PARENT_TASK_ID)
	})

	it("the explicit rootTaskId wins over the rootTask object derivation", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const rootTask = { taskId: OTHER_ROOT_TASK_ID } as unknown as Task
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "stamped child",
			startTask: false,
			rootTask,
			rootTaskId: ROOT_TASK_ID,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		expect(task.rootTaskId).toBe(ROOT_TASK_ID)
	})

	it("absent option keeps the rootTask object derivation", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const rootTask = { taskId: ROOT_TASK_ID } as unknown as Task
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "derived child",
			startTask: false,
			rootTask,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		expect(task.rootTaskId).toBe(ROOT_TASK_ID)
	})

	it("a rootless new task keeps rootTaskId undefined", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "plain task",
			startTask: false,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		expect(task.rootTaskId).toBeUndefined()
	})

	it("a history-restored task keeps its stored rootTaskId even when the option is provided", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const historyItem: HistoryItem = {
			id: "restored-1",
			rootTaskId: OTHER_ROOT_TASK_ID,
			parentTaskId: PARENT_TASK_ID,
			number: 1,
			ts: 1,
			task: "restored task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			historyItem,
			startTask: false,
			rootTaskId: ROOT_TASK_ID,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		expect(task.rootTaskId).toBe(OTHER_ROOT_TASK_ID)
	})

	it("saveClineMessages persists the stamped rootTaskId via taskMetadata", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "child of a restored task",
			startTask: false,
			rootTaskId: ROOT_TASK_ID,
			parentTask: { taskId: PARENT_TASK_ID } as unknown as Task,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()

		const updateSpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
		task["clineMessages"] = [taskSay]

		await task["saveClineMessages"]()

		expect(updateSpy).toHaveBeenCalledTimes(1)
		const persisted = updateSpy.mock.calls[0][0] as { rootTaskId?: string; parentTaskId?: string }
		expect(persisted.rootTaskId).toBe(ROOT_TASK_ID)
		expect(persisted.parentTaskId).toBe(PARENT_TASK_ID)
	})
})
