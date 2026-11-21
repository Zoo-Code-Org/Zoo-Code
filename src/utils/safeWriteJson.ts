import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { getErrorCode } from "./errorCode"
import { acquireFileLock, lockPathFor } from "./fileLock"
import { resolveLockKey, resolvePublishTarget } from "../services/file-safety/safeWriteText"
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
	 * Restrict the write to a directory. The publish target is resolved through
	 * symlinks before this check runs, so a caller that picked the path from a
	 * known scope (a workspace, a project settings directory) can refuse a write
	 * that a planted symlink would land somewhere else. The check runs before the
	 * advisory lock is taken and before anything is staged.
	 */
	confineTo?: string

	/**
	 * When provided, receives one event per replacement-protocol step (see
	 * SafeWriteJsonTraceStage). Callers such as the task-message save use it
	 * to emit diagnostic trace lines; it never influences the write itself.
	 */
	trace?: SafeWriteJsonTrace
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
 * Thrown when the advisory lock this write holds no longer names the path it is about to
 * publish. The lock key is resolved before the lock is taken and the publish target is
 * resolved under it, so an alias repointed in between would otherwise let this writer commit
 * onto a file whose lock belongs to another writer. Nothing is staged when this rejects.
 */
class LockKeyDriftError extends Error {
	constructor(requestedPath: string, lockKey: string, publishTarget: string) {
		super(
			`Refusing to publish ${publishTarget}: the advisory lock was taken for ${lockKey}, which is no longer the file this write resolves to (requested ${requestedPath}). Retry the write.`,
		)
		this.name = "LockKeyDriftError"
	}
}
/**
 * Whether two lock keys denote one lock.
 *
 * The drift guard further down exists because two writers holding two different locks can
 * commit onto one file, each believing it owned it. That is a claim about the locks, and the
 * lock for a key is the artefact at lockPathFor(key). On a case-folding filesystem (NTFS,
 * APFS) `SETTINGS.JSON.lock` and `settings.json.lock` ARE one artefact, so a writer that
 * computed its key from a name that did not exist yet and then meets that file's true name
 * under the lock is holding the very lock the other spelling would take: nothing about its
 * lock changed, and comparing the two spellings refuses a write that never needed refusing.
 *
 * The question is put to the filesystem through fs.stat with bigint: true, for the same
 * reason safeWriteText.ts puts its staging-containment question that way: on NTFS and ReFS a
 * file identity can exceed Number.MAX_SAFE_INTEGER, and a rounded number makes two artefacts
 * look different from each other or two different artefacts look alike. The spelling
 * comparison stays in front of this as the fast path, so a stat is only asked when the
 * spellings already differ. A missing artefact is the one failure that carries no information
 * about identity, so the keys are then treated as different locks and the original rejection
 * stands. Any other stat failure propagates: a guard that answered "different locks" from an
 * EACCES would be refusing for a reason it never measured.
 */
async function _locksAreOneLock(firstKey: string, secondKey: string): Promise<boolean> {
	// A divergence in another directory is not this question. A key whose parent was
	// re-keyed under the writer can resolve its own artefact spelling onto some other
	// writer's artefact, and an identity match there says nothing about the lock this
	// writer took. Only a name that differs from its counterpart by case, within the
	// same directory, can be one lock under two spellings - and even then the
	// filesystem, not the spelling, is what answers.
	if (path.dirname(firstKey) !== path.dirname(secondKey)) {
		return false
	}
	if (path.basename(firstKey).toLowerCase() !== path.basename(secondKey).toLowerCase()) {
		return false
	}
	const first = await _statLockArtefact(lockPathFor(firstKey))
	if (first === undefined) {
		return false
	}
	const second = await _statLockArtefact(lockPathFor(secondKey))
	if (second === undefined) {
		return false
	}
	return first.dev === second.dev && first.ino === second.ino
}

/**
 * Stat one lock artefact. undefined means the artefact is not there - the only failure that
 * says something about this comparison. Anything else is the guard losing its ability to
 * decide, and it propagates rather than being read as "not the same lock".
 */
async function _statLockArtefact(lockPath: string): Promise<fsSync.BigIntStats | undefined> {
	try {
		return await fs.stat(lockPath, { bigint: true })
	} catch (error: unknown) {
		if (getErrorCode(error) === "ENOENT") {
			return undefined
		}
		throw error
	}
}

/**
 * Thrown when the directory this write was approved to stage into no longer names that
 * directory. The publish target and the staging location are resolved under the lock, but
 * a resolved path is a pathname, not a bound identity: if the target's parent is replaced
 * with a link pointing elsewhere before the staged file is written, the staged JSON is
 * created outside the directory this write was approved for, and the commit rename that
 * follows would then move that stray file onto the target. Rejecting here leaves nothing
 * on disk.
 */
class StagingDirectoryDriftError extends Error {
	constructor(requestedPath: string, approvedDirectory: string, actualDirectory: string) {
		super(
			`Refusing to stage ${requestedPath}: the directory this write was approved for (${approvedDirectory}) now resolves to ${actualDirectory}. Retry the write.`,
		)
		this.name = "StagingDirectoryDriftError"
	}
}

/**
 * Whether two paths name the same directory. `realpath` reports the on-disk spelling,
 * which can differ in case on Windows, so the identity being compared here is the
 * directory, not the spelling of it.
 */
function _sameDirectory(approved: string, actual: string): boolean {
	return process.platform === "win32" ? approved.toLowerCase() === actual.toLowerCase() : approved === actual
}

