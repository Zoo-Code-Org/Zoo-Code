import * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { isStatsQueryRangeBounded, isWithinStatsQueryRange, type StatsQueryRangeMs } from "./statsQueryRange"

/** The read-only TaskHistoryStore surface consumed by the task catalog. */
export interface DashboardTaskCatalogSource {
	getAll(): HistoryItem[]
	onDidChange: vscode.Event<void>
	initialized?: Promise<void>
}

/** Immutable indexes associated with one dashboard task catalog revision. */
export interface DashboardTaskCatalogSnapshot {
	revision: number
	byId: ReadonlyMap<string, HistoryItem>
	childrenByParentId: ReadonlyMap<string, readonly string[]>
	ancestorsByTaskId: ReadonlyMap<string, readonly string[]>
	orderedTaskIds: readonly string[]
}

/** A deterministic page of task IDs from one catalog revision. */
export interface DashboardTaskCatalogPage {
	tasks: string[]
	cursor?: string
	totalEstimate: number
}

export type DashboardTaskCatalogErrorCode = "DASHBOARD_TASK_CATALOG/getPage/001" | "DASHBOARD_TASK_CATALOG/getPage/002"

/** An invalid or stale page cursor. */
export class DashboardTaskCatalogError extends Error {
	constructor(
		public readonly code: DashboardTaskCatalogErrorCode,
		message: string,
	) {
		super(`[${code}] ${message}`)
		this.name = "DashboardTaskCatalogError"
	}
}

interface DashboardTaskCatalogCursor {
	v: 1
	r: number
	ts: number
	id: string
}

const CATALOG_REBUILD_DEBOUNCE_MS = 300
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const EMPTY_TASK_IDS: readonly string[] = Object.freeze([])

/**
 * Immutable, History-first task read model for the Dashboard. Membership uses
 * the History validity rule, truthy `ts` and `task`, without workspace filtering.
 */
export class DashboardTaskCatalog implements vscode.Disposable {
	private snapshot: DashboardTaskCatalogSnapshot
	private descendantsMemo = new Map<string, readonly string[]>()
	private readonly didChangeEmitter = new vscode.EventEmitter<DashboardTaskCatalogSnapshot>()
	private readonly sourceSubscription: vscode.Disposable
	private rebuildTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false

	/** Fires after a debounced source mutation produces a new snapshot. */
	public readonly onDidChange: vscode.Event<DashboardTaskCatalogSnapshot> = this.didChangeEmitter.event

	constructor(private readonly source: DashboardTaskCatalogSource) {
		this.snapshot = this.createSnapshot(0)
		this.sourceSubscription = this.source.onDidChange(() => this.scheduleRebuild())
	}

	/** Current task-store-derived revision. */
	get catalogRevision(): number {
		return this.snapshot.revision
	}

	/** Resolves when the authoritative TaskHistoryStore has finished loading. */
	get sourceInitialized(): Promise<void> {
		return this.source.initialized ?? Promise.resolve()
	}

	/**
	 * Rebuilds synchronously after the History store's initial load completes.
	 * This is separate from the debounced source event because loading a valid
	 * index need not itself produce a TaskHistoryStore change event.
	 */
	rebuild(): void {
		if (this.disposed) {
			return
		}
		this.snapshot = this.createSnapshot(this.snapshot.revision + 1)
		this.descendantsMemo = new Map()
		this.didChangeEmitter.fire(this.snapshot)
	}

	get byId(): ReadonlyMap<string, HistoryItem> {
		return this.snapshot.byId
	}

	get childrenByParentId(): ReadonlyMap<string, readonly string[]> {
		return this.snapshot.childrenByParentId
	}

	get ancestorsByTaskId(): ReadonlyMap<string, readonly string[]> {
		return this.snapshot.ancestorsByTaskId
	}

	get orderedTaskIds(): readonly string[] {
		return this.snapshot.orderedTaskIds
	}

	/**
	 * Contains descendant calculations already requested for this revision. Use
	 * getDescendantTaskIds() to populate this lazy index.
	 */
	get descendantsByTaskId(): ReadonlyMap<string, readonly string[]> {
		return new ImmutableMap(this.descendantsMemo.entries())
	}

	getSnapshot(): DashboardTaskCatalogSnapshot {
		return this.snapshot
	}

