import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

export interface SafeWriteTextOptions {
	/**
	 * When true, keep the old-file semantics without ever removing the target: the
	 * previous content is copied to a hidden backup path and flushed before the
	 * commit rename, the commit rename atomically replaces the target, and on success
	 * the backup copy is deleted. A failure before the commit leaves the target
	 * untouched (there is nothing to roll back) and removes the backup copy. When
	 * false (default) the atomic rename simply replaces the target.
	 */
	backup?: boolean

	/**
	 * Platform override for testing.  When omitted the real process.platform
	 * value is used.  Set to "win32" or "linux" / "darwin" from tests so that
	 * both branches are reachable without needing a real Windows runner.
	 */
	platform?: string

	/**
	 * Custom execFile runner for testing (e.g. vi.fn).  When omitted the real
	 * child_process.execFile is used.
	 */
	execFileRunner?: typeof execFile

	/**
	 * Sink for non-fatal safety notices. A Windows DACL that could not be captured means the
	 * committed file may inherit different access rights: the write still proceeds (a missing or
	 * failing icacls must not block saving), but the caller is told instead of the change being
	 * silent. Defaults to console.warn.
	 */
	onWarning?: (message: string) => void

	/**
	 * Pre-written temp path to use for the commit phase.  When provided,
	 * safeWriteText skips creating its own staging file and uses this path
	 * instead (it still fsyncs before rename).  Useful when a caller has
	 * already written data to a temp file via a custom stream.
	 */
	tempPath?: string
}

/**
 * A caller-supplied staging path that is not a file this write may publish: it
 * sits outside the target's directory (so the commit rename would cross
 * filesystems) or is not a regular file. Rejecting it before any write keeps the
 * target from being replaced by whatever the path points at.
 */
export class StagingPathError extends Error {
	readonly stagingPath: string

	constructor(message: string, stagingPath: string) {
		super(message)
		this.name = "StagingPathError"
		this.stagingPath = stagingPath
	}
}

/**
 * The commit rename succeeded but the parent-directory fsync did not, so the
 * directory entry is not known to be durable. The content is at the target; the
 * caller cannot assume it survives a crash. Reported as its own error so a
 * successful return never claims durability the filesystem did not grant.
 */
export class PostCommitDurabilityError extends Error {
	readonly targetPath: string

	constructor(targetPath: string, cause: unknown) {
		super(
			"The rename committed but the parent directory could not be fsynced -- the content is at the target path reported on this error, and the directory entry may not be durable.",
			{ cause },
		)
		this.name = "PostCommitDurabilityError"
		this.targetPath = targetPath
	}
}

/**
 * The backup copy could not be created AND the partial copy could not be removed.
 * The write failed either way, but the leftover is a copy of the previous content that
 * is still on disk: its path travels on the error so the caller can remove it, instead
 * of the cleanup silently discarding the only reference to it.
 */
/**
 * The target exists but its access rights could not be inspected or saved, so publishing would
 * replace it with a file that inherits different rights. On Windows the publish fails instead of
 * warning: a successful write that silently widened who can read the file is not a save the user
 * can trust, and the failure happens before the commit, so the target still holds its content.
 */
export class DaclInspectionError extends Error {
	constructor(
		readonly targetPath: string,
		readonly phase: "inspect" | "save",
		readonly causeError: unknown,
	) {
		const detail = phase === "save" ? "its DACL could not be saved" : "its access rights could not be checked"
		super(`safeWriteText: refusing to publish over ${targetPath} because ${detail}`)
		this.name = "DaclInspectionError"
	}
}

/**
 * The content is committed but the saved DACL could not be put back on it, so the file at the
 * target answers to different access rights than the one it replaced. Reported as an error rather
 * than a warning: the caller has to know that the publish changed who can read the file.
 */
export class DaclRestoreError extends Error {
	constructor(
		readonly targetPath: string,
		readonly causeError: unknown,
	) {
		super(`safeWriteText: content committed at ${targetPath}, but its saved access rights could not be restored`)
		this.name = "DaclRestoreError"
	}
}

