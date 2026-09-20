// Regression tests for the eager `markLocallyActive` claim in
// ClineProvider.createTaskWithHistoryItemUnlocked and its rollback on every
// path that does not reach a scheduled run (CodeRabbit round-3 Finding B/E),
// plus the reopenParentFromDelegation continuation-scheduling paths where the
// parent is claimed through createTaskWithHistoryItem(startTask:false) but the
// scheduler never admits the resumed run (latest CodeRabbit review).
//
// npx vitest run core/webview/__tests__/ClineProvider.markLocallyActive.spec.ts
//
// Test-double pattern mirrors src/__tests__/single-open-invariant.spec.ts:
// a plain provider object + the real prototype methods, so the actual
// createTaskWithHistoryItemUnlocked wiring (claim → branch → release) is
// exercised without a VS Code host.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

import { RooCodeEventName } from "@roo-code/types"
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
	createTask: (
		this: unknown,
		text?: string,
		images?: string[],
		parentTask?: Task,
		options?: { startTask?: boolean },
	) => Promise<Task>
	runDelegationTransition: <T>(this: unknown, parentTaskId: string, fn: () => Promise<T>) => Promise<T>
	reopenParentFromDelegation: (
		this: unknown,
		params: {
			parentTaskId: string
			childTaskId: string
			completionResultSummary: string
			pendingActionId?: string
		},
	) => Promise<boolean>
}

const privateClineProvider = ClineProvider.prototype as unknown as PrivateClineProviderMethods

// Declared via `vi.hoisted` (not a plain module-scope class) so the class
// binding is initialized BEFORE the hoisted vi.mock factory runs — the mock
// factory executes while ClineProvider's imports resolve, so a normally
// declared class would still be in its temporal dead zone there. This also
// exposes the stub to tests for `toBeInstanceOf(TaskStub)` assertions.
const TaskStub = vi.hoisted(() => {
	// `vi` is not yet initialized at hoist time, so field initializer surfaces
	// that use vi.fn() are deferred to construction time (class fields run per
	// instance, well after vitest initializes the mock registry).
	class TaskStub {
		public taskId: string
		public instanceId = "stub-inst"
		public parentTask?: unknown
		public abort = false
		public abandoned = false
		public abortTask = vi.fn().mockResolvedValue(undefined)
		constructor(opts: { historyItem?: { id: string }; parentTask?: unknown; onCreated?: (t: TaskStub) => void }) {
			// The id must come from the history item so claim/release target the exact
			// created task; hookless createTask (no historyItem) gets a deterministic
			// sequential default id, so tests can assert the exact generated value.
			this.taskId = opts.historyItem?.id ?? `task-stub-${++TaskStub.instanceCount}`
			this.parentTask = opts.parentTask
			opts.onCreated?.(this)
		}
		run() {
			return Promise.resolve()
		}
		on() {}
		off() {}
		emit() {}
		// Surfaces used by reopenParentFromDelegation's step 8 + continuation body.
		public overwriteClineMessages = vi.fn().mockResolvedValue(undefined)
		public overwriteApiConversationHistory = vi.fn().mockResolvedValue(undefined)
		public resumeAfterDelegation = vi.fn().mockResolvedValue(undefined)
		public static instanceCount = 0
	}
	return TaskStub
})

vi.mock("../../task/Task", () => ({
	Task: TaskStub,
}))

// reopenParentFromDelegation reads/writes per-task message files through these
// module functions. Echo the passed messages back (production returns the
// saved array) so the continuation tests never touch the filesystem.
vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return {
		...mod,
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi
			.fn()
			.mockImplementation(({ messages }: { messages: unknown[] }) => Promise.resolve(messages)),
		saveTaskMessages: vi
			.fn()
			.mockImplementation(({ messages }: { messages: unknown[] }) => Promise.resolve(messages)),
	}
})
vi.mock("../../task-persistence/taskMessages", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence/taskMessages")>()
	return { ...mod, readTaskMessages: vi.fn().mockResolvedValue([]) }
})

type MockFn = ReturnType<typeof vi.fn>

// Narrow a `vi.fn()` dual (call-new) mock to its callable procedure shape for
// assertion sites; avoids `any` while keeping the mock identity intact.
function asCallable<T extends { new (...args: never[]): unknown }>(fn: T): T & ((...args: never[]) => unknown) {
	return fn as T & ((...args: never[]) => unknown)
}

