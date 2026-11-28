// pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.backgroundSubtasks.spec.ts

import EventEmitter from "events"

import { WebviewFocusTracker } from "../WebviewFocusTracker"
import * as vscode from "vscode"
import type { HistoryItem, ProviderSettings } from "@roo-code/types"
import { ORGANIZATION_ALLOW_ALL, providerIdentifiers, RooCodeEventName } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { TaskRegistry } from "../../task/TaskRegistry"
import { Task } from "../../task/Task"
import { ShadowCheckpointService } from "../../../services/checkpoints/ShadowCheckpointService"
import { ProfileValidator } from "../../../shared/ProfileValidator"
import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"
import type {
	BackgroundChildEntry,
	BackgroundChildHandle,
	BackgroundSubtaskSpec,
} from "../../background-subtasks/types"
import {
	ClineProvider,
	DEFAULT_MAX_PARALLEL_SUBTASKS,
	MAX_LIVE_BACKGROUND_CHILDREN_PER_PARENT,
	MAX_PARALLEL_SUBTASKS_CAP,
} from "../ClineProvider"

const apiConfig: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiKey: "test-key",
}

/**
 * Shared state for the mocked `Task` constructor: every created child is
 * pushed here so a test can assert on the options the provider passed.
 */
const taskState = vi.hoisted(() => ({ created: [] as unknown[] }))

interface MockTaskConstructorOptions {
	taskId?: string
	task?: string
	parentTask?: { taskId: string }
	rootTask?: { taskId: string }
	/** Explicit authoritative root id for a child whose root object is gone. */
	rootTaskId?: string
	taskNumber?: number
	apiConfiguration?: unknown
	handoffExecutionContext?: {
		mode: string
		apiConfigName?: string
		apiConfiguration: ProviderSettings
	}
	backgroundToolPolicy?: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> }
	backgroundChildHosted?: boolean
	historyItem?: { id: string; rootTaskId?: string; parentTaskId?: string; number?: number }
}

/**
 * Tracks child task loop concurrency. `block()` makes every `run()` wait on a
 * shared gate so the scheduler cap can be observed; `releaseAll()` frees them.
 */
const runTracker = vi.hoisted(() => {
	const state = { active: 0, maxActive: 0, started: 0 }
	let gate: Promise<void> = Promise.resolve()
	let release: (() => void) | undefined
	let rejection: Error | undefined

	return {
		state,
		reset() {
			state.active = 0
			state.maxActive = 0
			state.started = 0
			gate = Promise.resolve()
			release = undefined
			rejection = undefined
		},
		block() {
			gate = new Promise<void>((resolve) => {
				release = resolve
			})
		},
		releaseAll() {
			release?.()
			release = undefined
		},
		/** Makes the next `run()` reject the way a failed child loop does. */
		failNext(message: string) {
			rejection = new Error(message)
		},
		async run() {
			state.started += 1
			state.active += 1
			state.maxActive = Math.max(state.maxActive, state.active)
			await gate
			state.active -= 1
			if (rejection) {
				const error = rejection
				rejection = undefined
				throw error
			}
		},
	}
})

/**
 * In-memory stand-in for `TaskHistoryStore` so the provider's registration
 * writes are observable, plus the constructor options for the option-wiring test.
 */
const storeState = vi.hoisted(() => ({
	items: new Map<string, HistoryItem>(),
	constructorOptions: [] as unknown[],
}))

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
			showInformationMessage: vi.fn(),
			showWarningMessage: vi.fn(),
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
		},
		Uri: {
			file: vi.fn().mockReturnValue({ toString: () => "file://test" }),
			joinPath: vi.fn(),
		},
		commands: {
			executeCommand: vi.fn().mockResolvedValue(undefined),
		},
		ExtensionMode: {
			Production: 1,
			Development: 2,
			Test: 3,
		},
		version: "1.85.0",
	}
})

// The fake child mirrors the constructor derivations the provider relies on:
// parentTaskId from `parentTask`, rootTaskId from an explicit `rootTaskId`, a
// `historyItem`, or `rootTask` (in that order, matching CR-1's Task option).
// It deliberately does not call `onCreated`; no assertion depends on provider
// listeners being wired for a child in these tests. The raw constructor
// options are retained on each instance so provider tests assert the wiring
// the provider actually performed instead of this double's derivation of it.
vi.mock("../../task/Task", () => {
	class MockTask {
		taskId: string
		instanceId = "mock-instance"
		/** Raw options verbatim as passed by the provider under test. */
		readonly rawOptions: MockTaskConstructorOptions
		rootTaskId?: string
		parentTaskId?: string
		taskNumber: number
		metadata: { task?: string }
		cwd = "/test/workspace"
		workspacePath = "/test/workspace"
		apiConfiguration: unknown
		handoffExecutionContext?: MockTaskConstructorOptions["handoffExecutionContext"]
		backgroundToolPolicy?: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> }
		/** Raw hosted flag as passed by the provider; no derivation is mirrored. */
		backgroundChildHosted?: boolean
		abort = false
		abandoned = false
		// EventEmitter gives once() real Node semantics — the listener is
		// removed before it runs — matching Task's production emitter so
		// abort-hook tests can detect a hook record retained after the once
		// was consumed.
		private readonly emitter = new EventEmitter()
		emit = vi.fn((event: string, ...args: unknown[]) => {
			this.emitter.emit(event, ...args)
		})
		on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			this.emitter.on(event, listener)
		})
		once = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			this.emitter.once(event, listener)
		})
		off = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			this.emitter.off(event, listener)
		})
		dispose = vi.fn().mockResolvedValue(undefined)
		abortTask = vi.fn(async () => {
			this.emit(RooCodeEventName.TaskAborted)
		})
		run = vi.fn(() => runTracker.run())
		getTaskMode = vi.fn(async () => "code")
		getTaskApiConfigName = vi.fn(async () => undefined)

		constructor(options: MockTaskConstructorOptions) {
			this.rawOptions = options
			this.taskId = options.historyItem?.id ?? options.taskId ?? `mock-task-${taskState.created.length + 1}`
			this.rootTaskId =
				options.rootTaskId ?? (options.historyItem ? options.historyItem.rootTaskId : options.rootTask?.taskId)
			this.parentTaskId = options.historyItem ? options.historyItem.parentTaskId : options.parentTask?.taskId
			this.taskNumber = options.taskNumber ?? options.historyItem?.number ?? -1
			this.metadata = { task: options.task }
			this.apiConfiguration = options.apiConfiguration
			this.handoffExecutionContext = options.handoffExecutionContext
			this.backgroundToolPolicy = options.backgroundToolPolicy
			// Record the hosted flag verbatim so tests assert the provider's
			// wiring (spawn sets it, restore omits it) rather than a property
			// this mock would have to derive. The `isBackgroundSubtaskChild`
			// derivation is asserted against the real `Task` in
			// src/core/task/__tests__/background-restored-child.spec.ts (P1-2).
			this.backgroundChildHosted = options.backgroundChildHosted
			taskState.created.push(this)
		}
	}

	return {
		Task: MockTask,
		PendingActionSettlementError: class PendingActionSettlementError extends Error {},
	}
})

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

