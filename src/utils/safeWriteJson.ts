import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock, assertLockUsable, LOCK_STALE_MS } from "./fileLock"

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
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Removes leftover temp files for this target left by a crashed writer.
 * - Writes to a temporary file first, then replaces the target with one
 *   atomic rename, so the target is never missing between the two states.
 * - Cleans up the temporary file in case of errors.
 * - Aborts before orphan cleanup and before replacing the target when the
 *   advisory lock was compromised, so it never writes or deletes without
 *   exclusion.
 * - Supports pretty-printing with indentation while maintaining streaming efficiency.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @param {SafeWriteJsonOptions} options - Optional configuration for JSON formatting.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: any, options?: SafeWriteJsonOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists
	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: unknown) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Acquire the lock before any file operations. On failure the release
	// helper stays unused and the error propagates.
	let lock: Awaited<ReturnType<typeof acquireFileLock>>
	try {
		lock = await acquireFileLock(absoluteFilePath)
	} catch (lockError) {
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		throw lockError
	}

	// Path of the temporary file while it exists, so the error path can clean it up.
	let actualTempNewFilePath: string | null = null

	try {
		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write.
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

		// A compromised lock no longer excludes a peer writer, so its temp
		// files are not orphans. Abort before discovery and again before
		// each removal instead of deleting a live writer's temp files.
		assertLockUsable(lock, absoluteFilePath, "orphan cleanup")
		await removeLeftoverTempFiles(dirPath, path.basename(absoluteFilePath), () =>
			assertLockUsable(lock, absoluteFilePath, "orphan cleanup"),
		)

		// Step 1: Write data to a new temporary file.
		actualTempNewFilePath = path.join(
			dirPath,
			`.${path.basename(absoluteFilePath)}.new_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
		)

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// A compromised lock means another host may be mutating the target.
		// Fail here instead of replacing the target without exclusion.
		assertLockUsable(lock, absoluteFilePath, "commit")

		// Step 2: Replace the target with one atomic rename. The target holds
		// either the old content or the new content at every instant, so a
		// crash cannot leave it missing.
		await fs.rename(actualTempNewFilePath, absoluteFilePath)
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(`Operation failed for ${absoluteFilePath}:`, originalError)

		if (actualTempNewFilePath) {
			try {
				await fs.unlink(actualTempNewFilePath)
			} catch (cleanupError) {
				console.error(`[Catch] Failed to clean up temporary new file ${actualTempNewFilePath}:`, cleanupError)
			}
		}

		throw originalError
	} finally {
		// Release the lock in the main finally block.
		try {
			await lock.release()
		} catch (unlockError) {
			// Do not re-throw here, as the originalError from the try/catch (if any) is more important.
			console.error(`Failed to release lock for ${absoluteFilePath}:`, unlockError)
		}
	}
}

/**
 * Remove leftover `.<target>.new_*.tmp` and `.<target>.bak_*.tmp` files.
 * Safe while the caller holds the advisory lock for `targetBasename`.
 * @param dirPath The directory holding the target file.
 * @param targetBasename The target file's base name.
 * @param assertLockUsable Called before each removal so the caller can
 * abort while the lock is compromised.
 */
async function removeLeftoverTempFiles(
	dirPath: string,
	targetBasename: string,
	assertLockUsable: () => void,
): Promise<void> {
	const newPrefix = `.${targetBasename}.new_`
	const backupPrefix = `.${targetBasename}.bak_`
	let entries: string[]
	try {
		entries = await fs.readdir(dirPath)
	} catch {
		return
	}
	for (const entry of entries) {
		if (!entry.endsWith(".tmp")) {
			continue
		}
		if (!entry.startsWith(newPrefix) && !entry.startsWith(backupPrefix)) {
			continue
		}
		assertLockUsable()
		try {
			await fs.unlink(path.join(dirPath, entry))
		} catch (error) {
			console.error(`Failed to clean up leftover temp file ${entry} for ${targetBasename}:`, error)
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

export { LOCK_STALE_MS, safeWriteJson }
