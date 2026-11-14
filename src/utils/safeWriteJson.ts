import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { getErrorCode } from "./errorCode"
import { acquireFileLock } from "./fileLock"
import { recoverInterruptedReplacement } from "./jsonFileRecovery"
import {
	AncestorReplacedError,
	resolveLockKey,
	resolvePublishTarget,
	TargetMovedError,
	type AncestorIdentity,
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

/**
 * The directories between the canonical scope root and the target's parent, each with
 * the identity it had when the write was authorized. `confineTo` decides from the
 * resolved target; this is what lets the publish notice that a directory it walked was
 * replaced afterwards, because safeWriteText re-reads every one of them right before the
 * commit rename (see the confineTo option doc).
 *
 * A component that does not exist yet (a create into a directory the publish itself will
 * make) has no identity to pin, so it is skipped: there is nothing to compare, and the
 * pin exists to detect a directory that WAS walked being swapped, not to forbid creating
 * one.
 */
/**
 * Re-verify the pinned confinement decision against what is on disk now.
 *
 * The target name is checked first, because an existing target makes an ancestor swap visible in
 * the resolved name itself: that is TargetMovedError, and the error carries what the path resolves
 * to NOW rather than the resolution the write was authorized against, so a caller reading the
 * failure sees the destination that exists instead of the one that stopped being true. A create
 * into a swapped directory leaves the name resolving to itself, so the pinned directories are what
 * catch it: AncestorReplacedError, naming the directory that moved.
 *
 * Each pinned directory is compared by identity and by resolution. A directory that was moved
 * keeps its dev+ino and its old name can be replaced by a link that points at it, so the identity
 * comparison passes while the name no longer means the location that was walked; the publish takes
 * path strings and would follow that link out of the scope. A stat or realpath failure that is not
 * "this path is gone" (EACCES, EIO) is propagated unchanged: reporting it as a replaced ancestor
 * would point the user at a containment problem that is not there.
 */
async function _assertConfinementStillHolds(
	absoluteFilePath: string,
	expectedResolvedPath: string,
	pinnedDirectories: AncestorIdentity[],
): Promise<void> {
	const currentResolvedPath = await resolvePublishTarget(absoluteFilePath)
	if (currentResolvedPath !== expectedResolvedPath) {
		throw new TargetMovedError(expectedResolvedPath, currentResolvedPath)
	}
	for (const pinnedDirectory of pinnedDirectories) {
		const now = await fs.stat(pinnedDirectory.dir, { bigint: true }).catch((error: unknown) => {
			const code = getErrorCode(error)
			if (code === "ENOENT" || code === "ENOTDIR") {
				return undefined
			}
			throw error
		})
		// The error names the directory that moved; the reason is what this comparison actually
		// observed, stated without the identity numbers it compared.
		if (now === undefined || now.dev !== pinnedDirectory.dev || now.ino !== pinnedDirectory.ino) {
			throw new AncestorReplacedError(
				pinnedDirectory.dir,
				"is no longer the directory the confinement check walked",
			)
		}
		const resolvedDir = await fs.realpath(pinnedDirectory.dir).catch((error: unknown) => {
			const code = getErrorCode(error)
			if (code === "ENOENT" || code === "ENOTDIR") {
				return undefined
			}
			throw error
		})
		if (resolvedDir === undefined || path.resolve(resolvedDir) !== path.resolve(pinnedDirectory.dir)) {
			throw new AncestorReplacedError(
				pinnedDirectory.dir,
				"no longer resolves to the location the confinement check walked",
			)
		}
	}
}

async function _ancestorIdentities(root: string, targetParent: string): Promise<AncestorIdentity[]> {
	const relative = path.relative(root, targetParent)
	const chain: string[] = [root]
	if (relative && relative !== "." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
		let cursor = root
		for (const segment of relative.split(path.sep)) {
			cursor = path.join(cursor, segment)
			chain.push(cursor)
		}
	}
	const pinned: AncestorIdentity[] = []
	for (const dir of chain) {
		// A missing ancestor has no identity to pin, but any other stat failure means the
		// walk could not verify the chain: dropping it would let a swapped-in directory
		// escape the confine check, so fail closed instead of skipping the pin.
		// The publish creates the target's parent before it takes the lock and pins the ancestors
		// after the lock is held, so a component that is missing here was removed during the publish.
		// Skipping it would leave the chain unverified, and a symlink placed at that path before the
		// staging write sends both the staged file and the commit rename outside the confine.
		const stat = await fs.stat(dir, { bigint: true })
		pinned.push({ dir, dev: stat.dev, ino: stat.ino })
	}
	return pinned
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

	// Pinned before the lock is taken: the canonical directory the write is confined to. Every
	// confinement decision below is made against THIS root. Re-resolving confineTo after the lock
	// would follow a link that someone placed at the scope's name while this writer waited, and the
	// check would then bless whatever directory arrived there instead of the one the caller named.
	let confinedScopeRoot: string | undefined

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
		confinedScopeRoot = scopeRoot
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
	if (confinedScopeRoot !== undefined) {
		if (_escapesScope(confinedScopeRoot, await _resolveScopeRoot(lockKey))) {
			throw new ConfinedPathEscapeError(absoluteFilePath, lockKey, confinedScopeRoot)
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
		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. The root is the one captured before the lock, so a link placed at the
		// scope's own name while this writer waited cannot move the goalposts. This runs
		// before the merge read and before anything is staged, so a rejected write leaves
		// nothing behind.
		if (confinedScopeRoot !== undefined) {
			if (_escapesScope(confinedScopeRoot, await _resolveScopeRoot(resolvedTargetPath))) {
				throw new ConfinedPathEscapeError(absoluteFilePath, resolvedTargetPath, confinedScopeRoot)
			}
		}

		// What the confinement decision was made ABOUT is pinned for the rest of the publish: the
		// resolved publish target, and the identity (dev, ino) of every directory walked from the
		// scope root down to the target's parent. The pins are re-verified three times - before
		// recovery touches the tree, after the merge read and before anything is staged, and
		// immediately before the commit rename - so an ancestor directory replaced by a link at any
		// point in the publish aborts it instead of redirecting it outside the scope. Without the
		// pins the publish would follow the swap at each of those steps.
		let expectedResolvedPath: string | undefined
		let expectedAncestorIdentities: AncestorIdentity[] | undefined
		if (confinedScopeRoot !== undefined) {
			const canonicalTarget = await _resolveScopeRoot(resolvedTargetPath)
			expectedResolvedPath = resolvedTargetPath
			expectedAncestorIdentities = await _ancestorIdentities(confinedScopeRoot, path.dirname(canonicalTarget))
			// Verify before recovery touches anything. Recovery renames an orphaned backup into the
			// target's directory and deletes leftover replacement files it matches by name; doing that
			// before the walked directories are re-verified would let an ancestor that was already
			// replaced move those changes outside confineTo, where the caller never authorized any write.
			await _assertConfinementStillHolds(absoluteFilePath, expectedResolvedPath, expectedAncestorIdentities)
		}

		// Heal any state an interrupted previous write left behind: an absent
		// canonical path with an orphaned backup, or leftover replacement files. Runs
		// before the merge read so a merge callback reads the restored content, and after
		// the checks above so it cannot act outside the declared scope. It scans the
		// directory the LOCK KEY names rather than the directory of the path this caller
		// spelled: the interrupted write staged its files beside the publish target it
		// resolved, so a writer arriving through a differently named alias can only find
		// them by looking beside the referent - which is where the key points.
		const recovery = await recoverInterruptedReplacement(lockKey).catch((error: unknown) => {
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

		// Re-verify the pinned decision against what is on disk now, before anything is staged.
		if (expectedResolvedPath !== undefined) {
			await _assertConfinementStillHolds(absoluteFilePath, expectedResolvedPath, expectedAncestorIdentities ?? [])
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
		//
		// The check above ran before the staged write; the staged write is the step that takes the
		// time. Verify again here, against the statement that actually acts on the pinned decision,
		// so an ancestor replaced while the JSON was streaming to disk cannot publish outside the
		// scope: the rename below moves the staged file along the path this write resolved before the
		// swap, and the staged file itself already followed the swap.
		if (expectedResolvedPath !== undefined) {
			await _assertConfinementStillHolds(absoluteFilePath, expectedResolvedPath, expectedAncestorIdentities ?? [])
		}
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
	// mode 0o600 at creation: the staged file holds the caller's content - task history, MCP
	// servers, settings - for as long as it takes to stream, flush, copy the target's mode onto it
	// and rename it. Created with the process umask it would be group- and world-readable for that
	// whole window, and the mode copy below can only narrow a staged file, not make an already-read
	// copy unreadable again. A target with its own mode still gets that mode, applied below.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8", mode: 0o600 })

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
 * does not silently widen it. A missing target has no mode to copy. Any other failure
 * aborts the write rather than logging and proceeding: the commit renames the staged
 * file onto the target, so a write that could not read the target's mode, or could not
 * put it on the staged file, would publish a 0o600 file's content under 0o644 and tell
 * nobody. That is the same rule safeWriteText states for its own mode handling (see its
 * errorCode helper), and the staged file is created 0o600 so the content is never
 * readable to others while this decision is being made.
 */
async function _copyTargetMode(targetPath: string, stagedPath: string): Promise<void> {
	let mode: number
	try {
		const stats = await fs.stat(targetPath)
		mode = stats.mode & 0o777
	} catch (statError: unknown) {
		const code = getErrorCode(statError)
		if (code === "ENOENT" || code === "ENOTDIR") {
			// Nothing is committed yet and no mode exists to preserve: the staged file's own
			// private mode is the mode this write publishes.
			return
		}
		// The target's mode is unknown, so the mode the publish would land cannot be checked.
		// Failing here is the only answer that cannot widen a restrictive file's access.
		throw new Error(`safeWriteJson: could not read the mode of ${targetPath} before publishing onto it`, {
			cause: statError,
		})
	}
	try {
		await fs.chmod(stagedPath, mode)
	} catch (chmodError: unknown) {
		// The staged file is what becomes the target. Publishing it with its own mode would
		// replace a restrictive file with a permissive one, which is the failure this step exists
		// to prevent, so the write stops with the mode it could not honour named in the error.
		throw new Error(
			`safeWriteJson: could not copy mode ${mode.toString(8)} from ${targetPath} onto the staged file ${stagedPath}`,
			{ cause: chmodError },
		)
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
