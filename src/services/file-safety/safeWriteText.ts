import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { userInfo } from "os"

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
	/**
	 * The old-content copy retained for recovery on this path, or null when backup
	 * mode was off or the target did not exist before the write. The name is a hidden
	 * random path, so without this field no caller could find the copy the catch block
	 * deliberately keeps.
	 */
	readonly backupPath: string | null

	constructor(targetPath: string, cause: unknown, backupPath: string | null = null) {
		super(
			"The rename committed but the parent directory could not be fsynced -- the content is at the target path reported on this error, and the directory entry may not be durable.",
			{ cause },
		)
		this.name = "PostCommitDurabilityError"
		this.targetPath = targetPath
		this.backupPath = backupPath
	}
}
// -- helpers ---------------------------------------------------------------

/**
 * How far resolveLockKey follows a chain of links. 40 is where Node's own resolver
 * gives up with ELOOP, so every chain the operating system is willing to resolve is a
 * chain this walk resolves too. A smaller bound stops at an intermediate link of a
 * long dangling chain, and the writer that stopped there queues on a different lock
 * from the writer standing at the referent - the two-locks-for-one-file case
 * canonicalDirKey exists to prevent.
 */
const MAX_SYMLINK_HOPS = 40

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
	// That is the POSIX story only: Windows directory creation ignores this mode argument
	// and chmodSync establishes no DACL, so on win32 what makes the staging directory
	// private is the caller's _grantPrivateDaclWindows step, which runs before the first
	// staged byte and reports rather than fails when icacls is unavailable.
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

/** Apply a restrictive Windows DACL to a freshly created staging directory.
 * `icacls <dir> /inheritance:r /grant:r "<account>:(OI)(CI)F"` drops every inherited
 * ACE and leaves one explicit ACE for the account running the write, so files created
 * inside inherit only that account. Measured on a Windows host: the directory went
 * from three inherited ACEs (SYSTEM, Administrators and the user) to the single
 * explicit one, and a file written into it inherited only the user.
 * Returns false instead of throwing: a machine without icacls, or with no account name
 * readable either from the environment or from the host itself, still saves the file, and
 * the caller reports the leftover exposure through onWarning. */
/**
 * The account name the staging grant names. The environment comes first because that is
 * the source a caller can control and the source the tests pin. It is empty on a process
 * that inherits neither USERNAME nor USER, which is how the hosted windows jobs run, so
 * the account the host itself reports is asked next: userInfo is synchronous, and it throws
 * when no account entry can be read, which is the same no-account state the caller already
 * reports through onWarning. A name icacls will not resolve makes the grant fail, and a
 * failed grant already takes this same warning path rather than rejecting the write. */
function _resolveStagingAccountName(): string | null {
	const fromEnvironment = process.env.USERNAME ?? process.env.USER
	if (typeof fromEnvironment === "string" && fromEnvironment.length > 0) {
		return fromEnvironment
	}
	try {
		const reported = userInfo().username
		return typeof reported === "string" && reported.length > 0 ? reported : null
	} catch {
		return null
	}
}

