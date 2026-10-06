import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"


import { resolvePublishTarget, safeWriteText, type SafeWriteTextOptions } from "../services/file-safety/safeWriteText"


import { acquireFileLock } from "./fileLock"

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
 * - Writes to a temporary file first via JsonStreamStringify streaming.
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
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}


	// Acquire the lock before any file operations. `acquireFileLock` owns the
	// shared advisory lock protocol, so callers that lock the same path with
	// it (for example task-history deletion) serialize with this write.
	// If lock acquisition fails, it throws immediately. The releaseLock
	// remains a no-op, so the finally block in the main file operations
	// try-catch-finally won't try to release an unacquired lock if this
	// path is taken.
	releaseLock = await acquireFileLock(absoluteFilePath)

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

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

		// Step 1: Write data to a new temporary file via JSON streaming.
		// Stage it beside the *resolved* target (the symlink referent when the path is
		// a symlink): safeWriteText commits by renaming onto that referent, and a
		// rename across filesystems would fail with EXDEV.
		const resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)
		actualTempNewFilePath = path.join(
			path.dirname(resolvedTargetPath),
			".new_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp",
		)

		// The staged file holds the entire new content while it exists, so it must not
		// be created with the process default (0o666 & ~umask, i.e. 0o644) next to a
		// target that is deliberately narrower - a 0o600 settings file in a shared
		// directory, for example. Mirror the existing target's mode, but always keep the
		// owner read/write bits: safeWriteText reopens the staged file with "r+" before it
		// applies the target mode with fchmod, so a read-only mirror (0o400/0o444) would
		// fail that open with EACCES. A target that does not exist yet keeps the ordinary
		// default; any other stat failure is surfaced instead of silently widening the
		// creation mode.
		let stagingMode: number | undefined
		try {
			stagingMode = (fsSync.statSync(resolvedTargetPath).mode & 0o777) | 0o600
		} catch (statError: unknown) {
			const statCode =
				typeof statError === "object" && statError !== null && "code" in statError
					? (statError as { code?: string }).code
					: undefined
			if (statCode !== "ENOENT") {
				throw statError
			}
			stagingMode = undefined
		}

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint, stagingMode)

		// Step 2: Delegate the atomic commit to safeWriteText with the pre-written
		// temp path. The publish is a single rename, so the target stays intact on
		// failure and no backup copy is needed. safeWriteText still captures the
		// Windows DACL before the commit rename and restores it afterwards.
		const textOptions: SafeWriteTextOptions = {
			tempPath: actualTempNewFilePath,
		}

		await safeWriteText(absoluteFilePath, "", textOptions)

		// If we reach here, the new file is successfully in place.
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// A failed safeWriteText leaves the target untouched (the commit rename never
		// landed). Clean up the .new file if it still exists (safeWriteText also
		// cleans up its tempPath on failure; this is a safety net in case its
		// cleanup missed it).
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

		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release the lock in the main finally block.
		try {
			await releaseLock()
		} catch (unlockError) {
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
async function _streamDataToFile(
	targetPath: string,
	data: any,
	prettyPrint = false,
	mode?: number,
): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	// mode is explicit because createWriteStream defaults to 0o666 (& ~umask): the
	// staged file is readable by others until the commit renames it onto the target.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) })

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

export { safeWriteJson }
