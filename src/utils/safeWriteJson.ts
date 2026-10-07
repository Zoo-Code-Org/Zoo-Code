import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { getErrorCode } from "./errorCode"
import { acquireFileLock } from "./fileLock"
import { recoverInterruptedReplacement } from "./jsonFileRecovery"

/**
 * Stages reported through the optional `trace` callback. They mark the
 * replacement-protocol steps that matter when diagnosing interrupted or
 * failing writes: the recovery pass, the temp-file write, the backup rename
 * of the EPERM fallback, the commit rename, and completion.
 */
export type SafeWriteJsonTraceStage =
	"recover" | "write-start" | "backup-rename" | "replacement-rename" | "write-complete"

export type SafeWriteJsonTrace = (event: { stage: SafeWriteJsonTraceStage; detail?: string }) => void

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

	/**
	 * When provided, receives one event per replacement-protocol step (see
	 * SafeWriteJsonTraceStage). Callers such as the task-message save use it
	 * to emit diagnostic trace lines; it never influences the write itself.
	 */
	trace?: SafeWriteJsonTrace
}

function createTempFilePath(absoluteFilePath: string, kind: "new" | "bak"): string {
	return path.join(
		path.dirname(absoluteFilePath),
		`.${path.basename(absoluteFilePath)}.${kind}_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
	)
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Recovers an interrupted previous write before touching the file: restores an orphaned backup when the canonical path is absent, and removes leftover temp files.
 * - Writes to a temporary file first, then commits it with a single atomic rename, so the committed target stays readable through an interrupted write.
 * - When a single rename over the target fails with EPERM (a reader holds the file open on Windows), falls back to backing the target up before replacing it.
 * - Attempts to roll back and clean up in case of errors.
 * - Supports pretty-printing with indentation while maintaining streaming efficiency.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {unknown} data - The data to serialize to JSON and write.
 * @param {SafeWriteJsonOptions} options - Optional configuration for JSON formatting.
 * @returns {Promise<void>}
 */

async function safeWriteJson(filePath: string, data: unknown, options?: SafeWriteJsonOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {} // Initialized to a no-op

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists with improved reliability
	// Declared outside the protected block so the catch and finally can still name
	// the target when the resolution itself rejects.
	let resolvedTargetPath: string | undefined

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: unknown) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must be computable
	// while a peer writer is mid-commit (backup mode renames the referent away and
	// back), so the walk tolerates a dangling link instead of rejecting it here.
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Acquire the lock before any file operations. If acquisition fails it throws
	// immediately, and releaseLock stays a no-op so the finally block does not try
	// to release an unacquired lock.
	releaseLock = await acquireFileLock(lockKey)

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

	try {
		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement
		// files. Runs first so a merge callback reads the restored content.
		const recovery = await recoverInterruptedReplacement(absoluteFilePath).catch((error: unknown) => {
			const code = getErrorCode(error) ?? "unknown"
			options?.trace?.({ stage: "recover", detail: `failed:${code}` })
			throw error
		})
		if (recovery.foundLeftovers) {
			options?.trace?.({ stage: "recover", detail: recovery.restoredFrom ?? "cleaned-leftovers" })
		}

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. This runs before the merge read and before anything is staged, so a
		// rejected write leaves nothing behind.
		if (options?.confineTo) {
			const scopeRoot = await _resolveScopeRoot(options.confineTo)
			const resolvedTarget = await _resolveScopeRoot(resolvedTargetPath)
			const relative = path.relative(scopeRoot, resolvedTarget)
			if (
				relative === "" ||
				relative === ".." ||
				relative.startsWith(".." + path.sep) ||
				path.isAbsolute(relative)
			) {
				throw new ConfinedPathEscapeError(absoluteFilePath, resolvedTargetPath, scopeRoot)
			}
		}

		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write. Must be inside try/finally
		// so a throwing merge still releases the lock.
		if (options?.merge) {
			let existing: unknown = null
			try {
				existing = JSON.parse(await fs.readFile(resolvedTargetPath, "utf8"))
			} catch (error: unknown) {
				const code = getErrorCode(error)
				if (!(error instanceof SyntaxError) && code !== "ENOENT") {
					throw error
				}
			}
			data = options.merge(existing, data)
		}

		// Step 1: Write data to a new temporary file and flush it to storage,
		// making a best-effort flush before committing the replacement.
		options?.trace?.({ stage: "write-start" })
		actualTempNewFilePath = createTempFilePath(absoluteFilePath, "new")

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)
		await _flushFileToDisk(actualTempNewFilePath)

		// Step 2: Commit the replacement with a single atomic rename. The
		// committed target stays in place until this rename lands, so a
		// process exit before or during the commit can no longer leave the
		// canonical path absent.
		try {
			options?.trace?.({ stage: "replacement-rename" })
			await fs.rename(actualTempNewFilePath, absoluteFilePath)
		} catch (renameError: unknown) {
			if (getErrorCode(renameError) !== "EPERM") {
				throw renameError
			}

			// A single rename over a file that a reader holds open fails with
			// EPERM on Windows, so fall back to the two-step replacement:
			// rename the target to a backup, then the replacement into place.
			// The rollback in the catch below restores the backup when the
			// second rename fails, and the recovery pass at the start of the
			// next write repairs a crash between the two renames.
			options?.trace?.({ stage: "backup-rename", detail: "eperm-fallback" })
			actualTempBackupFilePath = createTempFilePath(absoluteFilePath, "bak")
			await fs.rename(absoluteFilePath, actualTempBackupFilePath)
			options?.trace?.({ stage: "replacement-rename", detail: "eperm-fallback" })
			await fs.rename(actualTempNewFilePath, absoluteFilePath)
		}

		// If we reach here, the new file is successfully in place and any
		// backup has already been handled by safeWriteText.
		actualTempNewFilePath = null
		options?.trace?.({ stage: "write-complete" })

		// Step 3: If a backup was created, attempt to delete it.
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
		console.error(
			`Operation failed for ${resolvedTargetPath ?? absoluteFilePath}: [Original Error Caught]`,
			originalError,
		)

		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// A failed safeWriteText already rolled the backup (if any) back to
		// the target path. Clean up the .new file if it still exists
		// (safeWriteText also cleans up its tempPath on failure; this is a
		// safety net in case its cleanup missed it).
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError: unknown) {
				// The expected case: safeWriteText already removed its own temp file, so a
				// missing file here is not a cleanup failure worth logging. Returning would
				// also swallow the original error the caller needs.
				const isAbsent =
					typeof cleanupError === "object" &&
					cleanupError !== null &&
					"code" in cleanupError &&
					cleanupError.code === "ENOENT"
				if (!isAbsent) {
					console.error(
						`[Catch] Failed to clean up temporary new file ${newFileToCleanupWithinCatch}:`,
						cleanupError,
					)
				}
			}
		}

		// A failed rollback leaves the backup as the only committed copy.
		// Preserve it for recovery by a later writer.
		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release the lock in the main finally block.
		try {
			await releaseLock()
		} catch (unlockError) {
			console.error(`Failed to release lock for ${resolvedTargetPath ?? absoluteFilePath}:`, unlockError)
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
 * Flushes a fully written temp file to storage before it is committed.
 * Best effort: durability against power loss is a bonus here, process-crash
 * safety comes from the rename protocol itself, and a filesystem that
 * refuses fsync must not block the write.
 */
async function _flushFileToDisk(targetPath: string): Promise<void> {
	try {
		const handle = await fs.open(targetPath, "r+")
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
	} catch (flushError) {
		console.error(`Failed to flush ${targetPath} to storage before commit:`, flushError)
	}
}

export { safeWriteJson }
