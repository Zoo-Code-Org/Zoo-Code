import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as os from "os"
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
	 * Publish onto the requested path itself instead of onto the referent of a symlink found
	 * there.
	 *
	 * Following a link is only safe once somebody has decided that the referent is an
	 * acceptable destination - by declaring a confinement scope, or by checking the resolved path
	 * some other way. A caller that did neither must keep the rename-over-link behavior: a link
	 * planted inside the workspace would otherwise move the write to a file outside it, and the
	 * caller would never learn that its bytes landed somewhere else.
	 */
	publishOverLink?: boolean
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
 * Thrown when the DACL of an EXISTING Windows target could not be captured, so the commit
 * rename would replace a file whose access rights are unknown with one that inherits whatever
 * the destination directory grants. The write is refused before anything is committed: the
 * alternative - publishing and warning - silently changes who can read a file the user could
 * read before, which is a security boundary rather than a cosmetic difference.
 */
export class DaclCaptureError extends Error {
	readonly targetPath: string

	constructor(targetPath: string, cause?: unknown) {
		super(
			"Refusing to publish over the existing target: its DACL could not be captured, so the replacement would change the file's access rights without knowing what they were. The target is unchanged; the path is reported here.",
			{ cause },
		)
		this.name = "DaclCaptureError"
		this.targetPath = targetPath
	}
}

/**
 * Thrown when the saved DACL could not be restored onto the committed file AND the restrictive
 * fallback (drop inherited ACEs, grant the current user sole full control) could not be applied
 * and verified. The committed bytes are rolled back onto the retained backup first, so a
 * rejection never leaves content at the target that nobody authorized an ACL for.
 */
export class DaclRestoreError extends Error {
	readonly targetPath: string