	/**
	 * Resolves a task's subtree IDs in deterministic child order. The source task
	 * is omitted so callers can model `task + descendants` explicitly.
	 */
	getDescendantTaskIds(taskId: string): readonly string[] {
		const cached = this.descendantsMemo.get(taskId)
		if (cached) {
			return cached
		}
		if (!this.snapshot.byId.has(taskId)) {
			return EMPTY_TASK_IDS
		}

		const descendants: string[] = []
		const visited = new Set<string>([taskId])
		const pending = [...(this.snapshot.childrenByParentId.get(taskId) ?? [])].reverse()
		while (pending.length > 0) {
			const currentId = pending.pop()!
			if (visited.has(currentId)) {
				continue
			}

			visited.add(currentId)
			descendants.push(currentId)
			const children = this.snapshot.childrenByParentId.get(currentId)
			if (children) {
				for (let index = children.length - 1; index >= 0; index--) {
					pending.push(children[index])
				}
			}
		}

		const immutableDescendants = Object.freeze(descendants)
		this.descendantsMemo.set(taskId, immutableDescendants)
		return immutableDescendants
	}

	/**
	 * Uses a compound `(ts DESC, id DESC)` cursor. Cursors from older snapshots
	 * are rejected so pages never combine task catalog revisions.
	 *
	 * When `rangeMs` is bounded, membership is filtered on the task's creation
	 * timestamp (`HistoryItem.ts`) within the half-open `[fromMs, toMs)` range;
	 * ordering, cursor semantics, and `totalEstimate` (now the filtered count)
	 * are otherwise unchanged. An absent or unbounded range keeps the legacy
	 * unfiltered behavior.
	 */
	getPage(
		cursor?: string,
		limit: number = DEFAULT_PAGE_LIMIT,
		rangeMs?: StatsQueryRangeMs,
	): DashboardTaskCatalogPage {
		const pageLimit = normalizePageLimit(limit)
		const startIndex = cursor ? this.findPageStartIndex(this.decodeCursor(cursor)) : 0

		if (!isStatsQueryRangeBounded(rangeMs)) {
			const tasks = this.snapshot.orderedTaskIds.slice(startIndex, startIndex + pageLimit)
			const lastTaskId = tasks.at(-1)

			return {
				tasks: [...tasks],
				cursor:
					lastTaskId && startIndex + tasks.length < this.snapshot.orderedTaskIds.length
						? this.encodeCursor(lastTaskId)
						: undefined,
				totalEstimate: this.snapshot.orderedTaskIds.length,
			}
		}

		const orderedTaskIds = this.snapshot.orderedTaskIds
		const tasks: string[] = []
		let totalEstimate = 0
		let hasMore = false

		for (let index = 0; index < orderedTaskIds.length; index++) {
			const taskId = orderedTaskIds[index]
			const item = this.snapshot.byId.get(taskId)!
			if (!isWithinStatsQueryRange(rangeMs, item.ts)) {
				continue
			}
			totalEstimate += 1
			if (index < startIndex) {
				continue
			}
			if (tasks.length < pageLimit) {
				tasks.push(taskId)
			} else {
				hasMore = true
			}
		}

		const lastTaskId = tasks.at(-1)
		return {
			tasks,
			cursor: lastTaskId && hasMore ? this.encodeCursor(lastTaskId) : undefined,
			totalEstimate,
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer)
			this.rebuildTimer = null
		}
		this.sourceSubscription.dispose()
		this.didChangeEmitter.dispose()
	}

	private scheduleRebuild(): void {
		if (this.disposed) {
			return
		}
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer)
		}

		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = null
			if (this.disposed) {
				return
			}
			this.rebuild()
		}, CATALOG_REBUILD_DEBOUNCE_MS)
	}

	private createSnapshot(revision: number): DashboardTaskCatalogSnapshot {
		const latestItemsById = new Map<string, HistoryItem>()
		for (const item of this.source.getAll()) {
			if (item.id) {
				latestItemsById.set(item.id, item)
			}
		}

		const byId = new Map<string, HistoryItem>()
		for (const [taskId, item] of latestItemsById) {
			if (item.ts && item.task) {
				byId.set(taskId, freezeHistoryItem(item))
			}
		}

		const orderedTaskIds = [...byId.keys()].sort((leftId, rightId) => compareTaskIds(leftId, rightId, byId))
		const mutableChildrenByParentId = new Map<string, string[]>()
		for (const [taskId, item] of byId) {
			if (!item.parentTaskId || !byId.has(item.parentTaskId)) {
				continue
			}
			const children = mutableChildrenByParentId.get(item.parentTaskId) ?? []
			children.push(taskId)
			mutableChildrenByParentId.set(item.parentTaskId, children)
		}

		for (const children of mutableChildrenByParentId.values()) {
			children.sort((leftId, rightId) => compareTaskIds(leftId, rightId, byId))
		}

		const childrenByParentId = new Map<string, readonly string[]>()
		for (const [parentId, children] of mutableChildrenByParentId) {
			childrenByParentId.set(parentId, Object.freeze([...children]))
		}

		const ancestorsByTaskId = new Map<string, readonly string[]>()
		const reportedCycles = new Set<string>()
		for (const taskId of orderedTaskIds) {
			ancestorsByTaskId.set(taskId, this.resolveAncestors(taskId, byId, reportedCycles))
		}

		const snapshot: DashboardTaskCatalogSnapshot = {
			revision,
			byId: new ImmutableMap(byId),
			childrenByParentId: new ImmutableMap(childrenByParentId),
			ancestorsByTaskId: new ImmutableMap(ancestorsByTaskId),
			orderedTaskIds: Object.freeze(orderedTaskIds),
		}
		return Object.freeze(snapshot)
	}

	private resolveAncestors(
		taskId: string,
		byId: ReadonlyMap<string, HistoryItem>,
		reportedCycles: Set<string>,
	): readonly string[] {
		const ancestors: string[] = []
		const visited = new Set<string>([taskId])
		let currentId = taskId
		while (true) {
			const parentTaskId = byId.get(currentId)?.parentTaskId
			if (!parentTaskId || !byId.has(parentTaskId)) {
				break
			}
			if (visited.has(parentTaskId)) {
				const cycleKey = [...visited].sort().join(",")
				if (!reportedCycles.has(cycleKey)) {
					reportedCycles.add(cycleKey)
					console.warn(
						`[DASHBOARD_TASK_CATALOG/createSnapshot/001] Parent cycle detected for task ${taskId}: ${cycleKey}`,
					)
				}
				break
			}
			ancestors.push(parentTaskId)
			visited.add(parentTaskId)
			currentId = parentTaskId
		}
		return Object.freeze(ancestors)
	}

	private findPageStartIndex(cursor: DashboardTaskCatalogCursor): number {
		if (cursor.r !== this.snapshot.revision) {
			throw new DashboardTaskCatalogError(
				"DASHBOARD_TASK_CATALOG/getPage/002",
				`Cursor revision ${cursor.r} does not match catalog revision ${this.snapshot.revision}`,
			)
		}
		const index = this.snapshot.orderedTaskIds.findIndex((taskId) => {
			const item = this.snapshot.byId.get(taskId)!
			return item.ts < cursor.ts || (item.ts === cursor.ts && taskId < cursor.id)
		})
		return index === -1 ? this.snapshot.orderedTaskIds.length : index
	}

	private encodeCursor(taskId: string): string {
		const item = this.snapshot.byId.get(taskId)!
		const cursor: DashboardTaskCatalogCursor = { v: 1, r: this.snapshot.revision, ts: item.ts, id: taskId }
		return Buffer.from(JSON.stringify(cursor)).toString("base64url")
	}

	private decodeCursor(cursor: string): DashboardTaskCatalogCursor {
		try {
			const decoded = JSON.parse(
				Buffer.from(cursor, "base64url").toString("utf8"),
			) as Partial<DashboardTaskCatalogCursor>
			if (
				decoded.v !== 1 ||
				typeof decoded.r !== "number" ||
				typeof decoded.ts !== "number" ||
				typeof decoded.id !== "string"
			) {
				throw new Error("invalid cursor shape")
			}
			return decoded as DashboardTaskCatalogCursor
		} catch {
			throw new DashboardTaskCatalogError("DASHBOARD_TASK_CATALOG/getPage/001", "Cursor is invalid")
		}
	}
}

