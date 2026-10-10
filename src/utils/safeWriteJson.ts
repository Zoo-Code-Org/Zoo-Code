import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock } from "./fileLock"
import {
	resolveLockKey,
	resolvePublishTarget,
	safeWriteText,
	type SafeWriteTextOptions,
} from "../services/file-safety/safeWriteText"

/**
 * Options for safeWriteJson function
 */
export interface SafeWriteJsonOptions {
	/**
	 * Whether to pretty-print the JSON output with indentation.
	 * When true, uses tab characters for indentation.
	 * When false or undefined, outputs compact JSON.
	 * @default false
	 */
	prettyPrint?: boolean

	/**
	 * When provided, the current file is read under the advisory lock
	 * and passed to this function along with the incoming data. The
	 * return value replaces `data` for the write. This turns a blind
	 * overwrite into an atomic read-modify-write, preventing cross-process
	 * lost updates. `existing` is null when the file does not exist or
	 * cannot be parsed.
	 */
	merge?: (existing: unknown, incoming: unknown) => unknown

	/**
	 * Restrict the write to a directory. The publish target is resolved through
	 * symlinks before this check runs, so a caller that picked the path from a
	 * known scope (a workspace, a project settings directory) can refuse a write
	 * that a planted symlink would land somewhere else. The check runs before the
	 * advisory lock is taken and before anything is staged.
	 */
	confineTo?: string
}

/**
 * Thrown when a write declared with `confineTo` resolves outside that directory.
 */
export class ConfinedPathEscapeError extends Error {
	constructor(
		readonly requestedPath: string,
		readonly resolvedPath: string,
		readonly confineTo: string,
	) {
		super(
			`Refusing to write ${resolvedPath}: it resolves outside the confined directory ${confineTo} (requested ${requestedPath}).`,
		)
		this.name = "ConfinedPathEscapeError"
	}
}

/**
 * Canonicalize the directory a write is confined to. The publish target is fully
 * resolved through symlinks, so the scope has to be resolved the same way or a
 * scope path that itself runs through a symlink (macOS /var -> /private/var is the
 * common case) would compare lexically against a resolved target and reject every
 * legitimate in-scope write. When the scope does not exist yet, the nearest
 * existing ancestor is resolved and the remainder re-appended.
 */
async function _resolveScopeRoot(confineTo: string): Promise<string> {
	const lexical = path.resolve(confineTo)
	try {
		return await fs.realpath(lexical)
	} catch (error: unknown) {
		// Only a missing path means "walk up and re-join". EACCES or ELOOP means the
		// scope cannot be canonicalized at all, and continuing would build a partly
		// lexical root that can disagree with the canonical target - the failure has to
		// surface rather than decide the scope from a guess.
		if (_scopeErrorCode(error) !== "ENOENT") {
			throw error
		}
		const missing: string[] = []
		let ancestor = lexical
		while (true) {
			const parent = path.dirname(ancestor)
			if (parent === ancestor) {
				return lexical
			}
			missing.push(path.basename(ancestor))
			ancestor = parent
			try {
				const real = await fs.realpath(ancestor)
				return path.join(real, ...missing.reverse())
			} catch (innerError: unknown) {
				if (_scopeErrorCode(innerError) !== "ENOENT") {
					throw innerError
				}
			}
		}
	}
}

/**
 * Reject a candidate publish path that escapes the caller's confined scope.
 * Shared by the pre-lock check and the in-lock check so both canonicalize the
 * same way: the candidate is resolved through symlinks and compared against the
 * resolved scope root.
 */
function _assertWithinScope(requestedPath: string, candidatePath: string, scopeRoot: string): void {
	const relative = path.relative(scopeRoot, candidatePath)
	if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new ConfinedPathEscapeError(requestedPath, candidatePath, scopeRoot)
	}
}

