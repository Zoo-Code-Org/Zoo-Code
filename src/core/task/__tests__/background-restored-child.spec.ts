// npx vitest run core/task/__tests__/background-restored-child.spec.ts

import * as os from "os"
import * as path from "path"

import pWaitFor from "p-wait-for"
import type { ExtensionContext } from "vscode"
import { providerIdentifiers, type GlobalState, type ModelInfo, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { setAbortLatch } from "../../../test-utils/run-state"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
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

function getTaskSeams(task: Task): TaskSeams {
	return task as unknown as TaskSeams
}

const backgroundPolicy: ConstructorParameters<typeof Task>[0]["backgroundToolPolicy"] = {
	disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
	experiments: BACKGROUND_CHILD_EXPERIMENTS,
}

describe("restored background child stays interactive but read-only (P1-2)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings
	let baseProviderState!: ProviderState
	// Every task built by buildRestoredTask/buildHostedChild, so afterEach can
	// dispose them. The builders construct Task objects directly and never
	// register them with the provider, so provider disposal alone cannot
	// reach them.
	let builtTasks: Task[] = []

	const providerStateWith = (overrides: Partial<ProviderState> = {}): ProviderState => ({
		...baseProviderState,
		mcpEnabled: false,
		...overrides,
	})

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
		// assertion: the builders never register their tasks with the provider,
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

	// A restored background child: the restore path (ClineProvider
	// createTaskWithHistoryItemUnlocked) passes the read-only policy but never
	// the hosted flag. This builder mirrors that exact construction.
	async function buildRestoredTask() {
		vi.spyOn(mockProvider, "getState").mockResolvedValue(
			providerStateWith({ mode: "code", autoApprovalEnabled: false }),
		)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			backgroundToolPolicy: backgroundPolicy,
			// No backgroundChildHosted: the restore path never sets it.
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()
		return task
	}

	// A LIVE background child for contrast: same policy plus the hosted flag.
	async function buildHostedChild() {
		vi.spyOn(mockProvider, "getState").mockResolvedValue(
			providerStateWith({ mode: "code", autoApprovalEnabled: false }),
		)
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			backgroundToolPolicy: backgroundPolicy,
			backgroundChildHosted: true,
		})
		// Track before the first await so a throw in getTaskMode still leaves a
		// reachable task for afterEach disposal.
		builtTasks.push(task)
		await task.getTaskMode()
		return task
	}

	function armRequestSeams(task: Task) {
		const seams = getTaskSeams(task)
		vi.spyOn(seams, "getSystemPrompt").mockResolvedValue("mock system prompt")
		vi.spyOn(seams, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		const createMessageSpy = vi
			.spyOn(task.api, "createMessage")
			.mockReturnValue(asyncStreamFrom<ApiStreamChunk>([{ type: "text", text: "ok" }]))
		vi.spyOn(task, "getTokenUsage").mockReturnValue({
			totalCost: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			contextTokens: 0,
		})
		task["diffViewProvider"] = { reset: vi.fn() } as unknown as Task["diffViewProvider"]
		vi.mocked(mockProvider.postStateToWebviewWithoutTaskHistory).mockClear()
		return createMessageSpy
	}

	it("is interactive: the policy alone does not flag it as a background child", async () => {
		const restored = await buildRestoredTask()
		const hosted = await buildHostedChild()

		expect(restored.isBackgroundSubtaskChild).toBe(false)
		expect(hosted.isBackgroundSubtaskChild).toBe(true)
		// Both carry the policy; only the derivation differs.
		expect(restored["backgroundToolPolicy"]).toEqual(backgroundPolicy)
	})

	it("keeps the read-only policy at the tool layer (write tools stay blocked)", async () => {
		const restored = await buildRestoredTask()
		const policy = restored["effectiveToolPolicy"]({ disabledTools: undefined, experiments: undefined })

		expect(policy.disabledTools).toEqual(expect.arrayContaining([...BACKGROUND_CHILD_DISABLED_TOOLS]))
		expect(policy.experiments).toEqual(BACKGROUND_CHILD_EXPERIMENTS)
		expect(policy.disabledTools).toContain("write_to_file")
		expect(policy.disabledTools).toContain("execute_command")
	})

	it("still withholds write tools from the model-facing tool array", async () => {
		const restored = await buildRestoredTask()
		const createMessageSpy = armRequestSeams(restored)

		await restored.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		const [, , metadata] = createMessageSpy.mock.calls[0] as [unknown, unknown, { tools?: unknown[] } | undefined]
		const toolNames = (metadata?.tools ?? []).map((tool) => {
			const functionTool = tool as { type: string; function: { name: string } }
			return functionTool.function.name
		})
		expect(toolNames).not.toContain("write_to_file")
		expect(toolNames).not.toContain("execute_command")
		expect(toolNames).toEqual(expect.arrayContaining(["read_file", "attempt_completion"]))
	})

	it("posts state to the webview across a request iteration (nothing suppressed)", async () => {
		const restored = await buildRestoredTask()
		const createMessageSpy = armRequestSeams(restored)

		await restored.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		// A LIVE child would post nothing here (the F-11 guards); a restored
		// child is the current interactive task, so its state must flow.
		expect(createMessageSpy).toHaveBeenCalled()
		expect(mockProvider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalled()
	})

	it("its ask is not auto-resolved by the D4 seam (resolveBackgroundChildAsk is a no-op)", async () => {
		const restored = await buildRestoredTask()
		const hosted = await buildHostedChild()

		// The D4 seam must leave the restored child's asks alone so they reach the
		// interactive blocking path, while it still auto-resolves a hosted child's.
		// (The seam is async since the M-1 canonical gate resolves realpaths.)
		expect(
			await restored["resolveBackgroundChildAsk"]("resume_task", { decision: "ask" }, undefined),
		).toBeUndefined()
		expect(await restored["resolveBackgroundChildAsk"]("tool", { decision: "ask" }, "{}")).toBeUndefined()
		expect(await hosted["resolveBackgroundChildAsk"]("resume_task", { decision: "ask" }, undefined)).toEqual({
			response: "noButtonClicked",
		})
	})

	it("its resume ask blocks for approval instead of auto-running", async () => {
		// Drive the ask through the lightweight prototype seam (the same harness
		// background-ask-policy uses): the restored child has
		// isBackgroundSubtaskChild === false — proven from the real constructor in
		// the test above — so the D4 seam is inert and the ask behaves like any
		// interactive history task.
		const provider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			getSkillsManager: () => undefined,
			cwd: "/mock/workspace/path",
			getState: async () => ({ autoApprovalEnabled: false }),
		}
		const task = Object.create(Task.prototype) as Task
		setAbortLatch(task, false)
		task["clineMessages"] = []
		task["askResponse"] = undefined
		task["askResponseText"] = undefined
		task["askResponseImages"] = undefined
		task["lastMessageTs"] = undefined
		task["addToClineMessages"] = vi.fn(async () => {})
		task["saveClineMessages"] = vi.fn(async () => true)
		task["updateClineMessage"] = vi.fn(async () => {})
		task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
		task["checkpointSave"] = vi.fn(async () => {})
		task["emit"] = vi.fn()
		Object.defineProperty(task, "runRejections", { value: new Set() })
		Object.defineProperty(task, "reportedDivergences", { value: new Set() })
		task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
		Object.defineProperty(task, "workspacePath", { value: "/mock/workspace/path" })
		Object.defineProperty(task, "isBackgroundSubtaskChild", { value: false })
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		Object.defineProperty(task, "messageQueueService", { value: new MessageQueueService() })

		// resume_task has no auto-approval mapping, so with the D4 seam inert the
		// ask posts a chat row and blocks on the user, exactly like any interactive
		// history task. A hosted child would instead resolve noButtonClicked
		// instantly (before any chat row) and fall through to initiateTaskLoop —
		// the P1-2 bug.
		//
		// This test must prove the blocking itself, so it engages the real
		// p-wait-for waiter: the file-level mock resolves unconditionally, and
		// approving from inside the row-post callback (as the previous revision
		// did) would let the ask settle without ever waiting for approval.
		const { default: realWaitFor } = await vi.importActual<typeof import("p-wait-for")>("p-wait-for")
		vi.mocked(pWaitFor).mockImplementation(realWaitFor)

		// The row post is the observable "the prompt is on screen" signal: wait
		// for it, prove the ask promise is still pending, then answer.
		let markRowPosted: () => void = () => {}
		const rowPosted = new Promise<void>((resolve) => {
			markRowPosted = resolve
		})
		task["addToClineMessages"] = vi.fn(async () => {
			markRowPosted()
		})

		const askPromise = task.ask("resume_task", "{}", false)
		await Promise.race([rowPosted, askPromise])
		expect(task["addToClineMessages"]).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ask", ask: "resume_task" }),
		)
		// The row posts exactly once: a second post would mean the ask resolved
		// and re-asked, which is the auto-resolve bug this test guards.
		expect(task["addToClineMessages"]).toHaveBeenCalledTimes(1)

		// The only legitimate way this promise settles is the approval below:
		// race it past one waiter poll interval and demand it is still pending.
		const stillPending = Symbol("stillPending")
		const outcome = await Promise.race([
			askPromise.then(
				() => "settled" as const,
				() => "rejected" as const,
			),
			new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 250)),
		])
		expect(outcome).toBe(stillPending)

		task.approveAsk()
		const result = await askPromise
		expect(result.response).toBe("yesButtonClicked")
	})
})
