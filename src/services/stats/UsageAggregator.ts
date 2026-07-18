import type {
	UsageEventV1,
	StatsQuery,
	StatsSnapshot,
	StatsBucket,
	SourcedNumber,
	UsageValueSource,
} from "@roo-code/types"

// ── Types ───────────────────────────────────────────────────────────────────

/** 집계에 사용할 내부 이벤트 표현 (UsageEventV1 + 파생 필드) */
interface AggregatableEvent {
	event: UsageEventV1
	/** timezone 기준 calendar bucket key (예: "2026-07-19") */
	dayBucket?: string
	/** timezone 기준 week bucket key (예: "2026-W29") */
	weekBucket?: string
	/** timezone 기준 month bucket key (예: "2026-07") */
	monthBucket?: string
}

/** source별 cost 분리를 위한 내부 구조 */
interface SourceSeparatedCost {
	provider: number
	estimated: number
	backfilled: number
}

// ── Empty Bucket Factory ────────────────────────────────────────────────────

function createEmptyBucket(key: Record<string, string> = {}): StatsBucket {
	return {
		key,
		events: 0,
		completedCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		unknownEventCount: 0,
	}
}

// ── UsageAggregator ────────────────────────────────────────────────────────

/**
 * 사용량 이벤트 집계 엔진.
 *
 * 설계 원칙 (아키텍처 보고서 섹션 5.17):
 * - day/week/month/provider/model/mode/status/source 그룹화 (최대 3축)
 * - timezone calendar bucket (DST 처리)
 * - unknown field 분리 (unknownEventCount)
 * - source별 cost 분리 (provider/estimated/backfilled)
 * - inclusion semantics 처리 (cacheReadInInput 등)
 * - 결과 정렬: 시간 오름차순, category는 known total 내림차순 후 이름 오름차순
 */
export class UsageAggregator {
	/**
	 * 이벤트 배열을 쿼리 조건에 따라 집계하여 StatsSnapshot을 반환한다.
	 *
	 * @param events 집계 대상 이벤트 배열 (UsageEventStore.readAll() 결과)
	 * @param query 통계 조회 쿼리
	 * @param options 추가 옵션 (recordingPaused 등)
	 */
	query(
		events: UsageEventV1[],
		query: StatsQuery,
		options: { recordingPaused?: boolean } = {},
	): StatsSnapshot {
		// 1. 시간 범위 필터링
		const { from, to } = this.resolveTimeRange(query)
		const filtered = events.filter((event) => {
			const eventTime = new Date(event.occurredAt).getTime()
			if (from && eventTime < from.getTime()) return false
			if (to && eventTime >= to.getTime()) return false
			return true
		})

		// 2. cancelled 이벤트 필터링
		const includeCancelled = query.includeCancelled ?? false
		const visibleEvents = includeCancelled
			? filtered
			: filtered.filter((e) => e.status !== "cancelled")

		// 3. timezone 기준 bucket key 계산
		const aggregatable: AggregatableEvent[] = visibleEvents.map((event) => {
			const bucketKeys = this.computeTimeBuckets(event, query.timezone)
			return { event, ...bucketKeys }
		})

		// 4. 그룹화 및 집계
		const groupBy = query.groupBy
		const bucketMap = new Map<string, StatsBucket>()

		for (const item of aggregatable) {
			const bucketKeys = this.getGroupKeys(item, groupBy)
			for (const bucketKey of bucketKeys) {
				const mapKey = this.serializeKey(bucketKey)
				let bucket = bucketMap.get(mapKey)
				if (!bucket) {
					bucket = createEmptyBucket(bucketKey)
					bucketMap.set(mapKey, bucket)
				}
				this.accumulateIntoBucket(bucket, item.event)
			}
		}

		// 5. totals 계산
		const totals = createEmptyBucket()
		for (const item of aggregatable) {
			this.accumulateIntoBucket(totals, item.event)
		}

		// 6. 정렬
		const buckets = this.sortBuckets(Array.from(bucketMap.values()), groupBy)

		// 7. coverage 계산
		const coverage = this.computeCoverage(events, aggregatable, options.recordingPaused)

		return {
			query,
			generatedAt: new Date().toISOString(),
			buckets,
			totals,
			coverage,
		}
	}

	// ── Time Range Resolution ───────────────────────────────────────────────