function _scopeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/**
 * Safely writes JSON data to a file.
 * - Creates parent directories if they don't exist
 * - Uses 'proper-lockfile' for inter-process advisory locking to prevent concurrent writes to the same path.
 * - Writes to a temporary file first via JsonStreamStringify streaming.
 * - If the target file exists, it's backed up before being replaced.
 * - Attempts to roll back and clean up in case of errors.
 * - Supports pretty-printing with indentation while maintaining streaming efficiency.
 *
 * @param {string} filePath - The absolute path to the target file.
 * @param {any} data - The data to serialize to JSON and write.
 * @param {SafeWriteJsonOptions} options - Optional configuration for JSON formatting.
 * @returns {Promise<void>}
 */
/**
 * Fold a path into the identity its advisory lock is actually placed under.
 *
 * acquireFileLock locks `<absolute path>.lock` with realpath:false (see fileLock.ts), so the
 * lock's identity is the directory ENTRY the path names, not the string. On Windows the
 * filesystem folds two spellings of one entry in two ways: case anywhere, and short (8.3) names
 * inside a component - the runner profile directory arrives as RUNNER~1 on a CI agent, which is
 * where this was first observed. A case-only comparison folds only the first, so the second
 * leaves two keys that look different, one .lock directory, and a second acquisition that
 * collides with the first one's own lock: 'Lock file is already being held' once the retries are
 * spent.
 *
 * So fold the way the lock is placed: canonicalise the deepest EXISTING ancestor and append the
 * segments below it, case-folded on Windows. Canonicalising an existing ancestor is what folds a
 * short name, because that folding belongs to the filesystem rather than to any string rule; a
 * tail that does not exist yet can only be folded by the string rule. The walk starts at the
 * PARENT, not at the file: the lock is the entry beside the file, so the final component must
 * never be resolved through a symlink, or a link and its referent would fold into one key and
 * the two distinct .lock entries this call takes on purpose would collapse into one.
 */
