import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { getErrorCode } from "./errorCode"
import { acquireFileLock } from "./fileLock"
import { recoverInterruptedReplacement } from "./jsonFileRecovery"
import { resolveLockKey, resolvePublishTarget } from "../services/file-safety/safeWriteText"

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

	/**
	 * Restrict the write to a directory. The publish target is resolved through
	 * symlinks before this check runs, so a caller that picked the path from a
	 * known scope (a workspace, a project settings directory) can refuse a write
	 * that a planted symlink would land somewhere else. The check runs before the
	 * advisory lock is taken and before anything is staged.
	 */
	confineTo?: string
}

/**
 * Thrown when a write declared with `confineTo` resolves outside that directory.
 */
export class ConfinedPathEscapeError extends Error {
	constructor(
		readonly requestedPath: string,
		readonly resolvedPath: string,
		readonly confineTo: string,
	) {
		super(
			`Refusing to write ${resolvedPath}: it resolves outside the confined directory ${confineTo} (requested ${requestedPath}).`,
		)
		this.name = "ConfinedPathEscapeError"
	}
}

/**
 * Canonicalize the directory a write is confined to. The publish target is fully
 * resolved through symlinks, so the scope has to be resolved the same way or a
 * scope path that itself runs through a symlink (macOS /var -> /private/var is the
 * common case) would compare lexically against a resolved target and reject every
 * legitimate in-scope write. When the scope does not exist yet, the nearest
 * existing ancestor is resolved and the remainder re-appended.
 */
async function _resolveScopeRoot(confineTo: string): Promise<string> {
	const lexical = path.resolve(confineTo)
	try {
		return await fs.realpath(lexical)
	} catch (error: unknown) {
		// Only a missing path means "walk up and re-join". EACCES or ELOOP means the
		// scope cannot be canonicalized at all, and continuing would build a partly
		// lexical root that can disagree with the canonical target - the failure has to
		// surface rather than decide the scope from a guess.
		if (getErrorCode(error) !== "ENOENT") {
			throw error
		}
		const missing: string[] = []
		let ancestor = lexical
		while (true) {
			const parent = path.dirname(ancestor)
			if (parent === ancestor) {
				return lexical
			}
			missing.push(path.basename(ancestor))
			ancestor = parent
			try {
				const real = await fs.realpath(ancestor)
				return path.join(real, ...missing.reverse())
			} catch (innerError: unknown) {
				if (getErrorCode(innerError) !== "ENOENT") {
					throw innerError
				}
			}
		}
	}
}

/**
 * Whether `candidate` sits outside `scopeRoot`. The scope root itself counts as
 * outside: a file write cannot land on the directory that declares the scope.
 */