	/**
	 * 쿼리의 preset/from/to를 기반으로 시간 범위를 결정한다.
	 * - today: query timezone의 오늘 00:00부터 다음 날 00:00 미만
	 * - 7d/30d: 오늘 포함 calendar day 7/30개
	 * - all: 모든 지원 event
	 */
	private resolveTimeRange(query: StatsQuery): { from?: Date; to?: Date } {
		if (query.preset) {
			const now = new Date()
			const tzNow = this.toTimezoneDate(now, query.timezone)

			switch (query.preset) {
				case "today": {
					const from = this.startOfDay(tzNow, query.timezone)
					const to = new Date(from)
					to.setDate(to.getDate() + 1)
					return { from, to }
				}
				case "7d": {
					const to = this.startOfDay(tzNow, query.timezone)
					to.setDate(to.getDate() + 1)
					const from = new Date(to)
					from.setDate(from.getDate() - 7)
					return { from, to }
				}
				case "30d": {
					const to = this.startOfDay(tzNow, query.timezone)
					to.setDate(to.getDate() + 1)
					const from = new Date(to)
					from.setDate(from.getDate() - 30)
					return { from, to }
				}
				case "all":
					return {}
			}
		}

		// 명시적 from/to
		const from = query.from ? new Date(query.from) : undefined
		const to = query.to ? new Date(query.to) : undefined
		return { from, to }
	}

