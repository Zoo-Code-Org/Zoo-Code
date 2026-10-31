import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock, withFileLock } from "./fileLock"
import { tracePersistenceEvent } from "./persistenceTrace"

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

function notifyTrace(trace: SafeWriteJsonTrace | undefined, event: Parameters<SafeWriteJsonTrace>[0]): void {
	try {
		trace?.(event)
	} catch {
		try {
			console.error("JSON write trace callback failed")
		} catch {
			// Diagnostics must not affect persistence, even if logging fails.
		}
	}
}

function createTempFilePath(absoluteFilePath: string, kind: "new" | "bak"): string {
	return path.join(
		path.dirname(absoluteFilePath),
		`.${path.basename(absoluteFilePath)}.${kind}_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
	)
}

function getTempFilePrefix(absoluteFilePath: string, kind: "new" | "bak"): string {
	return `.${path.basename(absoluteFilePath)}.${kind}_`
}

/** Copy validated backup bytes; never publish the backup pathname itself. */
async function restoreBackup(backupPath: string, absoluteFilePath: string): Promise<void> {
	const temporaryPath = createTempFilePath(absoluteFilePath, "new")
	try {
		const before = await fs.lstat(backupPath, { bigint: true })
		if (!before.isFile())
			throw Object.assign(new Error("Recovery backup must be a regular file"), { code: "EINVAL" })
		const flags =
			fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0) | (fsSync.constants.O_NONBLOCK ?? 0)
		const source = await fs.open(backupPath, flags)
		try {
			const opened = await source.stat({ bigint: true })
			const after = await fs.lstat(backupPath, { bigint: true })
			// Identity checks also protect platforms without O_NOFOLLOW. No bytes
			// are read until the descriptor matches the regular entry inspected.
			if (
				!opened.isFile() ||
				!after.isFile() ||
				before.dev !== opened.dev ||
				before.ino !== opened.ino ||
				after.dev !== opened.dev ||
				after.ino !== opened.ino
			) {
				throw Object.assign(new Error("Recovery backup changed during validation"), { code: "EINVAL" })
			}
			const destination = await fs.open(temporaryPath, "wx", 0o600)
			try {
				const buffer = Buffer.alloc(64 * 1024)
				for (;;) {
					const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
					if (bytesRead === 0) break
					await destination.writeFile(buffer.subarray(0, bytesRead))
				}
			} finally {
				await destination.close()
			}
		} finally {
			await source.close()
		}
		await fs.rename(temporaryPath, absoluteFilePath)
	} finally {
		try {
			await fs.unlink(temporaryPath)
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") console.error("Failed to clean recovery temporary file:", error)
		}
	}
}

/**
 * Heals the canonical path after an interrupted previous write. Must run
 * under the advisory lock and before any data is read or written: temp and
 * backup files are only ever created while that lock is held, so anything
 * matching their name patterns belongs to a writer that can no longer
 * commit or clean it up (a crashed process, or a stale lock that was
 * stolen).
 *
 * The two-step replacement used by the EPERM fallback (and by versions
 * before the single-rename commit) can be interrupted after the target was
 * renamed to its backup but before the replacement landed. A process exit
 * at that point leaves the canonical path absent, which readers see as a
 * permanent ENOENT that no retry can repair, so the newest backup is
 * restored first. Leftover replacement and backup files are garbage
 * collected afterwards.
 *
 * @returns Whether leftover files were found, and the backup path that was
 * restored, if any.
 */
async function recoverInterruptedReplacementUnchecked(
	absoluteFilePath: string,
): Promise<{ foundLeftovers: boolean; restoredFrom: string | null }> {
	const dirPath = path.dirname(absoluteFilePath)
	const newPrefix = getTempFilePrefix(absoluteFilePath, "new")
	const backupPrefix = getTempFilePrefix(absoluteFilePath, "bak")

	let entries: string[]
	try {
		entries = await fs.readdir(dirPath)
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") throw error
		return { foundLeftovers: false, restoredFrom: null }
	}

	const orphanedPaths = entries
		.filter((entry) => entry.endsWith(".tmp") && (entry.startsWith(newPrefix) || entry.startsWith(backupPrefix)))
		.map((entry) => path.join(dirPath, entry))

	if (orphanedPaths.length === 0) {
		return { foundLeftovers: false, restoredFrom: null }
	}

	let restoredFrom: string | null = null

	try {
		await fs.access(absoluteFilePath)
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT") throw error
		// Ignore only backups removed since readdir. Other inspection failures
		// must stop the write rather than discard uninspected committed data.
		const backupStats = await Promise.all(
			orphanedPaths
				.filter((orphanPath) => path.basename(orphanPath).startsWith(backupPrefix))
				.map(async (backupPath) => {
					try {
						const stats = await fs.lstat(backupPath)
						if (!stats.isFile())
							throw Object.assign(new Error("Recovery backup must be a regular file"), { code: "EINVAL" })
						return { backupPath, mtimeMs: stats.mtimeMs }
					} catch (statError) {
						if (getErrorCode(statError) !== "ENOENT") throw statError
						return null
					}
				}),
		)
		const backups = backupStats.filter((backup) => backup !== null)
		backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.backupPath.localeCompare(a.backupPath))
		const [newest] = backups
		if (newest) {
			const newestBackupPath = newest.backupPath
			// A failed restore leaves every backup intact and aborts the write.
			// In particular, a merge must never observe null in this state.
			await restoreBackup(newestBackupPath, absoluteFilePath)
			restoredFrom = newestBackupPath
			tracePersistenceEvent("json-recovered", { filePath: absoluteFilePath })
		}
	}

	for (const orphanPath of orphanedPaths) {
		try {
			await fs.unlink(orphanPath)
		} catch (cleanupError) {
			tracePersistenceEvent("json-cleanup-failed", {
				filePath: absoluteFilePath,
				detail: getErrorCode(cleanupError) ?? "IO_ERROR",
			})
			console.error(`Failed to clean up interrupted-write leftover ${orphanPath}:`, cleanupError)
		}
	}

	return { foundLeftovers: true, restoredFrom }
}

async function withRecoveryTrace<T>(absoluteFilePath: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		tracePersistenceEvent("json-recovery-failed", {
			filePath: absoluteFilePath,
			detail: getErrorCode(error) ?? "IO_ERROR",
		})
		throw error
	}
}

export function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined
}

/** Recover a missing JSON file for a reader, serialized with writers and deletion. */
export async function recoverJsonFile(filePath: string): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	return withRecoveryTrace(absoluteFilePath, async () => {
		let entries: string[]
		try {
			entries = await fs.readdir(path.dirname(absoluteFilePath))
		} catch (error) {
			if (getErrorCode(error) === "ENOENT") return
			throw error
		}
		// A genuinely absent file has nothing to recover. Do not contend with a
		// first writer (or create a lock directory) merely to report ENOENT.
		const backupPrefix = getTempFilePrefix(absoluteFilePath, "bak")
		if (!entries.some((entry) => entry.startsWith(backupPrefix) && entry.endsWith(".tmp"))) return
		// This is only a hint: inspect the canonical file and backups again under
		// the lock before restoring or cleaning anything.
		await withFileLock(absoluteFilePath, recoverInterruptedReplacementUnchecked)
	})
}

/** Called under the canonical file lock before deleting it, so backups cannot resurrect it. */
export async function removeJsonBackups(absoluteFilePath: string): Promise<void> {
	const prefix = getTempFilePrefix(absoluteFilePath, "bak")
	for (const entry of await fs.readdir(path.dirname(absoluteFilePath))) {
		if (entry.startsWith(prefix) && entry.endsWith(".tmp")) {
			try {
				await fs.unlink(path.join(path.dirname(absoluteFilePath), entry))
			} catch (error) {
				if (getErrorCode(error) !== "ENOENT") throw error
			}
		}
	}
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
	try {
		// Create directory with recursive option
		await fs.mkdir(dirPath, { recursive: true })

		// Verify directory exists after creation attempt
		await fs.access(dirPath)
	} catch (dirError) {
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

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null
	let committed = false

	try {
		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement
		// files. Runs first so a merge callback reads the restored content.
		const recovery = await withRecoveryTrace(absoluteFilePath, () =>
			recoverInterruptedReplacementUnchecked(absoluteFilePath),
		).catch((error: unknown) => {
			notifyTrace(options?.trace, { stage: "recover", detail: `failed: ${getErrorCode(error) ?? "IO_ERROR"}` })
			throw error
		})
		if (recovery.foundLeftovers) {
			notifyTrace(options?.trace, { stage: "recover", detail: recovery.restoredFrom ?? "cleaned-leftovers" })
		}

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

		// Step 1: Stream the replacement to a temporary file before commit.
		notifyTrace(options?.trace, { stage: "write-start" })
		actualTempNewFilePath = createTempFilePath(absoluteFilePath, "new")

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// Step 2: Commit the replacement with a single atomic rename. The
		// committed target stays in place until this rename lands, so a
		// process exit before or during the commit can no longer leave the
		// canonical path absent.
		try {
			notifyTrace(options?.trace, { stage: "replacement-rename" })
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
			notifyTrace(options?.trace, { stage: "backup-rename", detail: "eperm-fallback" })
			const backupPath = createTempFilePath(absoluteFilePath, "bak")
			await fs.rename(absoluteFilePath, backupPath)
			actualTempBackupFilePath = backupPath
			notifyTrace(options?.trace, { stage: "replacement-rename", detail: "eperm-fallback" })
			await fs.rename(actualTempNewFilePath, absoluteFilePath)
		}

		committed = true

		// If we reach here, the new file is successfully in place.
		// The original actualTempNewFilePath is now the main file, so we shouldn't try to clean it up as "temp".
		// Mark as "used" or "committed"
		actualTempNewFilePath = null

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
		console.error(`Operation failed for ${absoluteFilePath}: [Original Error Caught]`, originalError)

		const newFileToCleanupWithinCatch = actualTempNewFilePath
		const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

		// Attempt rollback if a backup was made
		if (!committed && backupFileToRollbackOrCleanupWithinCatch) {
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

		// A failed rollback leaves the last committed copy in the backup.
		// Preserve it so a subsequent read or write can recover it.
		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		if (committed) notifyTrace(options?.trace, { stage: "write-complete" })
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

export { safeWriteJson }
