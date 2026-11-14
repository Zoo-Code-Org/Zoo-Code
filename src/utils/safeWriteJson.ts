import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { getErrorCode } from "./errorCode"
import { acquireFileLock } from "./fileLock"
import { recoverInterruptedReplacement } from "./jsonFileRecovery"
import {
	PostCommitDurabilityError,
	resolveLockKey,
	resolvePublishTarget,
	safeWriteText,
} from "../services/file-safety/safeWriteText"

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

/**
 * Staging path for the replacement, created beside the target it will be renamed onto.
 *
 * The name has to satisfy two contracts at once. safeWriteText only publishes a
 * caller-supplied staging path whose basename matches `.new_*.tmp` (a plain file
 * beside the target would have its content published and its own name deleted),
 * and jsonFileRecovery only garbage-collects leftovers whose name is scoped to
 * this file, so it can never unlink another target's in-flight staging file in
 * the same directory. `.new_<basename>_<ts>_<rand>.tmp` is the one shape that
 * satisfies both.
 */
function createStagingFilePath(absoluteFilePath: string): string {
	return path.join(
		path.dirname(absoluteFilePath),
		`.new_${path.basename(absoluteFilePath)}_${Date.now()}_${Math.random().toString(36).substring(2) || "0"}.tmp`,
	)
}

