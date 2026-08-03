// Pure reducer for the dashboard stats stream.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// for the full specification.

import type {
	DashboardStatsSubscription,
	DashboardStatsError,
	DashboardTaskPage,
	DashboardTaskStatsDelta,
	DashboardTaskStatsSnapshot,
	DashboardTaskSummary,
	DashboardTaskUpsert,
	StatsBucket,
	StatsBucketDelta,
	StatsQuery,
} from "@roo-code/types"

// ── State ───────────────────────────────────────────────────────────────────

/**
 * Normalized dashboard stream state.
 *
 * - `buckets` is keyed by `JSON.stringify(bucket.key)` for stable identity.
 * - `bucketOrder` preserves the snapshot's original bucket ordering.
 * - `sessions` is keyed by `rootTaskId`; `sessionOrder` preserves stable row order.
 * - `isLoading` is true ONLY before the first snapshot arrives. After that,
 *   background updates never set page-level loading (architecture goal 1.1#1).
 * - `pendingResync` is set when a generation mismatch or gap is detected.
 *   While true, deltas are ignored until a fresh snapshot arrives.
 * - `subscriptionId` (the subscription `requestId`) doubles as the epoch.
 *   Replacing the subscription generates a new `requestId`, and stale-epoch
 *   responses are silently rejected.
 */
export interface DashboardStreamState {
	status: "idle" | "loading" | "connected" | "error"

	// Subscription identity / epoch
	subscriptionId: string | null
	generation: number | null
	sequence: number

	// Loading flag — true only before first snapshot
	isLoading: boolean

	// Resync flag — when true, deltas are ignored until a snapshot arrives
	pendingResync: boolean

	// Background error (non-fatal; existing data stays visible)
	backgroundError: { code: string; message: string } | null

	// Main stats (normalized from StatsSnapshot)
	query: StatsQuery | null
	generatedAt: string | null
	totals: StatsBucket | null
	buckets: Record<string, StatsBucket>
	bucketOrder: string[]
	coverage: {
		firstEventAt?: string
		lastEventAt?: string
		recordingPaused: boolean
		backfilledEventCount: number
	} | null

	// Heatmap
	heatmapRangeDays: number | null
	heatmapValues: number[]

	// Tasks (normalized)
	tasks: Record<string, DashboardTaskSummary>
	taskOrder: string[]
	taskCursor: string | undefined
	taskTotalEstimate: number
}