function _escapesScope(scopeRoot: string, candidate: string): boolean {
	const relative = path.relative(scopeRoot, candidate)
	return relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
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
 * - Stages the replacement beside the resolved publish target, resolves the advisory
 *   lock key to the same referent, and refuses a write declared with confineTo when
 *   either the target or the lock key resolves outside that scope.
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

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null

	try {
		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement
		// Recovery has to look beside the file an interrupted publish actually renamed onto. The
		// leftover names are derived from the publish target, so when the caller named a symlink
		// whose referent lives in another directory, the backup and the staged copy sit beside the
		// referent while this scan - which used the lexical spelling - searched the link's own
		// directory, found nothing, and let the write below publish straight over the orphaned
		// newer content. Resolve the publish target first so the scan looks where the bytes are.
		// Best-effort on purpose: resolvePublishTarget rejects a link with no referent, and in that
		// state nothing can be attributed to a referent, so recovery falls back to the named path -
		// exactly what it always scanned - and the strict resolution below still decides whether
		// this write may proceed at all.
		let recoveryTarget = absoluteFilePath
		try {
			recoveryTarget = await resolvePublishTarget(absoluteFilePath)
		} catch {
			recoveryTarget = absoluteFilePath
		}
		const recovery = await recoverInterruptedReplacement(recoveryTarget).catch((error: unknown) => {
			const code = getErrorCode(error) ?? "unknown"
			options?.trace?.({ stage: "recover", detail: `failed:${code}` })
			throw error
		})
		if (recovery.foundLeftovers) {
			options?.trace?.({ stage: "recover", detail: recovery.restoredFrom ?? "cleaned-leftovers" })
		}

		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

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
		// Stage it beside the *resolved* publish target (the symlink referent when the
		// path is a symlink): the commit rename below lands on that referent, and a rename
		// across filesystems would fail with EXDEV.
		actualTempNewFilePath = createTempFilePath(resolvedTargetPath, "new")

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// CWE-732: the commit renames the staged file onto the target, so the file that
		// lands carries the STAGED file's mode, not the target's. A 0o600 target would
		// otherwise be published as 0o644 with the umask-derived default. Copy the target's
		// mode onto the staged file before the rename; a target that is not there yet has no
		// mode to copy, and POSIX modes are ignored on Windows.
		await _copyTargetMode(resolvedTargetPath, actualTempNewFilePath)
		await _flushFileToDisk(actualTempNewFilePath)

		// Step 2: Commit the replacement with a single atomic rename. The
		// committed target stays in place until this rename lands, so a
		// process exit before or during the commit can no longer leave the
		// canonical path absent.
		try {
			options?.trace?.({ stage: "replacement-rename" })
			await fs.rename(actualTempNewFilePath, resolvedTargetPath)
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
			actualTempBackupFilePath = createTempFilePath(resolvedTargetPath, "bak")
			await fs.rename(resolvedTargetPath, actualTempBackupFilePath)
			options?.trace?.({ stage: "replacement-rename", detail: "eperm-fallback" })
			await fs.rename(actualTempNewFilePath, resolvedTargetPath)
		}

		// If we reach here, the new file is successfully in place.
		// The original actualTempNewFilePath is now the main file, so we shouldn't try to clean it up as "temp".
		// Mark as "used" or "committed"

		// The rename is durable only once the directory entry that records it reaches disk
		// too. Best effort and POSIX-only - see _flushDirectoryToDisk.
		_flushDirectoryToDisk(path.dirname(resolvedTargetPath))
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
					`Successfully wrote ${resolvedTargetPath ?? absoluteFilePath}, but failed to clean up backup ${actualTempBackupFilePath}:`,
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
		const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

		// Attempt rollback if a backup was made
		if (backupFileToRollbackOrCleanupWithinCatch) {
			try {
				await fs.rename(backupFileToRollbackOrCleanupWithinCatch, resolvedTargetPath ?? absoluteFilePath)
				// Mark as handled, prevent later unlink of this path
				actualTempBackupFilePath = null
			} catch (rollbackError) {
				// actualTempBackupFilePath (outer scope) remains pointing to backupFileToRollbackOrCleanupWithinCatch
				console.error(
					`[Catch] Failed to restore backup ${backupFileToRollbackOrCleanupWithinCatch} to ${
						resolvedTargetPath ?? absoluteFilePath
					}:`,
					rollbackError,
				)
			}
		}

		// Cleanup the .new file if it exists
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError: unknown) {
				// An already-gone staging file is the normal outcome when the failure was the
				// commit rename itself, so it is not a second failure and must not be logged as
				// one; the caller would otherwise see two errors for one write.
				if (getErrorCode(cleanupError) !== "ENOENT") {
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
			// releaseLock will be the actual unlock function if lock was acquired,
			// or the initial no-op if acquisition failed.
			await releaseLock()
		} catch (unlockError) {
			// Do not re-throw here, as the originalError from the try/catch (if any) is more important.
			console.error(`Failed to release lock for ${lockKey}:`, unlockError)
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
 * Copies the existing target's permission mode onto the staged file so the publish
 * does not silently widen it. A missing target has no mode to copy; a stat or chmod
 * that fails for another reason is logged and the write proceeds with the staged
 * file's own mode, because the replacement protocol - not the mode - is what makes the
 * write atomic.
 */
async function _copyTargetMode(targetPath: string, stagedPath: string): Promise<void> {
	let mode: number
	try {
		const stats = await fs.stat(targetPath)
		mode = stats.mode & 0o777
	} catch (statError: unknown) {
		const code = getErrorCode(statError)
		if (code && code !== "ENOENT" && code !== "ENOTDIR") {
			console.error(`Could not read the mode of ${targetPath} before publishing onto it:`, statError)
		}
		return
	}
	try {
		await fs.chmod(stagedPath, mode)
	} catch (chmodError: unknown) {
		// A mode this write could not reproduce is not cosmetic. Publishing over a 0o600
		// target with the staged file's own 0o644 widens who can read the file, and the
		// rename would then report success. Re-read what the staged file actually ended up
		// with: refuse the publish unless the mode matches anyway, because a filesystem
		// that ignores POSIX modes, or a umask that already produced the target mode, is
		// not a widening. The staged file is cleaned by the caller's failure path, so the
		// target is left exactly as it was.
		const stagedMode = await fs.stat(stagedPath).catch(() => undefined)
		if (stagedMode === undefined || (Number(stagedMode.mode) & 0o777) !== mode) {
			console.error(`Failed to copy mode ${mode.toString(8)} from ${targetPath} onto ${stagedPath}:`, chmodError)
			throw chmodError
		}
		console.error(
			`Copied no mode onto ${stagedPath}; its own mode ${String((Number(stagedMode.mode) & 0o777).toString(8))} already matches the target ${targetPath}.`,
		)
		console.error(`Failed to copy mode ${mode.toString(8)} from ${targetPath} onto ${stagedPath}:`, chmodError)
	}
}

/**
 * Syncs the directory that holds a freshly committed file. A rename only survives a
 * crash once the directory entry recording it is on disk as well. Best effort by
 * design: the write already published, and a filesystem that refuses to open or fsync
 * a directory must not turn a completed write into a reported failure - the content is
 * at the target either way, so the caller is told through the log, not through a
 * rejection. POSIX only: Windows cannot open a directory for this purpose.
 */
function _flushDirectoryToDisk(directoryPath: string): void {
	if (process.platform === "win32") {
		return
	}
	let fd: number | undefined
	try {
		fd = fsSync.openSync(directoryPath, "r")
		fsSync.fsyncSync(fd)
	} catch (dirSyncError: unknown) {
		console.warn(`Could not fsync ${directoryPath} after publishing a file into it:`, dirSyncError)
	} finally {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd)
			} catch (closeError: unknown) {
				void closeError
			}
		}
	}
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