	constructor(targetPath: string, cause?: unknown) {
		super(
			"The saved DACL could not be restored onto the committed file and the restrictive fallback could not be verified; the previous content was rolled back onto the backup rather than published under an unknown ACL.",
			{ cause },
		)
		this.name = "DaclRestoreError"
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

/**
 * Release a descriptor this call still owns, meaning one whose close has not been attempted yet.
 * A close that has already been attempted is never retried: the first close(2) may have released
 * the descriptor even while reporting an error, and closing the same number again can then release
 * a descriptor a concurrent open has meanwhile been handed. Such a failure is logged where it
 * happens instead. This helper only reports its own failure, so it can never replace the error a
 * failed write is about to throw.
 */
function _closeDescriptor(fd: number, label: string): void {
	try {
		fsSync.closeSync(fd)
	} catch (error: unknown) {
		console.error(`Failed to close the ${label}:`, error)
	}
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

/**
 * Decide whether an `icacls <file>` report describes a DACL narrowed to one principal.
 *
 * The report is a header line naming the file followed by one line per access-control entry, e.g.
 * "NT AUTHORITY\\SY:\\Users:(RX)" or "DESKTOP\\bob:(I)(F)". Entries are taken from the lines after
 * the header, so the path - which usually contains the user's own name - can never satisfy the
 * check on its own. An entry is accepted only when it carries no "(I)" inherited component and its
 * principal is exactly the identity the narrowing granted, compared as a whole name.
 */
/**
 * The principal names icacls can report for the account the narrowing granted. The grant names a
 * bare account name and icacls reports it qualified - with the domain for a domain account, with
 * the machine name for a local one - so each qualified form is compared in full. Windows account
 * names are case-insensitive, hence the lowercasing. Nothing matches on a prefix or a suffix: a
 * principal can contain spaces, and "OTHERDOMAIN\bob" ends with "\bob" while granting a different
 * account than the local "bob".
 */
function _expectedAcePrincipals(identity: string): string[] {
	const expected = [identity.toLowerCase()]
	// The two environment values name the authority the account is qualified against: COMPUTERNAME
	// is the machine a local account belongs to, USERDOMAIN the domain of a domain account. Both are
	// read at call time so a process that changed them is not compared against a stale name.
	const prefixes = [process.env.COMPUTERNAME ?? "", process.env.USERDOMAIN ?? ""]
	for (const prefix of prefixes) {
		if (prefix !== "") {
			expected.push(`${prefix}\\${identity}`.toLowerCase())
		}
	}
	return expected
}
function _aclEntriesAreNarrowedTo(report: string, identity: string): boolean {
	// Every "principal:(flags)" pair in the report is an entry; the file path that icacls prints
	// ahead of the first entry is stripped below so it cannot satisfy the check by containing the
	// user's name.
	const pattern = /([^:()]+):\(([^()]*)\)/g
	const expectedPrincipals = _expectedAcePrincipals(identity)
	let count = 0
	for (const match of report.matchAll(pattern)) {
		let principal = match[1].trim()
		// The first entry shares its line with the path. Only a leading token that looks like a
		// path is dropped: a principal such as "NT AUTHORITY\\SYSTEM" legitimately contains a space
		// and must survive intact.
		const parts = principal.split(/\s+/)
		if (parts.length > 1 && /^[A-Za-z]:[\\/]|^[\\/]/.test(parts[0])) {
			principal = parts.slice(1).join(" ").trim()
		}
		const flags = match[2]
		if (flags.includes("(I)")) {
			return false
		}
		if (!expectedPrincipals.includes(principal.toLowerCase())) {
			return false
		}
		count++
	}
	return count > 0
}

/**
 * Narrow a file's DACL to a single explicit grant for the current user, then verify it by
 * reading the DACL back. Used when the saved DACL could not be reapplied: the row's alternative
 * to failing is to publish under an ACL that is known to be restrictive, and "known" means
 * read back - icacls reports an inherited ACE with an (I) flag, so a verified narrowing shows
 * the grant and no inherited entry.
 */
async function _restrictDaclWindows(
	filePath: string,
	execFileRunner?: typeof execFile,
	identity: string = os.userInfo().username,
): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	const applied = await new Promise<boolean>((resolve) => {
		runner("icacls", [filePath, "/inheritance:r", "/grant:r", `${identity}:F`], { windowsHide: true }, (err) =>
			resolve(!err),
		)
	})
	if (!applied) {
		return false
	}
	const readBack = await new Promise<string | null>((resolve) => {
		runner("icacls", [filePath], { windowsHide: true }, (err, stdout) => (err ? resolve(null) : resolve(stdout ?? "")))
	})
	if (readBack === null) {
		return false
	}
	// Verification reads the access-control entries, not the whole output: icacls prints the file
	// path first, and a workspace path normally contains the user's name (C:\Users\<user>\...),
	// so a substring match would pass on a file that grants that user nothing. Every entry must be
	// an explicit grant to the current user with no inherited component, which is the only state
	// this helper claims to have verified.
	return _aclEntriesAreNarrowedTo(readBack, identity)
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

	// Resolve the symlink referent (see resolvePublishTarget), unless the caller asked to
	// replace the link instead of writing through it. The link is then the target, so a referent
	// outside the caller's view cannot receive these bytes.
	const targetPath = options?.publishOverLink ? absoluteFilePath : await resolvePublishTarget(absoluteFilePath)
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
			// Ownership of the descriptor follows the backup seed's model: it is released
			// inside the try, and only a close that is still owed is retried through
			// _closeDescriptor in the catch. A close that fails must not become the error this
			// write reports when the write itself already failed - the operation's own failure
			// is the one that explains what happened - and it must not be abandoned either.
			let stagingFd: number | undefined
			try {
				const handle = fsSync.openSync(tempPath, "w", targetMode)
				stagingFd = handle
				if (targetExists) {
					fsSync.fchmodSync(handle, targetMode)
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				let offset = 0
				while (offset < buffer.length) {
					offset += fsSync.writeSync(handle, buffer, offset, buffer.length - offset)
				}
				_fsyncFile(handle)
				// Ownership ends when the close is attempted, not when it succeeds.
				stagingFd = undefined
				try {
					fsSync.closeSync(handle)
				} catch (closeError: unknown) {
					console.error(`Failed to close the staging descriptor for ${tempPath}:`, closeError)
				}
			} catch (error: unknown) {
				if (stagingFd !== undefined) {
					_closeDescriptor(stagingFd, `staging descriptor for ${tempPath}`)
				}
				throw error
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
			// Same ownership model as the self-staged branch above: the close is retried and
			// reported through _closeDescriptor rather than replacing the write's own failure.
			let stagedFd: number | undefined
			try {
				const handle = fsSync.openSync(tempPath, "r+")
				stagedFd = handle
				if (targetMode !== null) {
					fsSync.fchmodSync(handle, targetMode)
				}
				_fsyncFile(handle)
				// Ownership ends when the close is attempted, not when it succeeds.
				stagedFd = undefined
				try {
					fsSync.closeSync(handle)
				} catch (closeError: unknown) {
					console.error(`Failed to close the staged temp descriptor for ${tempPath}:`, closeError)
				}
			} catch (error: unknown) {
				if (stagedFd !== undefined) {
					_closeDescriptor(stagedFd, `staged temp descriptor for ${tempPath}`)
				}
				throw error
			}
		}

		// -- Step 2 (win32): save DACL BEFORE the backup copy -----------
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
					// The target exists and its DACL could not be captured. Publishing anyway would
					// replace a file whose access rights are unknown with one that inherits whatever
					// the destination directory grants - a change in who can read the file, decided
					// silently by a helper that failed. The refusal happens BEFORE the commit rename,
					// so the target still holds its previous content under its previous ACL; the
					// staging file this write created is removed with the refusal.
					await fs.unlink(tempPath).catch(() => {})
					if (stagingDir) {
						await fs.rmdir(stagingDir).catch(() => {})
					}
					throw new DaclCaptureError(targetPath)
				}
			} else if (errorCode(accessError) !== "ENOENT") {
				// Not "absent": the target is there but could not be checked (EACCES, ...), so
				// DACL preservation was skipped for a reason the caller cannot infer from the
				// successful write alone.
				warn(`Could not check ${targetPath} for DACL preservation (${errorCode(accessError) ?? "unknown error"}); the replacement may inherit different access rights.`)
			}
		}
		try {
			// -- Step 3 (backup:true, or any win32 publish that captured a DACL): durable copy ----
			// A caller that asked for no backup still gets a private copy whenever step 2 saved a
			// DACL dump, because step 5's only safe failure mode is a rollback onto the pre-write
			// content: without it, a DACL that could be neither restored nor narrowed would leave
			// new bytes at the target under an ACL nobody authorized - the exact condition the
			// security row refuses. The copy is unlinked on success, so a caller that did not ask
			// for a backup never sees one.
			if (options?.backup || daclDumpPath !== null) {
				try {
					await fs.access(targetPath)
					backupPath = _tempName(dirPath, "safeWriteText.bak")
					// Copy, never move. Renaming the target away leaves the canonical path absent for
					// the whole commit window: readers see a missing file, and a concurrent
					// writer can create a new target that a later rollback would destroy. A copy
					// keeps the target present, so the step 4 rename is the only change to the
					// canonical path. The copy is flushed so the retained content survives a crash.
					let seedFd: number | undefined
					let backupFd: number | undefined
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
						seedFd = fsSync.openSync(backupPath, "wx", 0o600)
						// Owned no longer the moment the close is attempted: a retried close could
						// release a descriptor somebody else has been handed in the meantime.
						const seedHandle = seedFd
						seedFd = undefined
						try {
							fsSync.closeSync(seedHandle)
						} catch (closeError: unknown) {
							console.error(`Failed to close the backup seed descriptor for ${backupPath}:`, closeError)
						}
						await fs.copyFile(targetPath, backupPath)
						await fs.chmod(backupPath, 0o600)
						// "r+" not "r": fsync on a read-only handle is EPERM on Windows, and the same
						// flag the staged temp file uses above.
						backupFd = fsSync.openSync(backupPath, "r+")
						_fsyncFile(backupFd)
						// Same rule for the backup's fsync descriptor.
						const backupHandle = backupFd
						backupFd = undefined
						try {
							fsSync.closeSync(backupHandle)
						} catch (closeError: unknown) {
							console.error(`Failed to close the backup fsync descriptor for ${backupPath}:`, closeError)
						}
					} catch (backupError: unknown) {
						if (seedFd !== undefined) {
							// The seed descriptor is still owned here: its close failed, or an error landed
							// between the open and that close. Retry the release before reporting, and let a
							// second close failure be logged rather than replace the backup failure this
							// handler is about to rethrow.
							_closeDescriptor(seedFd, `backup seed descriptor for ${backupPath}`)
						}
						if (backupFd !== undefined) {
							// Same rule for the fsync descriptor of the backup copy.
							_closeDescriptor(backupFd, `backup fsync descriptor for ${backupPath}`)
						}
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

			// -- Step 4b (POSIX): fsync the parent directory so the directory entry
			// changed by the commit rename is durable, not just the file content.
			if (platform !== "win32") {
				let dirFd: number | undefined
				try {
					const handle = fsSync.openSync(dirPath, "r")
					dirFd = handle
					_fsyncFile(handle)
					// The question this block answers is whether the directory entry reached the
					// disk, which the fsync above has already answered. A close that fails after it
					// is therefore reported rather than turned into a durability failure, and it is
					// not retried: the descriptor is released as far as the kernel is concerned, and
					// a second close could release a number a concurrent open has been handed.
					dirFd = undefined
					try {
						fsSync.closeSync(handle)
					} catch (closeError: unknown) {
						console.error(`Failed to close the parent directory descriptor for ${dirPath}:`, closeError)
					}
				} catch (error: unknown) {
					if (dirFd !== undefined) {
						// Only an error that arrived before any close was attempted can still find
						// this descriptor owned - the fsync failing, for instance.
						_closeDescriptor(dirFd, `parent directory descriptor for ${dirPath}`)
					}
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
					// The saved ACEs could not be reapplied. On a plain temp directory that is the
					// normal outcome rather than the exception - measured on this host, icacls
					// /restore exits 1300 with "Not all privileges or groups referenced are assigned
					// to the caller" for every pairing - so failing here would break every publish.
					// The row's alternative is to publish under an ACL that is KNOWN to be
					// restrictive: drop the inherited entries, grant the current user sole full
					// control, and verify it by reading the DACL back.
					const narrowed = await _restrictDaclWindows(targetPath, options?.execFileRunner)
					if (!narrowed) {
						// Neither the original ACL nor a verified restrictive one could be put on the
						// committed file, so the bytes do not stay at the target under an unknown
						// ACL: the retained backup - the pre-write content - is renamed back and the
						// write is reported as failed.
						if (backupPath !== null && releaseBackupOnSuccess) {
							// Ownership of the backup transfers before the rename, not after it. If the
							// rename itself fails the backup is still the only copy of the pre-write
							// content, and the outer handler must not unlink it just because this call
							// is failing - that is how a cleanup swallows the user's data.
							const rollbackPath = backupPath
							backupPath = null
							releaseBackupOnSuccess = false
							try {
								await fs.rename(rollbackPath, targetPath)
							} catch (rollbackError: unknown) {
								warn(`safeWriteText: the DACL of ${targetPath} could not be restored and its content could not be rolled back; the pre-write content is retained at ${rollbackPath}.`)
								throw new DaclRestoreError(targetPath, rollbackError)
							}
							// The rolled-back file is the backup, whose access rights came from the
							// directory rather than from the original target, so the same verification
							// runs on it: a rollback that restores content under an unknown ACL has not
							// finished its job either.
							const rolledBackAcl = await _restrictDaclWindows(targetPath, options?.execFileRunner)
							if (!rolledBackAcl) {
								warn(`safeWriteText: the previous content is back at ${targetPath}, but its access rights could not be narrowed or verified; the file carries the access rights of its directory.`)
							}
						}
						throw new DaclRestoreError(targetPath)
					}
					warn(`safeWriteText: content committed at ${targetPath}, but the saved DACL could not be restored from ${daclDumpPath}; the file's access rights were narrowed to the current user's full control and verified.`)
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
		if (backupPath && releaseBackupOnSuccess) {
			// Nothing to restore: the backup is a copy, so the target still holds whatever
			// the commit left there - before the commit that is the pre-write content, and
			// after it the published content. Either way the copy has served its purpose
			// and must not be left beside the target where no caller can find it.
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
