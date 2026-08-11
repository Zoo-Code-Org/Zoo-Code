import { z } from "zod"

// ── Enums ──────────────────────────────────────────────────────────────────

/** Final status of an LLM API call */
export const UsageEventStatus = z.enum(["completed", "failed", "cancelled"])
export type UsageEventStatus = z.infer<typeof UsageEventStatus>

/** Source of a token usage value */
export const UsageValueSource = z.enum(["provider", "estimated", "backfilled"])
export type UsageValueSource = z.infer<typeof UsageValueSource>

/** Whether a token field is double-counted (e.g. cacheRead included in inputTokens) */
export const InclusionRule = z.enum(["included", "excluded", "unknown"])
export type InclusionRule = z.infer<typeof InclusionRule>

// ── SourcedNumber ──────────────────────────────────────────────────────────

/** A numeric value paired with its source */
export const SourcedNumber = z.object({
	value: z.number(),
	source: UsageValueSource,
})
export type SourcedNumber = z.infer<typeof SourcedNumber>

// ── UsageEventV1 ────────────────────────────────────────────────────────────

/**
 * A usage event for a single LLM API call.
 * schemaVersion 1 — bump when the schema changes.
 *
 * Security: prompt bodies, response bodies, API keys, and workspace paths
 * must never be included in this schema.
 */
export const UsageEventV1 = z.object({
	schemaVersion: z.literal(1),
	eventId: z.string(),
	idempotencyKey: z.string(),
	occurredAt: z.string(), // ISO 8601 UTC
	timezoneOffsetMinutes: z.number(),
	status: UsageEventStatus,
	attempt: z.number(),
	taskId: z.string(),
	parentTaskId: z.string().optional(),
	/**
	 * Stable root-session identity for dashboard streaming.
	 * Resolved from the task hierarchy by the recorder; migration resolves
	 * legacy parent chains with the existing cycle guard. Absent on events
	 * recorded before this field was introduced (backward compatible).
	 */
	rootTaskId: z.string().optional(),
	provider: z.string(),
	model: z.string(),
	mode: z.string(),
	/**
	 * Domain extracted from the provider's custom base URL (e.g. "kimi.ai",
	 * "localhost:1234"). Only set when the user configured a custom base URL
	 * that differs from the provider's default. Absent for default endpoints
	 * and for providers without a base URL field. Backward compatible:
	 * events recorded before this field was introduced remain valid.
	 */
	endpoint: z.string().optional(),
	usage: z.object({
		inputTokens: SourcedNumber.optional(),
		outputTokens: SourcedNumber.optional(),
		cacheWriteTokens: SourcedNumber.optional(),
		cacheReadTokens: SourcedNumber.optional(),
		reasoningTokens: SourcedNumber.optional(),
		totalTokens: SourcedNumber.optional(),
		costUsd: SourcedNumber.optional(),
	}),
	semantics: z.object({
		cacheReadInInput: InclusionRule,
		cacheWriteInInput: InclusionRule,
		reasoningInOutput: InclusionRule,
	}),
	provenance: z.enum(["live", "history-backfill"]),
})
export type UsageEventV1 = z.infer<typeof UsageEventV1>

// ── StatsQuery ──────────────────────────────────────────────────────────────

/** Statistics query */
export const StatsQuery = z.object({
	from: z.string().optional(), // ISO 8601
	to: z.string().optional(),
	preset: z.enum(["today", "7d", "30d", "all"]).optional(),
	timezone: z.string(), // IANA
	groupBy: z.array(z.enum(["day", "week", "month", "provider", "model", "mode", "status", "source"])).max(3),
	includeCancelled: z.boolean().default(false),
	/**
	 * Cache ratio for estimation when provider doesn't report cacheReadTokens.
	 * Default: 0.94 (94% of input tokens are estimated as cached)
	 * Range: 0.0 to 1.0
	 */
	cacheRatio: z.number().min(0).max(1).optional(),
})
export type StatsQuery = z.infer<typeof StatsQuery>

