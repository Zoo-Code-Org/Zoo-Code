import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import { computeVersionToken } from "../../utils/versionToken"
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
 *
 * It also carries the version token the commit landed. The guidance this error gives
 * - do not re-issue the write - is only checkable against a version, and a guarded
 * write that wants to keep authorizing the content it just published has to record
 * the version that is on disk rather than the one its read observed.
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
	/**
	 * The version token of the content the commit landed, derived the way every guard
	 * derives one (`computeVersionToken`), read best-effort after the commit. Undefined
	 * when the post-commit stat failed: the commit stands either way, and a caller that
	 * cannot name the version says so rather than guessing.
	 */
	readonly committedVersion: string | undefined

	constructor(targetPath: string, cause: unknown, backupPath: string | null = null, committedVersion?: string) {
		super(
			"The rename committed but the parent directory could not be fsynced -- the content is at the target path reported on this error, and the directory entry may not be durable. " +
				(committedVersion !== undefined
					? `The content this write committed is version ${committedVersion} -- committed, not durable: do not re-issue the write; read the file again before editing it.`
					: "This write is committed, not durable: do not re-issue it; read the file again before editing it."),
			{ cause },
		)
		this.name = "PostCommitDurabilityError"
		this.targetPath = targetPath
		this.backupPath = backupPath
		this.committedVersion = committedVersion
	}
}

/**
 * The lock-key walk followed links as far as it was allowed to and never received an answer:
 * every step reported another link, so the chain was either longer than the bound or circular.
 * Reported as its own error because the operation has not been refused by a guard - it never got
 * as far as a guard - and because the caller's spelling is not a lock key: the writer that would
 * have taken this lock is the one whose key the filesystem refused to name.
 */
export class LockKeyWalkIncompleteError extends Error {
	readonly absoluteFilePath: string
	readonly bound: number
	/** The last key the walk reached before it stopped. Carried because the caller can report which
	 * spelling it stopped at without re-walking the chain. */
	readonly lastKey: string

	constructor(absoluteFilePath: string, bound: number, lastKey: string) {
		super(
			`Lock key for ${absoluteFilePath} did not resolve within ${bound} symlink steps (last key ${lastKey}); refusing to take a lock derived from the spelling the walk stopped at.`,
		)
		this.name = "LockKeyWalkIncompleteError"
		this.absoluteFilePath = absoluteFilePath
		this.bound = bound
		this.lastKey = lastKey
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
	// existing directory), so on POSIX staged temp files are never group/world readable.
	// On Windows the mode is no restriction at all: icacls on a staging directory created and
	// chmodSync-d exactly this way still lists inherited read for BUILTIN\Users and inherited
	// modify for NT AUTHORITY\Authenticated Users, which is why _restrictStagingDaclWindows sets
	// the DACL before any content goes into the directory.
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

/**
 * Upper bound for the Windows DACL child processes, in milliseconds. execFile without a timeout
 * waits for the child indefinitely: a icacls blocked on a reparse point, a network share, or an
 * interception filter would hold the caller's write open forever, and for a safeWriteJson caller it
 * would hold the per-file advisory lock while every other writer of the same file exhausts its
 * retries (src/utils/fileLock.ts: 5 retries, 100ms..1s backoff) and fails. A timeout lands on the
 * path this module already has for a failing icacls - skip DACL handling, commit the write, report
 * the warning - and it stays below LOCK_STALE_MS (31_000) so a hung helper cannot outlive the
 * staleness window the lock protocol is written around.
 */
// How far resolveLockKey will follow links when the path is not there yet. Two links that
// point at each other never answer "not there" or "not a link", so the walk needs a bound; it is
// a limit on the work, not a claim about how deep a real chain goes.
const LOCK_KEY_WALK_BOUND = 8
const DACL_COMMAND_TIMEOUT_MS = 20_000

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns true when the dump was written successfully; false otherwise.
 * Never throws — callers treat failure as "skip DACL handling". */
async function _saveDaclWindows(srcPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner(
				"icacls",
				[srcPath, "/save", dumpPath, "/T"],
				{ timeout: DACL_COMMAND_TIMEOUT_MS, windowsHide: true },
				(err) => (err ? reject(err) : resolve()),
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
			runner(
				"icacls",
				[dirPath, "/restore", dumpPath],
				{ timeout: DACL_COMMAND_TIMEOUT_MS, windowsHide: true },
				(err) => (err ? reject(err) : resolve()),
			)
		})
		return true
	} catch {
		return false
	}
}

