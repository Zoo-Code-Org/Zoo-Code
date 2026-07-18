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
