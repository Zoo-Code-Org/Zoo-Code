import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { JsonStreamStringify } from "json-stream-stringify"


import { resolvePublishTarget, safeWriteText, type SafeWriteTextOptions } from "../services/file-safety/safeWriteText"


import { acquireFileLock } from "./fileLock"

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
	 * Refuse to publish through a symlink at the target path.
	 *
	 * By default a symlink target is resolved and the write lands on its referent,
	 * which is what keeps every alias of one file behind a single advisory lock.
	 * That is the wrong default for a payload whose destination the user chose -
	 * settings exports carry API credentials - where following a link they never
	 * pointed at would write secrets into a file they did not pick. When this is
	 * set, a symlink at the final path component is an error instead.
	 */
	refuseSymlinkTarget?: boolean
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
	try {
		await fs.mkdir(dirPath, { recursive: true })
		await fs.access(dirPath)
	} catch (dirError: any) {
		console.error(`Failed to create or access directory for ${absoluteFilePath}:`, dirError)
		throw dirError
	}

	// A credential-bearing payload must not be redirected through a link the user
	// never chose: check the final path component before anything is resolved,
	// staged, or locked.
	if (options?.refuseSymlinkTarget) {
		let targetStat: fsSync.Stats | undefined
		try {
			targetStat = await fs.lstat(absoluteFilePath)
		} catch (error: unknown) {
			const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined
			// Only a missing target means there is no link to refuse. Anything else -
			// a permission error on the parent directory, for example - is not evidence
			// that the destination is safe to publish into.
			if (code !== "ENOENT") {
				throw error
			}
		}
		if (targetStat?.isSymbolicLink()) {
			throw new Error(
				`safeWriteJson: refusing to write through the symlink at ${absoluteFilePath}; the payload would land on its referent instead of the destination the user chose.`,
			)
		}
	}

	// Resolve the publish target BEFORE acquiring the lock: proper-lockfile keys
	// the lock by the given path, so a symlink alias and its referent would
	// otherwise take two distinct locks for one underlying file - a concurrent
	// merge through both aliases could then read the same JSON and overwrite one
	// update. Locking the resolved referent coordinates every alias through one
	// lock. resolvePublishTarget tolerates a not-yet-existing file (it returns
	// the given path on ENOENT), preserving the previous create-from-absent flow.
	const resolvedTargetPath = await resolvePublishTarget(absoluteFilePath)

// The refusal above and this resolution are separate syscalls, so a local writer
// could replace the final component with a link in between; resolvedTargetPath
// would then describe a destination the caller never chose. Re-check the component
// the caller named - once here and again under the lock before publishing - so the
// refusal stays effective through publication.
const assertFinalComponentNotReplaced = async (stage: string): Promise<void> => {
	const nowStat = await fs.lstat(absoluteFilePath).catch(() => undefined)
	if (nowStat?.isSymbolicLink()) {
		throw new Error(
			`safeWriteJson: refusing to write through the symlink now at ${absoluteFilePath} (${stage}); the payload would land at ${resolvedTargetPath}, a destination the caller never chose.`,
		)
	}
}
if (options?.refuseSymlinkTarget) {
	await assertFinalComponentNotReplaced("after resolution")
}

	// Acquire the lock before any file operations. `acquireFileLock` owns the
	// shared advisory lock protocol, so callers that lock the same path with it
	// (for example task-history deletion) serialize with this write. It locks the
	// resolved publish target, which is the key every other writer to this file
	// uses. If acquisition fails it throws immediately, so the finally block never
	// releases an unacquired lock.
	releaseLock = await acquireFileLock(resolvedTargetPath)
	// Variables to hold the actual path of the temp file if it is created.
	let actualTempNewFilePath: string | null = null

	try {
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

		if (options?.refuseSymlinkTarget) {
			// Last chance to notice the destination was swapped for a link: everything the
			// caller asked for is staged and the commit rename follows the resolved path.
			await assertFinalComponentNotReplaced("before publication")
		}
		await safeWriteText(resolvedTargetPath, "", textOptions)

		// If we reach here, the new file is successfully in place and any
		// backup has already been handled by safeWriteText.
		actualTempNewFilePath = null
	} catch (originalError) {
		console.error(`Operation failed for ${resolvedTargetPath}: [Original Error Caught]`, originalError)

		const newFileToCleanupWithinCatch = actualTempNewFilePath

		// A failed safeWriteText already rolled the backup (if any) back to
		// the target path. Clean up the .new file if it still exists
		// (safeWriteText also cleans up its tempPath on failure; this is a
		// safety net in case its cleanup missed it).
		if (newFileToCleanupWithinCatch) {
			try {
				await fs.unlink(newFileToCleanupWithinCatch)
			} catch (cleanupError) {
				console.error(
					`[Catch] Failed to clean up temporary new file ${newFileToCleanupWithinCatch}:`,
					cleanupError,
				)
			}
		}

		throw originalError // This MUST be the error that rejects the promise.
	} finally {
		// Release the lock in the main finally block.
		try {
			await releaseLock()
		} catch (unlockError) {
			console.error(`Failed to release lock for ${resolvedTargetPath}:`, unlockError)
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
