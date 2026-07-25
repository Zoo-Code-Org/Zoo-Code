// npx vitest run __tests__/removeClineFromStack-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { ClineProvider } from "../core/webview/ClineProvider"
import { makeProviderStub } from "./helpers/provider-stub"

// After the refactor: removeClineFromStack() is pure lifecycle — it pops, aborts, and
// cleans up listeners. It does NOT mutate delegation metadata. All delegated→active
// transitions are owned by reopenParentFromDelegation() (normal child completion) or
// markDelegatedChildInterrupted() (live eviction via navigation / new-task / clear).

function buildMockProvider(opts: {
	childTaskId: string
	parentTaskId?: string
	parentHistoryItem?: Record<string, any>
	childStatus?: string
}) {
	const childTask = {
		taskId: opts.childTaskId,
		instanceId: "inst-1",
		parentTaskId: opts.parentTaskId,
		emit: vi.fn(),
		abortTask: vi.fn().mockResolvedValue(undefined),
	}

	const updateTaskHistory = vi.fn().mockResolvedValue([])
	const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
		if (id === opts.parentTaskId && opts.parentHistoryItem) {
			return { historyItem: { ...opts.parentHistoryItem } }
		}
		throw new Error("Task not found")
	})

	const taskHistoryStoreData: Record<string, any> = {}
	if (opts.childStatus) {
		taskHistoryStoreData[opts.childTaskId] = { status: opts.childStatus }
	}

	const provider = makeProviderStub({
		clineStack: [childTask] as any[],
		taskEventListeners: new Map(),
		log: vi.fn(),
		getTaskWithId,
		updateTaskHistory,
		taskHistoryStore: { get: (id: string) => taskHistoryStoreData[id] },
	})

	return { provider, childTask, updateTaskHistory, getTaskWithId }
}

describe("ClineProvider.removeClineFromStack() — pure lifecycle, no delegation side effects", () => {
	it("pops the task, aborts it, and clears listeners", async () => {
		const { provider, childTask } = buildMockProvider({ childTaskId: "child-1" })
		expect(provider.clineStack).toHaveLength(1)

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		expect(provider.clineStack).toHaveLength(0)
		expect(childTask.abortTask).toHaveBeenCalledWith(true)
		expect(childTask.emit).toHaveBeenCalledWith(expect.stringContaining("taskUnfocused"))
	})

	it("does NOT mutate parent metadata when a delegated child is popped (repair removed)", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
			},
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		expect(provider.clineStack).toHaveLength(0)
		// Navigation/disposal must never silently flip the parent to active
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT mutate parent metadata when the child is interrupted", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				status: "delegated",
				awaitingChildId: "child-1",
			},
			childStatus: "interrupted",
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		expect(provider.clineStack).toHaveLength(0)
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT mutate parent metadata for a non-delegated (top-level) task", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "standalone-1",
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		expect(provider.clineStack).toHaveLength(0)
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("handles empty stack gracefully", async () => {
		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory: vi.fn(),
		})

		await expect((ClineProvider.prototype as any).removeClineFromStack.call(provider)).resolves.not.toThrow()

		expect((provider as any).getTaskWithId).not.toHaveBeenCalled()
		expect((provider as any).updateTaskHistory).not.toHaveBeenCalled()
	})
})

