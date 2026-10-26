import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { execFile } from "child_process"

import { resolveRealPath } from "../../utils/WorkspacePathResolver"

/**
 * Options for safeWriteText atomic text publish primitive.
 */
export interface SafeWriteTextOptions {
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
	 * Authorized publish root. When set, a requested path that resolves lexically
	 * inside this root must also publish inside it: a symlink or dangling link whose
	 * referent escapes the root is rejected before anything is created or written,
	 * so an approval that covered the inside path can never be spent on an outside
	 * target. Requested paths that are themselves outside the root are not
	 * constrained here - the caller's own approval flow governs those.
	 */
	authorizedRoot?: string
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
/**
 * The target exists but its DACL could not be captured, so publishing would replace its security
 * descriptor with inherited permissions and no record would exist to restore it from. Thrown
 * before the commit rename; the target is left untouched.
 */
export class DaclCaptureError extends Error {
	constructor(
		public readonly targetPath: string,
		public readonly dumpPath: string,
	) {
		super(
			`safeWriteText: refusing to publish ${targetPath}: its DACL could not be captured (no icacls dump was written at ${dumpPath}). No change was made to the target.`,
		)
		this.name = "DaclCaptureError"
	}
}

export class PublishNotDurableError extends Error {
	constructor(targetPath: string, reason: string) {
		super(`Published ${targetPath} but could not confirm it is durable: ${reason}`)
		this.name = "PublishNotDurableError"
	}
}

/**
 * The content is committed but a captured DACL could not be put back on it, so the file at the
 * target answers to different access rights than the one it replaced. Raised after the commit
 * rename, so the content is at the target.
 *
 * A host that cannot restore DACLs at all (icacls /restore exits 1300 because the process lacks
 * the backup/restore privilege) is treated as a logged host limitation instead: the content is
 * committed and no retry can fix the capability, so failing every overwrite there would break
 * ordinary saves without changing the outcome. Only restore failures that a retry or a caller
 * could address are raised as this error.
 */
export class DaclRestoreError extends Error {
	constructor(
		public readonly targetPath: string,
		public readonly causeError: unknown,
		reason: string = "its saved access rights could not be restored",
	) {
		super(`safeWriteText: content committed at ${targetPath}, but ${reason}`)
		this.name = "DaclRestoreError"
	}
}

function _errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/** Create a private per-write staging sub-directory inside *dir*. The name is
 * generated here, the way the temp file inside it is named, so concurrent writes
 * never collide on their temp names and never release a directory another write
 * is still using. */
function _stagingDir(dir: string): string {
	// A shared fixed name is a path the workspace controls: mkdirSync with
	// recursive:true accepts an existing entry of that name without creating
	// anything, so a committed .file-safety-staging symlink would have the chmod
	// below repair the permissions of a directory outside the workspace and put
	// the staged file in it. A name this call generated cannot be pre-planted.
	const sd = path.join(dir, ".file-safety-staging_" + Date.now() + "_" + Math.random().toString(36).substring(2))
	// The name is this call's, the entry at it still has to be checked: a colliding
	// or swapped-in path would stage - and then publish - outside the target
	// directory. Anything that is not a real directory owned by this process is
	// rejected instead of used.
	let preExisted = false
	try {
		const existing = fsSync.lstatSync(sd)
		preExisted = true
		if (!existing.isDirectory()) {
			throw new UnsafeStagingDirectoryError(sd, "it exists and is not a directory")
		}
	} catch (error: unknown) {
		if (error instanceof UnsafeStagingDirectoryError) throw error
		if (_errorCode(error) !== "ENOENT") throw error
	}
	// A directory this call created but never hands to the caller would sit in the user's
	// target directory forever - the caller never receives the path, so nothing else can
	// clean it up. A pre-existing staging directory is left alone: it may belong to a
	// concurrent write.
	function _abandonIfCreated(): void {
		if (!preExisted) {
			try {
				fsSync.rmdirSync(sd)
			} catch {
				// not empty or already gone: there is nothing else this call can do
			}
		}
	}
	// mode:0o700 protects a freshly created staging dir; the best-effort chmod
	// repairs a pre-existing one (mkdirSync with recursive:true never chmods an
	// existing directory), so staged temp files are never group/world readable.
	fsSync.mkdirSync(sd, { recursive: true, mode: 0o700 })
	// Re-check after the create: the path can be swapped for a symlink between the
	// check above and mkdirSync.
	let created: fsSync.Stats
	try {
		created = fsSync.lstatSync(sd)
	} catch (error: unknown) {
		// The directory exists at this point and this call may have just created it. Letting the
		// probe error propagate would strand it: the caller never receives the path, so nothing
		// else can remove it. Abandon first, then rethrow the original error.
		_abandonIfCreated()
		throw error
	}
	if (!created.isDirectory()) {
		_abandonIfCreated()
		throw new UnsafeStagingDirectoryError(sd, "it was replaced by a non-directory")
	}
	if (typeof process.getuid === "function" && created.uid !== process.getuid()) {
		_abandonIfCreated()
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
 *
 * The async fsync form runs the same syscall on libuv's thread pool instead of blocking the
 * extension host event loop (this is also what FileHandle.sync() uses internally). The staging
 * write and fchmod stay synchronous because they are bounded and need the descriptor the sync
 * open produced; only the durability barrier - the part the review measured at ~7 ms - is moved
 * off the event loop. Any fsync error still rejects the publish before the rename.
 */
function _fsyncFile(fd: number): Promise<void> {
	return new Promise((resolve, reject) => {
		fsSync.fsync(fd, (error) => (error ? reject(error) : resolve()))
	})
}

/**
 * Keep the existing target's group on the staged file before it is published.
 *
 * The commit is a rename, so the published inode is a new one: it takes the process's
 * primary group (or the directory's gid when the directory is setgid). A shared 0o664
 * file owned by group `devs` would therefore lose group write access for every member
 * whose primary group is not `devs`, even though the fchmod below restores the mode - the
 * mode fix exists precisely to stop that regression, so the group has to survive too.
 *
 * Best-effort: fchown only succeeds when this process belongs to that group, which is the
 * case that matters; anywhere else the mode fix still stands. It runs BEFORE fchmod
 * because chown can clear the setgid bits that chmod has just set. Windows carries no
 * POSIX gid to preserve - its identity is the DACL, handled by the save/restore steps.
 */
function _applyTargetOwnership(fd: number, gid: number | undefined, platform: string): void {
	if (platform === "win32" || typeof gid !== "number") {
		return
	}
	try {
		fsSync.fchownSync(fd, -1, gid)
	} catch {
		// Not a member of the target's group: keep the mode preservation and move on.
	}
}

/** Save the DACL of *srcPath* to a dump file on Windows.
 * Returns true when a usable dump exists; false otherwise.
 * Never throws - a false return means no usable dump was produced, which the caller treats
 * as "the security descriptor cannot be preserved" and fails closed before publishing. */
async function _saveDaclWindows(srcPath: string, dumpPath: string, execFileRunner?: typeof execFile): Promise<boolean> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			// No /T: with a file path, /T makes icacls walk the whole directory tree and save every
			// file that shares the name (a save of <root>\package.json also walks node_modules),
			// and the matching /restore then rewrites the DACL of every one of those files rather
			// than only the target's. An inaccessible subdirectory can also make /save exit
			// non-zero, leaving the fail-closed check to depend on a dump that may not contain the
			// target's own entry.
			runner("icacls", [srcPath, "/save", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return _dumpIsUsable(dumpPath)
	} catch {
		// icacls can exit non-zero while still writing a usable dump (measured on a normal host), so
		// judge the capture by the artifact, not only by the exit code: a non-empty dump is a capture.
		try {
			return _dumpIsUsable(dumpPath)
		} catch {
			return false
		}
	}
}

// A DACL dump is only usable if it is actually there, is a regular file, and has bytes in it.
// Both the success and the failure callback have to be judged by this: icacls can exit 0 without
// writing anything (measured on a host where the target's owner differs from the caller), and a
// zero-byte dump restores nothing - so trusting the exit code alone would let the commit rename
// destroy a security descriptor that was never captured.
function _dumpIsUsable(dumpPath: string): boolean {
	try {
		const st = fsSync.statSync(dumpPath)
		return st.isFile() && st.size > 0
	} catch {
		return false
	}
}

/** Restore a DACL dump onto *dirPath* on Windows.
 * `restored` reports whether icacls succeeded; the caller decides whether a lost DACL is
 * tolerable. `privilegeUnavailable` separates the one failure that will never fix itself
 * from a transient one: on a non-elevated host /restore always exits 1300 (measured), so
 * retrying it on every later write costs three process spawns per write for a DACL that
 * cannot be restored. A transient failure must not disable preservation for the process. */
async function _restoreDaclWindows(
	dirPath: string,
	dumpPath: string,
	execFileRunner?: typeof execFile,
): Promise<{ restored: boolean; privilegeUnavailable: boolean }> {
	const runner = execFileRunner ?? execFile
	try {
		await new Promise<void>((resolve, reject) => {
			runner("icacls", [dirPath, "/restore", dumpPath], { windowsHide: true }, (err) =>
				err ? reject(err) : resolve(),
			)
		})
		return { restored: true, privilegeUnavailable: false }
	} catch (error: unknown) {
		// execFile reports a non-zero exit as an error carrying that exit code.
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
		return { restored: false, privilegeUnavailable: code === _ICACLS_PRIVILEGE_EXIT_CODE }
	}
}

// Set once a restore has failed with the missing-privilege exit code: from then on the
// process skips the save/restore pair instead of paying for it on every write and warning
// about the same host limitation each time. Skipping the pair is a cost decision only: it
// must not change what a publish reports. A later write that replaces an existing target
// still loses that target's descriptor, so step 2b records it and the call reports the
// condition instead of resolving quietly. The reason is logged once, when the memo is set.
let daclRestorePrivilegeUnavailable = false

// icacls exit code for "a required privilege is not held by the client".
const _ICACLS_PRIVILEGE_EXIT_CODE = 1300

// -- public API ------------------------------------------------------------

/**
 * Atomic text publish primitive.
 *
 * 1. Write content to a temp file in a private per-write staging subdir
 *    (same volume -> atomic rename guaranteed).
 * 2. fsync the temp file, then close it.
 * 3. win32 only: if target exists save its DACL dump BEFORE the commit rename.
 * 4. Atomic rename temp -> target.
 * 5. win32 only: restore DACL onto the directory AFTER commit rename.
 * 6. On success: unlink DACL dump.
 * 7. On failure: clean up temp + dump (the target was never moved).
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
		// Only ENOENT means "there is nothing here that could be a link". Any other lstat error
		// (EACCES, EIO, ...) must propagate: treating "could not inspect" as "not a link" would let
		// a write land on the link path and replace the link, which is exactly what this resolver
		// exists to prevent - and the doc comment above already promises that it propagates.
		let link: Awaited<ReturnType<typeof fs.lstat>> | null = null
		try {
			link = await fs.lstat(absoluteFilePath)
		} catch (statError: unknown) {
			if (_errorCode(statError) !== "ENOENT") {
				throw statError
			}
		}
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

/** Lexical containment: true when target sits at or under root. */
function _isWithinRoot(root: string, target: string): boolean {
	const rel = path.relative(root, target)
	// A leading ".." is an escape only as a full segment: a sibling entry
	// may legitimately be named "..config", and path.relative reports it bare.
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/**
 * Canonicalize a path that may not exist yet: resolve the nearest existing
 * ancestor and re-append the missing tail. A dangling final component under
 * a symlinked parent directory would otherwise look inside the root
 * lexically while the write lands wherever the parent link points.
 */
async function _realpathNearestExisting(targetPath: string): Promise<string> {
	// Same walk as WorkspacePathResolver.resolveRealPath, with case folding off: the result is
	// compared against the authorized root and used for publish decisions, so the on-disk case
	// must be preserved and a non-ENOENT error must fail closed (both provided by the helper).
	return resolveRealPath(targetPath, { caseFold: false })
}
/**
 * Refuse a publish whose retained target escaped the caller's authorized root
 * while the requested path sat inside it: the tool layer approved the inside
 * path, so an escape here (a symlink or dangling link pointing outside the
 * workspace) would land bytes the approval never covered outside the root, and
 * the parent-directory mkdir below would happily create the outside parent
 * first. A requested path that is itself outside the root is left alone - the
 * caller's own approval flow covers outside-root writes, and this primitive has
 * no opinion about a root it was not asked to enforce.
 */
export async function assertPublishWithinAuthorizedRoot(
	authorizedRoot: string,
	requestedPath: string,
	targetPath: string,
): Promise<void> {
	let root: string
	try {
		root = await fs.realpath(authorizedRoot)
	} catch (error: unknown) {
		// ENOENT falls back to the lexical root: the root may be created by this
		// very write's mkdir below. Any other inspection error propagates rather
		// than silently skipping the boundary.
		if (_errorCode(error) !== "ENOENT") {
			throw error
		}
		root = path.resolve(authorizedRoot)
	}
	// A workspace opened through a symlink (e.g. /tmp/ws -> /private/tmp/ws)
	// makes every inside path look outside the canonicalized root, which
	// would skip the check exactly where it matters. Match both the canonical
	// and the lexical root: an inside request is one that sits under either,
	// and an inside target is one that sits under either.
	const lexicalRoot = path.resolve(authorizedRoot)
	const roots = lexicalRoot === root ? [root] : [root, lexicalRoot]
	const requestedInside = roots.some((candidate) => _isWithinRoot(candidate, requestedPath))
	// The retained target may still sit under a symlinked parent directory:
	// resolve the nearest existing ancestor so the inside test sees where the
	// bytes actually land, not just where the name lexically sits.
	const effectiveTarget = await _realpathNearestExisting(targetPath)
	const targetInside = roots.some((candidate) => _isWithinRoot(candidate, effectiveTarget))
	if (requestedInside && !targetInside) {
		throw new Error(
			`safeWriteText: refusing to publish ${targetPath}: the requested path ${requestedPath} is inside the authorized root ${root} but the resolved publish target is not. Nothing was written.`,
		)
	}
}

export async function safeWriteText(filePath: string, content: string, options?: SafeWriteTextOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)

	// Resolve the symlink referent (see resolvePublishTarget).
	const targetPath = await resolvePublishTarget(absoluteFilePath)

	// Enforce the caller's authorized root before anything is created or written
	// (the mkdir below can otherwise materialize an outside parent first).
	if (options?.authorizedRoot !== undefined) {
		await assertPublishWithinAuthorizedRoot(options.authorizedRoot, absoluteFilePath, targetPath)
	}

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
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.rmdir(stagingDir)
				return
			} catch (error: unknown) {
				const code = _errorCode(error)
				// ENOENT: another writer already removed it. ENOTEMPTY: a concurrent write is still
				// staging here, which is the concurrency guard this directory exists for. Both are
				// benign - no retry, no warning.
				if (code === "ENOENT" || code === "ENOTEMPTY") return
				// Anything else (EBUSY, EPERM, EACCES, ...) is transient here: retry once, then
				// surface the retained directory. A leftover staging directory is acceptable, an
				// invisible one is not.
				if (attempt === 1) {
					console.warn(
						`safeWriteText: staging directory release failed: ${stagingDir} (${code ?? String(error)})`,
					)
				}
			}
		}
	}