/**
 * The account name a Windows DACL grant can be addressed to, or null when the host offers none.
 *
 * icacls refuses a principal it cannot map and leaves the directory alone: measured with the real
 * icacls on this machine's own volume, an empty principal makes it exit 87 and print its usage text,
 * and a name that maps to no SID makes it exit 1332 printing "No mapping between account names and
 * security IDs was done." os.userInfo reports an account name on a host where USERNAME is empty, so
 * it is asked first; with no name at all there is nothing to grant to, and a child process that can
 * only fail is not worth starting.
 */
function _windowsGrantPrincipal(): string | null {
	const candidates: (string | undefined)[] = []
	try {
		candidates.push(os.userInfo().username)
	} catch {
		// userInfo can fail on a constrained host; the environment spellings are the fallback.
	}
	candidates.push(process.env.USERNAME, process.env.LOGNAME)
	for (const candidate of candidates) {
		const name = (candidate ?? "").trim()
		// icacls reads a principal as "<name>:(<rights>)", so a name carrying a colon or a parenthesis
		// would turn one argument into two different meanings.
		if (name !== "" && !name.includes(":") && !name.includes("(") && !name.includes(")")) {
			return name
		}
	}
	return null
}

/**
 * Run one icacls command under the same bound the target-DACL steps use, and report its exit code
 * instead of throwing: everything here treats icacls as advisory, exactly as the steps that save
 * and restore the target's DACL already do.
 */
async function _runIcaclsWindows(
	args: string[],
	execFileRunner?: typeof execFile,
): Promise<{ ok: true } | { ok: false; code: number | string }> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", args, { timeout: DACL_COMMAND_TIMEOUT_MS, windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return { ok: true }
	} catch (error: unknown) {
		const code = (error as { code?: number | string }).code
		return { ok: false, code: code ?? "unknown" }
	}
}

/**
 * Narrow the access rights of the staging directory this write created, on Windows, before any
 * content is written into it.
 *
 * Windows gives a new file the access rights its directory holds at the moment the file is created,
 * so the narrowing has to land before Step 1 puts a byte into the directory. Measured on this
 * machine: a file staged into a directory that was narrowed only afterwards does lose the inherited
 * rights in the end, but it sat readable to BUILTIN\Users for the whole time it was there, and that
 * window is what this step closes. Returns the directory the narrowing actually landed on - so the
 * caller knows that a later lockout is this write's own doing and worth undoing - plus the notice to
 * report, in the shape this module already uses for a failing icacls on the target: skip the DACL
 * work, commit the write, tell the caller. A host without icacls, a principal that maps to no SID
 * and a child that never returns are all non-fatal here.
 */
async function _restrictStagingDaclWindows(
	stagingDir: string,
	execFileRunner?: typeof execFile,
): Promise<{ appliedTo: string | null; notice: string | null }> {
	const principal = _windowsGrantPrincipal()
	if (principal === null) {
		return {
			appliedTo: null,
			notice: "Could not narrow the access rights of the staging directory: this process offered no account name to grant them to.",
		}
	}
	const restricted = await _runIcaclsWindows(
		[stagingDir, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)(F)`],
		execFileRunner,
	)
	if (!restricted.ok) {
		return {
			appliedTo: null,
			notice: `Could not narrow the access rights of ${stagingDir} (icacls exited ${restricted.code}); the directory keeps the rights it inherited.`,
		}
	}
	return { appliedTo: stagingDir, notice: null }
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
 * Stat a directory for the staging-containment comparison. undefined means the directory is not
 * there, which is the one failure that carries information about containment: a supplied staging
 * file cannot sit in a directory that does not exist, and the caller's spelling comparison decides.
 * Any other failure is the guard losing its ability to decide, so it is reported as its own refusal
 * rather than being read as containment.
 */
async function _statDirectoryForContainment(
	directoryPath: string,
	supplied: string,
): Promise<fsSync.BigIntStats | undefined> {
	try {
		return await fs.stat(directoryPath, { bigint: true })
	} catch (error: unknown) {
		if (errorCode(error) === "ENOENT") {
			return undefined
		}
		throw new StagingPathError(
			`Staging directory could not be compared with the target's directory (${directoryPath})`,
			supplied,
		)
	}
}