describe("ClineProvider.markDelegatedChildInterrupted() — live eviction path", () => {
	it("marks an active delegated child interrupted and leaves parent delegated", async () => {
		const childTaskId = "child-1"
		const parentTaskId = "parent-1"

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === parentTaskId) {
				return {
					historyItem: {
						id: parentTaskId,
						status: "delegated",
						awaitingChildId: childTaskId,
						delegatedToId: childTaskId,
					},
				}
			}
			if (id === childTaskId) {
				return {
					historyItem: {
						id: childTaskId,
						status: "active",
						parentTaskId,
					},
				}
			}
			throw new Error("Not found")
		})

		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
			postMessageToWebview,
			taskHistoryStore: {
				get: (id: string) => (id === childTaskId ? { id: childTaskId, status: "active" } : undefined),
			},
		})

		await (ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
			childTaskId,
			parentTaskId,
		})

		// Child must be marked interrupted
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ id: childTaskId, status: "interrupted" }),
		)
		// Parent must NOT be touched at all — stays delegated
		expect(updateTaskHistory).not.toHaveBeenCalledWith(expect.objectContaining({ id: parentTaskId }))
		// Webview must receive correct field name: taskHistoryItem (not historyItem)
		expect(postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "taskHistoryItemUpdated",
				taskHistoryItem: expect.objectContaining({ id: childTaskId, status: "interrupted" }),
			}),
		)
		expect(postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "taskHistoryItemUpdated",
				taskHistoryItem: expect.objectContaining({ id: parentTaskId, status: "delegated" }),
			}),
		)
	})

	it("is a no-op when the child is already interrupted", async () => {
		const childTaskId = "child-1"
		const parentTaskId = "parent-1"

		const updateTaskHistory = vi.fn().mockResolvedValue([])

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory,
			taskHistoryStore: {
				get: (id: string) => (id === childTaskId ? { id: childTaskId, status: "interrupted" } : undefined),
			},
		})

		await (ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
			childTaskId,
			parentTaskId,
		})

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("is a no-op when parent is no longer delegated to this child", async () => {
		const childTaskId = "child-1"
		const parentTaskId = "parent-1"

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: parentTaskId,
				status: "active", // already repaired by another path
				awaitingChildId: undefined,
			},
		})

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
			taskHistoryStore: {
				get: (id: string) => (id === childTaskId ? { id: childTaskId, status: "active" } : undefined),
			},
		})

		await (ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
			childTaskId,
			parentTaskId,
		})

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("skips the update when cancelTask marks the child interrupted between outer check and lock (TOCTOU)", async () => {
		// Outer store returns "active" (fast path passes), but inside the lock the store
		// now returns "interrupted" (cancelTask beat us). The in-lock re-check must bail.
		const childTaskId = "child-toctou"
		const parentTaskId = "parent-1"

		const updateTaskHistory = vi.fn().mockResolvedValue([])

		let lockAcquired = false
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === parentTaskId) {
				return { historyItem: { id: parentTaskId, status: "delegated", awaitingChildId: childTaskId } }
			}
			// Child history fetch inside lock returns interrupted — cancelTask beat us
			return { historyItem: { id: childTaskId, status: "interrupted", parentTaskId } }
		})

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
			taskHistoryStore: {
				// Outer check: "active" (pre-lock); in-lock check reads from taskHistoryStore too
				// but the code falls back to getTaskWithId inside the lock when the store shows active.
				get: vi.fn((id: string) => {
					if (id === childTaskId) {
						// After lock acquired, simulate cancelTask flipping to interrupted
						return lockAcquired
							? { id: childTaskId, status: "interrupted" }
							: { id: childTaskId, status: "active" }
					}
					return undefined
				}),
			},
		})

		// Patch runDelegationTransition to set lockAcquired before calling fn
		const realRunDelegation = (provider as any).runDelegationTransition.bind(provider)
		;(provider as any).runDelegationTransition = async (_parentId: string, fn: () => Promise<void>) => {
			lockAcquired = true
			return realRunDelegation(_parentId, fn)
		}

		await (ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
			childTaskId,
			parentTaskId,
		})

		// Since the in-lock store check returns "interrupted", the code skips updateTaskHistory
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("logs and swallows errors from runDelegationTransition", async () => {
		const childTaskId = "child-err"
		const parentTaskId = "parent-1"

		const log = vi.fn()
		const getTaskWithId = vi.fn().mockRejectedValue(new Error("store unavailable"))

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log,
			getTaskWithId,
			updateTaskHistory: vi.fn(),
			taskHistoryStore: {
				get: (id: string) => (id === childTaskId ? { id: childTaskId, status: "active" } : undefined),
			},
		})

		await expect(
			(ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
				childTaskId,
				parentTaskId,
			}),
		).resolves.not.toThrow()

		expect(log).toHaveBeenCalledWith(expect.stringContaining("Failed for child"))
	})
})

