/**
 * Guarded-write compare-and-swap core (upstream epic #1375, phase A4a).
 *
 * Wraps the S3 safeWriteText publish primitive behind version-token guards so
 * that every write is deterministic:
 *
 * - an unobserved target may only be created when it is absent
 *   (createIfAbsent);
 * - an observed target is published only when the on-disk version token still
 *   matches the token recorded at read time (replaceIfVersion);
 * - an edit-style write requires a prior observation (unobservedEditGuard).
 *
 * A per-absolute-path FIFO chain of tail promises orders concurrent
 * in-process writes to the same path: the first matching write wins, the rest
 * fail stale. Observations come from the task's S2 ObservationRegistry.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { resolvePublishTarget, safeWriteText } from "../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../utils/versionToken"
import { acquireFileLock } from "../../utils/fileLock"
import type { Task } from "../task/Task"

// -- Types ------------------------------------------------------------------

/** Write kind that drives guard selection. */
export type GuardedWriteKind = "create" | "update" | "edit"

/** Internal error thrown when a guard rejects a write. */
class GuardRejectedError extends Error {
	constructor(
		message: string,
		readonly path: string,
	) {
		super(message)
		this.name = "GuardRejectedError"
	}
}

/**
 * A queued guarded write reached the head of its path's chain after the task that
 * issued it had already been aborted or disposed. Task.dispose() sets the same
 * `abort` flag that abortTask() sets, so that flag is the disposal signal visible
 * at this layer.
 */
export class CancelledTaskWriteError extends Error {
	readonly path: string
	constructor(absolutePath: string) {
		super(
			`Guarded write for ${absolutePath} was cancelled -- the task was aborted or disposed ` +
				"before its turn in the per-path write queue; nothing was published.",
		)
		this.name = "CancelledTaskWriteError"
		this.path = absolutePath
	}
}

// -- Per-path tail-promise chain --------------------------------------------

/**
 * Per-absolute-path FIFO chain of pending guarded writes (tail promise per
 * path). Every write enqueues onto the current tail for its path, so
 * concurrent writes to the same path run one at a time in submission order.
 *
 * The chain never leaks a rejection through itself: each link settles, a
 * rejected link is skipped by the next writer (a failed write must not block
 * later writes to the same path), and every caller receives its own link
 * promise to handle.
 *
 * Settled entries are evicted (below), so a long-lived extension does not
 * accumulate a map entry per distinct written path.
 */
const pendingChains = new Map<string, Promise<unknown>>()

/**
 * Enqueue a write operation on the per-path FIFO chain.
 *
 * Returns the promise for this link; it always settles. A prior link that
 * rejected is skipped, not propagated. The map entry for this link is
 * deleted once it settles — but only while it is still the current tail for
 * the path, so a replacement enqueued in the meantime keeps ownership.
 */
function enqueue<T>(pathKey: string, fn: () => Promise<T>): Promise<T> {
	const prev = pendingChains.get(pathKey) ?? Promise.resolve()
	const next = prev.then(fn, fn)
	pendingChains.set(pathKey, next)
	void next.then(
		() => {
			if (pendingChains.get(pathKey) === next) {
				pendingChains.delete(pathKey)
			}
		},
		() => {
			if (pendingChains.get(pathKey) === next) {
				pendingChains.delete(pathKey)
			}
		},
	)
	return next
}

// -- Guard primitives --------------------------------------------------------

/**
 * Extract a Node errno code (e.g. "ENOENT") from a thrown value, or
 * undefined when the value carries none.
 */
function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/**
 * Run a guard check and its publish as one atomic step with respect to every writer
 * that honors the same advisory lock (safeWriteJson acquires it through fileLock).
 * Without the lock the version token can change between the check and the rename, so
 * a write that looked valid on the check can overwrite a newer file.
 */
async function withWriteLock<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
	// Lock the canonical publish target, not the caller's spelling of the path.
	// safeWriteJson resolves its publish target before locking, and acquireFileLock
	// runs with realpath:false, so an alias and its referent would otherwise take two
	// different lock files: a guarded write through the alias would not serialize with
	// a safeWriteJson publish through the referent and could overwrite it.
	const lockPath = await resolvePublishTarget(absolutePath)
	const release = await acquireFileLock(lockPath)
	try {
		return await run()
	} finally {
		await release()
	}
}

