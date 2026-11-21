import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { resolvePublishTarget } from "../services/file-safety/safeWriteText"

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

	/**
	 * Refuse to publish through a symlink at the target path.
	 *
	 * Two things differ by default and should not be conflated: the advisory LOCK is keyed to
	 * the resolved referent, which is what keeps every alias of one file behind a single lock,
	 * while the PUBLISH stays on the path the caller named - the commit is a rename, and a
	 * rename replaces that directory entry, so a symlink there is replaced rather than followed
	 * and its referent never receives the payload.
	 * That is the wrong default for a payload whose destination the user chose -
	 * settings exports carry API credentials - where following a link they never
	 * pointed at would write secrets into a file they did not pick. When this is
	 * set, a symlink at the final path component is an error instead.
	 *
	 * The refusal is not a one-time inspection: the final entry and every ancestor
	 * directory identity are re-derived inside the publication, immediately before
	 * the commit rename, so a directory swapped for a link during the staging
	 * sequence is caught before it can redirect the payload. Node exposes no
	 * handle-relative rename, so the window that remains is the commit rename
	 * itself, not the checks before it.
	 */
	refuseSymlinkTarget?: boolean
}

/**
 * An ancestor directory that passed the symlink refusal, recorded with the
 * bigint device and inode it had at that moment so the publication can tell
 * whether it is still the same directory before committing.
 */