vi.mock("../../../utils/path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../utils/path")>()
	return {
		...actual,
		getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
	}
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			setProvider: vi.fn(),
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
			captureTaskCompleted: vi.fn(),
		},
	},
}))

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

// Keep the real mode table so an unknown slug really is unknown.
vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		getModeBySlug: vi.fn(actual.getModeBySlug),
	}
})

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

// Keep the real lifecycle reducers (`addBackgroundChild`) and replace only the
// store, so the provider's registration writes land in the in-memory map.
vi.mock("../../task-persistence", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../task-persistence")>()

	const makeStore = () => ({
		initialize: vi.fn().mockResolvedValue(undefined),
		initialized: Promise.resolve(),
		dispose: vi.fn(),
		get: vi.fn((taskId: string) => storeState.items.get(taskId)),
		getAll: vi.fn(() => Array.from(storeState.items.values())),
		upsert: vi.fn(async (item: HistoryItem) => {
			const existing = storeState.items.get(item.id)
			storeState.items.set(item.id, existing ? { ...existing, ...item } : item)
			return Array.from(storeState.items.values())
		}),
		atomicReadAndUpdate: vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			const current = storeState.items.get(taskId)
			if (!current) {
				throw new Error(`[mock TaskHistoryStore] task ${taskId} not found`)
			}
			const updated = update(current)
			storeState.items.set(taskId, updated)
			return Array.from(storeState.items.values())
		}),
		delete: vi.fn().mockResolvedValue(undefined),
		deleteMany: vi.fn().mockResolvedValue(undefined),
		migrateFromGlobalState: vi.fn().mockResolvedValue(undefined),
		invalidate: vi.fn().mockResolvedValue(undefined),
		invalidateAll: vi.fn(),
		setAutoTitleIfAbsent: vi.fn().mockResolvedValue({ applied: false }),
	})

	return {
		...actual,
		TaskHistoryStore: vi.fn().mockImplementation(function (_path: string, options?: unknown) {
			storeState.constructorOptions.push(options)
			return makeStore()
		}),
		saveTaskMessages: vi.fn().mockResolvedValue(undefined),
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi.fn().mockResolvedValue(undefined),
	}
})

interface MockTaskInstance {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	rawOptions: MockTaskConstructorOptions
	taskNumber: number
	backgroundChildHosted?: boolean
	handoffExecutionContext?: MockTaskConstructorOptions["handoffExecutionContext"]
	backgroundToolPolicy?: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> }
	run: ReturnType<typeof vi.fn>
	abortTask: ReturnType<typeof vi.fn>
	dispose: ReturnType<typeof vi.fn>
	emit: ReturnType<typeof vi.fn<(event: string, ...args: unknown[]) => void>>
	once: ReturnType<typeof vi.fn>
	off: ReturnType<typeof vi.fn>
}

function createdTasks(): MockTaskInstance[] {
	return taskState.created as MockTaskInstance[]
}

/**
 * Minimal stand-in for the members `spawnBackgroundChildren` reads from a parent
 * task: identity, lineage, mode/profile accessors, and the TaskAborted emitter.
 */
class FakeParentTask {
	// EventEmitter gives once() real Node semantics — the listener is removed
	// before it runs — so abort-hook tests can tell when the provider retains
	// a hook record after the once has already been consumed.
	private readonly emitter = new EventEmitter()
	readonly instanceId = "parent-instance"
	readonly apiConfiguration: ProviderSettings = apiConfig
	dispose = vi.fn().mockResolvedValue(undefined)
	abortTask = vi.fn().mockResolvedValue(undefined)
	flushPendingToolResultsToHistory = vi.fn().mockResolvedValue(true)

	constructor(
		readonly taskId: string,
		readonly rootTaskId?: string,
		// `Task` retains this reference after the stack pops that delegation
		// performs; every production lineage walk relies on it (D-01).
		readonly parentTask?: FakeParentTask,
	) {}

	async getTaskMode(): Promise<string> {
		return "code"
	}

	async getTaskApiConfigName(): Promise<string> {
		return "default-profile"
	}

	once(event: string, listener: (...args: unknown[]) => void): void {
		this.emitter.once(event, listener)
	}

	off(event: string, listener: (...args: unknown[]) => void): void {
		this.emitter.off(event, listener)
	}

	emit(event: string): void {
		this.emitter.emit(event)
	}

	listenerCount(event: string): number {
		return this.emitter.listenerCount(event)
	}
}

// The double implements TaskIdentity/lineage/mode accessors and an event emitter;
// no other Task surface is reachable from spawnBackgroundChildren.
function asTask(parent: FakeParentTask): Task {
	return parent as unknown as Task
}

function seedRegistry(provider: ClineProvider, ...tasks: FakeParentTask[]): void {
	const registry = new TaskRegistry()
	for (const task of tasks) {
		registry.push(asTask(task))
	}
	provider["taskRegistry"] = registry
}

function seedParentRecord(taskId: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
	const item: HistoryItem = {
		id: taskId,
		number: 1,
		ts: 1,
		task: "Parent task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
		...overrides,
	}
	storeState.items.set(taskId, item)
	return item
}

