import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { resolveLockKey, resolvePublishTarget } from "../services/file-safety/safeWriteText"

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
	 * Restrict the write to a directory. The publish target is resolved through
	 * symlinks before this check runs, so a caller that picked the path from a
	 * known scope (a workspace, a project settings directory) can refuse a write
	 * that a planted symlink would land somewhere else. The check runs before the
	 * advisory lock is taken and before anything is staged, and it is repeated on
	 * the resolved publish target inside the lock so a peer writer that moved the
	 * referent in between is caught too. Confinement is active whenever this option
	 * is DEFINED: a declared root that is empty or whitespace-only is rejected
	 * rather than silently disabling the checks.
	 *
	 * What it does NOT cover: an ancestor DIRECTORY of the target that is replaced
	 * by a link in the window between the last check and the commit rename. Both
	 * checks decide from the final component as it resolves at their own instant,
	 * and publication is path based - the parent-directory creation and the commit
	 * rename both take a path - so an ancestor swapped after the check redirects the
	 * publish. What happens then depends on what sits at the swapped-in path: if it
	 * already has a file at the target name the publish fails in the staging
	 * identity guard (StagingPathError) and nothing is written; if it does not, the
	 * write follows the swapped ancestor and lands OUTSIDE the declared scope. This
	 * option claims neither outcome: it confines the target it resolved, not the
	 * directory tree above it. Making the claim cover that window needs a publish
	 * that walks from an already-open directory handle with no-follow semantics
	 * (openat/renameat over a directory fd); this runtime exposes neither, so the
	 * claim is narrowed here instead of being made true. A caller that needs
	 * containment across that window cannot get it from this option.
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

function createTempFilePath(absoluteFilePath: string, kind: "new" | "bak"): string {
	return path.join(
		path.dirname(absoluteFilePath),
		`.${path.basename(absoluteFilePath)}.${kind}_${Date.now()}_${Math.random().toString(36).substring(2)}.tmp`,
	)
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
 * Reject a candidate publish path that escapes the caller's confined scope.
 * Shared by the pre-lock check and the in-lock check so both canonicalize the
 * same way: the candidate is resolved through symlinks and compared against the
 * resolved scope root.
 */
function _assertWithinScope(requestedPath: string, candidatePath: string, scopeRoot: string): void {
	const relative = path.relative(scopeRoot, candidatePath)
	if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new ConfinedPathEscapeError(requestedPath, candidatePath, scopeRoot)
	}
}

/**
 * The scope root a caller declared, or undefined when no scope was declared.
 * Confinement is active whenever confineTo is DEFINED: a declared root that is
 * empty or whitespace-only cannot contain any canonicalized path - path.resolve("")
 * is the process cwd, not the scope the caller named - so it fails closed here
 * instead of silently disabling the checks below, which would let the write
 * follow any symlink with no scope check at all. Both confinement checks key off
 * this single decision, so they can never disagree about whether a scope is
 * active.
 */
function _declaredScopeRoot(confineTo: string | undefined, requestedPath: string): string | undefined {
	if (confineTo === undefined) {
		return undefined
	}
	if (confineTo.trim() === "") {
		throw new ConfinedPathEscapeError(requestedPath, requestedPath, confineTo)
	}
	return confineTo
}

/**
 * Undo exactly the file this write published at the escaped location.
 *
 * The path alone cannot prove the file is ours: a concurrent writer can replace it
 * between the commit and this re-check, and unlinking on the name would then delete a
 * peer's file. The bytes this write staged are therefore compared with the bytes now on
 * disk, and a mismatch leaves the peer's file untouched. The escape is reported to the
 * caller either way.
 * @internal Exported for the escape-undo regression tests.
 */