/**
 * Whether the two stats name DIFFERENT files, judged the way the compares around it judge
 * one directory: as bigints, because on NTFS and ReFS a file identity can exceed
 * Number.MAX_SAFE_INTEGER and a rounded value makes two files look alike or two spellings of
 * one file look different. The helper reports a swap only when both stats actually carry a
 * bigint identity - production asks for { bigint: true } at every call site that feeds it, so
 * a stat without one is a double that was never asked to answer identity, and calling that a
 * swap would refuse every staged write for a shape no real filesystem produces. A stat that
 * fails outright is handled by its call site, not here: this helper only ever answers
 * "different" or "not shown to be different".
 */
function _stagingIdentityDiffers(checked: fsSync.BigIntStats, current: fsSync.BigIntStats): boolean {
	return (
		typeof checked.ino === "bigint" &&
		typeof current.ino === "bigint" &&
		typeof checked.dev === "bigint" &&
		typeof current.dev === "bigint" &&
		(checked.ino !== current.ino || checked.dev !== current.dev)
	)
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
 *
 * It is fail-closed about the other reason a resolution can end without an answer.
 * The fallback walk runs only for ENOENT - the path is not there yet, which is also
 * what a dangling link reports - because that is the one case where a key can still
 * be derived without guessing. A failure that says the filesystem refused to answer
 * (EACCES on a link the caller may not read, ENOTDIR, EIO, or the ELOOP that
 * resolvePublishTarget reports for a cycle) propagates: a key built from the caller's
 * own spelling after a refusal is the same divergence class this function exists to
 * remove, and locking the wrong file is worse than refusing the operation. Reaching
 * the walk's depth bound is the third way an answer fails to arrive - the chain went
 * as far as it was allowed to and stopped - so it rejects rather than returning the
 * prefix the walk happened to stop at.
 * Every key this function returns is canonicalized through canonicalDirKey.
 */
export async function resolveLockKey(absoluteFilePath: string): Promise<string> {
	try {
		return await canonicalDirKey(await resolvePublishTarget(absoluteFilePath))
	} catch (error: unknown) {
		// Only a missing path falls back. Everything else is a refusal, and a refusal is not
		// evidence about what the path refers to - see the note above.
		if (errorCode(error) !== "ENOENT") {
			throw error
		}
		// A real readlink also answers for cases that are not failures: "not there" and "not a
		// link" (EINVAL, which is what a plain file and a Windows junction report) end the walk
		// at the key it reached, which is the answer for a dangling link and for an alias that
		// lands on a real file. Two links that point at each other answer neither, so the walk is
		// bounded, and the bound is a refusal rather than an answer.
		let key = absoluteFilePath
		for (let depth = 0; depth < LOCK_KEY_WALK_BOUND; depth++) {
			const target = await fs.readlink(key).catch((readlinkError: unknown) => {
				const code = errorCode(readlinkError)
				if (code === "ENOENT" || code === "EINVAL") {
					return undefined
				}
				throw readlinkError
			})
			if (target === undefined) {
				return await canonicalDirKey(key)
			}
			key = await canonicalDirKey(path.resolve(path.dirname(key), target))
		}
		throw new LockKeyWalkIncompleteError(absoluteFilePath, LOCK_KEY_WALK_BOUND, key)
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

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind. Track the directory this
	// write created so its cleanup removes its own directory, not a shared one.
	let stagingDir: string | null = null
	let tempPath: string
	// Non-null only for a caller-supplied staging file: the identity the validation above
	// reported, plus the spelling a refusal should quote back. The open and the commit rename
	// each re-confirm the path against it, because validation is a statement about one moment.
	let validatedStaging: { stats: fsSync.BigIntStats; supplied: string } | null = null
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
		const suppliedDir = path.dirname(supplied)
		const targetDir = path.resolve(dirPath)
		// Containment is a claim about directories, not about strings. An alias root - a junction on
		// Windows, a symlinked directory on POSIX - makes canonicalDirKey hand dirPath in the referent's
		// spelling while the caller still holds its own, and a string compare of the two then refuses a
		// staging file that sits physically inside the target's directory. Compare the directories by
		// identity, through fs.stat with bigint: true for the same reason the two lstats below use it:
		// on NTFS and ReFS a file identity can exceed Number.MAX_SAFE_INTEGER, and a rounded number makes
		// two directories look different or two different directories look alike. The spelling compare is
		// kept as the fast path in front of it and as the answer when a stat cannot be made; a stat that
		// fails for any reason other than the directory not being there propagates, because a guard that
		// reads "could not tell" as "contained" has stopped guarding.
		if (suppliedDir !== targetDir) {
			const suppliedDirStat = await _statDirectoryForContainment(suppliedDir, supplied)
			const targetDirStat = await _statDirectoryForContainment(targetDir, supplied)
			const sameDirectory =
				suppliedDirStat !== undefined &&
				targetDirStat !== undefined &&
				suppliedDirStat.dev === targetDirStat.dev &&
				suppliedDirStat.ino === targetDirStat.ino
			if (!sameDirectory) {
				throw new StagingPathError(
					`Staging file must sit in the target's directory (${dirPath}), got ${supplied}`,
					supplied,
				)
			}
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
		// Everything above is a statement about the path at one moment. Keep the identity that
		// was checked so the open and the commit rename can each re-confirm it.
		validatedStaging = { stats: stagingStat, supplied }
		tempPath = options.tempPath
	} else {
		// The staging directory lives inside the target's own parent, so the parent has to exist
		// before _stagingDir runs: mkdirSync's recursive creation applies its mode to every
		// directory it creates and never chmods one that already exists, so a self-staged write
		// into a missing parent would publish the target into a directory left at the private
		// staging mode (0o700) instead of the directory default. Nothing validates a self-staged
		// path ahead of this, so creating the parent here cannot create a directory on behalf of
		// a write that is about to be rejected -- and it is the order safeWriteJson already uses
		// for its own staging directory.
		await fs.mkdir(dirPath, { recursive: true })
		stagingDir = _stagingDir(dirPath)
		tempPath = _tempName(stagingDir, "safeWriteText")
	}

	// A caller-supplied staging path defers this until that path has been accepted (mirrors
	// safeWriteJson behaviour): mkdir -p ahead of the caller-supplied checks let a *rejected*
	// write create a directory in the target's own tree before anything was validated. For
	// the self-staged branch above this re-runs on a directory that already exists -- a
	// recursive mkdir never chmods an existing directory, so it cannot repair a mode inherited
	// from the staging creation -- and fs.access still confirms the directory is usable.
	await fs.mkdir(dirPath, { recursive: true })
	await fs.access(dirPath)

	const platform = options?.platform ?? process.platform
	// Warning delivery must never abort the write: the notices below describe a publish that went
	// ahead imperfectly - some of them land before the commit - and a caller whose callback throws (a UI
	// sink, a logger that is mid-restart) must not turn that into a failed save.
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

	// -- Step 0 (win32): narrow the staging directory BEFORE any content is staged in it -----
	// The 0o700 mode _stagingDir asks for carries no weight on Windows: measured with the real icacls,
	// a staging directory created with that mode and chmodSync-d to it afterwards still lists
	// inherited read for BUILTIN\Users and inherited modify for NT AUTHORITY\Authenticated Users, the
	// same rights the target's parent directory holds, so every byte a save stages is readable to
	// other logins for as long as it sits there. Narrowing the directory before the staged file is
	// created hands that file the narrow rights from its first byte. Only the staging directory this
	// write created is touched (its name is unique per write), and a caller-supplied staging path
	// lives beside the target rather than in here, so neither the caller's directory nor another
	// write's staging is narrowed by this call.
	let stagingDaclAppliedTo: string | null = null
	if (platform === "win32" && stagingDir !== null) {
		const stagingDacl = await _restrictStagingDaclWindows(stagingDir, options?.execFileRunner)
		if (stagingDacl.notice !== null) {
			warn(stagingDacl.notice)
		}
		stagingDaclAppliedTo = stagingDacl.appliedTo
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

			// The staged open doubles as the rights check for the directory narrowed above. When the grant
			// names an account this process does not carry, the directory holds no access right for its own
			// writer, and that surfaces here as EPERM or EACCES on the open: measured on this machine,
			// listing, opening and writing inside such a directory each answered EPERM. Hand the inherited
			// rights back and try once - and only when this write was the one that narrowed the directory,
			// because a path somebody else narrowed is not this write's to widen. Any other failure
			// propagates unchanged.
			let fd: number
			try {
				fd = fsSync.openSync(tempPath, "w", targetMode)
			} catch (error: unknown) {
				const openCode = errorCode(error)
				if (stagingDaclAppliedTo === null || (openCode !== "EPERM" && openCode !== "EACCES")) {
					throw error
				}
				await _runIcaclsWindows([stagingDaclAppliedTo, "/reset"], options?.execFileRunner)
				warn(
					`Restricting ${stagingDaclAppliedTo} left it without an access right for this process (${openCode}); its inherited rights were restored and the content is staged under them.`,
				)
				fd = fsSync.openSync(tempPath, "w", targetMode)
			}
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
				if (validatedStaging) {
					// Re-confirm the file the open actually landed on, BEFORE the chmod below: an fd
					// opened on a path that was swapped for a link in the meantime would change the
					// permissions of somebody else's file, and a swap to a different file would let the
					// commit publish that file instead of the content staged here. A fstatSync that
					// fails propagates: the fd is ours, and a stat we cannot take is not evidence that
					// the path still names our file.
					const opened = fsSync.fstatSync(fd, { bigint: true })
					if (_stagingIdentityDiffers(validatedStaging.stats, opened)) {
						throw new StagingPathError(
							"Staging file was replaced between validation and open",
							validatedStaging.supplied,
						)
					}
				}
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
			// The rename publishes whatever the staging path names at the moment it runs. One step
			// before it, confirm the path still names the file this write staged and chmodded: a
			// path swapped for a link or for another file in the meantime would otherwise be
			// published in place of the content written here. A stat that fails - the file gone, or
			// a failure that is not about it being gone - is a refusal, because the rename cannot
			// then be shown to be publishing our content. The window between this look and the
			// rename is narrowed, not closed: a rename has no handle to go through, so this is the
			// last look, not a lock.
			if (validatedStaging) {
				const beforeCommit = await fs.lstat(tempPath, { bigint: true }).catch((error: unknown) => {
					throw new StagingPathError(
						`Staging file could not be re-checked before the commit (${errorCode(error) ?? "unknown error"}): ${tempPath}`,
						validatedStaging.supplied,
					)
				})
				if (_stagingIdentityDiffers(validatedStaging.stats, beforeCommit)) {
					throw new StagingPathError(
						"Staging file was replaced between validation and the commit",
						validatedStaging.supplied,
					)
				}
			}
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
					// Read the version the commit landed, the same derivation every guard compares
					// against, so a caller can record which content is on disk and a later write can
					// be authorized against it. Best-effort: a failed stat does not undo the commit.
					const committedVersion = await computeVersionToken(targetPath).catch(() => undefined)
					throw new PostCommitDurabilityError(
						targetPath,
						error,
						releaseBackupOnSuccess ? backupPath : null,
						committedVersion,
					)
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
