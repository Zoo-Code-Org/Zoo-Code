import type {
	DashboardTaskApiCall,
	DashboardTaskDetail,
	DashboardTaskPage,
	DashboardTaskSummary,
	UsageEventV1,
} from "@roo-code/types"

import { DashboardTaskCatalog } from "./DashboardTaskCatalog"
import type { TaskIdentityAggregate, TaskUsageRow } from "./UsageStatsDatabase"
import { getEffectiveCost, computeCacheDiscountBase, applyCacheDiscount } from "./costRecalculation"
import { type StatsQueryRangeMs } from "./statsQueryRange"

/** Error codes emitted by the History-first Dashboard task projection. */
export type DashboardTaskProjectionErrorCode = "DASHBOARD_TASK_PROJECTION/computeTaskDetail/001"

/** Raised when a detail is requested for a task absent from the History catalog. */
export class DashboardTaskProjectionError extends Error {
	constructor(
		public readonly code: DashboardTaskProjectionErrorCode,
		message: string,
	) {
		super(`[${code}] ${message}`)
		this.name = "DashboardTaskProjectionError"
	}
}

interface SubtreeUsageSummary {
	totalCost: number
	totalTokens: number
	inputTokens: number
	outputTokens: number
	eventCount: number
	lastUsageAt?: number
	model: string
	provider: string
	models: string[]
	modes: string[]
}

/** Read-only usage queries required by the Dashboard task projection. */
export interface DashboardTaskUsageReader {
	queryTaskUsageByTaskIds(taskIds: string[], rangeMs?: StatsQueryRangeMs): Map<string, TaskUsageRow>
	queryTaskIdentityAggregates(taskIds: string[], rangeMs?: StatsQueryRangeMs): Map<string, TaskIdentityAggregate>
	queryEventsByTaskIds(taskIds: string[], rangeMs?: StatsQueryRangeMs): Array<UsageEventV1 & { sequence: number }>
}

/**
 * Pages the immutable History task catalog (root tasks only), batch-loads
 * direct task usage for every required subtree, then composes one summary per
 * catalog row plus one per direct child (`childTasks`).
 *
 * When `rangeMs` is bounded, the catalog pages only roots whose subtree has a
 * task created inside the range, and per-task figures aggregate only in-range
 * usage events. An absent or unbounded range keeps all-time behavior.
 *
 * When `cacheRatio` is provided, subtree costs are discounted by
 * `cacheRatio × Σ cacheDiscountBase` (floored at 0), matching the stats
 * snapshot semantics: estimated cache reads are priced at the cache-read rate.
 */
export function computeTaskPage(
	catalog: DashboardTaskCatalog,
	db: DashboardTaskUsageReader,
	requestId: string,
	cursor?: string,
	limit?: number,
	rangeMs?: StatsQueryRangeMs,
	cacheRatio?: number,
): DashboardTaskPage {
	const catalogPage = catalog.getPage(cursor, limit, rangeMs)
	const subtreeTaskIds = collectPageSubtreeTaskIds(catalog, catalogPage.tasks)
	const usageByTaskId = db.queryTaskUsageByTaskIds(subtreeTaskIds, rangeMs)
	const identityByTaskId = db.queryTaskIdentityAggregates(subtreeTaskIds, rangeMs)

	// Direct children of this page's roots ride along so the client can render
	// an expanded root without an extra round-trip. Their usage rows are
	// already loaded (children are part of their root's subtree).
	const childTaskIds = catalogPage.tasks.flatMap((taskId) => catalog.childrenByParentId.get(taskId) ?? [])

	return {
		requestId,
		catalogRevision: catalog.catalogRevision,
		tasks: catalogPage.tasks.map((taskId) =>
			computeTaskSummary(catalog, taskId, usageByTaskId, identityByTaskId, cacheRatio),
		),
		childTasks: childTaskIds.map((taskId) =>
			computeTaskSummary(catalog, taskId, usageByTaskId, identityByTaskId, cacheRatio),
		),
		cursor: catalogPage.cursor,
		totalEstimate: catalogPage.totalEstimate,
	}
}

