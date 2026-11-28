import * as path from "path"
import { tracePersistenceEvent } from "../core/task-persistence/persistenceTrace"
import * as lockfile from "proper-lockfile"

import { resolveRealPath } from "./WorkspacePathResolver"

/**
 * Shared staleness window for per-file advisory locks. This module owns the
 * single advisory lock protocol used by `safeWriteJson` and by callers that
 * must serialize with it, such as task-history deletion.
 */
export const LOCK_STALE_MS = 31_000

const RECOVERY_RETRY_MS = 1000
const RECOVERY_GRACE_MS = 4000

export interface FileLockOptions {
	/** Recovery may wait out a crashed writer's staleness window without stealing a live lock. */
	waitForStaleLock?: boolean
	/** Startup scans defer locked files instead of waiting under the store mutex. */
	immediate?: boolean
}

/**
 * Resolve the canonical path the advisory lock is keyed on.
 *
 * Locks must key on the referent, not the caller's alias: two writers reaching one file
 * through a symlinked ancestor would otherwise serialize on different locks and lose each
 * other's updates. resolveRealPath resolves the nearest existing ancestor, so a file that
 * does not exist yet under a symlinked directory still locks under the real directory. Case
 * folding is disabled because the result is used for filesystem operations, not comparisons.
 */
export async function resolveFileLockPath(filePath: string): Promise<string> {
	return resolveRealPath(path.resolve(filePath), { caseFold: false })
}

/**
 * Acquire the advisory lock for one file path using the exact protocol
 * `safeWriteJson` uses, so operations that hold this lock serialize with
 * every `safeWriteJson` write to the same path. Callers must release the
 * returned function exactly once and must not acquire the same lock again
 * while holding it.
 */
export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = await resolveFileLockPath(filePath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: absoluteFilePath })
	try {
		return await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: options?.immediate
				? 0
				: options?.waitForStaleLock
					? {
							retries: Math.ceil((LOCK_STALE_MS + RECOVERY_GRACE_MS) / RECOVERY_RETRY_MS),
							factor: 1,
							minTimeout: RECOVERY_RETRY_MS,
							maxTimeout: RECOVERY_RETRY_MS,
						}
					: {
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
	options?: FileLockOptions,
): Promise<T> {
	// The operation is handed the caller's own resolved spelling. Canonicalising here would give the
	// delete path a different string for one file whenever an 8.3 alias or a junctioned ancestor
	// is in play, and every comparison it makes against names it built from its own path - the
	// backup guard and the leftover-prefix match in jsonFileRecovery - is a string comparison.
	// The lock key and the artefact stay on resolveFileLockPath below, which is what makes an
	// alias and its referent contend; only the path the operation sees changes.
	const absoluteFilePath = path.resolve(filePath)
	const releaseLock = await acquireFileLock(absoluteFilePath, options)

	let result: T
	try {
		result = await operation(absoluteFilePath)
	} catch (operationError) {
		// The operation error is the primary failure. Release without
		// reporting a secondary release error over it.
		try {
			await releaseLock()
		} catch (releaseError) {
			console.error(`Failed to release lock for ${absoluteFilePath}:`, releaseError)
		}
		throw operationError
	}

	try {
		await releaseLock()
	} catch (releaseError) {
		// The operation already succeeded, so a release failure is only
		// logged, matching how `safeWriteJson` handles release failures.
		console.error(`Failed to release lock for ${absoluteFilePath}:`, releaseError)
	}
	return result
}
