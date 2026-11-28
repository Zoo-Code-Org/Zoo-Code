// pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.backgroundSpawnCancellation.spec.ts

import EventEmitter from "events"

import { WebviewFocusTracker } from "../WebviewFocusTracker"
import * as vscode from "vscode"
import type { HistoryItem, ProviderSettings } from "@roo-code/types"
import { ORGANIZATION_ALLOW_ALL, providerIdentifiers, RooCodeEventName } from "@roo-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import { TaskRegistry } from "../../task/TaskRegistry"
import { Task } from "../../task/Task"
import { ProfileValidator } from "../../../shared/ProfileValidator"
import type { BackgroundChildHandle, BackgroundSubtaskSpec } from "../../background-subtasks/types"
import { ClineProvider } from "../ClineProvider"

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
 * writes are observable.
 */
const storeState = vi.hoisted(() => ({
	items: new Map<string, HistoryItem>(),
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
// `historyItem`, or `rootTask` (in that order). It deliberately does not call
// `onCreated`; no assertion depends on provider listeners being wired for a
// child in these tests.
vi.mock("../../task/Task", () => {
	class MockTask {
		taskId: string
		instanceId = "mock-instance"
		rootTaskId?: string
		parentTaskId?: string
		taskNumber: number
		metadata: { task?: string }
		cwd = "/test/workspace"
		workspacePath = "/test/workspace"
		apiConfiguration: unknown
		handoffExecutionContext?: MockTaskConstructorOptions["handoffExecutionContext"]
		backgroundToolPolicy?: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> }
		isBackgroundSubtaskChild: boolean
		abort = false
		abandoned = false
		// EventEmitter gives once() real Node semantics — the listener is
		// removed before it runs — matching Task's production emitter.
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
			this.taskId = options.historyItem?.id ?? options.taskId ?? `mock-task-${taskState.created.length + 1}`
			this.rootTaskId =
				options.rootTaskId ?? (options.historyItem ? options.historyItem.rootTaskId : options.rootTask?.taskId)
			this.parentTaskId = options.historyItem ? options.historyItem.parentTaskId : options.parentTask?.taskId
			this.taskNumber = options.taskNumber ?? options.historyItem?.number ?? -1
			this.metadata = { task: options.task }
			this.apiConfiguration = options.apiConfiguration
			this.handoffExecutionContext = options.handoffExecutionContext
			this.backgroundToolPolicy = options.backgroundToolPolicy
			this.isBackgroundSubtaskChild = options.backgroundChildHosted === true
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
			dispose: vi.fn(),
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
		TaskHistoryStore: vi.fn().mockImplementation(function (_path: string, _options?: unknown) {
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
	taskNumber: number
	isBackgroundSubtaskChild: boolean
	handoffExecutionContext?: MockTaskConstructorOptions["handoffExecutionContext"]
	backgroundToolPolicy?: { disabledTools?: readonly string[]; experiments?: Record<string, boolean> }
	run: ReturnType<typeof vi.fn>
	abortTask: ReturnType<typeof vi.fn>
	dispose: ReturnType<typeof vi.fn>
	emit: ReturnType<typeof vi.fn>
	once: ReturnType<typeof vi.fn>
	off: ReturnType<typeof vi.fn>
}

function createdTasks(): MockTaskInstance[] {
	return taskState.created as MockTaskInstance[]
}

/**
 * Minimal stand-in for the members `spawnBackgroundChildren` reads from a parent
 * task: identity, lineage, mode/profile accessors, the synchronous `abort`
 * flag (`abortTask()` flips it synchronously on the real Task), and the
 * TaskAborted emitter.
 */
class FakeParentTask {
	// EventEmitter gives once() real Node semantics — the listener is removed
	// before it runs — so abort-hook tests can tell when the provider retains
	// a hook record after the once has already been consumed.
	private readonly emitter = new EventEmitter()
	readonly instanceId = "parent-instance"
	readonly apiConfiguration: ProviderSettings = apiConfig
	// Mirrors Task's synchronous abort flag (ClineProvider reads it in
	// `isBackgroundSpawnParentActive`), so a pre-cancelled parent can be
	// simulated without emitting the event.
	abort = false
	dispose = vi.fn().mockResolvedValue(undefined)
	abortTask = vi.fn(async () => {
		this.abort = true
		this.emit(RooCodeEventName.TaskAborted)
	})
	flushPendingToolResultsToHistory = vi.fn().mockResolvedValue(true)

	constructor(
		readonly taskId: string,
		readonly rootTaskId?: string,
		// `Task` retains this reference after the stack pops that delegation
		// performs; every production lineage walk relies on it.
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

	on(event: string, listener: (...args: unknown[]) => void): void {
		this.emitter.on(event, listener)
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

describe("ClineProvider background spawn admission gate (CR finding 1 residual)", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()
		taskState.created.length = 0
		runTracker.reset()
		storeState.items.clear()

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

	it("admits no construction work when the parent is already cancelled", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")
		// `abortTask()` flips this synchronously on the real Task, so a spawn
		// that starts after the cancellation observes it before any work.
		parent.abort = true

		const result = await spawn(provider, parent, [makeSpec("a"), makeSpec("b"), makeSpec("c")])

		// The pre-admission gate must stop every spec from being constructed:
		// no task, no run, no published record.
		expect(createdTasks()).toHaveLength(0)
		expect(runTracker.state.started).toBe(0)
		expect(provider["backgroundTasks"].size).toBe(0)
		expect(result.started).toBe(false)

		// Callers receive exactly one settleable handle per requested spec.
		expect(result.children).toHaveLength(3)
		const entries = await Promise.all(result.children.map((child) => child.done))
		expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted", "aborted"])
		expect(entries.every((entry) => entry.error === "Parent task was cancelled")).toBe(true)

		// The synthetic ids never reach persistence: `cancelledBackgroundHandle`
		// writes no history row, and the store still holds only the seeded
		// parent record. Locks the "writes nothing" contract.
		expect(storeState.items.size).toBe(1)
		for (const entry of entries) {
			expect(storeState.items.get(entry.taskId)).toBeUndefined()
		}
	})

	it("admits no construction work after the provider was disposed", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		await provider.dispose()

		const result = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])

		expect(createdTasks()).toHaveLength(0)
		expect(runTracker.state.started).toBe(0)
		expect(provider["backgroundTasks"].size).toBe(0)
		expect(result.started).toBe(false)

		expect(result.children).toHaveLength(2)
		const entries = await Promise.all(result.children.map((child) => child.done))
		expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted"])
		expect(entries.every((entry) => entry.error === "Provider disposed")).toBe(true)
	})

	it("does not construct the specs queued behind a parent cancelled mid-batch", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		// Park the FIRST spec's `createTask`; cancel the parent while it is
		// in flight, then release it.
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

		const spawnPromise = spawn(provider, parent, [makeSpec("a"), makeSpec("b"), makeSpec("c")])
		await createEntered
		parent.emit(RooCodeEventName.TaskAborted)
		releaseCreate()
		const result = await spawnPromise

		// Spec "a" was in flight when the cancellation landed: it was
		// constructed, then settled and disposed without scheduling.
		expect(createdTasks()).toHaveLength(1)
		expect(createdTasks()[0].dispose).toHaveBeenCalled()

		// Specs "b" and "c" were never admitted: no construction at all, so
		// there was also nothing to dispose for them.
		expect(runTracker.state.started).toBe(0)
		expect(provider["backgroundTasks"].size).toBe(0)
		expect(result.started).toBe(false)

		// One handle per spec, all settled aborted.
		expect(result.children).toHaveLength(3)
		const entries = await Promise.all(result.children.map((child) => child.done))
		expect(entries.map((entry) => entry.status)).toEqual(["aborted", "aborted", "aborted"])
		expect(entries.every((entry) => entry.error === "Parent task was cancelled")).toBe(true)
		// The unadmitted handles carry synthetic ids, not constructed task ids.
		expect(entries.slice(1).map((entry) => entry.taskId)).not.toContain(createdTasks()[0].taskId)
	})

	it("retries the terminal write when cancelling during registration makes it fail (CR round 3)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		// Park the registration's parent write so the parent is cancelled while
		// the child's history row is being registered: the post-registration
		// parent check then settles the child without scheduling it. The first
		// terminal write for the child then fails transiently — without the
		// bounded retry the row would stay `active` forever, and startup
		// reconciliation skips a child whose parent is still active/delegated.
		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let releaseRegistration!: () => void
		const registrationGate = new Promise<void>((resolve) => {
			releaseRegistration = resolve
		})
		let enteredRegistration!: () => void
		const registrationEntered = new Promise<void>((resolve) => {
			enteredRegistration = resolve
		})
		let failFirstTerminalWrite = true
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-1") {
				enteredRegistration()
				await registrationGate
			} else if (failFirstTerminalWrite) {
				failFirstTerminalWrite = false
				throw new Error("transient store failure")
			}
			return originalReadAndUpdate(taskId, update)
		})

		const spawnPromise = spawn(provider, parent, [makeSpec("a")])
		await registrationEntered
		await parent.abortTask()
		releaseRegistration()
		const result = await spawnPromise

		// The child was settled unscheduled, exactly like the mid-batch case.
		expect(result.children).toHaveLength(1)
		const [entry] = await Promise.all(result.children.map((child) => child.done))
		expect(entry.status).toBe("aborted")
		expect(entry.error).toBe("Parent task was cancelled")
		expect(runTracker.state.started).toBe(0)
		expect(provider["backgroundTasks"].size).toBe(0)
		const childId = createdTasks()[0].taskId

		// The transient failure must not strand the child on `active`: the
		// bounded retry lands the terminal `interrupted` write.
		await vi.waitFor(
			() => {
				expect(storeState.items.get(childId)?.status).toBe("interrupted")
			},
			{ timeout: 2000, interval: 10 },
		)
		const childWriteCalls = vi.mocked(store.atomicReadAndUpdate).mock.calls.filter(([id]) => id === childId)
		expect(childWriteCalls.length).toBeGreaterThanOrEqual(2)
	})

	it("keeps the abort hook released when nothing was ever scheduled", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")
		parent.abort = true

		await spawn(provider, parent, [makeSpec("a")])

		// The finally block must not leave a listener behind on the parent.
		expect(parent.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		expect(provider["backgroundAbortHooks"].size).toBe(0)
	})
})

