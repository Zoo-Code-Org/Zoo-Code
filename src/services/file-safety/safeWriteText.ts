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

function _orphanedBackupMessage(targetPath: string, backupPath: string, cause: unknown, cleanupError: unknown): string {
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

/** Remove this write's own staging directory, retrying once and reporting the exact path
 * when it still fails. Shared by the success and the failure path so neither one silently
 * discards a cleanup failure: an ENOTEMPTY from a racing writer, an EPERM while a handle
 * inside the directory is still being released, or a transient filesystem error leaves a
 * concrete directory on disk that no caller can find again. A cleanup failure must never
 * un-commit a published file and must never replace the original write error, so it travels
 * through the warning sink carrying the path a later cleanup pass needs. */
async function _releaseStagingDir(stagingDir: string, warn: (message: string) => void): Promise<void> {
	let cleanupError: unknown = null
	// Retry once: Windows reports EPERM while a handle inside the directory is still being
	// released, and the second attempt usually succeeds.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.rmdir(stagingDir)
			return
		} catch (error: unknown) {
			// A directory someone else already removed is exactly the goal, not a
			// leftover to report.
			if (errorCode(error) === "ENOENT") {
				return
			}
			cleanupError = error
		}
	}
	warn(
		`safeWriteText: could not remove the staging directory ${stagingDir} (${
			cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
		}); it is left in place for a later cleanup pass`,
	)
}

/**
 * Remove this write's DACL dump. Retried once for the same reason the backup copy is:
 * on Windows an unlink commonly reports EPERM while another handle to the file is still
 * being released, although the file is gone a moment later. A dump that survives both
 * attempts is a concrete file beside the target whose name no caller can recover, so the
 * exact path is reported through the warning sink instead of being swallowed - on the
 * success path as well as on the failure path, where it must also never replace the
 * original write error. ENOENT means the goal is already met, so it is not a failure.
 */
