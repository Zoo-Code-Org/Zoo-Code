// src/services/stats/UsageRecorder.ts
//
// Commit 3: Final usage measurement for API attempts.
// No per-chunk recording; records only at terminal finalize.
// Store errors are isolated with try-catch so they do not affect existing task results.

import * as crypto from "crypto"

import type { UsageEventV1, UsageValueSource, InclusionRule } from "@roo-code/types"

import { UsageEventStore } from "./UsageEventStore"

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Context required for UsageRecorder to create an event at terminal finalize.
 * Passed at the point in the task lifecycle where the API call completed/failed/was cancelled.
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
	endpoint?: string
}

// ── UsageRecorder ────────────────────────────────────────────────────────────

/**
 * Records usage events at the terminal finalize boundary of an API attempt.
 *
 * Design principles (architecture report section 5.5-5.8):
 * - Does not record events per chunk. Records only at terminal finalize.
 * - Records at most once for the same requestKey + status combination (idempotency).
 * - Store errors do not affect existing task results (best-effort).
 *
 * Hexagonal boundary: The task lifecycle knows only the UsageRecorder interface
 * and is unaware of the file implementation details (UsageEventStore).
 */
export class UsageRecorder {
	private readonly store: UsageEventStore
	private readonly onChanged?: () => void
	private readonly finalizedKeys: Set<string> = new Set()

	constructor(store: UsageEventStore, onChanged?: () => void) {
		this.store = store
		this.onChanged = onChanged
	}

	/**
	 * Called at the terminal finalize of an API attempt.
	 *
	 * @param requestKey Request identifier (taskId:apiReqIndex:attempt format — B1 fix:
	 *   includes apiReqIndex so multiple tool-use turns of one task get different keys)
	 * @param status "completed" | "failed" | "cancelled"
	 * @param ctx Usage recording context
	 *
	 * Records at most once for the same requestKey:status combination.
	 * Silently ignores store errors (no impact on task).
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
				inputTokens: ctx.inputTokens > 0 ? { value: ctx.inputTokens, source: ctx.tokenSource } : undefined,
				outputTokens: ctx.outputTokens > 0 ? { value: ctx.outputTokens, source: ctx.tokenSource } : undefined,
				cacheWriteTokens: ctx.cacheWriteTokens
					? { value: ctx.cacheWriteTokens, source: ctx.tokenSource }
					: undefined,
				cacheReadTokens: ctx.cacheReadTokens
					? { value: ctx.cacheReadTokens, source: ctx.tokenSource }
					: undefined,
				reasoningTokens: ctx.reasoningTokens
					? { value: ctx.reasoningTokens, source: ctx.tokenSource }
					: undefined,
				// totalTokens = inputTokens + outputTokens (provider-neutral definition).
				// Cache tokens are a subset/breakdown of input; reasoning tokens are a subset of output.
				// Adding them separately would double-count. See docs/260720_22_gitignore-heatmap-fix/213200_debug-report.md
				totalTokens: {
					value: ctx.inputTokens + ctx.outputTokens,
					source: ctx.tokenSource,
				},
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
			this.onChanged?.()
		} catch {
			// store error must not break task
			// STATS_STORE/append/* errors are classified inside UsageEventStore
		}
	}

	/**
	 * For testing/verification: returns the current state of the finalizedKeys set.
	 * Not used in production code.
	 */
	_hasFinalized(requestKey: string, status: string): boolean {
		return this.finalizedKeys.has(`${requestKey}:${status}`)
	}
}
