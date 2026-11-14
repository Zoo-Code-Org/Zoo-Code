import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

/**
 * Options for safeWriteText atomic text publish primitive.
 */
// Backups whose removal failed. The path is kept, not abandoned: the next write retries it, so a
// transient EBUSY or a scanner holding the file does not leave the backup in the workspace for good.
const PENDING_BACKUP_REMOVALS = new Set<string>()

function _errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

async function _removeBackupWithRetry(backupPath: string, attempts = 3): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await fs.unlink(backupPath)
			PENDING_BACKUP_REMOVALS.delete(backupPath)
			return true
		} catch (error: unknown) {
			// A backup that is already gone is the outcome this cleanup was after: someone deleted
			// the retained file, or a second flush is iterating a snapshot of the set that another
			// flush has already cleared. Treating that as work retries a file that cannot come back
			// and re-adds its path, so every later write pays the retry sleeps on it.
			if (_errorCode(error) === "ENOENT") {
				PENDING_BACKUP_REMOVALS.delete(backupPath)
				return true
			}
			if (attempt < attempts - 1) {
				await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
			}
		}
	}

	PENDING_BACKUP_REMOVALS.add(backupPath)
	return false
}

/** Retry the backup removals an earlier write could not finish. Best-effort; returns how many cleared. */
export async function flushPendingBackupRemovals(): Promise<number> {
	let cleared = 0
	for (const backupPath of [...PENDING_BACKUP_REMOVALS]) {
		if (await _removeBackupWithRetry(backupPath)) {
			cleared += 1
		}
	}
	return cleared
}

export interface SafeWriteTextOptions {
	/**
	 * When true, preserve the old-file semantics: copy the target to a backup and
	 * fsync the copy before the commit, delete the backup after a successful commit,
	 * and on failure try to remove the backup too - the copy is of content the target
	 * still holds, so it is clutter rather than the only copy, and it is not what a
	 * failed write is meant to leave behind. A removal that itself fails hands the path
	 * to the next write instead of abandoning it, so the clutter does not end up with no
	 * owner. The target is never moved, so a failed write
	 * leaves the pre-write content at the target path instead of rolling anything
	 * back.  When false (default) the atomic rename simply replaces
	 * the target -- crash-safe window is zero.
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
	 * Pre-written temp path to use for the commit phase.  When provided,
	 * safeWriteText skips creating its own staging file and uses this path
	 * instead (it still fsyncs before rename).  Useful when a caller has
	 * already written data to a temp file via a custom stream.
	 */
	tempPath?: string

	/**
	 * Verification that runs AFTER the staged copy is written and fsynced and IMMEDIATELY
	 * BEFORE the commit rename. A guard that has to compare on-disk state against an
	 * expectation (a version token, or absence) cannot do that before the staging work:
	 * the window between check and publish would then span the whole staging + fsync
	 * sequence. Running the check here shrinks it to the rename syscall itself. A
	 * rejection skips the commit rename, so the target is left exactly as it was and the
	 * staged temp is cleaned up by the failure path.
	 *
	 * This is not an atomic compare-and-swap. No portable rename primitive compares the
	 * on-disk CONTENT against an expectation, so a writer that neither takes the advisory
	 * lock nor goes through this path can still change the file inside that last window.
	 * The guard narrows the window: a change detected during verification rejects the
	 * write instead of being silently lost, but a change that lands after verification
	 * returns and before the rename can still be overwritten. Full atomicity would need
	 * a content-addressed publish (or a lock every writer in the ecosystem honors),
	 * which this layer cannot enforce from outside.
	 */
	preCommitVerify?: (targetPath: string) => Promise<void>
}

// -- helpers ---------------------------------------------------------------

/** Generate a unique temp file name in the given directory. */
function _tempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Create a private staging sub-directory inside *dir* so that multiple
 * concurrent writes never collide on their temp names. */
