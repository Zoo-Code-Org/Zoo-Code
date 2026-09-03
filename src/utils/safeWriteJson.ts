import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import { JsonStreamStringify } from "json-stream-stringify"

/**
 * Options for safeWriteJson function
 */
export interface SafeWriteJsonOptions {
	/**
	 * Whether to pretty-print the JSON output with indentation.
	 * When true, uses tab characters for indentation.
	 * When false or undefined, outputs compact JSON.
	 * @default false
	 */
	prettyPrint?: boolean

	/**
	 * When provided, the current file is read under the advisory lock
	 * and passed to this function along with the incoming data. The
	 * return value replaces `data` for the write. This turns a blind
	 * overwrite into an atomic read-modify-write, preventing cross-process
	 * lost updates. `existing` is null when the file does not exist or
	 * cannot be parsed.
	 */
	merge?: (existing: unknown, incoming: unknown) => unknown

	/** The caller already holds this file's lock. Internal use only. */
	lockAcquired?: boolean
}

export async function lockJsonFile(filePath: string): Promise<() => Promise<void>> {
	const absoluteFilePath = path.resolve(filePath)
	const dirPath = path.dirname(absoluteFilePath)
	let compromisedError: Error | undefined

	await fs.mkdir(dirPath, { recursive: true })
	await fs.access(dirPath)

	const release = await lockfile.lock(absoluteFilePath, {
		stale: LOCK_STALE_MS,
		update: 10000,
		realpath: false,
		retries: {
			retries: 5,
			factor: 2,
			minTimeout: 100,
			maxTimeout: 1000,
		},
		onCompromised: (err) => {
			if (!compromisedError) {
				compromisedError = err
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
			}
		},
	})

	return async () => {
		try {
			await release()
		} catch (releaseError) {
			if (!compromisedError) throw releaseError
			console.error(`Failed to release compromised lock for ${absoluteFilePath}:`, releaseError)
		}

		if (compromisedError) throw compromisedError
	}
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Writes to a temporary file first.
 * - If the target file exists, it's backed up before being replaced.
 * - Attempts to roll back and clean up in case of errors.
 * - Supports pretty-printing with indentation while maintaining streaming efficiency.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @param {SafeWriteJsonOptions} options - Optional configuration for JSON formatting.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: any, options?: SafeWriteJsonOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {} // Initialized to a no-op
	let operationFailed = false
	let operationError: unknown
	let unlockFailed = false
	let unlockError: unknown

	if (!options?.lockAcquired) {
		try {
			releaseLock = await lockJsonFile(absoluteFilePath)
		} catch (lockError) {
			console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
			throw lockError
		}
	}

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null

	try {
		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write. Must be inside try/finally
		// so a throwing merge still releases the lock.
		if (options?.merge) {
			let existing: unknown = null
			try {
				existing = JSON.parse(await fs.readFile(absoluteFilePath, "utf8"))
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error ? (error as { code: string }).code : undefined
				if (!(error instanceof SyntaxError) && code !== "ENOENT") {
					throw error
				}
			}
			data = options.merge(existing, data)
		}

		// Step 1: Write data to a new temporary file.
		actualTempNewFilePath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// Step 2: Check if the target file exists. If so, rename it to a backup path.
		try {
			// Check for target file existence
			await fs.access(absoluteFilePath)
			// Target exists, create a backup path and rename.
			actualTempBackupFilePath = path.join(
				path.dirname(absoluteFilePath),
				`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
			)
			await fs.rename(absoluteFilePath, actualTempBackupFilePath)
		} catch (accessError: any) {
			// Explicitly type accessError
			if (accessError.code !== "ENOENT") {
				// An error other than "file not found" occurred during access check.
				throw accessError
			}
			// Target file does not exist, so no backup is made. actualTempBackupFilePath remains null.
		}

		// Step 3: Rename the new temporary file to the target file path.
		// This is the main "commit" step.
		await fs.rename(actualTempNewFilePath, absoluteFilePath)

		// If we reach here, the new file is successfully in place.
		// The original actualTempNewFilePath is now the main file, so we shouldn't try to clean it up as "temp".
		// Mark as "used" or "committed"
		actualTempNewFilePath = null

		// Step 4: If a backup was created, attempt to delete it.
		if (actualTempBackupFilePath) {
			try {
				await fs.unlink(actualTempBackupFilePath)
				// Mark backup as handled
				actualTempBackupFilePath = null
			} catch (unlinkBackupError) {
				// Log this error, but do not re-throw. The main operation was successful.
				// actualTempBackupFilePath remains set, indicating an orphaned backup.
				console.error(
					`Successfully wrote ${absoluteFilePath}, but failed to clean up backup ${actualTempBackupFilePath}:`,
					unlinkBackupError,
				)
			}
		}
	} catch (originalError) {
		operationFailed = true
		operationError = originalError
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		const newFileToCleanupWithinCatch = actualTempNewFilePath
		const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

		// Attempt rollback if a backup was made
		if (backupFileToRollbackOrCleanupWithinCatch) {
			try {
				await fs.rename(backupFileToRollbackOrCleanupWithinCatch, absoluteFilePath)
				// Mark as handled, prevent later unlink of this path
				actualTempBackupFilePath = null
			} catch (rollbackError) {
				// actualTempBackupFilePath (outer scope) remains pointing to backupFileToRollbackOrCleanupWithinCatch
				console.error(
					`[Catch] Failed to restore backup ${backupFileToRollbackOrCleanupWithinCatch} to ${absoluteFilePath}:`,
					rollbackError,
				)
			}
		}

		// Cleanup the .new file if it exists
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary new file ${newFileToCleanupWithinCatch}:`,
					cleanupError,
				)
			}
		}

		// Cleanup the .bak file if it still needs to be (i.e., wasn't successfully restored)
		if (actualTempBackupFilePath) {
			try {
				await fs.unlink(actualTempBackupFilePath)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary backup file ${actualTempBackupFilePath}:`,
					cleanupError,
				)
			}
		}
	} finally {
		// Release the lock in the main finally block.
		try {
			// releaseLock will be the actual unlock function if lock was acquired,
			// or the initial no-op if acquisition failed.
			await releaseLock()
		} catch (error) {
			unlockFailed = true
			unlockError = error
			if (operationFailed) console.error(`Failed to release lock for ${absoluteFilePath}:`, error)
		}
	}

	if (operationFailed) throw operationError
	if (unlockFailed) throw unlockError
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @param prettyPrint Whether to format the JSON with indentation.
 * @returns Promise<void>
 */
async function _streamDataToFile(targetPath: string, data: any, prettyPrint = false): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8" })

	// JsonStreamStringify traverses the object and streams tokens directly
	// The 'spaces' parameter adds indentation during streaming, not via a separate pass
	// Convert undefined to null for valid JSON serialization (undefined is not valid JSON)
	const stringifyStream = new JsonStreamStringify(
		data === undefined ? null : data,
		undefined, // replacer
		prettyPrint ? "\t" : undefined, // spaces for indentation
	)

	return new Promise<void>((resolve, reject) => {
		stringifyStream.on("error", reject)
		fileWriteStream.on("error", reject)
		fileWriteStream.on("finish", resolve)
		stringifyStream.pipe(fileWriteStream)
	})
}

export const LOCK_STALE_MS = 31_000

export { safeWriteJson }
