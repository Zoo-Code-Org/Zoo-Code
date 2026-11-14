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

	/**
	 * The publish target the caller already authorized.
	 * A caller that checks workspace containment and then calls this primitive resolves
	 * the path twice: once for its own decision and once here. If a link is swapped in
	 * between the two, the decision was about a different file than the one published.
	 * Passing the authorized value makes that drift fatal instead of silent.
	 */
	expectedResolvedPath?: string

	/**
	 * The directories the caller walked when it authorized this target, with the
	 * (dev, ino) identity each had at that moment.
	 *
	 * expectedResolvedPath pins the NAME this write publishes; it cannot see a parent
	 * directory being replaced by a link between the caller's containment check and the
	 * commit. Re-checking the ancestor identities immediately before the commit makes a
	 * swapped parent fatal too: the publish then aborts instead of writing through the new
	 * link. Node has no descriptor-relative rename, so a swap that lands after this check
	 * and before the rename is not eliminable here - it narrows the window to the commit
	 * itself rather than the whole guard.
	 * The identity check is paired with a realpath comparison: moving a directory
	 * preserves (dev, ino), and replacing its old name with a symlink to the moved
	 * location keeps stat() matching while sending the commit to the new location.
	 * The name must still resolve to the authorized location, not merely to the
	 * same inode.
	 */
	expectedAncestorIdentities?: AncestorIdentity[]
}

