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
	 * that a planted symlink would land somewhere else. The check runs under the
	 * target's advisory lock, once the publish target has been resolved, and before
	 * anything is staged or written.
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

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must be computable
	// while a peer writer is mid-commit (backup mode renames the referent away and
	// back), so the walk tolerates a dangling link instead of rejecting it here.
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement, if the caller declared a scope, is checked BEFORE the lock is
	// taken: proper-lockfile creates ${lockKey}.lock beside the lock key, and the key
	// is the symlink referent, so a repository-planted link out of the scope would
	// otherwise create a lock directory outside the scope (and an unwritable referent
	// directory would surface a lock-acquisition error after retries instead of
	// ConfinedPathEscapeError). Repeated on the resolved publish target inside the
	// lock, since a peer writer may move the referent in between.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		_assertWithinScope(absoluteFilePath, await _resolveScopeRoot(lockKey), scopeRoot)
	}

	// Acquire the lock before any file operations. If acquisition fails it throws
	// immediately, and releaseLock stays a no-op so the finally block does not try
	// to release an unacquired lock.
	releaseLock = await acquireFileLock(lockKey)

	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

	try {
		// Resolve the publish target under the lock: the peer has committed by now, so
		// the strict dangling-link rejection still applies to a real dangling link. It
		// must stay inside the protected block, otherwise a rejection here leaves the
		// advisory lock held until the stale timeout for every other writer.
		resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

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
