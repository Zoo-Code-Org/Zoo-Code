// npx vitest run src/core/task/__tests__/delegation-concurrent.spec.ts

import * as vscode from "vscode"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../../webview/ClineProvider"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { type Task } from "../Task"
import { makeProviderStub } from "../../../__tests__/helpers/provider-stub"

function makeParent(overrides: Record<string, unknown> = {}): Task {
	return {
		taskId: "parent-1",
		clineMessages: [] as unknown[],
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn().mockResolvedValue(true),
		abort: false,
		abandoned: false,
		...overrides,
	} as unknown as Task
}

function makeChild(overrides: Record<string, unknown> = {}): Task {
	return {
		taskId: "child-1",
		clineMessages: [] as unknown[],
		abort: false,
		abandoned: false,
		run: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as Task
}

/**
 * Real createTask() pushes the child onto taskRegistry (which also focuses
 * it) before returning. Mirror that here so the fan-out branch has a real
 * registry entry to operate on, same as production.
 */
function makeCreateTaskMock(provider: ClineProvider, child: Task) {
	return vi.fn().mockImplementation(async () => {
		;(provider as unknown as { taskRegistry: { push: (t: Task) => void } }).taskRegistry.push(child)
		return child
	})
}

function baseStubFields(parent: Task) {
	const atomicReadAndUpdate = vi.fn(async (_id: string, updater: (h: HistoryItem) => HistoryItem) =>
		updater({ id: "parent-1", status: "active", childIds: [] } as unknown as HistoryItem),
	)
	return {
		contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
		getCurrentTask: vi.fn(() => parent),
		handleModeSwitch: vi.fn().mockResolvedValue({
			apiConfiguration: {},
			mode: "code",
			apiConfigName: "default",
		}),
		handleModeSwitchForChild: vi.fn().mockResolvedValue({
			apiConfiguration: {},
			mode: "code",
			apiConfigName: "default",
		}),
		taskHistoryStore: {
			get: vi.fn(() => undefined),
			atomicReadAndUpdate,
		},
		isViewLaunched: false,
		emit: vi.fn(),
		deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
		getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "parent-1" } }),
		createTaskWithHistoryItem: vi.fn().mockResolvedValue(parent),
	}
}

function getRunningTasks(provider: ClineProvider): Task[] {
	return ClineProvider.prototype.getRunningTasks.call(provider)
}

function callDelegate(provider: ClineProvider) {
	return (
		ClineProvider.prototype as unknown as {
			delegateParentAndOpenChild: (params: {
				parentTaskId: string
				message: string
				initialTodos: never[]
				mode: string
			}) => Promise<Task>
		}
	).delegateParentAndOpenChild.call(provider, {
		parentTaskId: "parent-1",
		message: "do work",
		initialTodos: [],
		mode: "code",
	})
}