type OwnershipStore = {
	get: (id: string) => unknown
	markLocallyActive: MockFn
	markLocallyInactive: MockFn
	invalidate: MockFn
	atomicUpdatePair: MockFn
}

type ProviderStubObject = {
	historyTaskCreationQueue: Promise<void>
	getCurrentTask: MockFn
	getTaskWithId: MockFn
	cancelledDelegationChildIds: Set<string>
	taskCreationCallback?: (task: unknown) => void
	runDelegationTransition: <T>(parentTaskId: string, fn: () => Promise<T>) => Promise<T>
	// Wired after the literal in makeProvider because the wrapper must be bound to
	// the stub object itself; optional so the literal typechecks before wiring.
	createTaskWithHistoryItem?: (historyItem: HistoryItemLike, options?: { startTask?: boolean }) => Promise<Task>
	/** Satisfies the ClineProvider structural interface for `createTask` without being invoked by it. */
	setValues?: MockFn
	taskRegistry: TaskRegistry
	taskHistoryStore: OwnershipStore
	evictCurrentTask: MockFn
	removeClineFromStack: MockFn
	addClineToStack: MockFn
	performPreparationTasks: MockFn
	taskScheduler: { schedule: MockFn }
	taskEventListeners: Map<unknown, Array<() => void>>
	log: MockFn
	emit: MockFn
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
		invalidate: vi.fn().mockResolvedValue(undefined),
		atomicUpdatePair: vi.fn(),
	}
}

function makeProvider(store: OwnershipStore, overrides: Partial<ProviderStubObject> = {}): ProviderStubObject {
	const registry = new TaskRegistry()
	const provider: ProviderStubObject = {
		historyTaskCreationQueue: Promise.resolve(),
		getCurrentTask: vi.fn((...args: unknown[]) => (registry.current as undefined | Task) && registry.current),
		getTaskWithId: vi.fn((id: string) =>
			Promise.resolve({
				historyItem: {
					id,
					number: 1,
					ts: Date.now(),
					task: "test task",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					workspace: "/tmp",
				},
			}),
		),
		cancelledDelegationChildIds: new Set<string>(),
		runDelegationTransition: <T>(parentTaskId: string, fn: () => Promise<T>): Promise<T> =>
			privateClineProvider.runDelegationTransition<T>(parentTaskId, fn),
		taskRegistry: registry,
		taskHistoryStore: store,
		evictCurrentTask: vi.fn().mockResolvedValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		addClineToStack: vi.fn().mockResolvedValue(undefined),
		performPreparationTasks: vi.fn().mockResolvedValue(undefined),
		setValues: vi.fn().mockResolvedValue(undefined),
		taskScheduler: { schedule: vi.fn().mockResolvedValue(undefined) },
		taskEventListeners: new Map(),
		log: vi.fn(),
		emit: vi.fn(),
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
			organizationAllowList: { allowAll: true },
		}),
		getPendingEditOperation: vi.fn().mockReturnValue(undefined),
		clearPendingEditOperation: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		context: {
			extension: { packageJSON: {} },
			globalStorageUri: { fsPath: "/tmp" },
			workspaceState: { get: vi.fn().mockReturnValue(false) },
		},
		contextProxy: {
			extensionUri: {},
			globalStorageUri: { fsPath: "/tmp" },
			getValue: vi.fn(),
			setValue: vi.fn(),
			setProviderSettings: vi.fn(),
			getProviderSettings: vi.fn(() => ({})),
		},
		...overrides,
	}
	// The public wrapper reads this.historyTaskCreationQueue and routes to the
	// Unlocked prototype method with `this`, so it must be bound to the stub object.
	provider.createTaskWithHistoryItem = (historyItem, options) =>
		privateClineProvider.createTaskWithHistoryItem.call(provider, historyItem, options)
	return provider
}

function makeHistoryItem(id: string, extra: Partial<HistoryItemLike> = {}): HistoryItemLike {
	return {
		id,
		number: 1,
		ts: Date.now(),
		task: "test task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/tmp",
		...extra,
	}
}

