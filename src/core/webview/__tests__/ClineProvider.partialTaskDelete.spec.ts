// npx vitest run core/webview/__tests__/ClineProvider.partialTaskDelete.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ClineProvider } from "../ClineProvider"
import { TaskHistoryDeleteError } from "../../task-persistence"

/**
 * deleteTaskWithId batches the store deletions, and TaskHistoryStore.deleteMany attempts
 * every id even when one fails, reporting the ones it could NOT remove. The provider must
 * therefore treat a TaskHistoryDeleteError as a PARTIAL success: the ids it does not list
 * are gone from the store, and leaving them in the recent-task cache, the posted webview
 * state, and on disk would contradict the store.
 */
async function makeFixture(deleteMany: ReturnType<typeof vi.fn>) {
	const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-task-delete-"))
	const taskDirs: Record<string, string> = {}
	for (const taskId of ["task-1", "task-2"]) {
		const dir = path.join(storageDir, "tasks", taskId)
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, "ui_messages.json"), "[]")
		taskDirs[taskId] = dir
	}
	const provider = {
		taskHistoryStore: { deleteMany },
		recentTasksCache: ["task-1", "task-2"],
		getTaskWithId: vi.fn(async (taskId: string) => ({
			taskDirPath: taskDirs[taskId],
			historyItem: { id: taskId, childIds: taskId === "task-1" ? ["task-2"] : [] },
		})),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		deleteTaskFromState: vi.fn().mockResolvedValue(undefined),
		contextProxy: { globalStorageUri: { fsPath: storageDir } },
		cwd: storageDir,
	} as unknown as ClineProvider
	return { provider, storageDir, taskDirs }
}

async function exists(dir: string): Promise<boolean> {
	try {
		await fs.access(dir)
		return true
	} catch {
		return false
	}
}

describe("ClineProvider.deleteTaskWithId - partial batch failures", () => {
	it("cleans up the tasks that were deleted before rethrowing the batch failure", async () => {
		const partial = new TaskHistoryDeleteError(["task-2"], "unlink failed: EPERM")
		const { provider, storageDir, taskDirs } = await makeFixture(vi.fn().mockRejectedValue(partial))

		try {
			await expect(ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")).rejects.toBe(partial)

			// The store no longer lists task-1, so its directory must be gone and the cache
			// and webview must stop listing it; task-2 is still in the store, so its
			// directory must survive.
			expect(await exists(taskDirs["task-1"])).toBe(false)
			expect(await exists(taskDirs["task-2"])).toBe(true)
			expect((provider as unknown as { recentTasksCache?: string[] }).recentTasksCache).toBeUndefined()
			expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
		} finally {
			await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("removes every artifact and posts state once when the batch succeeds", async () => {
		const { provider, storageDir, taskDirs } = await makeFixture(vi.fn().mockResolvedValue(undefined))

		try {
			await ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")

			expect(await exists(taskDirs["task-1"])).toBe(false)
			expect(await exists(taskDirs["task-2"])).toBe(false)
			expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
		} finally {
			await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("still cleans up the deleted tasks when the webview state post rejects", async () => {
		const partial = new TaskHistoryDeleteError(["task-2"], "unlink failed: EPERM")
		const { provider, storageDir, taskDirs } = await makeFixture(vi.fn().mockRejectedValue(partial))
		const stateError = new Error("webview is gone")
		provider.postStateToWebview = vi.fn().mockRejectedValue(stateError)

		try {
			// The batch error is what the caller must see, not the state-post failure.
			await expect(ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")).rejects.toBe(partial)

			// task-1 is gone from the store, so its artifacts must be gone too: cleaning
			// after the post would strand them whenever the post rejects.
			expect(await exists(taskDirs["task-1"])).toBe(false)
			expect(await exists(taskDirs["task-2"])).toBe(true)
		} finally {
			await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("leaves every artifact in place when no task was deleted", async () => {
		const allFailed = new TaskHistoryDeleteError(["task-1", "task-2"], "lock acquisition failed")
		const { provider, storageDir, taskDirs } = await makeFixture(vi.fn().mockRejectedValue(allFailed))

		try {
			await expect(ClineProvider.prototype.deleteTaskWithId.call(provider, "task-1")).rejects.toBe(allFailed)

			// Nothing was removed from the store, so nothing may be cleaned up as if it had been.
			expect(await exists(taskDirs["task-1"])).toBe(true)
			expect(await exists(taskDirs["task-2"])).toBe(true)
		} finally {
			await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {})
		}
	})
})
