import * as path from "path"
import * as lockfile from "proper-lockfile"

export const LOCK_STALE_MS = 31_000

export async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	// proper-lockfile calls `onCompromised` from its renewal timer after the
	// lock promise already resolved. A throw here becomes an uncaught
	// exception in the host instead of a rejection, so record the error and
	// fail the owning operation through its release call instead.
	let compromisedError: Error | null = null
	try {
		const release = await lockfile.lock(absoluteFilePath, {
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
				compromisedError = error
			},
		})
		return async () => {
			if (compromisedError) {
				// proper-lockfile marks the lock released when it reports a
				// compromise and its own release resolves silently, so reject
				// with the recorded compromise error here.
				throw compromisedError
			}
			await release()
		}
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
		const code =
			releaseError && typeof releaseError === "object" && "code" in releaseError
				? (releaseError as { code: unknown }).code
				: undefined
		if (code === "ECOMPROMISED") {
			// The lock was compromised while this operation held it, so the
			// operation ran without mutual exclusion. Reject the operation
			// that owns the lock instead of reporting success.
			throw releaseError
		}
		console.error(`Failed to release lock for ${absoluteFilePath}:`, releaseError)
	}
	return result
}
