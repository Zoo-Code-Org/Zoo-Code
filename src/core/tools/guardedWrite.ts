/**
 * Guarded-write compare-and-swap core (upstream epic #1375, phase A4a).
 *
 * Wraps the S3 safeWriteText publish primitive behind version-token guards so
 * that every write is deterministic:
 *
 * - an unobserved target may only be created when it is absent
 *   (createIfAbsent);
 * - an observed target is published only when the on-disk version token still
 *   matches the current observation token (replaceIfVersion);
 * - an edit-style write requires a prior observation (unobservedEditGuard).
 *
 * A per-absolute-path FIFO chain of tail promises orders concurrent
 * in-process writes to the same path. Each publish refreshes the observation to
 * the token it wrote when the new token can be computed, so same-task writes
 * apply last-write-wins; when that refresh fails the observation keeps the
 * previous observation token. A write that goes through replaceIfVersion fails
 * stale when the on-disk token differs from the token the observation currently
 * holds; an observed "create" whose target has disappeared instead uses
 * createIfAbsent and can recreate it. Observations come from the task's S2
 * ObservationRegistry and authorize the write as well as the version check.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteText, TargetExistsError, type DirectoryIdentity } from "../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../utils/versionToken"
import { withFileLock } from "../../utils/fileLock"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"
import type { Task } from "../task/Task"

// -- Types ------------------------------------------------------------------

/** Write kind that drives guard selection. */
export type GuardedWriteKind = "create" | "update" | "edit"

/** Error thrown when a guard rejects a write. Exported so a caller can tell a guard verdict from an unrelated failure.
 */
