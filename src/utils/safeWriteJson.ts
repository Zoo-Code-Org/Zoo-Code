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
 * Canonicalize the staging directory this write was approved to stage into, or report that the
 * probe could not answer. Returning undefined instead of throwing is the point: the drift check
 * can only read meaning out of a resolution that succeeded, and every failure this probe can
 * produce - ENOENT while the directory exists because a component is mid-replacement or because
 * the caller's fs double reports the path as missing, EACCES, EPERM, ELOOP - is equally consistent
 * with the approved directory being exactly where it was approved. A probe that cannot answer is
 * not an answer.
 */
async function _probeApprovedStagingDirectory(directory: string): Promise<string | undefined> {
	try {
		return await _resolveScopeRoot(directory)
	} catch {
		return undefined
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
	// Declared outside the protected block so the catch and finally can still name
	// the target when the resolution itself rejects.
	let resolvedTargetPath: string | undefined

	// Confinement is checked before ANY filesystem side effect. mkdir -p through a
	// planted symlinked ancestor (projectDir/.roo -> /elsewhere) would create
	// directories outside the declared scope, and an unwritable referent would surface
	// the mkdir error instead of the ConfinedPathEscapeError the caller is entitled to.
	// _resolveScopeRoot resolves a not-yet-existing path through its nearest existing
	// ancestor, so this works for the target's missing parents too.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		const requested = await _resolveScopeRoot(absoluteFilePath)
		if (_escapesScope(scopeRoot, requested)) {
			throw new ConfinedPathEscapeError(absoluteFilePath, requested, scopeRoot)
		}
	}

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: unknown) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must stay computable while
	// a peer writer is mid-commit - the commit rename briefly leaves the path without
	// the referent it had when the walk started - so the walk tolerates a dangling link
	// instead of rejecting it here. (The backup itself is a copy: the target is never
	// renamed away, so a dangling link here means a peer's commit or an external
	// unlink, not a backup rename.)
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement is checked here as well as under the lock. The lock file lives NEXT
	// TO the key, so a planted symlink that points outside the declared scope would
	// first make this write create "<referent>.lock" outside that scope - a side effect
	// the caller declared it would not have - and if that directory is not writable the
	// caller would get a lock-acquisition error instead of the ConfinedPathEscapeError
	// it is entitled to. The key is the symlink referent, so this check sees the same
	// destination the lock would be taken on. The under-lock check stays: it covers the
	// target re-resolved after a peer commits.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		if (_escapesScope(scopeRoot, await _resolveScopeRoot(lockKey))) {
			throw new ConfinedPathEscapeError(absoluteFilePath, lockKey, scopeRoot)
		}
	}

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

		// The lock above was chosen from the path as it looked before the lock was taken, and the
		// publish target is resolved under the lock - after a peer committed, and after the alias
		// itself may have been repointed. If the two no longer name the same file, this writer is
		// holding the lock of a path it is not about to publish while some other writer can hold
		// the lock of the one it is about to publish, which is two commits onto one file each
		// believing it owned it. Nothing has been staged or merged yet, so rejecting here leaves
		// every file untouched and the caller can retry against the key it resolves to now.
		if ((await resolveLockKey(resolvedTargetPath)) !== lockKey) {
			throw new LockKeyDriftError(absoluteFilePath, lockKey, resolvedTargetPath)
		}

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. This runs before the merge read and before anything is staged, so a
		// rejected write leaves nothing behind.
		if (options?.confineTo) {
			const scopeRoot = await _resolveScopeRoot(options.confineTo)
			if (_escapesScope(scopeRoot, await _resolveScopeRoot(resolvedTargetPath))) {
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
		// The commit rename publishes the staging inode, so the file that lands at the target carries
		// the staging file's mode rather than the target's: on POSIX a rename does not carry the
		// replaced file's permissions over. A staging file created with the process default (0o666 &
		// ~umask, normally 0o644) therefore turns an update of a 0o600 file into a world-readable one
		// sitting in a traversable directory. Read the publish target's mode before staging and create
		// the staging file with it. A target that is not there yet has no mode to carry over, and the
		// creation default stands; any other stat failure is propagated, because the mode a private
		// file is published with is not something this write gets to guess.
		const publishTargetMode = await _readPublishTargetMode(resolvedTargetPath ?? absoluteFilePath)
		// The staging location was chosen from the parent directory resolved under the lock. Re-verify
		// that directory against itself before writing anything into it: a resolved pathname is not an
		// identity, and a parent that was replaced with a link pointing elsewhere in the meantime would
		// put the staged file outside the directory this write was approved for. safeWriteText would
		// then reject the publish, but the stray file would already exist. Both sides of this comparison
		// are canonicalized with the same directory walk the confinement check above uses, because for a
		// target that does not exist yet resolvePublishTarget returns the path it was given: comparing
		// that lexical spelling against fs.realpath of the same directory rejects an ordinary write
		// whenever the two spellings differ. On a Windows runner the temp root arrives spelled with its
		// 8.3 short name (C:\Users\RUNNER~1\AppData\Local\Temp) and realpath reports the long name for
		// that very same directory, so every write into a directory that did not exist yet rejected
		// here. The two walks run against the same frozen approval one after the other, and both sides
		// are compared as canonical directories rather than as the text of a path, so a parent that
		// really was replaced by a link still lands on a different canonical directory and still
		// rejects.
		//
		// What this guard may act on is one thing only: a re-resolution that succeeds and lands on a
		// different directory. A probe that cannot answer is not an answer. A probe that fails - ENOENT
		// because a component is mid-replacement or is simply not there yet, EACCES, EPERM or ELOOP
		// because the filesystem refused to say - carries no information about replacement whatsoever,
		// and a failing probe is a normal condition of this write path rather than an attack: the task
		// persistence suite runs this write against an fs/promises double whose stat rejects with
		// ENOENT for every path, and its task directory was created moments earlier with the real fs.
		// Reading that as drift rejected an ordinary write, which is the shape upstream's newer
		// Task.spec hit on a Windows temp path. So a probe that cannot answer proceeds. A directory that
		// really was deleted in the meantime then fails at the staging write itself: still fail-closed,
		// still nothing created outside the directory the write was approved for, and the error names
		// the failed write instead of claiming to be evidence of replacement. The confinement checks
		// above decide the opposite way on purpose - there the guard has to prove the write is inside
		// the scope, and a probe that cannot answer cannot prove anything.
		const approvedStagingDirectory = path.dirname(actualTempNewFilePath)
		const approvedCanonical = await _probeApprovedStagingDirectory(approvedStagingDirectory)
		const currentStagingDirectory =
			approvedCanonical === undefined ? undefined : await _probeApprovedStagingDirectory(approvedCanonical)
		if (
			approvedCanonical !== undefined &&
			currentStagingDirectory !== undefined &&
			!_sameDirectory(approvedCanonical, currentStagingDirectory)
		) {
			throw new StagingDirectoryDriftError(
				resolvedTargetPath ?? absoluteFilePath,
				approvedCanonical,
				currentStagingDirectory,
			)
		}

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint, publishTargetMode)
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

		// A pre-commit failure leaves the target untouched, and safeWriteText has
		// already removed its own backup copy and temp file (a POST-commit failure
		// keeps the backup on purpose and reports its path on the error). Clean up
		// the .new file if it still exists - safety net in case its cleanup missed it.
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
 * The mode the staging file has to be created with, taken from the file it is about to replace.
 * undefined means there is no such file yet and the creation default stands; a failure that is
 * not "not there" is propagated, because guessing the mode of a private file is how a 0o600
 * settings file becomes 0o644 without anyone deciding it.
 */
async function _readPublishTargetMode(publishTargetPath: string): Promise<number | undefined> {
	let mode: number
	try {
		mode = (await fs.stat(publishTargetPath)).mode
	} catch (error: unknown) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined
		}
		throw error
	}
	return mode & 0o777
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @param prettyPrint Whether to format the JSON with indentation.
 * @returns Promise<void>
 */
async function _streamDataToFile(targetPath: string, data: unknown, prettyPrint = false, mode?: number): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects. The mode is the publish
	// target's own mode, so the inode that replaces it is not created more openly than the file it
	// replaces; on Windows the creation mode carries only the read-only bit and per-user rights come
	// from directory inheritance, which is why the end-to-end mode assertion is POSIX-shaped.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8", mode })
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