/** The outcome of a publish: paths this call left on disk that it could not remove. */
export interface SafeWriteTextResult {
	/**
	 * Every leftover this write could not clean up (a backup copy whose unlink kept failing, a DACL
	 * dump, a staging directory). A warning tells a human about them; this is what the caller has to
	 * act on - a retry, a startup sweep, or a message that names the path.
	 */
	leftoverPaths: string[]
}

export class OrphanedBackupError extends Error {
	readonly orphanedBackupPath: string
	readonly originalError: unknown
	readonly cleanupError: unknown
	constructor(backupPath: string, targetPath: string, cause: unknown, cleanupError: unknown) {
		super(_orphanedBackupMessage(targetPath, backupPath, cause, cleanupError), { cause })
		this.name = "OrphanedBackupError"
		this.orphanedBackupPath = backupPath
		this.originalError = cause
		this.cleanupError = cleanupError
	}
}

function _orphanedBackupMessage(
	targetPath: string,
	backupPath: string,
	cause: unknown,
	cleanupError: unknown,
): string {
	const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
	return (
		`safeWriteText: could not create the backup of ${targetPath} (${reason(cause)}), and the ` +
		`partial copy at ${backupPath} could not be removed (${reason(cleanupError)}). The copy is ` +
		`still on disk and must be deleted.`
	)
}
// -- helpers ---------------------------------------------------------------

/** Generate a unique temp file name in the given directory. */
function _tempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Create a private per-write staging sub-directory inside *dir*. The name is
 * unique per write, so concurrent writes never collide on their temp names and
 * never remove a staging directory another write is still using: with one shared
 * name, one write's best-effort rmdir could delete the directory another write
 * had just created but not yet opened, failing its openSync with ENOENT. */
function _stagingDir(dir: string): string {
	const sd = path.join(dir, ".file-safety-staging_" + Date.now() + "_" + Math.random().toString(36).substring(2))
	// mode:0o700 protects a freshly created staging dir; the best-effort chmod
	// repairs a pre-existing one (mkdirSync with recursive:true never chmods an
	// existing directory), so staged temp files are never group/world readable.
	fsSync.mkdirSync(sd, { recursive: true, mode: 0o700 })
	try {
		fsSync.chmodSync(sd, 0o700)
	} catch {
		// best-effort: chmod denied or unavailable; a fresh dir was still
		// created with the requested mode
	}
	return sd
}

function _fsyncFile(fd: number): void {
	fsSync.fsyncSync(fd)
}

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns true when the dump was written successfully; false otherwise.
 * Never throws — callers treat failure as "skip DACL handling". */
async function _saveDaclWindows(srcPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [srcPath, "/save", dumpPath, "/T"], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return true
	} catch {
		return false
	}
}

/** Restore a DACL dump onto *dirPath* on Windows.
 * Returns whether icacls succeeded; the caller reports a failure. */
async function _restoreDaclWindows(dirPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [dirPath, "/restore", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return true
	} catch {
		return false
	}
}

// -- public API ------------------------------------------------------------

/**
 * Resolve the publish target: the symlink referent when the given path is an
 * existing symlink, the path itself otherwise. Only ENOENT (target absent yet)
 * may fall back to the given path; any other resolution error (EACCES, EIO, ...)
 * propagates so a broken or unreadable symlink is never written through its
 * link path. Callers that stage a temp file themselves must stage it beside
 * the resolved path: the commit is a rename onto the referent, and a rename
 * across filesystems fails with EXDEV.
 */
