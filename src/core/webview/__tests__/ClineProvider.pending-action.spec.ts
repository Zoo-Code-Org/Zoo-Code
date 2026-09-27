import type { HistoryItem, PendingTaskAction } from "@roo-code/types"

import { ClineProvider } from "../ClineProvider"

const pendingAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "action-1",
	approvalText: "{}",
	mode: "ask",
	message: "Child",
	todos: [],
}

function makeProvider(historyItem: HistoryItem) {
	let current = historyItem
	const atomicReadAndUpdate = vi.fn(async (_taskId: string, updater: (item: HistoryItem) => HistoryItem) => {
		current = updater(current)
		return [current]
	})
	const provider = {
		taskHistoryStore: { atomicReadAndUpdate },
		recentTasksCache: ["cached"],
	} as unknown as ClineProvider
	return { provider, atomicReadAndUpdate, current: () => current }
}

const historyItem = {
	id: "task-1",
	number: 1,
	ts: 1,
	task: "Task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
} satisfies HistoryItem

describe("ClineProvider pending task actions", () => {
	it("sets a pending action atomically and invalidates the recent-task cache", async () => {
		const { provider, atomicReadAndUpdate, current } = makeProvider(historyItem)

		await ClineProvider.prototype.setPendingTaskAction.call(provider, "task-1", pendingAction)

		expect(atomicReadAndUpdate).toHaveBeenCalledWith("task-1", expect.any(Function))
		expect(current().pendingAction).toEqual(pendingAction)
		expect((provider as unknown as { recentTasksCache?: string[] }).recentTasksCache).toBeUndefined()
	})

	it("clears only the matching action", async () => {
		const matching = makeProvider({ ...historyItem, pendingAction })

		await expect(
			ClineProvider.prototype.clearPendingTaskAction.call(matching.provider, "task-1", "action-1"),
		).resolves.toBe(true)
		expect(matching.current().pendingAction).toBeUndefined()

		const stale = makeProvider({ ...historyItem, pendingAction })
		await expect(
			ClineProvider.prototype.clearPendingTaskAction.call(stale.provider, "task-1", "stale-action"),
		).resolves.toBe(false)
		expect(stale.current().pendingAction).toEqual(pendingAction)
	})

	it("returns false when the task was deleted before clear", async () => {
		const provider = {
			taskHistoryStore: {
				atomicReadAndUpdate: vi
					.fn()
					.mockRejectedValue(
						new Error("[TaskHistoryStore] atomicReadAndUpdate: task task-1 not found in cache"),
					),
			},
		} as unknown as ClineProvider

		await expect(ClineProvider.prototype.clearPendingTaskAction.call(provider, "task-1", "action-1")).resolves.toBe(
			false,
		)
	})

	it("propagates unrelated store failures", async () => {
		const provider = {
			taskHistoryStore: { atomicReadAndUpdate: vi.fn().mockRejectedValue(new Error("disk unavailable")) },
		} as unknown as ClineProvider

		await expect(
			ClineProvider.prototype.clearPendingTaskAction.call(provider, "task-1", "action-1"),
		).rejects.toThrow("disk unavailable")
	})
})
