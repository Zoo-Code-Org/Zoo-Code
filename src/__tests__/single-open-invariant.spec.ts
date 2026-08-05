// npx vitest run __tests__/single-open-invariant.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { type OutputChannel } from "vscode"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskRegistry } from "../core/task/TaskRegistry"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { type Task } from "../core/task/Task"
import { API } from "../extension/api"
import * as ProfileValidatorMod from "../shared/ProfileValidator"

type PrivateClineProviderMethods = {
	createTask: (
		this: unknown,
		text?: string,
		images?: string[],
		parentTask?: Task,
		options?: Parameters<ClineProvider["createTask"]>[3],
	) => ReturnType<ClineProvider["createTask"]>
	createTaskWithHistoryItem: (
		this: unknown,
		...args: Parameters<ClineProvider["createTaskWithHistoryItem"]>
	) => ReturnType<ClineProvider["createTaskWithHistoryItem"]>
	evictCurrentTask: (this: unknown) => ReturnType<ClineProvider["evictCurrentTask"]>
}

const privateClineProvider = ClineProvider.prototype as unknown as PrivateClineProviderMethods
const resolveRunOverrides = vi.fn(async (_overrides: unknown, apiConfiguration: unknown) => ({ apiConfiguration }))

// Mock Task class used by ClineProvider to avoid heavy startup
vi.mock("../core/task/Task", () => {
	class TaskStub {
		public taskId: string
		public instanceId = "inst"
		public parentTask?: unknown
		public apiConfiguration: unknown
		public rootTask?: unknown
		constructor(opts: {
			historyItem?: { id: string }
			parentTask?: unknown
			apiConfiguration?: unknown
			onCreated?: (t: TaskStub) => void
		}) {
			this.taskId = opts.historyItem?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`
			this.parentTask = opts.parentTask
			this.apiConfiguration = opts.apiConfiguration ?? { apiProvider: "anthropic" }
			opts.onCreated?.(this)
		}
		start() {}
		run() {
			return Promise.resolve()
		}
		on() {}
		off() {}
		emit() {}
	}
	return { Task: TaskStub }
})

describe("Single-open-task invariant", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("User-initiated create: closes existing before opening new", async () => {
		// Allow profile
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)

		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const addClineToStack = vi.fn().mockResolvedValue(undefined)
		const schedulespy = vi.fn().mockResolvedValue(undefined)

		const existingTask = { taskId: "existing-1", abort: false, abandoned: false }
		const registry = new TaskRegistry()
		registry.push(existingTask as unknown as Task)
		const provider = {
			resolveRunOverrides,
			taskRegistry: registry,
			taskScheduler: { schedule: schedulespy },
			getCurrentTask: vi.fn(() => existingTask),
			taskHistoryStore: { get: vi.fn(() => undefined) },
			markDelegatedChildInterrupted: vi.fn().mockResolvedValue(undefined),
			get evictCurrentTask() {
				return privateClineProvider.evictCurrentTask.bind(this)
			},
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				enableCheckpoints: true,
				checkpointTimeout: 60,
				cloudUserInfo: null,
			}),
			removeClineFromStack,
			addClineToStack,
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			getStateToPostToWebview: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as ClineProvider

		await privateClineProvider.createTask.call(provider, "New task")

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(addClineToStack).toHaveBeenCalledTimes(1)
		expect(schedulespy).toHaveBeenCalledTimes(1)
	})

	it("Subtask create: keeps existing task open when parentTask is provided", async () => {
		vi.spyOn(ProfileValidatorMod.ProfileValidator, "isProfileAllowed").mockReturnValue(true)

		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const addClineToStack = vi.fn().mockResolvedValue(undefined)
		const parentTask = { taskId: "parent-1", abort: false, abandoned: false }
		const registry2 = new TaskRegistry()
		registry2.push(parentTask as unknown as Task)

		const provider = {
			resolveRunOverrides,
			taskRegistry: registry2,
			taskScheduler: new TaskScheduler(),
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				organizationAllowList: "*",
				enableCheckpoints: true,
				checkpointTimeout: 60,
				cloudUserInfo: null,
			}),
			removeClineFromStack,
			addClineToStack,
			setProviderProfile: vi.fn(),
			log: vi.fn(),
			getStateToPostToWebview: vi.fn(),
			providerSettingsManager: { getModeConfigId: vi.fn(), listConfig: vi.fn() },
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			taskCreationCallback: vi.fn(),
			contextProxy: {
				extensionUri: {},
				setValue: vi.fn(),
				getValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
		} as unknown as ClineProvider

		await privateClineProvider.createTask.call(provider, "Subtask", undefined, parentTask as unknown as Task)

		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(addClineToStack).toHaveBeenCalledTimes(1)
	})

	it("History resume path always closes current before rehydration (non-rehydrating case)", async () => {
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const addClineToStack = vi.fn().mockResolvedValue(undefined)
		const updateGlobalState = vi.fn().mockResolvedValue(undefined)
		const schedulespy = vi.fn().mockResolvedValue(undefined)

		const provider = {
			resolveRunOverrides,
			getCurrentTask: vi.fn(() => undefined), // ensure not rehydrating
			taskHistoryStore: { get: vi.fn(() => undefined) },
			markDelegatedChildInterrupted: vi.fn().mockResolvedValue(undefined),
			get evictCurrentTask() {
				return privateClineProvider.evictCurrentTask.bind(this)
			},
			removeClineFromStack,
			addClineToStack,
			updateGlobalState,
			log: vi.fn(),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			},
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				enableCheckpoints: true,
				checkpointTimeout: 60,
				experiments: {},
				cloudUserInfo: null,
				taskSyncEnabled: false,
			}),
			// Methods used by createTaskWithHistoryItem for pending edit cleanup
			getPendingEditOperation: vi.fn().mockReturnValue(undefined),
			clearPendingEditOperation: vi.fn(),
			taskScheduler: { schedule: schedulespy },
			context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
			contextProxy: {
				extensionUri: {},
				getValue: vi.fn(),
				setValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
			postStateToWebview: vi.fn(),
		} as unknown as ClineProvider

		const historyItem = {
			id: "hist-1",
			number: 1,
			ts: Date.now(),
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/tmp",
		}

		const task = await privateClineProvider.createTaskWithHistoryItem.call(provider, historyItem)
		expect(task).toBeTruthy()
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(addClineToStack).toHaveBeenCalledTimes(1)
		expect(schedulespy).toHaveBeenCalledTimes(1)
	})

	it("History resume path wires scheduler in rehydrating (in-place) case", async () => {
		const schedulespy = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const historyId = "hist-rehydrate-1"

		const existingTask = {
			taskId: historyId,
			instanceId: "old-inst",
			abort: false,
			abandoned: false,
			abortTask: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
		}

		const registry = new TaskRegistry()
		registry.push(existingTask as unknown as Task)

		const provider = {
			resolveRunOverrides,
			getCurrentTask: vi.fn(() => existingTask),
			taskRegistry: registry,
			taskHistoryStore: { get: vi.fn(() => undefined) },
			markDelegatedChildInterrupted: vi.fn().mockResolvedValue(undefined),
			get evictCurrentTask() {
				return privateClineProvider.evictCurrentTask.bind(this)
			},
			removeClineFromStack,
			addClineToStack: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			},
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
				enableCheckpoints: true,
				checkpointTimeout: 60,
				experiments: {},
				cloudUserInfo: null,
				taskSyncEnabled: false,
			}),
			getPendingEditOperation: vi.fn().mockReturnValue(undefined),
			clearPendingEditOperation: vi.fn(),
			taskScheduler: { schedule: schedulespy },
			taskEventListeners: new WeakMap(),
			performPreparationTasks: vi.fn().mockResolvedValue(undefined),
			context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
			contextProxy: {
				extensionUri: {},
				getValue: vi.fn(),
				setValue: vi.fn(),
				setProviderSettings: vi.fn(),
				getProviderSettings: vi.fn(() => ({})),
			},
			postStateToWebview: vi.fn(),
		} as unknown as ClineProvider

		const historyItem = {
			id: historyId,
			number: 1,
			ts: Date.now(),
			task: "Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: "/tmp",
		}

		await privateClineProvider.createTaskWithHistoryItem.call(provider, historyItem)

		expect(schedulespy).toHaveBeenCalledTimes(1)
		// evictCurrentTask must NOT have been called — in-place replace, no stack pop
		expect(removeClineFromStack).not.toHaveBeenCalled()
	})

	it("IPC StartNewTask path closes current before new task", async () => {
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "ipc-1" })
		const provider = {
			context: {} as unknown,
			getCurrentTask: vi.fn(() => undefined),
			taskHistoryStore: { get: vi.fn(() => undefined) },
			markDelegatedChildInterrupted: vi.fn().mockResolvedValue(undefined),
			get evictCurrentTask() {
				return privateClineProvider.evictCurrentTask.bind(this)
			},
			removeClineFromStack,
			postStateToWebview: vi.fn(),
			postMessageToWebview: vi.fn(),
			createTask,
			getValues: vi.fn(() => ({})),
			providerSettingsManager: { saveConfig: vi.fn() },
			on: vi.fn((ev: unknown, cb: unknown) => {
				if (ev === "taskCreated") {
					// no-op for this test
				}
				return provider
			}),
		} as unknown as ClineProvider

		const output = { appendLine: vi.fn() } as unknown as OutputChannel
		const api = new API(output, provider, undefined, false)

		const taskId = await api.startNewTask({
			configuration: {},
			text: "hello",
			images: undefined,
			newTab: false,
		})

		expect(taskId).toBe("ipc-1")
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(createTask).toHaveBeenCalled()
	})
})