describe("ClineProvider mode-config id lookup fallback (CR finding 3)", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()
		taskState.created.length = 0
		runTracker.reset()
		storeState.items.clear()

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
			mode: "code",
		})
	})

	afterEach(async () => {
		runTracker.releaseAll()
		await provider.dispose()
		vi.restoreAllMocks()
	})

	it("a rejecting mode-config lookup degrades to the parent configuration without exiting the batch", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")
		provider["getModeConfigId"] = vi.fn(async (mode: string) => {
			if (mode === "architect") {
				throw new Error("settings store unavailable")
			}
			return undefined
		})

		// `a` shares the parent's mode (no lookup); `b`/`c` use a mode whose
		// saved-profile lookup rejects while `a` is already constructed.
		const result = await spawn(provider, parent, [
			makeSpec("a", "code"),
			makeSpec("b", "architect"),
			makeSpec("c", "architect"),
		])

		// The rejection must not escape the spawn loop: every spec is admitted,
		// constructed, and scheduled.
		expect(result.children).toHaveLength(3)
		expect(createdTasks()).toHaveLength(3)
		expect(result.started).toBe(true)
		await flush()
		expect(runTracker.state.started).toBe(3)

		// The failing lookup falls back to the parent task configuration.
		for (const child of createdTasks().slice(1)) {
			expect(child.handoffExecutionContext?.mode).toBe("architect")
			expect(child.handoffExecutionContext?.apiConfigName).toBe("default-profile")
			expect(child.handoffExecutionContext?.apiConfiguration).toEqual(apiConfig)
		}

		const entries = await Promise.all(result.children.map((child) => child.done))
		expect(entries).toHaveLength(3)
		expect(provider["backgroundTasks"].size).toBe(0)
	})
})