function _stagingDir(dir: string): string {
	// One directory per write, named the way the temp inside it is named. A shared
	// fixed name is a path the workspace controls: mkdirSync(recursive) accepts an
	// existing entry of that name without creating anything, and a committed symlink
	// at that name would make the chmod below rewrite the permissions of a directory
	// outside the workspace and put the staged file in it. A name this call generated
	// cannot be pre-planted by the content being written.
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

/**
 * fsync a file descriptor so its data is durable before the atomic rename.
 * Uses the sync form because this repo's @types/node does not declare
 * fs.promises.fsync; the staging file is small, so the blocking window is bounded.
 */
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
 * Best-effort: content is already committed, so failure is non-fatal. */
async function _restoreDaclWindows(dirPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<void> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [dirPath, "/restore", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
	} catch {
		// best-effort; content already committed
	}
}

// -- public API ------------------------------------------------------------

/**
 * Atomic text publish primitive.
 *
 * 1. Write content to a temp file in a private per-write staging subdir
 *    (same volume -> atomic rename guaranteed).
 * 2. fsync the temp file, then close it.
 * 3. win32 only: if target exists save its DACL dump BEFORE the backup copy.
 * 4. Optionally copy target -> backup (when backup:true) and fsync the copy.
 * 5. Atomic rename temp -> target.
 * 6. win32 only: restore DACL onto the directory AFTER commit rename.
 * 7. On success: delete backup (if any) and unlink DACL dump.
 * 8. On failure: drop the backup copy; clean up temp + dump.
 */

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
		if (_errorCode(error) !== "ENOENT") {
			throw error
		}
		// realpath answers ENOENT for two different worlds: a name that does not exist
		// yet, and a symlink whose referent is gone. lstat tells them apart, and only the
		// first may fall back to the link path - writing through the second would let the
		// commit rename replace the link with a regular file where a link used to stand.
		const linkState = await fs.lstat(absoluteFilePath).catch((error: unknown) => {
			// ENOENT is the only lstat answer that means "this name does not exist yet" -
			// the one world that may fall back to the link path. Any other failure leaves us
			// unable to tell an absent name from a dangling link, and the guess that has to be
			// avoided is the permissive one: writing on through the link path would let the
			// commit rename replace a link with a regular file where a link used to stand.
			// An unreadable target stops the write instead.
			if (_errorCode(error) !== "ENOENT") {
				throw error
			}
			return null
		})
		if (linkState?.isSymbolicLink()) {
			throw new Error(`Cannot write through a dangling symlink at ${absoluteFilePath}: its target does not exist`)
		}
		return absoluteFilePath
	})
}