describe("delegateParentAndOpenChild — fan-out (Story 3.2b)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("maxConcurrency=1: removeClineFromStack is still called — existing behavior fully preserved", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue(child)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack,
			createTask,
		})

		await callDelegate(provider)

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
	})

	it("maxConcurrency=2 with a free permit: parent stays active, fan-out path is taken", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack,
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		// Parent must not be suspended.
		expect(removeClineFromStack).not.toHaveBeenCalled()
		// UI focus moves to the child, parent remains in the registry.
		const registry = (provider as unknown as { taskRegistry: TaskRegistry }).taskRegistry
		expect(registry.current?.taskId).toBe("child-1")
		expect(registry.getById("parent-1")).toBeDefined()
	})

	it("maxConcurrency=2 but no free permit: falls back to the suspending (maxConcurrency=1) path", async () => {
		const parent = makeParent()
		const child = makeChild()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue(child)

		const scheduler = new TaskScheduler(2)
		// Occupy both permits so none are free for fan-out. Don't await —
		// the occupying "run" functions never resolve on purpose.
		void scheduler.schedule(makeParent({ taskId: "occupant-1" }), () => new Promise<void>(() => {}))
		void scheduler.schedule(makeParent({ taskId: "occupant-2" }), () => new Promise<void>(() => {}))
		// Poll the deterministic signal instead of assuming a fixed microtask
		// depth for sem.acquire() to settle.
		for (let i = 0; i < 10 && scheduler.available > 0; i++) {
			await Promise.resolve()
		}

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack,
			createTask,
		})

		await callDelegate(provider)

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
	})

	it("createTask() throws in fan-out: the reserved permit is released, not leaked", async () => {
		const parent = makeParent()
		const createTaskError = new Error("createTask boom")
		const scheduler = new TaskScheduler(2)
		const createTaskWithHistoryItem = vi.fn()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack,
			createTask: vi.fn().mockRejectedValue(createTaskError),
			createTaskWithHistoryItem,
		})

		await expect(callDelegate(provider)).rejects.toThrow(createTaskError)

		// Permit must have been released, not leaked — a subsequent reservation
		// attempt must succeed immediately.
		expect(scheduler.available).toBe(2)
		const release = await scheduler.tryReserve()
		expect(release).toBeDefined()
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
	})

	it("handleModeSwitch() throws in fan-out: delegation aborts and releases the reserved permit before child creation", async () => {
		const parent = makeParent()
		const modeSwitchError = new Error("Provider profile mutation timed out")
		const scheduler = new TaskScheduler(2)
		const createTask = vi.fn()
		const createTaskWithHistoryItem = vi.fn()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			handleModeSwitch: vi.fn().mockRejectedValue(modeSwitchError),
			handleModeSwitchForChild: vi.fn().mockRejectedValue(modeSwitchError),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack,
			createTask,
			createTaskWithHistoryItem,
		})

		await expect(callDelegate(provider)).rejects.toThrow(modeSwitchError)

		expect(createTask).not.toHaveBeenCalled()
		expect(scheduler.available).toBe(2)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
	})

	it("fan-out metadata persistence failure removes only the created child and releases its permit", async () => {
		const parent = makeParent()
		const child = makeChild()
		const persistError = new Error("parent metadata persist failed")
		const scheduler = new TaskScheduler(2)
		const createTaskWithHistoryItem = vi.fn()
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockImplementation(async (taskId?: string) => {
			if (taskId === child.taskId) {
				registry.remove(taskId)
			}
		})
		const registry = new TaskRegistry()
		registry.push(parent)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			taskRegistry: registry,
			taskScheduler: scheduler,
			removeClineFromStack,
			deleteTaskWithId,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				get: vi.fn(() => undefined),
				atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
			},
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await expect(callDelegate(provider)).rejects.toThrow(persistError)

		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		expect(removeClineFromStack).toHaveBeenCalledWith(child.taskId)
		expect(deleteTaskWithId).toHaveBeenCalledWith(child.taskId, false)
		expect(registry.getById(child.taskId)).toBeUndefined()
		expect(registry.getById(parent.taskId)).toBe(parent)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(child.run).not.toHaveBeenCalled()
		expect(scheduler.available).toBe(2)
	})

	it("fan-out does not start a child after its parent is evicted during metadata persistence", async () => {
		const parent = makeParent()
		const child = makeChild()
		const scheduler = new TaskScheduler(2)
		let metadataEntered!: () => void
		const metadataEnteredPromise = new Promise<void>((resolve) => (metadataEntered = resolve))
		let releaseMetadata!: () => void
		const releaseMetadataPromise = new Promise<void>((resolve) => (releaseMetadata = resolve))
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn()
		const registry = new TaskRegistry()
		registry.push(parent)
		const removeClineFromStack = vi.fn().mockImplementation(async (taskId?: string) => {
			if (taskId) registry.remove(taskId)
		})

		const provider = makeProviderStub({
			...baseStubFields(parent),
			taskRegistry: registry,
			taskScheduler: scheduler,
			removeClineFromStack,
			deleteTaskWithId,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				get: vi.fn(() => undefined),
				atomicReadAndUpdate: vi.fn(async () => {
					metadataEntered()
					await releaseMetadataPromise
				}),
			},
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		const delegation = callDelegate(provider)
		await metadataEnteredPromise
		registry.remove(parent.taskId)
		parent.abandoned = true
		releaseMetadata()

		await expect(delegation).rejects.toThrow(/Parent parent-1 is no longer live/)
		expect(child.run).not.toHaveBeenCalled()
		expect(removeClineFromStack).toHaveBeenCalledWith(child.taskId)
		expect(deleteTaskWithId).toHaveBeenCalledWith(child.taskId, false)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(registry.getById(child.taskId)).toBeUndefined()
		expect(scheduler.available).toBe(2)
	})

	it("fan-out metadata rollback cleans child history without recreating the live parent", async () => {
		const parent = makeParent()
		const child = makeChild()
		const scheduler = new TaskScheduler(2)
		const registry = new TaskRegistry()
		registry.push(parent)
		const removeClineFromStack = vi.fn().mockImplementation(async (taskId?: string) => {
			if (taskId) registry.remove(taskId)
		})
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn()
		const provider = makeProviderStub({
			...baseStubFields(parent),
			taskRegistry: registry,
			taskScheduler: scheduler,
			removeClineFromStack,
			deleteTaskWithId,
			createTaskWithHistoryItem,
			taskHistoryStore: {
				get: vi.fn((id: string) => (id === child.taskId ? { id, status: "active" } : undefined)),
				atomicReadAndUpdate: vi.fn().mockRejectedValue(new Error("metadata failed")),
			},
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await expect(callDelegate(provider)).rejects.toThrow("metadata failed")
		expect(removeClineFromStack).toHaveBeenCalledWith(child.taskId)
		expect(deleteTaskWithId).toHaveBeenCalledWith(child.taskId, false)
		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(registry.taskIds).toEqual([parent.taskId])
		expect(scheduler.available).toBe(2)
	})

	it("createTask() throws in the non-fan-out path: the evicted parent is restored", async () => {
		const parent = makeParent()
		const createTaskError = new Error("createTask boom")
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(parent)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockRejectedValue(createTaskError),
			createTaskWithHistoryItem,
		})

		await expect(callDelegate(provider)).rejects.toThrow(createTaskError)

		expect(createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "parent-1" })
	})

	it("handleModeSwitch() throws in the non-fan-out path: the evicted parent is restored", async () => {
		const parent = makeParent()
		const modeSwitchError = new Error("mode switch failed")
		const createTask = vi.fn()
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(parent)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			handleModeSwitch: vi.fn().mockRejectedValue(modeSwitchError),
			handleModeSwitchForChild: vi.fn().mockRejectedValue(modeSwitchError),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			createTaskWithHistoryItem,
		})

		await expect(callDelegate(provider)).rejects.toThrow(modeSwitchError)

		expect(createTask).not.toHaveBeenCalled()
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith({ id: "parent-1" })
	})

	it("createTask() throws in the non-fan-out path: parent restore retries once after a restore failure", async () => {
		const parent = makeParent()
		const createTaskError = new Error("createTask boom")
		const restoreError = new Error("restore failed once")
		const createTaskWithHistoryItem = vi.fn().mockRejectedValueOnce(restoreError).mockResolvedValueOnce(parent)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockRejectedValue(createTaskError),
			createTaskWithHistoryItem,
		})

		await expect(callDelegate(provider)).rejects.toThrow(createTaskError)

		expect(createTaskWithHistoryItem).toHaveBeenCalledTimes(2)
		expect(createTaskWithHistoryItem).toHaveBeenNthCalledWith(1, { id: "parent-1" })
		expect(createTaskWithHistoryItem).toHaveBeenNthCalledWith(2, { id: "parent-1" })
	})

	it("createTask() throws in the non-fan-out path: parent restore reports an error after retry exhaustion", async () => {
		const parent = makeParent()
		const createTaskError = new Error("createTask boom")
		const createTaskWithHistoryItem = vi.fn().mockRejectedValue(new Error("restore keeps failing"))
		const showErrorMessage = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(1),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockRejectedValue(createTaskError),
			createTaskWithHistoryItem,
		})

		try {
			await expect(callDelegate(provider)).rejects.toThrow(createTaskError)

			expect(createTaskWithHistoryItem).toHaveBeenCalledTimes(2)
			expect(showErrorMessage).toHaveBeenCalledWith(
				"Failed to restore the parent task after subtask creation failed. Reopen the task from history to continue.",
			)
		} finally {
			showErrorMessage.mockRestore()
		}
	})

	it("fan-out path: both parent and child are tracked in the registry with no shared clineMessages reference", async () => {
		const parent = makeParent({ clineMessages: [{ text: "parent msg" }] })
		const child = makeChild({ clineMessages: [{ text: "child msg" }] })

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		const running = getRunningTasks(provider).map((t) => t.taskId)
		expect(running).toContain("parent-1")
		expect(running).toContain("child-1")
		expect(parent.clineMessages).not.toBe(child.clineMessages)
	})

	it("fan-out path: the child's run() actually starts concurrently with the parent, not just the registry bookkeeping", async () => {
		const parent = makeParent()
		let parentResolve!: () => void
		// The parent's own request loop is "in flight" (never resolves during
		// this test) — provided as run() the way ClineProvider's real scheduler
		// invocation for the parent would use it, to prove the child does not
		// wait for the parent to finish.
		const parentRun = vi.fn(() => new Promise<void>((res) => (parentResolve = res)))

		let childStarted = false
		let childResolve!: () => void
		const child = makeChild({
			run: vi.fn().mockImplementation(() => {
				childStarted = true
				return new Promise<void>((res) => (childResolve = res))
			}),
		})

		const scheduler = new TaskScheduler(2)
		// Occupy one permit with the "parent's own request loop" so only one
		// permit remains — exactly the scenario fan-out is meant to handle.
		void scheduler.schedule(parent, parentRun)
		for (let i = 0; i < 10 && scheduler.available > 1; i++) {
			await Promise.resolve()
		}

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: scheduler,
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)
		// Poll the deterministic signal (the child's run() having actually been
		// invoked) instead of assuming a fixed microtask depth.
		for (let i = 0; i < 10 && !childStarted; i++) {
			await Promise.resolve()
		}

		expect(childStarted).toBe(true)
		expect(child.run).toHaveBeenCalledTimes(1)

		childResolve()
		parentResolve()
	})

	it("fan-out path: persisted parent history status is still 'delegated' (awaiting child), independent of the in-memory registry", async () => {
		// Fan-out only changes whether the parent Task instance stays alive in
		// TaskRegistry — it does not change what delegateParentAndOpenChild
		// persists to TaskHistoryStore. The parent's HistoryItem status becomes
		// "delegated" (awaiting the child) in both the fan-out and suspending
		// paths; "both recorded as active simultaneously" is not the intended
		// semantics here, even though the parent Task keeps running in memory.
		const parent = makeParent()
		const child = makeChild()
		let persistedParent: HistoryItem | undefined

		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent],
			taskScheduler: new TaskScheduler(2),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			taskHistoryStore: {
				get: vi.fn(() => undefined),
				atomicReadAndUpdate: vi.fn(async (_id: string, updater: (h: HistoryItem) => HistoryItem) => {
					persistedParent = updater({
						id: "parent-1",
						status: "active",
						childIds: [],
					} as unknown as HistoryItem)
					return persistedParent
				}),
			},
		})
		Object.assign(provider, { createTask: makeCreateTaskMock(provider, child) })

		await callDelegate(provider)

		expect(persistedParent?.status).toBe("delegated")
		expect(persistedParent?.awaitingChildId).toBe("child-1")
		// But the parent Task instance itself is still live and running in the registry.
		expect(getRunningTasks(provider).map((t) => t.taskId)).toContain("parent-1")
	})

	it("permit is reserved atomically at the fan-out decision — a concurrent delegation cannot steal the last free permit", async () => {
		// maxConcurrency=2, one permit already held by an unrelated running task,
		// leaving exactly one free — the contested permit.
		const scheduler = new TaskScheduler(2)
		void scheduler.schedule(makeParent({ taskId: "occupant" }), () => new Promise<void>(() => {}))
		await Promise.resolve()
		expect(scheduler.available).toBe(1)

		// Two reservation attempts race for the single remaining permit. Because
		// tryReserve() has no await before the underlying semaphore decrements
		// its count, only one can win even though both observe available === 1
		// beforehand.
		const [first, second] = await Promise.all([scheduler.tryReserve(), scheduler.tryReserve()])

		const wins = [first, second].filter((r) => r !== undefined)
		expect(wins).toHaveLength(1)
		expect(scheduler.available).toBe(0)
	})

	it("getRunningTasks() exposes all concurrently active tasks", () => {
		const parent = makeParent()
		const child = makeChild()
		const provider = makeProviderStub({
			...baseStubFields(parent),
			tasks: [parent, child],
			taskScheduler: new TaskScheduler(2),
		})

		expect(getRunningTasks(provider).map((t) => t.taskId)).toEqual(["parent-1", "child-1"])
	})
})

