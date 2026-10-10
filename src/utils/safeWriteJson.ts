import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock } from "./fileLock"
import {
	createStagingFile,
	PostCommitDurabilityError,
	resolveLockKey,
	resolvePublishTarget,
	safeWriteText,
	type DirectoryIdentity,
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
/**
 * The identity (dev, ino) of every EXISTING directory between the confined scope root
 * and the authorized target's parent. These are the directories the confinement walk
 * went through; a later swap of any one of them sends the commit somewhere the scope
 * check never looked, so the publish re-checks them.
 */
async function _confinedAncestorIdentities(scopeRoot: string, target: string): Promise<DirectoryIdentity[]> {
	const parent = path.dirname(target)
	const relative = path.relative(scopeRoot, parent)
	const chain: string[] = [scopeRoot]
	if (relative && relative !== "." && !relative.startsWith(".." + path.sep)) {
		let cursor = scopeRoot
		for (const segment of relative.split(path.sep)) {
			cursor = path.join(cursor, segment)
			chain.push(cursor)
		}
	}
	const pinned: DirectoryIdentity[] = []
	for (const dir of chain) {
		const stat = await fs.stat(dir, { bigint: true }).catch(() => undefined)
		if (stat) {
			pinned.push({ dir, dev: stat.dev, ino: stat.ino })
		}
	}
	return pinned
}

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
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(".." + path.sep) ||
		path.isAbsolute(relative)
	) {
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
async function safeWriteJson(filePath: string, data: any, options?: SafeWriteJsonOptions): Promise<void> {
	const absoluteFilePath = path.resolve(filePath)
	let releaseLock = async () => {} // Initialized to a no-op

	// For directory creation
	const dirPath = path.dirname(absoluteFilePath)

	// Ensure directory structure exists with improved reliability
	// Declared outside the protected block so the catch and finally can still name
	// the target when the resolution itself rejects.
	let resolvedTargetPath: string | undefined

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must be computable even
	// when the link does not resolve yet - a create writes through a dangling link,
	// and a peer writer can be caught between creating its staging file and the
	// commit rename - so the walk tolerates a dangling link instead of rejecting it
	// here.
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement, if the caller declared a scope, is checked before ANY filesystem
	// side effect of this call: the directory creation below would otherwise create a
	// parent directory outside confineTo for an out-of-scope target, and
	// proper-lockfile would create ${lockKey}.lock beside the lock key (a
	// repository-planted link out of the scope would also make an unwritable referent
	// directory surface a lock-acquisition error after retries instead of
	// ConfinedPathEscapeError). Repeated on the resolved publish target inside the
	// lock, since a peer writer may move the referent in between.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(lockKey), scopeRoot)
	}

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Acquire the lock before any file operations. If acquisition fails it throws
	// immediately, and releaseLock stays a no-op so the finally block does not try
	// to release an unacquired lock.
	releaseLock = await acquireFileLock(lockKey)

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null
	// The private staging directory belongs to whoever asked createStagingFile for it: safeWriteText
	// removes a directory it created itself, but a handle handed in from outside leaves the directory
	// owned by its holder, so this call has to be the one that removes it on a failure.
	let stagingDirToCleanup: string | undefined

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
		// The confinement decision is about a specific resolved path AND the directories
		// the walk to it went through. Both are handed to the publish primitive, which
		// re-resolves the path itself: without the pin, a link swapped in after this check
		// would move the commit outside the scope while every check above still passed.
		let confinedTarget: string | undefined
		let confinedAncestors: DirectoryIdentity[] | undefined
		if (options?.confineTo) {
			const scopeRoot = await _resolveScopeRoot(options.confineTo)
			confinedTarget = await _resolveScopeRoot(resolvedTargetPath)
			_assertWithinScope(absoluteFilePath, confinedTarget, scopeRoot)
			confinedAncestors = await _confinedAncestorIdentities(scopeRoot, confinedTarget)
		}

		// If a merge callback was provided, read the current file under the lock
		// and let the caller merge before we write. Must be inside try/finally
		// so a throwing merge still releases the lock.
		if (options?.merge) {
			let existing: unknown = null
			try {
				existing = JSON.parse(await fs.readFile(resolvedTargetPath, "utf8"))
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
		// The staging file comes from createStagingFile, which creates it exclusively
		// (wx) inside a private staging directory beside the *resolved* target (the symlink
		// referent when the path is a symlink; resolvedTargetPath above): safeWriteText
		// commits by renaming onto that referent, and a rename across filesystems would
		// fail with EXDEV. Taking the file from that API rather than naming one here is
		// what lets the commit bind to the object this write created - a path this call
		// invented could otherwise already exist, with content and access rights nobody
		// here chose.
		const staging = await createStagingFile(resolvedTargetPath)
		actualTempNewFilePath = staging.tempPath
		stagingDirToCleanup = staging.stagingDir

		await _streamDataToFile(staging.tempPath, data, options?.prettyPrint)

		// Step 2: Delegate backup + commit to safeWriteText with the pre-written
		// temp path. backup:true keeps the old safeWriteJson semantics: a COPY of the
		// target is taken before the commit rename and the target itself is never
		// moved, which also keeps it in place until safeWriteText captures its Windows
		// DACL (safeWriteText dumps the DACL before taking the backup copy and
		// restores it onto the directory after the commit rename).
		const textOptions: SafeWriteTextOptions = {
			staging,
			backup: true,
			// Pin the confinement decision onto the publish: the path handed to the publish
			// primitive must still resolve to what this check authorized, and every
			// directory the confined walk went through must still be the same directory,
			// or nothing is committed.
			// The pin is the path the publish will itself re-resolve - resolvedTargetPath,
			// which is what is passed below - not the canonicalized scope form. Pinning
			// the canonical form would refuse a target whose ANCESTORS are aliases (the
			// /var -> /private/var shape): the publish resolves only its final component, so
			// the two spellings differ even though nothing moved. The containment decision
			// still uses confinedTarget; only the drift check needs the publish's spelling.
			expectedResolvedPath: resolvedTargetPath,
			expectedAncestorIdentities: confinedAncestors,
			// A write with no declared scope replaces the link rather than writing through it, so the
			// publish must not re-resolve the path it is handed below.
			publishOverLink: options?.confineTo === undefined,
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

		// A PostCommitDurabilityError is raised AFTER the delegated commit rename: the staging file
		// has been consumed and the target holds the new bytes. Unlinking the staging NAME at that
		// point is an unlink of whatever answers to the name now, not of this write's staging file,
		// and the published content must not be touched either.
		const newFileToCleanupWithinCatch = originalError instanceof PostCommitDurabilityError ? null : actualTempNewFilePath

// A failed safeWriteText left the target alone, with ONE exception: a
// PostCommitDurabilityError is raised AFTER the commit rename, when the
// parent-directory fsync fails, so the target already holds the NEW bytes.
// Nothing here may restore or retry a write on that error - doing so would
// overwrite published content. For every other failure the target still holds
// the pre-write bytes and the backup copy was removed by safeWriteText itself.
// Clean up the .new file if it still exists (safeWriteText also cleans up its
// tempPath on failure; this is a safety net in case its cleanup missed it).
		// step, so the target still holds the pre-write bytes, and the backup copy it
		// took is removed by safeWriteText itself. Clean up the .new file if it still
		// exists (safeWriteText also cleans up its tempPath on failure; this is a
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

		// The staging directory is this call's residue: a failure before the commit leaves it
		// empty beside the target, and a failure inside createStagingFile or the streaming step
		// never reached safeWriteText's own cleanup. A PostCommitDurabilityError means the commit
		// consumed the staging file and safeWriteText already removed the directory with it.
		if (stagingDirToCleanup && !(originalError instanceof PostCommitDurabilityError)) {
			await fs.rmdir(stagingDirToCleanup).catch(() => {})
		}

		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release the lock in the main finally block.
		try {
			await releaseLock()
		} catch (unlockError) {
			console.error(`Failed to release lock for ${resolvedTargetPath ?? absoluteFilePath}:`, unlockError)
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