	// Set when the commit landed but its durability could not be confirmed. The
	// content is in place, so there is nothing to roll back, but the caller must
	// not be told the publish is durable.
	let durabilityError: unknown = null
	// Set when the commit landed but the saved DACL could not be put back on the published file.
	// The content is in place, so there is nothing to roll back, but the caller must not observe a
	// success whose access rights changed.
	let daclRestoreError: DaclRestoreError | null = null
	let daclDumpPath: string | null = null // tracked for cleanup in finally
	let daclSaved = false // restore step runs only when the save succeeded

	const platform = options?.platform ?? process.platform

	try {
		// -- Step 1: write content to staging temp file -------------------
		if (!options?.tempPath) {
			// Preserve the existing target's permissions: the staging file must
			// not be published wider than the file it replaces (a 0o600 target
			// must not become 0o644 through the atomic rename).
			let targetMode = 0o644 // default for a fresh target
			let targetGid: number | undefined
			let targetExists = false
			try {
				const targetStats = fsSync.statSync(targetPath)
				targetMode = targetStats.mode & 0o777
				targetGid = targetStats.gid
				targetExists = true
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
				// The staging directory belongs to this write alone, but its release is
				// best-effort and retried, so a lingering release can still race this open.
				// Recreate the same path - a fresh random name would not contain tempPath,
				// the reopen would fail again on a real filesystem, and the new directory
				// would be orphaned - and verify it is a real directory before reopening.
				// Any other errno, or a second ENOENT, is a real failure.
				if (_errorCode(error) !== "ENOENT" || stagingDir === null) throw error
				fsSync.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
				if (!fsSync.lstatSync(stagingDir).isDirectory()) {
					throw new UnsafeStagingDirectoryError(stagingDir, "it exists and is not a directory")
				}
				fd = fsSync.openSync(tempPath, "w", targetMode)
			}
			// The creation mode handed to openSync is masked by the process umask: an existing
			// 0o664 target would be published as 0o644 and a shared repository would lose group
			// write access on every save. Apply the exact target mode on the descriptor, which is
			// also what the caller-staged branch below does.
			try {
				if (targetExists) {
					_applyTargetOwnership(fd, targetGid, platform)
					fsSync.fchmodSync(fd, targetMode)
				}
				// Loop until every byte is written: writeSync can report a short
				// (partial) write, and publishing a truncated staging file would
				// commit corrupt content.
				const buffer = Buffer.from(content, "utf8")
				let offset = 0
				while (offset < buffer.length) {
					offset += fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
				}
				await _fsyncFile(fd)
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
				targetGid = targetStats.gid
			} catch (error: unknown) {
				// As above: an unknown target mode must not be replaced by the temp's
				// own creation mode, which can be wider than the target's.
				if (_errorCode(error) !== "ENOENT") throw error
			}
			const fd = fsSync.openSync(tempPath, "r+")
			try {
				if (targetMode !== null) {
					_applyTargetOwnership(fd, targetGid, platform)
					fsSync.fchmodSync(fd, targetMode)
				}
				await _fsyncFile(fd)
			} finally {
				fsSync.closeSync(fd)
			}
		}

		// -- Step 2 (win32): save DACL BEFORE the commit rename -----------
		// Once a restore has proven this host cannot restore at all, saving a dump it cannot
		// apply is three process spawns per write for nothing, so the pair is skipped. The
		// skip is decided here, not in step 5, because the save is the expensive half.
		if (platform === "win32" && !daclRestorePrivilegeUnavailable) {
			try {
				await fs.access(targetPath) // target exists?
				// Unique per call: two concurrent writes to the same target must not share one dump,
				// where one call can unlink or overwrite the file the other is still using. Kept in the
				// target directory, not the staging dir, so a write that never stages a temp file still
				// leaves no extra directory behind.
				daclDumpPath = _tempName(dirPath, "safeWriteText.acl.tmp")
				const saved = await _saveDaclWindows(targetPath, daclDumpPath, options?.execFileRunner)
				if (!saved) {
					// Fail closed. Publishing without a captured DACL replaces the target's security
					// descriptor with whatever the parent directory inherits, and no later step can put the
					// original back. icacls /save does not need the backup/restore privileges that /restore
					// does (measured: /restore exits 1300 un-elevated), so refusing here does not break
					// ordinary hosts - it removes the exposure instead of accepting it. The staging file,
					// the dump is cleaned by the rollback below.
					daclSaved = false
					// This throw leaves the try/finally that owns cleanup, so release the artifacts here:
					// the staged file and the (unusable) dump must not be orphaned. Removal is retried once
					// and a retained path is reported rather than suppressed.
					const abortArtifacts: Array<string | null> = [
						daclDumpPath,
						options?.tempPath ? null : tempPath, // a caller-supplied temp belongs to the caller
					]
					for (const artifact of abortArtifacts) {
						if (!artifact) {
							continue
						}
						let removed = false
						for (let attempt = 0; attempt < 2 && !removed; attempt++) {
							try {
								await fs.unlink(artifact)
								removed = true
							} catch {
								// retry once, then report
							}
						}
						if (!removed) {
							console.warn(
								`safeWriteText: aborted before publishing and could not remove ${artifact}; it is retained and must be cleaned up out of band.`,
							)
						}
					}
					throw new DaclCaptureError(targetPath, daclDumpPath)
				} else {
					daclSaved = true
				}
			} catch (err: unknown) {
				if (err instanceof DaclCaptureError) {
					// Not an access probe failure: the target exists and its DACL could not be captured.
					throw err
				}

				// Only ENOENT means "there is no target, so there is no DACL to preserve". EACCES or any
				// other probe error says nothing about the target's security descriptor, and publishing
				// over a target we could not inspect would replace it without a captured DACL.
				const probeCode =
					err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined
				if (probeCode !== "ENOENT") {
					throw err
				}
				daclDumpPath = null
			}
		}

		try {
			// -- Step 3: atomic rename temp -> target ---------------------
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
						await _fsyncFile(dirFd)
					} finally {
						fsSync.closeSync(dirFd)
					}
				} catch (error: unknown) {
					// The rename committed, so the content is in place and there is nothing to
					// roll back, but the directory entry is not confirmed durable. Record it so
					// the call fails and the publish is reported as not durable.
					durabilityError = error
				}
			}

			// -- Step 5 (win32): restore DACL AFTER commit rename ---------
			if (platform === "win32" && daclSaved && daclDumpPath !== null) {
				const restoredDir = path.dirname(targetPath)
				let attempt = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				if (!attempt.restored && !attempt.privilegeUnavailable) {
					// One retry, and only for a failure that could be transient: icacls can fail
					// while another process still holds the just-renamed file open. A host without
					// the privilege fails identically every time, so retrying it is pure cost.
					attempt = await _restoreDaclWindows(restoredDir, daclDumpPath, options?.execFileRunner)
				}
				if (!attempt.restored) {
					// A host without the backup/restore privilege cannot do better: no retry
					// grants a privilege mid-process, and the content is already committed. Warn
					// once, memo the limitation, and let the publish succeed - failing every
					// overwrite on such a host would break ordinary saves without changing the
					// access rights. Non-privilege restore failures stay errors: those are the
					// failures a caller or a later retry could actually address.
					if (attempt.privilegeUnavailable) {
						if (!daclRestorePrivilegeUnavailable) {
							daclRestorePrivilegeUnavailable = true
							console.warn(
								"safeWriteText: this host cannot restore DACLs (icacls /restore reports a missing privilege); the published content keeps the access rights inherited from its directory, and later writes in this process skip saving and restoring them.",
							)
						}
					} else {
						// The content is committed, but the published file answers to a different
						// DACL than the one that was saved, and nothing here verified an equivalent
						// restrictive ACL on the replacement. Reported as an error rather than a
						// warning: a publish that changed who can read the file must not look like
						// an ordinary successful save. Thrown after the rollback handler below - the
						// content is committed, so this is not a failure to roll back.
						daclRestoreError = new DaclRestoreError(targetPath, null)
					}
				}
			}
		} finally {
			// Unlink DACL dump regardless of success/failure in this span.
			if (daclDumpPath !== null) {
				try {
					await fs.unlink(daclDumpPath)
				} catch {
					// One bounded retry, then surface the path: an icacls dump left next to the
					// settings file is a readable copy of its ACL, so an invisible orphan is worse
					// than a visible one.
					try {
						await fs.unlink(daclDumpPath)
					} catch (cleanupError: unknown) {
						console.warn(
							`safeWriteText: the DACL dump at ${daclDumpPath} could not be removed (${String(cleanupError)}); it is left in place.`,
						)
					}
				}
			}
		}

		// tempPath is now the committed file; no cleanup needed.
	} catch (originalError: unknown) {
		// -- Rollback / cleanup on failure ----------------------------------
		// Always clean up the staging temp file on failure. A single swallowed unlink is not enough:
		// a transient EBUSY/EPERM would silently leave the temp inside the staging directory, and nothing
		// would ever report the retained path. Bounded retry, same shape as the DACL cleanup.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await fs.unlink(tempPath)
				break
			} catch (cleanupError: unknown) {
				const code = _errorCode(cleanupError)
				if (code === "ENOENT") {
					break
				}
				if (attempt === 1) {
					console.warn(
						`safeWriteText: staging temp release failed: ${tempPath} (${code ?? String(cleanupError)})`,
					)
				}
			}
		}

		if (daclDumpPath !== null) {
			await fs.unlink(daclDumpPath).catch(() => {})
		}

		await _releaseStagingDir()

		throw originalError
	}

	await _releaseStagingDir()

	// Raised outside the rollback handler on purpose: the content is committed, so
	// this is not a failure to roll back.
	if (durabilityError !== null) {
		const reason = durabilityError instanceof Error ? durabilityError.message : String(durabilityError)
		throw new PublishNotDurableError(targetPath, reason)
	}

	// Raised outside the rollback handler for the same reason as PublishNotDurableError: the
	// content is committed, so this is not a failure to roll back. A restore
	// failure therefore reaches the caller as its own error: no caller can observe success for a
	// publish whose DACL was not restored.
	if (daclRestoreError !== null) {
		throw daclRestoreError
	}
}
