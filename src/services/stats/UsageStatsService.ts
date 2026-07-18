import type { UsageEventV1, StatsQuery, StatsSnapshot } from "@roo-code/types"

import { UsageEventStore, StatsStoreError } from "./UsageEventStore"
import { UsageAggregator } from "./UsageAggregator"

// ── Export Format ───────────────────────────────────────────────────────────

export type ExportFormat = "json" | "csv"

/** JSON export 결과 */
export interface JsonExport {
	exportSchemaVersion: 1
	exportedAt: string
	query: StatsQuery
	events: UsageEventV1[]
}

// ── Error Codes ─────────────────────────────────────────────────────────────

export type StatsServiceErrorCode =
	| "STATS_SERVICE/export/001" // 지원하지 않는 format
	| "STATS_SERVICE/clear/001" // nonce 불일치
	| "STATS_SERVICE/backfill/001" // backfill 실패

export class StatsServiceError extends Error {
	constructor(
		public readonly code: StatsServiceErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsServiceError"
	}
}

// ── CSV Column Order ────────────────────────────────────────────────────────

/**
 * CSV export의 고정 column 순서.
 * 누락 값은 빈 cell, 0은 `0`.
 * source와 inclusion field를 별도 column으로 둔다.
 */
const CSV_COLUMNS = [
	"eventId",
	"idempotencyKey",
	"occurredAt",
	"timezoneOffsetMinutes",
	"status",
	"attempt",
	"taskId",
	"parentTaskId",
	"provider",
	"model",
	"mode",
	"inputTokens",
	"inputTokensSource",
	"outputTokens",
	"outputTokensSource",
	"cacheWriteTokens",
	"cacheWriteTokensSource",
	"cacheReadTokens",
	"cacheReadTokensSource",
	"reasoningTokens",
	"reasoningTokensSource",
	"totalTokens",
	"totalTokensSource",
	"costUsd",
	"costUsdSource",
	"cacheReadInInput",
	"cacheWriteInInput",
	"reasoningInOutput",
	"provenance",
] as const

// ── UsageStatsService ───────────────────────────────────────────────────────

/**
 * 통계 서비스 facade.
 * UsageEventStore과 UsageAggregator를 통합하여 제공한다.
 *
 * 설계 원칙 (아키텍처 보고서 섹션 5.15-5.17):
 * - query: 집계 엔진을 통한 통계 조회
 * - export: JSON/CSV 형식으로 통계 내보내기
 * - clear: nonce 검증 후 통계 데이터 삭제
 * - backfill: 과거 task history에서 이벤트 복원
 *
 * 보안: prompt, response, API key, workspace path를 저장하지 않는다.
 */
export class UsageStatsService {
	private readonly store: UsageEventStore
	private readonly aggregator: UsageAggregator

	/** clear 검증용 nonce (짧은 수명) */
	private clearNonce: string | null = null
	private clearNonceExpiresAt: number = 0

