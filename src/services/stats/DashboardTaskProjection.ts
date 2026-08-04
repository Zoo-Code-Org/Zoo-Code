import type {
	DashboardTaskApiCall,
	DashboardTaskDetail,
	DashboardTaskPage,
	DashboardTaskSummary,
	UsageEventV1,
} from "@roo-code/types"

import { DashboardTaskCatalog } from "./DashboardTaskCatalog"
import type { TaskUsageRow } from "./UsageStatsDatabase"
import { getEffectiveCost } from "./costRecalculation"
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
	eventCount: number
	lastUsageAt?: number
	model: string
	provider: string
}

/** Read-only usage queries required by the Dashboard task projection. */
export interface DashboardTaskUsageReader {
	queryTaskUsageByTaskIds(taskIds: string[], rangeMs?: StatsQueryRangeMs): Map<string, TaskUsageRow>
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
 */
export function computeTaskPage(
	catalog: DashboardTaskCatalog,
	db: DashboardTaskUsageReader,
	requestId: string,
	cursor?: string,
	limit?: number,
	rangeMs?: StatsQueryRangeMs,
): DashboardTaskPage {
	const catalogPage = catalog.getPage(cursor, limit, rangeMs)
	const usageByTaskId = db.queryTaskUsageByTaskIds(collectPageSubtreeTaskIds(catalog, catalogPage.tasks), rangeMs)

	// Direct children of this page's roots ride along so the client can render
	// an expanded root without an extra round-trip. Their usage rows are
	// already loaded (children are part of their root's subtree).
	const childTaskIds = catalogPage.tasks.flatMap((taskId) => catalog.childrenByParentId.get(taskId) ?? [])

	return {
		requestId,
		catalogRevision: catalog.catalogRevision,
		tasks: catalogPage.tasks.map((taskId) => computeTaskSummary(catalog, taskId, usageByTaskId)),
		childTasks: childTaskIds.map((taskId) => computeTaskSummary(catalog, taskId, usageByTaskId)),
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
): DashboardTaskSummary[] {
	const knownTaskIds = [...new Set(taskIds)].filter(
		(taskId) => catalog.byId.has(taskId) && catalog.isSubtreeWithinRange(rangeMs, taskId),
	)
	const usageByTaskId = db.queryTaskUsageByTaskIds(collectPageSubtreeTaskIds(catalog, knownTaskIds), rangeMs)
	return knownTaskIds.map((taskId) => computeTaskSummary(catalog, taskId, usageByTaskId))
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
		totalCost: sortedEvents.reduce((total, event) => total + getEffectiveCost(event), 0),
		callCount: sortedEvents.length,
		apiCalls: sortedEvents.map((event, index) => eventToApiCall(event, index + 1)),
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
): DashboardTaskSummary {
	const task = catalog.byId.get(taskId)!
	const subtreeUsage = summarizeSubtreeUsage([taskId, ...catalog.getDescendantTaskIds(taskId)], usageByTaskId)

	return {
		taskId,
		rootTaskId: task.rootTaskId ?? resolveRootTaskId(catalog, taskId),
		parentTaskId: task.parentTaskId,
		title: task.task,
		taskTimestamp: task.ts,
		lastUsageAt: subtreeUsage.lastUsageAt,
		totalCost: subtreeUsage.totalCost,
		totalTokens: subtreeUsage.totalTokens,
		model: subtreeUsage.model,
		provider: subtreeUsage.provider,
		eventCount: subtreeUsage.eventCount,
		childTaskIds: [...(catalog.childrenByParentId.get(taskId) ?? [])],
	}
}

function summarizeSubtreeUsage(
	taskIds: readonly string[],
	usageByTaskId: ReadonlyMap<string, TaskUsageRow>,
): SubtreeUsageSummary {
	let totalCost = 0
	let totalTokens = 0
	let eventCount = 0
	let latestUsage: TaskUsageRow | undefined

	for (const taskId of taskIds) {
		const usage = usageByTaskId.get(taskId)
		if (!usage) {
			continue
		}

		totalCost += usage.totalCost
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
		totalCost,
		totalTokens,
		eventCount,
		lastUsageAt: latestUsage?.lastActivity,
		model: latestUsage?.model ?? "",
		provider: latestUsage?.provider ?? "",
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

function eventToApiCall(event: UsageEventV1, index: number): DashboardTaskApiCall {
	return {
		index,
		mode: event.mode,
		timestamp: new Date(event.occurredAt).getTime(),
		inputTokens: event.usage.inputTokens?.value ?? 0,
		outputTokens: event.usage.outputTokens?.value ?? 0,
		cacheReadTokens: event.usage.cacheReadTokens?.value ?? 0,
		cacheWriteTokens: event.usage.cacheWriteTokens?.value ?? 0,
		reasoningTokens: event.usage.reasoningTokens?.value ?? 0,
		costUsd: getEffectiveCost(event),
		status: event.status,
		model: event.model,
	}
}

function uniqueInFirstSeenOrder(values: readonly string[]): string[] {
	return [...new Set(values)]
}