/**
 * Computes complete current summaries for a known set of History task IDs.
 * Callers use this for stream upserts after usage mutations without changing
 * catalog membership or pagination order.
 *
 * When `rangeMs` is bounded, tasks whose subtree has no task created inside
 * the range are dropped (matching page membership) and figures aggregate only
 * in-range usage events.
 */
export function computeTaskSummaries(
	catalog: DashboardTaskCatalog,
	db: DashboardTaskUsageReader,
	taskIds: readonly string[],
	rangeMs?: StatsQueryRangeMs,
	cacheRatio?: number,
): DashboardTaskSummary[] {
	const knownTaskIds = [...new Set(taskIds)].filter(
		(taskId) => catalog.byId.has(taskId) && catalog.isSubtreeWithinRange(rangeMs, taskId),
	)
	const subtreeTaskIds = collectPageSubtreeTaskIds(catalog, knownTaskIds)
	const usageByTaskId = db.queryTaskUsageByTaskIds(subtreeTaskIds, rangeMs)
	const identityByTaskId = db.queryTaskIdentityAggregates(subtreeTaskIds, rangeMs)
	return knownTaskIds.map((taskId) =>
		computeTaskSummary(catalog, taskId, usageByTaskId, identityByTaskId, cacheRatio),
	)
}

/**
 * Returns focused detail for a History task and its descendants. Empty usage is
 * successful and still includes the History title and timestamp.
 * When `rangeMs` is bounded, only in-range usage events are included.
 */
export function computeTaskDetail(
	catalog: DashboardTaskCatalog,
	db: DashboardTaskUsageReader,
	taskId: string,
	_requestId: string,
	rangeMs?: StatsQueryRangeMs,
	cacheRatio?: number,
): DashboardTaskDetail {
	const task = catalog.byId.get(taskId)
	if (!task) {
		throw new DashboardTaskProjectionError(
			"DASHBOARD_TASK_PROJECTION/computeTaskDetail/001",
			`Task ${taskId} was not found in the current History catalog`,
		)
	}

	const events = db.queryEventsByTaskIds([taskId, ...catalog.getDescendantTaskIds(taskId)], rangeMs)
	const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence)

	return {
		taskId,
		title: task.task,
		taskTimestamp: task.ts,
		models: uniqueInFirstSeenOrder(sortedEvents.map((event) => event.model)),
		modes: uniqueInFirstSeenOrder(sortedEvents.map((event) => event.mode)),
		totalTokens: sortedEvents.reduce((total, event) => total + getTotalTokens(event), 0),
		totalCost: sortedEvents.reduce(
			(total, event) =>
				total + applyCacheDiscount(getEffectiveCost(event), computeCacheDiscountBase(event), cacheRatio),
			0,
		),
		callCount: sortedEvents.length,
		apiCalls: sortedEvents.map((event, index) => eventToApiCall(event, index + 1, cacheRatio)),
	}
}

function collectPageSubtreeTaskIds(catalog: DashboardTaskCatalog, pageTaskIds: readonly string[]): string[] {
	const taskIds = new Set<string>()
	for (const taskId of pageTaskIds) {
		taskIds.add(taskId)
		for (const descendantTaskId of catalog.getDescendantTaskIds(taskId)) {
			taskIds.add(descendantTaskId)
		}
	}
	return [...taskIds]
}

function computeTaskSummary(
	catalog: DashboardTaskCatalog,
	taskId: string,
	usageByTaskId: ReadonlyMap<string, TaskUsageRow>,
	identityByTaskId: ReadonlyMap<string, TaskIdentityAggregate>,
	cacheRatio?: number,
): DashboardTaskSummary {
	const task = catalog.byId.get(taskId)!
	const subtreeUsage = summarizeSubtreeUsage(
		[taskId, ...catalog.getDescendantTaskIds(taskId)],
		usageByTaskId,
		identityByTaskId,
		cacheRatio,
	)

	return {
		taskId,
		rootTaskId: task.rootTaskId ?? resolveRootTaskId(catalog, taskId),
		parentTaskId: task.parentTaskId,
		title: task.task,
		taskTimestamp: task.ts,
		lastUsageAt: subtreeUsage.lastUsageAt,
		totalCost: subtreeUsage.totalCost,
		totalTokens: subtreeUsage.totalTokens,
		inputTokens: subtreeUsage.inputTokens,
		outputTokens: subtreeUsage.outputTokens,
		model: subtreeUsage.model,
		provider: subtreeUsage.provider,
		models: subtreeUsage.models,
		modes: subtreeUsage.modes,
		eventCount: subtreeUsage.eventCount,
		childTaskIds: [...(catalog.childrenByParentId.get(taskId) ?? [])],
	}
}