const flush = async (ticks = 6): Promise<void> => {
	for (let index = 0; index < ticks; index++) {
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

function makeSpec(label: string, mode = "code"): BackgroundSubtaskSpec {
	return { label, mode, message: `Investigate ${label}` }
}

async function spawn(
	provider: ClineProvider,
	parent: FakeParentTask,
	specs: BackgroundSubtaskSpec[],
): Promise<{ children: BackgroundChildHandle[]; started: boolean }> {
	return provider.spawnBackgroundChildren(asTask(parent), specs)
}

describe("ClineProvider background subtasks (D2/D7/D8)", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()
		taskState.created.length = 0
		runTracker.reset()
		storeState.items.clear()
		storeState.constructorOptions.length = 0

		vi.spyOn(ProfileValidator, "isProfileAllowed").mockReturnValue(true)

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
			extension: { packageJSON: { version: "1.0.0" } },
			subscriptions: [],
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		const mockContextProxy = {
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn().mockReturnValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			setValues: vi.fn().mockResolvedValue(undefined),
			getProviderSettings: vi.fn().mockReturnValue(apiConfig),
			extensionUri: mockContext.extensionUri,
			globalStorageUri: mockContext.globalStorageUri,
		}

		provider = new ClineProvider(
			mockContext,
			mockOutputChannel,
			"sidebar",
			mockContextProxy as unknown as ContextProxy,
			new WebviewFocusTracker(),
		)

		provider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: apiConfig,
			customModes: [],
			organizationAllowList: ORGANIZATION_ALLOW_ALL,
			// `addClineToStack` refuses to finish without a mode.
			mode: "code",
		})
		provider["getModeConfigId"] = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(async () => {
		runTracker.releaseAll()
		await provider.dispose()
		vi.restoreAllMocks()
	})

	describe("spawnBackgroundChildren", () => {
		it("returns no children for an empty spec list", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)

			const result = await spawn(provider, parent, [])

			expect(result).toEqual({ children: [], started: false })
			expect(createdTasks()).toHaveLength(0)
		})

		it("caps a batch at MAX_PARALLEL_SUBTASKS_CAP and logs the truncation", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			provider.log = vi.fn()

			const specs = Array.from({ length: MAX_PARALLEL_SUBTASKS_CAP + 2 }, (_value, index) =>
				makeSpec(`child-${index}`),
			)
			const result = await spawn(provider, parent, specs)

			expect(result.children).toHaveLength(MAX_PARALLEL_SUBTASKS_CAP)
			expect(createdTasks()).toHaveLength(MAX_PARALLEL_SUBTASKS_CAP)
			expect(provider.log).toHaveBeenCalledWith(
				expect.stringContaining(`Truncated ${specs.length} requested background children`),
			)
		})

		it("does not push children onto the task stack", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			const lengthBefore = provider["taskRegistry"].length

			await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])

			expect(provider["taskRegistry"].length).toBe(lengthBefore)
			expect(provider.getCurrentTask()?.taskId).toBe("parent-1")
		})

		it("inherits parentTaskId and rootTaskId from the parent lineage", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			await spawn(provider, parent, [makeSpec("a")])

			// Assert the raw options the provider passed; the double's derivation
			// of rootTaskId/parentTaskId is covered against a real `Task` in the
			// task-layer suite and must not be what keeps this test green.
			const [child] = createdTasks()
			expect(child.rawOptions.parentTask?.taskId).toBe("parent-1")
			expect(child.rawOptions.rootTask?.taskId).toBe("parent-1")
			expect(child.rawOptions.rootTaskId).toBeUndefined()
		})

		it("inherits the true root when the delegated parent's root is absent from the registry", async () => {
			// Production-reachable state (D-01): delegation pops every ancestor
			// off the stack, so the registry holds only the delegated parent and
			// the root survives only as the parent's in-memory `parentTask`.
			const root = new FakeParentTask("root-1")
			const parent = new FakeParentTask("parent-1", "root-1", root)
			seedRegistry(provider, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			expect(provider["taskRegistry"].getById("root-1")).toBeUndefined()

			await spawn(provider, parent, [makeSpec("a")])

			const [child] = createdTasks()
			expect(child.rawOptions.parentTask?.taskId).toBe("parent-1")
			expect(child.rawOptions.rootTask?.taskId).toBe("root-1")
			expect(child.rawOptions.rootTaskId).toBeUndefined()
		})

		it("walks a nested delegation chain to the root", async () => {
			const root = new FakeParentTask("root-1")
			const middle = new FakeParentTask("middle-1", "root-1", root)
			const parent = new FakeParentTask("parent-1", "root-1", middle)
			seedRegistry(provider, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			await spawn(provider, parent, [makeSpec("a")])

			expect(createdTasks()[0].rawOptions.rootTask?.taskId).toBe("root-1")
			expect(createdTasks()[0].rawOptions.rootTaskId).toBeUndefined()
		})

		it("numbers the batch on its own channel without colliding with delegation", async () => {
			const root = new FakeParentTask("root-1")
			const parent = new FakeParentTask("parent-1", "root-1")
			seedRegistry(provider, root, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
			await spawn(provider, parent, [makeSpec("c"), makeSpec("d")])

			const numbers = createdTasks().map((task) => task.taskNumber)
			expect(numbers).toEqual([3, 4, 5, 6])
			expect(new Set(numbers).size).toBe(numbers.length)

			// A delegated child is numbered after the parent leaves the stack
			// (length 1 -> 2), which is the channel the batch must not reuse.
			const delegatedNumberAfterParentLeaves = provider["taskRegistry"].length - 1 + 1
			expect(numbers).not.toContain(delegatedNumberAfterParentLeaves)
		})

		it("turns an unknown mode into a failed handle without spawning a task", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const result = await spawn(provider, parent, [makeSpec("ok", "code"), makeSpec("bad", "missing-mode")])

			expect(result.children).toHaveLength(2)
			expect(createdTasks()).toHaveLength(1)

			const failedEntry = (await result.children[1].done) as BackgroundChildEntry
			expect(failedEntry.status).toBe("failed")
			expect(failedEntry.error).toBe("Unknown mode: missing-mode")
			expect(failedEntry.label).toBe("bad")
			expect(result.children[0].taskId).toBe(createdTasks()[0].taskId)
		})

		it("keeps other specs alive when construction fails", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const originalCreateTask = provider.createTask.bind(provider)
			let call = 0
			provider.createTask = vi.fn(async (...args: Parameters<typeof originalCreateTask>) => {
				call += 1
				if (call === 1) {
					throw new Error("provider rejected the profile")
				}
				return originalCreateTask(...args)
			})

			const result = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])

			expect(createdTasks()).toHaveLength(1)
			const firstEntry = (await result.children[0].done) as BackgroundChildEntry
			expect(firstEntry.status).toBe("failed")
			expect(firstEntry.error).toBe("provider rejected the profile")
			expect(result.children[1].taskId).toBe(createdTasks()[0].taskId)
		})

		it("injects the read-only background tool policy into every child", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			await spawn(provider, parent, [makeSpec("a"), makeSpec("b", "architect")])

			const children = createdTasks()
			expect(children).toHaveLength(2)

			for (const child of children) {
				expect(child.backgroundChildHosted).toBe(true)
				const disabledTools = child.backgroundToolPolicy?.disabledTools ?? []
				expect(disabledTools).toEqual(BACKGROUND_CHILD_DISABLED_TOOLS)
				expect(disabledTools).toContain("write_to_file")
				expect(disabledTools).toContain("execute_command")
				expect(disabledTools).toContain("new_task")
				expect(child.backgroundToolPolicy?.experiments).toEqual(BACKGROUND_CHILD_EXPERIMENTS)
				expect(child.backgroundToolPolicy?.experiments?.customTools).toBe(false)
			}
		})

		it("registers every child id on the parent without touching awaitingChildId", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const result = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])

			const parentRecord = storeState.items.get("parent-1")
			expect(parentRecord?.childIds).toEqual(result.children.map((child) => child.taskId))
			expect(parentRecord?.awaitingChildId).toBeUndefined()
			expect(parentRecord?.status).toBe("active")
		})

		it("stamps each child history record with backgroundParentTaskId", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			// Park the runs so the records stay live while registration is read.
			runTracker.block()

			const result = await spawn(provider, parent, [makeSpec("a", "code"), makeSpec("b", "architect")])

			for (const [index, child] of createdTasks().entries()) {
				const record = storeState.items.get(child.taskId)
				expect(record).toBeDefined()
				expect(record?.backgroundParentTaskId).toBe("parent-1")
				expect(record?.parentTaskId).toBe("parent-1")
				expect(record?.status).toBe("active")
				expect(record?.number).toBe(child.taskNumber)
				expect(record?.mode).toBe(result.children[index].mode)
			}
		})
	})

	describe("spawn cancellation window (CR finding 1)", () => {
		/**
		 * Start a spawn whose `createTask` is parked, run `duringCreate` once the
		 * construction is in flight, then release it and return the spawn result.
		 */
		async function spawnWithParkedCreate(
			parent: FakeParentTask,
			specs: BackgroundSubtaskSpec[],
			duringCreate: () => Promise<void> | void,
		): Promise<{ children: BackgroundChildHandle[]; started: boolean }> {
			const originalCreateTask = provider.createTask.bind(provider)
			let releaseCreate!: () => void
			const createGate = new Promise<void>((resolve) => {
				releaseCreate = resolve
			})
			let enteredCreate!: () => void
			const createEntered = new Promise<void>((resolve) => {
				enteredCreate = resolve
			})

			provider.createTask = vi.fn(async (...args: Parameters<typeof originalCreateTask>) => {
				enteredCreate()
				await createGate
				return originalCreateTask(...args)
			})

			const spawnPromise = spawn(provider, parent, specs)
			await createEntered
			await duringCreate()
			releaseCreate()
			return spawnPromise
		}

		it("does not schedule or publish a child created after the parent was cancelled", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const result = await spawnWithParkedCreate(parent, [makeSpec("late")], () => {
				parent.emit(RooCodeEventName.TaskAborted)
			})

			expect(createdTasks()).toHaveLength(1)
			expect(provider["backgroundTasks"].size).toBe(0)
			expect(runTracker.state.started).toBe(0)

			const entry = await result.children[0].done
			expect(entry.status).toBe("aborted")
			expect(entry.error).toBe("Parent task was cancelled")
			expect(createdTasks()[0].dispose).toHaveBeenCalled()
		})

		it("does not schedule or publish a child whose construction outlived the provider", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const result = await spawnWithParkedCreate(parent, [makeSpec("late")], async () => {
				await provider.dispose()
			})

			expect(runTracker.state.started).toBe(0)
			expect(provider["backgroundTasks"].size).toBe(0)

			const entry = await result.children[0].done
			expect(entry.status).toBe("aborted")
			expect(entry.error).toBe("Provider disposed")
		})
	})

	describe("mode profile fallback (CR finding 3)", () => {
		it("spawns with the parent configuration when the mode config id lookup rejects", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			provider["getModeConfigId"] = vi.fn().mockRejectedValue(new Error("settings store unavailable"))

			const result = await spawn(provider, parent, [makeSpec("a", "architect"), makeSpec("b", "architect")])

			expect(result.children).toHaveLength(2)
			expect(createdTasks()).toHaveLength(2)
			for (const child of createdTasks()) {
				expect(child.handoffExecutionContext?.mode).toBe("architect")
				expect(child.handoffExecutionContext?.apiConfigName).toBe("default-profile")
				expect(child.handoffExecutionContext?.apiConfiguration).toEqual(apiConfig)
			}
		})
	})

	describe("authoritative lineage root without a live root object (CR finding 5)", () => {
		it("carries the parent's stored rootTaskId when neither the registry nor the chain has the root", async () => {
			const parent = new FakeParentTask("parent-1", "root-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			expect(provider["taskRegistry"].getById("root-1")).toBeUndefined()

			await spawn(provider, parent, [makeSpec("a")])

			// No live root object exists, so the provider must pass the
			// authoritative id explicitly (CR finding 5) rather than a root object.
			const [child] = createdTasks()
			expect(child.rawOptions.rootTask).toBeUndefined()
			expect(child.rawOptions.rootTaskId).toBe("root-1")
			expect(child.rawOptions.parentTask?.taskId).toBe("parent-1")
		})

		it("carries the stored rootTaskId into a delegated child", async () => {
			const parent = new FakeParentTask("parent-1", "root-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-1",
				message: "do the thing",
				initialTodos: [],
				mode: "code",
			})

			const [child] = createdTasks()
			expect(child.rawOptions.rootTask).toBeUndefined()
			expect(child.rawOptions.rootTaskId).toBe("root-1")
			expect(child.rawOptions.parentTask?.taskId).toBe("parent-1")
		})
	})

	describe("run ended without a terminal state (F-02)", () => {
		it("settles the handle as failed when the run ends without attempt_completion", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			// An unblocked run resolves immediately and never resolves the host
			// handle: the mistake-limit / token-limit / first-chunk-failure shape.
			const { children } = await spawn(provider, parent, [makeSpec("mistake-limit")])
			const entry = await children[0].done

			expect(entry.status).toBe("failed")
			expect(entry.error).toBe("Background child run ended without a terminal state")
			expect(entry.finishedAt).toBeTypeOf("number")
			expect(provider["backgroundTasks"].size).toBe(0)

			// The parent's join is exactly this Promise.all; it must resolve.
			await expect(Promise.all(children.map((child) => child.done))).resolves.toHaveLength(1)
		})

		it("frees the scheduler permits when runs end without a terminal state", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.block()
			const first = await spawn(
				provider,
				parent,
				Array.from({ length: DEFAULT_MAX_PARALLEL_SUBTASKS }, (_value, index) => makeSpec(`child-${index}`)),
			)
			await flush()
			expect(runTracker.state.active).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)

			runTracker.releaseAll()
			const entries = await Promise.all(first.children.map((child) => child.done))
			expect(entries.map((entry) => entry.status)).toEqual(
				Array.from({ length: DEFAULT_MAX_PARALLEL_SUBTASKS }, () => "failed"),
			)

			// A fresh child starts immediately, proving the pool is free.
			const second = await spawn(provider, parent, [makeSpec("next")])
			await flush(10)
			expect(second.children).toHaveLength(1)
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS + 1)
		})

		it("does not overwrite the error of a run that rejected", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.failNext("api exploded")
			const { children } = await spawn(provider, parent, [makeSpec("explodes")])
			const entry = await children[0].done

			expect(entry.status).toBe("failed")
			expect(entry.error).toBe("api exploded")
		})
	})

	describe("running transition (F-09)", () => {
		it("reports a child as running once the scheduler permit is acquired", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.block()
			const started: BackgroundChildEntry[] = []
			const { children } = await provider.spawnBackgroundChildren(
				asTask(parent),
				[makeSpec("a"), makeSpec("b")],
				{ onChildStarted: (entry) => started.push(entry) },
			)
			await flush()

			expect(started).toHaveLength(2)
			expect(started.every((entry) => entry.status === "running")).toBe(true)
			expect(started.every((entry) => typeof entry.startedAt === "number")).toBe(true)

			provider.resolveBackgroundChild(children[0].taskId, "report")
			provider.resolveBackgroundChild(children[1].taskId, "report")
			const entries = await Promise.all(children.map((child) => child.done))

			expect(entries.map((entry) => entry.status)).toEqual(["completed", "completed"])
			// Only the queued -> running transition is reported.
			expect(started).toHaveLength(2)
		})

		it("does not report a queued child before a permit frees", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.block()
			const started: string[] = []
			await provider.spawnBackgroundChildren(
				asTask(parent),
				Array.from({ length: DEFAULT_MAX_PARALLEL_SUBTASKS + 1 }, (_value, index) =>
					makeSpec(`child-${index}`),
				),
				{ onChildStarted: (entry) => started.push(entry.taskId) },
			)
			await flush()
			expect(started).toHaveLength(DEFAULT_MAX_PARALLEL_SUBTASKS)

			runTracker.releaseAll()
			await flush(10)
			expect(started).toHaveLength(DEFAULT_MAX_PARALLEL_SUBTASKS + 1)
		})
	})

	describe("cumulative live-children cap (F-17)", () => {
		it("rejects specs beyond the per-parent cap across repeated fan-outs", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const first = await spawn(
				provider,
				parent,
				Array.from({ length: MAX_PARALLEL_SUBTASKS_CAP }, (_value, index) => makeSpec(`child-${index}`)),
			)
			const second = await spawn(provider, parent, [makeSpec("g"), makeSpec("h")])
			expect(first.children).toHaveLength(MAX_PARALLEL_SUBTASKS_CAP)
			expect(second.children).toHaveLength(2)
			expect(provider["backgroundTasks"].size).toBe(MAX_LIVE_BACKGROUND_CHILDREN_PER_PARENT)
			expect(createdTasks()).toHaveLength(MAX_LIVE_BACKGROUND_CHILDREN_PER_PARENT)

			const third = await spawn(provider, parent, [makeSpec("overflow")])

			expect(third.children).toHaveLength(1)
			expect(createdTasks()).toHaveLength(MAX_LIVE_BACKGROUND_CHILDREN_PER_PARENT)
			const entry = await third.children[0].done
			expect(entry.status).toBe("failed")
			expect(entry.error).toBe(
				`Live background child limit reached (${MAX_LIVE_BACKGROUND_CHILDREN_PER_PARENT} per parent)`,
			)
		})
	})

	describe("task numbering across batches (F-19)", () => {
		it("never repeats a task number across sequential fan-out batches", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const first = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
			provider.resolveBackgroundChild(first.children[0].taskId, "report")
			provider.resolveBackgroundChild(first.children[1].taskId, "report")
			await flush()

			const second = await spawn(provider, parent, [makeSpec("c"), makeSpec("d")])
			provider.resolveBackgroundChild(second.children[0].taskId, "report")
			provider.resolveBackgroundChild(second.children[1].taskId, "report")
			await flush()

			const numbers = createdTasks().map((task) => task.taskNumber)
			expect(numbers).toHaveLength(4)
			expect(new Set(numbers).size).toBe(numbers.length)
			expect(numbers).toEqual([...numbers].sort((left, right) => left - right))
		})
	})

	describe("abort-hook release (F-21)", () => {
		it("releases the idle hook when the spawn throws before any child registers", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			// A cross-mode spec loads a saved profile; a throwing profile read
			// aborts the batch before the first child exists. (The mode-config id
			// lookup itself is covered by its own fallback since CR finding 3.)
			provider["loadSavedModeProfile"] = vi.fn().mockRejectedValue(new Error("settings store unavailable"))

			await expect(spawn(provider, parent, [makeSpec("a", "architect")])).rejects.toThrow(
				"settings store unavailable",
			)

			expect(parent.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
			expect(provider["backgroundAbortHooks"].size).toBe(0)
		})
	})

	describe("log-injection hardening (F-22)", () => {
		it("JSON-encodes a model-controlled label in spawn failure logs", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			provider.log = vi.fn()
			provider.createTask = vi.fn(async (..._args: Parameters<ClineProvider["createTask"]>) => {
				throw new Error("rejected by the profile check")
			})

			const label = "evil\n[spawnBackgroundChildren] forged line"
			const result = await spawn(provider, parent, [makeSpec(label)])
			const entry = await result.children[0].done

			expect(entry.status).toBe("failed")
			const logs = (provider.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string)
			const failureLog = logs.find((line) => line.includes("Failed to create child"))
			expect(failureLog).toBeDefined()
			expect(failureLog).toContain(JSON.stringify(label))
			expect(failureLog).not.toContain("\n")
		})
	})

	describe("delegation lineage (D-01)", () => {
		it("stamps a top-level delegation child with the parent as its root", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-1",
				message: "do the thing",
				initialTodos: [],
				mode: "code",
			})

			const [child] = createdTasks()
			expect(child.rawOptions.rootTask?.taskId).toBe("parent-1")
			expect(child.rawOptions.rootTaskId).toBeUndefined()
			expect(child.rawOptions.parentTask?.taskId).toBe("parent-1")
		})

		it("carries the true root instead of reading the registry after the parent was popped", async () => {
			const root = new FakeParentTask("root-1")
			const parent = new FakeParentTask("parent-1", "root-1", root)
			seedRegistry(provider, parent)
			seedParentRecord("parent-1", { rootTaskId: "root-1" })

			await provider.delegateParentAndOpenChild({
				parentTaskId: "parent-1",
				message: "do the thing",
				initialTodos: [],
				mode: "code",
			})

			// The registry is empty when the child is constructed; the lineage
			// root comes from the reference captured before removeClineFromStack.
			expect(provider["taskRegistry"].getById("parent-1")).toBeUndefined()
			expect(provider["taskRegistry"].getById("root-1")).toBeUndefined()
			const [child] = createdTasks()
			expect(child.rawOptions.rootTask?.taskId).toBe("root-1")
			expect(child.rawOptions.rootTaskId).toBeUndefined()
		})
	})

	describe("restored background child policy (F-05)", () => {
		it("re-applies the read-only policy to a history item stamped with backgroundParentTaskId", async () => {
			await provider.createTaskWithHistoryItem(
				{
					...seedParentRecord("child-1"),
					parentTaskId: "parent-1",
					backgroundParentTaskId: "parent-1",
				},
				{ startTask: false },
			)

			const [restored] = createdTasks()
			expect(restored.taskId).toBe("child-1")
			// P1-2: the restore path must OMIT the hosted flag so the restored
			// child installed as the current stack task stays interactive (state
			// posts flow, the resume ask blocks for approval). Only the spawn
			// path passes it; the interactivity derivation from the flag is
			// covered against the real `Task` in the task-layer suite.
			expect(restored.backgroundChildHosted).toBeUndefined()
			// F-05: but its read-only policy is preserved on restore.
			expect(restored.backgroundToolPolicy?.disabledTools).toEqual(BACKGROUND_CHILD_DISABLED_TOOLS)
			expect(restored.backgroundToolPolicy?.experiments).toEqual(BACKGROUND_CHILD_EXPERIMENTS)
		})

		it("leaves a normal history item without the background policy", async () => {
			await provider.createTaskWithHistoryItem(seedParentRecord("normal-1"), { startTask: false })

			const [restored] = createdTasks()
			expect(restored.backgroundChildHosted).toBeUndefined()
			expect(restored.backgroundToolPolicy).toBeUndefined()
		})
	})

	describe("background scheduler (D7)", () => {
		it("runs at most DEFAULT_MAX_PARALLEL_SUBTASKS children concurrently and queues the rest", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			expect(DEFAULT_MAX_PARALLEL_SUBTASKS).toBe(4)
			expect(MAX_PARALLEL_SUBTASKS_CAP).toBe(6)

			runTracker.block()
			const result = await spawn(
				provider,
				parent,
				Array.from({ length: MAX_PARALLEL_SUBTASKS_CAP }, (_value, index) => makeSpec(`child-${index}`)),
			)

			await flush()
			expect(result.children).toHaveLength(MAX_PARALLEL_SUBTASKS_CAP)
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)
			expect(runTracker.state.active).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)
			expect(runTracker.state.maxActive).toBeLessThanOrEqual(MAX_PARALLEL_SUBTASKS_CAP)

			runTracker.releaseAll()
			await flush(10)

			expect(runTracker.state.started).toBe(MAX_PARALLEL_SUBTASKS_CAP)
			expect(runTracker.state.active).toBe(0)
			expect(runTracker.state.maxActive).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)
		})
	})

	describe("background scheduler permit release (D5 regression)", () => {
		// The defect: a background child whose run completes through the D5 path
		// never released its scheduler permit, because only the host handle
		// settled while the run promise kept looping. After
		// DEFAULT_MAX_PARALLEL_SUBTASKS such children, every later background
		// child starved. These tests park the mock runs on the tracker gate, so
		// the permit can only come back through the terminal-settle path.
		it("returns the pool to full availability after DEFAULT_MAX_PARALLEL_SUBTASKS children complete", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.block()
			const batch = await spawn(
				provider,
				parent,
				Array.from({ length: DEFAULT_MAX_PARALLEL_SUBTASKS }, (_value, index) => makeSpec(`child-${index}`)),
			)
			await flush()
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)

			// D5: every child reported its result while its run is still parked.
			for (const child of batch.children) {
				provider.resolveBackgroundChild(child.taskId, "report")
			}

			const extra = await spawn(provider, parent, [makeSpec("overflow")])
			await flush(10)

			expect(extra.children).toHaveLength(1)
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS + 1)
			const entries = await Promise.all(batch.children.map((child) => child.done))
			expect(entries.map((entry) => entry.status)).toEqual(["completed", "completed", "completed", "completed"])
		})

		it("releases the permits for children aborted mid-run and settles their handles as aborted", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			// Fill the whole pool with parked runs so a permit comes back only
			// through the terminal settle, never through run() settling.
			runTracker.block()
			const first = await spawn(
				provider,
				parent,
				Array.from({ length: DEFAULT_MAX_PARALLEL_SUBTASKS }, (_value, index) => makeSpec(`child-${index}`)),
			)
			await flush()
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS)

			parent.emit(RooCodeEventName.TaskAborted)
			await flush()

			const entries = await Promise.all(first.children.map((child) => child.done))
			expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted", "aborted", "aborted"])

			// The parked runs have not settled, so the next child starts only
			// because each abort released its permit at the terminal settle. A
			// live parent is what production hands the freed pool to: the
			// aborted parent itself is unspawnable again (abort flag set, spawn
			// epoch bumped), and the fake emits the event without recording
			// either, so the second spawn goes through a fresh parent on the
			// same provider.
			const secondParent = new FakeParentTask("parent-2")
			seedRegistry(provider, secondParent)
			seedParentRecord("parent-2")
			const second = await spawn(provider, secondParent, [makeSpec("e")])
			await flush(10)
			expect(second.children).toHaveLength(1)
			expect(runTracker.state.started).toBe(DEFAULT_MAX_PARALLEL_SUBTASKS + 1)
		})

		it("keeps the completed outcome when the parked run settles late", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.block()
			const first = await spawn(provider, parent, [makeSpec("a")])
			provider.resolveBackgroundChild(first.children[0].taskId, "report")
			const entry = await first.children[0].done
			expect(entry.status).toBe("completed")

			// The run settles after the terminal record; nothing may re-settle or
			// overwrite the outcome the parent already collected.
			runTracker.releaseAll()
			await flush(10)
			const settled = await first.children[0].done
			expect(settled.status).toBe("completed")
			expect(settled.result).toBe("report")
		})
	})

	describe("BackgroundSubtaskHost", () => {
		it("settles a completed child exactly once with its result", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId
			seedChildRecord(childId)

			provider.resolveBackgroundChild(childId, "report body")
			provider.resolveBackgroundChild(childId, "second body")

			const entry = await children[0].done
			expect(entry.status).toBe("completed")
			expect(entry.result).toBe("report body")
			expect(entry.finishedAt).toBeTypeOf("number")
			expect(provider["backgroundTasks"].has(childId)).toBe(false)
		})

		it("keeps the first outcome when resolve is followed by fail", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId
			seedChildRecord(childId)

			provider.resolveBackgroundChild(childId, "report body")
			provider.failBackgroundChild(childId, "late failure")

			const entry = await children[0].done
			expect(entry.status).toBe("completed")
			expect(entry.result).toBe("report body")
			expect(entry.error).toBeUndefined()
		})

		it("ignores a failure for a child that was never registered", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			expect(() => provider.failBackgroundChild("unknown-child", "boom")).not.toThrow()
			expect(provider["backgroundTasks"].size).toBe(0)
		})
	})

	describe("terminal resource release (CR finding 2)", () => {
		it("disposes the child exactly once after a normal completion and keeps its status", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId
			expect(storeState.items.get(childId)?.status).toBe("active")

			provider.resolveBackgroundChild(childId, "report")
			const entry = await children[0].done
			await flush(10)

			const child = createdTasks()[0]
			expect(entry.status).toBe("completed")
			expect(child.dispose).toHaveBeenCalledTimes(1)
			// Dispose must not go through the aborted path: that would have
			// emitted TaskAborted and let the hook overwrite the status.
			expect(child.emit).not.toHaveBeenCalledWith(RooCodeEventName.TaskAborted)
			expect(storeState.items.get(childId)?.status).toBe("completed")
		})

		it("disposes the child exactly once after a terminal failure and keeps its status", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			runTracker.failNext("api exploded")
			const { children } = await spawn(provider, parent, [makeSpec("explodes")])
			const entry = await children[0].done
			await flush(10)

			const child = createdTasks()[0]
			expect(entry.status).toBe("failed")
			expect(entry.error).toBe("api exploded")
			expect(child.dispose).toHaveBeenCalledTimes(1)
			expect(child.emit).not.toHaveBeenCalledWith(RooCodeEventName.TaskAborted)
			// A failed child has no terminal history status of its own.
			expect(storeState.items.get(child.taskId)?.status).toBe("interrupted")
		})

		it("does not release twice when the child's own abort settles it first", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childTask = createdTasks()[0]
			expect(childTask).toBeDefined()

			// The child aborts itself (API failure, disposal) while the parent
			// stays active: the handle must settle through the child's own
			// TaskAborted hook, not the parent cascade.
			childTask.emit(RooCodeEventName.TaskAborted)
			await flush()

			const entry = await children[0].done
			expect(entry.status).toBe("aborted")
			expect(entry.error).toBe("Background child was aborted")
			expect(childTask.dispose).toHaveBeenCalledTimes(1)
			// The parent cascade never ran: the parent is untouched and no
			// "Parent task was cancelled" settlement overwrote the child reason.
			expect(parent.abortTask).not.toHaveBeenCalled()

			// The parked run releasing later must not settle or dispose again.
			runTracker.releaseAll()
			await flush()

			expect(childTask.dispose).toHaveBeenCalledTimes(1)
			expect(provider["backgroundTasks"].size).toBe(0)
		})
	})

	describe("deleting a live background child (CR finding 4)", () => {
		it("stops and drains the deleted child before removing history, leaving its sibling running", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
			const [target, sibling] = children
			const targetTask = createdTasks().find((task) => task.taskId === target.taskId)!
			const siblingTask = createdTasks().find((task) => task.taskId === sibling.taskId)!

			let releaseAbort!: () => void
			const abortGate = new Promise<void>((resolve) => {
				releaseAbort = resolve
			})
			targetTask.abortTask.mockImplementation(async () => {
				await abortGate
			})

			// Gate disposal separately: `finishBackgroundChild` already calls
			// `dispose()`, so an immediately-resolving mock would let the final
			// assertions pass even if the deletion path stopped awaiting the
			// drain. Deletion must stay blocked until BOTH gates open.
			let releaseDispose!: () => void
			const disposeGate = new Promise<void>((resolve) => {
				releaseDispose = resolve
			})
			targetTask.dispose.mockImplementation(async () => {
				await disposeGate
			})

			const deleteMany = vi.spyOn(provider.taskHistoryStore, "deleteMany")
			vi.spyOn(ShadowCheckpointService, "deleteTask").mockResolvedValue(undefined)
			vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)

			const deletion = provider.deleteTaskWithId(target.taskId, false)
			try {
				await flush()

				// The child is off-stack, so its run must be stopped by the deletion
				// path itself; history removal waits for that drain.
				expect(targetTask.abortTask).toHaveBeenCalledTimes(1)
				expect(deleteMany).not.toHaveBeenCalled()

				releaseAbort()
				await flush()

				// The abort has settled, but the drain still awaits the child's
				// disposal: history removal must remain blocked.
				expect(deleteMany).not.toHaveBeenCalled()

				releaseDispose()
				await deletion

				expect(deleteMany).toHaveBeenCalledWith([target.taskId])
				expect(targetTask.dispose).toHaveBeenCalled()
				expect(siblingTask.abortTask).not.toHaveBeenCalled()
				expect(provider["backgroundTasks"].has(sibling.taskId)).toBe(true)
				expect(provider["backgroundTasks"].has(target.taskId)).toBe(false)
			} finally {
				// A failed assertion must not leave the deletion parked: the suite
				// teardown only releases the run tracker, and afterEach's
				// provider.dispose() would wait on these same gates forever.
				// Promise resolves are idempotent, so the staged releases above
				// stay as-is on the success path.
				releaseAbort()
				releaseDispose()
				await deletion
			}
		})
	})

	describe("cancel cascade and dispose (D8)", () => {
		it("aborts and settles every child when the parent emits TaskAborted", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			// Park the runs: the abort must settle live children, not children
			// the run-ended catch-all already failed.
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
			expect(parent.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)

			parent.emit(RooCodeEventName.TaskAborted)
			await flush()

			for (const child of createdTasks()) {
				expect(child.abortTask).toHaveBeenCalled()
			}

			const entries = await Promise.all(children.map((child) => child.done))
			expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted"])
			expect(entries.every((entry) => entry.error === "Parent task was cancelled")).toBe(true)
			expect(provider["backgroundTasks"].size).toBe(0)
			expect(parent.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		})

		it("aborts and settles every child on dispose and drains the map", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			// Park the runs so dispose, not the run-ended catch-all, settles them.
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
			provider["taskRegistry"] = new TaskRegistry()

			await provider.dispose()

			expect(provider["backgroundTasks"].size).toBe(0)
			for (const child of createdTasks()) {
				expect(child.abortTask).toHaveBeenCalled()
			}

			const entries = await Promise.all(children.map((child) => child.done))
			expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted"])
		})

		it("does not double-settle a child that resolves before the parent aborts", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			// Park the run so only the explicit resolve can settle the handle.
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId
			seedChildRecord(childId)

			provider.resolveBackgroundChild(childId, "done early")
			parent.emit(RooCodeEventName.TaskAborted)
			await flush()

			const entry = await children[0].done
			expect(entry.status).toBe("completed")
			expect(entry.result).toBe("done early")
		})
	})

	describe("terminal persistence drains and repair (CR round 5)", () => {
		it("dispose waits for a child's abort cascade already in progress before tearing down the history store", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const child = createdTasks()[0]

			// Hold the child's final save: the cascade below parks inside
			// `abortTask`, so disposal can only observe the child through
			// `pendingBackgroundChildCleanup`.
			let releaseSave!: () => void
			let saveEntered!: () => void
			const saveGate = new Promise<void>((resolve) => {
				releaseSave = resolve
			})
			const saveEnteredPromise = new Promise<void>((resolve) => {
				saveEntered = resolve
			})
			child.abortTask.mockImplementation(async () => {
				saveEntered()
				await saveGate
			})

			const cascade = provider.abortBackgroundChildren("parent-1")
			await saveEnteredPromise

			// dispose()'s own abort pass finds no records — the cascade already
			// settled them — so only the drain of `pendingBackgroundChildCleanup`
			// keeps the teardown ordered after the held final save.
			provider["taskRegistry"] = new TaskRegistry()
			const storeDispose = vi.spyOn(provider.taskHistoryStore, "dispose")
			let disposalSettled = false
			const disposal = provider.dispose().then(() => {
				disposalSettled = true
			})
			await flush()

			expect(disposalSettled).toBe(false)
			expect(storeDispose).not.toHaveBeenCalled()

			releaseSave()
			await cascade
			await disposal

			expect(storeDispose).toHaveBeenCalledTimes(1)
			const entry = await children[0].done
			expect(entry.status).toBe("aborted")
		})

		it("dispose waits for a child's in-flight terminal write before tearing down the history store", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId

			// Park the terminal write itself: settlement is synchronous, so the
			// record is gone while its history write is still in flight.
			const store = provider.taskHistoryStore
			const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
			let releaseWrite!: () => void
			const writeGate = new Promise<void>((resolve) => {
				releaseWrite = resolve
			})
			store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
				if (taskId === childId) {
					await writeGate
				}
				return originalReadAndUpdate(taskId, update)
			})

			provider.resolveBackgroundChild(childId, "done")
			await flush()

			provider["taskRegistry"] = new TaskRegistry()
			const storeDispose = vi.spyOn(provider.taskHistoryStore, "dispose")
			let disposalSettled = false
			const disposal = provider.dispose().then(() => {
				disposalSettled = true
			})
			await flush()

			expect(disposalSettled).toBe(false)
			expect(storeDispose).not.toHaveBeenCalled()

			releaseWrite()
			await disposal

			expect(storeDispose).toHaveBeenCalledTimes(1)
			expect(provider["pendingBackgroundTerminalWrites"].size).toBe(0)
			expect(storeState.items.get(childId)?.status).toBe("completed")
		})

		it("records an exhausted terminal write for repair, retries it on the next pass, and logs every failure", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId

			const store = provider.taskHistoryStore
			const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
			let childWritesFail = true
			store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
				if (taskId === childId && childWritesFail) {
					throw new Error("persistent store failure")
				}
				return originalReadAndUpdate(taskId, update)
			})

			provider.resolveBackgroundChild(childId, "done")
			// The bounded retry runs behind settlement (`delay` is mocked to an
			// immediate resolve), so a flush is enough for all three attempts to
			// fail and the repair to be recorded.
			await flush()

			// The write never landed: the row is still `active`, and the
			// exhausted write is recorded for the next repair pass instead of
			// being abandoned.
			expect(storeState.items.get(childId)?.status).toBe("active")
			expect(provider["pendingBackgroundTerminalRepairs"].get(childId)).toMatchObject({
				taskId: childId,
				status: "completed",
			})

			// Every attempt failed and the give-up is logged, never silent.
			const logs = vi.mocked(mockOutputChannel.appendLine).mock.calls.map((call) => String(call[0]))
			expect(
				logs.some((line) => line.includes(`Persisting terminal state for ${childId} failed (attempt 1/3)`)),
			).toBe(true)
			expect(
				logs.some((line) => line.includes(`Persisting terminal state for ${childId} failed (attempt 3/3)`)),
			).toBe(true)
			expect(logs.some((line) => line.includes(`Giving up persisting terminal state for ${childId}`))).toBe(true)

			// The store recovers; the next repair pass lands exactly the write
			// a first-attempt success would have made.
			childWritesFail = false
			await provider["flushPendingBackgroundTerminalRepairs"]()
			expect(storeState.items.get(childId)?.status).toBe("completed")
			expect(provider["pendingBackgroundTerminalRepairs"].size).toBe(0)
		})

		it("logs when the terminal write finds no history record", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")
			runTracker.block()

			const { children } = await spawn(provider, parent, [makeSpec("a")])
			const childId = children[0].taskId

			// The row disappears between registration and settlement (e.g. its
			// registration upsert kept failing); the skipped write must say so
			// instead of returning silently.
			storeState.items.delete(childId)

			provider.resolveBackgroundChild(childId, "done")
			await flush()

			const logs = vi.mocked(mockOutputChannel.appendLine).mock.calls.map((call) => String(call[0]))
			expect(
				logs.some((line) =>
					line.includes(`Not persisting terminal state for ${childId}: no history record exists`),
				),
			).toBe(true)
		})
	})

	describe("depth-1 guarantee and store wiring", () => {
		it("blocks parallel_subtasks for every child (structural depth-1)", async () => {
			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			await spawn(provider, parent, [makeSpec("a")])

			expect(BACKGROUND_CHILD_DISABLED_TOOLS).toContain("parallel_subtasks")
			const [child] = createdTasks()
			expect(child.backgroundToolPolicy?.disabledTools).toContain("parallel_subtasks")
		})

		it("exposes the live background map through isLiveBackgroundChild", async () => {
			const options = storeState.constructorOptions[0] as
				{ isLiveBackgroundChild?: (taskId: string) => boolean } | undefined
			expect(options?.isLiveBackgroundChild).toBeTypeOf("function")

			const parent = new FakeParentTask("parent-1")
			seedRegistry(provider, parent)
			seedParentRecord("parent-1")

			const { children } = await spawn(provider, parent, [makeSpec("a")])

			expect(options?.isLiveBackgroundChild?.(children[0].taskId)).toBe(true)
			expect(options?.isLiveBackgroundChild?.("some-other-task")).toBe(false)
		})
	})
})

function seedChildRecord(childTaskId: string): void {
	storeState.items.set(childTaskId, {
		id: childTaskId,
		number: 2,
		ts: 2,
		task: "Child task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		backgroundParentTaskId: "parent-1",
	})
}
