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
		const stagingStat = await fs.lstat(supplied)
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
		const targetStat = await fs.lstat(targetPath).catch(() => null)
		if (
			targetStat &&
			typeof stagingStat.ino === "number" &&
			typeof targetStat.ino === "number" &&
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
	// Set once the commit rename has published the new content. After that point the
	// backup is no longer a safe restore source: rolling it back would overwrite
	// content the caller can already observe at the target path.
	let committed = false
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
		if (platform === "win32") {
			try {
				await fs.access(targetPath) // target exists?
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
				}
			} catch {
				// target does not exist or access failed — no DACL handling
				daclDumpPath = null
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
						await fs.copyFile(targetPath, backupPath)
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
						// of anything, and once the write fails nothing else removes it.
						await fs.unlink(backupPath).catch(() => {})
						backupPath = null
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
					console.warn(`safeWriteText: content committed at ${targetPath}, but the saved DACL could not be restored from ${daclDumpPath}; the file may carry different access rights than the one it replaced.`)
				}
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			if (releaseBackupOnSuccess && backupPath) {
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

		// Best-effort: remove the now-empty staging directory. Self-staged
		// writes only, and only this write's own directory: a per-write directory
		// cannot be the one another concurrent write is still using. A failure must
		// never un-commit a published file, so the removal swallows all errors.
		if (stagingDir) {
			await fs.rmdir(stagingDir).catch(() => {})
		}
	} catch (originalError: unknown) {
		// Only a pre-commit failure can restore the backup. Once the commit rename
		// published, a later failure (for example the post-commit directory fsync)
		// must not overwrite the published content with the old file.
		if (backupPath && releaseBackupOnSuccess && !committed) {
			// Nothing to restore: the backup is a copy, so the target still holds the
			// pre-write content for the whole attempt and the failed commit left it in
			// place. Drop the copy and report the original error - there is no rename that
			// could clobber a publish another writer made during the attempt.
			await fs.unlink(backupPath).catch(() => {})
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
