import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

import { getErrorCode } from "../../utils/errorCode"

export interface SafeWriteTextOptions {
	/**
	 *
	 * When true, keep a durable copy of the previous content at a sibling
	 * safeWriteText.bak_* file for the duration of the write: the target is copied
	 * before the commit rename and the copy is removed after it. The copy is never
	 * a rollback source - nothing is restored on failure, because the copy never
	 * displaced the target: before the commit the target still holds its previous
	 * content, and after it the target holds the new content and this call removes
	 * the copy. A removal that fails AFTER the commit reports OrphanedPublishedBackupError
	 * and leaves the new content at the target: nothing is rolled back, because rolling back
	 * would replace published bytes with an older copy the caller never asked to restore. A
	 * removal that fails after a write that never committed reports
	 * OrphanedBackupAfterFailedWriteError, whose contentPublished says which of the two
	 * happened. When false (default) the atomic rename simply replaces the target --
	 * crash-safe window is zero.
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
	 * Commit only if the target name does NOT exist at commit time.
	 * rename(2) has no no-replace form - it silently displaces a target that another
	 * writer created after the caller's absence check - so the commit is done with
	 * link(2) instead, which fails EEXIST for an existing name (and does not follow a
	 * symlink placed at that name). A conditional create therefore cannot overwrite a
	 * file it never saw.
	 */
	failIfExist?: boolean

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
	 * The name must still resolve to the location it was authorized against - the
	 * recorded resolvedPath when the caller walked a symlink alias, and dir itself
	 * when it recorded a plain spelling - not merely to the same inode.
	 */
	expectedAncestorIdentities?: DirectoryIdentity[]

	/**
	 * Cancellation of an in-flight write.
	 *
	 * Every step before the commit is awaited, so a caller that loses interest - a document closed,
	 * a task abandoned - has one point where the publish can still be refused: the commit gate, after
	 * the staging file and any backup copy exist and before the target name is moved. An aborted
	 * signal refuses, the failure cleanup removes this write's staging file, and the target keeps the
	 * content it had. An abort arriving after this gate cannot be observed - there is no await left
	 * between here and the rename - so that commit completes.
	 */
	signal?: AbortSignal
}

