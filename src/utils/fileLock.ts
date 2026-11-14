import * as path from "path"
import * as fsSync from "fs"
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
	/**
	 * An artefact spelling the caller captured before it started moving the leaf, used verbatim
	 * for this acquisition. A writer that renames the leaf as part of its own write must capture
	 * the spelling once, before the first rename, and hand it back here: re-deriving it after the
	 * rename names a different artefact for one file.
	 */
	artefactSpelling?: string
}

/**
 * The artefact a lock lives in: the caller's path with its nearest existing ancestor spelled
 * the way the volume spells it, plus ".lock". Nothing in the name comes from what the leaf
 * currently holds, because `safeWriteJson`'s EPERM fallback renames the leaf itself to a backup
 * mid-write: a name derived from the leaf at that moment belongs to whichever spelling the
 * volume happens to hold, so two writers that compute one identity take two artefacts and
 * contend with nobody. The second then acquires while the first still holds, runs its recovery
 * pass over the first writer's in-flight temp file, and the first fails its commit rename with
 * ENOENT. Only the nearest EXISTING ancestor is canonicalized and the components below it are
 * re-joined, which is what keeps the name computable while the leaf is absent or dangling. The
 * basename below that ancestor is compared as written, so two spellings of the file itself (an
 * 8.3 alias, a case variant on a case-insensitive volume) still take one artefact each: the
 * same residual the identity key carries, and a residual this function does not remove.
 */
export function lockArtefactSpelling(absoluteFilePath: string): string {
	const absolute = path.resolve(absoluteFilePath)
	const dirPath = path.dirname(absolute)
	let cursor = dirPath
	const missing: string[] = []
	for (;;) {
		let canonical: string | undefined
		try {
			canonical = fsSync.realpathSync.native(cursor)
		} catch {
			// An ancestor that is not there yet, or that cannot be inspected, says nothing about the
			// canonical spelling. Falling back to the caller's own parent is the conservative
			// direction here: it can only ever give a writer the same artefact it takes today, never a
			// second writer one it would not have taken.
			canonical = undefined
		}
		if (canonical !== undefined) {
			return path.join(canonical, ...missing.reverse(), path.basename(absolute)) + ".lock"
		}
		missing.push(path.basename(cursor))
		const parent = path.dirname(cursor)
		if (parent === cursor) {
			// Nothing on the path exists yet, so the caller's spelling is the only name left.
			return absolute + ".lock"
		}
		cursor = parent
	}
}

/**
 * Acquire the advisory lock for one file path using the exact protocol
 * `safeWriteJson` uses, so operations that hold this lock serialize with
 * every `safeWriteJson` write to the same path. Callers must release the
 * returned function exactly once and must not acquire the same lock again
 * while holding it.
 */
export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	const lockfilePath = options?.artefactSpelling ?? lockArtefactSpelling(absoluteFilePath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: absoluteFilePath })
	try {
		return await lockfile.lock(absoluteFilePath, {
			lockfilePath, // named by the caller's path and its canonical ancestor, never by what the leaf currently holds
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