	constructor(globalStoragePath: string) {
		this.store = new UsageEventStore(globalStoragePath)
		this.aggregator = new UsageAggregator()
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * 서비스를 초기화한다.
	 * 저장소 초기화를 수행한다.
	 */
	async initialize(): Promise<void> {
		await this.store.initialize()
	}

	/**
	 * 통계를 조회한다.
	 *
	 * @param query 통계 조회 쿼리
	 * @param options 추가 옵션
	 * @returns 통계 스냅샷
	 */
	async queryStats(
		query: StatsQuery,
		options: { recordingPaused?: boolean } = {},
	): Promise<StatsSnapshot> {
		const events = await this.store.readAll()
		return this.aggregator.query(events, query, options)
	}

	/**
	 * 통계를 내보낸다.
	 *
	 * @param query 통계 조회 쿼리 (export 대상 범위)
	 * @param format 내보낼 형식 ("json" 또는 "csv")
	 * @returns JSON인 경우 객체, CSV인 경우 문자열
	 */
	async exportStats(
		query: StatsQuery,
		format: ExportFormat,
	): Promise<JsonExport | string> {
		const events = await this.store.readAll()

		// 시간 범위 필터링
		const filtered = this.filterEventsByQuery(events, query)

		switch (format) {
			case "json":
				return {
					exportSchemaVersion: 1,
					exportedAt: new Date().toISOString(),
					query,
					events: filtered,
				}

			case "csv":
				return this.eventsToCsv(filtered)

			default:
				throw new StatsServiceError(
					"STATS_SERVICE/export/001",
					`Unsupported export format: ${format as string}`,
				)
		}
	}

	/**
	 * 통계 삭제를 위한 nonce를 발급한다.
	 * UI 1차 confirmation dialog 후 Host가 이 메서드를 호출한다.
	 *
	 * @returns 짧은 수명의 nonce (5분 유효)
	 */
	issueClearNonce(): string {
		const nonce = this.generateNonce()
		this.clearNonce = nonce
		// 5분 유효
		this.clearNonceExpiresAt = Date.now() + 5 * 60 * 1000
		return nonce
	}

	/**
	 * 통계 데이터를 삭제한다.
	 * nonce가 유효해야 한다 (5분 이내, 1회용).
	 *
	 * @param nonce issueClearNonce()로 발급받은 nonce
	 * @throws StatsServiceError nonce 불일치 또는 만료 시
	 */
	async clearStats(nonce: string): Promise<void> {
		// nonce 검증
		if (!this.clearNonce || this.clearNonce !== nonce) {
			throw new StatsServiceError(
				"STATS_SERVICE/clear/001",
				"Invalid clear nonce: nonce mismatch",
			)
		}

		if (Date.now() > this.clearNonceExpiresAt) {
			this.clearNonce = null
			throw new StatsServiceError(
				"STATS_SERVICE/clear/001",
				"Invalid clear nonce: nonce expired",
			)
		}

		// 1회용 nonce 소비
		this.clearNonce = null

		// 저장소 clear
		await this.store.clear()
	}

	/**
	 * 과거 task history에서 사용량 이벤트를 복원한다.
	 * Commit 3의 UsageRecorder에서 실제 구현 시 호출된다.
	 *
	 * @param events 복원할 이벤트 배열
	 * @returns 복원된 이벤트 수 (dedupe로 인해 실제 append된 수는 다를 수 있음)
	 */
	async backfillFromHistory(events: UsageEventV1[]): Promise<number> {
		let appended = 0

		for (const event of events) {
			try {
				// provenance가 "history-backfill"이어야 함
				const backfillEvent: UsageEventV1 = {
					...event,
					provenance: "history-backfill",
				}
				const result = await this.store.append(backfillEvent)
				if (result) {
					appended++
				}
			} catch (err) {
				// storage 오류는 LLM task를 실패시키지 않음
				if (err instanceof StatsStoreError) {
					console.warn(`[UsageStatsService] backfill append failed for event ${event.eventId}:`, err)
				} else {
					throw new StatsServiceError(
						"STATS_SERVICE/backfill/001",
						`Backfill failed for event ${event.eventId}`,
						err,
					)
				}
			}
		}

		return appended
	}

	/**
	 * 저장소가 hard cap에 도달했는지 확인한다.
	 */
	isCapped(): boolean {
		return this.store.isCapped()
	}

	// ── Internal: Event Filtering ───────────────────────────────────────────

	/**
	 * 쿼리 조건에 따라 이벤트를 필터링한다.
	 * 시간 범위와 includeCancelled를 처리한다.
	 */
	private filterEventsByQuery(events: UsageEventV1[], query: StatsQuery): UsageEventV1[] {
		// 시간 범위
		let from: Date | undefined
		let to: Date | undefined

		if (query.preset) {
			const now = new Date()
			const range = this.resolvePresetRange(query.preset, query.timezone, now)
			from = range.from
			to = range.to
		} else {
			from = query.from ? new Date(query.from) : undefined
			to = query.to ? new Date(query.to) : undefined
		}

		let filtered = events.filter((event) => {
			const eventTime = new Date(event.occurredAt).getTime()
			if (from && eventTime < from.getTime()) return false
			if (to && eventTime >= to.getTime()) return false
			return true
		})

		// cancelled 필터링
		const includeCancelled = query.includeCancelled ?? false
		if (!includeCancelled) {
			filtered = filtered.filter((e) => e.status !== "cancelled")
		}

		return filtered
	}

	/**
	 * preset에서 시간 범위를 계산한다.
	 */
	private resolvePresetRange(
		preset: NonNullable<StatsQuery["preset"]>,
		timezone: string,
		now: Date,
	): { from?: Date; to?: Date } {
		const tzNow = this.toTimezoneStartOfDay(now, timezone)

		switch (preset) {
			case "today": {
				const from = new Date(tzNow)
				const to = new Date(from)
				to.setDate(to.getDate() + 1)
				return { from, to }
			}
			case "7d": {
				const to = new Date(tzNow)
				to.setDate(to.getDate() + 1)
				const from = new Date(to)
				from.setDate(from.getDate() - 7)
				return { from, to }
			}
			case "30d": {
				const to = new Date(tzNow)
				to.setDate(to.getDate() + 1)
				const from = new Date(to)
				from.setDate(from.getDate() - 30)
				return { from, to }
			}
			case "all":
				return {}
		}
	}

	/**
	 * timezone 기준으로 해당 날짜의 00:00:00 UTC를 반환한다.
	 */
	private toTimezoneStartOfDay(date: Date, timezone: string): Date {
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
		const parts = formatter.formatToParts(date)
		const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10)
		const year = get("year")
		const month = get("month") - 1
		const day = get("day")

		// timezone의 wall-clock 자정을 UTC로 변환
		const midnightEpoch = Date.UTC(year, month, day, 0, 0, 0)
		const tzOffset = this.getTimezoneOffsetMinutes(date, timezone)
		// tzOffset = UTC - (timezone wall-clock as UTC)
		// timezone 자정의 실제 UTC = timezone 자정 wall-clock as UTC + tzOffset
		return new Date(midnightEpoch + tzOffset * 60 * 1000)
	}

