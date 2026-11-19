// npx vitest run core/task/__tests__/background-webview-guards.spec.ts

import * as os from "os"
import * as path from "path"

import type { ExtensionContext } from "vscode"
import {
	providerIdentifiers,
	type ClineMessage,
	type GlobalState,
	type ModelInfo,
	type ProviderSettings,
	RooCodeEventName,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import type { ContextManagementOptions, ContextManagementResult } from "../../context-management"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"
import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"

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

const mockMessages = [
	{
		ts: Date.now(),
		type: "say",
		say: "text",
		text: "historical task",
	},
]

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
				return Promise.resolve("[]")
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

// The condense guards are asserted around manageContext: the real summarizer
// would call the API, so it stands in as a pass-through that reports "nothing
// condensed" (no summary, no error, no truncation).
const { manageContextMock } = vi.hoisted(() => ({
	manageContextMock: vi.fn<(options: ContextManagementOptions) => Promise<ContextManagementResult>>(),
}))

vi.mock("../../context-management", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../context-management")>()
	return {
		...actual,
		manageContext: manageContextMock,
	}
})

// Model-info stand-in: the settled snapshot only needs a defined ModelInfo.
const stubModelInfo: ModelInfo = {
	contextWindow: 200_000,
	maxTokens: 4096,
	supportsPromptCache: true,
}

type TaskSeams = {
	getSystemPrompt: (requestState: ProviderState | undefined, requestModelInfo?: ModelInfo) => Promise<string>
	safeEnsureModelFetched: () => Promise<ModelInfo>
}

type ProviderState = Awaited<ReturnType<ClineProvider["getState"]>>

// A double assertion is unavoidable here: the seam helpers are private on Task,
// and the test drives them through vi.spyOn on the real instance.
function getTaskSeams(task: Task): TaskSeams {
	return task as unknown as TaskSeams
}

