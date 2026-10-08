import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

/**
 * Options for safeWriteText atomic text publish primitive.
 */
export interface SafeWriteTextOptions {
	/**
	 * When true, copy the target to a backup file before the commit rename. The
	 * commit is a single atomic rename, so the target is never removed first and
	 * nothing restores from the copy: it is deleted after a confirmed commit, and
	 * kept on disk when the commit could not be confirmed durable so the previous
	 * content stays recoverable. Costs a full read+write of the old file, so
	 * callers that do not need that recovery copy should leave this off.
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
}

// -- helpers ---------------------------------------------------------------

/** Generate a unique temp file name in the given directory. */
function _tempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Sharing errors that clear on their own when the target is held open. */
const _TRANSIENT_RENAME_CODES = ["EPERM", "EACCES", "EBUSY"]
// Bounded so a permanently locked target still fails fast: 5 retries back off to
// 320ms, for a worst case of ~620ms added to a save.
const _RENAME_RETRY_ATTEMPTS = 5
const _RENAME_RETRY_BASE_MS = 20

/** Error raised when the staging path cannot be trusted. */
class UnsafeStagingDirectoryError extends Error {
	constructor(stagingPath: string, reason: string) {
		super(`Refusing to stage in ${stagingPath}: ${reason}`)
		this.name = "UnsafeStagingDirectoryError"
	}
}

/**
 * Raised when the commit rename landed but the parent-directory fsync failed.
 * The new content is in place; what is unconfirmed is that the directory entry
 * survives a crash, so callers must not treat the publish as durable.
 */
export class PublishNotDurableError extends Error {
	constructor(targetPath: string, reason: string) {
		super(`Published ${targetPath} but could not confirm it is durable: ${reason}`)
		this.name = "PublishNotDurableError"
	}
}

function _errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/** Create a private staging sub-directory inside *dir* so that multiple
 * concurrent writes never collide on their temp names. */
function _stagingDir(dir: string): string {
	const sd = path.join(dir, ".file-safety-staging")
	// mkdirSync(recursive) follows an existing path, so a .file-safety-staging
	// symlink planted by another process would stage - and then publish - outside
	// the target directory. Anything that is not a real directory owned by this
	// process is rejected instead of used.
	try {
		const existing = fsSync.lstatSync(sd)
		if (!existing.isDirectory()) {
			throw new UnsafeStagingDirectoryError(sd, "it exists and is not a directory")
		}
	} catch (error: unknown) {
		if (error instanceof UnsafeStagingDirectoryError) throw error
		if (_errorCode(error) !== "ENOENT") throw error
	}
	// mode:0o700 protects a freshly created staging dir; the best-effort chmod
	// repairs a pre-existing one (mkdirSync with recursive:true never chmods an
	// existing directory), so staged temp files are never group/world readable.
	fsSync.mkdirSync(sd, { recursive: true, mode: 0o700 })
	// Re-check after the create: the path can be swapped for a symlink between the
	// check above and mkdirSync.
	const created = fsSync.lstatSync(sd)
	if (!created.isDirectory()) {
		throw new UnsafeStagingDirectoryError(sd, "it was replaced by a non-directory")
	}
	if (typeof process.getuid === "function" && created.uid !== process.getuid()) {
		throw new UnsafeStagingDirectoryError(sd, "it is not owned by this process")
	}
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
 * Returns true when icacls reported success; false otherwise, so the caller can
 * decide whether a lost DACL is tolerable. */
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
 * Atomic text publish primitive.
 *
 * 1. Write content to a temp file in a private per-write staging subdir
 *    (same volume -> atomic rename guaranteed).
 * 2. fsync the temp file, then close it.
 * 3. win32 only: if target exists save its DACL dump BEFORE backup rename.
 * 4. Optionally rename target -> backup (when backup:true).
 * 5. Atomic rename temp -> target.
 * 6. win32 only: restore DACL onto the directory AFTER commit rename.
 * 7. On success: delete backup (if any) and unlink DACL dump.
 * 8. On failure: rollback backup to target path; clean up temp + dump.
 */

/**
 * Resolve the publish target: the symlink referent when the given path is an
 * existing symlink, the path itself otherwise. A dangling symlink is followed to
 * its referent too (renaming onto the link path would replace the link), and only
 * a path that neither exists nor is a link falls back to the given path. Any other
 * resolution error (EACCES, EIO, ELOOP, ...) propagates so a broken or unreadable
 * symlink is never written through its link path. Callers that stage a temp file
 * themselves must stage it beside the resolved path: the commit is a rename onto
 * the referent, and a rename across filesystems fails with EXDEV.
 */
export async function resolvePublishTarget(
	absoluteFilePath: string,
	visitedLinks: Set<string> = new Set(),
): Promise<string> {
	try {
		return await fs.realpath(absoluteFilePath)
	} catch (error: unknown) {
		if (_errorCode(error) !== "ENOENT") throw error
		// realpath reports ENOENT for a dangling symlink as well as for a missing path.
		// Renaming onto the link path would replace the link with a regular file, so follow
		// the link text to its referent instead; a link cycle surfaces as ELOOP and still
		// propagates, so the recursion is bounded.
		const link = await fs.lstat(absoluteFilePath).catch(() => null)
		if (link?.isSymbolicLink()) {
			const linkText = await fs.readlink(absoluteFilePath)
			if (visitedLinks.has(absoluteFilePath)) {
				const loopError = new Error(`Symlink loop while resolving publish target ${absoluteFilePath}`)
				;(loopError as NodeJS.ErrnoException).code = "ELOOP"
				throw loopError
			}
			visitedLinks.add(absoluteFilePath)
			return resolvePublishTarget(path.resolve(path.dirname(absoluteFilePath), linkText), visitedLinks)
		}
		return absoluteFilePath
	}
}

export async function safeWriteText(filePath: string, content: string, options?: SafeWriteTextOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolvePublishTarget(absoluteFilePath)
	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour).
	await fs.mkdir(dirPath, { recursive: true })
	await fs.access(dirPath)

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind.
	const stagingDir = options?.tempPath ? null : _stagingDir(dirPath)
	const tempPath = options?.tempPath ?? _tempName(stagingDir ?? dirPath, "safeWriteText")

	// The staging sub-directory only exists to hold this write's temp file, so it is
	// removed once the write is over. rmdir fails with ENOTEMPTY while another write
	// still stages here, which is exactly the concurrency guard wanted.
	async function _releaseStagingDir(): Promise<void> {
		if (stagingDir === null) return
		try {
			await fs.rmdir(stagingDir)
		} catch {
			// non-empty (a concurrent write is still staging) or already gone
		}
	}

	let backupPath: string | null = null
	let backupCreated = false
	// Set when the commit landed but its durability could not be confirmed. The
	// content is in place, so there is nothing to roll back, but the caller must
	// not be told the publish is durable.
	let durabilityError: unknown = null
	let daclDumpPath: string | null = null // tracked for cleanup in finally
	let daclSaved = false // restore step runs only when the save succeeded

	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			let targetMode = 0o644 // default for a fresh target
			try {
				targetMode = fsSync.statSync(targetPath).mode & 0o777
			} catch (error: unknown) {
				// Only a genuinely absent target may take the default mode. Any other
				// stat failure leaves the real mode unknown, and publishing with the
				// default could widen a restrictive file, so the write does not proceed.
				if (_errorCode(error) !== "ENOENT") throw error
			}
			let fd: number
			try {
				fd = fsSync.openSync(tempPath, "w", targetMode)
			} catch (error: unknown) {
				// Every write to one directory shares the staging dir, and a write that finishes
				// removes it when empty. A concurrent writer can therefore remove it between
				// _stagingDir() and this open. Re-create it and try once; any other errno, or
				// a second ENOENT, is a real failure.
				if (_errorCode(error) !== "ENOENT" || stagingDir === null) throw error
				_stagingDir(dirPath)
				fd = fsSync.openSync(tempPath, "w", targetMode)
			}
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
			} catch (error: unknown) {
				// As above: an unknown target mode must not be replaced by the temp's
				// own creation mode, which can be wider than the target's.
				if (_errorCode(error) !== "ENOENT") throw error
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
				// Unique per call: two concurrent writes to the same target must not share one dump,
				// where one call can unlink or overwrite the file the other is still using. Kept in the
				// target directory, not the staging dir, so a write that never stages a temp file still
				// leaves no extra directory behind.
				daclDumpPath = _tempName(dirPath, "safeWriteText.acl.tmp")
				const saved = await _saveDaclWindows(targetPath, daclDumpPath, options?.execFileRunner)
				if (!saved) {
					// Skip the restore step, but keep daclDumpPath tracked: a failed save can
					// still have created the dump file, and the finally block must remove it.
					//
					// This is deliberately NOT fatal. icacls /restore needs backup/restore
					// privileges: measured on a normal (non-elevated) Windows host it fails with
					// "Not all privileges or groups referenced are assigned to the caller"
					// (exit 1300), and /save itself can exit non-zero while still writing a
					// usable dump. Refusing the write would therefore break every save on such a
					// host without removing the exposure. The privilege-free fix - copying the
					// target's DACL onto the staged file BEFORE the commit, so the rename never
					// changes the security descriptor - is tracked separately; see the note on
					// tracking issue easonLiangWorldedtech/Zoo-Code#41.
					daclSaved = false
				} else {
					daclSaved = true
				}
			} catch {
				// target does not exist or access failed — no DACL handling
				daclDumpPath = null
			}
		}

		try {
			// -- Step 3 (backup:true): copy the target to a backup ----------------
			// The target must stay at its canonical path until the single atomic rename
			// below publishes the staged file. Renaming the target away first would leave
			// the path missing if that publish rename failed, so the backup is a copy and
			// there is nothing to roll back.
			if (options?.backup) {
				try {
					await fs.access(targetPath)
					backupPath = _tempName(dirPath, "safeWriteText.bak")
					await fs.copyFile(targetPath, backupPath)
					backupCreated = true
				} catch (err: unknown) {
					const code =
						typeof err === "object" && err !== null && "code" in err
							? (err as { code?: string }).code
							: undefined
					if (code !== "ENOENT") throw err
				}
			}
			// -- Step 4: atomic rename temp -> target ---------------------
			// On Windows the rename can be rejected while another process holds the
			// target without FILE_SHARE_DELETE. The previous fs.writeFile path tolerated
			// that, so retry a bounded number of times before failing.
			for (let attempt = 0; ; attempt++) {
				try {
					await fs.rename(tempPath, targetPath)
					break
				} catch (error: unknown) {
					const transient =
						platform === "win32" &&
						attempt < _RENAME_RETRY_ATTEMPTS &&
						_TRANSIENT_RENAME_CODES.includes(_errorCode(error) ?? "")
					if (!transient) throw error
					await new Promise((resolve) => setTimeout(resolve, _RENAME_RETRY_BASE_MS * 2 ** attempt))
				}
			}

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
					// The rename committed, so the content is in place and there is nothing to
					// roll back, but the directory entry is not confirmed durable. Record it so
					// the call fails and the backup is kept for recovery.
					durabilityError = error
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			if (platform === "win32" && daclSaved && daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				let restored = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				if (!restored) {
					// One retry: icacls can fail transiently while another process still holds
					// the just-renamed file open.
					restored = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				}
				if (!restored) {
					// Not fatal, for the same reason the save miss is not: on a non-elevated
					// host /restore cannot succeed at all. The content is committed and the
					// backup (when taken) is kept so the previous content and its permissions
					// stay recoverable.
				}
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			// Kept when durability is unconfirmed, so the previous content is still
			// recoverable if the un-durable rename is lost on power loss.
			if (backupCreated && backupPath && durabilityError === null) {
				try {
					await fs.unlink(backupPath)
				} catch {
					// non-fatal — orphaned backup is acceptable
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
		if (backupCreated && backupPath) {
			// The target was never moved, so rollback is just removing the backup copy.
			try {
				await fs.unlink(backupPath)
			} catch {
				// cleanup failure is non-fatal
			}
		}

		// Always clean up the staging temp file on failure.
		try {
			await fs.unlink(tempPath).catch(() => {})
		} catch {
			// cleanup failure is non-fatal
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		await _releaseStagingDir()

		throw originalError
	}

	await _releaseStagingDir()

	// Raised outside the rollback handler on purpose: the content is committed, so
	// this is not a failure to roll back, and the backup must survive for recovery.
	if (durabilityError !== null) {
		const reason =
			durabilityError instanceof Error ? durabilityError.message : String(durabilityError)
		throw new PublishNotDurableError(targetPath, reason)
	}
}
