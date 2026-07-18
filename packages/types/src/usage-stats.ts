import { z } from "zod"

// ── Enums ──────────────────────────────────────────────────────────────────

/** LLM API 호출의 최종 상태 */
export const UsageEventStatus = z.enum(["completed", "failed", "cancelled"])
export type UsageEventStatus = z.infer<typeof UsageEventStatus>

/** 토큰 사용량 값의 출처 */
export const UsageValueSource = z.enum(["provider", "estimated", "backfilled"])
export type UsageValueSource = z.infer<typeof UsageValueSource>

/** 토큰 중복 계산 여부 (예: cacheRead이 inputTokens에 포함되어 있는지) */
export const InclusionRule = z.enum(["included", "excluded", "unknown"])
export type InclusionRule = z.infer<typeof InclusionRule>

// ── SourcedNumber ──────────────────────────────────────────────────────────

/** 값과 그 출처를 함께 표현 */
export const SourcedNumber = z.object({
	value: z.number(),
	source: UsageValueSource,
})
export type SourcedNumber = z.infer<typeof SourcedNumber>

// ── UsageEventV1 ────────────────────────────────────────────────────────────

/**
 * 단일 LLM API 호출의 사용량 이벤트.
 * schemaVersion 1 — 향후 스키마 변경 시 버전을 올립니다.
 *
 * 보안: prompt 본문, response 본문, API key, workspace path는
 * 이 스키마에 절대 포함하지 않습니다.
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

/** 통계 조회 쿼리 */
export const StatsQuery = z.object({
	from: z.string().optional(), // ISO 8601
	to: z.string().optional(),
	preset: z.enum(["today", "7d", "30d", "all"]).optional(),
	timezone: z.string(), // IANA
	groupBy: z.array(z.enum(["day", "week", "month", "provider", "model", "mode", "status", "source"])).max(3),
	includeCancelled: z.boolean().default(false),
})
export type StatsQuery = z.infer<typeof StatsQuery>

// ── StatsBucket ──────────────────────────────────────────────────────────────

/** 그룹화된 통계 버킷 */
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

/** 통계 조회 결과 스냅샷 */
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
