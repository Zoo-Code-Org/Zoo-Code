import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import crypto from "crypto"

import deepEqual from "fast-deep-equal"
import { historyItemSchema, type HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { acquireFileLock, LOCK_STALE_MS, withFileLock } from "../../utils/fileLock"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { deleteJsonFile, isReplacementLeftover, recoverMissingJsonFile } from "../../utils/jsonFileRecovery"
import { getErrorCode, readFileWithMissingRetry } from "./readFileWithMissingRetry"
import { resolveLockKey } from "../../services/file-safety/safeWriteText"
import { getStorageBasePath } from "../../utils/storage"
import { assertValidTransition, settleRejectedCreateSubtaskAction, type HistoryItemStatus } from "./taskLifecycle"
import { computeHistoryDelta, DeltaRejectedError, mergeHistoryDelta } from "./taskStoreConcurrency"

export { assertValidTransition, type HistoryItemStatus } from "./taskLifecycle"
export { DeltaRejectedError } from "./taskStoreConcurrency"

/**
 * Build a `safeWriteJson` merge callback that applies only `delta` to the
 * current disk state, preserving fields written by another process.
 */
function mergeWithDisk(delta: Partial<HistoryItem>): (existing: unknown, incoming: unknown) => unknown {
	return (existing, incoming) => mergeHistoryDelta(existing, incoming as HistoryItem, delta)
}

/**
 * Durable intent for the one repair that spans an active delegated child and
 * its parent. Task files remain authoritative; this file only records the
 * guarded target transition that must be completed after a crash.
 */
interface DelegationRepairIntent {
	version: 1
	operationId: string
	parentTaskId: string
	childTaskId: string
	expected: {
		parent: {
			status: "delegated"
			awaitingChildId: string
			delegatedToId?: string
		}
		child: {
			status: "active"
			parentTaskId?: string
			rootTaskId?: string
		}
	}
	target: {
		childStatus: "interrupted"
		parentStatus: "active"
	}
}

/**
 * TaskHistoryStore encapsulates all task history persistence logic.
 *
 * Each task's HistoryItem is stored as an individual JSON file in its
 * existing task directory (`globalStorage/tasks/<taskId>/history_item.json`).
 * There is no shared index file. Reads scan the task directories.
 *
 * Cross-process safety for per-task files comes from `safeWriteJson`'s
 * `proper-lockfile` with a `merge` callback: each write reads the
 * current file under the advisory lock and merges incoming fields, so
 * a concurrent writer's changes are preserved rather than silently
 * dropped. Within a single extension host process, an in-process write
 * lock serializes mutations.
 */
/**
 * Options for TaskHistoryStore constructor.
 */
export interface TaskHistoryStoreOptions {
	/**
	 * Optional callback invoked inside the write lock after each mutation
	 * (upsert, delete, deleteMany). Used for serialized write-through to
	 * globalState during the transition period.
	 */
	onWrite?: (items: HistoryItem[]) => Promise<void>
}

/**
 * A deletion that did not happen.
 *
 * The item is kept in the cache, the mtime map and the persisted state, so the store still
 * agrees with the disk and the next reconciliation does not resurrect a task the caller was
 * told was gone. The caller learns the delete failed instead of seeing a success that the
 * on-disk state contradicts.
 */
export class TaskHistoryDeleteError extends Error {
	constructor(
		readonly taskIds: string[],
		readonly reason: string,
		cause?: unknown,
	) {
		super(
			`Task history for ${taskIds.join(", ")} could not be deleted (${reason}); the affected items were kept.`,
			{ cause },
		)
		this.name = "TaskHistoryDeleteError"
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined
}
/**
 * What the locked removal observed. "blocked" is the resurrection guard firing: a leftover
 * sibling of this task file could not be removed, so the canonical file was kept.
 * "retargeted" is the identity check firing: the name now resolves onto a different lock key
 * key than the one this call holds, so the file belongs to another writer's lock and this
 * removal touched nothing.
 * "enumeration-failed" is the sweep's own read failing: the lock was held, so the stage that
 * failed is the directory read, not the lock, and neither the sweep nor the unlink ran.
 * "named-present" and "named-uncheckable" are that same sweep read reporting its directory
 * gone while the name this caller passed is still there, or is unreadable: the directory the
 * sweep reads and the name the caller asked about are not the same thing when the name is an
 * alias.
 */
type TaskFileRemoval =
	| { outcome: "removed" | "absent" | "retargeted" }
	| { outcome: "blocked"; blockedOn: string; error: unknown }
	| { outcome: "enumeration-failed"; error: unknown }
	| { outcome: "revalidation-failed"; error: unknown }
	| { outcome: "named-present" }
	| { outcome: "named-uncheckable"; error: unknown }
	| { outcome: "failed"; error: unknown }

export class TaskHistoryStore {
	private readonly globalStoragePath: string
	private readonly onWrite?: (items: HistoryItem[]) => Promise<void>
	private cache: Map<string, HistoryItem> = new Map()
	private taskFileMtimes: Map<string, number> = new Map()
	private writeLock: Promise<void> = Promise.resolve()
	private fsWatcher: fsSync.FSWatcher | null = null
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	/**
	 * Promise that resolves when initialization is complete.
	 * Callers can await this to ensure the store is ready before reading.
	 */
	public readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	/** Periodic reconciliation interval in milliseconds. */
	private static readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000

	constructor(globalStoragePath: string, options?: TaskHistoryStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.onWrite = options?.onWrite
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Scan task files, reconcile delegation state, start watchers.
	 */
	async initialize(): Promise<void> {
		try {
			const tasksDir = await this.getTasksDir()
			await fs.mkdir(tasksDir, { recursive: true })

			// 1. Scan task directories to populate the cache
			await this.reconcile({ forceRefresh: true })
			// Capture which active tasks were present in persisted state before replay can
			// change any statuses. Reconciliation must not treat a replay-repaired parent
			// as an orphaned active child in the same startup pass.
			const persistedActiveIds = this.getPersistedActiveIds()

			// 2. Complete any two-record repair interrupted after its intent was durable.
			try {
				await this.replayDelegationRepairIntent()
			} catch (error) {
				console.error("[TaskHistoryStore] Failed to replay delegation repair intent:", error)
			}

			// 3. Repair delegation inconsistencies left by a previous crash
			await this.reconcileDelegationState(persistedActiveIds)

			// 4. Start fs.watch for cross-instance reactivity
			this.startWatcher()

			// 5. Start periodic reconciliation as a defensive fallback
			this.startPeriodicReconciliation()
		} finally {
			// Mark initialization as complete so callers awaiting `initialized` can proceed
			this.resolveInitialized()
		}
	}

	/**
	 * Flush pending writes, clear watchers, release resources.
	 */
	dispose(): void {
		this.disposed = true

		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer)
			this.reconcileTimer = null
		}

		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}
	}

	// ────────────────────────────── Reads ──────────────────────────────

	/**
	 * Get a single history item by task ID.
	 */
	get(taskId: string): HistoryItem | undefined {
		return this.cache.get(taskId)
	}

	/**
	 * Get all history items, sorted by timestamp descending (newest first).
	 */
	getAll(): HistoryItem[] {
		return Array.from(this.cache.values()).sort((a, b) => b.ts - a.ts)
	}

	/**
	 * Get history items filtered by workspace path.
	 */
	getByWorkspace(workspace: string): HistoryItem[] {
		return this.getAll().filter((item) => item.workspace === workspace)
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Insert or update a history item.
	 *
	 * Writes the per-task file immediately (source of truth)
	 * and updates the in-memory cache.
	 */
	async upsert(item: HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(() => this.upsertCore(item))
	}

	/**
	 * Core upsert logic — must only be called from within `withLock`.
	 *
	 * Enforces state-machine transition rules when `item.status` changes.
	 * Pass `skipTransitionCheck: true` only for administrative repairs (reconciliation,
	 * migration) that need to write corrected state outside the normal task lifecycle.
	 */
	private async upsertCore(
		item: HistoryItem,
		options: { skipTransitionCheck?: boolean } = {},
	): Promise<HistoryItem[]> {
		const existing = this.cache.get(item.id)

		// Enforce transition validity at the write boundary so that any caller
		// (including fire-and-forget saves) cannot silently stomp a terminal status.
		// Skip when there is no existing record — first insert has no prior state to transition from.
		// Normalize existing.status (undefined = legacy "active") before comparing so that writing
		// status: "active" onto a legacy item without a status field is not treated as a transition.
		if (!options.skipTransitionCheck && existing && item.status !== undefined) {
			const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
			if (item.status !== normalizedExisting) {
				try {
					assertValidTransition(existing.status, item.status)
				} catch (cacheError) {
					// Cache may be stale from a peer write. Re-read disk
					// under the store lock before rejecting the transition.
					const diskItem = await this.readTaskFile(item.id)
					if (!diskItem) {
						throw cacheError
					}
					assertValidTransition(diskItem.status, item.status)
				}
			}
		}

		// Merge: preserve existing metadata unless explicitly overwritten
		const merged = existing ? { ...existing, ...item } : item

		const delta = existing ? this.buildDelta(item.id, existing, item) : { ...item }
		let written: HistoryItem
		try {
			written = await this.writeTaskFile(merged, delta)
		} catch (error) {
			if (error instanceof DeltaRejectedError) {
				const diskItem = await this.readTaskFile(item.id)
				if (diskItem) {
					this.cache.set(item.id, diskItem)
				}
				throw error
			}
			throw error
		}

		// Update in-memory cache with what was actually persisted
		this.cache.set(written.id, written)

		const all = this.getAll()

		// Call onWrite callback inside the lock for serialized write-through
		if (this.onWrite) {
			await this.onWrite(all)
		}

		return all
	}

	/**
	 * Delete one task’s history item.
	 *
	 * The unlink runs under the same per-file advisory lock as `safeWriteJson`, so a locked
	 * read-modify-write (for example the settlement in `clearPendingActionIfMatching`) cannot
	 * interleave with it. Eviction and the write-through happen only once the file is actually
	 * gone - unlinked, or reported absent by the unlink itself. A lock-key resolution failure, a
	 * lock that could not be taken, or any other unlink failure leaves the item in place and is
	 * reported as a TaskHistoryDeleteError: a store that dropped the item while the file survived
	 * would report a deletion that the next reconciliation immediately contradicts.
	 */
	async delete(taskId: string): Promise<void> {
		return this.withLock(async () => {
			const outcome = await this.removeTaskFile(taskId)
			if (!outcome.deleted) {
				throw new TaskHistoryDeleteError([taskId], outcome.reason ?? "unknown error", outcome.cause)
			}
			this.cache.delete(taskId)
			this.taskFileMtimes.delete(taskId)

			// The removal above swept this task file's .bak_/.new_ siblings under the per-file lock
			// before it unlinked the canonical path. This is main's shared delete helper running
			// once more after that lock was released: it collects anything a peer created in the
			// window between our release and our return, and its ENOENT on the now-absent canonical
			// path is the expected outcome rather than a failure. It takes the per-file lock for
			// itself after ours was released, so the two never nest.
			// Remove per-task file (best-effort)
			try {
				const filePath = await this.getTaskFilePath(taskId)
				await deleteJsonFile(filePath)
			} catch (error) {
				if (getErrorCode(error) !== "ENOENT")
					console.warn("[TaskHistoryStore] Failed to delete task history:", error)
				// File may already be deleted
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	/**
	 * Delete multiple tasks’ history items in a batch.
	 *
	 * Every item follows the `delete` semantics and is attempted even when an earlier one fails.
	 * The single write-through runs once, after the batch, and only if at least one item was
	 * actually removed. Failed ids are reported together in one TaskHistoryDeleteError and stay
	 * in the store, one entry per id: the report is keyed by id, so a duplicate id is named once and
	 * only the outcome of its last attempt decides whether it is named at all. An id whose earlier
	 * attempt removed the file and whose later attempt failed keeps the entry that earlier attempt
	 * served: the eviction is undone before the write-through, so the payload, the cache, and the
	 * report all agree about which tasks the caller still has.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withLock(async () => {
			// Keyed by id rather than appended. The batch's caller can hand the same id twice - the
			// descendant walk in ClineProvider.deleteTaskWithId has no visited set, so a child listed
			// under two parents or a cycle in childIds yields duplicates - and an append-only log
			// then reports an id whose later attempt deleted the file, which makes the caller skip the
			// artifacts of a task this batch already removed. One entry per id, and the attempt that
			// decides the entry is the last one.
			const failures = new Map<string, { reason: string; cause?: unknown }>()
			// What each successful attempt served away, keyed by id. The batch can attempt one id twice, and
			// the last attempt decides the report; when that attempt fails the file may be there again - a
			// peer republished it - and the entry this store was serving has to be back in the cache before
			// the write-through and the error. A batch that reports a failed id while the payload it just
			// wrote and the cache it just evicted both omit that id tells the caller to keep a task the
			// store itself no longer has.
			const served = new Map<string, { entry?: HistoryItem; mtime?: number }>()
			let deletedAny = false
			for (const taskId of taskIds) {
				const outcome = await this.removeTaskFile(taskId)
				if (!outcome.deleted) {
					const held = served.get(taskId)
					if (held) {
						served.delete(taskId)
						if (held.entry) {
							this.cache.set(taskId, held.entry)
						}
						if (held.mtime !== undefined) {
							this.taskFileMtimes.set(taskId, held.mtime)
						}
					}
					failures.set(taskId, { reason: outcome.reason ?? "unknown error", cause: outcome.cause })
					continue
				}
				// A later attempt that found the file gone supersedes any failure this batch recorded for
				// the same id: leaving the entry behind would report a deletion as failed and cost the
				// caller its artifact cleanup for a file that is no longer there.
				failures.delete(taskId)
				// Snapshot what this attempt serves away, so a later attempt of the same id that fails can put
				// back exactly what was here rather than what a recovery pass would guess. A duplicate id can
				// succeed more than once, and a later success has nothing left in the cache to serve: writing
				// that empty result over the snapshot would throw away the one record that holds anything, and
				// a third attempt that then failed would report the id as retained while restoring nothing.
				// Only an attempt that actually served something may replace the snapshot.
				const servedNow = { entry: this.cache.get(taskId), mtime: this.taskFileMtimes.get(taskId) }
				const servedBefore = served.get(taskId)
				served.set(taskId, {
					entry: servedNow.entry ?? servedBefore?.entry,
					mtime: servedNow.mtime ?? servedBefore?.mtime,
				})
				this.cache.delete(taskId)
				this.taskFileMtimes.delete(taskId)
				deletedAny = true
				// The removal above swept this task file's .bak_/.new_ siblings under the per-file lock
				// before it unlinked the canonical path. This is main's shared delete helper running
				// once more after that lock was released: it collects anything a peer created in the
				// window between our release and our return, and its ENOENT on the now-absent canonical
				// path is the expected outcome rather than a failure. It takes the per-file lock for
				// itself after ours was released, so the two never nest.

				// Remove per-task file (best-effort)
				try {
					const filePath = await this.getTaskFilePath(taskId)
					await deleteJsonFile(filePath)
				} catch (error) {
					if (getErrorCode(error) !== "ENOENT")
						console.warn("[TaskHistoryStore] Failed to delete task history:", error)
					// File may already be deleted
				}
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite && deletedAny) {
				await this.onWrite(this.getAll())
			}

			if (failures.size > 0) {
				const failed = Array.from(failures.entries())
				throw new TaskHistoryDeleteError(
					failed.map(([taskId]) => taskId),
					failed.map(([taskId, failure]) => taskId + ": " + failure.reason).join("; "),
					failed[0][1].cause,
				)
			}
		})
	}

	/**
	 * Remove the per-task file under the shared lock and report whether the file is gone.
	 *
	 * Only the unlink's own ENOENT counts as gone: the file was there to delete and is not there
	 * now. Every other failure means the file may still exist and the item must stay in the store
	 * - a lock-key that cannot be resolved, a lock-key that cannot be re-derived while its own lock is
	 * held, a lock that could not be taken (proper-lockfile reports ENOENT for a missing key), a lock
	 * timeout, a containing-directory read that failed while the lock was held, or any non-ENOENT
	 * unlink error. Those stages reach the caller with a
	 * reason naming the stage, because "ENOENT" on its own does not say which of them happened, and
	 * a store that evicts an item whose file survived
	 * reports a deletion the next reconciliation contradicts. The one stage where an ENOENT may
	 * still close the deletion is a lock that could not be taken at all: there the verdict comes
	 * from the named path rather than from the lock's errno, and it is made inside a fresh
	 * acquisition of that same lock, so a file verified absent with nothing recoverable beside
	 * it is a completed deletion while a lock that still refuses the retry is not.
	 * The sweep's own read is held to the same standard: it reads the directory of the lock key,
	 * which is the directory the name resolves to rather than the one the name sits in, so when
	 * that read reports the directory gone the named path is asked before any deletion is
	 * reported, and only a name that reports itself gone closes the deletion.
	 */
	private async removeTaskFile(taskId: string): Promise<{ deleted: boolean; reason?: string; cause?: unknown }> {
		const filePath = await this.getTaskFilePath(taskId)
		let lockKey: string
		try {
			// Lock the resolved publish target, not the path as spelled: proper-lockfile keys the
			// lock by the path it is given, so an alias and its referent would take two locks for
			// one file. The unlink still removes the named path.
			lockKey = await this.lockKeyFor(filePath)
		} catch (resolutionError: unknown) {
			// The key could not be computed, so the lock was never attempted and the unlink never
			// ran. A dangling alias whose referent sits under a missing parent fails here with
			// ENOENT while the alias itself is still on disk: that is not evidence of a deletion.
			return {
				deleted: false,
				reason: `lock key could not be resolved (${errorCode(resolutionError) ?? "unknown error"})`,
				cause: resolutionError,
			}
		}

		// The verdict is returned from inside the locked operation rather than inferred from what
		// withFileLock throws: that helper rethrows the operation's error unchanged, so a lock
		// failure and an unlink failure would otherwise arrive at the same place and could not be
		// told apart by their error code alone. Returning the verdict keeps the stages apart -
		// anything reaching the catch below failed at the lock, before any verdict existed.
		let removal: TaskFileRemoval
		try {
			removal = await withFileLock(lockKey, async (absoluteFilePath) => {
				// The key was computed before this call waited. A referent move in the meantime means the
				// lock being held keys a location a writer has already moved away from: the sweep below
				// would read one directory and the unlink would remove a name whose publish target another
				// lock now covers. Re-derive the key from the name this removal was asked to remove and
				// refuse when it no longer matches, the way the guarded writes refuse the same window
				// (src/core/tools/guardedWrite.ts:215-220), rather than removing beside it.
				let rederivedKey: string
				try {
					rederivedKey = await resolveLockKey(filePath)
				} catch (revalidationError: unknown) {
					// Returned, not thrown, for the reason the directory read below states for itself: withFileLock
					// rethrows an operation error unchanged, so a throw here would land in the lock catch and be
					// reported as a lock that could not be taken even though this call is standing inside that
					// lock. The stage that failed is this re-derivation, and only a reason naming it keeps the
					// two apart for whoever reads the report.
					return { outcome: "revalidation-failed", error: revalidationError }
				}
				if (rederivedKey !== lockKey) {
					return { outcome: "retargeted" }
				}
				const containingDir = path.dirname(absoluteFilePath)
				// Sweep the interrupted-write siblings before the canonical file, in the order
				// jsonFileRecovery.deleteJsonFile uses. A leftover backup this sweep cannot remove
				// must not survive beside a canonical file this delete removed: a later reader's
				// recovery pass would resurrect content this delete was meant to destroy. Keeping
				// the canonical file and reporting the delete as failed is the safe outcome.
				let entries: string[]
				try {
					entries = await fs.readdir(containingDir)
				} catch (readdirError: unknown) {
					if (errorCode(readdirError) === "ENOENT") {
						// The directory the sweep looks in is gone. That is that directory's answer, not the
						// named path's: this removal was asked about a name, and the sweep reads the directory of
						// the lock key, which is the directory the name resolves to rather than the one the name
						// itself sits in. A name can outlive that directory - an alias whose referent directory
						// was removed elsewhere, a listing that raced a republish - so the named path is asked the
						// way the lock-failure verdict asks it, and its own answer decides whether anything was
						// left to delete.
						try {
							await fs.lstat(filePath)
							// The name reports itself present: nothing was removed and no deletion happened.
							return { outcome: "named-present" }
						} catch (statError: unknown) {
							if (errorCode(statError) !== "ENOENT") {
								// Neither the sweep nor the unlink ran, and this read failed for another reason, so
								// nothing here says the file is gone: the stage that failed is this read.
								return { outcome: "named-uncheckable", error: statError }
							}
							// The name itself reports itself gone.
							return { outcome: "absent" }
						}
					}
					// Returned, not thrown: withFileLock rethrows an operation error unchanged, so a
					// throw here would land in the lock catch and be reported as a lock failure even though
					// the lock was taken and the stage that failed is the directory read.
					return { outcome: "enumeration-failed", error: readdirError }
				}
				for (const entry of entries) {
					if (!isReplacementLeftover(absoluteFilePath, entry)) {
						continue
					}
					try {
						await fs.unlink(path.join(containingDir, entry))
					} catch (leftoverError: unknown) {
						if (errorCode(leftoverError) === "ENOENT") {
							// A peer already collected it, which is the outcome this sweep wanted.
							continue
						}
						return { outcome: "blocked", blockedOn: entry, error: leftoverError }
					}
				}
				try {
					// The named path, not the lock key: an alias is removed as its caller named it.
					await fs.unlink(filePath)
					return { outcome: "removed" }
				} catch (unlinkError: unknown) {
					return {
						outcome: errorCode(unlinkError) === "ENOENT" ? "absent" : "failed",
						error: unlinkError,
					}
				}
			})
		} catch (lockError: unknown) {
			// The lock stage failed, so no stage of the removal ran. Its ENOENT cannot settle
			// anything on its own: proper-lockfile creates <key>.lock with mkdir, which reports
			// ENOENT both when the directory that would hold the file is gone (nothing to delete)
			// and when the key is an alias whose referent is missing (the named file may still be
			// right there). Ask the named path itself rather than read the lock's errno as a
			// report about the file.
			return await this._verdictAfterLockFailure(filePath, lockKey, lockError)
		}

		if (removal.outcome === "retargeted") {
			// The name resolved onto a different key while the lock was being taken, so this call held the
			// wrong lock and left the file alone. Reporting a deletion here would evict an item whose
			// file another writer is publishing onto right now.
			return {
				deleted: false,
				reason: "the path resolved to a different lock key while this removal waited for the lock",
			}
		}
		if (removal.outcome === "revalidation-failed") {
			// The lock was held and the key could not be re-derived from the name, so this call cannot prove
			// it is holding the lock a writer is using. Nothing was removed and the item stays, which is the
			// same retention as the retargeted verdict: only the stage named in the reason differs, because a
			// reason that says the lock could not be taken while the lock was in fact taken is a wrong
			// statement about the world, not a different outcome.
			return {
				deleted: false,
				reason: `the lock key could not be re-derived while this removal held the lock (${errorCode(removal.error) ?? "unknown error"})`,
				cause: removal.error,
			}
		}
		if (removal.outcome === "named-present") {
			// The directory the sweep read is gone while the name this caller passed still reports
			// itself present, so no deletion happened: reporting one would evict an item whose file is
			// on disk, which the next reconciliation contradicts.
			return {
				deleted: false,
				reason: "the named path still reports itself present although the directory the sweep read is gone",
			}
		}
		if (removal.outcome === "named-uncheckable") {
			// The sweep could not run and the name could not be read either, so the removal holds no
			// observation about the file to report a deletion from.
			return {
				deleted: false,
				reason: `the named path could not be checked (${errorCode(removal.error) ?? "unknown error"})`,
				cause: removal.error,
			}
		}
		if (removal.outcome === "blocked") {
			// The task file was kept, so the item must stay in the store: reporting a deletion
			// here would be contradicted by the next reconciliation.
			return {
				deleted: false,
				reason:
					"a leftover " +
					removal.blockedOn +
					" from an interrupted write could not be removed (" +
					(errorCode(removal.error) ?? "unknown error") +
					")",
				cause: removal.error,
			}
		}
		if (removal.outcome === "enumeration-failed") {
			// The lock was held and the containing directory could not be read, so neither the leftover
			// sweep nor the unlink ran. Nothing here says the file is gone: the stage that failed is the
			// read, and the item has to stay with the file.
			return {
				deleted: false,
				reason: `the containing directory could not be read (${errorCode(removal.error) ?? "unknown error"})`,
				cause: removal.error,
			}
		}
		if (removal.outcome === "failed") {
			return {
				deleted: false,
				reason: errorCode(removal.error) ?? "unknown error",
				cause: removal.error,
			}
		}
		// Unlinked by this call, or already absent when the unlink or the containing
		// directory said so. Either way the file is gone and the item may be evicted.
		return { deleted: true }
	}

	/**
	 * What to report when the lock could not be taken at all. A verdict about the file has to
	 * come from the same place the writer publishes from, so the named path is asked directly
	 * rather than read through the lock's errno - lstat does not follow a symlink, which is
	 * what keeps a dangling alias reporting itself present - and an absence is accepted only
	 * after the lock has been taken again and the named path and its siblings are re-checked
	 * inside it. A lock that still refuses the retry is a writer that is standing: the
	 * deletion is blocked, because a caller that never held the lock cannot certify that
	 * nothing recoverable is sitting beside the file.
	 */
	private async _verdictAfterLockFailure(
		filePath: string,
		lockKey: string,
		lockError: unknown,
	): Promise<{ deleted: boolean; reason?: string; cause?: unknown }> {
		const lockReason = `the per-file lock could not be taken (${errorCode(lockError) ?? "unknown error"})`
		try {
			await fs.lstat(filePath)
		} catch (statError: unknown) {
			if (errorCode(statError) === "ENOENT") {
				// The named path reported itself absent, and this path never held the writer's lock,
				// so that answer is not the writer's own: a writer can publish after this lstat,
				// move an earlier publish to a backup, and be interrupted there. Absence is
				// certifiable only from inside the lock, so it is certified under a new one.
				return await this._certifyAbsentUnderLock(filePath, lockKey, lockReason, lockError)
			}
			return {
				deleted: false,
				reason: `${lockReason}; the file could not be checked (${errorCode(statError) ?? "unknown error"})`,
				cause: statError,
			}
		}
		return { deleted: false, reason: lockReason, cause: lockError }
	}

	/**
	 * Certify an absence that was observed from outside the lock. The acquisition is retried
	 * with the staleness window acquireFileLock already passes to proper-lockfile, so a lock
	 * left behind by a dead writer is stolen and the delete proceeds, while a live one refuses
	 * the retry and the deletion is reported blocked: the item stays in the store and the
	 * caller is told which stage to retry. Inside the acquisition the named path is asked
	 * again and the interrupted-write siblings are scanned, because a completed publish that
	 * landed while the delete was waiting for the lock leaves a canonical file and no siblings,
	 * and only an observation made while no writer can move the file says what is beside it. When
	 * the retry cannot create the lock at all, that failure's errno is still not the verdict: the
	 * named path is asked again and its own answer closes or blocks the deletion, and the scan
	 * covers both the name the caller passed and the target that name resolves to, which is the
	 * directory a writer actually stages in. The retry is used only after the name is resolved again
	 * under the lock that retry holds: a key that no longer matches the one this deletion locked, or
	 * one that cannot be resolved at all, refuses the certification, because holding the key of a
	 * location a writer has moved away from says nothing about what sits beside the name. The scan
	 * follows the spelling rather than the directory - leftovers are named after the target basename,
	 * so a name whose referent lives in the same directory under a different basename still gets the
	 * scan of that spelling.
	 */
	private async _certifyAbsentUnderLock(
		filePath: string,
		lockKey: string,
		lockReason: string,
		lockError: unknown,
	): Promise<{ deleted: boolean; reason?: string; cause?: unknown }> {
		let releaseLock: () => Promise<void>
		try {
			releaseLock = await acquireFileLock(lockKey)
		} catch (retryError: unknown) {
			if (errorCode(retryError) === "ENOENT") {
				// A directory on the way to the lock is gone, so the retry could not create the lock at
				// all. The lock's errno is not a verdict about the file, and the absence observed above was
				// observed outside any lock: a writer can publish onto this name between that lstat and this
				// failed retry, and it publishes onto the spelling it resolves to rather than onto the
				// directory that happens to be missing. Ask the named path again - lstat does not follow a
				// symlink, which is what keeps a dangling alias reporting itself present - and let that
				// answer decide. A different errno - EEXIST, EACCES, EBUSY - is somebody else holding the
				// lock or a directory that cannot be written, and that is not a completed deletion.
				try {
					await fs.lstat(filePath)
					return {
						deleted: false,
						reason: `${lockReason}; the file reported itself present after a directory on the way to the lock went missing`,
						cause: retryError,
					}
				} catch (retryStatError: unknown) {
					if (errorCode(retryStatError) !== "ENOENT") {
						return {
							deleted: false,
							reason: `${lockReason}; the named path could not be checked (${errorCode(retryStatError) ?? "unknown error"})`,
							cause: retryStatError,
						}
					}
					// Absent when asked again, with no lock left to take and nothing published onto this name.
					return { deleted: true }
				}
			}
			return {
				deleted: false,
				reason: `${lockReason}; the retry could not take the lock either, so the deletion is blocked on the lock`,
				cause: retryError,
			}
		}
		try {
			// The removal path re-derives the key inside the lock it holds and refuses a mismatch; this
			// certification is the other half of the same rule and had not been given it. Without the
			// re-derivation here, a name that moves between the failed acquisition and this retry leaves the
			// retry holding the key of a location the writer has already moved away from: the reads below
			// look in directories no writer is using, and a publish onto the new target lands after the
			// deletion is reported. Ask the name again under the lock this retry holds, and refuse the
			// certification when the answer is a different key or no answer at all.
			let currentKey: string
			try {
				currentKey = await resolveLockKey(filePath)
			} catch (revalidationError: unknown) {
				return {
					deleted: false,
					reason: `${lockReason}; the lock key could not be re-derived while the retry lock was held (${errorCode(revalidationError) ?? "unknown error"})`,
					cause: revalidationError,
				}
			}
			if (currentKey !== lockKey) {
				return {
					deleted: false,
					reason: `${lockReason}; the path resolved to a different lock key while this deletion waited, so the lock held here keys a location a writer has moved away from`,
					cause: lockError,
				}
			}
			// With the lock held, the named path is asked first: a publish that completed while
			// the delete was refused the lock means there is a file here again.
			try {
				await fs.lstat(filePath)
				return {
					deleted: false,
					reason: `${lockReason}; the file came back after the lock failed`,
					cause: lockError,
				}
			} catch (statError: unknown) {
				if (errorCode(statError) !== "ENOENT") {
					return {
						deleted: false,
						reason: `${lockReason}; the named path could not be checked (${errorCode(statError) ?? "unknown error"})`,
						cause: statError,
					}
				}
			}
			// A writer stages its temp file and its old-content copy beside the target it resolves to
			// (src/services/file-safety/safeWriteText.ts:273-275), which is the directory of the lock key,
			// and names them after that target's basename. When the name this caller passed is an alias,
			// path.dirname(filePath) is a different directory and the leftovers carry the referent's
			// basename rather than the alias's, so one lookup here would be a claim about a directory no
			// writer used. Read both spellings' directories, each against the spelling whose basename its
			// leftovers are named after.
			// Leftovers are named after the target basename, so the second spelling is owed whenever the two
			// spellings differ - including an alias that links to a differently named file in its own
			// directory, where the directories match and only the basenames do not. Comparing spellings
			// rather than directories is what makes that case get two scans; they collapse into one only when
			// both spellings name the same file.
			const scans: { dir: string; against: string }[] = [{ dir: path.dirname(filePath), against: filePath }]
			if (lockKey !== filePath) {
				scans.push({ dir: path.dirname(lockKey), against: lockKey })
			}
			for (const scan of scans) {
				let entries: string[]
				try {
					entries = await fs.readdir(scan.dir)
				} catch (readError: unknown) {
					if (errorCode(readError) === "ENOENT") {
						// Nothing sits in this spelling's directory: for this spelling that is the same
						// answer an empty scan gives.
						continue
					}
					return {
						deleted: false,
						reason: `${lockReason}; the containing directory could not be read (${errorCode(readError) ?? "unknown error"})`,
						cause: readError,
					}
				}
				const leftover = entries.find((entry) => isReplacementLeftover(scan.against, entry))
				if (leftover) {
					return {
						deleted: false,
						reason: `${lockReason}; a leftover ${leftover} from an interrupted write can still be recovered`,
						cause: lockError,
					}
				}
			}
			// Absent, holding the lock, with nothing a recovery pass could restore beside it.
			return { deleted: true }
		} finally {
			// The verdict is already known, so a release failure is logged rather than
			// reported over it, the way withFileLock handles a failed release.
			try {
				await releaseLock()
			} catch (releaseError: unknown) {
				console.error(`Failed to release lock for ${lockKey}:`, releaseError)
			}
		}
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

	/**
	 * The lock key a writer would use for a task file. resolvePublishTarget refuses
	 * a dangling link, so the delete paths and the liveness probe walk the chain
	 * themselves to find the lock held at the referent.
	 */
	private async lockKeyFor(taskFilePath: string): Promise<string> {
		return resolveLockKey(taskFilePath)
	}

	/**
	 * Scan task directories and fix any drift between disk and cache.
	 *
	 * - Tasks on disk but missing from cache: read and add
	 * - Tasks in cache but missing from disk: remove
	 */
	async reconcile(options: { forceRefresh?: boolean } = {}): Promise<void> {
		// Run through the write lock to prevent interleaving with upsert/delete
		return this.withLock(async () => {
			const tasksDir = await this.getTasksDir()

			let dirEntries: string[]
			try {
				dirEntries = await fs.readdir(tasksDir)
			} catch {
				return // tasks dir doesn't exist yet
			}

			// Filter out hidden and reserved names
			const taskDirNames = dirEntries.filter((name) => !name.startsWith("_") && !name.startsWith("."))

			const onDiskIds = new Set(taskDirNames)
			const cacheIds = new Set(this.cache.keys())
			const liveIds = new Set<string>()

			for (const taskId of onDiskIds) {
				try {
					const taskFilePath = await this.getTaskFilePath(taskId)
					const { mtimeMs } = await fs.stat(taskFilePath).catch(async (error: unknown) => {
						if (getErrorCode(error) !== "ENOENT") throw error
						await recoverMissingJsonFile(taskFilePath, { waitForStaleLock: false })
						return fs.stat(taskFilePath)
					})
					liveIds.add(taskId)
					if (
						!options.forceRefresh &&
						this.cache.has(taskId) &&
						this.taskFileMtimes.get(taskId) === mtimeMs
					) {
						continue
					}

					const item = await this.readTaskFile(taskId)
					if (item?.id === taskId) {
						const previous = this.cache.get(taskId)
						this.taskFileMtimes.set(taskId, mtimeMs)
						if (!deepEqual(previous, item)) {
							this.cache.set(taskId, item)
						}
					}
				} catch (error) {
					if (getErrorCode(error) !== "ENOENT") {
						liveIds.add(taskId)
						console.warn("[TaskHistoryStore] Failed to reconcile task history:", error)
						continue
					}
					// File may be temporarily absent during a peer's atomic
					// rename window in safeWriteJson. The advisory lock is
					// held for the entire write, so its presence means a
					// write is in progress — keep the task live.
					try {
						// Probe the same key the writer locks: safeWriteJson locks the resolved
						// publish target, so an alias and its referent share one lock file.
						const lockPath = (await this.lockKeyFor(await this.getTaskFilePath(taskId))) + ".lock"
						const lockStat = await fs.stat(lockPath)
						if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) {
							liveIds.add(taskId)
						}
					} catch {
						// No lock file — file is genuinely absent
					}
				}
			}

			// Evict tasks whose history_item.json no longer exists
			for (const taskId of cacheIds) {
				if (!liveIds.has(taskId)) {
					this.cache.delete(taskId)
					this.taskFileMtimes.delete(taskId)
				}
			}
		})
	}

	/**
	 * Repair delegation inconsistencies left by a crash mid-transition.
	 *
	 * Called once from `initialize()` after `reconcile()`. Runs inside `withLock` to
	 * prevent interleaving with watcher-triggered reconcile() calls. Iterates until
	 * convergence so that one-level chained delegations visible at startup are resolved.
	 *
	 * Must NOT be called from within `withLock` — `withLock` is non-reentrant (promise
	 * chain); calling `upsert` (which acquires the lock) from inside would deadlock.
	 * `upsertCore` is called directly here instead, bypassing transition validation via
	 * `skipTransitionCheck: true` because these writes are administrative repairs, not
	 * runtime state-machine transitions.
	 *
	 * Cases repaired per pass:
	 * - Parent `delegated` with no `awaitingChildId` → parent → `active` (invalid state)
	 * - Parent `delegated`, child not found → parent → `active` (orphaned delegation)
	 * - Parent `delegated`, child `completed` → parent → `active` (interrupted handoff)
	 * - Parent `delegated`, child `active` → child → `interrupted`, parent → `active`
	 *
	 * A parent awaiting an `interrupted` or `delegated` child is left as-is — the child is
	 * resumable. An `active` child is treated as orphaned during startup recovery because
	 * no live task session exists to own it.
	 */
	private async reconcileDelegationState(persistedActiveIds: ReadonlySet<string>): Promise<void> {
		return this.withLock(() => this.reconcileDelegationStateCore(persistedActiveIds))
	}

	/**
	 * Reconcile delegation state while the store lock is already held.
	 *
	 * Callers that do not hold the lock must use `reconcileDelegationState()`.
	 * Migration uses this core method so its cache/file updates and the
	 * follow-up repair remain one serialized operation without re-entering the
	 * non-reentrant lock.
	 */
	private async reconcileDelegationStateCore(persistedActiveIds: ReadonlySet<string>): Promise<void> {
		// Only statuses loaded from persistence represent sessions that could have
		// been orphaned by a crash. A delegated parent repaired to active earlier in
		// this pass remains resumable and must not be mistaken for a second orphaned
		// child in a delegation chain. The snapshot is intentionally captured before
		// repair-intent replay and remains unchanged for the entire reconciliation.
		let repairsInThisPass: number
		do {
			repairsInThisPass = 0
			// Rebuild the lookup map each pass so repairs from the previous pass
			// are visible when evaluating chained delegations.
			const byId = new Map(Array.from(this.cache.values()).map((i) => [i.id, i]))

			for (const [, item] of byId) {
				if (item.status !== "delegated") {
					continue
				}

				try {
					if (!item.awaitingChildId) {
						await this.upsertCore(
							{ ...item, status: "active", awaitingChildId: undefined, delegatedToId: undefined },
							{ skipTransitionCheck: true },
						)
						console.warn(
							`[TaskHistoryStore] Reconciled invalid delegation: task ${item.id} → active (no awaitingChildId)`,
						)
						repairsInThisPass++
						continue
					}

					const child = byId.get(item.awaitingChildId)

					if (!child) {
						await this.upsertCore(
							{
								...item,
								status: "active",
								awaitingChildId: undefined,
								delegatedToId: undefined,
							},
							{ skipTransitionCheck: true },
						)
						console.warn(
							`[TaskHistoryStore] Reconciled orphaned delegation: task ${item.id} → active (child ${item.awaitingChildId} not found)`,
						)
						repairsInThisPass++
					} else if ((child.status ?? "active") === "active" && persistedActiveIds.has(child.id)) {
						// An active child persisted across startup cannot have a live task session
						// behind it. Mark it interrupted before releasing the parent's delegation
						// link so the normal resume/re-delegate flow can take over. This is an
						// administrative recovery, not a runtime delegation transition.
						await this.repairActiveDelegation(item, child)
						console.warn(
							`[TaskHistoryStore] Reconciled orphaned active child: child ${child.id} → interrupted, task ${item.id} → active`,
						)
						repairsInThisPass++
					} else if (child.status === "completed") {
						await this.upsertCore(
							{
								...item,
								status: "active",
								awaitingChildId: undefined,
								delegatedToId: undefined,
								completedByChildId: child.id,
								completionResultSummary:
									child.completionResultSummary ?? "Task completed (recovered after interruption)",
							},
							{ skipTransitionCheck: true },
						)
						console.warn(
							`[TaskHistoryStore] Reconciled interrupted handoff: task ${item.id} → active (child ${item.awaitingChildId} already completed)`,
						)
						repairsInThisPass++
					}
				} catch (error) {
					console.error(`[TaskHistoryStore] Failed to reconcile delegation for task ${item.id}:`, error)
				}
				// child.status === "interrupted" or "delegated" → leave as-is this pass
			}
		} while (repairsInThisPass > 0)
	}

	private getPersistedActiveIds(): ReadonlySet<string> {
		return new Set(
			Array.from(this.cache.values())
				.filter((item) => (item.status ?? "active") === "active")
				.map((item) => item.id),
		)
	}

	/**
	 * Replay the durable active-child repair intent, if one was left by a crash.
	 * The expected fields are guards: an intent may update only the missing side
	 * when the other side is already at its target, or when both records still
	 * describe the original delegated handoff.
	 *
	 * This method acquires the store's non-reentrant promise-chain lock. It must be
	 * called outside an existing `withLock` callback; locked callers must use the
	 * corresponding core methods directly instead of awaiting this method.
	 */
	private async replayDelegationRepairIntent(): Promise<void> {
		return this.withLock(async () => {
			const intent = await this.readDelegationRepairIntent()
			if (!intent) {
				return
			}

			const child = this.cache.get(intent.childTaskId)
			const parent = this.cache.get(intent.parentTaskId)
			if (!child || !parent) {
				await this.quarantineDelegationRepairIntent(
					intent,
					`missing ${!child ? "child" : "parent"} task record`,
				)
				return
			}

			const childAtTarget = child.status === intent.target.childStatus
			const parentMatchesTargetState =
				parent.status === intent.target.parentStatus &&
				parent.awaitingChildId === undefined &&
				parent.delegatedToId === undefined
			const childMatchesExpected = this.matchesDelegationRepairChildPreconditions(intent, child)
			const parentMatchesExpected = this.matchesDelegationRepairParentPreconditions(intent, parent)

			if ((!childAtTarget && !childMatchesExpected) || (!parentMatchesTargetState && !parentMatchesExpected)) {
				await this.quarantineDelegationRepairIntent(intent, "task state no longer matches its guards")
				return
			}

			const repairedChild = childAtTarget ? child : { ...child, status: intent.target.childStatus }
			const repairedParent = parentMatchesTargetState
				? parent
				: {
						...parent,
						status: intent.target.parentStatus,
						awaitingChildId: undefined,
						delegatedToId: undefined,
					}

			if (!childAtTarget) await this.writeTaskFile(repairedChild)
			if (!parentMatchesTargetState) await this.writeTaskFile(repairedParent)

			this.cache.set(repairedChild.id, repairedChild)
			this.cache.set(repairedParent.id, repairedParent)

			// The journal is retained until the write-through callback succeeds.
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
			await this.removeDelegationRepairIntent()
		})
	}

	/**
	 * Start and complete a guarded active-child repair while already holding the
	 * store lock. The intent is durable before either task file is touched.
	 */
	private async repairActiveDelegation(parent: HistoryItem, child: HistoryItem): Promise<void> {
		const intent: DelegationRepairIntent = {
			version: 1,
			operationId: crypto.randomUUID(),
			parentTaskId: parent.id,
			childTaskId: child.id,
			expected: {
				parent: {
					status: "delegated",
					awaitingChildId: child.id,
					delegatedToId: parent.delegatedToId,
				},
				child: {
					status: "active",
					parentTaskId: child.parentTaskId,
					rootTaskId: child.rootTaskId,
				},
			},
			target: { childStatus: "interrupted", parentStatus: "active" },
		}

		await this.writeDelegationRepairIntent(intent)
		await this.applyDelegationRepairIntent(intent, child, parent)
	}

	private async applyDelegationRepairIntent(
		intent: DelegationRepairIntent,
		child: HistoryItem,
		parent: HistoryItem,
	): Promise<void> {
		const repairedChild = { ...child, status: intent.target.childStatus }
		const repairedParent = {
			...parent,
			status: intent.target.parentStatus,
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}

		await this.writeTaskFile(repairedChild)
		await this.writeTaskFile(repairedParent)

		this.cache.set(repairedChild.id, repairedChild)
		this.cache.set(repairedParent.id, repairedParent)

		if (this.onWrite) {
			await this.onWrite(this.getAll())
		}
		await this.removeDelegationRepairIntent()
	}

	private matchesDelegationRepairParentPreconditions(intent: DelegationRepairIntent, parent: HistoryItem): boolean {
		return (
			parent.status === intent.expected.parent.status &&
			parent.awaitingChildId === intent.expected.parent.awaitingChildId &&
			parent.delegatedToId === intent.expected.parent.delegatedToId
		)
	}

	private matchesDelegationRepairChildPreconditions(intent: DelegationRepairIntent, child: HistoryItem): boolean {
		return (
			(child.status ?? "active") === intent.expected.child.status &&
			child.parentTaskId === intent.expected.child.parentTaskId &&
			child.rootTaskId === intent.expected.child.rootTaskId
		)
	}

	private async readDelegationRepairIntent(): Promise<DelegationRepairIntent | null> {
		const intentPath = await this.getDelegationRepairIntentPath()
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFileWithMissingRetry(intentPath)) as unknown
		} catch (error) {
			if (this.isFileNotFoundError(error)) {
				return null
			}
			await this.quarantineDelegationRepairIntent(null, "malformed JSON")
			return null
		}

		if (!this.isDelegationRepairIntent(parsed)) {
			await this.quarantineDelegationRepairIntent(null, "malformed intent")
			return null
		}
		return parsed
	}

	private isDelegationRepairIntent(value: unknown): value is DelegationRepairIntent {
		if (!value || typeof value !== "object") {
			return false
		}
		const candidate = value as Record<string, unknown>
		const expected = candidate.expected
		const expectedRecord = expected && typeof expected === "object" ? (expected as Record<string, unknown>) : null
		const expectedParent =
			expectedRecord?.parent && typeof expectedRecord.parent === "object"
				? (expectedRecord.parent as Record<string, unknown>)
				: null
		const expectedChild =
			expectedRecord?.child && typeof expectedRecord.child === "object"
				? (expectedRecord.child as Record<string, unknown>)
				: null
		const target = candidate.target
		const targetRecord = target && typeof target === "object" ? (target as Record<string, unknown>) : null
		return (
			candidate.version === 1 &&
			typeof candidate.operationId === "string" &&
			this.isSafeTaskId(candidate.parentTaskId) &&
			this.isSafeTaskId(candidate.childTaskId) &&
			candidate.parentTaskId !== candidate.childTaskId &&
			!!expectedParent &&
			expectedParent.status === "delegated" &&
			typeof expectedParent.awaitingChildId === "string" &&
			expectedParent.awaitingChildId === candidate.childTaskId &&
			(expectedParent.delegatedToId === undefined || typeof expectedParent.delegatedToId === "string") &&
			!!expectedChild &&
			expectedChild.status === "active" &&
			(expectedChild.parentTaskId === undefined || typeof expectedChild.parentTaskId === "string") &&
			(expectedChild.rootTaskId === undefined || typeof expectedChild.rootTaskId === "string") &&
			!!targetRecord &&
			targetRecord.childStatus === "interrupted" &&
			targetRecord.parentStatus === "active"
		)
	}

	private async writeDelegationRepairIntent(intent: DelegationRepairIntent): Promise<void> {
		await safeWriteJson(await this.getDelegationRepairIntentPath(), intent)
	}

	private async removeDelegationRepairIntent(): Promise<void> {
		try {
			await deleteJsonFile(await this.getDelegationRepairIntentPath())
		} catch (error) {
			console.warn("[TaskHistoryStore] Failed to remove completed delegation repair intent:", error)
		}
	}

	private async quarantineDelegationRepairIntent(
		intent: DelegationRepairIntent | null,
		reason: string,
	): Promise<void> {
		const intentPath = await this.getDelegationRepairIntentPath()
		const quarantinePath = `${intentPath}.quarantine-${Date.now()}-${Math.random().toString(36).slice(2)}`
		try {
			await fs.rename(intentPath, quarantinePath)
		} catch (error) {
			console.warn("[TaskHistoryStore] Failed to quarantine delegation repair intent:", error)
		}
		console.warn(
			`[TaskHistoryStore] Ignored ${intent ? `stale delegation repair intent ${intent.operationId}` : "malformed delegation repair intent"}: ${reason}`,
		)
	}

	private isSafeTaskId(value: unknown): value is string {
		return (
			typeof value === "string" &&
			value.length > 0 &&
			value !== "." &&
			value !== ".." &&
			!value.includes("/") &&
			!value.includes("\\")
		)
	}

	private isFileNotFoundError(error: unknown): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
	}

	private async getDelegationRepairIntentPath(): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
	}

	// ────────────────────────────── Cache invalidation ──────────────────────────────

	/**
	 * Invalidate a single task's cache entry (re-read from disk on next access).
	 */
	async invalidate(taskId: string): Promise<void> {
		return this.withLock(async () => {
			try {
				const item = await this.readTaskFile(taskId)
				if (item) {
					this.cache.set(taskId, item)
				} else {
					this.cache.delete(taskId)
				}
				this.taskFileMtimes.delete(taskId)
			} catch {
				this.cache.delete(taskId)
			}
		})
	}

	/**
	 * Clear all in-memory cache entries; a subsequent `reconcile()` repopulates them from task files.
	 */
	async invalidateAll(): Promise<void> {
		return this.withLock(async () => {
			this.cache.clear()
		})
	}

	// ────────────────────────────── Migration ──────────────────────────────

	/**
	 * Migrate from globalState taskHistory array to per-task files.
	 *
	 * For each entry in the globalState array, writes a `history_item.json`
	 * file if one doesn't already exist. This is idempotent and safe to re-run.
	 */
	async migrateFromGlobalState(taskHistoryEntries: HistoryItem[]): Promise<void> {
		if (!taskHistoryEntries || taskHistoryEntries.length === 0) {
			return
		}

		await this.withLock(async () => {
			const tasksDir = await this.getTasksDir()

			for (const item of taskHistoryEntries) {
				if (!item.id) {
					continue
				}

				// Check if task directory exists on disk
				const taskDir = path.join(tasksDir, item.id)

				try {
					await fs.access(taskDir)
				} catch {
					// Task directory doesn't exist; skip this entry as it's orphaned in globalState
					continue
				}

				// Write history_item.json if it doesn't exist yet
				const filePath = path.join(taskDir, GlobalFileNames.historyItem)
				try {
					await fs.access(filePath)
					// File already exists, skip (don't overwrite existing per-task files)
				} catch (error) {
					if (getErrorCode(error) !== "ENOENT") throw error
					// Recovery or a peer may supply a committed record after the access check.
					let persisted = item
					await safeWriteJson(filePath, item, {
						merge: (existing) => {
							if (existing !== null) {
								const recovered = historyItemSchema.parse(existing)
								if (recovered.id !== item.id) throw new Error("Migration task ID mismatch")
								persisted = recovered
							}
							return persisted
						},
					})
					this.cache.set(item.id, persisted)
				}
			}

			// Repair any delegation inconsistencies introduced by the migrated entries.
			// Run the lock-free core because migration already holds the store lock.
			await this.reconcileDelegationStateCore(this.getPersistedActiveIds())
		})
	}

	// ────────────────────────────── Private: Per-task file I/O ──────────────────────────────

	/**
	 * Return only the fields in `incoming` that differ from `cached`.
	 */
	private computeDelta(cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return computeHistoryDelta(cached, incoming)
	}

	private buildDelta(id: string, cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return { id, ...this.computeDelta(cached, incoming) }
	}

	/**
	 * Write a HistoryItem to its per-task `history_item.json` file.
	 *
	 * When `delta` is provided, the merge callback applies only the
	 * delta to the current disk state, so fields written by another
	 * process are preserved. Without a delta the full item is written
	 * as-is (used by administrative repair paths that are authoritative).
	 */
	private async writeTaskFile(item: HistoryItem, delta?: Partial<HistoryItem>): Promise<HistoryItem> {
		const filePath = await this.getTaskFilePath(item.id)
		if (delta) {
			let written: HistoryItem = item
			const mergeFn = mergeWithDisk(delta)
			await safeWriteJson(filePath, item, {
				merge: (existing, incoming) => {
					const result = mergeFn(existing, incoming)
					written = result as HistoryItem
					return result
				},
			})
			return written
		} else {
			await safeWriteJson(filePath, item)
			return item
		}
	}

	/**
	 * Read a HistoryItem from its per-task `history_item.json` file.
	 */
	private async readTaskFile(taskId: string): Promise<HistoryItem | null> {
		const filePath = await this.getTaskFilePath(taskId)

		try {
			const raw = await readFileWithMissingRetry(filePath)
			const item: HistoryItem = JSON.parse(raw)
			return item.id ? item : null
		} catch {
			return null
		}
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	/**
	 * Watch the tasks directory for changes from other instances.
	 */
	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		// Use a debounced handler to avoid excessive reconciliation
		let watchDebounce: ReturnType<typeof setTimeout> | null = null

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, _filename) => {
						if (this.disposed) {
							return
						}

						// Debounce the reconciliation triggered by fs.watch
						if (watchDebounce) {
							clearTimeout(watchDebounce)
						}
						watchDebounce = setTimeout(() => {
							this.reconcile().catch((err) => {
								console.error("[TaskHistoryStore] Reconciliation after fs.watch failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						console.error("[TaskHistoryStore] fs.watch error:", err)
						// fs.watch is unreliable on some platforms; periodic reconciliation
						// serves as the fallback.
					})
				} catch (err) {
					console.error("[TaskHistoryStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				console.error("[TaskHistoryStore] Failed to get tasks dir for watcher:", err)
			})
	}

	/**
	 * Start periodic reconciliation as a defensive fallback for platforms
	 * where fs.watch is unreliable.
	 */
	private startPeriodicReconciliation(): void {
		if (this.disposed) {
			return
		}

		this.reconcileTimer = setTimeout(async () => {
			if (this.disposed) {
				return
			}
			try {
				await this.reconcile()
			} catch (err) {
				console.error("[TaskHistoryStore] Periodic reconciliation failed:", err)
			}
			this.startPeriodicReconciliation()
		}, TaskHistoryStore.RECONCILE_INTERVAL_MS)
	}

	// ────────────────────────────── Atomic read-modify-write ──────────────────────────────

	/**
	 * Read a HistoryItem from the in-memory cache and write back an updated version,
	 * all within a single lock acquisition so no concurrent writer can interleave
	 * between the read and the write.
	 *
	 * The `updater` receives the current cached item and must return the new item
	 * synchronously. It must not perform I/O or acquire any other lock.
	 *
	 * @throws If the task ID is not present in the cache.
	 */
	public atomicReadAndUpdate(taskId: string, updater: (current: HistoryItem) => HistoryItem): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const current = this.cache.get(taskId)
			if (!current) {
				throw new Error(`[TaskHistoryStore] atomicReadAndUpdate: task ${taskId} not found in cache`)
			}
			// Deep-copy so a mutating updater cannot alter cached state before persistence.
			const snapshot = structuredClone(current)
			const updated = updater(snapshot)
			if (updated.id !== taskId) {
				throw new Error(
					`[TaskHistoryStore] atomicReadAndUpdate: updater changed task id from ${taskId} to ${updated.id}`,
				)
			}
			return this.upsertCore(updated)
		})
	}

	/**
	 * Update two related HistoryItems within a single in-process lock acquisition.
	 * Both updaters run synchronously (no I/O, no lock re-entry). Both writes
	 * complete before the lock releases, so no in-process reader can observe an
	 * intermediate state. Cross-process atomicity is NOT guaranteed — each
	 * writeTaskFile call acquires and releases its own advisory file lock.
	 *
	 * @throws If either task ID is not present in the cache.
	 */
	public atomicUpdatePair(
		firstId: string,
		secondId: string,
		firstUpdater: (current: HistoryItem) => HistoryItem,
		secondUpdater: (current: HistoryItem) => HistoryItem,
	): Promise<HistoryItem[]> {
		return this.withLock(async () => {
			const first = this.cache.get(firstId)
			if (!first) throw new Error(`[TaskHistoryStore] atomicUpdatePair: ${firstId} not found`)
			const second = this.cache.get(secondId)
			if (!second) throw new Error(`[TaskHistoryStore] atomicUpdatePair: ${secondId} not found`)

			const updatedFirst = firstUpdater(structuredClone(first))
			const updatedSecond = secondUpdater(structuredClone(second))

			if (updatedFirst.id !== firstId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: first updater changed id from ${firstId} to ${updatedFirst.id}`,
				)
			}
			if (updatedSecond.id !== secondId) {
				throw new Error(
					`[TaskHistoryStore] atomicUpdatePair: second updater changed id from ${secondId} to ${updatedSecond.id}`,
				)
			}

			// Validate status transitions before any disk write — mirrors upsertCore guard.
			for (const [existing, updated] of [
				[first, updatedFirst],
				[second, updatedSecond],
			] as const) {
				if (updated.status !== undefined) {
					const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
					if (updated.status !== normalizedExisting) {
						assertValidTransition(existing.status, updated.status)
					}
				}
			}

			// Merge with existing cache entries before writing, mirroring upsertCore.
			const mergedFirst = { ...first, ...updatedFirst }
			const mergedSecond = { ...second, ...updatedSecond }

			const writtenFirst = await this.writeTaskFile(mergedFirst, this.buildDelta(firstId, first, updatedFirst))
			let writtenSecond: HistoryItem
			try {
				writtenSecond = await this.writeTaskFile(mergedSecond, this.buildDelta(secondId, second, updatedSecond))
			} catch (error) {
				// First record is committed on disk. Update cache so it
				// reflects disk state before propagating the error.
				this.cache.set(firstId, writtenFirst)
				throw error
			}

			// Both disk writes succeeded — now update the cache.
			this.cache.set(firstId, writtenFirst)
			this.cache.set(secondId, writtenSecond)

			const all = this.getAll()
			if (this.onWrite) {
				await this.onWrite(all)
			}
			return all
		})
	}

	/**
	 * Disk-authoritative compare-and-clear for a rejected `create_subtask`
	 * pending action (#1714). The comparison runs inside the per-file
	 * advisory lock's merge callback, so the decision reads the persisted
	 * record rather than this store's possibly stale cache. Settlement goes
	 * through the shared `settleRejectedCreateSubtaskAction` reducer, so a
	 * completed record is never mutated and a missing, different-kind, or
	 * replacement pending action is preserved unchanged. The authoritative
	 * record is written back, the store cache is refreshed with it, and it
	 * is returned to the caller.
	 *
	 * Deletion by another host is authoritative (#1726): when no persisted
	 * record exists, the merge callback removes the stale cache entry and
	 * throws instead of writing the cached record back to disk. A persisted
	 * record must also match the canonical task-history schema and carry the
	 * requested task ID; malformed or mismatched records drop the stale
	 * cache entry and fail settlement closed without rewriting the record.
	 *
	 * @throws If the task ID is not present in the cache, no persisted record remains on disk,
	 * or the persisted record is invalid or belongs to a different task ID.
	 */
	public async clearPendingActionIfMatching(taskId: string, expectedActionId: string): Promise<HistoryItem> {
		return this.withLock(async () => {
			const cached = this.cache.get(taskId)
			if (!cached) {
				throw new Error(`[TaskHistoryStore] clearPendingActionIfMatching: task ${taskId} not found in cache`)
			}
			const filePath = await this.getTaskFilePath(taskId)
			let authoritative: HistoryItem = cached
			let missingDiskRecord = false
			try {
				await safeWriteJson(filePath, cached, {
					merge: (existing) => {
						if (existing === null || existing === undefined) {
							// Writing the cached record back would recreate a task
							// another host deleted, so drop the stale entry first.
							// A throwing merge writes nothing, so the deleted
							// record stays deleted.
							missingDiskRecord = true
							this.cache.delete(taskId)
							this.taskFileMtimes.delete(taskId)
							throw new Error(
								`[TaskHistoryStore] clearPendingActionIfMatching: task ${taskId} not found in cache`,
							)
						}
						// Validate the locked disk record with the canonical
						// task-history schema (#1726). Settlement must not
						// rewrite malformed data and must not clear the action
						// on a record persisted under a different task ID, so
						// both cases drop the stale cache entry and fail
						// closed without touching the disk record.
						const parsed = historyItemSchema.safeParse(existing)
						if (!parsed.success) {
							this.cache.delete(taskId)
							this.taskFileMtimes.delete(taskId)
							throw new Error(
								`[TaskHistoryStore] clearPendingActionIfMatching: task ${taskId} has an invalid disk record`,
							)
						}
						if (parsed.data.id !== taskId) {
							this.cache.delete(taskId)
							this.taskFileMtimes.delete(taskId)
							throw new Error(
								`[TaskHistoryStore] clearPendingActionIfMatching: task ${taskId} has a disk record with mismatched id ${parsed.data.id}`,
							)
						}
						const disk = existing as HistoryItem
						authoritative = settleRejectedCreateSubtaskAction(disk, expectedActionId)
						return authoritative
					},
				})
			} catch (error) {
				if (missingDiskRecord) {
					throw new Error(
						`[TaskHistoryStore] clearPendingActionIfMatching: task ${taskId} not found in cache`,
					)
				}
				throw error
			}
			this.cache.set(taskId, authoritative)
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
			return authoritative
		})
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	/**
	 * Serializes all read-modify-write operations within a single extension
	 * host process to prevent concurrent interleaving.
	 */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: Path helpers ──────────────────────────────

	/**
	 * Get the tasks base directory path, resolving custom storage paths.
	 */
	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	/**
	 * Get the path to a task's `history_item.json` file.
	 */
	private async getTaskFilePath(taskId: string): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, taskId, GlobalFileNames.historyItem)
	}
}