export async function resolvePublishTarget(absoluteFilePath: string): Promise<string> {
	return fs.realpath(absoluteFilePath).catch(async (error: unknown) => {
		if (errorCode(error) !== "ENOENT") throw error
		// ENOENT also covers a dangling symlink, which must never be written through.
		// Only a lstat that also reports the path as absent may fall back to the
		// given path; a real lstat failure (EACCES, EIO) says nothing about whether
		// the path is a link, so falling back would write through a link we were
		// simply not allowed to inspect.
		const linkStat = await fs.lstat(absoluteFilePath).catch((lstatError: unknown) => {
			if (errorCode(lstatError) === "ENOENT") return undefined
			throw lstatError
		})
		if (linkStat?.isSymbolicLink()) throw error
		return absoluteFilePath
	})
}
/**
 * Distinguish "the target does not exist" from a real I/O failure (EACCES,
 * EIO, ...). The mode-preservation path may only fall back to the fresh-file
 * default on ENOENT; any other failure is propagated, otherwise a restrictive
 * target (0o600) would be published with the default 0o644 through the rename.
 */
function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code: unknown }).code)
		: undefined
}

/**
 * Canonicalize the parent directory and re-join the basename. fs.realpath
 * canonicalizes every component, including a symlinked ancestor directory or a
 * Windows 8.3 short name, so a lock key must be canonical even when the file
 * itself is not there yet -- otherwise the key for one file depends on whether
 * the file exists when the key is computed, and two writers take two locks.
 */

async function canonicalDirKey(absoluteFilePath: string): Promise<string> {
	const dirPath = path.dirname(absoluteFilePath)
	const canonicalDir = await fs.realpath(dirPath).catch(() => dirPath)
	return path.join(canonicalDir, path.basename(absoluteFilePath))
}

/**
 * Lock key for a publish target: the symlink referent when the path is an
 * existing symlink, the path itself otherwise. Unlike resolvePublishTarget this
 * tolerates a dangling link, because the lock key has to be computable while a
 * peer writer is mid-commit (a publish renames the staged file onto the referent,
 * and backup mode keeps a copy beside it).
 * The walk is bounded so a two-link cycle terminates, and every key it returns is
 * canonicalized through canonicalDirKey.
 */
export async function resolveLockKey(absoluteFilePath: string): Promise<string> {
	try {
		return await canonicalDirKey(await resolvePublishTarget(absoluteFilePath))
	} catch {
		// A real readlink throws for anything that is not a link, so a normal chain
		// ends the walk. Two links that point at each other never would, so the
		// walk is bounded and callers use the key they actually reached.
		let key = absoluteFilePath
		for (let depth = 0; depth < 8; depth++) {
			const target = await fs.readlink(key).catch(() => undefined)
			if (target === undefined) return await canonicalDirKey(key)
			key = await canonicalDirKey(path.resolve(path.dirname(key), target))
		}
		return await canonicalDirKey(key)
	}
}

/**
 * Remove a backup copy, retrying once: Windows reports EPERM for a file whose handle has not been
 * released yet, so a single failure is not evidence that the path is stuck. ENOENT counts as
 * removed - the goal is that the path is gone, not that this call performed the removal. Returns
 * the error that kept the path on disk, or null when it is gone.
 */
/**
 * Remove this write's own staging directory once its temp file is gone. Best-effort by design: a
 * failure must not un-commit a published file. The directory is empty and per-write at this point,
 * so a later sweep of stale .file-safety-staging_* names can remove it without risking another
 * write's file. Takes the directory as a parameter because control-flow narrowing does not survive
 * the try/finally boundary above the call site.
 */
async function _removeOwnStagingDir(stagingDir: string | null): Promise<void> {
	if (stagingDir === null) {
		return
	}
	await fs.rmdir(stagingDir).catch(() => {})
}

async function _removeBackupCopy(backupPath: string): Promise<unknown> {
	let lastError: unknown = null
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.unlink(backupPath)
			return null
		} catch (error: unknown) {
			if (errorCode(error) === "ENOENT") {
				return null
			}
			lastError = error
		}
	}
	return lastError
}

