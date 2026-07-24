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
