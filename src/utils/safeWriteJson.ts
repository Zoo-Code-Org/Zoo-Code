/* eslint-disable @typescript-eslint/no-explicit-any */
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

	// Acquire the lock before any file operations
	try {
		releaseLock = await lockfile.lock(absoluteFilePath, {
			stale: 31000, // Stale after 31 seconds
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: {
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

	try {
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
		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release the lock in the main finally block.
		try {
			// releaseLock will be the actual unlock function if lock was acquired,
			// or the initial no-op if acquisition failed.
			await releaseLock()
		} catch (unlockError) {
			// Do not re-throw here, as the originalError from the try/catch (if any) is more important.
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
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

/**
 * Options for safeUpdateJson function.
 */
export interface SafeUpdateJsonOptions extends SafeWriteJsonOptions {
	/**
	 * If true, and the target file does not exist, the initial state passed to
	 * the updater will be `undefined` and the updater must return the initial
	 * data to write. When false (default), a missing file is treated as an error.
	 * @default false
	 */
	allowCreate?: boolean
}

/**
 * Atomically read-modify-write a JSON file under an advisory lock.
 *
 * - If the file does not exist and `options.allowCreate` is `true`, the
 *   updater is called with `undefined` and must return the initial data.
 * - If the file does not exist and `options.allowCreate` is `false` (default),
 *   an error is thrown.
 * - If the file exists but cannot be parsed as JSON, the updater is not called
 *   and the original parse error is thrown.
 * - The updater runs synchronously while the lock is held; it must not perform
 *   I/O or acquire other locks.
 *
 * @param filePath - The absolute path to the target JSON file.
 * @param updater - A function that receives the current parsed data and returns
 *   the new data to write. If it throws, the file is left unchanged.
 * @param options - Optional configuration for create behavior and JSON formatting.
 * @returns A promise that resolves with the value returned by the updater.
 */
async function safeUpdateJson<T>(
	filePath: string,
	updater: (current: T | undefined) => T,
	options?: SafeUpdateJsonOptions,
): Promise<T> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {}

	const dirPath = path.dirname(absoluteFilePath)

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	try {
		releaseLock = await lockfile.lock(absoluteFilePath, {
			stale: 31000,
			update: 10000,
			realpath: false,
			retries: {
				retries: 5,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 1000,
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

	try {
		let current: T | undefined
		let fileExisted = false

		try {
			const raw = await fs.readFile(absoluteFilePath, "utf8")
			fileExisted = true
			current = JSON.parse(raw) as T
		} catch (readError: any) {
			if (readError.code !== "ENOENT") {
				throw readError
			}
		}

		if (!fileExisted && !options?.allowCreate) {
			throw new Error(`safeUpdateJson: file does not exist and allowCreate is false: ${absoluteFilePath}`)
		}

		const updated = updater(current)

		// Use the same atomic write path as safeWriteJson, but reuse the lock
		// we already hold. safeWriteJson would try to acquire the lock again,
		// so we inline the streaming write here.
		let actualTempNewFilePath: string | null = null
		let actualTempBackupFilePath: string | null = null

		try {
			actualTempNewFilePath = path.join(
				path.dirname(absoluteFilePath),
				`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
			)

			await _streamDataToFile(actualTempNewFilePath, updated, options?.prettyPrint)

			try {
				await fs.access(absoluteFilePath)
				actualTempBackupFilePath = path.join(
					path.dirname(absoluteFilePath),
					`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
				)
				await fs.rename(absoluteFilePath, actualTempBackupFilePath)
			} catch (accessError: any) {
				if (accessError.code !== "ENOENT") {
					throw accessError
				}
			}

			await fs.rename(actualTempNewFilePath, absoluteFilePath)
			actualTempNewFilePath = null

			if (actualTempBackupFilePath) {
				try {
					await fs.unlink(actualTempBackupFilePath)
					actualTempBackupFilePath = null
				} catch (unlinkBackupError) {
					console.error(
						`Successfully wrote ${absoluteFilePath}, but failed to clean up backup ${actualTempBackupFilePath}:`,
						unlinkBackupError,
					)
				}
			}
		} catch (writeError) {
			console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, writeError)

			const newFileToCleanupWithinCatch = actualTempNewFilePath
			const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

			if (backupFileToRollbackOrCleanupWithinCatch) {
				try {
					await fs.rename(backupFileToRollbackOrCleanupWithinCatch, absoluteFilePath)
					actualTempBackupFilePath = null
				} catch (rollbackError) {
					console.error(
						`[Catch] Failed to restore backup ${backupFileToRollbackOrCleanupWithinCatch} to ${absoluteFilePath}:`,
						rollbackError,
					)
				}
			}

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

			throw writeError
		}

		return updated
	} finally {
		try {
			await releaseLock()
		} catch (unlockError) {
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
	}
}

export { safeWriteJson, safeUpdateJson }
