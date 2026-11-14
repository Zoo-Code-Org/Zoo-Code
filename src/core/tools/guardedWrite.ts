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

import { PostCommitDurabilityError, safeWriteText } from "../../services/file-safety/safeWriteText"
import { computeVersionToken } from "../../utils/versionToken"
import { withFileLock } from "../../utils/fileLock"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"
import { resolvePublishTarget } from "../../services/file-safety/safeWriteText"
import type { Task } from "../task/Task"

/**
 * Local copies of the era lock-key derivation the guarded-publish flow needs
 * (canonical parent directory, final component never canonicalized, so a symlinked
 * alias locks under its alias key while the publish acts on the retained target
 * under the canonical key). The U5-lineage safeWriteText carries resolveLockKey but
 * never exported this pair; guardedWrite (U8's own surface) is the only consumer,
 * so the helpers live here rather than across the module boundary.
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

async function resolveLinkPathLockKey(absoluteFilePath: string): Promise<string> {
	return await canonicalDirKey(path.resolve(absoluteFilePath))
}

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

/**
 * The compare-and-swap rejection whose only cause is that the version token moved.
 *
 * Every other rejection in this module is a statement about the caller's authorization or about
 * the target's identity: the file was never read, it was deleted, the link moved, the target is
 * outside the workspace. This one says the bytes handed to the guard were authorized and a
 * different token is now on disk, which is the only shape a caller may read as "the publish I
 * wanted has already happened". Adoption is gated on it so a matching read cannot stand in for a
 * rejection that says nothing about this write's content.
 */
export class GuardStaleVersionError extends GuardRejectedError {
	constructor(message: string, path: string) {
		super(message, path)
		this.name = "GuardStaleVersionError"
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
 * Read the on-disk token after a publish, best-effort: a publish that
 * succeeded is not undone by a failed stat, so the caller keeps the publish
 * and only skips the observation refresh.
 */
async function tokenAfterPublish(absolutePath: string): Promise<string | undefined> {
	return computeVersionToken(absolutePath).catch(() => undefined)
}

/**
 * The token a publish landed with when its commit rename succeeded but the
 * durability check after it failed. Keyed by the error the guard rethrows, so
 * the reconciliation in guardedWrite can follow the disk without adopting a
 * peer writer's token: the guard reads it under the same lock it published
 * under, and an error that is not this write's simply has no entry.
 */
const landedPublishTokens = new WeakMap<Error, string>()

/**
 * Called by a guard when its publish rejects. A PostCommitDurabilityError means
 * the rename already placed the bytes at the target, so record the token that
 * landed publish wrote before the error leaves the lock. A failed stat only
 * skips the recording: it does not change the error the caller receives, and it
 * must not turn a landed publish into one that is forgotten.
 */
async function recordLandedPublish(absolutePath: string, error: unknown): Promise<void> {
	if (error instanceof PostCommitDurabilityError) {
		const token = await tokenAfterPublish(absolutePath)
		if (token !== undefined) {
			landedPublishTokens.set(error, token)
		}
	}
}

/** The token a landed-but-not-durable publish wrote, or undefined for any other failure. */
function landedPublishToken(error: unknown): string | undefined {
	return error instanceof PostCommitDurabilityError ? landedPublishTokens.get(error) : undefined
}

/**
 * Publish content only if the target file does not exist.
 *
 * Rejects with a loud remediation error when the file already exists: the
 * write was issued for a file that was never read, so the caller must read
 * the file first, then retry.
 */
/**
 * Resolve and retain the publish target inside the guard lock. The version
 * comparison and the publish must act on ONE fixed target: re-resolving the
 * caller's alias at publish time lets a symlink retargeted after the caller's
 * allowlist check send the write to a file that check never covered. A dangling
 * link falls back to the given path, so the existence/version checks below
 * produce the guard's normalized verdicts rather than a raw errno.
 */
async function fixedPublishTarget(absolutePath: string): Promise<string> {
	return resolvePublishTarget(absolutePath).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
			return absolutePath
		}
		throw error
	})
}