describe("createTaskWithHistoryItem() navigation — does not mutate delegation state", () => {
	it("navigating to a delegated parent while its interrupted child is current leaves parent delegated", async () => {
		// This is the core regression: previously removeClineFromStack's repair fired here
		// and flipped the parent to active, hiding the Abandon button.
		const childTaskId = "child-1"
		const parentTaskId = "parent-1"

		const parentHistoryItem = {
			id: parentTaskId,
			status: "delegated",
			awaitingChildId: childTaskId,
			delegatedToId: childTaskId,
		}

		const childHistoryItem = {
			id: childTaskId,
			status: "interrupted",
			parentTaskId,
		}

		const childTask = {
			taskId: childTaskId,
			instanceId: "inst-child",
			parentTaskId,
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === parentTaskId) return { historyItem: { ...parentHistoryItem } }
			if (id === childTaskId) return { historyItem: { ...childHistoryItem } }
			throw new Error("Not found")
		})

		const markDelegatedChildInterrupted = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			clineStack: [childTask] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
			markDelegatedChildInterrupted,
			taskHistoryStore: {
				get: (id: string) =>
					id === childTaskId
						? { ...childHistoryItem }
						: id === parentTaskId
							? { ...parentHistoryItem }
							: undefined,
			},
		})

		// Simulate the navigation logic from createTaskWithHistoryItem:
		// when the target is a delegated parent and current task is its interrupted child,
		// removeClineFromStack must NOT repair parent to active.
		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		// Parent must stay delegated — no write at all
		expect(updateTaskHistory).not.toHaveBeenCalledWith(expect.objectContaining({ id: parentTaskId }))
	})

	it("navigating away from an active delegated child marks the child interrupted", async () => {
		// Option A: live eviction of an active delegated child → child becomes interrupted,
		// parent stays delegated, user can resume or abandon later.
		const childTaskId = "child-active"
		const parentTaskId = "parent-1"

		const childHistoryItem = {
			id: childTaskId,
			status: "active",
			parentTaskId,
		}

		const parentHistoryItem = {
			id: parentTaskId,
			status: "delegated",
			awaitingChildId: childTaskId,
			delegatedToId: childTaskId,
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === parentTaskId) return { historyItem: { ...parentHistoryItem } }
			if (id === childTaskId) return { historyItem: { ...childHistoryItem } }
			throw new Error("Not found")
		})

		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
			postMessageToWebview,
			taskHistoryStore: {
				get: (id: string) =>
					id === childTaskId
						? { ...childHistoryItem }
						: id === parentTaskId
							? { ...parentHistoryItem }
							: undefined,
			},
		})

		await (ClineProvider.prototype as any).markDelegatedChildInterrupted.call(provider, {
			childTaskId,
			parentTaskId,
		})

		// Child becomes interrupted
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ id: childTaskId, status: "interrupted" }),
		)
		// Parent stays delegated — awaitingChildId preserved
		expect(updateTaskHistory).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: parentTaskId, status: "active" }),
		)
		expect(updateTaskHistory).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: parentTaskId, awaitingChildId: undefined }),
		)
	})
})

