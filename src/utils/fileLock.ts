import * as path from "path"
import * as lockfile from "proper-lockfile"

export const LOCK_STALE_MS = 31_000

/**
 * Acquire the advisory lock shared by JSON writes and destructive mutations.
 * The target may not exist yet, so callers can use the same protocol for
 * creation, replacement, and deletion.
 */
export function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	return lockfile.lock(absoluteFilePath, {
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
}
