import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import crypto from "crypto"

import deepEqual from "fast-deep-equal"
import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { LOCK_STALE_MS, safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"

/** Valid status values for a task's HistoryItem. */
export type HistoryItemStatus = NonNullable<HistoryItem["status"]>

export class DeltaRejectedError extends Error {
	constructor(
		public readonly taskId: string,
		public readonly diskStatus: HistoryItemStatus,
		public readonly attemptedStatus: HistoryItemStatus,
	) {
		super(`Delta rejected for task ${taskId}: disk status ${diskStatus} rejects transition to ${attemptedStatus}`)
		this.name = "DeltaRejectedError"
	}
}

const VALID_TRANSITIONS: Record<HistoryItemStatus, HistoryItemStatus[]> = {
	active: ["delegated", "completed", "interrupted"],
	delegated: ["active"],
	interrupted: ["completed"],
	completed: [],
}

/**
 * Asserts that a task status transition is valid, throwing if not.
 *
 * @throws {Error} When the transition is not allowed by the state machine.
 */
export function assertValidTransition(from: HistoryItemStatus | undefined, to: HistoryItemStatus): void {
	const fromStatus: HistoryItemStatus = from ?? "active"
	const validTargets = VALID_TRANSITIONS[fromStatus]
	if (!validTargets.includes(to)) {
		throw new Error(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
}

/**
 * Build a `safeWriteJson` merge callback that applies only `delta` to the
 * current disk state, preserving fields written by another process.
 */
function mergeWithDisk(delta: Partial<HistoryItem>): (existing: unknown, incoming: unknown) => unknown {
	return (existing, incoming) => {
		if (!existing || typeof existing !== "object" || !("id" in existing)) {
			return incoming
		}
		const disk = existing as HistoryItem
		if (delta.status !== undefined) {
			const diskStatus: HistoryItemStatus = disk.status ?? "active"
			if (delta.status !== diskStatus) {
				const validTargets = VALID_TRANSITIONS[diskStatus]
				if (!validTargets?.includes(delta.status as HistoryItemStatus)) {
					throw new DeltaRejectedError(disk.id, diskStatus, delta.status as HistoryItemStatus)
				}
			}
		}
		const merged = { ...disk, ...delta }
		if (delta.childIds && disk.childIds) {
			merged.childIds = [...new Set([...disk.childIds, ...delta.childIds])]
		}
		return merged
	}
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
	 * Delete a single task's history item.
	 */
	async delete(taskId: string): Promise<void> {
		return this.withLock(async () => {
			this.cache.delete(taskId)
			this.taskFileMtimes.delete(taskId)

			// Remove per-task file (best-effort)
			try {
				const filePath = await this.getTaskFilePath(taskId)
				await fs.unlink(filePath)
			} catch {
				// File may already be deleted
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	/**
	 * Delete multiple tasks' history items in a batch.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withLock(async () => {
			for (const taskId of taskIds) {
				this.cache.delete(taskId)
				this.taskFileMtimes.delete(taskId)

				try {
					const filePath = await this.getTaskFilePath(taskId)
					await fs.unlink(filePath)
				} catch {
					// File may already be deleted
				}
			}

			// Call onWrite callback inside the lock for serialized write-through
			if (this.onWrite) {
				await this.onWrite(this.getAll())
			}
		})
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

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
					const { mtimeMs } = await fs.stat(taskFilePath)
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
				} catch {
					// File may be temporarily absent during a peer's atomic
					// rename window in safeWriteJson. The advisory lock is
					// held for the entire write, so its presence means a
					// write is in progress — keep the task live.
					try {
						const lockPath = (await this.getTaskFilePath(taskId)) + ".lock"
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
			parsed = JSON.parse(await fs.readFile(intentPath, "utf8")) as unknown
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
			await fs.unlink(await this.getDelegationRepairIntentPath())
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
				} catch {
					// File doesn't exist, write it
					await safeWriteJson(filePath, item)
					this.cache.set(item.id, item)
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
		return Object.fromEntries(
			Object.entries(incoming).filter(([k, v]) => !deepEqual(v, (cached as Record<string, unknown>)[k])),
		) as Partial<HistoryItem>
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
			const raw = await fs.readFile(filePath, "utf8")
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
