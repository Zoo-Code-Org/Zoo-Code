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
 * - Atomically renames the temporary file over the target (a single rename,
 *   no backup step), so readers never observe a missing or partial file.
 * - Cleans up the temporary file in case of errors.
 * - Supports pretty-printing with indentation while maintaining streaming efficiency.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @param {SafeWriteJsonOptions} options - Optional configuration for JSON formatting.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: unknown, options?: SafeWriteJsonOptions): Promise<void> {
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
	} catch (dirError: unknown) {
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

	// Variable to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

	try {
		// Step 1: Write data to a new temporary file.
		actualTempNewFilePath = path.join(
			path.dirname(absoluteFilePath),
			`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// Step 2: Atomically replace the target file with the new file.
		// A single rename is atomic on POSIX and Windows (MoveFileEx with
		// MOVEFILE_REPLACE_EXISTING), so concurrent readers never observe a
		// missing file or a partially written file. No backup step is needed:
		// if the rename fails, the original file is left untouched.
		await fs.rename(actualTempNewFilePath, absoluteFilePath)

		// If we reach here, the new file is successfully in place.
		// The original actualTempNewFilePath is now the main file, so we shouldn't try to clean it up as "temp".
		// Mark as "used" or "committed"
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		// Cleanup the .new file if it exists
		if (actualTempNewFilePath) {
			try {
				await fs.unlink(actualTempNewFilePath)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary new file ${actualTempNewFilePath}:`,
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
async function _streamDataToFile(targetPath: string, data: unknown, prettyPrint = false): Promise<void> {
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
	} catch (dirError: unknown) {
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
		} catch (readError: unknown) {
			if ((readError as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
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

		try {
			actualTempNewFilePath = path.join(
				path.dirname(absoluteFilePath),
				`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
			)

			await _streamDataToFile(actualTempNewFilePath, updated, options?.prettyPrint)

			// Atomically replace the target file with the new file. A single
			// rename is atomic on POSIX and Windows, so readers never observe
			// a missing or partial file. No backup step is needed: if the
			// rename fails, the original file is left untouched.
			await fs.rename(actualTempNewFilePath, absoluteFilePath)
			actualTempNewFilePath = null
		} catch (writeError) {
			console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, writeError)

			// Cleanup the .new file if it exists
			if (actualTempNewFilePath) {
				try {
					await fs.unlink(actualTempNewFilePath)
				} catch (cleanupError) {
					console.error(
						`[Catch] Failed to clean up temporary new file ${actualTempNewFilePath}:`,
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
