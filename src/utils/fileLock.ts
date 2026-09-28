import * as path from "path"
import * as lockfile from "proper-lockfile"

export const LOCK_STALE_MS = 31_000

export async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	try {
		return await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10_000,
			realpath: false,
			retries: {
				retries: 5,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 1_000,
			},
			onCompromised: (error) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, error)
				throw error
			},
		})
	} catch (error) {
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, error)
		throw error
	}
}

/**
 * Run one operation while holding the advisory lock for a file path.
 * Callers must not acquire this lock again from inside `operation`.
 */
export async function withFileLock<T>(
	filePath: string,
	operation: (absoluteFilePath: string) => Promise<T>,
): Promise<T> {
	const absoluteFilePath = path.resolve(filePath)
	const releaseLock = await acquireFileLock(absoluteFilePath)

	try {
		return await operation(absoluteFilePath)
	} finally {
		try {
			await releaseLock()
		} catch (error) {
			console.error(`Failed to release lock for ${absoluteFilePath}:`, error)
		}
	}
}
