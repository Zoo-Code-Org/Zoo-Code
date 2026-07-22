import * as fs from "fs/promises"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getStorageBasePath } from "../../utils/storage"

/**
 * Cross-process lock for task history mutations.
 *
 * Multiple `ClineProvider` instances may live in separate extension-host
 * processes (for example VS Code windows) while sharing the same task history
 * storage. Each process has its own `TaskHistoryStore`, so an in-memory mutex is
 * not sufficient. This lock serializes mutations by taking an exclusive advisory
 * lock on the shared `tasks/_history.lock` file.
 */
export class TaskHistoryLock {
	private queue: Promise<unknown> = Promise.resolve()

	/**
	 * Acquires the shared task-history lock and executes `fn` while holding it.
	 *
	 * The lock file is scoped to the effective storage root (including custom
	 * storage path resolution) so all windows/processes targeting the same history
	 * store contend on the same file.
	 */
	async withLock<T>(globalStoragePath: string, fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(
			async () => {
				const lockFilePath = await this.getLockFilePath(globalStoragePath)
				return this.runWithFileLock(lockFilePath, fn)
			},
			async () => {
				const lockFilePath = await this.getLockFilePath(globalStoragePath)
				return this.runWithFileLock(lockFilePath, fn)
			},
		)

		this.queue = result.then(
			() => undefined,
			() => undefined,
		)

		return result
	}

	/**
	 * Clears in-process queues. File locks held by other processes are not affected.
	 */
	reset(): void {
		this.queue = Promise.resolve()
	}

	async getLockFilePath(globalStoragePath: string): Promise<string> {
		const basePath = await getStorageBasePath(globalStoragePath)
		const tasksDir = path.join(basePath, "tasks")
		await fs.mkdir(tasksDir, { recursive: true })
		return path.join(tasksDir, GlobalFileNames.historyLock)
	}

	private async runWithFileLock<T>(lockFilePath: string, fn: () => Promise<T>): Promise<T> {
		let releaseLock: (() => Promise<void>) | undefined

		try {
			releaseLock = await lockfile.lock(lockFilePath, {
				stale: 31000,
				update: 10000,
				realpath: false,
				retries: {
					retries: 36,
					factor: 1,
					minTimeout: 1000,
					maxTimeout: 1000,
				},
				onCompromised: (err) => {
					console.error(`[TaskHistoryLock] Lock at ${lockFilePath} was compromised:`, err)
					throw err
				},
			})

			return await fn()
		} finally {
			if (releaseLock) {
				await releaseLock()
			}
		}
	}
}

// Singleton instance shared across all ClineProvider instances in this process.
export const taskHistoryLock = new TaskHistoryLock()