function summarizeSubtreeUsage(
	taskIds: readonly string[],
	usageByTaskId: ReadonlyMap<string, TaskUsageRow>,
	identityByTaskId: ReadonlyMap<string, TaskIdentityAggregate>,
	cacheRatio?: number,
): SubtreeUsageSummary {
	let totalCost = 0
	let totalCacheDiscountBase = 0
	let totalTokens = 0
	let inputTokens = 0
	let outputTokens = 0
	let eventCount = 0
	let latestUsage: TaskUsageRow | undefined
	const subtreeModels: string[] = []
	const subtreeModes: string[] = []

	// taskIds arrive in subtree order (the task itself first, then descendants
	// in getDescendantTaskIds order), so concatenating each task's lists in
	// iteration order and deduping first-seen keeps that order in the union.
	for (const taskId of taskIds) {
		const identity = identityByTaskId.get(taskId)
		if (identity) {
			inputTokens += identity.inputTokens
			outputTokens += identity.outputTokens
			subtreeModels.push(...identity.models)
			subtreeModes.push(...identity.modes)
		}

		const usage = usageByTaskId.get(taskId)
		if (!usage) {
			continue
		}

		totalCost += usage.totalCost
		totalCacheDiscountBase += usage.cacheDiscountBase ?? 0
		totalTokens += usage.totalTokens
		eventCount += usage.eventCount
		if (
			usage.eventCount > 0 &&
			(!latestUsage ||
				usage.lastActivity > latestUsage.lastActivity ||
				(usage.lastActivity === latestUsage.lastActivity && usage.taskId > latestUsage.taskId))
		) {
			latestUsage = usage
		}
	}

	return {
		totalCost: applyCacheDiscount(totalCost, totalCacheDiscountBase, cacheRatio),
		totalTokens,
		inputTokens,
		outputTokens,
		eventCount,
		lastUsageAt: latestUsage?.lastActivity,
		model: latestUsage?.model ?? "",
		provider: latestUsage?.provider ?? "",
		models: uniqueInFirstSeenOrder(subtreeModels),
		modes: uniqueInFirstSeenOrder(subtreeModes),
	}
}

function resolveRootTaskId(catalog: DashboardTaskCatalog, taskId: string): string {
	const ancestors = catalog.ancestorsByTaskId.get(taskId)
	return ancestors?.at(-1) ?? taskId
}

function getTotalTokens(event: UsageEventV1): number {
	return (
		event.usage.totalTokens?.value ?? (event.usage.inputTokens?.value ?? 0) + (event.usage.outputTokens?.value ?? 0)
	)
}

function eventToApiCall(event: UsageEventV1, index: number, cacheRatio?: number): DashboardTaskApiCall {
	return {
		index,
		mode: event.mode,
		timestamp: new Date(event.occurredAt).getTime(),
		inputTokens: event.usage.inputTokens?.value ?? 0,
		outputTokens: event.usage.outputTokens?.value ?? 0,
		cacheReadTokens: event.usage.cacheReadTokens?.value ?? 0,
		cacheWriteTokens: event.usage.cacheWriteTokens?.value ?? 0,
		reasoningTokens: event.usage.reasoningTokens?.value ?? 0,
		costUsd: applyCacheDiscount(getEffectiveCost(event), computeCacheDiscountBase(event), cacheRatio),
		status: event.status,
		model: event.model,
	}
}

function uniqueInFirstSeenOrder(values: readonly string[]): string[] {
	return [...new Set(values)]
}
