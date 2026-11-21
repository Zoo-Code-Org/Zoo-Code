import * as fs from "fs/promises"
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

/**
 * The advisory lock for a path is the filesystem artefact at this location.
 * proper-lockfile's default is `<filePath>.lock`; `acquireFileLock` below passes the
 * value explicitly so the two cannot drift apart, and `safeWriteJson`'s lock-key drift
 * guard answers "is this the same lock?" by comparing two artefacts. A caller that
 * derived the location on its own would be comparing something other than what this
 * module actually locks.
 */
export function lockPathFor(filePath: string): string {
	return path.resolve(filePath) + ".lock"
}
const RECOVERY_GRACE_MS = 4000

/**
 * Create the directory that holds a path's lock artefact, and report only the levels this
 * call actually created. proper-lockfile's own mkdir of the artefact is not recursive, so a
 * write into a directory that did not exist yet failed here with ENOENT - before the publish
 * primitive, and so before any rollback it would have owned - and left the empty tree behind.
 *
 * This asks the filesystem to create, and lets the answer say what was made: recursive mkdir
 * resolves with the first directory it actually created, and with nothing when every level
 * already existed. There is deliberately no fs.stat here. The task-persistence suites mock
 * fs.stat to reject for every path, and safeWriteJson.stagingDirectory.spec.ts pins that the
 * write must not start asking fs.stat questions about the directory it is allowed to write
 * into; a stat-driven walk would reintroduce exactly that question, and did.
 */
async function createLockDirectoryChain(lockfilePath: string): Promise<string[]> {
	const parent = path.dirname(lockfilePath)
	// Measured on this host, not inferred from the docs: Node reports the first directory it
	// created with an extended-length prefix (\\?\C:\...), so the answer is normalised before
	// it is compared with anything. Comparing it raw is what made a rollback reach above the
	// tree this call had built.
	const firstMade = await fs.mkdir(parent, { recursive: true })
	if (firstMade === undefined || firstMade === null) {
		return []
	}
	const made = path.resolve(withoutExtendedLengthPrefix(String(firstMade)))
	const tail = path.relative(made, parent)
	if (tail.startsWith("..")) {
		// The answer is not a location this call can account for; claim the parent and no
		// more, which is the conservative reading of "only what we created".
		return [parent]
	}
	const chain: string[] = [made]
	let cursor = made
	if (tail !== "") {
		for (const segment of tail.split(path.sep)) {
			cursor = path.join(cursor, segment)
			chain.push(cursor)
		}
	}
	return chain
}

/** Strip the extended-length prefix Node reports on Windows, leaving other paths alone. */
function withoutExtendedLengthPrefix(candidate: string): string {
	if (candidate.startsWith("\\\\?\\UNC\\")) {
		return "\\\\" + candidate.slice(8)
	}
	if (candidate.startsWith("\\\\?\\")) {
		return candidate.slice(4)
	}
	return candidate
}
/**
 * Undo the directories a failed acquisition created, deepest first and best-effort. A
 * directory somebody else populated is not this call's to take away, and a rollback
 * failure must not arrive dressed as the error that caused the rollback.
 */
async function removeCreatedDirectories(created: string[]): Promise<void> {
	for (let index = created.length - 1; index >= 0; index--) {
		try {
			await fs.rmdir(created[index])
		} catch (rollbackError: unknown) {
			// Includes ENOTEMPTY: the directory is in use, which is a reason to leave it,
			// not a reason to report a second failure over the first.
			void rollbackError
		}
	}
}

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
export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: absoluteFilePath })
	const lockfilePath = lockPathFor(absoluteFilePath)
	// Created before the lock is taken, and removed again only if the acquisition
	// fails: see createLockDirectoryChain. A failure here is rolled back before it is
	// reported, so a refused write does not litter the tree it refused to enter.
	let created: string[] = []
	try {
		created = await createLockDirectoryChain(lockfilePath)
	} catch (mkdirError: unknown) {
		await removeCreatedDirectories(created)
		console.error(`Failed to prepare the lock directory for ${absoluteFilePath}:`, mkdirError)
		throw mkdirError
	}
	try {
		return await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			lockfilePath,
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
	} catch (lockError: unknown) {
		// The parent directories this call made are the only state it
		// owns at this point; give them back, then report the acquisition failure unchanged.
		await removeCreatedDirectories(created)
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