describe("background child webview suppression (UI-leak guards)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings
	let mockExtensionContext: ExtensionContext
	// Every task built by buildTask, so afterEach can dispose them. The tests
	// never add them to the provider's registry, so provider.dispose() alone
	// would not reach them.
	let builtTasks: Task[] = []

	// The mocked getState only carries the fields a test pins; Task reads the
	// rest through its own defaults. The cast supplies the remaining required
	// ExtensionState shape, which a Partial spread alone cannot prove.
	const providerStateWith = (overrides: Partial<ProviderState> = {}): ProviderState =>
		({
			mcpEnabled: false,
			...overrides,
		}) as ProviderState

	const backgroundPolicy: ConstructorParameters<typeof Task>[0]["backgroundToolPolicy"] = {
		disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
		experiments: BACKGROUND_CHILD_EXPERIMENTS,
	}

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

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
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
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

		manageContextMock.mockImplementation(async (options) => ({
			messages: options.messages,
			summary: "",
			cost: 0,
			prevContextTokens: 0,
		}))
	})

	afterEach(async () => {
		// Deterministic teardown: dispose every built task (closes request
		// generators still suspended mid-stream via their finally, clears
		// listeners/queues) and then the provider, so no async work outlives
		// this file. Disposal runs before restoreAllMocks so the module mocks
		// (fs, storage paths) are still in place for it.
		//
		// `Task.dispose()` and `ClineProvider.dispose()` write to the console on
		// every call. With ~30 tasks per file that is a burst of worker->parent
		// console RPCs landing exactly when the worker is closing, which Vitest
		// reports as `EnvironmentTeardownError: Closing rpc while
		// "onUserConsoleLog" was pending` and turns into a non-zero exit even
		// though every test passed. The repo runs with `silent: true`, so these
		// lines are dropped from the terminal anyway; silencing them here only
		// removes the RPC traffic, never a diagnostic a developer would see.
		const consoleQuiet = ["log", "info", "warn", "error", "debug"].map((key) =>
			vi.spyOn(console, key as "log").mockImplementation(() => {}),
		)
		try {
			// A rejecting dispose must not skip the remaining disposals or mask
			// the assertion failure under test.
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

	async function buildTask(
		backgroundToolPolicy?: ConstructorParameters<typeof Task>[0]["backgroundToolPolicy"],
		stateOverrides: Partial<ProviderState> = {},
	) {
		// Install the state read before construction: the constructor's mode
		// initialization consumes the same request-time state the request will.
		// stateOverrides lets a test pin request-time settings (e.g. the
		// auto-condense fields) so they survive into the request instead of
		// being replaced by this install.
		vi.spyOn(mockProvider, "getState").mockResolvedValue(
			providerStateWith({ mode: "code", autoApprovalEnabled: false, ...stateOverrides }),
		)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			backgroundToolPolicy,
			// P1-2: a LIVE background child is marked by the hosted flag, not by
			// policy presence. These specs always mean "live child" when they pass
			// a policy, so the two travel together here.
			backgroundChildHosted: backgroundToolPolicy !== undefined,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()
		return task
	}

	function resetProviderWebviewMocks() {
		vi.mocked(mockProvider.postMessageToWebview).mockClear()
		vi.mocked(mockProvider.postStateToWebviewThrottled).mockClear()
		vi.mocked(mockProvider.flushPostStateToWebviewThrottled).mockClear()
	}

	describe("addToClineMessages", () => {
		// An unanswered ask exercises both the throttled post and the immediate
		// flush that unanswered asks normally require.
		const askMessage: ClineMessage = {
			ts: 1,
			type: "ask",
			ask: "tool",
			text: "approve write?",
			isAnswered: false,
			partial: false,
		}

		it("posts no webview state for a background child but still emits, persists, and appends", async () => {
			const task = await buildTask(backgroundPolicy)
			task["emit"] = vi.fn()
			task["saveClineMessages"] = vi.fn(async () => true)
			resetProviderWebviewMocks()

			await task["addToClineMessages"]({ ...askMessage })

			expect(task.isBackgroundSubtaskChild).toBe(true)
			expect(mockProvider.postStateToWebviewThrottled).not.toHaveBeenCalled()
			expect(mockProvider.flushPostStateToWebviewThrottled).not.toHaveBeenCalled()
			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.Message, expect.anything())
			expect(task["saveClineMessages"]).toHaveBeenCalled()
			expect(task.clineMessages).toHaveLength(1)
		})

		it("posts throttled state and the immediate flush for a non-background task", async () => {
			const task = await buildTask()
			task["emit"] = vi.fn()
			task["saveClineMessages"] = vi.fn(async () => true)
			resetProviderWebviewMocks()

			await task["addToClineMessages"]({ ...askMessage })

			expect(task.isBackgroundSubtaskChild).toBe(false)
			expect(mockProvider.postStateToWebviewThrottled).toHaveBeenCalledTimes(1)
			expect(mockProvider.flushPostStateToWebviewThrottled).toHaveBeenCalledTimes(1)
			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.Message, expect.anything())
			expect(task["saveClineMessages"]).toHaveBeenCalled()
		})
	})

	describe("messageQueueStateChangedHandler", () => {
		it("emits the queue events without posting webview state for a background child", async () => {
			const task = await buildTask(backgroundPolicy)
			task["emit"] = vi.fn()
			resetProviderWebviewMocks()

			task["messageQueueService"].addMessage("queued feedback")

			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.TaskUserMessage, task.taskId)
			expect(task["emit"]).toHaveBeenCalledWith(
				RooCodeEventName.QueuedMessagesUpdated,
				task.taskId,
				expect.anything(),
			)
			expect(mockProvider.postStateToWebviewThrottled).not.toHaveBeenCalled()
		})

		it("posts webview state and emits the queue events for a non-background task", async () => {
			const task = await buildTask()
			task["emit"] = vi.fn()
			resetProviderWebviewMocks()

			task["messageQueueService"].addMessage("queued feedback")

			expect(mockProvider.postStateToWebviewThrottled).toHaveBeenCalledTimes(1)
			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.TaskUserMessage, task.taskId)
			expect(task["emit"]).toHaveBeenCalledWith(
				RooCodeEventName.QueuedMessagesUpdated,
				task.taskId,
				expect.anything(),
			)
		})
	})

	describe("updateClineMessage", () => {
		const partialMessage: ClineMessage = {
			ts: 2,
			type: "say",
			say: "text",
			text: "streaming partial",
			partial: true,
		}

		it("posts no messageUpdated for a background child but still emits the update event", async () => {
			const task = await buildTask(backgroundPolicy)
			task["emit"] = vi.fn()
			resetProviderWebviewMocks()

			await task["updateClineMessage"]({ ...partialMessage })

			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.Message, {
				action: "updated",
				message: partialMessage,
			})
		})

		it("posts messageUpdated for a non-background task", async () => {
			const task = await buildTask()
			task["emit"] = vi.fn()
			resetProviderWebviewMocks()

			await task["updateClineMessage"]({ ...partialMessage })

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
				type: "messageUpdated",
				clineMessage: partialMessage,
			})
			expect(task["emit"]).toHaveBeenCalledWith(RooCodeEventName.Message, {
				action: "updated",
				message: partialMessage,
			})
		})
	})

	describe("condense indicator posts", () => {
		function armContextWindowSeams(task: Task) {
			vi.spyOn(task, "getTokenUsage").mockReturnValue({
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				contextTokens: 200_000,
			})
		}

		it("posts no condense spinner or dismissal for a background child recovering from overflow", async () => {
			const task = await buildTask(backgroundPolicy)
			armContextWindowSeams(task)
			resetProviderWebviewMocks()

			await task["handleContextWindowExceededError"](stubModelInfo)

			// The condense actually ran (guard is not "skip condensing"), only the
			// webview indicator stayed silent.
			expect(manageContextMock).toHaveBeenCalled()
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("posts the condense spinner and its dismissal for a non-background task recovering from overflow", async () => {
			const task = await buildTask()
			armContextWindowSeams(task)
			resetProviderWebviewMocks()

			await task["handleContextWindowExceededError"](stubModelInfo)

			const posts = vi.mocked(mockProvider.postMessageToWebview).mock.calls.map(([message]) => message)
			expect(posts.filter((message) => message.type === "condenseTaskContextStarted")).toHaveLength(1)
			expect(posts.filter((message) => message.type === "condenseTaskContextResponse")).toHaveLength(1)
		})

		async function driveAutoCondense(task: Task) {
			const seams = getTaskSeams(task)
			vi.spyOn(seams, "getSystemPrompt").mockResolvedValue("mock system prompt")
			vi.spyOn(seams, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			vi.spyOn(task.api, "createMessage").mockReturnValue(
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]),
			)
			armContextWindowSeams(task)
			resetProviderWebviewMocks()

			// Retain the generator: one unconsumed next() would leave
			// attemptApiRequest suspended mid-stream (its finally, endApiWork,
			// never running). return() closes it deterministically.
			const requestGenerator = task.attemptApiRequest(0, { skipProviderRateLimit: true })
			try {
				await requestGenerator.next()
			} finally {
				await requestGenerator.return(undefined)
			}
		}

		it("posts no condense spinner or dismissal for a background child during an auto-condense request", async () => {
			const task = await buildTask(backgroundPolicy, {
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
			})

			await driveAutoCondense(task)

			// 100% of the context window is occupied, so the real threshold check
			// fires and the pass-through manageContext proves the branch ran.
			expect(manageContextMock).toHaveBeenCalled()
			expect(mockProvider.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("posts the condense spinner and its dismissal for a non-background task during an auto-condense request", async () => {
			const task = await buildTask(undefined, { autoCondenseContext: true, autoCondenseContextPercent: 100 })

			await driveAutoCondense(task)

			const posts = vi.mocked(mockProvider.postMessageToWebview).mock.calls.map(([message]) => message)
			expect(posts.filter((message) => message.type === "condenseTaskContextStarted")).toHaveLength(1)
			expect(posts.filter((message) => message.type === "condenseTaskContextResponse")).toHaveLength(1)
		})
	})

	describe("request-iteration state posts (F-11)", () => {
		function armRequestSeams(task: Task) {
			const seams = getTaskSeams(task)
			vi.spyOn(seams, "getSystemPrompt").mockResolvedValue("mock system prompt")
			vi.spyOn(seams, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
			vi.spyOn(task.api, "createMessage").mockReturnValue(
				asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]),
			)
			vi.spyOn(task, "getTokenUsage").mockReturnValue({
				totalCost: 0,
				totalTokensIn: 0,
				totalTokensOut: 0,
				contextTokens: 0,
			})
			// The real DiffViewProvider touches the editor API surface this file
			// does not model; the request iteration only needs it reset.
			task["diffViewProvider"] = { reset: vi.fn() } as unknown as Task["diffViewProvider"]
			resetProviderWebviewMocks()
			vi.mocked(mockProvider.postStateToWebviewWithoutTaskHistory).mockClear()
		}

		async function driveFullRequestIteration(task: Task) {
			// Drive the full request iteration: both state-post sites (before the
			// request and after the stream completes) live in
			// recursivelyMakeClineRequests, so the whole loop must run.
			await task.recursivelyMakeClineRequests([{ type: "text", text: "investigate the codebase" }])
		}

		it("posts no state to the webview across a full request iteration for a background child", async () => {
			const task = await buildTask(backgroundPolicy)
			armRequestSeams(task)

			await driveFullRequestIteration(task)

			expect(task.isBackgroundSubtaskChild).toBe(true)
			expect(mockProvider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
			// The loop really ran (its no-tool continuation can issue more than
			// one request); every one of those requests stayed off the webview.
			expect(vi.mocked(task.api.createMessage)).toHaveBeenCalled()
		})

		it("posts state around every request of a full iteration for a non-background task", async () => {
			const task = await buildTask()
			armRequestSeams(task)

			await driveFullRequestIteration(task)

			expect(task.isBackgroundSubtaskChild).toBe(false)
			// Each request posts state twice: once before the request (placeholder
			// cost/protocol refresh) and once after the stream completes.
			const requests = vi.mocked(task.api.createMessage).mock.calls.length
			expect(requests).toBeGreaterThan(0)
			expect(mockProvider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(requests * 2)
		})
	})

	describe("abortTaskOnce webview flush (F-11)", () => {
		async function driveAbort(task: Task) {
			task["emit"] = vi.fn()
			task["emitFinalTokenUsageUpdate"] = vi.fn()
			task["saveClineMessages"] = vi.fn(async () => true)
			resetProviderWebviewMocks()
			vi.mocked(mockProvider.flushPostStateToWebviewThrottled).mockClear()

			// Do NOT stub task.dispose here: abortTaskOnce() ends with
			// `void this.dispose()`, and these tasks stay in builtTasks, so
			// afterEach disposes them through the same (memoized) method. A
			// no-op stub would leave both abort-test tasks undisposed. Disposal
			// never touches the webview flush counters these tests assert on.
			await task["abortTaskOnce"]()
		}

		it("flushes nothing to the webview for a background child", async () => {
			const task = await buildTask(backgroundPolicy)

			await driveAbort(task)

			expect(mockProvider.flushPostStateToWebviewThrottled).not.toHaveBeenCalled()
		})

		it("flushes webview state for a non-background task", async () => {
			const task = await buildTask()

			await driveAbort(task)

			expect(mockProvider.flushPostStateToWebviewThrottled).toHaveBeenCalledTimes(1)
		})
	})
})