export async function undoEscapedPublish(publishedPath: string, expectedBytes: Buffer | undefined): Promise<void> {
	if (expectedBytes === undefined) {
		return
	}
	const before = await fs.stat(publishedPath, { bigint: true }).catch(() => undefined)
	if (!before) {
		return
	}
	const actualBytes = await fs.readFile(publishedPath).catch(() => undefined)
	if (actualBytes === undefined || !actualBytes.equals(expectedBytes)) {
		return
	}
	// Re-stat immediately before the unlink: a peer may have replaced the file between
	// the read and the delete, and unlinking it would remove that peer's content.
	const after = await fs.stat(publishedPath, { bigint: true }).catch(() => undefined)
	if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
		return
	}
	await fs.unlink(publishedPath).catch(() => {})
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Recovers an interrupted previous write before touching the file: restores an orphaned backup when the canonical path is absent, and removes leftover temp files.
 * - Writes to a temporary file first, then commits it with a single atomic rename, so the committed target stays readable through an interrupted write.
 * - When a single rename over the target fails with EPERM (a reader holds the file open on Windows), falls back to backing the target up before replacing it.
 * - With confineTo declared, refuses a publish whose resolved target lands outside that directory, before the lock and again under it.
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

	// Confinement is decided once, up front, so both checks below agree on whether a
	// scope is active: active whenever confineTo is defined, with a declared-but-empty
	// root failing closed before the lock key is resolved, before the lock is taken,
	// before any directory is created, and before anything is staged.
	const confinementRoot = _declaredScopeRoot(options?.confineTo, absoluteFilePath)

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must be computable
	// while a peer writer is mid-commit (backup mode renames the referent away and
	// back), so the walk tolerates a dangling link instead of rejecting it here.
	let lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement, if the caller declared a scope, is checked BEFORE the lock is
	// Also before the parent-directory creation below: an out-of-scope target with a
	// missing parent would otherwise get a directory created outside confineTo.
	// taken: proper-lockfile creates ${lockKey}.lock beside the lock key, and the key
	// is the symlink referent, so a repository-planted link out of the scope would
	// otherwise create a lock directory outside the scope (and an unwritable referent
	// directory would surface a lock-acquisition error after retries instead of
	// ConfinedPathEscapeError). Repeated on the resolved publish target inside the
	// lock, since a peer writer may move the referent in between.
	if (confinementRoot !== undefined) {
		const scopeRoot = await _resolveScopeRoot(confinementRoot)
		_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(lockKey), scopeRoot)
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

	// Acquire the lock before any file operations. `acquireFileLock` owns the
	// shared advisory lock protocol, so callers that lock the same path with
	// it (for example task-history deletion) serialize with this write.
	// If lock acquisition fails, it throws immediately. The releaseLock
	// remains a no-op, so the finally block in the main file operations
	// try-catch-finally won't try to release an unacquired lock if this
	// path is taken.
	releaseLock = await acquireFileLock(lockKey)

	// Declared before the protected block so the catch can name the bytes an escaped
	// publish left behind; the assignment below stays where our copy put it.
	let stagedBytes: Buffer | undefined

	// Variables to hold the actual paths of temp files if they are created.
	let actualTempNewFilePath: string | null = null
	let actualTempBackupFilePath: string | null = null

	try {
		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

		// The key was computed before the lock was taken, but the publish target is resolved
		// under it: a symlink retargeted in between means this writer holds the OLD referent's
		// lock and would merge into the new one. Re-derive the key and move to it before
		// staging, so every writer through the current referent queues behind the same lock.
		for (let attempt = 0; attempt < 3; attempt++) {
			const recomputedLockKey = await resolveLockKey(absoluteFilePath)
			if (recomputedLockKey === lockKey) {
				break
			}
			if (confinementRoot !== undefined) {
				const scopeRoot = await _resolveScopeRoot(confinementRoot)
				_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(recomputedLockKey), scopeRoot)
			}
			await releaseLock()
			releaseLock = async () => {}
			lockKey = recomputedLockKey
			releaseLock = await acquireFileLock(lockKey)
			resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)
		}
		if ((await resolveLockKey(absoluteFilePath)) !== lockKey) {
			throw new Error(
				`safeWriteJson: refusing to publish ${absoluteFilePath}: the resolved target kept changing while acquiring the lock`,
			)
		}

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. This runs before the merge read and before anything is staged, so a
		// rejected write leaves nothing behind. It is also the LAST confinement
		// decision of this write: it decides the final component as it resolves here,
		// and an ancestor directory replaced by a link between this point and the
		// commit rename below is outside its reach, because the rename takes a path and
		// re-resolves the tree at rename time. See the confineTo option doc for what the
		// two outcomes of that window are and why neither is claimed by this option.
		if (confinementRoot !== undefined) {
			const scopeRoot = await _resolveScopeRoot(confinementRoot)
			_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(resolvedTargetPath), scopeRoot)
		}

		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement
		// files. Runs first so a merge callback reads the restored content.
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
		options?.trace?.({ stage: "write-start" })
		actualTempNewFilePath = createTempFilePath(resolvedTargetPath, "new")

		// Staging, the commit rename, the EPERM fallback's two renames and the rollback all take
		// resolvedTargetPath - one resolved string for the whole publication. Staging beside the
		// raw path when the target is a link's referent would make the commit rename cross
		// filesystems, and mixing the two spellings is how a publish ends up beside the link
		// it meant to replace.

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// The bytes this write publishes identify the file a post-commit escape undo may
		// remove. They are read after the staged file is written - before it there is nothing
		// to read, and reading early failed with ENOENT on every confined write that reached
		// the publish - and before the mode copy below, so a restrictive target mode cannot
		// turn this read into a failure. A read failure aborts the write: publishing without
		// the bytes would leave the undo unable to verify (and remove) an escaped file.
		if (confinementRoot !== undefined) {
			stagedBytes = await fs.readFile(actualTempNewFilePath)
		}

		// CWE-732: the commit rename below lands the staged file onto the target, so the
		// file that survives carries the staged file's mode, not the target's. A 0o600
		// target would otherwise be published 0o644 from the umask-derived default. The
		// #1912 head (085fbf85e) carries this step for the same function; the blob main
		// brought in does not, and without it the two resolutions differ on a permission
		// property and the row that pins it can only pass on one platform.
		await _copyTargetMode(resolvedTargetPath, actualTempNewFilePath)

		await _flushFileToDisk(actualTempNewFilePath)

		// A peer can replace an ancestor directory between the check above and the commit
		// rename, and the rename takes a path: it replaces whatever file sits where it lands.
		// Re-verify the destination here, as late as the publish allows, so an escaped commit
		// is refused before it can overwrite bytes this write never read. The teardown below
		// removes the staged file, so both files keep their own content. A swap that lands
		// between this check and the rename is still caught fail-closed by the re-check after
		// the commit.
		if (confinementRoot !== undefined) {
			const commitScopeRoot = await _resolveScopeRoot(confinementRoot)
			_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(resolvedTargetPath), commitScopeRoot)
		}
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
		actualTempNewFilePath = null
		options?.trace?.({ stage: "write-complete" })

		// Fail-closed confinement re-check. The check above decides the target as it
		// resolves at check time; publication takes a path and re-resolves the tree
		// at commit time, so an ancestor directory replaced by a link inside that
		// window would publish outside the declared scope. Re-resolve after the
		// commit: if the bytes landed outside, undo by removing exactly the file
		// this write published at the escaped location (never a same-named file a peer
		// placed there after the commit) and report the escape. The peer's swap itself is
		// left as the peer made it. (A swapped-in directory
		// that already carried a target file is not stopped earlier here: the commit rename
		// replaces the file it lands on, so the undo below is what keeps the escaped publish
		// from leaving our bytes in place of somebody else's.)
		if (confinementRoot !== undefined) {
			const publishedPath = await _resolveScopeRoot(resolvedTargetPath)
			const scopeRoot = await _resolveScopeRoot(confinementRoot)
			try {
				_assertWithinScope(absoluteFilePath, publishedPath, scopeRoot)
			} catch (escapeError) {
				// Undo only the file this write published, never a same-named file a peer
				// placed there after the commit.
				await undoEscapedPublish(publishedPath, stagedBytes)
				throw escapeError
			}
		}

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
		) // A confinement escape is reported as the escape, not as whatever the teardown
		// surfaced: re-resolve the publish target, and if the committed bytes landed outside
		// the declared scope, remove exactly the file this write published there and report
		// ConfinedPathEscapeError. undoEscapedPublish compares the staged bytes first, so a
		// peer's file at the same name - including a backup this rollback just restored -
		// is left alone. Errors that are not an escape keep their own type.
		if (confinementRoot !== undefined && resolvedTargetPath !== undefined) {
			// This re-check runs while the write is already failing, so it must not decide what the
			// teardown does. Both locals stay undefined until their resolution lands, which is what
			// separates a scope that cannot be canonicalized from a target that escaped the scope.
			let publishedPath: string | undefined
			let scopeRoot: string | undefined
			try {
				publishedPath = await _resolveScopeRoot(resolvedTargetPath)
				scopeRoot = await _resolveScopeRoot(confinementRoot)
				_assertWithinScope(absoluteFilePath, publishedPath, scopeRoot)
			} catch (checkError) {
				if (publishedPath !== undefined && scopeRoot !== undefined) {
					// The check ran and said escape: undo exactly this write's bytes and report the
					// escape, as before.
					await undoEscapedPublish(publishedPath, stagedBytes)
					throw checkError
				}
				// The scope could not be canonicalized at all. Report it and keep going, so the
				// rollback and the staged cleanup below still run and the failure the caller sees
				// stays the one this catch block was entered with.
				console.error(
					`Confinement re-check for ${absoluteFilePath} could not run during the teardown:`,
					checkError,
				)
			}
		}

		const newFileToCleanupWithinCatch = actualTempNewFilePath
		const backupFileToRollbackOrCleanupWithinCatch = actualTempBackupFilePath

		// Attempt rollback if a backup was made
		if (backupFileToRollbackOrCleanupWithinCatch) {
			try {
				// A backup only ever exists once the resolved target is fixed, so the fallback is
				// for the type, not for a reachable case; naming it here keeps the rollback and the
				// commit rename on the same resolved string.
				await fs.rename(backupFileToRollbackOrCleanupWithinCatch, resolvedTargetPath ?? absoluteFilePath)
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
				// The staged file is often already gone: the commit rename consumed it, or an
				// earlier teardown removed it. Finding it absent is the expected outcome of a
				// failed publish, not a second failure, so it is not logged as one. Any other
				// cleanup failure is still reported.
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
		console.error(`Failed to copy mode ${mode.toString(8)} from ${targetPath} onto ${stagedPath}:`, chmodError)
	}
}

/**
 * Syncs the directory that holds a freshly committed file.
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