export async function safeWriteText(
	filePath: string,
	content: string | Uint8Array,
	options?: SafeWriteTextOptions,
): Promise<SafeWriteTextResult> {
	const absoluteFilePath = path.resolve(filePath)
	// Every leftover is recorded here as it is discovered, so a caller gets a structured result
	// instead of having to parse warnings to learn that content is still on disk.
	const leftoverPaths: string[] = []

	// Warning delivery must never abort the write: the notices below describe a
	// committed-but-imperfect publish, and a caller whose callback throws (a UI sink, a logger that
	// is mid-restart) must not turn that into a failed save. Declared above the try whose failure
	// handler reports a leftover backup copy, so both sides can reach it.
	const warn = (message: string) => {
		const report = (label: string, error: unknown) => {
			console.warn(`safeWriteText: onWarning callback ${label}: ${error instanceof Error ? error.message : String(error)}`)
		}
		try {
			const sink = options?.onWarning ?? ((m: string) => console.warn(m))
			const result: unknown = sink(message)
			// A sink may be async - TypeScript accepts a value-returning callback where
			// a void one is expected. Awaiting it would let warning delivery delay a
			// write that has already committed (and hang it if the sink never settles),
			// while leaving the promise unhandled turns a rejection into an unhandled
			// rejection, which under Node's default mode can end the process after a
			// successful write. Attach a handler without awaiting.
			if (result instanceof Promise) {
				result.catch((error: unknown) => report("rejected", error))
			}
		} catch (error: unknown) {
			report("failed", error)
		}
	}


	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolvePublishTarget(absoluteFilePath)
	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour).
	await fs.mkdir(dirPath, { recursive: true })
	await fs.access(dirPath)

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind. Track the directory this
	// write created so its cleanup removes its own directory, not a shared one.
	let stagingDir: string | null = null
	let tempPath: string
	if (options?.tempPath) {
		// A caller-supplied staging file is only safe when it is the file this
		// write is staging, not an arbitrary path. Two properties are checked:
		// it must sit beside the resolved target (a rename across filesystems
		// fails with EXDEV, and a path elsewhere lets a caller publish an
		// unrelated file onto the target), and it must be a regular file rather
		// than a link — renaming a link over the target publishes whatever the
		// link points at, which is the same trust problem as writing through a
		// dangling symlink in resolvePublishTarget.
		const supplied = path.resolve(options.tempPath)
		if (path.dirname(supplied) !== path.resolve(dirPath)) {
			throw new StagingPathError(
				`Staging file must sit in the target's directory (${dirPath}), got ${supplied}`,
				supplied,
			)
		}
		// BigInt stats: on NTFS/ReFS the file identity can exceed Number.MAX_SAFE_INTEGER, and
		// a rounded number makes two different files look identical (rejecting a valid staging
		// file) or hides a real alias.
		const stagingStat = await fs.lstat(supplied, { bigint: true })
		if (stagingStat.isSymbolicLink() || !stagingStat.isFile()) {
			throw new StagingPathError(
				`Staging file must be a regular file, not ${stagingStat.isSymbolicLink() ? "a symlink" : "another file type"}`,
				supplied,
			)
		}
		// A staging path that is the target would be unlinked by the failure handler
		// while it still holds the only copy of the content, so a failed write would
		// delete the file it was meant to protect. Compare identities, not spellings:
		// an alias of the target is the same hazard.
		// Only a missing target may be skipped: an EACCES/ELOOP/ENOTDIR here means the
		// identity comparison could not be made, and treating that as "no target" would let a
		// staging alias reach the commit and let cleanup delete the file it was meant to
		// protect.
		const targetStat = await fs.lstat(targetPath, { bigint: true }).catch((error: unknown) => {
			if (errorCode(error) !== "ENOENT") {
				throw new StagingPathError("Staging file could not be compared with the target", supplied)
			}
			return null
		})
		if (
			targetStat &&
			typeof stagingStat.ino === "bigint" &&
			typeof targetStat.ino === "bigint" &&
			stagingStat.ino === targetStat.ino &&
			stagingStat.dev === targetStat.dev
		) {
			throw new StagingPathError("Staging file must not be the target itself", supplied)
		}
		// The caller's own path is used as given; only the check is canonical.
		tempPath = options.tempPath
	} else {
		stagingDir = _stagingDir(dirPath)
		tempPath = _tempName(stagingDir, "safeWriteText")
	}

	let backupPath: string | null = null
	let releaseBackupOnSuccess = false
	// Non-null only when the win32 step-2 block saved a successful DACL dump:
	// it gates the step-5 restore and is tracked for the cleanup unlinks.
	let daclDumpPath: string | null = null
	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			// Encode before opening the staging file: an encoding Node cannot
			// represent must not leave a half-written temp file behind.
			// A string is encoded as UTF-8; bytes handed in by the caller (the
			// extension host encodes a document with VS Code's own codec, which
			// covers the legacy code pages Node cannot represent) are published
			// unchanged.
			const buffer = Buffer.from(content)
			let targetMode = 0o644 // default for a fresh target
			let targetExists = false
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
				targetExists = true
			} catch (error: unknown) {
				if (errorCode(error) !== "ENOENT") throw error
				// target does not exist yet - keep the default
			}
			// openSync's creation mode is narrowed by the process umask, so an
			// existing 0o664 target would be published as 0o644 through the
			// rename. Apply the existing target's exact mode on the fd, as the
			// caller-staged branch does; a fresh target keeps the default mode.
			const fd = fsSync.openSync(tempPath, "w", targetMode)
			try {
				if (targetExists) {
					fsSync.fchmodSync(fd, targetMode)
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				let offset = 0
				while (offset < buffer.length) {
					offset += fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
				}
				_fsyncFile(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		} else {
			// Preserve the existing target's mode (CWE-732): the caller-staged
			// temp carries its own creation mode, and publishing it as-is would
			// widen a restrictive target (e.g. 0o600 -> 0o644) through rename.
			// The mode is applied with fchmodSync on the open fd (AFTER openSync):
			// chmodSync on the path before the open would make a read-only target
			// (0o400/0o444) fail openSync(tempPath, "r+") with EACCES.
			let targetMode: number | null = null
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
			} catch (error: unknown) {
				if (errorCode(error) !== "ENOENT") throw error
				// target does not exist yet - keep the temp's default mode
			}
			const fd = fsSync.openSync(tempPath, "r+")
			try {
				if (targetMode !== null) {
					fsSync.fchmodSync(fd, targetMode)
				}
				_fsyncFile(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		}

		// -- Step 2 (win32): save DACL BEFORE the backup copy -----------
		const platform = options?.platform ?? process.platform
		// A refusal before the commit has to remove what this call already made: the failure
		// handler below is out of reach from here, and a staged file stranded beside the target is
		// residue the caller should not have to discover on its own.
		const _cleanupBeforeCommit = async (ownDir: string | null): Promise<string[]> => {
			const stuck: string[] = []
			const staged = tempPath
			await fs.unlink(staged).catch(() => {
				stuck.push(staged)
			})
			if (ownDir) {
				await fs.rmdir(ownDir).catch(() => {
					stuck.push(ownDir)
				})
			}
			return stuck
		}

		if (platform === "win32") {
			let accessError: unknown = null
			try {
				await fs.access(targetPath) // target exists?
			} catch (error: unknown) {
				accessError = error
			}
			if (accessError === null) {
				const dumpPath = _tempName(dirPath, "safeWriteText.acl")
				const saved = await _saveDaclWindows(targetPath, dumpPath, options?.execFileRunner)
				if (saved) {
					// Only a successfully saved dump may be restored onto the
					// committed file (step 5).
					daclDumpPath = dumpPath
				} else {
					// A failed icacls may have left a partial dump behind;
					// remove it now (best-effort) so no partial dump survives and
					// no later step can restore from it.
					await fs.unlink(dumpPath).catch(() => {})
					// The target exists and its DACL could not be captured, so the commit rename
					// would replace it with a file that inherits different access rights. Nothing here
					// can verify an equivalent restrictive ACL on the replacement, so the publish is
					// refused instead of warned about: a save that silently changed who can read the
					// file is not a save the user can trust. Nothing is committed yet, so the target
					// still holds its content; the staged file this call already made is removed by
					// the cleanup below, because the failure handler further down is out of reach.
					leftoverPaths.push(...(await _cleanupBeforeCommit(stagingDir)))
					throw new DaclInspectionError(targetPath, "save", null)
				}
			} else if (errorCode(accessError) !== "ENOENT") {
				// Not "absent": the target is there but its access rights could not be read (EACCES,
				// ...), so publishing would replace a file whose rights this call never learned. Same
				// rule as the save failure above: refuse before anything is committed.
				leftoverPaths.push(...(await _cleanupBeforeCommit(stagingDir)))
				throw new DaclInspectionError(targetPath, "inspect", accessError)
			}
		}
		try {
			// -- Step 3 (backup:true): durable copy target -> backup ----
			if (options?.backup) {
				try {
					await fs.access(targetPath)
					backupPath = _tempName(dirPath, "safeWriteText.bak")
					// Copy, never move. Renaming the target away leaves the canonical path absent for
					// the whole commit window: readers see a missing file, and a concurrent
					// writer can create a new target that a later rollback would destroy. A copy
					// keeps the target present, so the step 4 rename is the only change to the
					// canonical path. The copy is flushed so the retained content survives a crash.
					try {
						// Create the destination BEFORE any content exists at it, with the mode fixed
						// at open time. fs.copyFile picks the destination mode itself (the platform
						// creation mask subject to umask on some platforms, the source's mode - or its
						// read-only attribute - on others), so letting it create the file would either
						// leave a restrictive target's bytes briefly readable to others, or leave the
						// copy unwritable so the fsync open below fails with EACCES. open() ignores its
						// mode argument for an existing file, so this 0o600 survives the copy on POSIX;
						// the chmod afterwards is what clears a copied read-only attribute on Windows
						// and keeps a backup of a permissive file private.
						const seedFd = fsSync.openSync(backupPath, "wx", 0o600)
						// Single close, no retry: on POSIX close(2) can release the descriptor before it
						// reports an error (and leaves its state unspecified after EINTR), so a second
						// close could release a descriptor some other operation has meanwhile reused.
						// The failure propagates; backupPath is already recorded, so the outer cleanup
						// removes the seeded file instead of leaving it beside the target.
						fsSync.closeSync(seedFd)
						await fs.copyFile(targetPath, backupPath)
						await fs.chmod(backupPath, 0o600)
						// "r+" not "r": fsync on a read-only handle is EPERM on Windows, and the same
						// flag the staged temp file uses above.
						const backupFd = fsSync.openSync(backupPath, "r+")
						try {
							_fsyncFile(backupFd)
						} finally {
							fsSync.closeSync(backupFd)
						}
					} catch (backupError: unknown) {
						// A partial backup must not outlive this attempt: it is not a complete copy
						// of anything, and once the write fails nothing else removes it. The unlink is
						// retried once (Windows reports EPERM for a file whose handle has not been
						// released yet); if it still fails the path is carried on the thrown error
						// instead of being dropped where no caller can act on it.
						const orphanPath = backupPath
						// Same rule as the other two backup sites: one retry, ENOENT counts as removed.
						const backupCleanupError = await _removeBackupCopy(orphanPath)
						backupPath = null
						if (backupCleanupError !== null) {
							throw new OrphanedBackupError(orphanPath, targetPath, backupError, backupCleanupError)
						}
						throw backupError
					}
					releaseBackupOnSuccess = true
				} catch (err: unknown) {
					if (errorCode(err) !== "ENOENT") throw err
				}
			}

			// -- Step 4: atomic rename temp -> target ---------------------
			await fs.rename(tempPath, targetPath)

			// -- Step 4b (POSIX): fsync the parent directory so the directory entry
			// changed by the commit rename is durable, not just the file content.
			if (platform !== "win32") {
				try {
					const dirFd = fsSync.openSync(dirPath, "r")
					try {
						_fsyncFile(dirFd)
					} finally {
						fsSync.closeSync(dirFd)
					}
				} catch (error: unknown) {
					// The content rename committed, but the directory entry that
					// points at it is not known to be durable. Reporting success
					// here would let a caller believe the write survives a crash,
					// so the failure is surfaced as its own error: the caller can
					// still find the content at the target, it just cannot rely on
					// the directory entry having reached the disk.
					throw new PostCommitDurabilityError(targetPath, error)
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			// daclDumpPath is non-null only when the win32 step-2 block saved a
			// successful dump, so this gate is closed on every other platform
			// and on every failed save.
			if (daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				const restored = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				if (!restored) {
					// The content is committed, but the published file answers to a different
					// DACL from the one that was saved, and nothing here verified an equivalent
					// restrictive ACL on the replacement. This is reported as an error rather than a
					// warning: the caller has to know that the save changed who can read the file.
					// Contract change - this used to warn and resolve, which let a publish that
					// widened access look like an ordinary successful save.
					throw new DaclRestoreError(targetPath, null)
				}
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			if (releaseBackupOnSuccess && backupPath) {
				// The backup is a full copy of the previous content sitting next to the
				// published file. Dropping its path on a failed unlink would leave an artifact
				// that no caller can find or remove, so the unlink is retried once (Windows
				// commonly reports EPERM while another handle is still being released) and a
				// persistent failure is reported with the path instead of swallowed. The publish
				// itself succeeded, so the write still resolves: this is a leftover to clean up,
				// not a failed save.
				const cleanupError = await _removeBackupCopy(backupPath)
				if (cleanupError !== null) {
					// The publish itself succeeded, so this is a leftover to clean up rather than a
					// failed save: the path reaches the human through onWarning and the caller through
					// the structured result, because a full copy of the previous content is still
					// sitting beside the target.
					leftoverPaths.push(backupPath)
					warn(
						`safeWriteText: committed ${targetPath} but could not remove its backup copy at ${backupPath} (${
							errorCode(cleanupError) ?? "unknown error"
						}); the copy of the previous content is still on disk and needs to be removed.`,
					)
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span.
			if (daclDumpPath !== null) {
				const dumpPath = daclDumpPath
				await fs.unlink(dumpPath).catch(() => {
					leftoverPaths.push(dumpPath)
				})
			}
		}

		// tempPath is now the committed file; no cleanup needed.

		// Best-effort: remove the now-empty staging directory. Self-staged
		// writes only, and only this write's own directory: a per-write directory
		// cannot be the one another concurrent write is still using. A failure must
		// never un-commit a published file, so the removal swallows all errors.
		await _removeOwnStagingDir(stagingDir)

		// The result is reported only after this call's own residue has been dealt with: a caller
		// that receives an empty list knows there is nothing left for it to sweep.
		return { leftoverPaths }
	} catch (originalError: unknown) {
		// The backup is a copy, never a restore source: whether the failure happened before
		// or after the commit rename, the copy is removed below so no stale duplicate of the
		// previous content survives next to the target.
		if (backupPath && releaseBackupOnSuccess) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there - before the commit that is the pre-write content, and
			// after it the published content. Either way the copy has served its purpose
			// and must not be left beside the target where no caller can find it.
			// One retry, ENOENT counts as removed - the same rule as the other two backup sites.
			const stuckBackup = await _removeBackupCopy(backupPath)
			if (stuckBackup !== null) {
				// The original error is what the caller needs, so the leftover cannot be thrown; it is
				// reported with its path instead of dropped, through onWarning and the result.
				leftoverPaths.push(backupPath)
				warn(
					`safeWriteText: the write failed and its backup copy could not be removed from ${backupPath} (${
						errorCode(stuckBackup) ?? "unknown error"
					}); a full copy of the previous content is still on disk and needs to be removed.`,
				)
			}
			backupPath = null
		}
		try {
			await fs.unlink(tempPath).catch(() => {})
		} catch {
			// cleanup failure is non-fatal
		}

		// A failed self-staged write must not leave its staging directory behind.
		// Only the directory this write created, and only after its temp file is
		// gone, so the directory is empty and the removal stays best-effort.
		if (stagingDir) {
			await fs.rmdir(stagingDir).catch(() => {})
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		throw originalError
	}
}