export const initialDashboardStreamState: DashboardStreamState = {
	status: "idle",
	subscriptionId: null,
	generation: null,
	sequence: 0,
	isLoading: false,
	pendingResync: false,
	backgroundError: null,
	query: null,
	generatedAt: null,
	totals: null,
	buckets: {},
	bucketOrder: [],
	coverage: null,
	heatmapRangeDays: null,
	heatmapValues: [],
	tasks: {},
	taskOrder: [],
	taskCursor: undefined,
	taskTotalEstimate: 0,
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type DashboardStreamAction =
	| { type: "SUBSCRIBE"; subscription: DashboardStatsSubscription }
	| { type: "REPLACE_SUBSCRIPTION"; subscription: DashboardStatsSubscription }
	| { type: "SNAPSHOT"; snapshot: DashboardTaskStatsSnapshot }
	| { type: "DELTA"; delta: DashboardTaskStatsDelta }
	| { type: "TASK_PAGE"; page: DashboardTaskPage }
	| { type: "ERROR"; error: DashboardStatsError }
	| { type: "REQUEST_RESYNC" }
	| { type: "RESET" }

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Stable serialization of a bucket's group key.
 * `JSON.stringify` with sorted keys would be ideal, but the key is already
 * a `Record<string, string>` from the host, so direct stringify is sufficient
 * as long as the host uses a consistent key order (which it does, since Zod
 * parses the object in a deterministic order).
 */
function serializeBucketKey(key: Record<string, string>): string {
	return JSON.stringify(key)
}

/**
 * Apply a signed delta to an existing bucket, returning a new bucket.
 * Signed values support correction/reset migrations.
 */
function applyBucketDelta(bucket: StatsBucket, delta: StatsBucketDelta): StatsBucket {
	return {
		key: bucket.key,
		events: bucket.events + delta.events,
		completedCalls: bucket.completedCalls + delta.completedCalls,
		failedCalls: bucket.failedCalls + delta.failedCalls,
		cancelledCalls: bucket.cancelledCalls + delta.cancelledCalls,
		inputTokens: bucket.inputTokens + delta.inputTokens,
		outputTokens: bucket.outputTokens + delta.outputTokens,
		cacheReadTokens: bucket.cacheReadTokens + delta.cacheReadTokens,
		cacheWriteTokens: bucket.cacheWriteTokens + delta.cacheWriteTokens,
		reasoningTokens: bucket.reasoningTokens + delta.reasoningTokens,
		totalTokens: bucket.totalTokens + delta.totalTokens,
		costUsd: bucket.costUsd + delta.costUsd,
		unknownEventCount: bucket.unknownEventCount + delta.unknownEventCount,
	}
}

/**
 * Convert a `DashboardTaskUpsert` (which has the same shape) into a
 * `DashboardTaskSummary` for storage in the normalized tasks map.
 */
function upsertToSummary(upsert: DashboardTaskUpsert): DashboardTaskSummary {
	return {
		taskId: upsert.taskId,
		rootTaskId: upsert.rootTaskId,
		parentTaskId: upsert.parentTaskId,
		title: upsert.title,
		taskTimestamp: upsert.taskTimestamp,
		totalCost: upsert.totalCost,
		totalTokens: upsert.totalTokens,
		model: upsert.model,
		provider: upsert.provider,
		lastUsageAt: upsert.lastUsageAt,
		eventCount: upsert.eventCount,
	}
}

/**
 * Upsert a task into the normalized task map and order array.
 *
 * - If the task already exists, update its values in place WITHOUT
 *   reordering (architecture rule: "ordinary numeric updates do not reorder
 *   the visible page").
 * - A new task is inserted at the top until its next authoritative snapshot
 *   establishes catalog order.
 */
function upsertTask(
	tasks: Record<string, DashboardTaskSummary>,
	order: string[],
	upsert: DashboardTaskUpsert,
): { tasks: Record<string, DashboardTaskSummary>; order: string[] } {
	const summary = upsertToSummary(upsert)

	if (upsert.taskId in tasks) {
		// Update in place — do not reorder
		return {
			tasks: { ...tasks, [upsert.taskId]: summary },
			order,
		}
	}

	// New task — insert at top until the next catalog snapshot establishes order.
	return {
		tasks: { ...tasks, [upsert.taskId]: summary },
		order: [upsert.taskId, ...order],
	}
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export function dashboardStreamReducer(
	state: DashboardStreamState,
	action: DashboardStreamAction,
): DashboardStreamState {
	switch (action.type) {
		// ── SUBSCRIBE ───────────────────────────────────────────────────────
		// Start a new subscription. Sets loading state and stores the
		// subscription identity (requestId = epoch).
		case "SUBSCRIBE": {
			return {
				...initialDashboardStreamState,
				status: "loading",
				isLoading: true,
				subscriptionId: action.subscription.requestId,
			}
		}

		// ── REPLACE_SUBSCRIPTION ────────────────────────────────────────────
		// Replace the current subscription with a new epoch. Old data stays
		// visible until the new snapshot arrives (stale-while-revalidate).
		// isLoading is NEVER set if prior data exists (architecture goal 1.1#1).
		case "REPLACE_SUBSCRIPTION": {
			const hasPriorData = state.totals !== null
			return {
				...initialDashboardStreamState,
				status: hasPriorData ? state.status : "loading",
				isLoading: hasPriorData ? false : true,
				subscriptionId: action.subscription.requestId,
				// Preserve old data for stale-while-revalidate
				query: state.query,
				generatedAt: state.generatedAt,
				totals: state.totals,
				buckets: state.buckets,
				bucketOrder: state.bucketOrder,
				coverage: state.coverage,
				heatmapRangeDays: state.heatmapRangeDays,
				heatmapValues: state.heatmapValues,
				tasks: state.tasks,
				taskOrder: state.taskOrder,
				taskCursor: state.taskCursor,
				taskTotalEstimate: state.taskTotalEstimate,
			}
		}

		// ── SNAPSHOT ───────────────────────────────────────────────────────
		// Atomically replace all state with the authoritative snapshot.
		// Rejected if the snapshot's requestId doesn't match the current
		// subscription (stale-epoch rejection).
		case "SNAPSHOT": {
			// Stale-epoch rejection
			if (action.snapshot.requestId !== state.subscriptionId) {
				return state
			}

			const snap = action.snapshot

			// Normalize buckets into a keyed map with stable order
			const newBuckets: Record<string, StatsBucket> = {}
			const newBucketOrder: string[] = []
			for (const bucket of snap.stats.buckets) {
				const key = serializeBucketKey(bucket.key)
				newBuckets[key] = bucket
				newBucketOrder.push(key)
			}

			// Normalize tasks into a keyed map with catalog order.
			const newTasks: Record<string, DashboardTaskSummary> = {}
			const newTaskOrder: string[] = []
			for (const task of snap.tasks.tasks) {
				newTasks[task.taskId] = task
				newTaskOrder.push(task.taskId)
			}

			return {
				...state,
				status: "connected",
				subscriptionId: snap.requestId,
				generation: snap.generation,
				sequence: snap.sequence,
				isLoading: false,
				pendingResync: false,
				backgroundError: null,
				query: snap.stats.query,
				generatedAt: snap.stats.generatedAt,
				totals: snap.stats.totals,
				buckets: newBuckets,
				bucketOrder: newBucketOrder,
				coverage: snap.stats.coverage,
				heatmapRangeDays: snap.heatmap.rangeDays,
				heatmapValues: [...snap.heatmap.values],
				tasks: newTasks,
				taskOrder: newTaskOrder,
				taskCursor: snap.tasks.cursor,
				taskTotalEstimate: snap.tasks.totalEstimate,
			}
		}

		// ── DELTA ──────────────────────────────────────────────────────────
		// Apply an incremental delta. Rejected if:
		//   - pendingResync is true (waiting for snapshot)
		//   - requestId doesn't match (stale epoch)
		//   - generation doesn't match (generation mismatch → set pendingResync)
		//   - sequence <= local (duplicate → ignore)
		case "DELTA": {
			// Ignore deltas while waiting for resync snapshot
			if (state.pendingResync) {
				return state
			}

			// Stale-epoch rejection
			if (action.delta.requestId !== state.subscriptionId) {
				return state
			}

			// Generation mismatch → trigger background resync
			if (action.delta.generation !== state.generation) {
				return { ...state, pendingResync: true }
			}

			// Duplicate sequence → ignore
			if (action.delta.sequence <= state.sequence) {
				return state
			}

			const delta = action.delta

			// Apply total delta
			const newTotals = state.totals ? applyBucketDelta(state.totals, delta.totalDelta) : state.totals

			// Apply breakdown deltas
			const newBuckets = { ...state.buckets }
			for (const bucketDelta of delta.breakdownDelta) {
				const key = serializeBucketKey(bucketDelta.key)
				const existing = newBuckets[key]
				if (existing) {
					newBuckets[key] = applyBucketDelta(existing, bucketDelta)
				} else {
					// New bucket from delta — use delta values directly
					// (signed values are valid for a new bucket)
					newBuckets[key] = {
						key: bucketDelta.key,
						events: bucketDelta.events,
						completedCalls: bucketDelta.completedCalls,
						failedCalls: bucketDelta.failedCalls,
						cancelledCalls: bucketDelta.cancelledCalls,
						inputTokens: bucketDelta.inputTokens,
						outputTokens: bucketDelta.outputTokens,
						cacheReadTokens: bucketDelta.cacheReadTokens,
						cacheWriteTokens: bucketDelta.cacheWriteTokens,
						reasoningTokens: bucketDelta.reasoningTokens,
						totalTokens: bucketDelta.totalTokens,
						costUsd: bucketDelta.costUsd,
						unknownEventCount: bucketDelta.unknownEventCount,
					}
				}
			}

			// Apply heatmap day delta
			const newHeatmapValues = [...state.heatmapValues]
			if (delta.heatmapDayDelta) {
				const { dayIndex, delta: heatDelta } = delta.heatmapDayDelta
				if (dayIndex >= 0 && dayIndex < newHeatmapValues.length) {
					newHeatmapValues[dayIndex] += heatDelta
				}
			}

			// Apply task upserts
			let newTasks = state.tasks
			let newTaskOrder = state.taskOrder
			for (const upsert of delta.taskUpsert) {
				const result = upsertTask(newTasks, newTaskOrder, upsert)
				newTasks = result.tasks
				newTaskOrder = result.order
			}

			return {
				...state,
				status: "connected",
				sequence: delta.sequence,
				totals: newTotals,
				buckets: newBuckets,
				heatmapValues: newHeatmapValues,
				tasks: newTasks,
				taskOrder: newTaskOrder,
			}
		}

		// ── TASK_PAGE ──────────────────────────────────────────────────────
		// Append a cursor-paged task page. Existing tasks are updated;
		// new tasks are appended to the end of the catalog order array.
		case "TASK_PAGE": {
			// Stale-epoch rejection
			if (action.page.requestId !== state.subscriptionId) {
				return state
			}

			const newTasks = { ...state.tasks }
			const newTaskOrder = [...state.taskOrder]
			for (const task of action.page.tasks) {
				if (!(task.taskId in newTasks)) {
					newTaskOrder.push(task.taskId)
				}
				newTasks[task.taskId] = task
			}

			return {
				...state,
				tasks: newTasks,
				taskOrder: newTaskOrder,
				taskCursor: action.page.cursor,
				taskTotalEstimate: action.page.totalEstimate,
			}
		}

		// ── ERROR ──────────────────────────────────────────────────────────
		// Preserve existing data; set background error. Never set isLoading.
		case "ERROR": {
			// Stale-epoch rejection
			if (action.error.requestId !== state.subscriptionId) {
				return state
			}

			return {
				...state,
				status: "error",
				isLoading: false,
				backgroundError: { code: action.error.code, message: action.error.message },
			}
		}

		// ── REQUEST_RESYNC ──────────────────────────────────────────────────
		// Set the pendingResync flag. Deltas are ignored until a fresh
		// snapshot arrives and clears the flag.
		case "REQUEST_RESYNC": {
			return { ...state, pendingResync: true }
		}

		// ── RESET ───────────────────────────────────────────────────────────
		// Full reset to initial state (e.g., for clear/migration).
		case "RESET": {
			return { ...initialDashboardStreamState }
		}

		default:
			return state
	}
}