/** True when the path is absent on disk (fs.access reports ENOENT). */
async function fileIsAbsent(absolutePath: string): Promise<boolean> {
	try {
		await fs.access(absolutePath)
		return false
	} catch (error: unknown) {
		return errorCode(error) === "ENOENT"
	}
}

/**
 * Publish content only if the target file does not exist.
 *
 * Rejects with a loud remediation error when the file already exists: the
 * write was issued for a file that was never read, so the caller must read
 * the file first, then retry.
 */
export async function createIfAbsent(absolutePath: string, content: string): Promise<string> {
	return withWriteLock(absolutePath, async () => {
		try {
			await fs.access(absolutePath)
		} catch (error: unknown) {
			if (errorCode(error) !== "ENOENT") {
				// A real I/O failure (EACCES, EIO, ...) -- not a guard verdict.
				throw error
			}
			// Absent under the lock: no other lock-honoring writer can create it between
			// this check and the publish. A writer that does NOT honor the advisory lock can
			// still create the file while the staged copy is being written and fsynced, so
			// absence is re-asserted inside safeWriteText immediately before the commit
			// rename: the window then covers only that syscall, and the race surfaces as a
			// rejected write instead of silently clobbering whoever created the file.
			await safeWriteText(absolutePath, content, {
				preCommitVerify: async (targetPath) => {
					try {
						await fs.access(targetPath)
					} catch (error: unknown) {
						if (errorCode(error) === "ENOENT") {
							return
						}
						throw error
					}
					throw new GuardRejectedError(
						"File appeared at " +
							targetPath +
							" while this write was being staged -- read the file first, then retry.",
						absolutePath,
					)
				},
			})
			// Recomputed under the same lock: the caller records this as the new
			// observation, so a later write is compared against what this publish
			// actually wrote rather than against no observation at all.
			return computeVersionToken(absolutePath)
		}

		throw new GuardRejectedError(
			"File already exists at " +
				absolutePath +
				" and was not read before this write -- read the file first, then retry.",
			absolutePath,
		)
	})
}

/**
 * Publish content only if the current on-disk version token equals
 * expectedVersion (the token observed at read time).
 *
 * On a match the content is published via the S3 safeWriteText primitive; on
 * a mismatch the write is rejected stale with a re-read-then-retry
 * remediation suffix.
 */
export async function replaceIfVersion(
	absolutePath: string,
	expectedVersion: string,
	content: string,
): Promise<string> {
	return withWriteLock(absolutePath, async () => {
		let currentVersion: string
		try {
			currentVersion = await computeVersionToken(absolutePath)
		} catch (error: unknown) {
			if (errorCode(error) === "ENOENT") {
				// The observed file was deleted after the read: the version recorded
				// at read time no longer exists on disk. Normalize the raw ENOENT
				// into the guard's re-read-then-retry contract so the caller gets a
				// remediation it can act on, not a raw errno.
				throw new GuardRejectedError(
					"File was deleted after it was read -- the version recorded at read time (" +
						expectedVersion +
						") no longer exists; re-read the file, then retry.",
					absolutePath,
				)
			}
			// A real I/O failure (EACCES, EIO, ...) -- not a guard verdict.
			throw error
		}

		if (currentVersion === expectedVersion) {
			// The check and the publish run under the same lock, so the token cannot
			// change between them for any writer that honors it. A writer that does NOT
			// honor the advisory lock can still rewrite the file while the staged copy is
			// being written and fsynced, so the token is re-checked inside safeWriteText
			// immediately before the commit rename: the window then covers only that
			// syscall, and the race surfaces as a rejected stale write instead of a newer
			// version being replaced by the older one.
			await safeWriteText(absolutePath, content, {
				preCommitVerify: async (targetPath) => {
					let verifiedVersion: string
					try {
						verifiedVersion = await computeVersionToken(targetPath)
					} catch (error: unknown) {
						if (errorCode(error) === "ENOENT") {
							throw new GuardRejectedError(
								"File was deleted after it was read -- the version recorded at read time (" +
									expectedVersion +
									") no longer exists; re-read the file, then retry.",
								absolutePath,
							)
						}
						throw error
					}
					if (verifiedVersion !== expectedVersion) {
						throw new GuardRejectedError(
							"Stale version at commit time -- the file changed while this write was being " +
								"staged (expected " +
								expectedVersion +
								", current " +
								verifiedVersion +
								"); re-read the file, then retry.",
							absolutePath,
						)
					}
				},
			})
			// The publish moved the token; hand the new one back so the caller can
			// record it instead of leaving the read-time token in the registry.
			return computeVersionToken(absolutePath)
		}

		throw new GuardRejectedError(
			"Stale version -- the file changed since you read it (expected " +
				expectedVersion +
				", current " +
				currentVersion +
				"); re-read the file, then retry.",
			absolutePath,
		)
	})
}