interface CheckedDirectory {
	dir: string
	dev: bigint
	ino: bigint
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
 * - With `refuseSymlinkTarget`, refuses a publish whose final path component or any
 *   ancestor directory is (or becomes) a symlink, re-deriving the refusal immediately before
 *   the commit rename.
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
	} catch (dirError: unknown) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Every existing ancestor must be checked too, not just the final component: a symlinked
	// directory above the target redirects the payload without leaving a trace on the target path
	// itself (e.g. <workspace>/.roo -> a directory outside the workspace). Only ENOENT stops the
	// walk - a missing ancestor means nothing deeper exists to be a link. Any other inspection
	// error fails closed, because "could not inspect" is not evidence that the path is safe.
	// Each directory that passes is recorded with its bigint device and inode: a walk the
	// publication does not re-derive is a refusal an attacker retires by swapping the directory
	// after the walk ran, so the identities feed the pre-commit re-check below.
	async function _refuseSymlinkedAncestors(absoluteFilePath: string): Promise<CheckedDirectory[]> {
		const checked: CheckedDirectory[] = []
		let current = path.dirname(absoluteFilePath)
		for (;;) {
			let st: fsSync.BigIntStats
			try {
				st = await fs.lstat(current, { bigint: true })
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error
						? (error as { code?: string }).code
						: undefined
				if (code === "ENOENT") {
					// Fail closed: a directory that vanishes mid-walk leaves no identity to re-check
					// before publication, and a path that reappears as a symlink afterwards would be
					// followed by the path-based commit rename. Refuse rather than publish blind.
					throw new Error(
						`safeWriteJson: refusing to write to ${absoluteFilePath}: ${current} does not exist, so the destination ancestry cannot be verified.`,
					)
				}
				throw error
			}
			if (st.isSymbolicLink()) {
				throw new Error(
					`safeWriteJson: refusing to write to ${absoluteFilePath}: ${current} is a symlink, and the payload would be written outside the directory the caller named.`,
				)
			}
			checked.push({ dir: current, dev: st.dev, ino: st.ino })
			const parent = path.dirname(current)
			if (parent === current) {
				return checked
			}
			current = parent
		}
	}

	// A credential-bearing payload must not be redirected through a link the user
	// never chose: check the final path component before anything is resolved,
	// staged, or locked.
	let checkedAncestors: CheckedDirectory[] = []
	if (options?.refuseSymlinkTarget) {
		let targetStat: fsSync.Stats | undefined
		try {
			targetStat = await fs.lstat(absoluteFilePath)
		} catch (error: unknown) {
			const code =
				error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined
			// Only a missing target means there is no link to refuse. Anything else -
			// a permission error on the parent directory, for example - is not evidence
			// that the destination is safe to publish into.
			if (code !== "ENOENT") {
				throw error
			}
		}
		if (targetStat?.isSymbolicLink()) {
			throw new Error(
				`safeWriteJson: refusing to write through the symlink at ${absoluteFilePath}; the payload would land on its referent instead of the destination the user chose.`,
			)
		}

		// The final component alone is not enough: a symlinked ancestor redirects the payload while
		// leaving the target path looking ordinary. Checked before anything is resolved, staged or
		// locked, and it fails closed on any inspection error that is not ENOENT. The identities it
		// records are re-derived by the publication hook below - this walk alone leaves the whole
		// staging window open to an ancestor swap.
		checkedAncestors = await _refuseSymlinkedAncestors(absoluteFilePath)
	}

	// Two paths, for two different jobs: lock identity and publication destination.
	// The LOCK is keyed to the resolved referent, because proper-lockfile keys by the path it
	// is given: an alias and its referent would otherwise take two locks for one underlying
	// file, and a concurrent merge through both aliases could read the same JSON and overwrite
	// one update. Resolution happens before the lock for that reason, and resolvePublishTarget
	// tolerates a not-yet-existing file (it returns the given path on ENOENT), preserving the
	// create-from-absent flow.
	// The PUBLISH stays on the caller-named path in both modes: the commit is a rename, and a
	// rename replaces the directory entry rather than writing through a link, so a link the
	// caller never chose gets replaced instead of receiving the payload. That is the
	// pre-existing behaviour - publishing onto the referent instead would be a new default for
	// every caller. With refuseSymlinkTarget the named path is also the lock path: resolving it
	// here would hand back a referent the caller never chose if a link is planted between the
	// refusal check and this resolution, and every such writer keys its lock to the same named
	// path, so the lock still serializes all writers to that entry.
	const lockTargetPath = options?.refuseSymlinkTarget
		? absoluteFilePath
		: await resolvePublishTarget(absoluteFilePath)
	const publishTargetPath = absoluteFilePath

	// The refusal above and this resolution are separate syscalls, so a local writer
	// could replace the final component with a link in between; the resolved path
	// would then describe a destination the caller never chose. Re-check the component
	// the caller named - once here and again under the lock before publishing - so the
	// refusal stays effective through publication.
	const assertFinalComponentNotReplaced = async (stage: string): Promise<void> => {
		// Fail closed: only ENOENT (nothing there that could be a link) is tolerated. A lstat
		// failing for another reason - EACCES on the parent directory, for example - says
		// nothing about whether the entry is safe, so the write stops instead of publishing
		// blind through an unexamined destination.
		let nowStat: fsSync.Stats | undefined
		try {
			nowStat = await fs.lstat(absoluteFilePath)
		} catch (error: unknown) {
			const code =
				error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined
			if (code !== "ENOENT") {
				throw error
			}
		}
		if (nowStat?.isSymbolicLink()) {
			throw new Error(
				`safeWriteJson: refusing to write through the symlink now at ${absoluteFilePath} (${stage}); the payload would land at ${publishTargetPath}, a destination the caller never chose.`,
			)
		}
	}
	if (options?.refuseSymlinkTarget) {
		await assertFinalComponentNotReplaced("after resolution")
	}

	// The initial checks and the commit rename are separated by the whole staging sequence, and
	// Node exposes no handle-relative rename (no renameat): a local writer that swaps an
	// inspected ancestor for a link - or for a different directory - during that window would
	// still redirect the path-based commit rename, and no recheck of the final component would
	// notice, because the swap is one directory up. The publication therefore re-derives the
	// complete ancestry itself - the final entry and every recorded ancestor identity -
	// immediately before the commit rename, so the refusal is enforced at the action it guards.
	// What cannot be closed without a native renameat is stated rather than claimed as
	// protection: the window that remains is the commit rename itself.
	const assertAncestryUnchangedBeforeCommit = async (): Promise<void> => {
		await assertFinalComponentNotReplaced("before publication")
		for (const expected of checkedAncestors) {
			let nowStat: fsSync.BigIntStats
			try {
				nowStat = await fs.lstat(expected.dir, { bigint: true })
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error
						? (error as { code?: string }).code
						: undefined
				// The directory the walk recorded is gone: the ancestry the refusal was based on
				// no longer exists, and a path-based rename would resolve a chain nobody checked.
				if (code === "ENOENT") {
					throw new Error(
						`safeWriteJson: refusing to publish to ${absoluteFilePath}: ${expected.dir} no longer exists; an ancestor of the destination was replaced after it was checked.`,
					)
				}
				throw error
			}
			if (nowStat.isSymbolicLink()) {
				throw new Error(
					`safeWriteJson: refusing to publish to ${absoluteFilePath}: ${expected.dir} is now a symlink; the payload would be written outside the directory the caller named.`,
				)
			}
			if (nowStat.dev !== expected.dev || nowStat.ino !== expected.ino) {
				throw new Error(
					`safeWriteJson: refusing to publish to ${absoluteFilePath}: ${expected.dir} is no longer the directory that was checked; an ancestor of the destination was replaced after it was checked.`,
				)
			}
		}
	}

	// Acquire the lock before any file operations. `acquireFileLock` owns the
	// shared advisory lock protocol, so callers that lock the same path with
	// it (for example task-history deletion) serialize with this write.
	// If lock acquisition fails, it throws immediately. The releaseLock
	// remains a no-op, so the finally block in the main file operations
	// try-catch-finally won't try to release an unacquired lock if this
	// path is taken.
	releaseLock = await acquireFileLock(lockTargetPath)

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null

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

		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write. Must be inside try/finally
		// so a throwing merge still releases the lock.
		if (options?.merge) {
			let existing: unknown = null
			try {
				existing = JSON.parse(await fs.readFile(publishTargetPath, "utf8"))
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

		await _streamDataToFile(actualTempNewFilePath, data, publishTargetPath, options?.prettyPrint)
		await _flushFileToDisk(actualTempNewFilePath)

		// Step 2: Commit the replacement with a single atomic rename. The
		// committed target stays in place until this rename lands, so a
		// process exit before or during the commit can no longer leave the
		// canonical path absent.
		if (options?.refuseSymlinkTarget) {
			// Re-derive the refusal inside the publication, immediately before the commit rename, but
			// outside the rename-fallback try: that handler tests only the error code, so an EPERM
			// raised by this inspection would be mistaken for a rename collision and take the
			// two-step replacement, moving the committed destination to a backup even though the
			// refusal promises that nothing moves. Only rename failures reach the fallback now;
			// the fallback and the crash-recovery pass at the start of the next write are unchanged.
			await assertAncestryUnchangedBeforeCommit()
		}
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
			if (options?.refuseSymlinkTarget) {
				// The fallback's second rename is the same commit action, so it gets the same pre-commit re-check.
				await assertAncestryUnchangedBeforeCommit()
			}
			options?.trace?.({ stage: "replacement-rename", detail: "eperm-fallback" })
			await fs.rename(actualTempNewFilePath, absoluteFilePath)
		}

		// If we reach here, the new file is successfully in place.
		// The original actualTempNewFilePath is now the main file, so we shouldn't try to clean it up as "temp".
		// Mark as "used" or "committed"
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
			console.error(`Failed to release lock for ${lockTargetPath}:`, unlockError)
		}
	}
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @param preserveModeOf The existing file whose mode the staged file must inherit.
 * @param prettyPrint Whether to format the JSON with indentation.
 * @returns Promise<void>
 */