// ── StatsBucket ──────────────────────────────────────────────────────────────

/** Grouped statistics bucket */
export const StatsBucket = z.object({
	key: z.record(z.string()),
	events: z.number(),
	completedCalls: z.number(),
	failedCalls: z.number(),
	cancelledCalls: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	reasoningTokens: z.number(),
	totalTokens: z.number(),
	costUsd: z.number(),
	unknownEventCount: z.number(),
})
export type StatsBucket = z.infer<typeof StatsBucket>

// ── StatsSnapshot ────────────────────────────────────────────────────────────

/** Statistics query result snapshot */
export const StatsSnapshot = z.object({
	query: StatsQuery,
	generatedAt: z.string(),
	buckets: z.array(StatsBucket),
	totals: StatsBucket,
	coverage: z.object({
		firstEventAt: z.string().optional(),
		lastEventAt: z.string().optional(),
		recordingPaused: z.boolean(),
		backfilledEventCount: z.number(),
	}),
})
export type StatsSnapshot = z.infer<typeof StatsSnapshot>

// ── SessionSummary / SessionDetail / APICallRecord ──────────────────────────

/**
 * A summary of a single task session, aggregated from all usage events that
 * share the same `taskId`. Used by the Dashboard "Sessions" list.
 *
 * Security: does not include prompt bodies, response bodies, API keys, or
 * workspace paths. The `title` is derived from the first user message text
 * (truncated); if unavailable, falls back to the taskId.
 */
export interface SessionSummary {
	taskId: string
	title: string // First line of user input (truncated); falls back to taskId
	timestamp: number // Last activity (epoch ms)
	model: string // First-seen model (kept for backward compatibility)
	provider: string
	mode: string // First-seen mode (kept for backward compatibility)
	/**
	 * All unique models used in the session, in first-seen order.
	 * A session may switch models (e.g. orchestrator delegating to a
	 * different provider), so this array captures the full set while
	 * `model` retains the earliest value for backward compatibility.
	 */
	models: string[]
	/**
	 * All unique modes used in the session, in first-seen order.
	 * A session may span multiple modes (e.g. orchestrator-crow
	 * delegating to code, debug, ask), so this array captures the full
	 * set while `mode` retains the earliest value for backward compat.
	 */
	modes: string[]
	totalTokens: number
	totalCost: number
	callCount: number
}

/**
 * Detailed view of a single session, including the per-API-call records.
 * Used by the Dashboard session detail expansion (Commit 4).
 */
export interface SessionDetail extends SessionSummary {
	apiCalls: APICallRecord[]
}

/**
 * A single API call record within a session, used in `SessionDetail.apiCalls`.
 */
export interface APICallRecord {
	index: number
	mode: string
	timestamp: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens: number
	costUsd: number
	status: "completed" | "failed" | "cancelled"
	model: string
}

// ── Dashboard Streaming Protocol ────────────────────────────────────────────
//
// The types below define the versioned dashboard subscription protocol.
// Runtime validation (Zod) is required for every webview-originated query.
// See docs/260729_0001_session_branch-recovery/dashboard-streaming-architecture.md
// for the full specification.

/**
 * Cursor-paged session page request.
 * The cursor is host-issued, query-bound, and invalid after a generation or
 * query change.
 */
export const DashboardSessionPageRequest = z.object({
	/** Page size, 1–100. Default 50. */
	limit: z.number().int().min(1).max(100).default(50),
	/** Opaque cursor returned by the host. Absent for the first page. */
	cursor: z.string().optional(),
})
export type DashboardSessionPageRequest = z.infer<typeof DashboardSessionPageRequest>

/**
 * Subscribe request for the dashboard stats stream.
 * Contains the main stats query, heatmap range, and session page request.
 */