	/**
	 * 지정된 timezone에서의 UTC offset을 분 단위로 반환한다.
	 */
	private getTimezoneOffsetMinutes(date: Date, timezone: string): number {
		const utcDate = new Date(date.toISOString())
		const tzFormatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
		const tzParts = tzFormatter.formatToParts(utcDate)
		const get = (type: string) => parseInt(tzParts.find((p) => p.type === type)?.value ?? "0", 10)
		const tzYear = get("year")
		const tzMonth = get("month") - 1
		const tzDay = get("day")
		const tzHour = get("hour") % 24
		const tzMinute = get("minute")
		const tzSecond = get("second")

		const tzEpoch = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond)
		return Math.round((utcDate.getTime() - tzEpoch) / 60000)
	}

	// ── Internal: CSV ────────────────────────────────────────────────────────

	/**
	 * 이벤트 배열을 CSV 문자열로 변환한다.
	 * - event당 한 행
	 * - 고정 column 순서
	 * - 누락 값은 빈 cell, 0은 `0`
	 * - source와 inclusion field를 별도 column으로 둔다
	 * - spreadsheet formula injection 방지: `=`, `+`, `-`, `@`로 시작하면 `'`를 붙임
	 */
	private eventsToCsv(events: UsageEventV1[]): string {
		const rows: string[] = []

		// header
		rows.push(CSV_COLUMNS.join(","))

		for (const event of events) {
			const row = this.eventToCsvRow(event)
			rows.push(row)
		}

		return rows.join("\n")
	}

	/**
	 * 단일 이벤트를 CSV 행으로 변환한다.
	 */
	private eventToCsvRow(event: UsageEventV1): string {
		const values: string[] = []

		for (const col of CSV_COLUMNS) {
			const value = this.extractCsvValue(event, col)
			values.push(this.escapeCsvCell(value))
		}

		return values.join(",")
	}

	/**
	 * 이벤트에서 column에 해당하는 값을 추출한다.
	 */
	private extractCsvValue(event: UsageEventV1, column: string): string {
		switch (column) {
			case "eventId":
				return event.eventId
			case "idempotencyKey":
				return event.idempotencyKey
			case "occurredAt":
				return event.occurredAt
			case "timezoneOffsetMinutes":
				return String(event.timezoneOffsetMinutes)
			case "status":
				return event.status
			case "attempt":
				return String(event.attempt)
			case "taskId":
				return event.taskId
			case "parentTaskId":
				return event.parentTaskId ?? ""
			case "provider":
				return event.provider
			case "model":
				return event.model
			case "mode":
				return event.mode
			case "inputTokens":
				return event.usage.inputTokens ? String(event.usage.inputTokens.value) : ""
			case "inputTokensSource":
				return event.usage.inputTokens?.source ?? ""
			case "outputTokens":
				return event.usage.outputTokens ? String(event.usage.outputTokens.value) : ""
			case "outputTokensSource":
				return event.usage.outputTokens?.source ?? ""
			case "cacheWriteTokens":
				return event.usage.cacheWriteTokens ? String(event.usage.cacheWriteTokens.value) : ""
			case "cacheWriteTokensSource":
				return event.usage.cacheWriteTokens?.source ?? ""
			case "cacheReadTokens":
				return event.usage.cacheReadTokens ? String(event.usage.cacheReadTokens.value) : ""
			case "cacheReadTokensSource":
				return event.usage.cacheReadTokens?.source ?? ""
			case "reasoningTokens":
				return event.usage.reasoningTokens ? String(event.usage.reasoningTokens.value) : ""
			case "reasoningTokensSource":
				return event.usage.reasoningTokens?.source ?? ""
			case "totalTokens":
				return event.usage.totalTokens ? String(event.usage.totalTokens.value) : ""
			case "totalTokensSource":
				return event.usage.totalTokens?.source ?? ""
			case "costUsd":
				return event.usage.costUsd ? String(event.usage.costUsd.value) : ""
			case "costUsdSource":
				return event.usage.costUsd?.source ?? ""
			case "cacheReadInInput":
				return event.semantics.cacheReadInInput
			case "cacheWriteInInput":
				return event.semantics.cacheWriteInInput
			case "reasoningInOutput":
				return event.semantics.reasoningInOutput
			case "provenance":
				return event.provenance
			default:
				return ""
		}
	}

	/**
	 * CSV cell을 escape한다.
	 * - spreadsheet formula injection 방지: `=`, `+`, `-`, `@`로 시작하면 `'`를 붙임
	 * - 값에 `,`, `"`, `\n`이 포함되면 `"..."`로 감싸고 내부 `"`는 `""`로 escape
	 */
	private escapeCsvCell(value: string): string {
		// 빈 값은 빈 cell
		if (value === "") {
			return ""
		}

		// formula injection 방지
		let escaped = value
		if (/^[=+\-@]/.test(escaped)) {
			escaped = `'${escaped}`
		}

		// quoting 필요 여부
		if (/[",\n]/.test(escaped)) {
			escaped = `"${escaped.replace(/"/g, '""')}"`
		}

		return escaped
	}

	// ── Internal: Nonce ─────────────────────────────────────────────────────

	/**
	 * 짧은 수명의 nonce를 생성한다.
	 * crypto.randomUUID를 사용할 수 없는 환경을 위해 fallback을 제공한다.
	 */
	private generateNonce(): string {
		try {
			const crypto = require("crypto")
			return crypto.randomUUID()
		} catch {
			// fallback: timestamp + random
			return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
		}
	}
}