/** Seed a registry with a current task whose id matches `historyId` (rehydrate case). */
function makeRehydrateProvider(
	store: OwnershipStore,
	historyId: string,
	overrides: Partial<ProviderStubObject> = {},
	{ seedListeners = true }: { seedListeners?: boolean } = {},
) {
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
	const provider = makeProvider(store, {
		getCurrentTask: vi.fn(() => existing),
		taskRegistry: registry,
		...overrides,
	})
	// Seed the listener map exactly like production holds it for the current task so the
	// rehydrate cleanup contract (run every cleanup, then delete the map entry) is
	// assertable; tests that never observe the map are unaffected. Pass seedListeners:
	// false to exercise the no-entry side of the `if (cleanupFunctions)` guard.
	if (seedListeners) {
		provider.taskEventListeners.set(existing, [vi.fn(), vi.fn()])
	}
	return provider
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
		// CodeRabbit: ordering, not just invocation — the eager claim exists to cover
		// the gap BEFORE Task.run()'s first active-status write, so the claim must
		// precede the scheduler handoff on the recorded invocation order.
		expect(store.markLocallyActive.mock.invocationCallOrder[0]).toBeLessThan(
			provider.taskScheduler.schedule.mock.invocationCallOrder[0],
		)
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
		// Same claim-before-schedule ordering contract on the rehydrate branch.
		expect(store.markLocallyActive.mock.invocationCallOrder[0]).toBeLessThan(
			provider.taskScheduler.schedule.mock.invocationCallOrder[0],
		)
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

		// scheduleTask's failure path logs through console.error with the exact source tag
		// of THIS call site ("createTaskWithHistoryItem", stack branch).
		await vi.waitFor(() =>
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[createTaskWithHistoryItem] taskScheduler.schedule failed:",
				expect.objectContaining({ message: "permit failed" }),
			),
		)
	})

	it("releases the claim when the scheduler rejects the run (rehydrate path)", async () => {
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-sched-fail-re", {
			taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
		})

		await privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-sched-fail-re"))

		await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-sched-fail-re"))

		// Same console.error source-tag contract on the rehydrate-branch scheduleTask call.
		await vi.waitFor(() =>
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[createTaskWithHistoryItem] taskScheduler.schedule failed:",
				expect.objectContaining({ message: "permit failed" }),
			),
		)
	})

	it("failure paths claim the id exactly once and release it exactly once (no double-release)", async () => {
		// CodeRabbit: with BOTH performPreparationTasks and taskScheduler.schedule
		// configured to reject, the id must still be claimed exactly once and released
		// exactly once. The two failure sources are mutually exclusive at runtime by
		// control flow — a prep failure throws before scheduleTask is ever reached —
		// so the schedule rejection cannot stack a second release on top of the
		// catch-path release (asserted by schedule's zero calls below).
		{
			const store = makeStore()
			const provider = makeRehydrateProvider(store, "hist-once-prep", {
				performPreparationTasks: vi.fn().mockRejectedValue(new Error("prep exploded")),
				taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
			})

			await expect(
				privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-once-prep")),
			).rejects.toThrow("prep exploded")

			expect(store.markLocallyActive).toHaveBeenCalledTimes(1)
			expect(store.markLocallyActive).toHaveBeenCalledWith("hist-once-prep")
			expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
			expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-once-prep")
			expect(provider.taskScheduler.schedule).not.toHaveBeenCalled()
		}

		// Scheduler-rejection path: prep succeeds, the release arrives solely through
		// scheduleTask's onScheduleFailure hook — one claim, one release.
		{
			const store = makeStore()
			const provider = makeProvider(store, {
				taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
			})

			await privateClineProvider.createTaskWithHistoryItem.call(provider, makeHistoryItem("hist-once-sched"))

			await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith("hist-once-sched"))
			expect(store.markLocallyActive).toHaveBeenCalledTimes(1)
			expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
		}
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

	it("rehydrate path aborts the old task with abandon=true, runs its listener cleanups, removes the map entry, and replaces it in-place", async () => {
		// Locks the rehydrate branch's oldTask handling:
		// - abortTask(true): the boolean arg must be exactly true (abandon semantics);
		// - every cleanup function for the old task runs and the taskEventListeners map
		//   entry is deleted afterwards;
		// - the registry's current entry is the NEW task, not the old one (in-place replace);
		// - the exact "rehydrated task ... in-place (flicker-free)" log line is emitted.
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-reh-full")
		const existing = asCallable(provider.getCurrentTask)() as { abortTask: MockFn; taskId: string }
		const cleanups = provider.taskEventListeners.get(existing)!
		expect(cleanups).toHaveLength(2)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-reh-full"),
		)

		// Abort with abandon=true — a `false` arg would lie about the abandon semantics.
		expect(existing.abortTask).toHaveBeenCalledTimes(1)
		expect(existing.abortTask).toHaveBeenCalledWith(true)

		// Listener contract: every cleanup ran, then the map entry was removed.
		for (const cleanup of cleanups) {
			expect(cleanup).toHaveBeenCalledTimes(1)
		}
		expect(provider.taskEventListeners.has(existing)).toBe(false)

		// In-place replace: current is the new task instance, not the old one.
		expect(provider.taskRegistry.current).toBe(task)
		expect(provider.taskRegistry.current).not.toBe(existing)

		// Exact success-log line on the rehydrate path (task id + instance id).
		expect(provider.log).toHaveBeenCalledWith(
			"[createTaskWithHistoryItem] rehydrated task hist-reh-full.stub-inst in-place (flicker-free)",
		)
	})

	it("rehydrate teardown tolerates a getCurrentTask/registry mismatch: no registry entry means no old-task abort", async () => {
		// isRehydratingCurrentTask is decided from getCurrentTask(), but the replace branch
		// reads this.taskRegistry.current. These must stay two separate reads: when the
		// provider reports a matching current task while the registry no longer holds it
		// (concurrent eviction), the `if (oldTask)` guard must skip the old-task teardown
		// instead of throwing on a missing task. A mutant forcing the guard to `true`
		// dereferences undefined and rejects the whole creation.
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-reh-mismatch", {
			taskRegistry: new TaskRegistry(),
		})
		const existing = asCallable(provider.getCurrentTask)() as { abortTask: MockFn; taskId: string }

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-reh-mismatch"),
		)

		expect(task.taskId).toBe("hist-reh-mismatch")
		// No old task in the registry → no abort, no rethrow; the run is scheduled normally.
		expect(existing.abortTask).not.toHaveBeenCalled()
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)
		await flushMicrotasks()
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-reh-mismatch")
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
	})

	it("rehydrate path logs and continues when old-task abortTask itself rejects", async () => {
		// The inner try/catch around `await oldTask.abortTask(true)` must swallow the
		// rejection, log the exact diagnostic (old task id.instance plus the cause
		// message), and let creation proceed — the claim stays because creation succeeded.
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-reh-throw")
		const existing = asCallable(provider.getCurrentTask)() as { abortTask: MockFn }
		existing.abortTask = vi.fn().mockRejectedValue(new Error("abort blew up"))

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-reh-throw"),
		)

		expect(task.taskId).toBe("hist-reh-throw")
		expect(provider.log).toHaveBeenCalledWith(
			"[createTaskWithHistoryItem] abortTask() failed for old task hist-reh-throw.old-inst: abort blew up",
		)
		// The failure is contained: creation continues to a scheduled run.
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)
		await flushMicrotasks()
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
	})

	it("rehydrate path with startTask:false skips the scheduler and retains the eager claim", async () => {
		// The rehydrate-branch schedule guard `options?.startTask !== false` must honor an
		// explicit startTask:false by NOT scheduling, while the claim stays (the only
		// production caller re-registers ownership through its own active-status write
		// before resuming). Forcing the guard true — or flipping the `false` literal —
		// schedules anyway and breaks the contract.
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-reh-nostart")

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-reh-nostart"),
			{ startTask: false },
		)

		expect(task.taskId).toBe("hist-reh-nostart")
		expect(provider.taskScheduler.schedule).not.toHaveBeenCalled()
		await flushMicrotasks()
		expect(store.markLocallyActive).toHaveBeenCalledWith("hist-reh-nostart")
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
	})

	it("stack path logs the exact instantiation message, distinguishing child tasks from parent tasks", async () => {
		// The stack-branch success log is parameterized by `task.parentTask ? "child" :
		// "parent"`; pin the CHILD variant (including task id and instance id) so the
		// template literal cannot be blanked or its textual content swapped.
		const store = makeStore()
		const provider = makeProvider(store)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-child-msg", { parentTask: {} as Task }),
		)

		expect(task.taskId).toBe("hist-child-msg")
		expect(task.parentTask).toBeDefined()
		expect(provider.log).toHaveBeenCalledWith(
			"[createTaskWithHistoryItem] child task hist-child-msg.stub-inst instantiated",
		)
	})

	it("rehydrate teardown skips cleanup when the old task has NO listener map entry", async () => {
		// The `if (cleanupFunctions)` guard: an old task without registered listeners must
		// not run (or crash on) any cleanup. Forcing the guard true dereferences undefined
		// (`cleanupFunctions.forEach` on undefined) and rejects the whole creation.
		const store = makeStore()
		const provider = makeRehydrateProvider(store, "hist-reh-nolisteners", {}, { seedListeners: false })
		const existing = asCallable(provider.getCurrentTask)() as { abortTask: MockFn }
		expect(provider.taskEventListeners.size).toBe(0)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-reh-nolisteners"),
		)

		expect(task.taskId).toBe("hist-reh-nolisteners")
		expect(existing.abortTask).toHaveBeenCalledTimes(1)
		// No cleanup entry → the code runs clean through the replace and schedules.
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)
		// And no map entry was created for the NEW task either (no listeners registered).
		expect(provider.taskEventListeners.size).toBe(0)
	})

	it("stack path logs the PARENT-variant instantiation message for tasks without a parent", async () => {
		// The stack-branch success log's ternary `task.parentTask ? "child" : "parent"` —
		// pin the PARENT variant (including task id and instance id) so the "parent"
		// string literal cannot be blanked or swapped; the "child" side is pinned by the
		// sibling test above.
		const store = makeStore()
		const provider = makeProvider(store)

		const task = await privateClineProvider.createTaskWithHistoryItem.call(
			provider,
			makeHistoryItem("hist-parent-msg"),
		)

		expect(task.taskId).toBe("hist-parent-msg")
		expect(task.parentTask).toBeUndefined()
		expect(provider.log).toHaveBeenCalledWith(
			"[createTaskWithHistoryItem] parent task hist-parent-msg.stub-inst instantiated",
		)
	})

	it("hookless createTask call site survives a scheduler rejection by logging the createTask-tagged error, without a failure hook", async () => {
		// scheduleTask's optional onScheduleFailure hook is undefined at this call site
		// (createTask performs no claim that needs rolling back). The catch must invoke an
		// absent hook exactly zero times — an unconditional `onScheduleFailure(error)`
		// throws a TypeError as an unhandled rejection — and must log the rejection with
		// THIS call site's source tag ("createTask").
		const store = makeStore()
		const provider = makeProvider(store, {
			taskScheduler: { schedule: vi.fn().mockRejectedValue(new Error("permit failed")) },
		})

		const task = await privateClineProvider.createTask.call(provider, "hello")

		// CodeRabbit round-5: assert the resolution value itself, not just
		// "defined" — the resolved task must be the mocked TaskStub instance,
		// and its generated identifier (no historyItem on this path) must be
		// the stub's most recent sequential default id (deterministic prefix,
		// preferred over a /^task-/ format check because it pins the exact
		// id-generation behavior of the stub's constructor fallback).
		expect(task).toBeInstanceOf(TaskStub)
		expect(task.taskId).toBe(`task-stub-${TaskStub.instanceCount}`)
		expect(provider.taskScheduler.schedule).toHaveBeenCalledTimes(1)

		await flushMicrotasks()
		// Logged exactly once, with the exact tagged message and the original error.
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[createTask] taskScheduler.schedule failed:",
			expect.objectContaining({ message: "permit failed" }),
		)
	})
})

