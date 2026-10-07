import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"

import { acquireFileLock } from "./fileLock"
import {
	errorCode,
	PostCommitDurabilityError,
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
		if (errorCode(error) !== "ENOENT") {
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
				if (errorCode(innerError) !== "ENOENT") {
					throw innerError
				}
			}
		}
	}
}

/**
 * Whether `candidate` sits outside `scopeRoot`. The scope root itself counts as
 * outside: a file write cannot land on the directory that declares the scope.
 */
function _escapesScope(scopeRoot: string, candidate: string): boolean {
	const relative = path.relative(scopeRoot, candidate)
	return relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
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

	// Confinement is checked before ANY filesystem side effect. mkdir -p through a
	// planted symlinked ancestor (projectDir/.roo -> /elsewhere) would create
	// directories outside the declared scope, and an unwritable referent would surface
	// the mkdir error instead of the ConfinedPathEscapeError the caller is entitled to.
	// _resolveScopeRoot resolves a not-yet-existing path through its nearest existing
	// ancestor, so this works for the target's missing parents too.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		const requested = await _resolveScopeRoot(absoluteFilePath)
		if (_escapesScope(scopeRoot, requested)) {
			throw new ConfinedPathEscapeError(absoluteFilePath, requested, scopeRoot)
		}
	}

	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// Lock key: the symlink referent when the path is an existing symlink, so a
	// symlink alias and its referent share one lock. The key must stay computable while
	// a peer writer is mid-commit - the commit rename briefly leaves the path without
	// the referent it had when the walk started - so the walk tolerates a dangling link
	// instead of rejecting it here. (The backup itself is a copy: the target is never
	// renamed away, so a dangling link here means a peer's commit or an external
	// unlink, not a backup rename.)
	const lockKey = await resolveLockKey(absoluteFilePath)

	// Confinement is checked here as well as under the lock. The lock file lives NEXT
	// TO the key, so a planted symlink that points outside the declared scope would
	// first make this write create "<referent>.lock" outside that scope - a side effect
	// the caller declared it would not have - and if that directory is not writable the
	// caller would get a lock-acquisition error instead of the ConfinedPathEscapeError
	// it is entitled to. The key is the symlink referent, so this check sees the same
	// destination the lock would be taken on. The under-lock check stays: it covers the
	// target re-resolved after a peer commits.
	if (options?.confineTo) {
		const scopeRoot = await _resolveScopeRoot(options.confineTo)
		if (_escapesScope(scopeRoot, await _resolveScopeRoot(lockKey))) {
			throw new ConfinedPathEscapeError(absoluteFilePath, lockKey, scopeRoot)
		}
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
			if (_escapesScope(scopeRoot, await _resolveScopeRoot(resolvedTargetPath))) {
				throw new ConfinedPathEscapeError(absoluteFilePath, resolvedTargetPath, scopeRoot)
			}
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

		// Step 2: Delegate backup + commit to safeWriteText with the pre-written
		// temp path. backup:true makes safeWriteText COPY the target to a backup
		// before the commit rename; the target itself never moves, so there is no
		// rollback to undo. On win32 the DACL is dumped before that backup copy and
		// restored onto the directory after the commit rename.
		const textOptions: SafeWriteTextOptions = {
			tempPath: actualTempNewFilePath,
			backup: true,
		}

		try {
			await safeWriteText(resolvedTargetPath, "", textOptions)
		} catch (error: unknown) {
			// The commit rename already published the new JSON: only the durability of the
			// directory entry is unproven. safeWriteText keeps the previous-content copy on this
			// path and reports it on the error, so this caller - the one that always turns
			// backup on - owns that copy. The write is reported as committed, because the content
			// really is at the target and failing here would leave the caller's in-memory state
			// diverging from what is on disk; the copy is released best-effort so no hidden
			// .safeWriteText.bak_ file is left beside the target; and the durability caveat is
			// logged instead of swallowed. Any other error keeps the existing failure path.
			if (!(error instanceof PostCommitDurabilityError)) {
				throw error
			}
			if (error.backupPath) {
				await fs.unlink(error.backupPath).catch(() => {})
			}
			console.warn(
				`safeWriteJson: ${resolvedTargetPath ?? absoluteFilePath} is committed, but its directory entry may not be durable: ${
					error.cause instanceof Error ? error.cause.message : String(error.cause ?? error)
				}`,
			)
		}

		// If we reach here, the new file is successfully in place and any
		// backup has already been handled by safeWriteText.
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(
			`Operation failed for ${resolvedTargetPath ?? absoluteFilePath}: [Original Error Caught]`,
			originalError,
		)

		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// A pre-commit failure leaves the target untouched, and safeWriteText has
		// already removed its own backup copy and temp file (a POST-commit failure
		// keeps the backup on purpose and reports its path on the error). Clean up
		// the .new file if it still exists - safety net in case its cleanup missed it.
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError: unknown) {
				// The expected case: safeWriteText already removed its own temp file, so a
				// missing file here is not a cleanup failure worth logging. Returning would
				// also swallow the original error the caller needs.
				if (errorCode(cleanupError) !== "ENOENT") {
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