function normalizePageLimit(limit: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_PAGE_LIMIT
	}
	return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)))
}

function compareTaskIds(leftId: string, rightId: string, byId: ReadonlyMap<string, HistoryItem>): number {
	const left = byId.get(leftId)!
	const right = byId.get(rightId)!
	if (left.ts !== right.ts) {
		return right.ts - left.ts
	}
	return leftId < rightId ? 1 : leftId > rightId ? -1 : 0
}

function freezeHistoryItem(item: HistoryItem): HistoryItem {
	return Object.freeze({ ...item, childIds: item.childIds ? [...item.childIds] : undefined })
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
	readonly [Symbol.toStringTag] = "Map"
	private readonly internalMap: Map<K, V>

	constructor(entries: Iterable<readonly [K, V]>) {
		this.internalMap = new Map(entries)
		Object.freeze(this)
	}

	get size(): number {
		return this.internalMap.size
	}

	get(key: K): V | undefined {
		return this.internalMap.get(key)
	}

	has(key: K): boolean {
		return this.internalMap.has(key)
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		this.internalMap.forEach((value, key) => callbackfn.call(thisArg, value, key, this))
	}

	entries(): MapIterator<[K, V]> {
		return this.internalMap.entries()
	}

	keys(): MapIterator<K> {
		return this.internalMap.keys()
	}

	values(): MapIterator<V> {
		return this.internalMap.values()
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries()
	}
}