describe("ClineProvider reopenParentFromDelegation continuation scheduling ownership release", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		consoleErrorSpy.mockRestore()
	})

	// A store double whose atomicUpdatePair applies the updaters for real, so the
	// production completeDelegatedChild reducer produces the parent's `active`
	// record that the continuation body re-reads through get()/invalidate().
	function makeDelegationStore(seed: { child: HistoryItemLike; parent: HistoryItemLike }): OwnershipStore {
		const items = new Map<string, HistoryItemLike>([
			[seed.child.id, structuredClone(seed.child)],
			[seed.parent.id, structuredClone(seed.parent)],
		])
		return {
			get: vi.fn((id: string) => items.get(id)),
			markLocallyActive: vi.fn(),
			markLocallyInactive: vi.fn(),
			invalidate: vi.fn().mockResolvedValue(undefined),
			atomicUpdatePair: vi.fn(
				async (
					firstId: string,
					secondId: string,
					firstUpdater: (current: HistoryItemLike) => HistoryItemLike,
					secondUpdater: (current: HistoryItemLike) => HistoryItemLike,
				) => {
					const first = items.get(firstId)
					const second = items.get(secondId)
					if (!first || !second) {
						throw new Error(`atomicUpdatePair: ${first ? secondId : firstId} not found`)
					}
					items.set(firstId, firstUpdater(structuredClone(first)))
					items.set(secondId, secondUpdater(structuredClone(second)))
					return []
				},
			),
		}
	}

	function makeDelegationHistory(parentId: string, childId: string) {
		const parent = makeHistoryItem(parentId, {
			status: "delegated",
			awaitingChildId: childId,
			delegatedToId: childId,
			childIds: [childId],
		})
		const child = makeHistoryItem(childId, {
			status: "active",
			parentTaskId: parentId,
		})
		return { parent, child }
	}

	// Captures the scheduled run callback and returns a promise the test settles
	// manually, mirroring production where schedule() settles only after run().
	function makeCapturingSchedule() {
		let runTask: (() => Promise<void>) | undefined
		let resolveSchedule!: (value?: unknown) => void
		let rejectSchedule!: (reason?: unknown) => void
		const settled = new Promise<unknown>((resolve, reject) => {
			resolveSchedule = resolve
			rejectSchedule = reject
		})
		const schedule = vi.fn((_task: unknown, run: () => Promise<void>) => {
			runTask = run
			return settled
		})
		return {
			schedule,
			getRunTask: () => runTask,
			resolveSchedule: () => resolveSchedule(),
			rejectSchedule: (reason: unknown) => rejectSchedule(reason),
		}
	}

	function makeReopenFixture(schedule: MockFn) {
		const ids = { parentId: "parent-1", childId: "child-1" }
		const { parent, child } = makeDelegationHistory(ids.parentId, ids.childId)
		const store = makeDelegationStore({ child, parent })
		let created: InstanceType<typeof TaskStub> | undefined
		const provider = makeProvider(store, {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parent }),
			taskCreationCallback: (task) => {
				created = task as InstanceType<typeof TaskStub>
			},
		})
		// The stack branch's addClineToStack must actually install the created task so
		// the continuation body's `currentTask === parentInstance` check sees it.
		provider.addClineToStack = vi.fn((task: unknown) => {
			provider.taskRegistry.push(task as unknown as Task)
			return Promise.resolve()
		})
		provider.taskScheduler.schedule = schedule
		return {
			ids,
			store,
			provider,
			getCreated: () => {
				if (!created) throw new Error("taskCreationCallback was never invoked")
				return created
			},
		}
	}

	it("releases the parent's eager claim when the scheduler rejects before the continuation is ever admitted", async () => {
		// permit wait cancelled while the continuation was queued: schedule() rejects
		// without invoking its callback, so resumeAfterDelegation never runs and the
		// eager claim from createTaskWithHistoryItem(startTask:false) must be rolled back.
		const schedule = vi.fn().mockRejectedValue(new Error("permit wait cancelled"))
		const { ids, store, provider, getCreated } = makeReopenFixture(schedule)

		const result = await privateClineProvider.reopenParentFromDelegation.call(provider, {
			parentTaskId: ids.parentId,
			childTaskId: ids.childId,
			completionResultSummary: "subtask done",
		})

		expect(result).toBe(true)
		expect(schedule).toHaveBeenCalledTimes(1)
		// Claimed once by step 7, released once by the rejection handler.
		expect(store.markLocallyActive).toHaveBeenCalledTimes(1)
		expect(store.markLocallyActive).toHaveBeenCalledWith(ids.parentId)
		await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith(ids.parentId))
		expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
		expect(getCreated().resumeAfterDelegation).not.toHaveBeenCalled()
		// The rejection still reaches the tagged console.error diagnostic.
		await vi.waitFor(() =>
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[reopenParentFromDelegation] taskScheduler.schedule failed:",
				expect.objectContaining({ message: "permit wait cancelled" }),
			),
		)
	})

	it("releases the parent's eager claim when the scheduler resolves without ever invoking the continuation (aborted/abandoned while waiting)", async () => {
		// TaskScheduler.schedule returns early — permit acquired but task.abort/abandoned
		// set while queued — resolving WITHOUT calling run(). The claim must still be
		// released even though nothing rejected.
		const schedule = vi.fn().mockResolvedValue(undefined)
		const { ids, store, provider, getCreated } = makeReopenFixture(schedule)

		const result = await privateClineProvider.reopenParentFromDelegation.call(provider, {
			parentTaskId: ids.parentId,
			childTaskId: ids.childId,
			completionResultSummary: "subtask done",
		})

		expect(result).toBe(true)
		expect(store.markLocallyActive).toHaveBeenCalledWith(ids.parentId)
		await vi.waitFor(() => expect(store.markLocallyInactive).toHaveBeenCalledWith(ids.parentId))
		expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
		expect(getCreated().resumeAfterDelegation).not.toHaveBeenCalled()
		// Resolution-without-admission is not an error: the tagged console.error stays silent.
		await flushMicrotasks()
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("releases the parent's eager claim when the admitted continuation declines to resume (stale parent)", async () => {
		// The scheduler admits the continuation, but the body's staleness guard fires
		// (parent abandoned between scheduling and admission) and returns no runPromise.
		const capture = makeCapturingSchedule()
		const { ids, store, provider, getCreated } = makeReopenFixture(capture.schedule)

		const result = await privateClineProvider.reopenParentFromDelegation.call(provider, {
			parentTaskId: ids.parentId,
			childTaskId: ids.childId,
			completionResultSummary: "subtask done",
		})
		expect(result).toBe(true)
		expect(store.markLocallyInactive).not.toHaveBeenCalled()

		// Make the parent stale BEFORE invoking the admitted run.
		getCreated().abandoned = true
		await capture.getRunTask()!()

		expect(getCreated().resumeAfterDelegation).not.toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith(
			`[reopenParentFromDelegation] Skipping stale parent continuation for ${ids.parentId} after child ${ids.childId}`,
		)
		expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
		expect(store.markLocallyInactive).toHaveBeenCalledWith(ids.parentId)

		// The schedule promise settling afterwards must not release a second time.
		capture.resolveSchedule()
		await flushMicrotasks()
		expect(store.markLocallyInactive).toHaveBeenCalledTimes(1)
	})

	it("keeps the claim when the admitted continuation resumes the parent to completion", async () => {
		const capture = makeCapturingSchedule()
		const { ids, store, provider, getCreated } = makeReopenFixture(capture.schedule)

		const result = await privateClineProvider.reopenParentFromDelegation.call(provider, {
			parentTaskId: ids.parentId,
			childTaskId: ids.childId,
			completionResultSummary: "subtask done",
		})
		expect(result).toBe(true)

		await capture.getRunTask()!()
		capture.resolveSchedule()
		await flushMicrotasks()

		expect(getCreated().resumeAfterDelegation).toHaveBeenCalledTimes(1)
		expect(provider.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationCompleted,
			ids.parentId,
			ids.childId,
			"subtask done",
		)
		expect(provider.emit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, ids.parentId, ids.childId)
		expect(store.markLocallyActive).toHaveBeenCalledWith(ids.parentId)
		expect(store.markLocallyInactive).not.toHaveBeenCalled()
	})

	it("keeps the claim and still reports the error when the admitted resume itself fails", async () => {
		// CodeRabbit: rejection propagation from an ADMITTED resume must be preserved —
		// the error reaches the tagged console.error handler, but the claim is NOT
		// released because the parent session still exists in this window.
		const capture = makeCapturingSchedule()
		const { ids, store, provider, getCreated } = makeReopenFixture(capture.schedule)

		const result = await privateClineProvider.reopenParentFromDelegation.call(provider, {
			parentTaskId: ids.parentId,
			childTaskId: ids.childId,
			completionResultSummary: "subtask done",
		})
		expect(result).toBe(true)

		getCreated().resumeAfterDelegation.mockRejectedValue(new Error("resume blew up"))
		await expect(capture.getRunTask()!()).rejects.toThrow("resume blew up")
		capture.rejectSchedule(new Error("resume blew up"))
		await flushMicrotasks()

		expect(store.markLocallyInactive).not.toHaveBeenCalled()
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"[reopenParentFromDelegation] taskScheduler.schedule failed:",
			expect.objectContaining({ message: "resume blew up" }),
		)
	})
})