export const DashboardStatsSubscription = z.object({
	/** Correlation ID for the subscription request. */
	requestId: z.string(),
	/** Main dashboard time range query. */
	range: StatsQuery,
	/** Maximum sessions per page (1–100). */
	sessionPageSize: z.number().int().min(1).max(100).default(50),
	/** Number of days for the heatmap (30, 60, 120, 360). */
	heatmapRangeDays: z.number().int().min(1).max(365),
})
export type DashboardStatsSubscription = z.infer<typeof DashboardStatsSubscription>

/**
 * A single session row in the dashboard sessions list.
 * Derived from aggregated usage events sharing the same root task.
 *
 * Security: does not include prompt bodies, response bodies, API keys, or
 * workspace paths. The `title` is derived from the first user message text
 * (truncated); if unavailable, falls back to the rootTaskId.
 */
export const DashboardSessionSummary = z.object({
	rootTaskId: z.string(),
	title: z.string(),
	totalCost: z.number(),
	totalTokens: z.number(),
	model: z.string(),
	provider: z.string(),
	/** Last activity timestamp (epoch ms). */
	lastActivity: z.number(),
	/** Number of API calls in this session. */
	eventCount: z.number(),
})
export type DashboardSessionSummary = z.infer<typeof DashboardSessionSummary>

/**
 * Cursor-paged session list response.
 */
export const DashboardSessionPage = z.object({
	/** Correlation ID matching the subscription request. */
	requestId: z.string(),
	/** Session summaries for this page (at most `sessionPageSize` items). */
	sessions: z.array(DashboardSessionSummary),
	/** Opaque cursor for the next page. Absent if this is the last page. */
	cursor: z.string().optional(),
	/** Estimated total session count (may be approximate). */
	totalEstimate: z.number().int(),
})
export type DashboardSessionPage = z.infer<typeof DashboardSessionPage>

// ── Dashboard Task Protocol ────────────────────────────────────────────────
//
// Task rows are History-first: identity, title, timestamp, and hierarchy come
// from History, while the numeric metrics are composed from direct task usage.
// Each row intentionally represents the task's whole subtree, so parent and
// child rows must not be summed together for dashboard-wide totals.

/**
 * One History task and its aggregate usage for the task plus all descendants.
 * A missing usage row is represented by zero metrics, empty `models`/`modes`
 * lists, and no `lastUsageAt`.
 */
export const DashboardTaskSummary = z.object({
	taskId: z.string(),
	rootTaskId: z.string(),
	parentTaskId: z.string().optional(),
	title: z.string(),
	/** History task timestamp (epoch ms), not a usage timestamp. */
	taskTimestamp: z.number(),
	/** Latest usage timestamp in this task's subtree (epoch ms). */
	lastUsageAt: z.number().optional(),
	totalCost: z.number(),
	totalTokens: z.number(),
	/** Subtree-aggregated input tokens. */
	inputTokens: z.number(),
	/** Subtree-aggregated output tokens. */
	outputTokens: z.number(),
	/** Provider/model from the latest usage row in the subtree, or empty when unused. */
	model: z.string(),
	provider: z.string(),
	/** Distinct models used in the subtree, in first-seen order. */
	models: z.array(z.string()),
	/** Distinct modes used in the subtree, in first-seen order. */
	modes: z.array(z.string()),
	eventCount: z.number().int().nonnegative(),
	/** Direct children in catalog order; empty for childless tasks. */
	childTaskIds: z.array(z.string()),
})
export type DashboardTaskSummary = z.infer<typeof DashboardTaskSummary>

