import * as fs from "fs"
import * as path from "path"
import { tracePersistenceEvent } from "../core/task-persistence/persistenceTrace"
import * as lockfile from "proper-lockfile"
import { canonicalLeafSpelling } from "./lockLeafSpelling"

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
		// BigInt stats, because the identity is a string and a plain number is not lossless: two
		// adjacent inodes above 2^53 are the same Number, so the numeric form can key two
		// neighbouring directories alike and let them share a lock nobody asked for.
		const stats = fs.statSync(target, { bigint: true })
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
 * The identity a lock is keyed on: the device and inode of the nearest directory that actually
 * exists, plus the components below it that do not exist yet. Aliasing at or above that directory
 * converges - an 8.3 alias of it, a link to it, and a case variant of it on a case-insensitive
 * volume all arrive at the same identity, because the identity is the directory's and only the
 * surviving components are compared. Aliasing OF THE FINAL COMPONENT does not: those components
 * are compared as the strings the caller wrote, so an 8.3 alias of the file itself, or a case
 * variant of it, arrives as a second key - and lockArtefactPath names the artefact by
 * concatenating that same spelling, so it arrives as a second artefact beside it, and two writers
 * that believe they hold the same lock do not. A canonical spelling cannot serve the general
 * case here: a leaf that does not exist yet has no canonical spelling, which is what the
 * `realpath: false` in `acquireFileLock` is there for. And nothing here rewrites a caller's path
 * - the key is for comparing locks, never for opening files - so the strings callers hand to
 * unlink and readFile stay the strings those callers built.
 */
export function canonicalLockKey(filePath: string): string {
	const absolute = path.resolve(filePath)
	const { directory, relative } = nearestExistingDirectory(absolute)
	const identity = statIdentity(directory)
	if (identity === null) {
		// Not even a root of the path exists yet, so there is no identity to key on and the
		// resolved path is the one thing every caller of it computes alike.
		return absolute
	}
	return identity + ":" + relative.join("/")
}

/**
 * Where the artefact lives: beside the file, named by the spelling the volume holds for that leaf,
 * so two spellings of one file contend with one another instead of each taking its own lock. The
 * key above is the identity, and the artefact stays a path, because `safeWriteJson` and the
 * interruption tests address `<file>.lock` directly - moving it is what made a green suite red, so
 * the location is pinned by a test rather than left to taste. Only the final component is
 * re-spelled: a caller that reaches the file through a junction or an 8.3 alias of a DIRECTORY
 * still gets the artefact inside that directory, because the re-spelling never moves the file.
 */
function lockArtefactPath(absolutePath: string): string {
	return canonicalLeafSpelling(absolutePath) + ".lock"
}

export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	const lockfilePath = lockArtefactPath(absoluteFilePath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: absoluteFilePath })
	try {
		return await lockfile.lock(canonicalLockKey(absoluteFilePath), {
			lockfilePath,
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
