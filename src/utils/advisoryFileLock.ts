import * as fs from "fs/promises"
import * as path from "path"
import * as lockfile from "proper-lockfile"

/**
 * How long a proper-lockfile lock may appear unrefreshed before it is treated
 * as stale by other processes. Writers refresh every 10s, so 31s leaves
 * headroom while still recovering from a crashed holder.
 */
export const LOCK_STALE_MS = 31_000

/** Retry configuration shape accepted by proper-lockfile's `retries` option. */
export interface AdvisoryFileLockRetryOptions {
	retries: number
	factor?: number
	minTimeout?: number
	maxTimeout?: number
}

/**
 * Default acquisition-retry budget, identical to the one safeWriteJson has
 * always used: a holder typically finishes in well under this window.
 */
const ADVISORY_LOCK_DEFAULT_RETRIES: AdvisoryFileLockRetryOptions = {
	retries: 5,
	factor: 2,
	minTimeout: 100,
	maxTimeout: 1000,
}

/**
 * Acquisition-retry budget for read-under-lock paths. Bounded, but long
 * enough to wait out an in-flight cross-process write (including its
 * temp/backup rename window) instead of misreading the file mid-write.
 */
export const ADVISORY_READ_LOCK_RETRIES: AdvisoryFileLockRetryOptions = {
	retries: 15,
	factor: 1.5,
	minTimeout: 100,
	maxTimeout: 500,
}

/**
 * Acquire the same inter-process advisory `proper-lockfile` lock that
 * `safeWriteJson` uses for `filePath`, run `fn` while holding it, and always
 * release the lock afterwards. This is the single lock-configuration owner:
 * writers and read-under-lock callers share it, so a reader can never observe
 * a write's temp-file rename gap and a writer can never race a strict reader.
 *
 * Lock-acquisition failures propagate to the caller (the lock was never
 * held). A failed release is logged and does not mask `fn`'s outcome,
 * matching safeWriteJson's historical release behavior.
 */
export async function withAdvisoryFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: { retries?: AdvisoryFileLockRetryOptions },
): Promise<T> {
	const absoluteFilePath = path.resolve(filePath)

	// proper-lockfile stores its lock beside the target path, so the
	// containing directory must exist before acquisition (safeWriteJson has
	// always ensured this up front; idempotent for readers).
	await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true })

	let releaseLock: () => Promise<void>
	try {
		releaseLock = await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: options?.retries ?? ADVISORY_LOCK_DEFAULT_RETRIES,
			onCompromised: (err) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
				throw err
			},
		})
	} catch (lockError) {
		// If lock acquisition fails, the lock was never held; propagate.
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		throw lockError
	}

	try {
		return await fn()
	} finally {
		try {
			await releaseLock()
		} catch (unlockError) {
			// Do not re-throw here: a failed unlock must never mask the
			// outcome of the work done under the lock.
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
	}
}