export async function safeWriteText(filePath: string, content: string, options?: SafeWriteTextOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// A write is the natural place to retry backups an earlier one could not remove: the failure
	// that left them behind is usually transient, and this keeps them owned instead of orphaned.
	await flushPendingBackupRemovals()

	// Resolve the symlink referent (see resolvePublishTarget).
	let targetPath: string
	try {
		targetPath = await resolvePublishTarget(absoluteFilePath)
	} catch (error) {
		// A caller that staged its own temp file (safeWriteJson) owns it until the guarded
		// region below takes over. Resolution sits above that region, so a refusal here never
		// reaches the rollback unlink: without this the staged file is left on disk, against
		// the documented cleanup contract (step 8: on failure clean up temp + dump).
		if (options?.tempPath) {
			await fs.unlink(options.tempPath).catch(() => {})
		}
		throw error
	}
	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour). Setup sits above the
	// guarded region just like target resolution, so a failure here has to hand a
	// caller-staged temp file back the same way: the rollback unlink inside the region is
	// unreachable from a mkdir or access refusal.
	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (error) {
		if (options?.tempPath) {
			await fs.unlink(options.tempPath).catch(() => {})
		}
		throw error
	}

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind.
	const stagingDir = options?.tempPath ? null : _stagingDir(dirPath)
	const tempPath = options?.tempPath ?? _tempName(stagingDir ?? dirPath, "safeWriteText")

	let backupPath: string | null = null
	let releaseBackupOnSuccess = false
	let daclDumpPath: string | null = null // tracked for cleanup in finally

	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			let targetMode = 0o644 // default for a fresh target
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
			} catch {
				// target does not exist yet - keep the default
			}
			// No retry on ENOENT here. The staging directory carries a name this call
			// generated, so no other write shares it and none can remove it between the
			// create and this open; whatever removed it is not something re-creating a
			// directory under a fresh name would put back under tempPath. The retry this
			// branch used to carry therefore could only fail a second time.
			const fd = fsSync.openSync(tempPath, "w", targetMode)
			// open()'s mode argument is subject to the process umask, so asking for the
			// target's mode at creation is not the same as publishing it: a 0o664 target under
			// a 0o022 umask would come out 0o644. The chmod on the open descriptor is what
			// fixes the mode we asked for - the same reason the caller-staged branch below
			// fchmods rather than trusting its own open mode.
			fsSync.fchmodSync(fd, targetMode)
			try {
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				const buffer = Buffer.from(content, "utf8")
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
			} catch {
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

		// -- Step 2 (win32): save DACL BEFORE backup rename ---------------
		const platform = options?.platform ?? process.platform
		if (platform === "win32") {
			try {
				await fs.access(targetPath) // target exists?
				// A name this call generates, not a name derived from the target. A fixed
				// "<target>.acl.tmp" can already exist beside the target and belong to
				// something else; the cleanup below would then unlink a file this write
				// never created. Same owned-unique shape as the staging temp.
				const dumpPath = _tempName(dirPath, "safeWriteText.acl")
				const saved = await _saveDaclWindows(targetPath, dumpPath, options?.execFileRunner)
				if (saved) {
					// Only a successfully saved dump may be restored onto the
					// committed file (step 5).
					daclDumpPath = dumpPath
				} else {
					// A failed icacls may have left a partial dump behind. Clearing the
					// reference alone hands that file to nobody - the cleanup below only
					// unlinks a tracked dump - so remove it here (best-effort). Nothing
					// later may restore from a dump whose save failed.
					await fs.unlink(dumpPath).catch(() => {})
					daclDumpPath = null
				}
			} catch {
				// target does not exist or access failed — no DACL handling
				daclDumpPath = null
			}
		}

		try {
			// Ownership of the backup path is decided by the exclusive open below, not by picking a
			// name: an open that throws EEXIST means the name already belongs to another write, and
			// this attempt may then remove nothing. Declared outside that try so its catch can see it.
			let backupSeeded = false
			// -- Step 3 (backup:true): durable copy target -> backup ----
			if (options?.backup) {
				try {
					await fs.access(targetPath)
					backupPath = _tempName(dirPath, "safeWriteText.bak")
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
						// Ownership of the backup path begins here, at the moment this call
						// creates the file - not at the moment it picks a name. An exclusive open
						// that throws EEXIST means the name belongs to another write, and nothing
						// below may treat that file as this attempt's to throw away.
						backupSeeded = true
						fsSync.closeSync(seedFd)
						await fs.copyFile(targetPath, backupPath)
						await fs.chmod(backupPath, 0o600)
						// "r+" not "r": fsync on a read-only handle is EPERM on Windows, and this is
						// the same flag the staged temp file is opened with above.
						const backupFd = fsSync.openSync(backupPath, "r+")
						try {
							_fsyncFile(backupFd)
						} finally {
							fsSync.closeSync(backupFd)
						}
					} catch (backupError: unknown) {
						// A half-written backup is worse than none: it looks like a restore source.
						// The half-made backup has to go, but a failed unlink here must not orphan it:
						// this is the only cleanup this path performs and nulling backupPath below would
						// also hide the path from the rollback cleanup, so it goes through the same
						// three-strike removal every other backup removal uses - which keeps the path in
						// Only a backup this call actually opened is ours to remove. If the exclusive
						// seed open threw EEXIST the name was already another write's, and removing it
						// here would throw away somebody else's restore source - which is the only
						// cleanup this path performs, so nothing later would. A half-made copy still
						// goes through the same three-strike removal every other backup removal uses,
						// which keeps the path in PENDING_BACKUP_REMOVALS for a later write to clear
						// when an unlink of our own copy fails.

						if (backupSeeded) {
							await _removeBackupWithRetry(backupPath)
						}
						backupPath = null
						throw backupError
					}
					releaseBackupOnSuccess = true
				} catch (err: unknown) {
					if (_errorCode(err) !== "ENOENT") throw err
				}
			}

			// -- Step 3a: pre-commit verification -------------------------
			// Runs before the commit rename so a rejection leaves the target untouched -
			// nothing is moved yet. The backup copy has already been made by step 3 when
			// backup is on, and the failure path below removes it.
			if (options?.preCommitVerify) {
				await options.preCommitVerify(targetPath)
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
				} catch {
					// best-effort: the content rename already committed
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			if (platform === "win32" && daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			if (releaseBackupOnSuccess && backupPath) {
				// A cleanup failure must not abandon the path: retry, and if it still fails keep it for the
				// next write to clear instead of leaving an orphan nobody owns.
				await _removeBackupWithRetry(backupPath)
			}

			// The staging sub-directory only exists to hold this write's temp file. Once the
			// commit lands it is empty clutter in the user's workspace, so remove it when nothing
			// else is in it; a concurrent write still holding a temp file makes rmdir fail and is
			// left alone.
			if (stagingDir !== null) {
				try {
					await fs.rmdir(stagingDir)
				} catch {
					// best-effort: a concurrent write may still hold a temp file here
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span.
			if (daclDumpPath !== null) {
				await fs.unlink(daclDumpPath).catch(() => {})
			}
		}

		// tempPath is now the committed file; no cleanup needed.
	} catch (originalError: unknown) {
		// -- Rollback / cleanup on failure ----------------------------------
		if (backupPath && releaseBackupOnSuccess) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there - before the commit that is the pre-write content, and
			// after it the published content. Either way the copy has served its purpose and
			// the intent is to remove it: the target still holds what the copy holds, so a
			// leftover is clutter rather than the only copy of anything. What must not happen
			// is clutter with no owner - one best-effort unlink that fails leaves a backup
			// beside the target that nothing in this module can ever find again - so the
			// removal is retried and, if it still fails, the path goes to the pending set for
			// a later write to finish. The old design renamed the target away and back, which
			// could itself fail and leave persisted state missing at its expected path.
			await _removeBackupWithRetry(backupPath)
			backupPath = null
		}

		// Always clean up the staging temp file on failure.
		try {
			await fs.unlink(tempPath).catch(() => {})
		} catch {
			// cleanup failure is non-fatal
		}

		// The staging directory was created for this write's temp file, so a failed write
		// must not leave an empty .file-safety-staging in the user's workspace. rmdir only
		// removes an empty directory, so a concurrent write still holding a temp file here
		// keeps it in place.
		if (stagingDir !== null) {
			try {
				await fs.rmdir(stagingDir)
			} catch {
				// best-effort: non-empty (concurrent write) or already removed
			}
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		throw originalError
	}
}