function createBackupFilePath(absoluteFilePath: string): string {
	return path.join(
		path.dirname(absoluteFilePath),
		`.${path.basename(absoluteFilePath)}.bak_${Date.now()}_${Math.random().toString(36).substring(2) || "0"}.tmp`,
	)
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 *   The lock is keyed on the symlink referent, so an alias and its referent share one lock.
 * - Recovers an interrupted previous write before touching the file: restores an orphaned backup when the canonical path is absent, and removes leftover temp files.
 * - Writes to a temporary file first via JsonStreamStringify streaming, then commits it through safeWriteText's single atomic rename, so the committed target stays readable through an interrupted write.
 * - When that rename fails with EPERM (a reader holds the file open on Windows), re-stages and falls back to the two-step replacement that backs the target up before replacing it.
 * - Delegates the commit, the Windows DACL capture, the target mode and the post-commit fsync to safeWriteText, which is the same primitive the guarded text writes use.
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
	// while a peer writer is mid-commit (a publish renames the staged file onto the
	// referent and back), so the walk tolerates a dangling link instead of rejecting
	// it here.
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Acquire the lock before any file operations. If acquisition fails it throws
	// immediately, and releaseLock stays a no-op so the finally block does not try
	// to release an unacquired lock. Callers that lock the same key with acquireFileLock
	// (for example task-history deletion) serialize with this write.
	releaseLock = await acquireFileLock(lockKey)

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	// The backup copy taken by the EPERM fallback, if that fallback runs.
	let actualTempBackupFilePath: string | null = null

	try {
		// Resolve the publish target under the lock: a peer that held the lock has
		// committed by now, so the strict dangling-link rejection still applies to a
		// real dangling link. It must stay inside the protected block, otherwise a
		// rejection here leaves the advisory lock held until the stale timeout for
		// every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement
		// files. Runs on the resolved target, because that is the directory the
		// staging and backup names live in, and runs before the merge callback so
		// the callback reads the restored content.
		const recovery = await recoverInterruptedReplacement(resolvedTargetPath).catch((error: unknown) => {
			const code = getErrorCode(error) ?? "unknown"
			options?.trace?.({ stage: "recover", detail: `failed:${code}` })
			throw error
		})
		if (recovery.foundLeftovers) {
			options?.trace?.({ stage: "recover", detail: recovery.restoredFrom ?? "cleaned-leftovers" })
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
		// Staged beside the RESOLVED target (the symlink referent when the path is a
		// symlink): the commit is a rename onto that referent, and a rename across
		// filesystems would fail with EXDEV. The name is the staging convention the
		// commit primitive requires and is scoped to this file, so the recovery pass
		// above can still recognise it. See createStagingFilePath.
		options?.trace?.({ stage: "write-start" })
		actualTempNewFilePath = createStagingFilePath(resolvedTargetPath)

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)
		await _flushFileToDisk(actualTempNewFilePath)

		// Step 2: Commit through safeWriteText with the pre-written temp path (backup:false
		// is its single atomic rename), so the committed target stays in place until the
		// rename lands and a process exit before or during the commit cannot leave the
		// canonical path absent. safeWriteText carries the Windows DACL across the
		// replacement, preserves the target's mode, fsyncs the staged file and, off
		// Windows, fsyncs the parent directory - which is why this file no longer renames
		// onto the path itself.
		try {
			options?.trace?.({ stage: "replacement-rename" })
			await safeWriteText(resolvedTargetPath, "", { tempPath: actualTempNewFilePath, backup: false })
		} catch (commitError: unknown) {
			if (getErrorCode(commitError) !== "EPERM") {
				throw commitError
			}
			// A rename over a file that a reader holds open fails with EPERM on
			// Windows, so fall back to the two-step replacement: move the committed file
			// aside, then rename the replacement into place. safeWriteText removed the
			// staging path when its commit failed, so the data is re-staged under a fresh
			// name. The recovery pass at the start of the next write repairs a crash
			// between these two renames, so this sequence needs no pre-backup fsync here.
			options?.trace?.({ stage: "backup-rename", detail: "eperm-fallback" })
			// The backup keeps this file's `.basename.bak_*` convention: that is the name
			// the recovery pass restores from when a crash lands between the two renames.
			actualTempBackupFilePath = createBackupFilePath(resolvedTargetPath)
			await fs.rename(resolvedTargetPath, actualTempBackupFilePath)
			actualTempNewFilePath = createStagingFilePath(resolvedTargetPath)
			await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)
			await _flushFileToDisk(actualTempNewFilePath)
			options?.trace?.({ stage: "replacement-rename", detail: "eperm-fallback" })
			await safeWriteText(resolvedTargetPath, "", { tempPath: actualTempNewFilePath, backup: false })
		}
		// Step 3: Delete the backup file taken by the EPERM fallback (the single-rename
		// path never takes one). Failure here must not undo or fail the write, because the
		// new content is already committed; it is logged and the write still resolves.
		if (actualTempBackupFilePath) {
			try {
				await fs.unlink(actualTempBackupFilePath)
			} catch (cleanupError) {
				console.error(
					`Successfully wrote ${resolvedTargetPath} but failed to delete backup ${actualTempBackupFilePath}:`,
					cleanupError,
				)
			}
			actualTempBackupFilePath = null
		}

		actualTempNewFilePath = null
		options?.trace?.({ stage: "write-complete" })
	} catch (originalError) {
		console.error(
			`Operation failed for ${resolvedTargetPath ?? absoluteFilePath}: [Original Error Caught]`,
			originalError,
		)

		// PostCommitDurabilityError means the commit rename landed: the staged
		// path was renamed onto the target, so it is no longer a leftover temp
		// file. Unlinking it here would at best race a concurrent writer that has
		// already reused the staging name, and the published target must survive
		// the durability failure with its new content. The error rethrows below,
		// so the write is never observed as a confirmed-durable success.
		if (originalError instanceof PostCommitDurabilityError) {
			actualTempNewFilePath = null
		}

		// If the EPERM fallback had moved the committed file to the backup path, decide by
		// whether the second commit landed. A PostCommitDurabilityError is raised only after
		// the commit rename succeeded, so the new content is already at the target and the
		// backup holds the content the target no longer has: renaming it back would put the
		// old bytes over the published ones while the rethrown error tells the caller the new
		// content is at the target. It is dropped instead, and a failed drop leaves it as a
		// leftover the next writer's recovery pass collects.
		// A failure before the commit is the other case: the target still holds the content
		// the fallback moved aside, so the backup goes back and a failed restore leaves it
		// as the only committed copy for a later recovery rather than unlinked.
		if (actualTempBackupFilePath) {
			if (originalError instanceof PostCommitDurabilityError) {
				try {
					await fs.unlink(actualTempBackupFilePath)
				} catch (backupCleanupError: unknown) {
					if (getErrorCode(backupCleanupError) !== "ENOENT") {
						console.error(
							`Published ${resolvedTargetPath ?? absoluteFilePath} but failed to delete the stale EPERM-fallback backup ${actualTempBackupFilePath}:`,
							backupCleanupError,
						)
					}
				}
			} else {
				try {
					await fs.rename(actualTempBackupFilePath, resolvedTargetPath ?? absoluteFilePath)
				} catch (rollbackError) {
					console.error(
						`Failed to restore backup ${actualTempBackupFilePath} to ${resolvedTargetPath ?? absoluteFilePath}:`,
						rollbackError,
					)
				}
			}
			actualTempBackupFilePath = null
		}
		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// Clean up the .new file if it still exists (safeWriteText removes its own
		// staging path on a failed commit, so this is a safety net for the paths that
		// never reach it, such as a failure inside the EPERM fallback's re-stage).
		// The fallback's backup is handled above: it is either restored to the target
		// or preserved for a later recovery pass, never dropped here.
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
