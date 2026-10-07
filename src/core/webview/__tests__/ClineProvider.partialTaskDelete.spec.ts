// npx vitest run core/webview/__tests__/ClineProvider.partialTaskDelete.spec.ts

import { ClineProvider } from "../ClineProvider"
import { TaskHistoryDeleteError } from "../../task-persistence"

/**
 * deleteTaskWithId batches the store deletions, and TaskHistoryStore.deleteMany attempts
 * every id even when one fails. The provider must therefore treat a TaskHistoryDeleteError
 * as a PARTIAL success: the ids it does not list are gone from the store, and leaving them
 * in the recent-task cache, the webview state, and on disk would contradict the store.
 */
function makeProvider(deleteMany: ReturnType<typeof vi.fn>) {
	const provider = {
		taskHistoryStore: { deleteMany },
		recentTasksCache: ["task-1", "task-2"],
		getTaskWithId: vi.fn(async (taskId: string) => ({
			taskDirPath: `/tmp/global/${taskId}`,
			historyItem: { id: taskId, childIds: taskId === "task-1" ? ["task-2"] : [] },
		})),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		removeTaskArtifacts: vi.fn().mockResolvedValue(undefined),
		deleteTaskFromState: vi.fn().mockResolvedValue(undefined),
		contextProxy: { globalStorageUri: { fsPath: "/tmp/global" } },
		cwd: "/tmp/workspace",
	} as unknown as ClineProvider
	return provider
}

describe("ClineProvider.deleteTaskWithId - partial batch failures", () => {
	it("cleans up the tasks that were deleted before rethrowing the batch failure", async () => {
		const partial = new TaskHistoryDeleteError(["task-2"], "unlink failed: EPERM")
		const deleteMany = vi.fn().mockRejectedValue(partial)
		const provider = makeProvider(deleteMany)

		await expect(ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")).rejects.toBe(partial)

		// The store no longer lists task-1, so the cache and the webview must stop listing it
		// and its artifacts must be removed even though the batch as a whole failed.
		expect((provider as unknown as { recentTasksCache?: string[] }).recentTasksCache).toBeUndefined()
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
		expect(provider.removeTaskArtifacts).toHaveBeenCalledTimes(1)
		expect(provider.removeTaskArtifacts).toHaveBeenCalledWith(["task-1"])
	})

	it("removes every artifact and posts state once when the batch succeeds", async () => {
		const deleteMany = vi.fn().mockResolvedValue(undefined)
		const provider = makeProvider(deleteMany)

		await ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")

		expect(provider.removeTaskArtifacts).toHaveBeenCalledWith(["task-1", "task-2"])
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("does not clean up artifacts when no task was deleted", async () => {
		const allFailed = new TaskHistoryDeleteError(["task-1", "task-2"], "lock acquisition failed")
		const deleteMany = vi.fn().mockRejectedValue(allFailed)
		const provider = makeProvider(deleteMany)

		await expect(ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")).rejects.toBe(allFailed)

		// Nothing was removed, so nothing may be cleaned up as if it had been.
		expect(provider.removeTaskArtifacts).toHaveBeenCalledWith([])
	})
})