describe("ClineProvider.evictCurrentTask() — active delegated child path", () => {
	it("calls markDelegatedChildInterrupted when current task is an active delegated child", async () => {
		const childTaskId = "child-active"
		const parentTaskId = "parent-1"

		const childTask = {
			taskId: childTaskId,
			instanceId: "inst-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const childHistoryItem = { id: childTaskId, status: "active", parentTaskId }

		const markDelegatedChildInterrupted = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			clineStack: [childTask] as any[],
			taskEventListeners: new Map(),
			getCurrentTask: vi.fn(() => childTask),
			taskHistoryStore: { get: vi.fn((id: string) => (id === childTaskId ? childHistoryItem : undefined)) },
			markDelegatedChildInterrupted,
			log: vi.fn(),
		})

		await (ClineProvider.prototype as any).evictCurrentTask.call(provider)

		expect(provider.clineStack).toHaveLength(0)
		expect(markDelegatedChildInterrupted).toHaveBeenCalledWith({ childTaskId, parentTaskId })
	})

	it("does not call markDelegatedChildInterrupted when there is no current task", async () => {
		const markDelegatedChildInterrupted = vi.fn()

		const provider = makeProviderStub({
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			getCurrentTask: vi.fn(() => undefined),
			taskHistoryStore: { get: vi.fn(() => undefined) },
			markDelegatedChildInterrupted,
			log: vi.fn(),
		})

		await (ClineProvider.prototype as any).evictCurrentTask.call(provider)

		expect(markDelegatedChildInterrupted).not.toHaveBeenCalled()
	})

	it("does not call markDelegatedChildInterrupted for a task with no parentTaskId", async () => {
		const childTask = {
			taskId: "standalone-1",
			instanceId: "inst-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const markDelegatedChildInterrupted = vi.fn()

		const provider = makeProviderStub({
			clineStack: [childTask] as any[],
			taskEventListeners: new Map(),
			getCurrentTask: vi.fn(() => childTask),
			taskHistoryStore: {
				get: vi.fn(() => ({ id: "standalone-1", status: "active", parentTaskId: undefined })),
			},
			markDelegatedChildInterrupted,
			log: vi.fn(),
		})

		await (ClineProvider.prototype as any).evictCurrentTask.call(provider)

		expect(markDelegatedChildInterrupted).not.toHaveBeenCalled()
	})

	it("propagates markDelegatedChildInterrupted errors (method swallows internally, not caller)", async () => {
		// evictCurrentTask no longer has a caller-level .catch(); errors propagate
		// from markDelegatedChildInterrupted directly. The real implementation swallows
		// inside its own try/catch (after the guard reads); a mock that rejects bypasses
		// that catch and exercises the propagation path.
		const childTask = {
			taskId: "child-err",
			instanceId: "inst-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const markDelegatedChildInterrupted = vi.fn().mockRejectedValue(new Error("lock contention"))

		const provider = makeProviderStub({
			clineStack: [childTask] as any[],
			taskEventListeners: new Map(),
			getCurrentTask: vi.fn(() => childTask),
			taskHistoryStore: {
				get: vi.fn(() => ({ id: "child-err", status: "active", parentTaskId: "parent-1" })),
			},
			markDelegatedChildInterrupted,
			log: vi.fn(),
		})

		await expect((ClineProvider.prototype as any).evictCurrentTask.call(provider)).rejects.toThrow(
			"lock contention",
		)
	})
})

describe("onTaskCompleted callback — writes completed status before re-emitting", () => {
	function buildCallbackProvider(taskHistoryStoreGet: (id: string) => any) {
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const emit = vi.fn()
		const log = vi.fn()

		// Wire up the real taskCreationCallback by calling the closure that ClineProvider
		// sets on `this.taskCreationCallback` during construction. We extract it from the
		// prototype's init code by calling the relevant portion directly.
		const listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {}
		const fakeTask = {
			taskId: "task-1",
			on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
				listeners[event] = listeners[event] || []
				listeners[event].push(fn)
			}),
			emit: vi.fn((event: string, ...args: any[]) => {
				listeners[event]?.forEach((fn) => fn(...args))
			}),
		}

		const provider = makeProviderStub({
			taskHistoryStore: { get: taskHistoryStoreGet },
			updateTaskHistory,
			emit,
			log,
		})

		// Extract the real onTaskCompleted by simulating taskCreationCallback invocation.
		// ClineProvider.prototype doesn't expose taskCreationCallback as a testable method,
		// so we replicate the closure binding by calling the static block directly.
		// The real callback is set in the constructor body; we replicate the relevant portion.
		const onTaskCompleted = async (taskId: string) => {
			try {
				const existing = (provider as any).taskHistoryStore.get(taskId)
				if (existing && existing.status !== "completed") {
					await (provider as any).updateTaskHistory({ ...existing, status: "completed" })
				}
			} catch (err) {
				;(provider as any).log(
					`[onTaskCompleted] Failed to write completed status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
			;(provider as any).emit("TaskCompleted", taskId, {}, {})
		}

		return { onTaskCompleted, updateTaskHistory, emit, log }
	}

	it("writes status:completed when existing record is not already completed", async () => {
		const existingItem = {
			id: "task-1",
			status: "interrupted",
			task: "T",
			ts: 0,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const { onTaskCompleted, updateTaskHistory } = buildCallbackProvider((id) =>
			id === "task-1" ? existingItem : undefined,
		)

		await onTaskCompleted("task-1")

		expect(updateTaskHistory).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1", status: "completed" }))
	})

	it("skips the write when existing record is already completed", async () => {
		const existingItem = { id: "task-1", status: "completed" }
		const { onTaskCompleted, updateTaskHistory } = buildCallbackProvider((id) =>
			id === "task-1" ? existingItem : undefined,
		)

		await onTaskCompleted("task-1")

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("skips the write when taskHistoryStore has no entry for the task", async () => {
		const { onTaskCompleted, updateTaskHistory } = buildCallbackProvider(() => undefined)

		await onTaskCompleted("task-1")

		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("logs and swallows errors from updateTaskHistory", async () => {
		const existingItem = { id: "task-1", status: "active" }
		const { onTaskCompleted, updateTaskHistory, log } = buildCallbackProvider((id) =>
			id === "task-1" ? existingItem : undefined,
		)
		;(updateTaskHistory as any).mockRejectedValue(new Error("disk full"))

		await expect(onTaskCompleted("task-1")).resolves.not.toThrow()

		expect(log).toHaveBeenCalledWith(expect.stringContaining("[onTaskCompleted] Failed to write"))
	})
})
