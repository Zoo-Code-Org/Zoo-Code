// npx vitest run __tests__/provider-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskScheduler } from "../core/task/TaskScheduler"

const parentHistoryItem: HistoryItem = {
	id: "parent-1",
	task: "Parent",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	childIds: [],
} as unknown as HistoryItem

/** Minimal taskHistoryStore stub whose atomicReadAndUpdate calls the updater with the parent item. */
function makeStoreStub(
	overrides: Partial<{ atomicReadAndUpdate: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }> = {},
) {
	return {
		atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
			updater(parentHistoryItem)
			return []
		}),
		get: vi.fn().mockReturnValue(undefined),
		...overrides,
	}
}

/**
 * Parent task double with the methods delegateParentAndOpenChild reads from
 * `parent`. Without flushPendingToolResultsToHistory the method hits its
 * non-fatal flush-error branch and never reaches the happy delegation path.
 */
const makeParentTask = () =>
	({
		taskId: "parent-1",
		emit: vi.fn(),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn(),
	}) as any

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("persists parent delegation metadata via atomicReadAndUpdate and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = makeParentTask()

		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: childRun })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)

		// Child task created with startTask: false and initialStatus: "active"
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
		})

		// Delegation metadata written via atomicReadAndUpdate with correct taskId
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		const [calledTaskId, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		expect(calledTaskId).toBe("parent-1")

		// The updater must produce the correct delegation fields
		const result = updater(parentHistoryItem)
		expect(result).toMatchObject({
			id: "parent-1",
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: expect.arrayContaining(["child-1"]),
		})

		// child.run() called AFTER parent metadata is persisted (via taskScheduler)
		expect(childRun).toHaveBeenCalledTimes(1)

		// Provider-level event
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		// Mode switch
		expect(handleModeSwitch).toHaveBeenCalledWith("code")
	})

	it("posts taskHistoryItemUpdated to the webview when isViewLaunched is true", async () => {
		const updatedParent = { ...parentHistoryItem, status: "delegated" } as HistoryItem
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue(updatedParent),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "taskHistoryItemUpdated",
			taskHistoryItem: updatedParent,
		})
	})

	it("skips postMessageToWebview when isViewLaunched is true but store returns undefined", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue(undefined),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	it("calls child.run() only after atomicReadAndUpdate completes (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = makeParentTask()
		const childRun = vi.fn(async () => callOrder.push("child.run"))
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return { taskId: "child-1", start: vi.fn(), run: childRun }
		})
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, _updater: (h: HistoryItem) => HistoryItem) => {
				callOrder.push("atomicReadAndUpdate")
				return []
			}),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		// createTask → atomicReadAndUpdate → child.run: scheduler admits child only after metadata is persisted
		expect(callOrder).toEqual(["createTask", "atomicReadAndUpdate", "child.run"])
	})

	it("implicitly severs interrupted awaited child and re-delegates when parent is already delegated", async () => {
		const oldChildId = "old-child"
		const oldChild = { id: oldChildId, status: "interrupted" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
			childIds: [oldChildId],
		} as unknown as HistoryItem

		const taskHistoryStore = makeStoreStub({
			// store returns: parent (delegated), old child (interrupted)
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? oldChild : undefined,
			),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => makeParentTask()),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-2", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Continue",
			initialTodos: [],
			mode: "code",
		})

		// The updater must sever the old link and apply the new delegation
		const [, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		const result = updater(alreadyDelegatedParent)
		expect(result).toMatchObject({
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
		})
		// Old child ID preserved in childIds (audit trail)
		expect(result.childIds).toContain(oldChildId)
		expect(result.childIds).toContain("child-2")
	})

	it("rejects with 'Cannot re-delegate' when the existing awaited child is still active", async () => {
		const oldChildId = "old-child"
		const activeChild = { id: oldChildId, status: "active" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
		} as unknown as HistoryItem

		const child = { taskId: "child-2", start: vi.fn(), run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(makeParentTask())
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const taskHistoryStore = makeStoreStub({
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? activeChild : undefined,
			),
			// Real atomicReadAndUpdate behaviour: call the updater and propagate any throw
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: alreadyDelegatedParent }),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate")

		// Rollback: child must not have run, and must be cleaned up
		expect(child.run).not.toHaveBeenCalled()
		expect((provider as any).deleteTaskWithId).toHaveBeenCalledWith("child-2", false)
	})

	it("rolls back the paused child and restores the parent when atomicReadAndUpdate fails", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
		})

		const child = { taskId: "child-1", start: vi.fn(), run: childRun }
		// Before createTask: getCurrentTask returns parent (used by step 3 close).
		// After createTask: returns child so the rollback guard passes and the child is popped.
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack,
			createTask,
			getTaskWithId,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow(persistError)

		expect(childRun).not.toHaveBeenCalled()
		expect(removeClineFromStack).toHaveBeenNthCalledWith(1)
		expect(removeClineFromStack).toHaveBeenNthCalledWith(2)
		expect(deleteTaskWithId).toHaveBeenCalledWith("child-1", false)
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(parentHistoryItem)
	})

	it("applies the parent-supplied starting effort to the child at init (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		const childRun = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
			// The child's resolved model (post mode switch) supports the requested level.
			api: {
				getModel: () => ({ id: "child-model", info: { supportsReasoningEffort: ["low", "medium", "high"] } }),
			},
		})
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		const child = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "high",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(child.taskId).toBe("child-1")
		// Applied as a task-local override with provenance "parent" before the child's
		// first request (the child header shows it from the start).
		expect(setRuntimeThinkingEffort).toHaveBeenCalledTimes(1)
		expect(setRuntimeThinkingEffort).toHaveBeenCalledWith("high", "parent")
	})

	it("leaves the child's effort untouched when no starting effort is supplied (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		const childRun = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
		})
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve()

		expect(setRuntimeThinkingEffort).not.toHaveBeenCalled()
	})

	it("falls back with an observable say when the child model (post mode switch) does not support the effort (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		const say = vi.fn().mockResolvedValue(undefined)
		const childRun = vi.fn().mockResolvedValue(undefined)
		// The mode switch resolved a DIFFERENT model than the parent's: it only
		// supports low/high, so the parent-validated "xhigh" must not be applied.
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
			say,
			api: { getModel: () => ({ id: "child-model", info: { supportsReasoningEffort: ["low", "high"] } }) },
		})
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "xhigh",
		})
		await Promise.resolve()

		// No task-local override: the child runs with the settings-derived effort.
		expect(setRuntimeThinkingEffort).not.toHaveBeenCalled()
		// Observable on the child task: the fallback is announced, not silent.
		expect(say).toHaveBeenCalledTimes(1)
		const [sayType, sayText] = say.mock.calls[0]
		expect(sayType).toBe("error")
		expect(sayText).toContain("xhigh")
		expect(sayText).toContain("child-model")
		// Delegation itself still proceeds: the child runs.
		expect(childRun).toHaveBeenCalledTimes(1)
	})

	it("does not abort delegation when the fallback say rejects after the parent is disposed (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		// The parent is already disposed when this say runs, so the webview state can be
		// gone and the say rejects (e.g. posting to a removed task).
		const say = vi.fn().mockRejectedValue(new Error("task disposed"))
		const childRun = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
			say,
			api: { getModel: () => ({ id: "child-model", info: { supportsReasoningEffort: ["low", "high"] } }) },
		})
		const taskHistoryStore = makeStoreStub()
		const providerLog = vi.fn()

		// Partial provider double: the real ClineProvider.prototype.delegateParentAndOpenChild
		// is invoked below via .call() with only the members that method reads, so the full
		// interface is not implemented and the double assertion is the last-resort hand-off.
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: providerLog,
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		// Must NOT reject: the failing notification is non-fatal.
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "xhigh",
		})
		await Promise.resolve()

		// The say rejection is surfaced through the provider log, not thrown.
		expect(providerLog).toHaveBeenCalledWith(expect.stringContaining("non-fatal"))
		expect(providerLog).toHaveBeenCalledWith(expect.stringContaining("task disposed"))
		// Delegation metadata is still persisted for the (already disposed) parent:
		// capture the updater's resulting item and assert the delegated status and both
		// child links, not just that the metadata transaction was entered.
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		const [calledTaskId, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		expect(calledTaskId).toBe("parent-1")
		expect(updater(parentHistoryItem)).toMatchObject({
			id: "parent-1",
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: expect.arrayContaining(["child-1"]),
		})
		// And the child is still scheduled despite the failed notification.
		expect(childRun).toHaveBeenCalledTimes(1)
	})

	it("stringifies a non-Error say rejection in the non-fatal log (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		// A non-Error rejection (e.g. a raw string from the webview messaging
		// layer): the catch must not assume an Error shape, where error.message
		// would be undefined and the log line would read 'undefined'.
		const say = vi.fn().mockRejectedValue("webview gone")
		const childRun = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
			say,
			api: { getModel: () => ({ id: "child-model", info: { supportsReasoningEffort: ["low", "high"] } }) },
		})
		const taskHistoryStore = makeStoreStub()
		const providerLog = vi.fn()

		// Partial provider double: the real ClineProvider.prototype.delegateParentAndOpenChild
		// is invoked below via .call() with only the members that method reads, so the full
		// interface is not implemented and the double assertion is the last-resort hand-off.
		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: providerLog,
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		// Must NOT reject: the failing notification is non-fatal.
		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "xhigh",
		})
		await Promise.resolve()

		// The non-Error rejection is stringified into the log (the Error-instance
		// arm is covered by the disposed-parent test above).
		expect(providerLog).toHaveBeenCalledWith(expect.stringContaining("non-fatal"))
		expect(providerLog).toHaveBeenCalledWith(expect.stringContaining("webview gone"))
		// Delegation still proceeds: the child runs.
		expect(childRun).toHaveBeenCalledTimes(1)
	})

	it("applies the effort when the child model (post mode switch) has a boolean-true capability (DTE series 5/5)", async () => {
		const parentTask = makeParentTask()
		const setRuntimeThinkingEffort = vi.fn()
		const childRun = vi.fn().mockResolvedValue(undefined)
		// Boolean-true capability: the child model supports every level.
		const createTask = vi.fn().mockResolvedValue({
			taskId: "child-1",
			start: vi.fn(),
			run: childRun,
			setRuntimeThinkingEffort,
			api: { getModel: () => ({ id: "child-model", info: { supportsReasoningEffort: true } }) },
		})
		const taskHistoryStore = makeStoreStub()

		const provider = {
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		} as unknown as ClineProvider

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			thinkingEffort: "xhigh",
		})
		await Promise.resolve()

		expect(setRuntimeThinkingEffort).toHaveBeenCalledTimes(1)
		expect(setRuntimeThinkingEffort).toHaveBeenCalledWith("xhigh", "parent")
	})
})