describe("ClineProvider background child deletion and parent-link durability (CR findings axIE/axIR/axHd)", () => {
	let provider: ClineProvider
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		vi.clearAllMocks()
		taskState.created.length = 0
		runTracker.reset()
		storeState.items.clear()

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
			mode: "code",
		})
		provider["getModeConfigId"] = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(async () => {
		runTracker.releaseAll()
		await provider.dispose()
		vi.restoreAllMocks()
	})

	it("has deletion await a child whose abort cascade cleanup is still pending (CR axIE)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		runTracker.block()
		const result = await spawn(provider, parent, [makeSpec("a")])
		expect(result.started).toBe(true)
		const childId = result.children[0].taskId

		// Park the child's abort and disposal the way a final message save and
		// resource teardown do in production.
		const child = createdTasks()[0]
		let releaseAbort!: () => void
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve
		})
		let abortEntered!: () => void
		const abortEnteredPromise = new Promise<void>((resolve) => {
			abortEntered = resolve
		})
		child.abortTask.mockImplementation(async () => {
			abortEntered()
			await abortGate
		})
		let releaseDispose!: () => void
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve
		})
		child.dispose.mockImplementation(async () => {
			await disposeGate
		})

		// The parent's abort cascade settles the record (removing it from
		// `backgroundTasks`) and then parks inside `abortTask()`.
		try {
			const cascade = provider.abortBackgroundChildren("parent-1")
			await abortEnteredPromise
			expect(provider["backgroundTasks"].size).toBe(0)

			// Deletion reaches the lookup after the cascade removed the record: it
			// must still wait for the pending abort AND disposal drain.
			let deletionSettled = false
			const deletion = provider["stopBackgroundChildrenBeingDeleted"]([childId]).then(() => {
				deletionSettled = true
			})
			await flush()
			expect(deletionSettled).toBe(false)

			releaseAbort()
			await flush()
			expect(deletionSettled).toBe(false)

			releaseDispose()
			await deletion
			expect(deletionSettled).toBe(true)
			await cascade
		} finally {
			// A failed assertion above must not leave these gates closed: afterEach
			// awaits provider.dispose(), which waits on the same parked child
			// cleanup. Promise resolves are idempotent, so the staged releases on
			// the success path stay as-is.
			releaseAbort()
			releaseDispose()
		}
	})

	it("does not let deletion wait for a selected child's unselected sibling (CR axIE)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		runTracker.block()
		const result = await spawn(provider, parent, [makeSpec("a"), makeSpec("b")])
		expect(result.started).toBe(true)
		const [selectedId, siblingId] = result.children.map((child) => child.taskId)

		const gates = new Map<string, { release: () => void; entered: Promise<void> }>()
		for (const task of createdTasks()) {
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			let entered!: () => void
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve
			})
			gates.set(task.taskId, { release, entered: enteredPromise })
			task.abortTask.mockImplementation(async () => {
				entered()
				await gate
			})
		}

		try {
			const cascade = provider.abortBackgroundChildren("parent-1")
			await Promise.all([gates.get(selectedId)!.entered, gates.get(siblingId)!.entered])

			let deletionSettled = false
			const deletion = provider["stopBackgroundChildrenBeingDeleted"]([selectedId]).then(() => {
				deletionSettled = true
			})
			await flush()
			expect(deletionSettled).toBe(false)

			// Releasing only the selected child's cleanup must settle the deletion;
			// the unselected sibling stays parked and must not stall it.
			gates.get(selectedId)!.release()
			await deletion
			expect(deletionSettled).toBe(true)

			gates.get(siblingId)!.release()
			await cascade
		} finally {
			// Keep every gate openable on the failure path too: afterEach disposes
			// the provider, which drains the parked child cleanup behind these
			// gates. Resolving twice is a no-op.
			for (const gate of gates.values()) {
				gate.release()
			}
		}
	})

	it("retries the parent childIds write when registration hits a transient store failure (CR axIR)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let parentWriteFailures = 0
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-1" && parentWriteFailures < 2) {
				parentWriteFailures++
				throw new Error("transient store failure")
			}
			return originalReadAndUpdate(taskId, update)
		})

		const result = await spawn(provider, parent, [makeSpec("a")])
		expect(result.started).toBe(true)
		const childId = result.children[0].taskId

		// The parent link must be durable once the child counts as registered:
		// the bounded retry lands it instead of leaving the stamped child out
		// of the parent's `childIds`.
		expect(storeState.items.get("parent-1")?.childIds).toContain(childId)
		expect(storeState.items.get(childId)?.backgroundParentTaskId).toBe("parent-1")
		expect(provider["pendingBackgroundParentLinks"].size).toBe(0)
	})

	it("records a pending parent link that keeps failing and repairs it on the next pass (CR axIR)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let parentWritesFail = true
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-1" && parentWritesFail) {
				throw new Error("persistent store failure")
			}
			return originalReadAndUpdate(taskId, update)
		})

		runTracker.block()
		const result = await spawn(provider, parent, [makeSpec("a")])
		expect(result.started).toBe(true)
		const childId = result.children[0].taskId

		// The link did not land, but it is recorded for repair; the child is
		// still stamped so startup orphan cleanup keeps working.
		expect(storeState.items.get("parent-1")?.childIds).not.toContain(childId)
		expect(provider["pendingBackgroundParentLinks"].get(childId)).toBe("parent-1")
		expect(storeState.items.get(childId)?.backgroundParentTaskId).toBe("parent-1")

		// The store recovers; the next repair pass completes the link.
		parentWritesFail = false
		await provider["flushPendingBackgroundParentLinks"]()
		expect(storeState.items.get("parent-1")?.childIds).toContain(childId)
		expect(provider["pendingBackgroundParentLinks"].size).toBe(0)
	})

	it("repairs a pending parent link before the delete cascade collects childIds (CR axIR)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let parentWritesFail = true
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-1" && parentWritesFail) {
				throw new Error("persistent store failure")
			}
			return originalReadAndUpdate(taskId, update)
		})
		store.deleteMany = vi.fn(async (ids: string[]) => {
			for (const id of ids) {
				storeState.items.delete(id)
			}
		})

		runTracker.block()
		const result = await spawn(provider, parent, [makeSpec("a")])
		const childId = result.children[0].taskId
		expect(provider["pendingBackgroundParentLinks"].get(childId)).toBe("parent-1")

		// The store recovers before the user deletes the parent: the deletion's
		// repair pass must bring the child into the cascade, so its history row
		// and directory are removed with the parent's.
		parentWritesFail = false
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		await provider.deleteTaskWithId("parent-1")

		expect(store.deleteMany).toHaveBeenCalledWith(expect.arrayContaining(["parent-1", childId]))
		expect(storeState.items.get("parent-1")).toBeUndefined()
		expect(storeState.items.get(childId)).toBeUndefined()
	})

	it("closes admission and drains in-flight registrations before the delete cascade collects childIds (CR round 5)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let blockParentLinkWrites = false
		let linkEntered!: () => void
		let releaseLink!: () => void
		const linkEnteredPromise = new Promise<void>((resolve) => {
			linkEntered = resolve
		})
		const linkGate = new Promise<void>((resolve) => {
			releaseLink = resolve
		})
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-1" && blockParentLinkWrites) {
				linkEntered()
				await linkGate
			}
			return originalReadAndUpdate(taskId, update)
		})
		store.deleteMany = vi.fn(async (ids: string[]) => {
			for (const id of ids) {
				storeState.items.delete(id)
			}
		})

		// First child registers normally.
		runTracker.block()
		const first = await spawn(provider, parent, [makeSpec("a")])
		const childA = first.children[0].taskId

		// Second spawn parks inside its parent-link write: its registration is
		// in progress when deletion starts.
		try {
			blockParentLinkWrites = true
			const second = spawn(provider, parent, [makeSpec("b")])
			await linkEnteredPromise
			const childB = createdTasks()[1].taskId

			provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)

			const deletion = provider.deleteTaskWithId("parent-1")
			await flush()

			// The registration drain holds deletion before any history removal.
			expect(store.deleteMany).not.toHaveBeenCalled()

			// A spawn admitted after deletion started is refused outright.
			const late = await spawn(provider, parent, [makeSpec("c")])
			expect(late.started).toBe(false)
			expect((await late.children[0].done).status).toBe("aborted")
			expect(provider["backgroundTasks"].size).toBe(1)

			// Registration lands mid-delete; the cascade below must now see the
			// link and take the second child with the parent.
			releaseLink()
			await second
			await deletion

			expect(store.deleteMany).toHaveBeenCalledWith(expect.arrayContaining(["parent-1", childA, childB]))
			expect(storeState.items.size).toBe(0)
			expect(provider["backgroundTasks"].size).toBe(0)
		} finally {
			// A failed assertion must not leave the in-flight registration parked:
			// the suite teardown only releases the run tracker, not this gate.
			releaseLink()
		}
	})

	it("closes admission and drains registrations for each descendant before reading its childIds (CR F-1)", async () => {
		const parent = new FakeParentTask("parent-1")
		const descendant = new FakeParentTask("desc-1")
		seedRegistry(provider, parent, descendant)
		seedParentRecord("parent-1", { childIds: ["desc-1"] })
		seedParentRecord("desc-1")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let blockDescendantLinkWrites = false
		let releaseLink!: () => void
		const linkGate = new Promise<void>((resolve) => {
			releaseLink = resolve
		})
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "desc-1" && blockDescendantLinkWrites) {
				await linkGate
			}
			return originalReadAndUpdate(taskId, update)
		})
		store.deleteMany = vi.fn(async (ids: string[]) => {
			for (const id of ids) {
				storeState.items.delete(id)
			}
		})

		// Mirror the file-backed store: a read snapshots the record when it
		// runs, so a link write that lands after the read began is not part of
		// the returned item. Signal the moment the collector reads `desc-1`.
		const originalGet = store.get.bind(store)
		let readEntered!: () => void
		const readEnteredPromise = new Promise<void>((resolve) => {
			readEntered = resolve
		})
		store.get = vi.fn((taskId: string) => {
			const item = originalGet(taskId)
			if (taskId !== "desc-1" || !item) {
				return item
			}
			readEntered()
			return { ...item, childIds: item.childIds ? [...item.childIds] : item.childIds }
		})

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)

		try {
			runTracker.block()
			blockDescendantLinkWrites = true
			const deletion = provider.deleteTaskWithId("parent-1")
			await readEnteredPromise

			// The descendant's record has been read (a snapshot without any new
			// link); its admission gate must already be closed, so a spawn that
			// starts now is refused outright instead of registering a
			// grandchild whose link would escape the collector's snapshot.
			const midDeletionSpawn = spawn(provider, descendant, [makeSpec("g")])
			await flush(10)
			expect(provider["backgroundAdmissionClosed"].has("desc-1")).toBe(true)

			releaseLink()
			const midResult = await midDeletionSpawn
			await deletion

			expect(midResult.started).toBe(false)
			expect((await midResult.children[0].done).status).toBe("aborted")
			expect(store.deleteMany).toHaveBeenCalledWith(["parent-1", "desc-1"])
			expect(storeState.items.size).toBe(0)
			expect(provider["backgroundTasks"].size).toBe(0)
		} finally {
			// A failed assertion must not leave a parked registration behind:
			// the suite teardown only releases the run tracker, not this gate.
			releaseLink()
		}
	})

	it("does not drain an unrelated parent's in-flight registration when deleting a task (CR F-2)", async () => {
		const parentA = new FakeParentTask("parent-a")
		seedRegistry(provider, parentA)
		seedParentRecord("parent-a")
		seedParentRecord("parent-b")

		const store = provider.taskHistoryStore
		const originalReadAndUpdate = store.atomicReadAndUpdate.bind(store)
		let blockParentALinkWrites = false
		let linkEntered!: () => void
		let releaseLink!: () => void
		const linkEnteredPromise = new Promise<void>((resolve) => {
			linkEntered = resolve
		})
		const linkGate = new Promise<void>((resolve) => {
			releaseLink = resolve
		})
		store.atomicReadAndUpdate = vi.fn(async (taskId: string, update: (item: HistoryItem) => HistoryItem) => {
			if (taskId === "parent-a" && blockParentALinkWrites) {
				linkEntered()
				await linkGate
			}
			return originalReadAndUpdate(taskId, update)
		})
		store.deleteMany = vi.fn(async (ids: string[]) => {
			for (const id of ids) {
				storeState.items.delete(id)
			}
		})

		runTracker.block()
		blockParentALinkWrites = true
		const spawnA = spawn(provider, parentA, [makeSpec("a")])
		await linkEnteredPromise

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const deletion = provider.deleteTaskWithId("parent-b", false)

		try {
			// The unrelated registration is still parked inside its parent-link
			// write, yet the deletion of parent-b must reach deleteMany without
			// waiting for it, and no link may have been written for parent-a.
			await flush(10)
			expect(store.deleteMany).toHaveBeenCalledWith(["parent-b"])
			expect(storeState.items.get("parent-a")?.childIds ?? []).toHaveLength(0)
		} finally {
			releaseLink()
		}

		await spawnA
		await deletion
		expect(storeState.items.get("parent-b")).toBeUndefined()
	})

	it("removes exactly the abort-hook listener and keeps unrelated listeners (CR axHd)", async () => {
		const parent = new FakeParentTask("parent-1")
		seedRegistry(provider, parent)
		seedParentRecord("parent-1")

		const onceSpy = vi.spyOn(parent, "once")
		const offSpy = vi.spyOn(parent, "off")
		const unrelated = vi.fn()
		parent.on(RooCodeEventName.TaskAborted, unrelated)

		runTracker.block()
		const result = await spawn(provider, parent, [makeSpec("a")])
		parent.emit(RooCodeEventName.TaskAborted)
		await Promise.all(result.children.map((child) => child.done))

		await vi.waitFor(
			() => {
				expect(offSpy).toHaveBeenCalled()
			},
			{ timeout: 2000, interval: 10 },
		)

		// The same function reference that `once` received must be the one
		// passed to `off`: an implementation that drops every TaskAborted
		// listener (e.g. `off(event)` without the listener) would pass an
		// expect.any(Function) assertion but must fail here.
		const onceCalls = onceSpy.mock.calls.filter(([event]) => event === RooCodeEventName.TaskAborted)
		expect(onceCalls).toHaveLength(1)
		const [registeredEvent, registeredListener] = onceCalls[0]
		expect(offSpy).toHaveBeenCalledWith(registeredEvent, registeredListener)

		// The unrelated listener survives the hook release and still fires on
		// the next abort (it also observed the first one, before the release).
		expect(parent.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)
		const callsBefore = unrelated.mock.calls.length
		parent.emit(RooCodeEventName.TaskAborted)
		expect(unrelated.mock.calls.length).toBe(callsBefore + 1)
		expect(provider["backgroundAbortHooks"].size).toBe(0)
	})
})