async function _lockIdentityKey(absoluteFilePath: string): Promise<string> {
	const missing: string[] = [path.basename(absoluteFilePath)]
	let current = path.dirname(absoluteFilePath)
	for (;;) {
		let canonical: string | undefined
		try {
			canonical = await fs.realpath(current)
		} catch {
			// This component is not there yet; an ancestor of it may be.
		}
		if (canonical !== undefined || path.dirname(current) === current) {
			const folded = path.join(canonical ?? current, ...missing)
			return process.platform === "win32" ? folded.toLowerCase() : folded
		}
		missing.unshift(path.basename(current))
		current = path.dirname(current)
	}
}
async function safeWriteJson(filePath: string, data: any, options?: SafeWriteJsonOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	// One release per lock acquired, kept in acquisition order and released in reverse below.
	let releaseLocks: Array<() => Promise<void>> = []

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists with improved reliability
	// Declared outside the protected block so the catch and finally can still name
	// the target when the resolution itself rejects.
	let resolvedTargetPath: string | undefined

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must be computable
	// while a peer writer is mid-commit (backup mode renames the referent away and
	// back), so the walk tolerates a dangling link instead of rejecting it here.
	// The lock key must name the file this write is going to replace. An unscoped write publishes
	// over the link itself (see below), so it locks the link path; only a caller that declared a
	// confinement scope publishes through the referent and therefore locks the referent. Locking
	// the referent while replacing the link lets two writers hold two different locks for one
	// publish target - the lost update the lock exists to prevent.
	const publishOverLink = options?.confineTo === undefined
	const referentLockKey = await resolveLockKey(absoluteFilePath)
	// A confined caller publishes through the referent, so the referent is the identity it replaces
	// and the only lock it needs. A default write replaces the link itself, so the link path is the
	// identity it replaces - and it also takes the referent lock, because while the link exists that
	// is the lock serializing this alias against a writer that names the referent directly. Holding
	// only the link-path lock lets those two writers overlap, and their merge reads overwrite each
	// other. Resolving the referent here costs one more realpath on a default write; it is a read of
	// the link target for locking purposes, not a decision to publish through it.
	// The two keys are compared the way the filesystem would, not the way strings compare:
	// byte-for-byte they can name one file twice, and locking a file this call already locked
	// would stall on its own stale timeout. Folding is per _lockIdentityKey, because case folding
	// alone leaves a short-name spelling unequal to the canonical one resolveLockKey returns.
	const linkPathLockKey = absoluteFilePath
	const [referentLockIdentity, linkPathLockIdentity] = await Promise.all([
		_lockIdentityKey(referentLockKey),
		_lockIdentityKey(linkPathLockKey),
	])
	const sameIdentity = referentLockIdentity === linkPathLockIdentity
	const lockKeys = publishOverLink
		? sameIdentity
			? [linkPathLockKey]
			: [referentLockKey, linkPathLockKey].sort()
		: [referentLockKey]
	const lockKey = lockKeys[lockKeys.length - 1]

	// Confinement, if the caller declared a scope, is checked BEFORE the lock is
	// taken and before the parent-directory creation below: an out-of-scope target
	// with a missing parent would otherwise get a directory created outside
	// confineTo, and proper-lockfile creates ${lockKey}.lock beside the lock key -
	// a key that is the symlink referent, so a repository-planted link out of the
	// scope would otherwise create a lock file outside the scope (and an unwritable
	// referent directory would surface a lock-acquisition error after retries
	// instead of ConfinedPathEscapeError). Repeated on the resolved publish target
	// inside the lock, since a peer writer may move the referent in between.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(referentLockKey), scopeRoot)
	}

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// immediately, and releaseLock stays a no-op so the finally block does not try
	// to release an unacquired lock.
	// Acquired in sorted key order, so two writers approaching the same pair of identities from
	// opposite sides cannot each hold one and wait for the other. If an acquisition fails, anything
	// already acquired is released here: the protected block has not started, so its finally would
	// not run, and a held lock outlives this call until the stale timeout.
	const acquired: Array<() => Promise<void>> = []
	try {
		for (const key of lockKeys) {
			acquired.push(await acquireFileLock(key))
		}
	} catch (lockError) {
		for (const release of [...acquired].reverse()) {
			await release().catch(() => undefined)
		}
		throw lockError
	}
	releaseLocks = acquired

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

	try {
		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		// Only a caller that declared a confinement scope has looked at the referent, so only such
		// a caller may publish through it. Following a link for every writer lets a workspace file
		// that happens to be a symlink - .roo/mcp.json pointing at a file outside the workspace -
		// redirect a default write (McpHub passes no scope) onto a file nobody authorized, which is
		// the boundary the confined callers exist to protect. A default write therefore replaces the
		// link itself, as this primitive did before it resolved links at all.
		resolvedTargetPath = options?.confineTo ? await resolvePublishTarget(absoluteFilePath) : absoluteFilePath

		// Confinement, if the caller declared a scope. Both sides are canonicalized the
		// same way: the publish target is resolved through symlinks, and a target that
		// does not exist yet still carries the alias components of the path it was
		// given. This runs before the merge read and before anything is staged, so a
		// rejected write leaves nothing behind.
		if (options?.confineTo) {
			const scopeRoot = await _resolveScopeRoot(options.confineTo)
			_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(resolvedTargetPath), scopeRoot)
		}

		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write. Must be inside try/finally
		// so a throwing merge still releases the lock.
		if (options?.merge) {
			let existing: unknown = null
			// An unscoped write replaces the link rather than publishing through it, so it must not
			// read through the link either: reading the referent and writing the replacement would
			// copy JSON from outside the requested path into a file the caller named. The merge sees
			// no existing document, exactly as it would if the path did not exist.
			let mergeTargetIsLink = false
			if (!options?.confineTo) {
				try {
					mergeTargetIsLink = (await fs.lstat(resolvedTargetPath)).isSymbolicLink()
				} catch (linkError: unknown) {
					// An absent target is not a link: the read below reports ENOENT and the merge sees no
					// document, which is the behaviour callers rely on.
					const code =
						linkError && typeof linkError === "object" && "code" in linkError
							? (linkError as { code?: string }).code
							: undefined
					if (code !== "ENOENT") {
						throw linkError
					}
				}
			}
			try {
				if (!mergeTargetIsLink) {
					existing = JSON.parse(await fs.readFile(resolvedTargetPath, "utf8"))
				}
			} catch (error: unknown) {
				const code =
					error && typeof error === "object" && "code" in error ? (error as { code: string }).code : undefined
				if (!(error instanceof SyntaxError) && code !== "ENOENT") {
					throw error
				}
			}
			data = options.merge(existing, data)
		}

		// Step 1: Write data to a new temporary file via JSON streaming.
		// Stage it beside the *resolved* target (the symlink referent when the path is
		// a symlink; resolvedTargetPath above): safeWriteText commits by renaming
		// onto that referent, and a rename across filesystems would fail with EXDEV.
		actualTempNewFilePath = path.join(
			path.dirname(resolvedTargetPath),
			".new_" + Date.now() + "_" + Math.random().toString(36).substring(2) + ".tmp",
		)

		await _streamDataToFile(actualTempNewFilePath, data, options?.prettyPrint)

		// Step 2: Delegate backup + commit + rollback to safeWriteText with the
		// pre-written temp path. backup:true keeps the old safeWriteJson
		// semantics (target -> backup before commit, rollback on failure) and
		// keeps the target in place until safeWriteText captures its Windows
		// DACL (safeWriteText dumps the DACL before its own backup rename and
		// restores it onto the directory after the commit rename).
		const textOptions: SafeWriteTextOptions = {
			tempPath: actualTempNewFilePath,
			backup: true,
			// A write with no declared scope replaces the link rather than writing through it, so the
			// publish must not re-resolve the path it is handed below.
			publishOverLink,
		}

		await safeWriteText(resolvedTargetPath, "", textOptions)

		// If we reach here, the new file is successfully in place and any
		// backup has already been handled by safeWriteText.
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(
			`Operation failed for ${resolvedTargetPath ?? absoluteFilePath}: [Original Error Caught]`,
			originalError,
		)

		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// A failed safeWriteText already rolled the backup (if any) back to
		// the target path. Clean up the .new file if it still exists
		// (safeWriteText also cleans up its tempPath on failure; this is a
		// safety net in case its cleanup missed it).
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError: unknown) {
				// The expected case: safeWriteText already removed its own temp file, so a
				// missing file here is not a cleanup failure worth logging. Returning would
				// also swallow the original error the caller needs.
				const isAbsent =
					typeof cleanupError === "object" &&
					cleanupError !== null &&
					"code" in cleanupError &&
					cleanupError.code === "ENOENT"
				if (!isAbsent) {
					console.error(
						`[Catch] Failed to clean up temporary new file ${newFileToCleanupWithinCatch}:`,
						cleanupError,
					)
				}
			}
		}

		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release in the reverse of the acquisition order, and release every lock that was acquired
		// even if an earlier release threw: a lock this call took must not be left held.
		for (const release of [...releaseLocks].reverse()) {
			try {
				await release()
			} catch (unlockError) {
				console.error(`Failed to release lock for ${resolvedTargetPath ?? absoluteFilePath}:`, unlockError)
			}
		}
	}
}

/**
 * Helper function to stream JSON data to a file.
 * @param targetPath The path to write the stream to.
 * @param data The data to stream.
 * @param prettyPrint Whether to format the JSON with indentation.
 * @returns Promise<void>
 */
async function _streamDataToFile(targetPath: string, data: any, prettyPrint = false): Promise<void> {
	// Stream data to avoid high memory usage for large JSON objects.
	const fileWriteStream = fsSync.createWriteStream(targetPath, { encoding: "utf8" })

	// JsonStreamStringify traverses the object and streams tokens directly
	// The 'spaces' parameter adds indentation during streaming, not via a separate pass
	// Convert undefined to null for valid JSON serialization (undefined is not valid JSON)
	const stringifyStream = new JsonStreamStringify(
		data === undefined ? null : data,
		undefined, // replacer
		prettyPrint ? "\t" : undefined, // spaces for indentation
	)

	return new Promise<void>((resolve, reject) => {
		stringifyStream.on("error", reject)
		fileWriteStream.on("error", reject)
		fileWriteStream.on("finish", resolve)
		stringifyStream.pipe(fileWriteStream)
	})
}

export { safeWriteJson }