/**
 * Canonicalize a directory a write is confined to or approved to stage into. The publish
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
		if (_scopeErrorCode(error) !== "ENOENT") {
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
				if (_scopeErrorCode(innerError) !== "ENOENT") {
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

function _scopeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
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

	// An empty confineTo is a declared scope, not the absence of one: `""` resolves to the
	// process working directory, so the checks below test for presence, and the presence
	// decision happens once, here. A truthiness test would silently drop a scope a caller
	// declared as an empty string. No production call site passes confineTo at all - the
	// option is read nowhere outside this module - so nothing in the tree changes behaviour
	// under either reading. If a maintainer decides an empty string should mean "unset"
	// instead, that is a one-line change to this presence test with a test row of its own,
	// not a redesign.
	const confineTo = options?.confineTo

	// Confinement is checked before ANY filesystem side effect. mkdir -p through a
	// planted symlinked ancestor (projectDir/.roo -> /elsewhere) would create
	// directories outside the declared scope, and an unwritable referent would surface
	// the mkdir error instead of the ConfinedPathEscapeError the caller is entitled to.
	// _resolveScopeRoot resolves a not-yet-existing path through its nearest existing
	// ancestor, so this works for the target's missing parents too.
	if (confineTo !== undefined) {
		const scopeRoot = await _resolveScopeRoot(confineTo)
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

	// The lock is taken on the key that resolveLockKey establishes for the file - the canonical
	// spelling, which is the key every other writer to this file takes it on (see the acquisition
	// comment in core/tools/guardedWrite.ts at lines 190 to 192, and the note on the publish
	// primitive at lines 233 to 236, both of which state that safeWriteJson holds the resolved key).
	// Spelled from the caller's pathname instead, a writer whose path runs through an alias directory
	// and a writer that resolved that directory hold two locks for one file, and this function's own
	// drift check below then refuses an alias write it was never meant to refuse, because the lock it
	// holds and the target it measures were then spelled from two different questions.
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement is checked here as well as under the lock. The lock file lives NEXT
	// TO the key, so a planted symlink that points outside the declared scope would
	// first make this write create "<referent>.lock" outside that scope - a side effect
	// the caller declared it would not have - and if that directory is not writable the
	// caller would get a lock-acquisition error instead of the ConfinedPathEscapeError
	// it is entitled to. The key is the symlink referent, so this check sees the same
	// destination the lock would be taken on. The under-lock check stays: it covers the
	// target re-resolved after a peer commits.
	if (confineTo !== undefined) {
		const scopeRoot = await _resolveScopeRoot(confineTo)
		if (_escapesScope(scopeRoot, await _resolveScopeRoot(lockKey))) {
			throw new ConfinedPathEscapeError(absoluteFilePath, lockKey, scopeRoot)
		}
	}

	// Acquire the lock before any file operations. `acquireFileLock` owns the
	// shared advisory lock protocol, so callers that lock the same path with
	// it (for example task-history deletion) serialize with this write.
	// If lock acquisition fails, it throws immediately. The releaseLock
	// remains a no-op, so the finally block in the main file operations
	// try-catch-finally won't try to release an unacquired lock if this
	// path is taken.
	releaseLock = await acquireFileLock(lockKey)

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null
	// Present only while the EPERM fallback holds the target renamed aside as a backup.
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

		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

		// The lock above was chosen from the key this write resolved before taking it, and the
		// publish target is resolved under the lock - after a peer committed, and after the alias
		// itself may have been repointed. If the two no longer name the same file, this writer is
		// holding the lock of a path it is not about to publish while some other writer can hold
		// the lock of the one it is about to publish, which is two commits onto one file each
		// believing it owned it. Nothing has been staged or merged yet, so rejecting here leaves
		// every file untouched and the caller can retry against the key it resolves to now.
		const underLockKey = await resolveLockKey(resolvedTargetPath)
		// Different spellings are not yet evidence of a different lock: the pair is refused
		// only when the two lock artefacts are not the same filesystem object.
		if (underLockKey !== lockKey && !(await _locksAreOneLock(lockKey, underLockKey))) {
			throw new LockKeyDriftError(absoluteFilePath, lockKey, resolvedTargetPath)
		}

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. This runs before the merge read and before anything is staged, so a
		// rejected write leaves nothing behind.
		if (confineTo !== undefined) {
			const scopeRoot = await _resolveScopeRoot(confineTo)
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
			await fs.rename(actualTempNewFilePath, resolvedTargetPath ?? absoluteFilePath)
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
	// The mode cannot ride on the create call alone. createWriteStream opens the file, and an
	// open's creation mode is narrowed by the process umask, so an existing 0o664 target would be
	// published as 0o644 under a 0o022 umask - the group write it had would go missing with the
	// rename. One fchmod on the descriptor states the mode exactly. It is bound to the descriptor
	// rather than to the path, as safeWriteText.ts:499-:503 and :529-:547 do for text writes: the
	// staging name is this writer's own, and an fd-bound chmod cannot be retargeted by another
	// writer moving a path underneath it. A missing mode means there was no publish target to
	// copy from, and the creation default is left to stand, un-enforced as before.
	let stagingFd: number | undefined
	try {
		stagingFd = fsSync.openSync(targetPath, "w", mode)
		if (mode !== undefined) {
			fsSync.fchmodSync(stagingFd, mode)
		}
	} catch (stageError: unknown) {
		// An fchmod that fails leaves a descriptor behind, and a write that is going to report a
		// failure should not also leak the handle it opened to make it.
		if (stagingFd !== undefined) {
			fsSync.closeSync(stagingFd)
		}
		throw stageError
	}
	// The descriptor is already open, so the stream takes it and closes it when the write ends,
	// as it did when it opened the file itself. Passing the path alongside the fd is for the
	// error message Node attaches to a stream failure; Node ignores the path once an fd is given.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8", fd: stagingFd })
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
