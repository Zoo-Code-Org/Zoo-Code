// npx vitest run core/task/__tests__/background-retry-bound.spec.ts

import * as os from "os"
import * as path from "path"

import type { ExtensionContext } from "vscode"
import { providerIdentifiers, type GlobalState, type ModelInfo, type ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { WebviewFocusTracker } from "../../webview/WebviewFocusTracker"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom } from "../../../test-utils/stream"
import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"

// Mock delay before any imports that might use it (backoffAndAnnounce awaits it)
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

// The retry bound a background child is allowed before the terminal fires; the
// run makes the initial request plus this many retries, so a persistently
// failing path issues exactly MAX + 1 API calls (P1-1).
const MAX_ATTEMPTS = 3

function emptyStream(): AsyncGenerator<ApiStreamChunk> {
	return asyncStreamFrom<ApiStreamChunk>([])
}

async function* midStreamFailure(chunksBeforeFailure: ApiStreamChunk[]): AsyncGenerator<ApiStreamChunk> {
	for (const chunk of chunksBeforeFailure) {
		yield chunk
	}
	throw new Error("stream terminated mid-flight")
}

async function* firstChunkFailure(): AsyncGenerator<ApiStreamChunk> {
	throw new Error("first chunk failed")
	yield { type: "text", text: "unreachable" }
}

describe("background child retry bound (P1-1)", () => {
	let mockProvider: ClineProvider
	let mockContextProxy: ContextProxy
	let mockApiConfig: ProviderSettings
	let baseProviderState!: ProviderState

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

	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function buildTask(isBackgroundChild: boolean, autoApprovalEnabled: boolean) {
		vi.spyOn(mockProvider, "getState").mockResolvedValue(providerStateWith({ mode: "code", autoApprovalEnabled }))
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			backgroundToolPolicy: isBackgroundChild ? backgroundPolicy : undefined,
			backgroundChildHosted: isBackgroundChild,
		})
		await task.getTaskMode()
		return task
	}

	function armRequestSeams(task: Task, makeStream: () => AsyncGenerator<ApiStreamChunk>) {
		const seams = getTaskSeams(task)
		vi.spyOn(seams, "getSystemPrompt").mockResolvedValue("mock system prompt")
		vi.spyOn(seams, "safeEnsureModelFetched").mockResolvedValue(stubModelInfo)
		const createMessageSpy = vi.spyOn(task.api, "createMessage").mockImplementation(() => makeStream())
		vi.spyOn(task, "getTokenUsage").mockReturnValue({
			totalCost: 0,
			totalTokensIn: 0,
			totalTokensOut: 0,
			contextTokens: 0,
		})
		task["diffViewProvider"] = { reset: vi.fn() } as unknown as Task["diffViewProvider"]
		return createMessageSpy
	}

	it("noteBackgroundChildRetry terminates a hosted child past the cap and is a no-op for a normal task", async () => {
		const hosted = await buildTask(true, true)
		const normal = await buildTask(false, true)

		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			expect(() => hosted["noteBackgroundChildRetry"]()).not.toThrow()
		}
		expect(hosted.backgroundChildRetryCount).toBe(MAX_ATTEMPTS)
		expect(hosted.abandoned).toBe(false)

		// The next retry crosses the bound: requestAbort(true) + throw, exactly
		// like the mistake-limit terminal.
		expect(() => hosted["noteBackgroundChildRetry"]()).toThrow(/exceeded the automatic retry limit/)
		expect(hosted.abandoned).toBe(true)
		expect(hosted.backgroundChildRetryCount).toBe(MAX_ATTEMPTS + 1)

		// A normal task never counts and never aborts, however many retries.
		for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
			expect(() => normal["noteBackgroundChildRetry"]()).not.toThrow()
		}
		expect(normal.backgroundChildRetryCount).toBe(0)
		expect(normal.abandoned).toBe(false)
	})

	it("path (a): persistent empty assistant responses terminate the child after the cap", async () => {
		const task = await buildTask(true, true) // auto-approval ON: the looping branch
		const createMessageSpy = armRequestSeams(task, emptyStream)

		await task.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		// The run settles (the terminal throw is swallowed into didEndLoop), the
		// child is aborted, and the API calls are bounded at MAX + 1, not infinite.
		expect(task.abandoned).toBe(true)
		expect(task.backgroundChildRetryCount).toBe(MAX_ATTEMPTS + 1)
		expect(createMessageSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1)
	})

	it("path (b): persistent mid-stream failures terminate the child after the cap", async () => {
		const task = await buildTask(true, true)
		const createMessageSpy = armRequestSeams(task, () => midStreamFailure([{ type: "text", text: "partial" }]))

		await task.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		expect(task.abandoned).toBe(true)
		expect(task.backgroundChildRetryCount).toBe(MAX_ATTEMPTS + 1)
		expect(createMessageSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1)
	})

	it("path (c): persistent first-chunk failures terminate the child after the cap", async () => {
		const task = await buildTask(true, true) // auto-approval ON: the looping branch
		const createMessageSpy = armRequestSeams(task, firstChunkFailure)

		await task.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		expect(task.abandoned).toBe(true)
		expect(task.backgroundChildRetryCount).toBe(MAX_ATTEMPTS + 1)
		expect(createMessageSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS + 1)
	})

	it("a normal task is unaffected: the retry bound never engages on the empty path", async () => {
		// Auto-approval ON, empty stream. A normal task must NOT terminate at the
		// cap. The drive is otherwise unbounded, so end it manually once it has
		// already retried more times than a child is allowed.
		const task = await buildTask(false, true)
		let calls = 0
		const createMessageSpy = armRequestSeams(task, () => {
			calls += 1
			if (calls === MAX_ATTEMPTS + 2) {
				// The normal task is still healthy past the child's cap; stop the
				// drive. This abort is the test's, not the retry bound's.
				task.requestAbort(true)
			}
			return emptyStream()
		})

		await task.recursivelyMakeClineRequests([{ type: "text", text: "investigate" }])

		// The retry bound never engaged: the counter stayed at 0 across more
		// retries than the child cap, and every one of those retries issued.
		expect(task.backgroundChildRetryCount).toBe(0)
		expect(createMessageSpy).toHaveBeenCalledTimes(MAX_ATTEMPTS + 2)
	})
})