/** One directory's on-disk identity, read with bigint stats so NTFS 64-bit values survive. */
export type AncestorIdentity = {
	dir: string
	dev: bigint
	ino: bigint
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

/**
 * The path resolved to something other than the target the caller authorized.
 * Nothing is staged or published: a link swapped in after the caller's containment
 * check would otherwise send the write to a file that check never covered.
 */
export class TargetMovedError extends Error {
	readonly authorizedPath: string
	readonly resolvedPath: string
	constructor(authorizedPath: string, resolvedPath: string) {
		super(
			`The write was authorized for ${authorizedPath}, but that path now resolves to ${resolvedPath} -- nothing was published.`,
		)
		this.name = "TargetMovedError"
		this.authorizedPath = authorizedPath
		this.resolvedPath = resolvedPath
	}
}

/**
 * A directory the caller walked on its way to the authorized target is no longer the
 * directory it was: it was removed, replaced, or turned into a link to somewhere else.
 * Publishing through it would act on a decision that was never made about the file now
 * reachable there, so the commit is aborted.
 */
export class AncestorReplacedError extends Error {
	readonly directory: string
	constructor(directory: string, reason: string) {
		super(`A directory on the authorized path (${directory}) ${reason} -- nothing was published.`)
		this.name = "AncestorReplacedError"
		this.directory = directory
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
 * Components that are not there yet are walked over and re-joined onto the nearest
 * ancestor that is: the writer that arrives before this file's parent directory is
 * created has to take the lock of the writer that arrives after it. Only a missing
 * component may be walked over. An ancestor that exists but cannot be canonicalized
 * (ENOTDIR under a regular-file component, EACCES, EIO, ELOOP) means the canonical
 * key is unknown, and handing back the literal spelling would key this writer apart
 * from every writer that did canonicalize the same file.
 */

async function canonicalDirKey(absoluteFilePath: string): Promise<string> {
	const basename = path.basename(absoluteFilePath)
	const missing: string[] = []
	let cursor = path.dirname(absoluteFilePath)
	for (;;) {
		try {
			const canonicalDir = await fs.realpath(cursor)
			return path.join(canonicalDir, ...missing.reverse(), basename)
		} catch (error: unknown) {
			if (errorCode(error) !== "ENOENT") {
				throw error
			}
			const parent = path.dirname(cursor)
			if (parent === cursor) {
				// The root of this path was reached with components still missing: no ancestor
				// is left to canonicalize, so this spelling is the only answer available.
				return path.join(cursor, ...missing.reverse(), basename)
			}
			missing.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Lock key for a publish target: the symlink referent when the path is an
 * existing symlink, the path itself otherwise. Unlike resolvePublishTarget this
 * tolerates a dangling link, because the lock key has to be computable while a
 * peer writer is mid-commit (a publish renames the staged file onto the referent,
 * and backup mode keeps a copy beside it).
 * The walk is bounded, and a chain the bound cannot resolve rejects rather than naming
 * an arbitrary intermediate link: two writers that enter the same chain from different
 * ends would otherwise key one file with two different locks. Every key it does return
 * is canonicalized through canonicalDirKey.
 */
export async function resolveLockKey(absoluteFilePath: string): Promise<string> {
	try {
		return await canonicalDirKey(await resolvePublishTarget(absoluteFilePath))
	} catch (error: unknown) {
		// Only a dangling link (ENOENT) may fall through to the walk: any other
		// resolution error (EACCES, EIO) would key this writer to the alias path
		// while a writer reaching the referent directly keys the referent, and
		// the two writers would then take different locks for one file.
		if (errorCode(error) !== "ENOENT") {
			throw error
		}
		// A real readlink reports "this is not a link" by throwing: EINVAL on the
		// platforms this file runs on (measured with node 22.23.4 on win32, and EINVAL
		// on linux), and ENOENT when the path itself is gone. Those two answers end the
		// walk. Any other failure - EACCES, EIO, ELOOP - says nothing about whether this
		// path is a link, so it propagates: keying this writer to the alias while a
		// writer that reached the referent keys the referent is the two-locks-for-one-file
		// loss this function exists to prevent, and guessing it is how that loss arrives.
		const linkWalkLimit = 8
		let key = absoluteFilePath
		for (let depth = 0; depth < linkWalkLimit; depth++) {
			const target = await fs.readlink(key).catch((linkError: unknown) => {
				const code = errorCode(linkError)
				if (code === "ENOENT" || code === "EINVAL") return undefined
				throw linkError
			})
			if (target === undefined) return await canonicalDirKey(key)
			// A relative referent is relative to the link's REAL parent, not to the spelling the
			// caller arrived with: under a symlinked directory `..` names the referent's parent,
			// so a lexical join keys a different file and the writer through the alias stops
			// excluding the writer through the referent. When the link's own parent cannot be
			// canonicalized - a dangling chain - the lexical join is the only answer available.
			const referentParent = path.isAbsolute(target)
				? undefined
				: await fs.realpath(path.dirname(key)).catch(() => undefined)
			key = await canonicalDirKey(path.resolve(referentParent ?? path.dirname(key), target))
		}
		// The bound only exists to terminate a cycle. Past it the chain names no file, so
		// the caller is told instead of handed whichever link the walk stopped on.
		throw new Error(
			`safeWriteText: could not resolve a lock key for ${absoluteFilePath}: the symlink chain is deeper than ${linkWalkLimit} links`,
		)
	}
}

/**
 * The publish primitive itself. Tagged @internal because nothing in the shipped
 * extension reaches it yet: this unit lands the primitive and its evidence, and the
 * writer that is meant to call it arrives with the guardedWrite migration. Without the
 * tag the production Knip view reports this export as unused, which states the wrong
 * reason - the export is deliberate, its consumer is later in the merge order - and the
 * alternative is blanking this whole 973-line module in knip.json.
 *
 * @internal
 */
export async function safeWriteText(
	filePath: string,
	content: string | Uint8Array,
	options?: SafeWriteTextOptions,
): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolvePublishTarget(absoluteFilePath)
	// The caller authorized a specific resolved path; publishing at a different one
	// would act on a decision that was never made about this file.
	if (options?.expectedResolvedPath && path.resolve(options.expectedResolvedPath) !== targetPath) {
		throw new TargetMovedError(options.expectedResolvedPath, targetPath)
	}
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
	// The identity the staging check validated below, kept so the mode copy further down can
	// prove the descriptor it is about to chmod is that same file and not a name swapped after
	// the check. Null when this write stages the file itself.
	let validatedStagingIdentity: { dev: bigint; ino: bigint } | null = null
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
			// A textual mismatch is not yet evidence that the staging file sits elsewhere, because one
			// directory answers to more than one spelling. NTFS hands out an 8.3 alias for every name
			// longer than eight characters - the hosted Windows runner's temp directory arrives as
			// RUNNER~1 under the profile while the writer's resolved target arrives in the long
			// spelling - and a junction or link does the same thing on any box. Which spelling a comparison
			// sees depends on which call produced it: path.resolve preserves what it is handed, node's
			// synchronous fs.realpathSync preserves it too and only realpathSync.native expands the 8.3
			// form, while node's asynchronous fs.realpath - the call resolvePublishTarget uses - does
			// expand it. All four were measured on node 22.23.4 against a directory created for the
			// purpose: the alias C:\work\ZOO-CO~1\TMP-AL~2\LONG-D~1 came back expanded from async
			// realpath, unchanged from realpathSync, and both spellings statted to one inode
			// 673102249:562949965815680. A text match therefore proves nothing about whether two
			// strings name one directory. The property this guard protects -
			// no cross-filesystem commit rename (EXDEV) and no publishing of an unrelated file onto the
			// target - is a property of the directory's identity, so compare identity: dev and ino, read
			// as bigint for the same reason as the file check below. A directory that cannot be stat'd
			// keeps the rejection, so this only ever accepts what the textual check would have accepted
			// had the spelling been canonical on both sides.
			const suppliedDir = path.dirname(supplied)
			const [suppliedDirStat, targetDirStat] = await Promise.all([
				fs.stat(suppliedDir, { bigint: true }).catch(() => undefined),
				fs.stat(dirPath, { bigint: true }).catch(() => undefined),
			])
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
		// Ownership convention: a caller-staged file must carry the staging name this
		// library's own writers use (.new_<ts>_<rand>.tmp). An arbitrary regular file
		// beside the target (e.g. credentials.json) passes every check above, yet
		// renaming it onto the target publishes an unrelated file's content and deletes
		// its original name. Only files created under the staging convention may be
		// published through this parameter.
		if (!/^\.new_.*\.tmp$/.test(path.basename(supplied))) {
			throw new StagingPathError(
				`Staging file must carry the staging name convention .new_*.tmp, got ${path.basename(supplied)}`,
				supplied,
			)
		}
		// The caller's own path is used as given; only the check is canonical.
		tempPath = options.tempPath
		validatedStagingIdentity = { dev: stagingStat.dev, ino: stagingStat.ino }
	} else {
		stagingDir = _stagingDir(dirPath)
		tempPath = _tempName(stagingDir, "safeWriteText")
	}

	let backupPath: string | null = null
	let releaseBackupOnSuccess = false
	// Identity of the staged file as this write last held it open, captured from the descriptor
	// that was fsynced. The commit rename below takes a NAME, and between the fsync (which
	// releases the descriptor) and that rename a process that can write the staging directory can
	// move this write's file aside and put another file at the same name; the rename would then
	// publish content this write never wrote and never flushed.
	let stagedIdentity: fsSync.BigIntStats | null = null
	// Set when the pre-commit comparison finds a different file at the staging name: the name no
	// longer belongs to this write, so the failure cleanup must not unlink somebody else's file.
	let stagedPathIsForeign = false
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
				stagedIdentity = fsSync.fstatSync(fd, { bigint: true })
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
				// Prove the opened file is not a borrowed name: between the lstat check
				// and this open, a local attacker who can write the directory can replace
				// the staging path with a hard link to another file in it, and the commit
				// rename would then publish that file and delete its original name. While
				// the other name exists the inode carries a second link, so nlink === 1 on
				// the opened fd rules the substitution out; a swap that first unlinks the
				// other name can only stage content the attacker already had, not a file
				// the caller still references.
				const opened = fsSync.fstatSync(fd)
				if (!opened.isFile() || opened.nlink !== 1) {
					throw new StagingPathError(
						`Staging file changed between the check and the open: ${tempPath}`,
						tempPath,
					)
				}
				// The check above proves the name was a regular file when it was lstat'd, not that this
				// descriptor is that file. A writer of this directory can name the path for a symlink to a
				// single-link regular file between the lstat and the open: the open follows it, fstat then
				// reports a regular file with nlink 1 so the guard above passes, and the chmod below would
				// change that other file's mode. The pre-commit name check further down refuses the publish
				// but does not undo a mode already changed, so compare against the validated identity here.
				const openedIdentity = fsSync.fstatSync(fd, { bigint: true })
				if (
					validatedStagingIdentity !== null &&
					(openedIdentity.dev !== validatedStagingIdentity.dev ||
						openedIdentity.ino !== validatedStagingIdentity.ino)
				) {
					throw new StagingPathError(
						`Staging file changed between the check and the mode copy: ${tempPath}`,
						tempPath,
					)
				}
				if (targetMode !== null) {
					fsSync.fchmodSync(fd, targetMode)
				}
				_fsyncFile(fd)
				stagedIdentity = fsSync.fstatSync(fd, { bigint: true })
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
			// -- Step 2b: re-validate the authorized ancestry before committing --
			// The caller decided containment by walking this directory chain. A parent
			// swapped for a link to outside that chain would send the commit somewhere the
			// caller never authorized, even though expectedResolvedPath still matches (the
			// name is unchanged). Compare each recorded identity now, before anything is
			// moved into place.
			if (options?.expectedAncestorIdentities) {
				for (const expected of options.expectedAncestorIdentities) {
					const current = await fs.stat(expected.dir, { bigint: true }).catch((error: unknown) => {
						if (errorCode(error) === "ENOENT") {
							throw new AncestorReplacedError(expected.dir, "no longer exists")
						}
						throw error
					})
					if (current.dev !== expected.dev || current.ino !== expected.ino) {
						throw new AncestorReplacedError(expected.dir, "is no longer the directory that was authorized")
					}
					// A move preserves dev+ino, so the identity check above passes for a
					// directory that was relocated and whose old name was replaced by a
					// symlink to the moved location - stat follows that link. The commit
					// below takes path strings and would follow it too, publishing at the
					// moved location outside the chain the caller walked. Require that the
					// authorized name still resolves to the very location it named.
					// Only a vanished name is a containment violation. A transient EACCES
					// or EIO would otherwise be reported as a replaced ancestor, pointing
					// the user at a security problem that is not there - mirror the stat
					// call above, which maps only ENOENT and rethrows the rest.
					const resolvedDir = await fs.realpath(expected.dir).catch((error: unknown) => {
						const code = errorCode(error)
						if (code === "ENOENT" || code === "ENOTDIR") {
							return undefined
						}
						throw error
					})
					if (resolvedDir === undefined || path.resolve(resolvedDir) !== path.resolve(expected.dir)) {
						throw new AncestorReplacedError(expected.dir, "no longer resolves to the authorized location")
					}
				}
			}

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
			// A symlink can be retargeted while the temp file is being written: re-resolve
			// immediately before the commit rename so the locked resolution cannot publish
			// onto a sibling file that replaced the referent mid-write.
			const recomputedTargetPath = await resolvePublishTarget(absoluteFilePath)
			if (recomputedTargetPath !== targetPath) {
				throw new Error(
					`safeWriteText: refusing to commit ${absoluteFilePath}: the resolved target changed from ${targetPath} to ${recomputedTargetPath} while the write was in progress`,
				)
			}

			// The staging path is a name, not the file. Everything above released the descriptor,
			// and a process that can write the staging directory has had the whole window since the
			// fsync to move this write's file aside and name another file after it. The rename below
			// follows the name, so compare the name against the descriptor this write fsynced and
			// refuse rather than publish bytes that were never flushed here. A move preserves dev+ino,
			// and a hard link leaves nlink above 1, so both are caught the same way the open above is.
			if (stagedIdentity) {
				const nowStaged = await fs.lstat(tempPath, { bigint: true }).catch((error: unknown) => {
					if (errorCode(error) === "ENOENT") {
						throw new StagingPathError(
							`Staging file disappeared before the commit rename: ${tempPath}`,
							tempPath,
						)
					}
					throw error
				})
				if (
					typeof nowStaged.ino === "bigint" &&
					typeof stagedIdentity.ino === "bigint" &&
					(!nowStaged.isFile() ||
						nowStaged.ino !== stagedIdentity.ino ||
						nowStaged.dev !== stagedIdentity.dev ||
						// bigint against bigint: lstat with { bigint: true } reports nlink as a bigint,
						// so comparing it with the number 1 would never be equal.
						nowStaged.nlink !== 1n)
				) {
					// The name now belongs to a different file: unlinking it here would delete the
					// file that took its place, which this write has no claim on.
					stagedPathIsForeign = true
					throw new StagingPathError(
						`Staging file changed between the fsync and the commit rename: ${tempPath}`,
						tempPath,
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
		// The pre-commit comparison above found a foreign file at the staging name: this write's own
		// file is gone from that name, and removing what took its place would destroy a file the
		// caller never handed over.
		if (!committed && !stagedPathIsForeign) {
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