describe("ClineProvider.setTaskSchedulerMaxConcurrency()", () => {
	function setMaxConcurrency(provider: ClineProvider, maxConcurrency: number): void {
		ClineProvider.prototype.setTaskSchedulerMaxConcurrency.call(provider, maxConcurrency)
	}

	it("replaces the scheduler with one at the new maxConcurrency when no tasks are active", () => {
		const cancelQueued = vi.fn()
		const provider = makeProviderStub({
			tasks: [],
			taskScheduler: { cancelQueued, maxConcurrency: 1 } as unknown as TaskScheduler,
		})

		setMaxConcurrency(provider, 2)

		expect(cancelQueued).toHaveBeenCalledTimes(1)
		expect((provider as unknown as { taskScheduler: TaskScheduler }).taskScheduler.maxConcurrency).toBe(2)
	})

	it("throws and leaves the scheduler untouched if a task is active", () => {
		const cancelQueued = vi.fn()
		const originalScheduler = { cancelQueued, maxConcurrency: 1 } as unknown as TaskScheduler
		const provider = makeProviderStub({
			tasks: [makeParent()],
			taskScheduler: originalScheduler,
		})

		expect(() => setMaxConcurrency(provider, 2)).toThrow("Cannot change task scheduler concurrency")
		expect(cancelQueued).not.toHaveBeenCalled()
		expect((provider as unknown as { taskScheduler: TaskScheduler }).taskScheduler).toBe(originalScheduler)
	})

	it("rejects non-positive-integer values", () => {
		const provider = makeProviderStub({
			tasks: [],
			taskScheduler: new TaskScheduler(1),
		})

		expect(() => setMaxConcurrency(provider, 0)).toThrow("must be a positive integer")
		expect(() => setMaxConcurrency(provider, 1.5)).toThrow("must be a positive integer")
		expect(() => setMaxConcurrency(provider, -1)).toThrow("must be a positive integer")
	})
})
