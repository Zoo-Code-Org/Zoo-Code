import * as fs from "fs"
import * as path from "path"
import { tracePersistenceEvent } from "../core/task-persistence/persistenceTrace"
import * as lockfile from "proper-lockfile"

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
 * Acquire the advisory lock for one file path using the exact protocol
 * `safeWriteJson` uses, so operations that hold this lock serialize with
 * every `safeWriteJson` write to the same path. Callers must release the
 * returned function exactly once and must not acquire the same lock again
 * while holding it.
 */
function statIdentity(target: string): string | null {
	try {
		const stats = fs.statSync(target)
		return String(stats.dev) + ":" + String(stats.ino)
	} catch {
		return null
	}
}

/**
 * The nearest directory that actually exists on a path, so a write to a file that has
 * not been created yet can still be keyed by something the filesystem answers with.
 */
function nearestExistingDirectory(absolutePath: string): { directory: string; relative: string[] } {
	const relative: string[] = []
	let current = absolutePath
	while (path.dirname(current) !== current) {
		relative.unshift(path.basename(current))
		current = path.dirname(current)
		if (statIdentity(current) !== null) {
			return { directory: current, relative }
		}
	}
	return { directory: current, relative }
}

/**
 * The spelling a lock artefact should be created under: the canonical spelling of the
 * nearest existing directory, re-joined with the components that do not exist yet. This is
 * what makes an 8.3 alias and its long form take one lock, and it stays a spelling - the key
 * above is the identity, and callers that compare locks compare that.
 */
export function canonicalLockPath(filePath: string): string {
	const absolute = path.resolve(filePath)
	if (statIdentity(absolute) !== null) {
		try {
			return fs.realpathSync.native(absolute)
		} catch {
			return absolute
		}
	}
	const { directory, relative } = nearestExistingDirectory(absolute)
	let canonicalDirectory = directory
	try {
		canonicalDirectory = fs.realpathSync.native(directory)
	} catch {
		canonicalDirectory = directory
	}
	return relative.length === 0 ? canonicalDirectory : path.join(canonicalDirectory, ...relative)
}

export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = canonicalLockPath(filePath)
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
	const absoluteFilePath = canonicalLockPath(filePath)
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
