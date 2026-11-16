import * as fs from "fs/promises"
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
	/**
	 * The old-content copy this path retains for recovery, or null when backup mode was off
	 * or no copy was taken. The name is a hidden random path, so without this field no caller
	 * could find the copy the failure cleanup deliberately keeps.
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

/**
 * The staging entry this write validated, wrote and fsynced was found to name another
 * file at the commit. The commit rename publishes whatever the staging name holds the
 * moment it runs, so a peer that replaced the entry between validation and publication
 * would otherwise have its own content committed onto the target while this write
 * reported success. Reported as its own error so a failed write cannot claim a publish
 * it did not make.
 */
export class StagingReplacedError extends Error {
	readonly stagingPath: string
	/** Where it was noticed: before anything was published, or after the commit rename landed. */
	readonly stage: "before-commit" | "after-commit"
	/** The path the publish was aimed at. The staging name is a random path this module invented, so a caller that has to say which file it was saving cannot derive it from the staging path. */
	readonly targetPath: string
	/**
	 * The copy of the previous content this failure leaves behind, or null when it leaves none:
	 * backup mode off, no target before the write, or a before-commit failure whose handler
	 * deletes the redundant copy. The name is a hidden random path, so without this field the
	 * retained copy sat where no caller could find it - the same reason PostCommitDurabilityError
	 * carries it.
	 */
	readonly backupPath: string | null

	constructor(
		stagingPath: string,
		stage: "before-commit" | "after-commit",
		targetPath: string,
		backupPath: string | null = null,
	) {
		super(
			stage === "before-commit"
				? `Staging entry ${stagingPath} no longer names the file this write staged; the commit rename was skipped and the target was left as it was.`
				: `Staging entry ${stagingPath} was replaced before the commit rename landed; the target now holds a file this write did not stage.`,
		)
		this.name = "StagingReplacedError"
		this.stagingPath = stagingPath
		this.stage = stage
		this.targetPath = targetPath
		this.backupPath = backupPath
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

/**
 * How far resolveLockKey follows a chain of links. 40 is where Node's own resolver gives up
 * with ELOOP, so every chain the operating system is willing to resolve is a chain this walk
 * resolves too; a smaller bound stops at an intermediate link of a long chain, and the writer
 * that stopped there queues on a different lock from the writer standing at the referent - the
 * two-locks-for-one-file case canonicalDirKey exists to prevent.
 */
const MAX_SYMLINK_HOPS = 40


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
		const linkWalkLimit = MAX_SYMLINK_HOPS
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
 * alternative is blanking this whole module in knip.json.
 *
 * @internal
 */
