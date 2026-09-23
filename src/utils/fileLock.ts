import * as path from "path"
import * as lockfile from "proper-lockfile"

export const LOCK_STALE_MS = 31_000

/**
 * Retry budget for destructive mutations. The backoff outlasts
 * LOCK_STALE_MS, so a lock left behind by a crashed process is broken
 * within the same acquisition instead of failing the mutation.
 */
export const DESTRUCTIVE_LOCK_RETRIES = {
	retries: 36,
	factor: 2,
	minTimeout: 100,
	maxTimeout: 1_000,
}

export interface AcquiredFileLock {
	release: () => Promise<void>
	/**
	 * True once proper-lockfile reported the held lock compromised, for
	 * example when another host's stale-lock recovery removed the lock
	 * directory. Callers must check this before mutating the protected
	 * target and fail the operation instead of writing without exclusion.
	 */
	isCompromised: () => boolean
}

/**
 * Fail with one deterministic error when the held lock was reported
 * compromised, so the caller aborts before the next mutation of the
 * protected target instead of writing or deleting without exclusion.
 */
export function assertLockUsable(lock: AcquiredFileLock, targetPath: string, action: string): void {
	if (lock.isCompromised()) {
		throw new Error(`Lock for ${targetPath} was compromised before ${action}`)
	}
}

export interface AcquireFileLockOptions {
	retries?: lockfile.LockOptions["retries"]
}

/**
 * Acquire the advisory lock shared by JSON writes and destructive mutations.
 * The target may not exist yet, so callers can use the same protocol for
 * creation, replacement, and deletion.
 */
export function acquireFileLock(filePath: string, options?: AcquireFileLockOptions): Promise<AcquiredFileLock> {
	const absoluteFilePath = path.resolve(filePath)
	let compromised = false
	return lockfile
		.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10_000,
			realpath: false,
			retries: options?.retries ?? {
				retries: 5,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 1_000,
			},
			// proper-lockfile invokes this from a timer callback after
			// acquisition, so a throw here never reaches the awaited operation.
			// Record the state instead; callers check isCompromised before
			// mutating and fail the operation themselves.
			onCompromised: (error) => {
				compromised = true
				console.error(`Lock at ${absoluteFilePath} was compromised:`, error)
			},
		})
		.then((release) => ({ release, isCompromised: () => compromised }))
}
