// npx vitest run __tests__/abandonSubtask.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { HistoryItem } from "@roo-code/types"

import { ClineProvider } from "../core/webview/ClineProvider"
import { makeProviderStub } from "./helpers/provider-stub"

/**
 * Minimal taskHistoryStore stub whose atomicUpdatePair calls both updaters
 * against an in-memory item map and resolves, simulating the happy-path atomic write.
 */
function makeTaskHistoryStoreStub(childItem: Record<string, any>, parentItem: Record<string, any>) {
	const itemMap = new Map<string, Partial<HistoryItem>>([
		[childItem.id!, childItem],
		[parentItem.id!, parentItem],
	])

	const atomicUpdatePair = vi.fn(
		async (
			firstId: string,
			secondId: string,
			firstUpdater: (h: HistoryItem) => HistoryItem,
			secondUpdater: (h: HistoryItem) => HistoryItem,
		) => {
			itemMap.set(firstId, firstUpdater(itemMap.get(firstId) as HistoryItem))
			itemMap.set(secondId, secondUpdater(itemMap.get(secondId) as HistoryItem))
			return []
		},
	)

	return {
		atomicUpdatePair,
		get: vi.fn((id: string) => itemMap.get(id)),
	}
}

describe("ClineProvider.abandonSubtask()", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("severs the link: parent → active (awaitingChildId/delegatedToId cleared), child loses parentTaskId/rootTaskId", async () => {
		const childHistoryItem = {
			id: "child-1",
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			ts: Date.now(),
			task: "Child task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
			childIds: ["child-1"],
			ts: Date.now(),
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)

		const provider = makeProviderStub({
			getTaskWithId,
			getCurrentTask: vi.fn(() => undefined),
			taskHistoryStore,
			isViewLaunched: true,
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		} as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(true)
		expect(taskHistoryStore.atomicUpdatePair).toHaveBeenCalledTimes(1)
		const [firstId, secondId] = taskHistoryStore.atomicUpdatePair.mock.calls[0]
		expect(firstId).toBe("child-1")
		expect(secondId).toBe("parent-1")

		const updatedChild = taskHistoryStore.get("child-1")
		expect(updatedChild).toEqual(
			expect.objectContaining({
				id: "child-1",
				status: "interrupted",
				parentTaskId: undefined,
				rootTaskId: undefined,
			}),
		)

		const updatedParent = taskHistoryStore.get("parent-1")
		expect(updatedParent).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				awaitingChildId: undefined,
				delegatedToId: undefined,
			}),
		)

		// Guarded against a stale in-flight completion reattaching the child.
		expect((provider as any).cancelledDelegationChildIds.has("child-1")).toBe(true)

		// Both updated items broadcast to the webview with the actual severed-link field values,
		// not just matching IDs — a stale/pre-abandon payload would still match an id-only assertion.
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskHistoryItemUpdated",
			taskHistoryItem: expect.objectContaining({
				id: "child-1",
				status: "interrupted",
				parentTaskId: undefined,
				rootTaskId: undefined,
			}),
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "taskHistoryItemUpdated",
			taskHistoryItem: expect.objectContaining({
				id: "parent-1",
				status: "active",
				awaitingChildId: undefined,
				delegatedToId: undefined,
			}),
		})
	})

	it("closes the live child instance before severing the link, so a later save cannot reattach it", async () => {
		// An interrupted child is commonly still the live/open task (cancelTask rehydrates it
		// onto the stack). If abandon doesn't close it first, Task#saveClineMessages() would
		// rebuild parentTaskId/rootTaskId from the live task's readonly fields on its next save
		// and silently reattach the child. removeClineFromStack() must run before atomicUpdatePair.
		const childHistoryItem = {
			id: "child-1",
			status: "interrupted",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			ts: Date.now(),
			task: "Child task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
			childIds: ["child-1"],
			ts: Date.now(),
			task: "Parent task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			getTaskWithId,
			getCurrentTask: vi.fn(() => ({ taskId: "child-1" })),
			removeClineFromStack,
			taskHistoryStore,
			isViewLaunched: false,
		} as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(true)
		expect(removeClineFromStack).toHaveBeenCalledWith()
		// The live child must be closed before the persisted link is severed.
		const closeCallOrder = removeClineFromStack.mock.invocationCallOrder[0]
		const atomicCallOrder = taskHistoryStore.atomicUpdatePair.mock.invocationCallOrder[0]
		expect(closeCallOrder).toBeLessThan(atomicCallOrder)
	})

	it("does not attempt to close the live instance when the child is not the current task", async () => {
		const childHistoryItem = { id: "child-1", status: "interrupted", parentTaskId: "parent-1" }
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)

		const provider = makeProviderStub({
			getTaskWithId,
			getCurrentTask: vi.fn(() => ({ taskId: "some-other-task" })),
			removeClineFromStack,
			taskHistoryStore,
			isViewLaunched: false,
		} as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(true)
		expect(removeClineFromStack).not.toHaveBeenCalled()
	})

	it("returns false and does not modify state when the child is not interrupted (e.g. still active)", async () => {
		const childHistoryItem = { id: "child-1", status: "active", parentTaskId: "parent-1" }
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const provider = makeProviderStub({ getTaskWithId, taskHistoryStore } as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(false)
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("returns false when the child completes between the initial check and lock acquisition (TOCTOU)", async () => {
		// The initial status check reads the child as interrupted, but by the time the
		// per-parent lock is acquired, a concurrent resume-and-complete has already
		// transitioned it. The in-lock re-check must catch this and bail out.
		const childHistoryItem = { id: "child-1", status: "interrupted", parentTaskId: "parent-1" }
		const parentHistoryItem = {
			id: "parent-1",
			status: "delegated",
			awaitingChildId: "child-1",
			delegatedToId: "child-1",
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore: any = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		// Simulate the concurrent completion landing right before the in-lock re-check runs.
		taskHistoryStore.get = vi.fn((id: string) =>
			id === "child-1" ? { ...childHistoryItem, status: "completed" as const } : parentHistoryItem,
		)

		const provider = makeProviderStub({ getTaskWithId, taskHistoryStore } as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(false)
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("returns false and does not modify state when the child has no parentTaskId", async () => {
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { id: "standalone-1", status: "active" } })
		const provider = makeProviderStub({ getTaskWithId } as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "standalone-1")

		expect(result).toBe(false)
	})

	it("returns false and does not touch history when parent is no longer delegated to this child", async () => {
		const childHistoryItem = { id: "child-1", status: "interrupted", parentTaskId: "parent-1" }
		const parentHistoryItem = { id: "parent-1", status: "active", awaitingChildId: undefined }

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const provider = makeProviderStub({ getTaskWithId, taskHistoryStore } as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(false)
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})

	it("returns false when awaitingChildId points at a different child", async () => {
		const childHistoryItem = { id: "child-1", status: "interrupted", parentTaskId: "parent-1" }
		const parentHistoryItem = { id: "parent-1", status: "delegated", awaitingChildId: "child-OTHER" }

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "child-1") return { historyItem: childHistoryItem }
			if (id === "parent-1") return { historyItem: parentHistoryItem }
			throw new Error("Task not found")
		})

		const taskHistoryStore = makeTaskHistoryStoreStub(childHistoryItem, parentHistoryItem)
		const provider = makeProviderStub({ getTaskWithId, taskHistoryStore } as any)

		const result = await (ClineProvider.prototype as any).abandonSubtask.call(provider, "child-1")

		expect(result).toBe(false)
		expect(taskHistoryStore.atomicUpdatePair).not.toHaveBeenCalled()
	})
})
