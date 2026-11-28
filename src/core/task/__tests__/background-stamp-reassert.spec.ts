// npx vitest run core/task/__tests__/background-stamp-reassert.spec.ts

import * as os from "os"
import * as path from "path"

import type { ExtensionContext } from "vscode"
import { providerIdentifiers, type ClineMessage, type GlobalState, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"

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

// The re-assert under test lives in Task.saveClineMessages AFTER the message
// write, so stub the fs-touching saveTaskMessages to keep the spec deterministic
// (the real safeWriteJson atomic-rename races with the mocked fs); taskMetadata
// stays real so the historyItem shape is the production one.
vi.mock("../../task-persistence", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...actual,
		saveTaskMessages: vi.fn().mockResolvedValue([]),
	}
})

const PARENT_TASK_ID = "parent-1"

const backgroundPolicy: ConstructorParameters<typeof Task>[0]["backgroundToolPolicy"] = {
	disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
	experiments: BACKGROUND_CHILD_EXPERIMENTS,
}

describe("background child stamp re-assert on its own history write (M-2)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings

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

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// A LIVE background child carrying its parent (so the parent id is in memory)
	// — exactly what spawnBackgroundChildren registers. The spawn-time stamp
	// upsert is intentionally NOT performed here, modeling the transient store
	// failure that left the child unstamped (the M-2 scenario).
	async function buildUnstampedHostedChild() {
		const parentTask = { taskId: PARENT_TASK_ID } as unknown as Task
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "child investigation",
			startTask: false,
			parentTask,
			backgroundToolPolicy: backgroundPolicy,
			backgroundChildHosted: true,
		})
		await task.getTaskMode()
		return task
	}

	const taskSay: ClineMessage = { ts: 1, type: "say", say: "text", text: "child investigation", partial: false }

	it("the child's own save persists the backgroundParentTaskId stamp even when the spawn-time stamp failed", async () => {
		const child = await buildUnstampedHostedChild()
		expect(child.isBackgroundSubtaskChild).toBe(true)
		expect(child.parentTaskId).toBe(PARENT_TASK_ID)

		const updateSpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
		child["clineMessages"] = [taskSay]

		await child["saveClineMessages"]()

		// The child's own history write re-asserted the stamp from the in-memory
		// parent id, so a later restore sees it and re-applies the read-only policy.
		expect(updateSpy).toHaveBeenCalledTimes(1)
		const persisted = updateSpy.mock.calls[0][0] as { backgroundParentTaskId?: string }
		expect(persisted.backgroundParentTaskId).toBe(PARENT_TASK_ID)
	})

	it("a normal task's own save does not stamp a backgroundParentTaskId", async () => {
		vi.spyOn(mockProvider, "getState").mockResolvedValue({ mcpEnabled: false } as never)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "plain task",
			startTask: false,
		})
		await task.getTaskMode()

		const updateSpy = vi.spyOn(mockProvider, "updateTaskHistory").mockResolvedValue([])
		task["clineMessages"] = [taskSay]

		await task["saveClineMessages"]()

		const persisted = updateSpy.mock.calls[0][0] as { backgroundParentTaskId?: string }
		expect(persisted.backgroundParentTaskId).toBeUndefined()
	})
})