export class GuardRejectedError extends Error {
	constructor(
		message: string,
		readonly path: string,
	) {
		super(message)
		this.name = "GuardRejectedError"
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
const pendingChains = new Map<string, Promise<void>>()

/**
 * Enqueue a write operation on the per-path FIFO chain.
 *
 * Returns the promise for this link; it always settles. A prior link that
 * rejected is skipped, not propagated. The map entry for this link is
 * deleted once it settles — but only while it is still the current tail for
 * the path, so a replacement enqueued in the meantime keeps ownership.
 */
function enqueue(pathKey: string, fn: () => Promise<void>): Promise<void> {
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
export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as { code?: string }).code
		: undefined
}

/**
 * Cancellation re-check under the publish lock. A write queued on the FIFO
 * chain can outlive its task: the caller already reported the write to the model,
 * so a task aborted while its link waited must not publish afterwards.
 */
function cancelledBeforePublish(absolutePath: string, displayPath: string, isCancelled?: () => boolean): void {
	if (isCancelled?.()) {
		throw new GuardRejectedError(
			"Task was cancelled before this write published -- nothing was written.",
			displayPath,
		)
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
/**
 * Read the on-disk token after a publish, best-effort: a publish that
 * succeeded is not undone by a failed stat, so the caller keeps the publish
 * and only skips the observation refresh.
 */
async function tokenAfterPublish(absolutePath: string): Promise<string | undefined> {
	return computeVersionToken(absolutePath).catch(() => undefined)
}

export async function createIfAbsent(
	absolutePath: string,
	content: string | Uint8Array,
	displayPath: string,
	// Re-checked under the lock: a link that waited on the FIFO chain can outlive
	// the task that queued it.
	isCancelled?: () => boolean,
	// Re-checked under the lock, immediately before the publish: the path was authorized
	// when it was queued, but a symlink can be swapped in while the link waited on the
	// FIFO chain or on this lock.
	// Resolves the path again and returns the authorized target plus the directory
	// identities it was authorized against, so the publish can pin both.
	verifyTarget?: () => Promise<AuthorizedTarget>,
): Promise<string | undefined> {
	// Lock the key every other writer to this file uses: the resolved publish
	// target, so a symlink alias and its referent share one lock.
	return withFileLock(await resolveLockKey(absolutePath), async () => {
		cancelledBeforePublish(absolutePath, displayPath, isCancelled)
		try {
			await fs.access(absolutePath)
		} catch (error: unknown) {
			if (errorCode(error) !== "ENOENT") {
				// A real I/O failure (EACCES, EIO, ...) -- not a guard verdict.
				throw error
			}
			// Immediately before publication starts.
			cancelledBeforePublish(absolutePath, displayPath, isCancelled)
			const authorized = await verifyTarget?.()
			// No-replace commit. The access check above only proves absence at the moment
			// it runs: a writer that never takes the advisory lock can create the target
			// before this publish, and a plain rename would silently replace that newer
			// file. The commit is therefore a link that fails EEXIST, and the collision is
			// reported as the same guard verdict the pre-check produces.
			try {
				await safeWriteText(absolutePath, content, {
					failIfExist: true,
					expectedResolvedPath: authorized?.target,
					expectedAncestorIdentities: authorized?.ancestors,
				})
			} catch (error: unknown) {
				if (error instanceof TargetExistsError) {
					throw new GuardRejectedError(
						"File already exists at " +
							displayPath +
							" and was not read before this write -- read the file first, then retry.",
						displayPath,
					)
				}
				throw error
			}
			// Read the new token under the same lock, otherwise a peer lock-using
			// writer can publish in the gap and the caller records that writer's
			// token as its own observation.
			return tokenAfterPublish(absolutePath)
		}

		throw new GuardRejectedError(
			"File already exists at " +
				displayPath +
				" and was not read before this write -- read the file first, then retry.",
			displayPath,
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
 *
 * Atomicity boundary: the check and the publish run inside one acquisition of the
 * shared advisory lock, and the post-publish token is read under that same lock, so
 * no writer that participates in the protocol can interleave here. Every production
 * caller of the publish primitive holds the same canonical key (safeWriteJson
 * acquires it before publishing; TaskHistoryStore deletion takes it on the same
 * resolved key). The primitive itself cannot re-acquire the lock -- withFileLock must
 * not be re-entered inside an operation, and the callers already hold it, so wrapping
 * it would deadlock them. A writer that never takes the lock is outside the supported
 * threat model: a plain rename has no conditional form, so no advisory mechanism can
 * bind a checked version to it.
 */
export async function replaceIfVersion(
	absolutePath: string,
	expectedVersion: string,
	content: string | Uint8Array,
	// Re-checked under the lock: a link that waited on the FIFO chain can outlive
	// the task that queued it.
	displayPath: string,
	isCancelled?: () => boolean,
	// Re-checked under the lock, immediately before the publish: the path was authorized
	// when it was queued, but a symlink can be swapped in while the link waited on the
	// FIFO chain or on this lock.
	// Resolves the path again and returns the authorized target plus the directory
	// identities it was authorized against, so the publish can pin both.
	verifyTarget?: () => Promise<AuthorizedTarget>,
): Promise<string | undefined> {
	// Lock the key every other writer to this file uses: the resolved publish
	// target, so a symlink alias and its referent share one lock.
	return withFileLock(await resolveLockKey(absolutePath), async () => {
		cancelledBeforePublish(absolutePath, displayPath, isCancelled)
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
					displayPath,
				)
			}
			// A real I/O failure (EACCES, EIO, ...) -- not a guard verdict.
			throw error
		}

		// Re-checked after the awaited preflight: the task can be aborted while this
		// operation waits, and a publish that starts after that is a write the caller
		// has already reported as not performed.
		cancelledBeforePublish(absolutePath, displayPath, isCancelled)

		if (currentVersion === expectedVersion) {
			// Immediately before publication starts.
			cancelledBeforePublish(absolutePath, displayPath, isCancelled)
			const authorized = await verifyTarget?.()
			await safeWriteText(absolutePath, content, {
				expectedResolvedPath: authorized?.target,
				expectedAncestorIdentities: authorized?.ancestors,
			})
			// Read the new token under the same lock, otherwise a peer lock-using
			// writer can publish in the gap and the caller records that writer's
			// token as its own observation.
			return tokenAfterPublish(absolutePath)
		}

		throw new GuardRejectedError(
			"Stale version -- the file changed since you read it (expected " +
				expectedVersion +
				", current " +
				currentVersion +
				"); re-read the file, then retry.",
			displayPath,
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
export async function unobservedEditGuard(absolutePath: string, displayPath: string): Promise<never> {
	throw new GuardRejectedError("File not read yet -- read the file, then retry.", displayPath)
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
 * Reject a target that is not inside the task's workspace, before anything is
 * queued or touched. path.resolve keeps an absolute input unchanged and collapses
 * ".." segments, so a model-supplied string forwarded verbatim can name any path
 * on the machine. The rooignore rules, protected-path rules and the user-approval
 * flow live in the tool layer; this is the containment line inside the publish
 * helper itself, so a caller that forgets them cannot publish outside the
 * workspace by accident.
 */
function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target)
	return !(
		relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
	)
}

function assertInsideWorkspace(task: Task, absolutePath: string, displayPath: string): void {
	if (!isInside(path.resolve(task.cwd), absolutePath)) {
		throw new GuardRejectedError(
			`Path resolves outside the workspace -- write inside the workspace, then retry.`,
			displayPath,
		)
	}
}

/**
 * The lexical check above cannot see a symlink whose referent leaves the workspace, and
 * the publish resolves through that link. Resolve both sides the same way and compare
 * again. Only a missing TARGET is walked up to the nearest existing ancestor (a create
 * has no target yet); a workspace that cannot be resolved - for any reason, ENOENT
 * included - is rejected rather than falling back to the lexical decision, because the
 * lexical decision is exactly what a symlink defeats. An unresolvable root means there
 * is no canonical container to check against, so the write is refused instead of
 * published on a weaker guarantee.
 *
 * The check also records the identity (dev, ino) of every directory it walked from the
 * workspace root down to the target's parent. expectedResolvedPath pins the NAME that
 * gets published; it cannot notice a parent directory being swapped for a link. The pin
 * lets the guard notice that.
 */
async function assertCanonicalInsideWorkspace(
	task: Task,
	absolutePath: string,
	displayPath: string,
): Promise<AuthorizedTarget> {
	let workspaceRoot: string
	try {
		workspaceRoot = await fs.realpath(path.resolve(task.cwd))
	} catch {
		throw new GuardRejectedError(
			"Workspace could not be resolved, so this write cannot be checked against it -- retry with a path inside the workspace.",
			displayPath,
		)
	}
	const target = await realpathNearest(absolutePath, displayPath)
	if (!isInside(workspaceRoot, target)) {
		throw new GuardRejectedError(
			`Path resolves through a link to outside the workspace -- write a real file inside the workspace, then retry.`,
			displayPath,
		)
	}
	return { target, ancestors: await ancestorIdentities(workspaceRoot, target) }
}

/**
 * The directories between the canonical workspace root and the target's parent, each
 * with the identity it had when the write was authorized. A component that does not
 * exist yet (a create into a directory that will be made by the publish) has no
 * identity to pin, so it is skipped; every component that DID exist is pinned.
 */
async function ancestorIdentities(root: string, target: string): Promise<DirectoryIdentity[]> {
	const parent = path.dirname(target)
	const relative = path.relative(root, parent)
	const chain: string[] = [root]
	if (relative && relative !== "." && !relative.startsWith(".." + path.sep)) {
		let cursor = root
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

/**
 * What the canonical containment check decided, and the directory identities that
 * decision was made about. The publish has to be refused when either drifts.
 */
export type AuthorizedTarget = {
	target: string
	ancestors: DirectoryIdentity[]
}

async function realpathNearest(target: string, displayPath: string): Promise<string> {
	const lexical = path.resolve(target)
	try {
		return await fs.realpath(lexical)
	} catch (error: unknown) {
		if (errorCode(error) !== "ENOENT") {
			throw new GuardRejectedError(
				"Path could not be resolved, so it cannot be checked against the workspace -- retry with a path inside the workspace.",
				displayPath,
			)
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
					throw new GuardRejectedError(
						"Path could not be resolved, so it cannot be checked against the workspace -- retry with a path inside the workspace.",
						displayPath,
					)
				}
				// "Missing" has two meanings and only one of them is benign. A directory
				// that has not been created yet is fine - the publish makes it. A component
				// that EXISTS as a symlink whose referent is gone is a dangling link: the
				// lexical name would be re-joined onto a container that points elsewhere
				// (or nowhere), and the publish would then create the file outside the
				// directory this check authorized.
				const asLink = await fs.lstat(ancestor, { bigint: true }).catch(() => undefined)
				if (asLink?.isSymbolicLink()) {
					throw new GuardRejectedError(
						`Path runs through a link (${ancestor}) that does not resolve -- retry with a path inside the workspace.`,
						displayPath,
					)
				}
			}
		}
	}
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
 * 3. A full-file replacement ("update", or a "create" whose target still
 *    exists) additionally requires a complete observation: a partial read
 *    (slice, range, truncated, indentation block) authorizes targeted edits
 *    only, never a full-file overwrite of the existing content.
 * 4. Runs the chosen guard on the per-path FIFO chain so concurrent writes to
 *    the same path are deterministically ordered.
 * 5. After a successful publish, refreshes the observation with the new
 *    on-disk token (complete) so consecutive writes by the same task do not
 *    fail stale against the version they just published.
 */
export async function guardedWrite(
	task: Task,
	relPathOrAbsolute: string,
	content: string | Uint8Array,
	kind: GuardedWriteKind = "update",
	// Optional completeness for the refresh. A tool that built its content from a
	// view of another file must carry that view's completeness through the publish
	// instead of claiming completeness for lines it never read.
	completeOverride?: boolean,
): Promise<void> {
	const absolutePath = resolveAbsolutePath(task, relPathOrAbsolute)
	// Model-facing path: the caller's own spelling, not the resolved absolute
	// path. The guard key stays absolute, but a rejection must not put a
	// user-specific absolute path into the model's context.
	const displayPath = relPathOrAbsolute

	// Captured before the FIRST await in this function. The chain is FIFO, so this write
	// may not run until long after it was submitted, and task.abort can be raised and then
	// cleared by a resume in the meantime; the generation is what tells the two apart.
	// Capturing it after the containment awaits would leave a cancel that lands during
	// those awaits invisible: the write would capture the POST-cancel generation, sail
	// through the dequeue comparison, and publish work that belongs to the cancelled run.
	const cancellationGeneration = task.cancellationGeneration
	if (task.abort) {
		throw new GuardRejectedError(
			"Task was cancelled before this write ran -- the queued publish is not performed.",
			displayPath,
		)
	}

	// Containment is decided before the link is queued: a write that would land
	// outside the workspace must not take a slot on the FIFO chain, take the file
	// lock, or touch the filesystem at all.
	assertInsideWorkspace(task, absolutePath, displayPath)
	// Bound to the task and the caller's spelling so the guard can re-run the same
	// decision under the lock, immediately before the publish. The first call records
	// what was authorized; every later call has to agree with it, or the publish is
	// acting on a decision that was never made about the file now at this name.
	let pin: AuthorizedTarget | undefined
	const verifyTarget = async (): Promise<AuthorizedTarget> => {
		const fresh = await assertCanonicalInsideWorkspace(task, absolutePath, displayPath)
		if (!pin) {
			pin = fresh
			return fresh
		}
		if (fresh.target !== pin.target) {
			throw new GuardRejectedError(
				"Path changed between the containment check and the publish -- nothing was written.",
				displayPath,
			)
		}
		for (const expected of pin.ancestors) {
			const current = await fs.stat(expected.dir, { bigint: true }).catch(() => undefined)
			if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
				throw new GuardRejectedError(
					"A directory on the authorized path was replaced after this write was checked -- nothing was written.",
					displayPath,
				)
			}
		}
		return fresh
	}
	await verifyTarget()

	return enqueue(absolutePath, async () => {
		// Cancellation is checked when the link is dequeued, not when it was enqueued:
		// a write queued before an abort can still reach its turn on the chain after the
		// task is gone, and the caller has already reported the write to the model. The
		// generation is compared as well because abort is a mutable flag: a cancel followed
		// by a resume while this link waited leaves abort false again, and the write still
		// belongs to the cancelled run.
		if (task.abort || task.cancellationGeneration !== cancellationGeneration) {
			throw new GuardRejectedError(
				"Task was cancelled before this write ran -- the queued publish is not performed.",
				displayPath,
			)
		}
		const obs = task.observationRegistry.get(absolutePath)
		// A targeted edit authorizes only the view the model saw, so a partial
		// observation stays partial; a full-file publish is complete.
		let staysPartial = false
		// Token the guard read under the lock, so the refresh records the token
		// this write published rather than a peer writer's.
		let publishedToken: string | undefined

		if (kind === "edit") {
			// Edit-style writes require a prior read: no observation, no write.
			// A targeted edit only authorizes the view the model saw, so a
			// partial observation is valid for the edit itself; the version
			// check still rejects a file that moved since the read.
			if (obs === undefined) {
				await unobservedEditGuard(absolutePath, displayPath)
			} else {
				publishedToken = await replaceIfVersion(
					absolutePath,
					obs.version,
					content,
					displayPath,
					() => task.abort || task.cancellationGeneration !== cancellationGeneration,
					verifyTarget,
				)
				staysPartial = obs.complete === false
			}
		} else {
			// "create" or "update" publish a full file built on the model's
			// content. A replacement of an existing target -- an "update", or a
			// "create" whose target is still on disk -- therefore requires a
			// complete observation: a slice, range, truncated, or
			// indentation-block read only authorizes the view the model saw, and
			// publishing over the existing file would silently drop everything
			// the model never read, so the guard fails closed with a
			// re-read-the-whole-file remediation. A fresh create (absent target)
			// needs no prior read and stays allowed.
			const absent = kind === "create" && (await fileIsAbsent(absolutePath))
			if (!absent && obs !== undefined && obs.complete === false) {
				throw new GuardRejectedError(
					"File was only partially read (line slice, range, truncated view, or indentation block) -- " +
						"a full-file replacement needs the complete content; re-read the whole file, then retry.",
					displayPath,
				)
			}

			if (obs === undefined) {
				// Never read: only an absent target may be created.
				publishedToken = await createIfAbsent(absolutePath, content, displayPath, () => task.abort || task.cancellationGeneration !== cancellationGeneration, verifyTarget)
			} else if (absent) {
				// A "create" on a file that vanished after the read recreates it.
				publishedToken = await createIfAbsent(absolutePath, content, displayPath, () => task.abort || task.cancellationGeneration !== cancellationGeneration, verifyTarget)
			} else {
				// The version recorded at read time must still match the on-disk
				// token.
				publishedToken = await replaceIfVersion(
					absolutePath,
					obs.version,
					content,
					displayPath,
					() => task.abort || task.cancellationGeneration !== cancellationGeneration,
					verifyTarget,
				)
			}
		}

		// A publish changes the on-disk token (the rename changes ino, size, and
		// mtime). The model just wrote the full content, so refresh the
		// observation with the new token: a consecutive write by the same task
		// must not fail stale against the version it just published.
		// The guard already read the token under the lock; a failed stat after a
		// successful publish only skips the refresh, it does not undo the publish.
		if (publishedToken !== undefined) {
			// Refresh with the new token, keeping the completeness the guard
			// established: a partial observation that authorized a targeted edit
			// must stay partial, otherwise a later full-file replacement would
			// publish content built from the slice alone.
			task.observationRegistry.observe(absolutePath, publishedToken, completeOverride ?? !staysPartial)
		}
	})
}

/**
 * Reset the per-path tail-promise chains (test hook).
 */
export function resetChain(): void {
	pendingChains.clear()
}
