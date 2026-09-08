// Regression tests for the eager `markLocallyActive` claim in
// ClineProvider.createTaskWithHistoryItemUnlocked and its rollback on every
// path that does not reach a scheduled run (CodeRabbit round-3 Finding B/E).
//
// npx vitest run core/webview/__tests__/ClineProvider.markLocallyActive.spec.ts
//
// Test-double pattern mirrors src/__tests__/single-open-invariant.spec.ts:
// a plain provider object + the real prototype methods, so the actual
// createTaskWithHistoryItemUnlocked wiring (claim → branch → release) is
// exercised without a VS Code host.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

import { ClineProvider } from "../ClineProvider"
import { TaskRegistry } from "../../task/TaskRegistry"
import { type Task } from "../../task/Task"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

type HistoryItemLike = Parameters<ClineProvider["createTaskWithHistoryItem"]>[0]

type PrivateClineProviderMethods = {
	createTaskWithHistoryItem: (
		this: unknown,
		historyItem: HistoryItemLike,
		options?: { startTask?: boolean },
	) => ReturnType<ClineProvider["createTaskWithHistoryItem"]>
}

const privateClineProvider = ClineProvider.prototype as unknown as PrivateClineProviderMethods

vi.mock("../../task/Task", () => {
	// The id must come from the history item so claim/release target the exact
	// created task; the stub only implements the surface the provider touches.
	class TaskStub {
		public taskId: string
		public instanceId = "stub-inst"
		public parentTask?: unknown
		public abort = false
		public abandoned = false
		public abortTask = vi.fn().mockResolvedValue(undefined)
		constructor(opts: { historyItem?: { id: string }; onCreated?: (t: TaskStub) => void }) {
			this.taskId = opts.historyItem?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`
			opts.onCreated?.(this)
		}
		run() {
			return Promise.resolve()
		}
		on() {}
		off() {}
		emit() {}
	}
	return { Task: TaskStub }
})

type MockFn = ReturnType<typeof vi.fn>

type OwnershipStore = {
	get: (id: string) => unknown
	markLocallyActive: MockFn
	markLocallyInactive: MockFn
}

type ProviderStubObject = {
	historyTaskCreationQueue: Promise<void>
	getCurrentTask: MockFn
	taskRegistry: TaskRegistry
	taskHistoryStore: OwnershipStore
	evictCurrentTask: MockFn
	removeClineFromStack: MockFn
	addClineToStack: MockFn
	performPreparationTasks: MockFn
	taskScheduler: { schedule: MockFn }
	taskEventListeners: Map<unknown, Array<() => void>>
	log: MockFn
	customModesManager: { getCustomModes: MockFn }
	providerSettingsManager: { getModeConfigId: MockFn; listConfig: MockFn }
	getState: MockFn
	getPendingEditOperation: MockFn
	clearPendingEditOperation: MockFn
	postStateToWebview: MockFn
	context: Record<string, unknown>
	contextProxy: Record<string, unknown>
}

function makeStore(): OwnershipStore {
	return {
		get: vi.fn(() => undefined),
		markLocallyActive: vi.fn(),
		markLocallyInactive: vi.fn(),
	}
}

function makeProvider(store: OwnershipStore, overrides: Partial<ProviderStubObject> = {}): ProviderStubObject {
	const registry = new TaskRegistry()
	return {
		historyTaskCreationQueue: Promise.resolve(),
		getCurrentTask: vi.fn(() => registry.current),
		taskRegistry: registry,
		taskHistoryStore: store,
		evictCurrentTask: vi.fn().mockResolvedValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		addClineToStack: vi.fn().mockResolvedValue(undefined),
		performPreparationTasks: vi.fn().mockResolvedValue(undefined),
		taskScheduler: { schedule: vi.fn().mockResolvedValue(undefined) },
		taskEventListeners: new Map(),
		log: vi.fn(),
		customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
		providerSettingsManager: {
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			listConfig: vi.fn().mockResolvedValue([]),
		},
		getState: vi.fn().mockResolvedValue({
			apiConfiguration: { apiProvider: providerIdentifiers.anthropic, consecutiveMistakeLimit: 0 },
			enableCheckpoints: true,
			checkpointTimeout: 60,
			experiments: {},
			cloudUserInfo: null,
			taskSyncEnabled: false,
		}),
		getPendingEditOperation: vi.fn().mockReturnValue(undefined),
		clearPendingEditOperation: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
		contextProxy: {
			extensionUri: {},
			getValue: vi.fn(),
			setValue: vi.fn(),
			setProviderSettings: vi.fn(),
			getProviderSettings: vi.fn(() => ({})),
		},
		...overrides,
	}
}

function makeHistoryItem(id: string): HistoryItemLike {
	return {
		id,
		number: 1,
		ts: Date.now(),
		task: "test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/tmp",
	}
}

/** Seed a registry with a current task whose id matches `historyId` (rehydrate case). */
function makeRehydrateProvider(store: OwnershipStore, historyId: string, overrides: Partial<ProviderStubObject> = {}) {
	const existing = {
		taskId: historyId,
		instanceId: "old-inst",
		abort: false,
		abandoned: false,
		abortTask: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
	}
	const registry = new TaskRegistry()
	registry.push(existing as unknown as Task)
	return makeProvider(store, { getCurrentTask: vi.fn(() => existing), taskRegistry: registry, ...overrides })
}

async function flushMicrotasks(): Promise<void> {
	// scheduleTask's failure hook runs on the rejection microtask chain of a
	// fire-and-forget promise; drain it before asserting non-invocations.
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

describe("ClineProvider createTaskWithHistoryItem ownership claim/rollback", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		// scheduleTask keeps logging scheduler rejections via console.error; the
		// rejection tests exercise that path on purpose.
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
	})

	it("Finding E wiring: claims ownership for the created task id on the success path and never releases it before the run", async () => {
		// Removing the markLocallyActive(task.taskId) call from
		// createTaskWithHistoryItemUnlocked must fail THIS test — that is the
		// provider-wiring assertion CodeRabbit asked for.
		const store = makeStore()
		const provider = makeProvider(store)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-success"),
		)

		expect(task.taskId).toBe("hist-success")
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-success")
		await flushMicrotasks()
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)
	})

	it("claims ownership on the in-place rehydrate success path without releasing it", async () => {
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-rehydrate-ok")

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-rehydrate-ok"),
		)

		expect(task.taskId).toBe("hist-rehydrate-ok")
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-rehydrate-ok")
		await flushMicrotasks()
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)
	})

	it("releases the claim when preparation fails on the rehydrate path and rethrows", async () => {
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-prep-fail", {
			performPreparationTasks: vi.fn().mockRejectedValue(new Error("prep exploded")),
		})

		await expect(
			privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-prep-fail")),
		).rejects.toThrow("prep exploded")

		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-prep-fail")
		expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-prep-fail")
		expect(provider.taskScheduler.schedule).not.toHaveBeenCalled()
	})

	it("releases the claim when addClineToStack fails on the stack path and rethrows", async () => {
		const store = makeStore()
		const provider = makeProvider(store, {
			addClineToStack: vi.fn().mockRejectedValue(new Error("stack exploded")),
		})

		await expect(
			privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-stack-fail")),
		).rejects.toThrow("stack exploded")

		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-stack-fail")
		expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-stack-fail")
		expect(provider.taskScheduler.schedule).not.toHaveBeenCalled()
	})

	it("releases the claim when the scheduler rejects the run (stack path)", async () => {
		const store = makeStore()
		const provider = makeProvider(store, {
			taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
		})

		// The provider call itself still resolves — scheduleTask is
		// fire-and-forget — so the rollback must arrive via the failure hook.
		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-sched-fail"),
		)
		expect(task.taskId).toBe("hist-sched-fail")
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-sched-fail")

		await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-sched-fail"))
	})

	it("releases the claim when the scheduler rejects the run (rehydrate path)", async () => {
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-sched-fail-re", {
			taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
		})

		await privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-sched-fail-re"))

		await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-sched-fail-re"))
	})

	it("keeps the claim when startTask is false: the installed task starts via a later explicit path, not the scheduler", async () => {
		// The only production caller that passes startTask:false is
		// reopenParentFromDelegation (ClineProvider.ts step 7): the parent's
		// `active` history write during the delegation transition already
		// re-registered ownership via trackLocalSessionOwnership, and the caller
		// immediately runs the installed task through Task.resumeAfterDelegation()
		// — which persists active status itself. Releasing here would reopen the
		// crash-orphan window the eager claim exists to close, so the contract is
		// "retain the claim when scheduling is skipped" — this test locks it in.
		const store = makeStore()
		const provider = makeProvider(store)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-nostart"),
			{
				startTask: false,
			},
		)

		expect(task.taskId).toBe("hist-nostart")
		expect(provider.taskScheduler.schedule).not.toHaveBeenCalled()
		await flushMicrotasks()
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-nostart")
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
	})
})