async function _streamDataToFile(
	targetPath: string,
	data: unknown,
	preserveModeOf: string,
	prettyPrint = false,
): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	// The staged payload can carry API credentials and the staging path is generated inside a
	// directory the workspace already controls, so it is opened exclusively: a file a local
	// writer planted at that name fails the write with EEXIST instead of receiving the payload,
	// and a staging path left by a crashed writer is not silently overwritten. The creation mode
	// comes from the file being replaced, so the commit rename can neither widen a 0o600 target
	// nor narrow a shared one - the same rule src/services/file-safety/safeWriteText.ts applies to
	// its own staging file, with 0o644 as the default for a target that does not exist yet.
	let stageMode = 0o644
	let targetExisted = true
	try {
		stageMode = fsSync.statSync(preserveModeOf).mode & 0o777
	} catch (modeError) {
		// Only a genuinely missing target may fall back to the creation default. Every other
		// inspection in this file names ENOENT explicitly - the ancestor walk, the destination
		// re-checks and the publication hook - and a permission or I/O error says nothing about
		// the target's mode, so taking 0o644 for it could widen a 0o600 file or narrow a shared
		// one through the commit rename. Such an error propagates to the caller instead.
		if (getErrorCode(modeError) !== "ENOENT") {
			throw modeError
		}
		// No target yet: the default below leaves the process umask in charge, as before.
		targetExisted = false
	}
	const stagedFd = fsSync.openSync(targetPath, "wx", stageMode)
	if (targetExisted) {
		// openSync applies the process umask to the requested mode, so a 0o664 or 0o666 target
		// would be staged as 0o644 under the common umask 022 and lose group write through the
		// rename. Set the mode on the descriptor instead. A filesystem that refuses chmod keeps
		// the creation mode, which is no wider than what this writer published before.
		try {
			fsSync.fchmodSync(stagedFd, stageMode)
		} catch {
			// best-effort mode alignment; the write itself is not blocked
		}
	}
	let fileWriteStream: fsSync.WriteStream
	let stagingFdClosed = false
	const closeStagingFd = () => {
		if (stagingFdClosed) {
			return
		}
		stagingFdClosed = true
		try {
			fsSync.closeSync(stagedFd)
		} catch (closeError) {
			console.error(`Failed to close the staging descriptor for ${targetPath}:`, closeError)
		}
	}
	try {
		// The stream owns the descriptor but must not close it before the payload that carries
		// the credentials is synchronised on that same descriptor, so autoClose is turned off
		// and the finish handler does the hand: fsync first, then close. The flush below still
		// reopens the stage with r+ as well, but publication no longer depends on that reopen
		// being the only place the stage reaches storage.
		fileWriteStream = fsSync.createWriteStream(targetPath, {
			fd: stagedFd,
			encoding: "utf8",
			autoClose: false,
		})
	} catch (streamError) {
		closeStagingFd()
		throw streamError
	}
	fileWriteStream.on("finish", () => {
		try {
			fsSync.fsyncSync(stagedFd)
		} catch (syncError) {
			// A filesystem that refuses fsync must not block the write: same rule as the flush.
			console.error(`Failed to synchronise ${targetPath} on its staging descriptor:`, syncError)
		}
		closeStagingFd()
	})
	fileWriteStream.on("error", closeStagingFd)

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