/** Cursor-paged History task list for one immutable catalog revision. */
export const DashboardTaskPage = z.object({
	/** Correlation ID matching the page or subscription request. */
	requestId: z.string(),
	/** Immutable History catalog revision used to produce this page. */
	catalogRevision: z.number().int().nonnegative(),
	/** Root tasks only, in catalog order. Subtasks appear in `childTasks`. */
	tasks: z.array(DashboardTaskSummary),
	/** Direct children of this page's root tasks, keyed via their `parentTaskId`. */
	childTasks: z.array(DashboardTaskSummary).optional(),
	/** Opaque host-issued cursor for the next page. */
	cursor: z.string().optional(),
	/** Exact catalog size for the current revision. */
	totalEstimate: z.number().int().nonnegative(),
})
export type DashboardTaskPage = z.infer<typeof DashboardTaskPage>

/**
 * Current task summary emitted after usage changes. It has the same complete
 * identity and metrics as a page row so reducers never need a second join.
 */
export const DashboardTaskUpsert = DashboardTaskSummary
export type DashboardTaskUpsert = z.infer<typeof DashboardTaskUpsert>

/** One API call shown in a task detail's chronologically ordered call list. */
export const DashboardTaskApiCall = z.object({
	index: z.number().int().positive(),
	mode: z.string(),
	timestamp: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	reasoningTokens: z.number(),
	costUsd: z.number(),
	status: UsageEventStatus,
	model: z.string(),
})
export type DashboardTaskApiCall = z.infer<typeof DashboardTaskApiCall>

/**
 * Usage detail for a selected task and all descendants. Known tasks without
 * usage succeed with zero totals, empty models/modes, and an empty call list.
 */
export const DashboardTaskDetail = z.object({
	taskId: z.string(),
	title: z.string(),
	taskTimestamp: z.number(),
	models: z.array(z.string()),
	modes: z.array(z.string()),
	totalTokens: z.number(),
	totalCost: z.number(),
	callCount: z.number().int().nonnegative(),
	apiCalls: z.array(DashboardTaskApiCall),
})
export type DashboardTaskDetail = z.infer<typeof DashboardTaskDetail>

/**
 * Daily heatmap values snapshot.
 */
export const HeatmapSnapshot = z.object({
	/** Number of days the values array covers. */
	rangeDays: z.number().int().min(1),
	/** Daily cost values, one per day, oldest first. */
	values: z.array(z.number()),
})
export type HeatmapSnapshot = z.infer<typeof HeatmapSnapshot>

/**
 * Full state snapshot sent on initial subscription or recovery.
 * Authoritative for its query and epoch. Applied atomically by the reducer.
 */
export const DashboardStatsSnapshot = z.object({
	/** Correlation ID matching the subscription request. */
	requestId: z.string(),
	/** Store generation at the time of snapshot. */
	generation: z.number().int(),
	/** Monotonic sequence of the last committed event included. */
	sequence: z.number().int(),
	/** Full stats snapshot for the main dashboard. */
	stats: StatsSnapshot,
	/** First page of sessions. */
	sessions: DashboardSessionPage,
	/** Opaque cursor for fetching the next session page. */
	cursor: z.string().optional(),
	/** Heatmap daily values. */
	heatmap: HeatmapSnapshot,
})
export type DashboardStatsSnapshot = z.infer<typeof DashboardStatsSnapshot>

/**
 * Task-based full state snapshot. This is intentionally separate from
 * DashboardStatsSnapshot so legacy session stream consumers remain valid while
 * the extension host and webview migrate together.
 */
export const DashboardTaskStatsSnapshot = z.object({
	requestId: z.string(),
	generation: z.number().int(),
	sequence: z.number().int(),
	stats: StatsSnapshot,
	/** First History-first task page for this catalog revision. */
	tasks: DashboardTaskPage,
	/** Opaque cursor for fetching the next task page. */
	cursor: z.string().optional(),
	heatmap: HeatmapSnapshot,
})
export type DashboardTaskStatsSnapshot = z.infer<typeof DashboardTaskStatsSnapshot>

/**
 * Signed delta for a single stats bucket.
 * Key fields are identities; numeric fields are signed deltas.
 * Signed values support correction/reset migrations.
 */