/**
 * How many times a guarded write re-takes its locks when a peer retargets the alias while
 * this write holds them. Three acquisitions cover a protocol writer that swaps the link once
 * and a second writer that queues behind it; a target that keeps moving is a livelock, and
 * the write reports it as a guard rejection instead of looping.
 */
const MAX_LOCK_REACQUISITIONS = 3

/**
 * Internal signal: the retained publish target names a file whose lock this write does not
 * hold. Thrown only from the innermost lock, so withFileLock unwinds and releases every held
 * lock before the retry, and never escapes withBothIdentityLocks.
 */
class TargetOutsideHeldLocksError extends Error {
	constructor(
		readonly targetKey: string,
		readonly heldKeys: readonly string[],
	) {
		super(`publish target ${targetKey} is not covered by the held locks ${heldKeys.join(", ")}`)
		this.name = "TargetOutsideHeldLocksError"
	}
}

/**
 * Acquire the advisory locks covering BOTH identities of a guarded write:
 * the resolved referent key every writer to the file uses, and the alias
 * entry key (resolveLinkPathLockKey: canonical parent, final component never
 * followed) that a protocol writer swapping the link itself holds - the same
 * pair and folding safeWriteJson's dual-link path uses. Distinct keys are
 * taken in sorted order, the shared order of that path, so two guarded
 * writes can never deadlock, and withFileLock's own unwinding releases them
 * inner-first.
 *
 * The publish target is fixed INSIDE those locks and handed to the operation, which must
 * write exactly that path: the version comparison and the publish act on one target, so a
 * symlink retargeted after the caller's allowlist check cannot send the write to a file that
 * check never covered.
 *
 * The key of THAT target is then re-derived under the same locks. Both keys above were
 * computed from the alias before any lock was held, so a peer that replaces the alias while
 * this write is queued - or while it waits behind the FIFO chain - leaves this write holding
 * the OLD referent's lock and the alias entry's lock, while the target it is about to publish
 * is a different file whose lock belongs to some other writer. Writing it would race that
 * writer outright and ship bytes into a path the caller's authorization never covered. When
 * that happens the helper unwinds (inner lock first), takes the locks again against the
 * alias's CURRENT referent, and re-runs the check; after MAX_LOCK_REACQUISITIONS it rejects
 * the write rather than chasing a moving target.
 */
async function withBothIdentityLocks<T>(
	absolutePath: string,
	// The caller's spelling is what the model gets to see: the resolved path under a symlinked or aliased
	// workspace is a user-specific absolute path, and it has no business in model-facing text.
	displayPath: string,
	operation: (retainedTarget: string) => Promise<T>,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const referentKey = await resolveLockKey(absolutePath)
		const aliasKey = await resolveLinkPathLockKey(absolutePath)
		const heldKeys = aliasKey === referentKey ? [referentKey] : [aliasKey, referentKey]
		const lockOrder = [...heldKeys].sort()

		const runUnderLocks = async (index: number): Promise<T> => {
			if (index === lockOrder.length) {
				const retainedTarget = await fixedPublishTarget(absolutePath)
				const retainedKey = await resolveLockKey(retainedTarget)
				if (!heldKeys.includes(retainedKey)) {
					throw new TargetOutsideHeldLocksError(retainedKey, heldKeys)
				}
				return operation(retainedTarget)
			}
			return withFileLock(lockOrder[index], () => runUnderLocks(index + 1))
		}

		try {
			return await runUnderLocks(0)
		} catch (error: unknown) {
			if (!(error instanceof TargetOutsideHeldLocksError)) {
				throw error
			}
			if (attempt >= MAX_LOCK_REACQUISITIONS) {
				// Both halves of this rejection reach the model: the message and the error's path field carry the
				// caller's own spelling of the file rather than the resolved referent, which under an alias is a
				// user-specific absolute path.
				throw new GuardRejectedError(
					"File was retargeted while this write was queued -- nothing was published; re-read " +
						displayPath +
						" and retry.",
					displayPath,
				)
			}
		}
	}
}

