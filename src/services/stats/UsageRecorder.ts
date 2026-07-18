// src/services/stats/UsageRecorder.ts
//
// Commit 3: API attempt 최종 usage 계측.
// chunk별 기록이 없고 terminal finalize에서만 기록한다.
// store 오류가 기존 task 결과에 영향을 주지 않도록 try-catch로 격리한다.

import * as crypto from "crypto"

import type { UsageEventV1, UsageValueSource, InclusionRule } from "@roo-code/types"

import { UsageEventStore } from "./UsageEventStore"

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * UsageRecorder가 terminal finalize에서 이벤트를 생성할 때 필요한 컨텍스트.
 * Task lifecycle에서 API 호출이 완료/실패/취소된 시점에 전달된다.
 */
export interface UsageRecordingContext {
	taskId: string
	parentTaskId?: string
	provider: string
	model: string
	mode: string
	attempt: number
	// accumulated usage from stream
	inputTokens: number
	outputTokens: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	reasoningTokens?: number
	totalCost?: number
	// semantics
	cacheReadInInput: InclusionRule
	cacheWriteInInput: InclusionRule
	reasoningInOutput: InclusionRule
	// source
	costSource: UsageValueSource
	tokenSource: UsageValueSource
}

// ── UsageRecorder ────────────────────────────────────────────────────────────

/**
 * API attempt의 terminal finalize 경계에서 사용량 이벤트를 기록한다.
 *
 * 설계 원칙 (아키텍처 보고서 섹션 5.5-5.8):
 * - chunk별로 이벤트를 기록하지 않는다. terminal finalize에서만 기록한다.
 * - 동일 requestKey + status 조합에 대해 최대 한 번 기록한다 (idempotency).
 * - store 오류는 기존 task 결과에 영향을 주지 않는다 (best-effort).
 *
 * Hexagonal boundary: Task lifecycle은 UsageRecorder interface만 알고
 * 파일 구현(UsageEventStore)의 세부 사항을 모른다.
 */
export class UsageRecorder {
	private readonly store: UsageEventStore
	private readonly finalizedKeys: Set<string> = new Set()

	constructor(store: UsageEventStore) {
		this.store = store
	}

	/**
	 * API attempt의 terminal finalize에서 호출한다.
	 *
	 * @param requestKey 요청 식별자 (taskId:attempt 형태)
	 * @param status "completed" | "failed" | "cancelled"
	 * @param ctx 사용량 기록 컨텍스트
	 *
	 * 동일 requestKey:status 조합에 대해 한 번만 기록한다.
	 * store 오류 발생 시 조용히 무시한다 (task에 영향 없음).
	 */
	async finalizeUsageEvent(
		requestKey: string,
		status: "completed" | "failed" | "cancelled",
		ctx: UsageRecordingContext,
	): Promise<void> {
		// terminal finalize: idempotency check
		const idempotencyKey = `${requestKey}:${status}`
		if (this.finalizedKeys.has(idempotencyKey)) {
			return
		}
		this.finalizedKeys.add(idempotencyKey)

		const event: UsageEventV1 = {
			schemaVersion: 1,
			eventId: crypto.randomUUID(),
			idempotencyKey,
			occurredAt: new Date().toISOString(),
			timezoneOffsetMinutes: new Date().getTimezoneOffset(),
			status,
			attempt: ctx.attempt,
			taskId: ctx.taskId,
			parentTaskId: ctx.parentTaskId,
			provider: ctx.provider,
			model: ctx.model,
			mode: ctx.mode,
			usage: {
				inputTokens:
					ctx.inputTokens > 0 ? { value: ctx.inputTokens, source: ctx.tokenSource } : undefined,
				outputTokens:
					ctx.outputTokens > 0 ? { value: ctx.outputTokens, source: ctx.tokenSource } : undefined,
				cacheWriteTokens: ctx.cacheWriteTokens
					? { value: ctx.cacheWriteTokens, source: ctx.tokenSource }
					: undefined,
				cacheReadTokens: ctx.cacheReadTokens
					? { value: ctx.cacheReadTokens, source: ctx.tokenSource }
					: undefined,
				reasoningTokens: ctx.reasoningTokens
					? { value: ctx.reasoningTokens, source: ctx.tokenSource }
					: undefined,
				totalTokens: undefined, // calculated by aggregator
				costUsd: ctx.totalCost ? { value: ctx.totalCost, source: ctx.costSource } : undefined,
			},
			semantics: {
				cacheReadInInput: ctx.cacheReadInInput,
				cacheWriteInInput: ctx.cacheWriteInInput,
				reasoningInOutput: ctx.reasoningInOutput,
			},
			provenance: "live",
		}

		try {
			await this.store.append(event)
		} catch {
			// store error must not break task
			// STATS_STORE/append/* 오류는 UsageEventStore 내부에서 분류됨
		}
	}

	/**
	 * 테스트/검증용: finalizedKeys set의 현재 상태를 반환한다.
	 * 프로덕션 코드에서는 사용하지 않는다.
	 */
	_hasFinalized(requestKey: string, status: string): boolean {
		return this.finalizedKeys.has(`${requestKey}:${status}`)
	}
}
