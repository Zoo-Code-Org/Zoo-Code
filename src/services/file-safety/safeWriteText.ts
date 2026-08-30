import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

/**
 * Options for safeWriteText atomic text publish primitive.
 */
export interface SafeWriteTextOptions {
	/**
	 * When true, preserve the old-file semantics: rename target -> backup first,
	 * after commit rename delete the backup; on failure roll the backup back to
	 * the target path.  When false (default) the atomic rename simply replaces
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
	 * Pre-commit verification hook (A4a guarded write, epic #1375).  Invoked
	 * at the last moment before the commit rename (after any backup rename
	 * has moved the target aside) so a caller can re-check the target's
	 * state and reject publication when it changed since the caller's
	 * earlier verification.  When the hook rejects, no commit rename is
	 * performed: the backup (if any) is rolled back to the target and the
	 * staged temp file is discarded, and the hook's rejection is propagated
	 * to the caller.
	 *
	 * Scope: the hook closes the check-to-rename window for writers that the
	 * caller serializes (guardedWrite's per-path FIFO chain); external
	 * processes may still publish in the residual window between the hook
	 * and the rename (documented in guardedWrite).
	 */
	verifyBeforeCommit?: () => Promise<void>
}

// -- helpers ---------------------------------------------------------------

/** Generate a unique temp file name in the given directory. */
function _tempName(dir: string, prefix: string): string {
	return path.join(dir, "." + prefix + "_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp")
}

/** Create a private staging sub-directory inside *dir* so that multiple
 * concurrent writes never collide on their temp names. */
function _stagingDir(dir: string): string {
	const sd = path.join(dir, ".file-safety-staging")
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
 * 3. win32 only: if target exists save its DACL dump BEFORE backup rename.
 * 4. Optionally rename target -> backup (when backup:true).
 * 5. Optionally run the pre-commit verification hook (verifyBeforeCommit);
 *    a rejection aborts the publish (no commit rename) and propagates.
 * 6. Atomic rename temp -> target.
 * 7. win32 only: restore DACL onto the directory AFTER commit rename.
 * 8. On success: delete backup (if any) and unlink DACL dump.
 * 9. On failure: rollback backup to target path; clean up temp + dump.
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
	return fs.realpath(absoluteFilePath).catch((error: unknown) => {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: string }).code
				: undefined
		if (code !== "ENOENT") throw error
		return absoluteFilePath
	})
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
	const tempPath = options?.tempPath ?? _tempName(_stagingDir(dirPath), "safeWriteText")

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
			const fd = fsSync.openSync(tempPath, "w", targetMode)
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
				daclDumpPath = targetPath + ".acl.tmp"
				const saved = await _saveDaclWindows(targetPath, daclDumpPath, options?.execFileRunner)
				if (!saved) {
					daclDumpPath = null // skip DACL handling entirely
				}
			} catch {
				// target does not exist or access failed — no DACL handling
				daclDumpPath = null
			}
		}

		try {
			// -- Step 3 (backup:true): rename target -> backup --------------
			if (options?.backup) {
				try {
					await fs.access(targetPath)
					backupPath = _tempName(dirPath, "safeWriteText.bak")
					await fs.rename(targetPath, backupPath)
					releaseBackupOnSuccess = true
				} catch (err: unknown) {
					const code =
						typeof err === "object" && err !== null && "code" in err
							? (err as { code?: string }).code
							: undefined
					if (code !== "ENOENT") throw err
				}
			}

			// -- Step 3b (A4a): pre-commit verification --------------------------
			// Run at the last moment before the commit rename so a conditional
			// publication (guardedWrite's createIfAbsent / replaceIfVersion)
			// re-validates the target state against what the rename will replace.
			// A rejection skips the commit rename: the catch below rolls the
			// backup (if any) back to the target and discards the staged temp.
			// NOTE: with backup:true the target was already moved aside by step 3,
			// so the hook observes the post-backup state.
			if (options?.verifyBeforeCommit) {
				await options.verifyBeforeCommit()
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
		if (backupPath && releaseBackupOnSuccess) {
			try {
				await fs.rename(backupPath, targetPath)
			} catch {
				// rollback failed — do not mask original error
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

		throw originalError
	}
}
