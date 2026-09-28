import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock, LOCK_STALE_MS } from "./fileLock"

/**
 * Options for safeWriteJson function
 */
export interface SafeWriteJsonOptions {
	/**
	 * Whether to create and verify the target file's parent directory.
	 * @default true
	 */
	createParentDirectory?: boolean

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

	/**
	 * Replace an existing target with one rename from the completed temporary file.
	 * A copied backup retains rollback support without removing the target before
	 * the replacement rename.
	 * @default false
	 */
	atomicReplace?: boolean
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

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	if (options?.createParentDirectory !== false) {
		// Ensure directory structure exists with improved reliability
		try {
			// Create directory with recursive option
			await fs.mkdir(dirPath, { recursive: true })

			// Verify directory exists after creation attempt
			await fs.access(dirPath)
		} catch (dirError: any) {
			console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
			throw dirError
		}
	}

	// Acquire the lock before any file operations
	try {
		releaseLock = await acquireFileLock(absoluteFilePath)
	} catch (lockError) {
		// If lock acquisition fails, we throw immediately.
		// The releaseLock remains a no-op, so the finally block in the main file operations
		// try-catch-finally won't try to release an unacquired lock if this path is taken.
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		// Propagate the lock acquisition error
		throw lockError
	}

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null
	let actualTempRollbackFilePath: string | null = null

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

		// Step 2: Check if the target file exists. If so, retain a rollback backup.
		try {
			await fs.access(absoluteFilePath)
			const candidateBackupFilePath = path.join(
				path.dirname(absoluteFilePath),
				`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
			)
			if (options?.atomicReplace) {
				await fs.copyFile(absoluteFilePath, candidateBackupFilePath)
			} else {
				await fs.rename(absoluteFilePath, candidateBackupFilePath)
			}
			actualTempBackupFilePath = candidateBackupFilePath
		} catch (accessError: any) {
			if (accessError.code !== "ENOENT") {
				throw accessError
			}
			actualTempBackupFilePath = null
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
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		const newFileToCleanupWithinCatch = actualTempNewFilePath
		const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

		// Attempt rollback if a backup was made
		if (backupFileToRollbackOrCleanupWithinCatch) {
			try {
				if (options?.atomicReplace) {
					actualTempRollbackFilePath = path.join(
						path.dirname(absoluteFilePath),
						`.${path.basename(absoluteFilePath)}.rollback_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
					)
					await fs.copyFile(backupFileToRollbackOrCleanupWithinCatch, actualTempRollbackFilePath)
					await fs.rename(actualTempRollbackFilePath, absoluteFilePath)
					actualTempRollbackFilePath = null
					await fs.unlink(backupFileToRollbackOrCleanupWithinCatch)
				} else {
					await fs.rename(backupFileToRollbackOrCleanupWithinCatch, absoluteFilePath)
				}
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

		// A failed rollback can leave an incomplete rollback copy. The completed backup remains available for recovery.
		if (actualTempRollbackFilePath) {
			try {
				await fs.unlink(actualTempRollbackFilePath)
				actualTempRollbackFilePath = null
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary rollback file ${actualTempRollbackFilePath}:`,
					cleanupError,
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

		// A copied backup remains available for recovery when atomic rollback fails.
		if (actualTempBackupFilePath && !options?.atomicReplace) {
			try {
				await fs.unlink(actualTempBackupFilePath)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary backup file ${actualTempBackupFilePath}:`,
					cleanupError,
				)
			}
		}
		// Release the lock before rejecting. The original write failure is the
		// rejection and a release failure cannot mask it.
		try {
			await releaseLock()
		} catch (unlockError) {
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
		throw originalError // This MUST be the error that rejects the promise.
	}

	// Release the lock on the success path. A compromised lock means this
	// write ran without mutual exclusion, so reject this operation instead
	// of reporting success.
	try {
		await releaseLock()
	} catch (unlockError) {
		const code =
			unlockError && typeof unlockError === "object" && "code" in unlockError
				? (unlockError as { code: unknown }).code
				: undefined
		if (code === "ECOMPROMISED") {
			throw unlockError
		}
		console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
	}
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

export { LOCK_STALE_MS, safeWriteJson }
