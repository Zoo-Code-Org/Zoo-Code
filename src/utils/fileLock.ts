import * as path from "path"
import * as lockfile from "proper-lockfile"
import * as fs from "fs/promises"

/**
 * Shared staleness window for per-file advisory locks. This module owns the
 * single advisory lock protocol used by `safeWriteJson` and by callers that
 * must serialize with it, such as task-history deletion.
 */
export const LOCK_STALE_MS = 31_000

/**
 * Canonical lock key for a path.
 *
 * proper-lockfile derives its lock file from the path it is handed, and this module
 * turns off the library's own realpath step because the file may not exist yet. Two
 * callers that reach the same file by different routes - one lexical, one through a
 * symlinked directory - would then take DIFFERENT locks and silently lose updates
 * against each other, which is exactly how a task file written through a symlinked
 * task directory ends up unlocked against a task-history delete.
 *
 * The file itself may be absent (a create), so the nearest EXISTING ancestor is
 * canonicalized and the missing components are re-appended. If nothing can be
 * canonicalized the lexical absolute path is kept: lock keys stay stable and the
 * write's own resolution still decides where content lands.
 */
async function canonicalLockPath(filePath: string): Promise<string> {
	const absoluteFilePath = path.resolve(filePath)
	const missing: string[] = []
	let cursor = absoluteFilePath
	for (;;) {
		try {
			const realPath = await fs.realpath(cursor)
			return missing.length > 0 ? path.join(realPath, ...missing.reverse()) : realPath
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: string }).code
					: undefined
			if (code !== "ENOENT" && code !== "ENOTDIR") return absoluteFilePath
			const parent = path.dirname(cursor)
			if (parent === cursor) return absoluteFilePath
			missing.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Acquire the advisory lock for one file path using the exact protocol
 * `safeWriteJson` uses, so operations that hold this lock serialize with
 * every `safeWriteJson` write to the same path. Callers must release the
 * returned function exactly once and must not acquire the same lock again
 * while holding it.
 */
export async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	const absoluteFilePath = await canonicalLockPath(filePath)
	try {
		return await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: {
				// Configuration for retrying lock acquisition
				retries: 5, // Number of retries after the initial attempt
				factor: 2, // Exponential backoff factor (e.g., 100ms, 200ms, 400ms, ...)
				minTimeout: 100, // Minimum time to wait before the first retry (in ms)
				maxTimeout: 1000, // Maximum time to wait for any single retry (in ms)
			},
			onCompromised: (err) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
				throw err
			},
		})
	} catch (lockError) {
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		throw lockError
	}
}

/**
 * Run one operation while holding the advisory lock for a file path.
 * Callers must not acquire this lock again from inside `operation`, and
 * they must keep the documented lock order when combining this helper
 * with other locks to prevent deadlock.
 */
export async function withFileLock<T>(
	filePath: string,
	operation: (absoluteFilePath: string) => Promise<T>,
): Promise<T> {
	// The LOCK key is canonical, so a caller that reaches the file through a symlinked
	// directory and one that reaches it lexically contend for the same lock file. The
	// operation still receives the caller's own absolute path: on Windows realpath can
	// answer with the 8.3 short form (C:\Users\RUNNER~1\... for a temp dir under
	// C:\Users\runneradmin\...), and rewriting the path a caller unlinks or compares
	// would change behavior for every caller while adding nothing to the mutex.
	const operationPath = path.resolve(filePath)
	const releaseLock = await acquireFileLock(operationPath)

	let result: T
	try {
		result = await operation(operationPath)
	} catch (operationError) {
		// The operation error is the primary failure. Release without
		// reporting a secondary release error over it.
		try {
			await releaseLock()
		} catch (releaseError) {
			console.error(`Failed to release lock for ${operationPath}:`, releaseError)
		}
		throw operationError
	}

	try {
		await releaseLock()
	} catch (releaseError) {
		// The operation already succeeded, so a release failure is only
		// logged, matching how `safeWriteJson` handles release failures.
		console.error(`Failed to release lock for ${operationPath}:`, releaseError)
	}
	return result
}