/**
 * Unobserved-edit guard: an edit-style write without a prior observation is
 * rejected before any I/O. The literal-match / patch logic stays with the
 * tools in S4b; this guard only verifies that a read happened first.
 *
 * Returns Promise<never> because the rejection is total: this function
 * never resolves.
 */
export async function unobservedEditGuard(absolutePath: string): Promise<never> {
	throw new GuardRejectedError("File not read yet -- read the file, then retry.", absolutePath)
}

// -- Public API --------------------------------------------------------------

/**
 * Resolve a relative or absolute path against task.cwd.
 *
 * path.resolve also normalizes an already-absolute input (collapsing "." / ".."
 * segments and trailing separators), so the key always matches the
 * ObservationRegistry key recorded at read time (ReadFileTool observes under
 * path.resolve(task.cwd, relPath)) and two spellings of one file share one
 * FIFO chain.
 */
function resolveAbsolutePath(task: Task, relPathOrAbsolute: string): string {
	return path.resolve(task.cwd, relPathOrAbsolute)
}

/**
 * Guarded write entry point.
 *
 * 1. Resolves the absolute path against task.cwd.
 * 2. Consults the task's S2 observation registry to pick the guard:
 *    - unobserved + create/update: createIfAbsent (rejects if it exists);
 *    - observed + create on a file that vanished after the read: recreate;
 *    - observed otherwise: replaceIfVersion (CAS on the S1 version token);
 *    - unobserved + edit: unobservedEditGuard.
 * 3. Runs the chosen guard on the per-path FIFO chain so concurrent writes to
 *    the same path are deterministically ordered.
 */
export async function guardedWrite(
	task: Task,
	relPathOrAbsolute: string,
	content: string,
	kind: GuardedWriteKind = "update",
): Promise<void> {
	const absolutePath = resolveAbsolutePath(task, relPathOrAbsolute)

	// Snapshot the observation when the write is issued, not when its link runs.
	// A refresh after a publish must not retroactively validate a second write that
	// was issued against the pre-publish state: two concurrent writes to one path
	// still have exactly one winner.
	const obs = task.observationRegistry.get(absolutePath)

	return enqueue(absolutePath, async () => {
		// The link can reach the head of the queue long after the task that issued it is
		// gone (panel closed, task switched, abort landed while another write held the
		// path). Running it then would publish for a task that no longer serves requests
		// and re-observe the path, so the write stops here instead.
		if (task.abort) {
			throw new CancelledTaskWriteError(absolutePath)
		}

		let publishedVersion: string

		if (obs === undefined) {
			// Edit-style writes require a prior read: no observation, no write.
			if (kind === "edit") {
				await unobservedEditGuard(absolutePath)
			}
			// Never read: only an absent target may be created. (The edit guard
			// above rejects before reaching this line.)
			publishedVersion = await createIfAbsent(absolutePath, content)
		} else if (kind === "edit") {
			publishedVersion = await replaceIfVersion(absolutePath, obs.version, content)
		} else if (kind === "create" && (await fileIsAbsent(absolutePath))) {
			// kind is "create" or "update": a "create" on a file that vanished
			// after the read recreates it.
			publishedVersion = await createIfAbsent(absolutePath, content)
		} else {
			// Otherwise the version recorded at read time must still match the
			// on-disk token.
			publishedVersion = await replaceIfVersion(absolutePath, obs.version, content)
		}

		// The file on disk is now what this write published. Record that token: a
		// later guarded write must compare against it rather than the read-time (or,
		// for a created file, missing) token, which is what the result message
		// "you do not need to re-read the file" promises.
		task.observationRegistry.observe(absolutePath, publishedVersion)
	})
}

/**
 * Reset the per-path tail-promise chains (test hook).
 */
export function resetChain(): void {
	pendingChains.clear()
}