export const StatsBucketDelta = z.object({
	/** Stable serialized bucket key (e.g. JSON of group dimensions). */
	key: z.record(z.string()),
	/** Signed delta for events count. */
	events: z.number(),
	/** Signed delta for completed calls. */
	completedCalls: z.number(),
	/** Signed delta for failed calls. */
	failedCalls: z.number(),
	/** Signed delta for cancelled calls. */
	cancelledCalls: z.number(),
	/** Signed delta for input tokens. */
	inputTokens: z.number(),
	/** Signed delta for output tokens. */
	outputTokens: z.number(),
	/** Signed delta for cache read tokens. */
	cacheReadTokens: z.number(),
	/** Signed delta for cache write tokens. */
	cacheWriteTokens: z.number(),
	/** Signed delta for reasoning tokens. */
	reasoningTokens: z.number(),
	/** Signed delta for total tokens. */
	totalTokens: z.number(),
	/** Signed delta for cost in USD. */
	costUsd: z.number(),
	/** Signed delta for unknown event count. */
	unknownEventCount: z.number(),
})
export type StatsBucketDelta = z.infer<typeof StatsBucketDelta>

/**
 * Session upsert: a complete current summary for a root session.
 * Existing rows update in place. A newly created session may be inserted at
 * the top; ordinary numeric updates do not reorder the visible page.
 */
export const DashboardSessionUpsert = z.object({
	rootTaskId: z.string(),
	title: z.string(),
	totalCost: z.number(),
	totalTokens: z.number(),
	model: z.string(),
	provider: z.string(),
	lastActivity: z.number(),
	eventCount: z.number(),
})
export type DashboardSessionUpsert = z.infer<typeof DashboardSessionUpsert>

/**
 * Incremental delta message sent after the initial snapshot.
 * The reducer accepts it only when generation matches and afterSequence
 * equals the local through-sequence.
 */
export const DashboardStatsDelta = z.object({
	/** Correlation ID matching the subscription request. */
	requestId: z.string(),
	/** Store generation at the time of delta. */
	generation: z.number().int(),
	/** Monotonic sequence of the last committed event included. */
	sequence: z.number().int(),
	/** Signed delta for totals. */
	totalDelta: StatsBucketDelta,
	/** Signed deltas for breakdown buckets. */
	breakdownDelta: z.array(StatsBucketDelta),
	/** Signed delta for a single heatmap day. */
	heatmapDayDelta: z
		.object({
			/** Day index within the heatmap range (0-based). */
			dayIndex: z.number().int().min(0),
			/** Signed delta for that day's cost. */
			delta: z.number(),
		})
		.optional(),
	/** Session upserts for changed sessions. */
	sessionUpsert: z.array(DashboardSessionUpsert),
})
export type DashboardStatsDelta = z.infer<typeof DashboardStatsDelta>

/** Task-based stream delta with complete subtree summaries for changed rows. */
export const DashboardTaskStatsDelta = z.object({
	requestId: z.string(),
	generation: z.number().int(),
	sequence: z.number().int(),
	totalDelta: StatsBucketDelta,
	breakdownDelta: z.array(StatsBucketDelta),
	heatmapDayDelta: z
		.object({
			dayIndex: z.number().int().min(0),
			delta: z.number(),
		})
		.optional(),
	taskUpsert: z.array(DashboardTaskUpsert),
})
export type DashboardTaskStatsDelta = z.infer<typeof DashboardTaskStatsDelta>

/**
 * Typed error message for the dashboard stats stream.
 * Existing data stays visible for recoverable errors.
 * No stack trace crosses the boundary.
 */
export const DashboardStatsError = z.object({
	/** Correlation ID matching the subscription request. */
	requestId: z.string(),
	/** Stable error code (e.g. "STATS_STREAM/subscribe/001"). */
	code: z.string(),
	/** Safe, user-facing error message (no stack traces). */
	message: z.string(),
})
export type DashboardStatsError = z.infer<typeof DashboardStatsError>