async function _grantPrivateDaclWindows(stagingDirPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const account = _resolveStagingAccountName()
	if (!account) {
		return false
	}
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner(
				"icacls",
				[stagingDirPath, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`],
				{ windowsHide: true },
				(err) => (err ? reject(err) : resolve()),
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
/**
 * The errno-style code of a filesystem error, or undefined for anything that is not one. Exported
 * because safeWriteJson asks the same question of the same errors; a second copy of this test drifts.
 */
export function errorCode(error: unknown): string | undefined {
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
	// Walk up to the nearest ancestor that EXISTS, canonicalize that, and re-join the
	// components that are not there yet. Falling back to the unresolved spelling of the
	// whole parent - what a single realpath(...).catch(() => dirPath) used to do - makes
	// the key depend on whether the directory happens to exist: a writer whose parent is
	// already there canonicalizes through a symlinked ancestor (or a short name) while a
	// writer racing to create the same directory gets the literal spelling, so the two
	// take different locks for one file and a read-modify-write loses one side.
	// A realpath failure that is not "not there yet" says nothing about the canonical
	// form, so it is propagated rather than papered over with a key that may be wrong.
	let cursor = dirPath
	const missing: string[] = []
	for (;;) {
		const canonical = await fs.realpath(cursor).catch((error: unknown) => {
			if (errorCode(error) === "ENOENT") return undefined
			throw error
		})
		if (canonical !== undefined) {
			return path.join(canonical, ...missing.reverse(), path.basename(absoluteFilePath))
		}
		missing.push(path.basename(cursor))
		const parent = path.dirname(cursor)
		if (parent === cursor) {
			// Every component up to the root is missing: there is nothing to canonicalize
			// against, and the literal path is the only key left.
			return path.join(dirPath, path.basename(absoluteFilePath))
		}
		cursor = parent
	}
}

/**
 * Lock key for a publish target: the symlink referent when the path is an
 * existing symlink, the path itself otherwise. Unlike resolvePublishTarget this
 * tolerates a dangling link, because the lock key has to be computable while a
 * peer writer is mid-commit (a publish renames the staged file onto the referent,
 * and backup mode keeps a copy beside it).
 * The walk is bounded so a link cycle terminates, and every key it returns is
 * canonicalized through canonicalDirKey. The bound is MAX_SYMLINK_HOPS: a dangling
 * chain longer than the bound ends the walk at an intermediate link, and a writer
 * named through that chain then queues on a different lock from a writer named at
 * the referent. 40 links is the longest chain Node resolves at all, so no chain the
 * operating system itself can follow is cut off here.
 */
export async function resolveLockKey(absoluteFilePath: string): Promise<string> {
	try {
		return await canonicalDirKey(await resolvePublishTarget(absoluteFilePath))
	} catch {
		// A real readlink throws for anything that is not a link, so a normal chain
		// ends the walk. Two links that point at each other never would, so the
		// walk is bounded and callers use the key they actually reached.
		let key = absoluteFilePath
		for (let depth = 0; depth < MAX_SYMLINK_HOPS; depth++) {
			const target = await fs.readlink(key).catch(() => undefined)
			if (target === undefined) return await canonicalDirKey(key)
			key = await canonicalDirKey(path.resolve(path.dirname(key), target))
		}
		return await canonicalDirKey(key)
	}
}

/**
 * @internal Intentional direct-test seam: no production file calls this write path
 * yet, and this unit's own specs exercise it directly, which is the case
 * `docs/development-quality-checks.md` line 36 tells authors to declare here rather
 * than in configuration. Knip still follows the test imports in default mode.
 */
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
	// fs.mkdir reports the shallowest directory it had to create and returns undefined
	// when every component was already there. The return value is kept because step 4b
	// uses it to synchronize the directory ENTRIES this write created: fsyncing a
	// created directory syncs that directory's own inode, not the entry in its parent
	// that names it, so a crash could lose the saved file together with the new
	// directory holding it.
	const createdFrom = await fs.mkdir(dirPath, { recursive: true })
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
		// Compare canonical directories, not spellings. fs.realpath resolves a symlinked
		// ancestor directory and a Windows 8.3 short name, so a caller that staged through
		// an alias of the target's own directory staged beside the target and the commit
		// rename would not cross a filesystem: rejecting it on spelling alone failed a
		// write that was always legal. canonicalDirKey propagates any realpath failure that
		// is not "not there yet", so a directory whose canonical form cannot be established
		// is rejected rather than guessed at.
		const suppliedDirKey = path.dirname(await canonicalDirKey(supplied))
		if (suppliedDirKey !== path.dirname(await canonicalDirKey(targetPath))) {
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
	// Whether the commit rename ran. A failure after it is a durability problem
	// with the published file, not a pre-commit failure, and the backup is then
	// the only known-good copy of the previous content.
	let committed = false
	// Non-null only when the win32 step-2 block saved a successful DACL dump:
	// it gates the step-5 restore and is tracked for the cleanup unlinks.
	let daclDumpPath: string | null = null
	// The step-2 DACL handling and the staging-directory hardening in step 1 both key
	// off this value, and the hardening has to report through the same sink, so both are
	// resolved before the staging directory is created.
	const platform = options?.platform ?? process.platform
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
			// Windows: the platform's directory creation ignores mkdirSync's mode argument and
			// chmodSync does not establish a private DACL, so a staging directory created
			// inside a parent whose DACL admits other accounts holds the staged content readable
			// by those accounts until the step-5 restore. Make the directory private before the
			// first byte is written; stagingDir is non-null exactly on this branch.
			if (platform === "win32" && stagingDir !== null) {
				if (!(await _grantPrivateDaclWindows(stagingDir, options?.execFileRunner))) {
					warn(
						`Staged content in ${stagingDir} may be readable by other accounts: the staging directory's Windows DACL could not be made restrictive before the content was written.`,
					)
				}
			}
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
				// The target-absence question is asked here, on its own, so that the catch around the
				// block below can swallow exactly the answer this check gives rather than any ENOENT
				// raised inside that block: an ENOENT from opening dirPath to flush the entry that
				// names the recovery copy, or from the copy itself, says nothing about whether the
				// target exists, and swallowing it lets the commit rename publish with no recovery
				// copy of the previous content at all.
				let backupTargetAbsent = false
				try {
					try {
						await fs.access(targetPath)
					} catch (absenceError: unknown) {
						// The answer is recorded and then rethrown whatever it was, so that the copy
						// block below is skipped for a target that is not there yet: only the catch
						// around this whole block can tell that the ENOENT it is being handed was the
						// answer to this question, and it is that catch which permits the write to go
						// ahead with no recovery copy rather than a swallowed copy failure.
						if (errorCode(absenceError) === "ENOENT") {
							backupTargetAbsent = true
						}

						throw absenceError
					}
					backupPath = _tempName(dirPath, "safeWriteText.bak")
					// Copy, never move. Renaming the target away leaves the canonical path absent for
					// the whole commit window: readers see a missing file, and a concurrent
					// writer can create a new target that a later rollback would destroy. A copy
					// keeps the target present, so the step 4 rename is the only change to the
					// canonical path. The copy is flushed so the retained content survives a crash.
					try {
						// Create the destination BEFORE any content exists at it, with the mode fixed at
						// open time, and copy the bytes through descriptors this code opened. fs.copyFile
						// picks the destination's mode itself (the platform creation mask subject to umask
						// on some platforms) and, on POSIX, re-applies the SOURCE's mode to the file it
						// writes: a copy through it would widen this private 0o600 seed to the target's
						// permissions for the whole copy window - the previous content readable to every
						// account the target never admitted - and on Windows it carries the source's
						// read-only attribute onto the copy. Writing into the descriptor opened below keeps
						// the mode this code chose from the first byte to the last, so nothing has to be
						// chmodded afterwards.
						const seedFd = fsSync.openSync(backupPath, "wx", 0o600)
						try {
							const sourceFd = fsSync.openSync(targetPath, "r")
							try {
								const chunk = Buffer.allocUnsafe(64 * 1024)
								let readOffset = 0
								for (;;) {
									const read = fsSync.readSync(sourceFd, chunk, 0, chunk.length, readOffset)
									if (read === 0) {
										break
									}
									// writeSync can report a short write: publishing a truncated backup would
									// hand recovery a copy that is not a complete previous state.
									let written = 0
									while (written < read) {
										written += fsSync.writeSync(seedFd, chunk, written, read - written)
									}
									readOffset += read
								}
							} finally {
								fsSync.closeSync(sourceFd)
							}
						} finally {
							fsSync.closeSync(seedFd)
						}
						// "r+" not "r": fsync on a read-only handle is EPERM on Windows, and the same
						// flag the staged temp file uses above.
						const backupFd = fsSync.openSync(backupPath, "r+")
						try {
							_fsyncFile(backupFd)
						} finally {
							fsSync.closeSync(backupFd)
						}
						// The recovery copy is an entry inside dirPath, and the only directory fsync in
						// this function runs after the commit rename below. A crash between that rename
						// and that fsync can leave the rename on disk while the entry naming the recovery
						// copy has not reached it, which is the one case where PostCommitDurabilityError
						// hands the caller a backupPath for a copy that no longer exists: the content
						// survived into the renamed-to directory but the name for the copy did not.
						// Synchronizing dirPath here, while a failure is still a pre-commit failure, means
						// a directory-entry failure leaves the target at its previous content and the catch
						// below removes the copy, instead of the caller having to recover from a write that
						// already committed. The cost is one extra fsync on the backup path; the fsync after
						// the rename stays, because that rename changes a different entry in this directory.
						if (platform !== "win32") {
							const backupDirFd = fsSync.openSync(dirPath, "r")
							try {
								_fsyncFile(backupDirFd)
							} finally {
								fsSync.closeSync(backupDirFd)
							}
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
					// Only the answer the check above gave may be swallowed here, and only when it was
					// ENOENT: a target that is not there yet is written without a recovery copy, which
					// is what backup:true promises for a file that does not exist. Any other ENOENT from
					// this block - the copy, the flush of the copy, or the flush of the directory entry
					// naming it - is a failure of the write and reaches the caller before the rename.
					if (!backupTargetAbsent || errorCode(err) !== "ENOENT") throw err
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
					// The catch block keeps the backup on this path, so hand the caller the
					// path of the copy it is keeping - it is a hidden random name and is
					// otherwise unrecoverable.
					throw new PostCommitDurabilityError(targetPath, error, releaseBackupOnSuccess ? backupPath : null)
				}
				// The rename above changed one entry inside dirPath. When this write also
				// created dirPath or any of its ancestors, each of those directories is itself
				// an entry in its own parent, and the fsync above synchronized dirPath's inode,
				// not the entries naming it. Walk up from the first directory this write created
				// and synchronize each containing directory, deepest first: the same failure is
				// reported the same way, because the content is at the target either way and only
				// its durability is in question.
				if (createdFrom !== undefined) {
					const stopAt = path.dirname(createdFrom)
					let ancestorCursor = path.dirname(dirPath)
					try {
						for (;;) {
							const ancestorFd = fsSync.openSync(ancestorCursor, "r")
							try {
								_fsyncFile(ancestorFd)
							} finally {
								fsSync.closeSync(ancestorFd)
							}
							if (ancestorCursor === stopAt) {
								break
							}
							const ancestorParent = path.dirname(ancestorCursor)
							if (ancestorParent === ancestorCursor) {
								break
							}
							ancestorCursor = ancestorParent
						}
					} catch (ancestorError: unknown) {
						throw new PostCommitDurabilityError(
							targetPath,
							ancestorError,
							releaseBackupOnSuccess ? backupPath : null,
						)
					}
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
						`Content committed at ${targetPath}, but the saved DACL could not be restored from ${daclDumpPath}; the file may carry different access rights than the one it replaced.`,
					)
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
		// The backup is never restored: it is a copy, and the target already holds
		// either the pre-write content (before the commit) or the published content.
		// Only a pre-commit failure may discard the backup. After the commit the target
		// holds the NEW content, and when the failure is a post-commit durability error the
		// backup is the only copy known to hold the previous content - deleting it here
		// would destroy the recovery copy the contract promises.
		if (backupPath && releaseBackupOnSuccess && !committed) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there. Before the commit that is the pre-write content, and
			// the copy beside it is redundant; it must not be left where no caller can
			// find it.
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