	/**
	 * UTC Date를 지정된 timezone의 같은 순간으로 변환한다.
	 * Intl API를 사용하여 DST를 자동 처리한다.
	 */
	private toTimezoneDate(date: Date, timezone: string): Date {
		// timezone에서의 wall-clock 시간을 구한다
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})

		const parts = formatter.formatToParts(date)
		const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0"
		const year = parseInt(get("year"), 10)
		const month = parseInt(get("month"), 10) - 1
		const day = parseInt(get("day"), 10)
		const hour = parseInt(get("hour"), 10) % 24 // 24시를 0시로 변환
		const minute = parseInt(get("minute"), 10)
		const second = parseInt(get("second"), 10)

		// timezone의 wall-clock 시간을 UTC로 변환
		// tzOffset = UTC - (timezone wall-clock as UTC)
		// timezone wall-clock의 실제 UTC = wall-clock as UTC + tzOffset
		const utcGuess = Date.UTC(year, month, day, hour, minute, second)
		const tzOffset = this.getTimezoneOffsetMinutes(date, timezone)
		return new Date(utcGuess + tzOffset * 60 * 1000)
	}

	/**
	 * 지정된 timezone에서의 UTC offset을 분 단위로 반환한다.
	 */
	private getTimezoneOffsetMinutes(date: Date, timezone: string): number {
		// UTC 시간을 timezone에서 포맷팅
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
		const get = (type: string) => tzParts.find((p) => p.type === type)?.value ?? "0"
		const tzYear = parseInt(get("year"), 10)
		const tzMonth = parseInt(get("month"), 10) - 1
		const tzDay = parseInt(get("day"), 10)
		const tzHour = parseInt(get("hour"), 10) % 24
		const tzMinute = parseInt(get("minute"), 10)
		const tzSecond = parseInt(get("second"), 10)

		// timezone wall-clock을 UTC epoch로
		const tzEpoch = Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMinute, tzSecond)
		// offset = UTC epoch - timezone epoch (분 단위)
		// timezone이 UTC보다 앞서면 (예: Asia/Seoul = +9), tzEpoch이 UTC epoch보다 작음
		// offset = (utcEpoch - tzEpoch) / 60000
		return Math.round((utcDate.getTime() - tzEpoch) / 60000)
	}

	/**
	 * timezone 기준으로 해당 날짜의 00:00:00 UTC를 반환한다.
	 */
	private startOfDay(date: Date, timezone: string): Date {
		const tzDate = this.toTimezoneDate(date, timezone)
		// timezone에서의 wall-clock 날짜만 추출
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
		const parts = formatter.formatToParts(date)
		const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0"
		const year = parseInt(get("year"), 10)
		const month = parseInt(get("month"), 10) - 1
		const day = parseInt(get("day"), 10)

		// timezone의 00:00:00을 UTC로 변환
		const midnightEpoch = Date.UTC(year, month, day, 0, 0, 0)
		const tzOffset = this.getTimezoneOffsetMinutes(date, timezone)
		// tzOffset = UTC - (timezone wall-clock as UTC)
		// timezone 자정의 실제 UTC = timezone 자정 wall-clock as UTC + tzOffset
		return new Date(midnightEpoch + tzOffset * 60 * 1000)
	}

	// ── Time Bucket Computation ─────────────────────────────────────────────

	/**
	 * 이벤트의 timezone 기준 calendar bucket key를 계산한다.
	 * DST는 Intl API로 자동 처리된다.
	 */
	private computeTimeBuckets(
		event: UsageEventV1,
		timezone: string,
	): { dayBucket?: string; weekBucket?: string; monthBucket?: string } {
		const date = new Date(event.occurredAt)

		// day bucket: YYYY-MM-DD (timezone 기준)
		const dayFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		})
		const dayBucket = dayFormatter.format(date).replace(/\//g, "-")

		// month bucket: YYYY-MM
		const monthFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
		})
		const monthBucket = monthFormatter.format(date).replace(/\//g, "-")

		// week bucket: YYYY-Www (ISO week)
		const weekBucket = this.computeIsoWeekBucket(date, timezone)

		return { dayBucket, weekBucket, monthBucket }
	}

	/**
	 * ISO 8601 주 번호를 계산한다 (YYYY-Www 형식).
	 * timezone 기준으로 계산한다.
	 */
	private computeIsoWeekBucket(date: Date, timezone: string): string {
		// timezone 기준 날짜 구하기
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

		// ISO week 계산
		const d = new Date(Date.UTC(year, month, day))
		const dayNum = d.getUTCDay() || 7 // Sunday=0 → 7
		d.setUTCDate(d.getUTCDate() + 4 - dayNum)
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
		const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)

		return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`
	}

	// ── Grouping ────────────────────────────────────────────────────────────

	/**
	 * 이벤트에서 groupBy 축에 따른 bucket key 조합을 반환한다.
	 * 최대 3축까지 조합할 수 있다.
	 */
	private getGroupKeys(
		item: AggregatableEvent,
		groupBy: StatsQuery["groupBy"],
	): Record<string, string>[] {
		if (groupBy.length === 0) {
			return [{}]
		}

		// 각 축의 가능한 값을 배열로 구한 후 Cartesian product
		const axisValues: Record<string, string[]> = {}

		for (const axis of groupBy) {
			axisValues[axis] = this.getAxisValues(item, axis)
		}

		// Cartesian product
		const axes = Object.keys(axisValues)
		const results: Record<string, string>[] = [{}]

		for (const axis of axes) {
			const newResults: Record<string, string>[] = []
			for (const existing of results) {
				for (const value of axisValues[axis]) {
					newResults.push({ ...existing, [axis]: value })
				}
			}
			results.length = 0
			results.push(...newResults)
		}

		return results
	}

	/**
	 * 단일 축에 대한 이벤트의 값을 반환한다.
	 * source 축은 costUsd의 source에 따라 여러 값을 가질 수 있다.
	 */
	private getAxisValues(item: AggregatableEvent, axis: string): string[] {
		const { event } = item

		switch (axis) {
			case "day":
				return item.dayBucket ? [item.dayBucket] : []
			case "week":
				return item.weekBucket ? [item.weekBucket] : []
			case "month":
				return item.monthBucket ? [item.monthBucket] : []
			case "provider":
				return [event.provider]
			case "model":
				return [event.model]
			case "mode":
				return [event.mode]
			case "status":
				return [event.status]
			case "source": {
				// costUsd의 source에 따라 분리
				// 이벤트에 costUsd가 있으면 그 source를, 없으면 "unknown"
				const sources = new Set<string>()
				if (event.usage.costUsd) {
					sources.add(event.usage.costUsd.source)
				}
				// input/output tokens의 source도 고려
				if (event.usage.inputTokens) {
					sources.add(event.usage.inputTokens.source)
				}
				if (event.usage.outputTokens) {
					sources.add(event.usage.outputTokens.source)
				}
				if (sources.size === 0) {
					sources.add("unknown")
				}
				return Array.from(sources)
			}
			default:
				return []
		}
	}

	// ── Accumulation ────────────────────────────────────────────────────────

	/**
	 * 이벤트의 값을 bucket에 누적한다.
	 * inclusion semantics를 처리한다.
	 */
	private accumulateIntoBucket(bucket: StatsBucket, event: UsageEventV1): void {
		bucket.events++

		// status 카운트
		switch (event.status) {
			case "completed":
				bucket.completedCalls++
				break
			case "failed":
				bucket.failedCalls++
				break
			case "cancelled":
				bucket.cancelledCalls++
				break
		}

		// 토큰 누적 (inclusion semantics 처리)
		// cacheReadInInput이 "included"면 cacheReadTokens를 inputTokens에서 차감하지 않음 (이미 포함됨)
		// "excluded"면 별도 추가
		// "unknown"이면 unknownEventCount 증가

		const inputTokens = this.extractValue(event.usage.inputTokens)
		const outputTokens = this.extractValue(event.usage.outputTokens)
		const cacheReadTokens = this.extractValue(event.usage.cacheReadTokens)
		const cacheWriteTokens = this.extractValue(event.usage.cacheWriteTokens)
		const reasoningTokens = this.extractValue(event.usage.reasoningTokens)
		const totalTokens = this.extractValue(event.usage.totalTokens)
		const costUsd = this.extractValue(event.usage.costUsd)

		// inclusion semantics 검사
		const hasUnknownInclusion =
			event.semantics.cacheReadInInput === "unknown" ||
			event.semantics.cacheWriteInInput === "unknown" ||
			event.semantics.reasoningInOutput === "unknown"

		if (hasUnknownInclusion) {
			bucket.unknownEventCount++
		}

		// 토큰 값 누적
		// cacheReadInInput이 "included"면 inputTokens에 이미 cacheRead가 포함되어 있으므로
		// cacheReadTokens를 별도로 더하지 않음 (중복 방지)
		// "excluded"면 cacheReadTokens를 별도로 더함
		bucket.inputTokens += inputTokens
		bucket.outputTokens += outputTokens

		if (event.semantics.cacheReadInInput === "excluded") {
			bucket.cacheReadTokens += cacheReadTokens
		} else if (event.semantics.cacheReadInInput === "included") {
			// inputTokens에 이미 포함되어 있으므로 별도 추가 없음
			// 하지만 cacheReadTokens 필드에는 기록 (참고용)
			bucket.cacheReadTokens += cacheReadTokens
		} else {
			// unknown: 일단 더하되 unknownEventCount로 표시
			bucket.cacheReadTokens += cacheReadTokens
		}

		if (event.semantics.cacheWriteInInput === "excluded") {
			bucket.cacheWriteTokens += cacheWriteTokens
		} else if (event.semantics.cacheWriteInInput === "included") {
			bucket.cacheWriteTokens += cacheWriteTokens
		} else {
			bucket.cacheWriteTokens += cacheWriteTokens
		}

		if (event.semantics.reasoningInOutput === "excluded") {
			bucket.reasoningTokens += reasoningTokens
		} else if (event.semantics.reasoningInOutput === "included") {
			bucket.reasoningTokens += reasoningTokens
		} else {
			bucket.reasoningTokens += reasoningTokens
		}

		bucket.totalTokens += totalTokens
		bucket.costUsd += costUsd
	}

	/**
	 * SourcedNumber에서 값을 추출한다.
	 */
	private extractValue(sourced?: SourcedNumber): number {
		return sourced?.value ?? 0
	}

	// ── Sorting ────────────────────────────────────────────────────────────

	/**
	 * bucket을 정렬한다.
	 * - 시간 축(day/week/month)이 있으면 시간 오름차순
	 * - category 축만 있으면 known total 내림차순 후 이름 오름차순
	 */
	private sortBuckets(buckets: StatsBucket[], groupBy: StatsQuery["groupBy"]): StatsBucket[] {
		const hasTimeAxis = groupBy.some((g) => g === "day" || g === "week" || g === "month")

		if (hasTimeAxis) {
			// 시간 축 기준으로 정렬
			const timeAxis = groupBy.find((g) => g === "day" || g === "week" || g === "month")!
			return buckets.sort((a, b) => {
				const aTime = a.key[timeAxis] ?? ""
				const bTime = b.key[timeAxis] ?? ""
				return aTime.localeCompare(bTime)
			})
		}

		// category만 있는 경우: known total 내림차순 후 이름 오름차순
		return buckets.sort((a, b) => {
			// totalTokens 기준 내림차순
			const diff = b.totalTokens - a.totalTokens
			if (diff !== 0) return diff

			// 이름 오름차순
			const aName = Object.values(a.key).join("/")
			const bName = Object.values(b.key).join("/")
			return aName.localeCompare(bName)
		})
	}

	// ── Coverage ────────────────────────────────────────────────────────────

	/**
	 * coverage 정보를 계산한다.
	 */
	private computeCoverage(
		allEvents: UsageEventV1[],
		visibleEvents: AggregatableEvent[],
		recordingPaused: boolean = false,
	): StatsSnapshot["coverage"] {
		const times = visibleEvents.map((e) => new Date(e.event.occurredAt).getTime()).sort((a, b) => a - b)

		const backfilledEventCount = visibleEvents.filter(
			(e) => e.event.provenance === "history-backfill",
		).length

		return {
			firstEventAt: times.length > 0 ? new Date(times[0]).toISOString() : undefined,
			lastEventAt: times.length > 0 ? new Date(times[times.length - 1]).toISOString() : undefined,
			recordingPaused,
			backfilledEventCount,
		}
	}

	// ── Utilities ───────────────────────────────────────────────────────────

	/**
	 * bucket key 객체를 직렬화하여 Map key로 사용한다.
	 */
	private serializeKey(key: Record<string, string>): string {
		return Object.keys(key)
			.sort()
			.map((k) => `${k}=${key[k]}`)
			.join("|")
	}
}