async function _discardDaclDump(daclDumpPath: string, warn: (message: string) => void): Promise<void> {
	let cleanupError: unknown = null
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.unlink(daclDumpPath)
			return
		} catch (error: unknown) {
			if (errorCode(error) === "ENOENT") {
				return
			}
			cleanupError = error
		}
	}
	warn(
		`safeWriteText: could not remove the DACL dump ${daclDumpPath} (${
			errorCode(cleanupError) ?? (cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
		}); it is a text copy of the target's access rights and can be deleted.`,
	)
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
async function _restoreDaclWindows(
	dirPath: string,
	dumpPath: string,
	execFileRunner?: typeof execFile,
): Promise<boolean> {
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

export async function safeWriteText(
	filePath: string,
	content: string | Uint8Array,
	options?: SafeWriteTextOptions,
): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

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
	// The commit point of this write. Set the moment the rename succeeds: from that instant
	// tempPath IS the target (the rename moved the staged file onto it), so the failure cleanup
	// below must not unlink tempPath any more - a post-commit failure (the parent-directory fsync,
	// the DACL restore, a throwing warning sink) would otherwise delete the file that was just
	// published. The success path already knows this; the catch is the side that needs the flag.
	let committed = false
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
	// Warning delivery must never abort the write: the notices below describe a
	// committed-but-imperfect publish, and a caller whose callback throws (a UI sink,
	// a logger that is mid-restart) must not turn that into a failed save.
	const warn = (message: string) => {
		const report = (label: string, error: unknown) => {
			console.warn(
				`safeWriteText: onWarning callback ${label}: ${error instanceof Error ? error.message : String(error)}`,
			)
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
					// A failed icacls may have left a partial dump behind; remove it now so
					// no partial dump survives and no later step can restore from it. The
					// cleanup is the same retrying, reporting one used for a successful dump:
					// a partial file is still a concrete file beside the target, and a
					// transient EPERM (antivirus, a handle still being released) that survives
					// the retry has to leave the exact path behind, not vanish into a catch.
					await _discardDaclDump(dumpPath, warn)
					// The target exists and its DACL could not be captured, so the commit rename
					// replaces it with a file that inherits different access rights. The write still
					// proceeds - a missing or failing icacls must not leave the user unable to save -
					// but the replacement is no longer ACL-identical and that has to be visible
					// instead of silent.
					warn(
						`Could not save the DACL of ${targetPath}; the replacement may inherit different access rights.`,
					)
				}
			} else if (errorCode(accessError) !== "ENOENT") {
				// Not "absent": the target is there but could not be checked (EACCES, ...), so
				// DACL preservation was skipped for a reason the caller cannot infer from the
				// successful write alone.
				warn(
					`Could not check ${targetPath} for DACL preservation (${errorCode(accessError) ?? "unknown error"}); the replacement may inherit different access rights.`,
				)
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
						try {
							// Nothing runs here today: the descriptor exists only to create the destination with
							// a fixed mode. The block is what guarantees the close below runs for every
							// successful openSync, including any statement added between the open and the close -
							// an unclosed descriptor holds the backup open and blocks the cleanup that has to
							// remove that file.
						} finally {
							fsSync.closeSync(seedFd)
						}
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
						let backupCleanupError: unknown = null
						for (let attempt = 0; attempt < 2; attempt++) {
							try {
								await fs.unlink(orphanPath)
								backupCleanupError = null
								break
							} catch (cleanupError: unknown) {
								backupCleanupError = errorCode(cleanupError) === "ENOENT" ? null : cleanupError
							}
						}
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
			committed = true

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
					// The content is committed, but the published file may carry a different DACL
					// from the one that was saved. Failing the write here would break every
					// publish on machines where icacls cannot reapply the saved ACEs (a plain
					// temp directory restore fails with "Not all privileges or groups referenced
					// are assigned to the caller"), so the change of access rights is reported
					// rather than thrown.
					warn(
						`safeWriteText: content committed at ${targetPath}, but the saved DACL could not be restored from ${daclDumpPath}; the file may carry different access rights than the one it replaced.`,
					)
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
				let backupRemoved = false
				for (let attempt = 0; attempt < 2 && !backupRemoved; attempt++) {
					try {
						await fs.unlink(backupPath)
						backupRemoved = true
					} catch (cleanupError: unknown) {
						if (errorCode(cleanupError) === "ENOENT") {
							// Already gone: the cleanup goal is met, nothing to report.
							backupRemoved = true
						} else if (attempt === 1) {
							warn(
								`safeWriteText: committed ${targetPath} but could not remove its backup copy at ${backupPath} (${
									errorCode(cleanupError) ?? "unknown error"
								}); the copy of the previous content is still on disk and needs to be removed.`,
							)
						}
					}
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span. A dump that survives is an
			// artifact nobody else can name, so a failure is retried and reported with its path.
			if (daclDumpPath !== null) {
				await _discardDaclDump(daclDumpPath, warn)
				// This span owns the removal: the catch below must not retry the same file and report
				// the same leftover twice.
				daclDumpPath = null
			}
		}

		// tempPath is now the committed file; no cleanup needed.

		// Best-effort: remove the now-empty staging directory. Self-staged
		// writes only, and only this write's own directory: a per-write directory
		// cannot be the one another concurrent write is still using. A failure must
		// never un-commit a published file, so it is reported through the warning sink with
		// the leftover path instead of being swallowed.
		if (stagingDir) {
			await _releaseStagingDir(stagingDir, warn)
		}
	} catch (originalError: unknown) {
		// The backup is a COPY taken before the commit, never a rename of the target,
		// so there is nothing to restore here: the target still holds whatever the
		// commit left - the pre-write content when the commit never ran, the published
		// content when it did. The copy has served its purpose and must not be left
		// beside the target where no caller can find it.
		if (backupPath && releaseBackupOnSuccess) {
			// Retry once (Windows reports EPERM while a handle is still being released), and
			// if it still fails keep the path: clearing it would drop the only reference to
			// the orphan. The original write error is what propagates; the leftover is
			// reported through the warning sink with both paths.
			let cleanupError: unknown = null
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await fs.unlink(backupPath)
					cleanupError = null
					break
				} catch (error: unknown) {
					// A copy that is already gone is not a leftover: reporting it would claim a
					// recoverable orphan that no longer exists, and leaving backupPath set would
					// tell the reader the copy is still there.
					if (errorCode(error) === "ENOENT") {
						cleanupError = null
						break
					}
					cleanupError = error
				}
			}
			if (cleanupError) {
				warn(
					`safeWriteText: the write to ${targetPath} failed and its backup copy could not be removed at ${backupPath} (${
						cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					}); the copy is left in place so the previous content is still recoverable by hand`,
				)
			} else {
				backupPath = null
			}
		}
		// Only a write that never committed has a staged file to remove. After the commit
		// rename there is nothing at tempPath but the published target, and unlinking it here
		// would un-commit the write the caller is being told about.
		if (!committed) {
			let cleanupError: unknown = null
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await fs.unlink(tempPath)
					cleanupError = null
					break
				} catch (error: unknown) {
					// ENOENT means the goal is already met - the temp is gone - which is not a
					// leftover and must not raise the warning below.
					if (errorCode(error) === "ENOENT") {
						cleanupError = null
						break
					}
					cleanupError = error
				}
			}
			if (cleanupError) {
				// A leftover staged temp is not the caller's failure, but its path must not
				// be dropped silently: report it and keep the original error propagating.
				warn(
					`safeWriteText: could not remove the staging temp ${tempPath} (${
						cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
					})`,
				)
			}
		}

		// A failed self-staged write must not leave its staging directory behind.
		// Only the directory this write created, and only after its temp file is
		// gone, so the directory is empty and the removal stays best-effort: the original
		// write error keeps propagating, and a directory that still cannot be removed is
		// reported with its path rather than discarded.
		if (stagingDir) {
			await _releaseStagingDir(stagingDir, warn)
		}

		// Reported through the warning sink with its path, and never in place of originalError.
		if (daclDumpPath !== null) {
			await _discardDaclDump(daclDumpPath, warn)
		}

		throw originalError
	}
}