export async function createIfAbsent(
	absolutePath: string,
	content: string | Uint8Array,
	displayPath: string,
	// Re-checked under the lock: a link that waited on the FIFO chain can outlive
	// the task that queued it.
	isCancelled?: () => boolean,
	// Called under the lock with the RETAINED publish target before any check:
	// the caller's allowlist decision was made about the alias, and a link
	// retargeted (or a hard-link alias swapped in) since then names a different
	// file. The callback re-runs the access decision on the retained target and
	// throws to stop the publish.
	authorizeTarget?: (retainedTarget: string) => void,
): Promise<string | undefined> {
	// Lock both identities of the write: the resolved referent every other
	// writer to this file uses, and the alias entry a link-swapping protocol
	// writer holds.
	return withBothIdentityLocks(absolutePath, displayPath, async (publishTarget) => {
		cancelledBeforePublish(absolutePath, displayPath, isCancelled)
		// publishTarget is the retained target the helper fixed under the held locks and verified
		// those locks cover.
		authorizeTarget?.(publishTarget)
		try {
			await fs.access(publishTarget)
		} catch (error: unknown) {
			if (errorCode(error) !== "ENOENT") {
				// A real I/O failure (EACCES, EIO, ...) -- not a guard verdict.
				throw error
			}
			// Immediately before publication starts.
			cancelledBeforePublish(absolutePath, displayPath, isCancelled)
			try {
				// The retained target was resolved under the held locks: the publish acts on it as given
				// rather than resolving the alias a second time.
				await safeWriteText(publishTarget, content, { backup: true })
			} catch (error: unknown) {
				// A rename that landed before the durability check failed still placed the
				// bytes at the target: hand the token up before the error leaves the lock.
				await recordLandedPublish(publishTarget, error)
				throw error
			}
			// Read the new token under the same lock, otherwise a peer lock-using
			// writer can publish in the gap and the caller records that writer's
			// token as its own observation.
			return tokenAfterPublish(publishTarget)
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
	displayPath: string,
	// Re-checked under the lock: a link that waited on the FIFO chain can outlive
	// the task that queued it.
	isCancelled?: () => boolean,
	// Called under the lock with the RETAINED publish target before the version
	// comparison: the caller's allowlist decision was made about the alias, and
	// a link retargeted (or a hard-link alias swapped in) since then names a
	// different file. The callback re-runs the access decision on the retained
	// target and throws to stop the publish.
	authorizeTarget?: (retainedTarget: string) => void,
): Promise<string | undefined> {
	// Lock both identities of the write: the resolved referent every other
	// writer to this file uses, and the alias entry a link-swapping protocol
	// writer holds.
	return withBothIdentityLocks(absolutePath, displayPath, async (publishTarget) => {
		cancelledBeforePublish(absolutePath, displayPath, isCancelled)
		// publishTarget is fixed under the held locks and verified to be covered by them: the
		// version comparison and the publish below both act on this one target, so a symlink
		// retargeted after the caller's allowlist check cannot send the write to a file the
		// version check never covered.
		authorizeTarget?.(publishTarget)
		let currentVersion: string
		try {
			currentVersion = await computeVersionToken(publishTarget)
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
			try {
				// The retained target was resolved under the held locks: the publish acts on it as given
				// rather than resolving the alias a second time.
				await safeWriteText(publishTarget, content, { backup: true })
			} catch (error: unknown) {
				// A rename that landed before the durability check failed still placed the
				// bytes at the target: hand the token up before the error leaves the lock.
				await recordLandedPublish(publishTarget, error)
				throw error
			}
			// Read the new token under the same lock, otherwise a peer lock-using
			// writer can publish in the gap and the caller records that writer's
			// token as its own observation.
			return tokenAfterPublish(publishTarget)
		}

		throw new GuardStaleVersionError(
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
 * Whether `candidate` resolves inside `root`. Used to keep a symlink-retargeted
 * publish target inside the workspace when the caller's alias is inside it.
 */
function isInsideDirectory(root: string, candidate: string): boolean {
	// Compare forward-slash forms so the check works for Windows and POSIX roots
	// alike without relying on path.relative (test doubles may not provide it).
	const toForward = (value: string): string => value.replace(/\\/g, "/")
	const normalizedRoot = toForward(path.resolve(root)).replace(/\/+$/, "")
	const normalizedCandidate = toForward(path.resolve(candidate))
	const compareRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot
	const compareCandidate = process.platform === "win32" ? normalizedCandidate.toLowerCase() : normalizedCandidate
	return compareCandidate === compareRoot || compareCandidate.startsWith(`${compareRoot}/`)
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
): Promise<string | undefined> {
	const absolutePath = resolveAbsolutePath(task, relPathOrAbsolute)
	// Model-facing path: the caller's own spelling, not the resolved absolute
	// path. The guard key stays absolute, but a rejection must not put a
	// user-specific absolute path into the model's context.

	return enqueue(absolutePath, async () => {
		// Cancellation is checked when the link is dequeued, not when it was enqueued:
		// a write queued before an abort can still reach its turn on the chain after the
		// task is gone, and the caller has already reported the write to the model.
		const displayPath = relPathOrAbsolute
		// The tool layer validated the caller's alias before the write; re-run that
		// decision on the retained publish target under the lock, so a link
		// retargeted after the tool's check - or a hard-link alias whose new
		// referent the version token cannot tell apart - cannot send the approved
		// bytes to an ignored or external file.
		// Canonical workspace root and alias: resolvePublishTarget returns a real path,
		// while absolutePath is lexical. A workspace whose path contains a symlinked
		// ancestor would otherwise compare a real target against a lexical root and
		// reject an in-workspace write. Both fall back to the lexical form when the
		// filesystem cannot resolve them.
		const canonicalWorkspaceRoot = await fs.realpath(task.cwd).catch(() => path.resolve(task.cwd))
		// realpath only resolves a name when every component of it exists, so the ordinary case of a
		// write that creates its own file lands in the fallback: the final component is absent. The
		// lexical spelling is not a canonical alias - a workspace reached through a link directory or
		// a Windows 8.3 short name canonicalizes to a root the alias's own spelling cannot match - and
		// the clause below only binds the retained target when the alias is inside the canonical root.
		// Falling back to the lexical form therefore skipped containment for exactly the writes that
		// create a file inside an aliased workspace. Walk up to the deepest ancestor that does resolve
		// and re-join the components that are still missing, which is the shape resolvePublishTarget
		// now uses for the publish target, so the alias and the target are canonicalized alike.
		const canonicalAlias = await fs.realpath(absolutePath).catch(async () => {
			let cursor = path.dirname(absolutePath)
			const missing: string[] = []
			for (;;) {
				const resolvedAncestor = await fs.realpath(cursor).catch(() => undefined)
				if (resolvedAncestor !== undefined) {
					return path.join(resolvedAncestor, ...missing.reverse(), path.basename(absolutePath))
				}
				missing.push(path.basename(cursor))
				const parent = path.dirname(cursor)
				// Nothing above resolves either: the lexical path is the only canonical form left.
				if (parent === cursor) {
					return path.resolve(absolutePath)
				}
				cursor = parent
			}
		})
		// A relative task path is workspace-scoped in its *lexical* spelling: the caller named it relative
		// to task.cwd and the tool layer approved it as an in-workspace path. Canonicalizing such a path
		// can still land outside the workspace - the ordinary shape is a link directory inside the
		// workspace whose referent is elsewhere - and the clause below cannot catch that, because it only
		// binds the retained target when the alias looks inside the canonical root; an alias that itself
		// escapes would read as an intentional outside-workspace write. So the alias's own containment is
		// checked for relative paths that are lexically inside task.cwd, and it fails closed there: the
		// approved bytes were approved for a path inside the workspace. A relative path that is already
		// lexically outside task.cwd is a different animal - the tools spell an approved absolute
		// outside-workspace target that way (EditFileTool converts it with path.relative(task.cwd,
		// file_path) after the user approves the outside edit), and that caller keeps its own
		// authorization, exactly like an absolute path named outright.
		if (
			!path.isAbsolute(relPathOrAbsolute) &&
			isInsideDirectory(task.cwd, absolutePath) &&
			!isInsideDirectory(canonicalWorkspaceRoot, canonicalAlias)
		) {
			// The escaped alias is named relative to the canonical workspace root rather than as an absolute
			// path: this rejection goes straight into the model's context, and the resolved spelling of a
			// workspace reached through a link is a user-specific path the model does not need. The relative
			// form still lists the components in order, which is what the model has to re-read under.
			const escapedAlias = path.relative(canonicalWorkspaceRoot, canonicalAlias)
			throw new GuardRejectedError(
				"The write path resolves outside the workspace (" +
					escapedAlias +
					") -- nothing was written; re-read the file under its canonical path, then retry.",
				displayPath,
			)
		}
		const authorizeTarget = (retainedTarget: string): void => {
			// Containment: validateAccess enforces .rooignore only (its own tests allow
			// absolute and ../ paths), so a workspace symlink retargeted after the tool's
			// check could otherwise send the approved bytes to an external file. When the
			// caller's alias is inside the workspace, the retained target must be too.
			if (
				isInsideDirectory(canonicalWorkspaceRoot, canonicalAlias) &&
				!isInsideDirectory(canonicalWorkspaceRoot, retainedTarget)
			) {
				throw new GuardRejectedError(
					"The resolved publish target is outside the workspace -- nothing was written.",
					displayPath,
				)
			}
			if (task.rooIgnoreController && !task.rooIgnoreController.validateAccess(retainedTarget)) {
				throw new GuardRejectedError(
					"The ignore allowlist denied access to the resolved publish target -- nothing was written.",
					displayPath,
				)
			}
		}

		if (task.abort) {
			throw new GuardRejectedError(
				"Task was cancelled before this write ran -- the queued publish is not performed.",
				displayPath,
			)
		}
		const obs = task.observationRegistry.get(absolutePath)
		// Completeness the observation is refreshed with. A targeted edit authorizes only
		// the view the model saw, so a partial observation stays partial, while a full-file
		// publish is complete unless the caller carried another view's completeness through
		// in completeOverride. One rule, read by the success refresh and by the
		// reconciliation below, so the two can never disagree about what one publish records.
		const completeAfterPublish = (): boolean => completeOverride ?? !(obs?.complete === false)
		// Token the guard read under the lock, so the refresh records the token
		// this write published rather than a peer writer's.
		let publishedToken: string | undefined

		try {
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
						() => task.abort,
						authorizeTarget,
					)
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
					publishedToken = await createIfAbsent(
						absolutePath,
						content,
						displayPath,
						() => task.abort,
						authorizeTarget,
					)
				} else if (absent) {
					// A "create" on a file that vanished after the read recreates it.
					publishedToken = await createIfAbsent(
						absolutePath,
						content,
						displayPath,
						() => task.abort,
						authorizeTarget,
					)
				} else {
					// The version recorded at read time must still match the on-disk
					// token.
					publishedToken = await replaceIfVersion(
						absolutePath,
						obs.version,
						content,
						displayPath,
						() => task.abort,
						authorizeTarget,
					)
				}
			}
		} catch (error: unknown) {
			// A commit rename that landed but failed the durability check after it has
			// already put this write's bytes at the target, and the guard rethrows that
			// failure with the token it read under the same lock as the publish. The
			// observation has to follow the disk: left on the pre-write token, the next
			// guarded write from this task is rejected stale against the version it just
			// published itself, and the save path that calls guardedWrite directly
			// (DiffViewProvider.saveDirectly) has no reconciliation of its own to absorb
			// that. The error is rethrown untouched -- a durability failure is not a
			// successful save, and nothing here reports one.
			const landedToken = landedPublishToken(error)
			if (landedToken !== undefined) {
				task.observationRegistry.observe(absolutePath, landedToken, completeAfterPublish())
			}
			throw error
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
			task.observationRegistry.observe(absolutePath, publishedToken, completeAfterPublish())
		}
		// Hand the publish's own token back: the save path records it as the
		// rollback baseline, so a later disk state is compared against THIS
		// session's write instead of a guess. Undefined when the guard could
		// not read a token back (e.g. the edit guard path).
		return publishedToken
	})
}

/**
 * Reset the per-path tail-promise chains (test hook).
 *
 * @internal Test-only: production code never resets the chains, so the production
 * dead-code check must not report this export as unused.
 */
export function resetChain(): void {
	pendingChains.clear()
}