/** One directory's on-disk identity, read with bigint stats so NTFS 64-bit values survive. */
export type DirectoryIdentity = {
	dir: string
	dev: bigint
	ino: bigint
	/**
	 * Where `dir` resolved to when this identity was taken (its realpath).
	 *
	 * A caller that authorized a chain running THROUGH a symlink alias records the alias
	 * spelling as `dir`; that alias's realpath legitimately differs from `dir` while nothing
	 * moved, so comparing the current realpath against `dir` alone refuses a write whose
	 * ancestry never changed. The pre-commit revalidation compares against this value when it
	 * is present, and against `dir` when it is not.
	 */
	resolvedPath?: string
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

/**
 * The write committed and the content is published, but the pre-write backup could not be
 * removed after two attempts (a transient handle - antivirus scanner, indexer - usually
 * causes this). Returning success would hide a stale copy of the previous content that
 * only a recovery tool can find, so the path travels on this error instead.
 */
export class OrphanedPublishedBackupError extends Error {
	readonly publishedPath: string
	readonly orphanedBackupPath: string
	readonly cleanupError: unknown

	constructor(targetPath: string, backupPath: string, cleanupError: unknown) {
		const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
		super(
			`safeWriteText: the content was published at ${targetPath}, but the pre-write copy at ${backupPath} ` +
				`could not be removed (${reason}). The copy is still on disk and should be removed by the caller or a recovery tool.`,
			{ cause: cleanupError },
		)
		this.name = "OrphanedPublishedBackupError"
		this.publishedPath = targetPath
		this.orphanedBackupPath = backupPath
		this.cleanupError = cleanupError
	}
}

/**
 * A write that is already failing left its complete backup copy on disk because removing it
 * failed twice. Reported separately from OrphanedPublishedBackupError, which says the write
 * SUCCEEDED and only the copy is leftover: here the write's own failure is the primary fact
 * and is kept as originalError (and as this error's cause), cleanupError says why the copy is
 * still there, and contentPublished says which of the two meanings the leftover has - a stale
 * copy beside published content, or a duplicate of the content the target still holds.
 */
export class OrphanedBackupAfterFailedWriteError extends Error {
	readonly targetPath: string
	readonly orphanedBackupPath: string
	readonly originalError: unknown
	readonly cleanupError: unknown
	readonly contentPublished: boolean

	constructor(
		targetPath: string,
		backupPath: string,
		cause: unknown,
		cleanupError: unknown,
		contentPublished: boolean,
	) {
		const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
		super(
			`safeWriteText: the write to ${targetPath} failed (${reason(cause)}), and the backup copy at ${backupPath} ` +
				`could not be removed (${reason(cleanupError)}). The copy of the previous content is still on disk; ` +
				(contentPublished
					? `the target holds the new content, so the copy is stale and must be removed.`
					: `the target still holds the previous content, so the copy duplicates it and must be removed.`),
			{ cause },
		)
		this.name = "OrphanedBackupAfterFailedWriteError"
		this.targetPath = targetPath
		this.orphanedBackupPath = backupPath
		this.originalError = cause
		this.cleanupError = cleanupError
		this.contentPublished = contentPublished
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

	constructor(targetPath: string, cause: unknown, copiedTargetFsync = false) {
		super(
			copiedTargetFsync
				? "The exclusive copy committed but the copied target could not be fsynced -- the content is at the target path reported on this error, and it may not survive a crash on a volume without hard links."
				: "The rename committed but the parent directory could not be fsynced -- the content is at the target path reported on this error, and the directory entry may not be durable.",
			{ cause },
		)
		this.name = "PostCommitDurabilityError"
		this.targetPath = targetPath
	}
}

/**
 * The target exists but its access rights could not be inspected or saved, so publishing would
 * replace it with a file that inherits different rights. On Windows the publish is refused before
 * anything is committed: a save that silently widened who can read the file is not a save the
 * caller can trust, and nothing has been published yet, so the target still holds its content.
 * causeError carries the platform failure behind the refusal - the access check
 * error or the icacls error - so a caller can tell a command that ran and refused
 * from one that could not be started at all; it is the runner's own error, not a
 * summary of it.
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
 * A conditional create (failIfExist) found a target at commit time. The write is
 * refused without touching it: whatever is at the path was created by someone else
 * and stays exactly as it is.
 */
export class TargetExistsError extends Error {
	readonly targetPath: string
	constructor(targetPath: string) {
		super(`A file already exists at ${targetPath} -- the no-replace commit refused it.`)
		this.name = "TargetExistsError"
		this.targetPath = targetPath
	}
}

/**
 * A conditional create (failIfExist) found that the volume hosting the target has
 * no atomic no-replace primitive: link(2) reported that hard links do not exist
 * here, and publishing by copy would put bytes at the final name that readers can
 * observe mid-copy. Nothing is published - the write fails closed so a retry on a
 * capable volume (or a caller that accepts non-atomic publication) decides.
 */
export class UnsupportedFilesystemError extends Error {
	readonly targetPath: string
	constructor(targetPath: string, cause: unknown) {
		super(
			`Filesystem hosting ${targetPath} has no atomic no-replace commit primitive -- the guarded create refused to publish by copy.`,
			{ cause },
		)
		this.name = "UnsupportedFilesystemError"
		this.targetPath = targetPath
	}
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
/**
 * The caller cancelled this write at the commit gate. Nothing was published: the target holds what it
 * held before the call, and this write's staging file is removed by the same cleanup that handles every
 * other failure.
 */
export class PublishCancelledError extends Error {
	readonly targetPath: string

	constructor(targetPath: string) {
		super(`The write to ${targetPath} was cancelled before the commit -- nothing was published.`)
		this.name = "PublishCancelledError"
		this.targetPath = targetPath
	}
}

// -- helpers ---------------------------------------------------------------

/** fsync one directory so the entry it holds (a rename, or a newly created child) is durable. */
function _syncDirectory(dir: string): void {
	const dirFd = fsSync.openSync(dir, "r")
	try {
		fsSync.fsyncSync(dirFd)
	} finally {
		fsSync.closeSync(dirFd)
	}
}

/** Where the caller said a directory was, taken from the pins it handed in. */
type AuthorizedLocation = { dir: string; location: string; identityBacked: boolean }

function _authorizedAncestorLocations(options?: SafeWriteTextOptions): AuthorizedLocation[] {
	const locations: AuthorizedLocation[] = []
	for (const identity of options?.expectedAncestorIdentities ?? []) {
		locations.push({
			dir: path.resolve(identity.dir),
			location: path.resolve(identity.resolvedPath ?? identity.dir),
			identityBacked: true,
		})
	}
	if (options?.expectedResolvedPath) {
		const pinnedDir = path.dirname(path.resolve(options.expectedResolvedPath))
		locations.push({ dir: pinnedDir, location: pinnedDir, identityBacked: false })
	}
	return locations
}

/** True when *target* is *dir* itself or under it on the same spelling. */
function _isInside(dir: string, target: string): boolean {
	const rel = path.relative(dir, target)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** The deepest pinned location that contains *target*, if the caller pinned one. */
function _deepestAuthorizedLocation(locations: AuthorizedLocation[], target: string): AuthorizedLocation | undefined {
	let deepest: AuthorizedLocation | undefined
	for (const candidate of locations) {
		if (
			_isInside(candidate.location, target) &&
			(!deepest || candidate.location.length > deepest.location.length)
		) {
			deepest = candidate
		}
	}
	return deepest
}

/** Re-apply the target's group to the staging descriptor before publication.
 *
 * The commit publishes this inode, so whatever the staging file carries when the descriptor closes is
 * what the target gets afterwards. The mode is re-applied with fchmodSync above; the group is the other
 * half of what a shared workspace's read access lives on, and nothing carried it. -1 leaves the owner
 * alone.
 *
 * Best-effort on purpose. Measured on Windows the call reports success and changes nothing (the gid
 * stays 0 after asking for another group), and on POSIX a caller allowed to write a file is not always
 * a caller allowed to change its group, so failing here would refuse writes this user may make. The
 * attempt is the contract; the effect is platform-owned. */
function _preserveGroup(fd: number, gid: number): void {
	try {
		fsSync.fchownSync(fd, -1, gid)
	} catch {
		// A group this user cannot take is carried by the mode copy and the ACL path, not by failing the write.
	}
}

/**
 * The directories *mkdir(recursive:true)* had to create for *dirPath*, outermost first.
 *
 * Node reports the outermost component it created - or nothing when the path already existed -
 * and that answer is the whole input, so no extra stat is needed to learn what appeared. The
 * commit rename only makes the entry INSIDE the immediate parent durable, and every newly
 * created directory is itself an entry in its own parent, so step 4b fsyncs this chain (deepest
 * first, after the immediate parent) and then the directory that first links it into the tree;
 * otherwise a crash can drop an ancestor and with it the published file.
 *
 * On Windows the reported path carries the extended-length namespace marker, which is stripped
 * so the chain compares in the spelling the write itself works in. The marker has two shapes: the
 * drive shape \\\?C:\... and the UNC shape \\\?UNC\server\share\...,
 * whose root is spelled \\server\share\... once the marker is gone. Removing only the marker
 * characters from the UNC shape leaves \UNC\server\share\..., which reads as a path relative
 * to the current drive, so the walk below finds no root and yields nothing: the created-directory
 * authorization that reads this answer is skipped with it, and a directory this write created
 * under a planted link goes unchecked. The UNC shape is therefore converted as its own case. An
 * answer that is not on this path yields nothing, rather than syncing directories this write
 * cannot place.
 */
function _createdAncestorChain(createdRoot: string | undefined, dirPath: string): string[] {
	if (typeof createdRoot !== "string") return []
	const namespacePrefix = "\\\\?\\"
	const uncNamespacePrefix = "\\\\?\\UNC\\"
	let unprefixed = createdRoot
	if (createdRoot.startsWith(uncNamespacePrefix)) {
		// The marker and the "UNC" label together stand for the leading \\, so the
		// converted spelling restores that root instead of leaving the label as a relative
		// first segment.
		unprefixed = "\\\\" + createdRoot.slice(uncNamespacePrefix.length)
	} else if (createdRoot.startsWith(namespacePrefix)) {
		unprefixed = createdRoot.slice(namespacePrefix.length)
	}
	const root = path.resolve(unprefixed)
	const chain: string[] = []
	let cursor = dirPath
	for (;;) {
		chain.push(cursor)
		if (cursor === root) return chain.reverse()
		const parent = path.dirname(cursor)
		if (parent === cursor) return []
		cursor = parent
	}
}

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

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns null when the dump was written - the caller keeps it and restores it onto the
 * committed file at step 5 - and returns the runner's error when it was not, because the
 * caller refuses the publish in that case and has to be able to say which failure it is
 * refusing: "icacls ran and failed" and "icacls could not be started at all" are different
 * facts to act on. Never throws. */
async function _saveDaclWindows(srcPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<unknown> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [srcPath, "/save", dumpPath, "/T"], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return null
	} catch (error: unknown) {
		return error
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
		if (getErrorCode(error) !== "ENOENT") throw error
		// ENOENT also covers a dangling symlink, which must never be written through.
		// Only a lstat that also reports the path as absent may fall back to the
		// given path; a real lstat failure (EACCES, EIO) says nothing about whether
		// the path is a link, so falling back would write through a link we were
		// simply not allowed to inspect.
		const linkStat = await fs.lstat(absoluteFilePath).catch((lstatError: unknown) => {
			if (getErrorCode(lstatError) === "ENOENT") return undefined
			throw lstatError
		})
		if (linkStat?.isSymbolicLink()) throw error
		return await canonicalizeNearestAncestor(absoluteFilePath)
	})
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
			if (getErrorCode(error) === "ENOENT") return undefined
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
 * Canonicalize the nearest EXISTING ancestor and re-append the missing components.
 * The guard hands back a pin produced exactly this way (guardedWrite#realpathNearest),
 * so an absent target has to resolve identically here: a lexical fallback differs from
 * that pin whenever an ancestor is a symlink, and the create would then abort with
 * TargetMovedError even though nothing moved.
 */
async function canonicalizeNearestAncestor(absoluteFilePath: string): Promise<string> {
	const missing: string[] = []
	let cursor = absoluteFilePath
	for (;;) {
		try {
			const realPath = await fs.realpath(cursor)
			return missing.length > 0 ? path.join(realPath, ...missing.reverse()) : realPath
		} catch (error: unknown) {
			const code = getErrorCode(error)
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				// A real inspection failure (EACCES, EIO) says nothing about the path's
				// identity. Returning a lexical key here would silently canonicalize a
				// different path than the guard's pin, so fail closed instead.
				throw error
			}
			const parent = path.dirname(cursor)
			if (parent === cursor) return absoluteFilePath
			missing.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Lock key for a publish target: the symlink referent when the path is an
 * existing symlink, the path itself otherwise. Unlike resolvePublishTarget this
 * tolerates a dangling link, because the lock key has to be computable while a
 * peer writer is mid-commit (backup mode renames the referent away and back).
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

	// The caller authorized a specific resolved path; publishing at a different one
	// would act on a decision that was never made about this file.
	if (options?.expectedResolvedPath && path.resolve(options.expectedResolvedPath) !== targetPath) {
		throw new TargetMovedError(options.expectedResolvedPath, targetPath)
	}

	const dirPath = path.dirname(targetPath)

	// Ensure parent directory exists (mirrors safeWriteJson behaviour). What mkdir reports it
	// created feeds step 4b's fsync of the ancestors this write introduced; see
	// _createdAncestorChain.
	const createdAncestors = _createdAncestorChain(await fs.mkdir(dirPath, { recursive: true }), dirPath)
	await fs.access(dirPath)

	// What mkdir reports it created is a fact about the filesystem, not about the decision the
	// caller made: the chain above is sampled from that report, after the fact. A directory the
	// caller never walked - because it was not there when the caller authorized - can be a link
	// by the time mkdir reaches it, so the parent this write created sits outside the authorized
	// chain while still being reported as this write's parent, and the fsync chain alone would
	// then sync and publish through it. Compare each created directory with the deepest location
	// the caller pinned; a created directory under nothing the caller pinned has left the
	// authorized chain by construction. A caller that pinned no location has nothing to compare
	// against and keeps its current behaviour.
	if (createdAncestors.length > 0) {
		const authorized = _authorizedAncestorLocations(options)
		if (authorized.length > 0) {
			for (const created of createdAncestors) {
				const createdReal = await fs.realpath(created).catch((error: unknown) => {
					const code = getErrorCode(error)
					// A name that vanished since the mkdir is reported by the ancestry recheck below, which
					// also knows whether the caller authorized that name; only a real inspection failure is
					// this write's to report here.
					if (code === "ENOENT" || code === "ENOTDIR") {
						return undefined
					}
					throw error
				})
				const pinned = _deepestAuthorizedLocation(authorized, createdReal ?? created)
				if (pinned === undefined) {
					throw new AncestorReplacedError(created, "was created under nothing the caller authorized")
				}
				if (createdReal !== undefined && !_isInside(pinned.location, createdReal)) {
					throw new AncestorReplacedError(created, "was created outside the authorized location")
				}
			}
		}
	} else {
		// Nothing was created, which is what Node 22 reports when the final directory was already
		// there -- including when it is a symbolic link to a directory, because the stat that follows
		// the create succeeds and names no first created path. No chain means the loop above never
		// ran, yet the parent this write publishes into can still have become a link after the caller
		// authorized it: /ws/a pinned, /ws/a/new absent while the target was resolved, the name
		// planted as a link to /outside before the mkdir, and the access check above follows that link
		// and passes. The effective parent is checked the way the created chain is checked, so a
		// parent that resolves under nothing the caller pinned is refused before anything is staged.
		const authorized = _authorizedAncestorLocations(options)
		// A parent the caller named by identity belongs to the ancestry recheck below: that check
		// holds the (dev, ino) pair and the resolution the caller authorized against, and it reports
		// a moved or re-pointed pin in those terms. A pin built from expectedResolvedPath carries no
		// identity, so that recheck has nothing to compare for it and this branch must judge the
		// parent it names: only identity-backed pins count as named here.
		const resolvedParent = path.resolve(dirPath)
		const namedByCaller = authorized.some((pin) => pin.identityBacked && pin.dir === resolvedParent)
		if (authorized.length > 0 && !namedByCaller) {
			const parentReal = await fs.realpath(dirPath).catch((error: unknown) => {
				const code = getErrorCode(error)
				// A parent that vanished since the mkdir is reported by the ancestry recheck below, which
				// knows whether the caller authorized that name; only a real inspection failure is this
				// write's to report here.
				if (code === "ENOENT" || code === "ENOTDIR") {
					return undefined
				}
				throw error
			})
			const pinned = _deepestAuthorizedLocation(authorized, parentReal ?? dirPath)
			if (pinned === undefined) {
				throw new AncestorReplacedError(dirPath, "resolves under nothing the caller authorized")
			}
			if (parentReal !== undefined && !_isInside(pinned.location, parentReal)) {
				throw new AncestorReplacedError(dirPath, "resolves outside the authorized location")
			}
		}
	}

	// Create the staging directory only when we generate the temp file there;
	// callers supplying their own tempPath (e.g. safeWriteJson) must not be left
	// with an empty .file-safety-staging directory behind. Track the directory this
	// write created so its cleanup removes its own directory, not a shared one.
	let stagingDir: string | null = null
	let tempPath: string
	// Whether the commit rename has consumed the staging file. Cleanup is allowed to unlink
	// the staging path only while this write still owns it: after the rename the name belongs to
	// whatever is filed under it next, and a caller-supplied staging name is reused by the next
	// write to the same target.
	let stagingCommitted = false
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
			if (getErrorCode(error) !== "ENOENT") {
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
	// True only when this write's own seed open created the backup file. A name that already
	// existed is not this write's file, and the failure path below must not unlink it.
	let backupSeeded = false
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
			let targetGid: number | undefined
			let targetExists = false
			try {
				const targetStats = fsSync.statSync(targetPath)
				targetMode = targetStats.mode & 0o777
				// The commit publishes this inode, so the group the target belongs to has to be carried onto
				// the staging descriptor or the published file lands in whichever group this process runs in.
				// A double that reports no gid reports no group to carry.
				targetGid = typeof targetStats.gid === "number" ? targetStats.gid : undefined
				targetExists = true
			} catch (error: unknown) {
				if (getErrorCode(error) !== "ENOENT") throw error
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
					if (targetGid !== undefined) {
						_preserveGroup(fd, targetGid)
					}
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				// A zero return is not a short write - it means the descriptor made no progress -
				// and it is handled below rather than looped on.
				let offset = 0
				while (offset < buffer.length) {
					const written = fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
					if (written === 0) {
						// Not a short write: the descriptor made no progress at all, so looping again
						// would hold the fd and the event loop forever without ever reaching fsyncSync
						// or the commit. The finally below closes the fd and the outer cleanup removes
						// the staged file, so a stalled write strands neither.
						throw new Error(
							`safeWriteText: write of ${tempPath} stalled after ${offset} of ${buffer.length} bytes`,
						)
					}
					offset += written
				}
				fsSync.fsyncSync(fd)
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
			let targetGid: number | undefined
			try {
				const targetStats = fsSync.statSync(targetPath)
				targetMode = targetStats.mode & 0o777
				targetGid = typeof targetStats.gid === "number" ? targetStats.gid : undefined
			} catch (error: unknown) {
				if (getErrorCode(error) !== "ENOENT") throw error
				// target does not exist yet - keep the temp's default mode
			}
			const fd = fsSync.openSync(tempPath, "r+")
			try {
				if (targetMode !== null) {
					fsSync.fchmodSync(fd, targetMode)
					if (targetGid !== undefined) {
						_preserveGroup(fd, targetGid)
					}
				}
				fsSync.fsyncSync(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		}

		// -- Step 2 (win32): save DACL BEFORE backup rename ---------------
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
				const saveFailure = await _saveDaclWindows(targetPath, dumpPath, options?.execFileRunner)
				if (saveFailure === null) {
					// Only a successfully saved dump may be restored onto the
					// committed file (step 5).
					daclDumpPath = dumpPath
				} else {
					// A failed icacls may have left a partial dump behind;
					// remove it now (best-effort) so no partial dump survives and
					// no later step can restore from it.
					await fs.unlink(dumpPath).catch(() => {})
					// The target exists and its DACL could not be captured, so the commit rename
					// would replace it with a file that inherits different access rights, and nothing
					// here can verify an equivalent restrictive ACL on that replacement. The publish is
					// refused instead of warned about: a save that silently changed who can read the
					// file is not a save the caller can trust. Nothing is committed yet, so the target
					// still holds its content, and this throw lands in the handler at the bottom of
					// this try - the one place that removes the staged file and this write's own
					// staging directory - so a refused publish strands neither.
					// The runner's error travels with the refusal: the phase already says which check
					// refused, and without the error a caller cannot tell a failed icacls from an
					// icacls that could not be started at all.
					throw new DaclInspectionError(targetPath, "save", saveFailure)
				}
			} else if (getErrorCode(accessError) !== "ENOENT") {
				// Not "absent": the target is there but its access rights could not be read
				// (EACCES, ...), so publishing would replace a file whose rights this call never
				// learned. Same rule as the failed save above: refuse before anything is committed.
				throw new DaclInspectionError(targetPath, "inspect", accessError)
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
						if (getErrorCode(error) === "ENOENT") {
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
						const code = getErrorCode(error)
						if (code === "ENOENT" || code === "ENOTDIR") {
							return undefined
						}
						throw error
					})
					// The location the caller authorized. A recorded resolvedPath is the spelling the
					// caller walked - an alias ancestor resolves to something else by definition, and a
					// stable alias must pass here; the (dev, ino) check above is what catches the alias
					// being re-pointed. Without a resolvedPath the authorized name is the lexical dir.
					const authorizedLocation = expected.resolvedPath
						? path.resolve(expected.resolvedPath)
						: path.resolve(expected.dir)
					if (resolvedDir === undefined || path.resolve(resolvedDir) !== authorizedLocation) {
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
						// The name is ours from the moment the exclusive open succeeds, so the failure
						// path may remove it even when the close below reports an error.
						backupSeeded = true
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
							fsSync.fsyncSync(backupFd)
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
						if (backupSeeded) {
							for (let attempt = 0; attempt < 2; attempt++) {
								try {
									await fs.unlink(orphanPath)
									backupCleanupError = null
									break
								} catch (cleanupError: unknown) {
									if (getErrorCode(cleanupError) === "ENOENT") {
										// Already gone: that is exactly the outcome the cleanup wanted, so stop
										// rather than unlinking the same path a second time.
										backupCleanupError = null
										break
									}
									backupCleanupError = cleanupError
								}
							}
						}
						backupPath = null
						// When the seed open never succeeded - an EEXIST on a name another writer owns, or a
						// failure before anything existed at it - there is nothing here to remove: an entry
						// this write did not create is not this write's orphan, and unlinking it would take
						// away somebody else's backup on the way out. backupCleanupError stays null, so the
						// original failure below is what the caller sees.
						if (backupCleanupError !== null) {
							throw new OrphanedBackupError(orphanPath, targetPath, backupError, backupCleanupError)
						}
						throw backupError
					}
					releaseBackupOnSuccess = true
				} catch (err: unknown) {
					if (getErrorCode(err) !== "ENOENT") throw err
				}
			}

			// -- Commit gate: a cancelled write publishes nothing -------------------
			// Every step above is awaited, so an abort that arrived at any of them is visible here, and
			// this is the last point where publishing can still be refused: the commit below is a
			// synchronous rename with no await left between here and it.
			if (options?.signal?.aborted) {
				throw new PublishCancelledError(targetPath)
			}

			// -- Step 4: atomic commit temp -> target ---------------------
			if (options?.failIfExist) {
				// No-replace commit: link(2) fails EEXIST when the name already exists,
				// where a rename would silently displace whatever a non-participating
				// writer put there after the caller checked. The staged copy is removed
				// once the name points at it.
				try {
					await fs.link(tempPath, targetPath)
				} catch (error: unknown) {
					const code = getErrorCode(error)
					if (code === "EEXIST") {
						throw new TargetExistsError(targetPath)
					}
					// FAT32/exFAT volumes and some SMB/network mounts have no hard links, where
					// link(2) fails EPERM/ENOTSUP/ENOSYS. The fallback this replaces published by
					// an exclusive copy directly at the final name, but a copy is not atomic:
					// readers can observe a partial file, and a crash or an EIO mid-copy leaves
					// damaged bytes under the final name with the 'already exists' verdict on
					// retry. No atomic no-replace primitive exists on those volumes, so the
					// guarded create fails closed - nothing is published and the caller learns
					// the volume cannot honor the contract.
					if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") {
						throw error
					}
					throw new UnsupportedFilesystemError(targetPath, error)
				}
			} else {
				await fs.rename(tempPath, targetPath)
			}

			if (options?.failIfExist) {
				// The target name is published at this point; the staged name is only a second
				// link to the same inode (or a copy of it). Removal is best-effort: on Windows
				// an antivirus handle can make unlink fail with EBUSY/EPERM after the content
				// is already visible, and the write must not be reported as failed for content
				// the caller can now read back.
				await fs.unlink(tempPath).catch(() => undefined)
			}

			// Marked once the commit has consumed the staging name: on the rename path the
			// rename consumed it, on the link path the removal just did. Every step after
			// this one is a post-commit step, and none of them may remove the staging path
			// or the published content.
			stagingCommitted = true
			// -- Step 4b (POSIX): fsync the parent directory so the directory entry
			// changed by the commit rename is durable, not just the file content.
			if (platform !== "win32") {
				try {
					_syncDirectory(dirPath)
					// The rename above made the entry INSIDE dirPath durable. A parent this call had to
					// create is itself an entry in its own parent, so syncing only the immediate parent
					// leaves the newer ancestors unsynced and a crash can remove the chain - taking the
					// published file with it. Sync deepest-first, ending with the pre-existing directory
					// that holds the outermost new entry.
					for (let i = createdAncestors.length - 2; i >= 0; i--) {
						_syncDirectory(createdAncestors[i])
					}
					if (createdAncestors.length > 0) {
						_syncDirectory(path.dirname(createdAncestors[0]))
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
				await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
			}

			// -- Step 6 (backup:true): delete backup on success -----------
			if (releaseBackupOnSuccess && backupPath) {
				const orphanedBackupPath = backupPath
				let backupCleanupError: unknown = null
				// A transient handle (antivirus scanner, indexer) can block the first unlink
				// on Windows; one retry usually clears it.
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						await fs.unlink(orphanedBackupPath)
						backupCleanupError = null
						break
					} catch (cleanupError: unknown) {
						if (getErrorCode(cleanupError) === "ENOENT") {
							backupCleanupError = null
							break
						}
						backupCleanupError = cleanupError
					}
				}
				backupPath = null
				if (backupCleanupError !== null) {
					// The content is published: reporting success here would abandon a stale
					// copy of the previous content, so the failure travels as its own error.
					throw new OrphanedPublishedBackupError(targetPath, orphanedBackupPath, backupCleanupError)
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
		// The backup is a copy, never a restore source: whether the failure happened before
		// or after the commit rename, the copy is removed below so no stale duplicate of the
		// previous content survives next to the target.
		// Set when a backup copy this write made could not be removed; reported at the end of
		// this catch so the staging cleanup above is not skipped for a cleanup failure.
		let pendingBackupError: OrphanedBackupAfterFailedWriteError | null = null
		if (backupPath && releaseBackupOnSuccess) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there - before the commit that is the pre-write content, and
			// after it the published content. Either way the copy has served its purpose
			// and must not be left beside the target where no caller can find it.
			let removalError: unknown = null
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await fs.unlink(backupPath)
					removalError = null
					break
				} catch (error: unknown) {
					if (getErrorCode(error) === "ENOENT") {
						// Already gone: that is exactly the outcome this cleanup wanted.
						removalError = null
						break
					}
					// Retry once: Windows reports EPERM for a file whose handle has not been
					// released yet, which is the same failure the success-path cleanup retries.
					removalError = error
				}
			}
			if (removalError !== null) {
				// The copy of the previous content is still on disk and only this function knew
				// where. Reporting it is what keeps the original error the primary fact while
				// leaving the leftover findable; swallowing the removal left both unreported.
				// Constructed, not thrown yet: the staging cleanup below has to run first, so
				// the leftover is reported once this catch has finished what it can do about the
				// write's own mess.
				pendingBackupError = new OrphanedBackupAfterFailedWriteError(
					targetPath,
					backupPath,
					originalError,
					removalError,
					stagingCommitted,
				)
			}
			backupPath = null
		}
		if (!stagingCommitted) {
			try {
				await fs.unlink(tempPath).catch(() => {})
			} catch {
				// cleanup failure is non-fatal
			}
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

		if (pendingBackupError) {
			// The write's own failure is still the primary fact - it travels on this error as
			// originalError and as its cause - and the copy of the previous content now has a
			// path a caller can act on instead of being unreported.
			throw pendingBackupError
		}
		throw originalError
	}
}
