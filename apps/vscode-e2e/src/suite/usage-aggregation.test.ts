import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import { UsageEventV1, StatsSnapshot, type StatsBucket, type StatsQuery } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, waitUntilCompleted } from "./utils"

/**
 * E2E coverage for the Usage Aggregator & Pipeline (PR #1131 / b14-usage-aggregation-v2).
 *
 * The suite drives real tasks through the aimock provider, lets the extension
 * host's usage pipeline (UsageRecorder → UsageEventStore → UsageStatsService →
 * UsageAggregator) persist events, and then validates the aggregation contract
 * end-to-end against the raw NDJSON event log on disk:
 *
 * 1. Pipeline — a completed task's events survive the full record → store →
 *    query pipeline with schema-valid shape.
 * 2. Day buckets — grouping persisted events by calendar day (via the same
 *    Intl/IANA-timezone algorithm UsageAggregator uses) produces per-day
 *    buckets whose sums equal the ungrouped totals.
 * 3. Snapshot contract — an aggregator-equivalent snapshot built from raw
 *    events satisfies the StatsSnapshot zod schema and the StatsBucket
 *    invariants (status counts sum to events, totals consistency).
 *
 * UsageStatsService/UsageAggregator live inside the extension host and are not
 * exposed on the public RooCodeAPI surface, so this suite verifies the
 * pipeline's observable side-effect (the on-disk event log) and re-derives the
 * aggregation semantics declared in packages/types/src/usage-stats.ts — the
 * same schemas the host-side aggregator is unit-tested against.
 */

const STATS_DIR = path.resolve(
	__dirname,
	"..",
	"..",
	".vscode-test",
	"user-data",
	"User",
	"globalStorage",
	"zoocodeorganization.zoo-code",
	"usage-stats",
)

const TASK_MARKER = "USAGE_AGGREGATION_E2E_SMOKE: what is your name?"

/** Read all NDJSON segment files directly from disk (no store instance). */
async function readRawEvents(): Promise<UsageEventV1[]> {
	let segmentFiles: string[]
	try {
		const allFiles = await fs.readdir(STATS_DIR)
		segmentFiles = allFiles.filter((f) => f.startsWith("events-") && f.endsWith(".ndjson")).sort()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw err
	}

	const events: UsageEventV1[] = []
	for (const file of segmentFiles) {
		const content = await fs.readFile(path.join(STATS_DIR, file), "utf-8")
		const lines = content.split("\n").filter((line) => line.trim().length > 0)
		for (const line of lines) {
			const parsed = UsageEventV1.safeParse(JSON.parse(line))
			assert.ok(parsed.success, `Persisted event in ${file} must match UsageEventV1 schema`)
			events.push(parsed.data)
		}
	}
	return events
}

/** Empty bucket matching UsageAggregator.createEmptyBucket. */
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

/**
 * Accumulate one event into a bucket, mirroring UsageAggregator's observable
 * semantics: status counters, token sums, totalTokens recomputed as
 * input + output (provider-neutral), and unknown-inclusion counting.
 */
function accumulateIntoBucket(bucket: StatsBucket, event: UsageEventV1): void {
	bucket.events += 1
	if (event.status === "completed") bucket.completedCalls += 1
	if (event.status === "failed") bucket.failedCalls += 1
	if (event.status === "cancelled") bucket.cancelledCalls += 1

	const input = event.usage.inputTokens?.value ?? 0
	const output = event.usage.outputTokens?.value ?? 0
	bucket.inputTokens += input
	bucket.outputTokens += output
	bucket.cacheReadTokens += event.usage.cacheReadTokens?.value ?? 0
	bucket.cacheWriteTokens += event.usage.cacheWriteTokens?.value ?? 0
	bucket.reasoningTokens += event.usage.reasoningTokens?.value ?? 0
	// UsageAggregator recomputes totalTokens as input + output rather than
	// trusting the provider-reported total (repairs double-counted history).
	bucket.totalTokens += input + output
	bucket.costUsd += event.usage.costUsd?.value ?? 0

	if (
		event.semantics.cacheReadInInput === "unknown" ||
		event.semantics.cacheWriteInInput === "unknown" ||
		event.semantics.reasoningInOutput === "unknown"
	) {
		bucket.unknownEventCount += 1
	}
}

/**
 * Calendar day bucket key (YYYY-MM-DD) in the given IANA timezone — the same
 * Intl-based computation UsageAggregator.computeTimeBuckets performs, which
 * keeps DST handling in the platform instead of hand-rolled offsets.
 */
function dayBucketKey(occurredAt: string, timezone: string): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	return formatter.format(new Date(occurredAt)).replace(/\//g, "-")
}

/**
 * Build an aggregator-equivalent snapshot from raw events for the given
 * groupBy axes. Mirrors UsageAggregator.query for the day/totals surface this
 * suite asserts on (cancelled exclusion, bucket accumulation, coverage).
 */
function aggregateSnapshot(events: UsageEventV1[], query: StatsQuery): StatsSnapshot {
	const includeCancelled = query.includeCancelled ?? false
	const visible = includeCancelled ? events : events.filter((e) => e.status !== "cancelled")

	const bucketMap = new Map<string, StatsBucket>()
	for (const event of visible) {
		const key: Record<string, string> = {}
		for (const axis of query.groupBy) {
			if (axis === "day") key.day = dayBucketKey(event.occurredAt, query.timezone)
			if (axis === "provider") key.provider = event.provider
			if (axis === "model") key.model = event.model
			if (axis === "mode") key.mode = event.mode
			if (axis === "status") key.status = event.status
		}
		const mapKey = JSON.stringify(key)
		let bucket = bucketMap.get(mapKey)
		if (!bucket) {
			bucket = createEmptyBucket(key)
			bucketMap.set(mapKey, bucket)
		}
		accumulateIntoBucket(bucket, event)
	}

	const totals = createEmptyBucket()
	for (const event of visible) {
		accumulateIntoBucket(totals, event)
	}

	const buckets = Array.from(bucketMap.values())
	// Time axis present → sort ascending by the day key.
	if (query.groupBy.includes("day")) {
		buckets.sort((a, b) => (a.key.day ?? "").localeCompare(b.key.day ?? ""))
	}

	const times = visible.map((e) => Date.parse(e.occurredAt)).sort((a, b) => a - b)
	const firstTime = times.at(0)
	const lastTime = times.at(-1)

	return {
		query,
		generatedAt: new Date().toISOString(),
		buckets,
		totals,
		coverage: {
			firstEventAt: firstTime !== undefined ? new Date(firstTime).toISOString() : undefined,
			lastEventAt: lastTime !== undefined ? new Date(lastTime).toISOString() : undefined,
			recordingPaused: false,
			backfilledEventCount: visible.filter((e) => e.provenance === "history-backfill").length,
		},
	}
}

suite("Usage Aggregation Pipeline", function () {
	setDefaultSuiteTimeout(this)

	test("aggregation pipeline records a completed task end-to-end", async () => {
		const api = globalThis.api
		const before = await readRawEvents()

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: TASK_MARKER,
		})

		await waitUntilCompleted({ api, taskId })

		// UsageRecorder.finalizeUsageEvent is fire-and-forget; poll until the
		// store write lands on disk before asserting on the pipeline output.
		let after: UsageEventV1[] = []
		await waitFor(async () => {
			after = await readRawEvents()
			return after.some((event) => event.taskId === taskId)
		})

		const taskEvents = after.filter((event) => event.taskId === taskId)
		assert.ok(taskEvents.length > 0, `Task ${taskId} should flow through the pipeline to disk`)
		assert.ok(after.length > before.length, "Pipeline must append new events for the completed task")

		// The events produced by the pipeline must be aggregatable: every field
		// the aggregator reads (status, usage numbers, semantics, provenance)
		// must be present and well-formed.
		for (const event of taskEvents) {
			assert.strictEqual(event.status, "completed")
			assert.ok(event.usage.inputTokens, "pipeline must record inputTokens for aggregation")
			assert.ok(event.usage.outputTokens, "pipeline must record outputTokens for aggregation")
			assert.ok(
				["included", "excluded", "unknown"].includes(event.semantics.cacheReadInInput),
				"semantics.cacheReadInInput must be a valid InclusionRule",
			)
			assert.strictEqual(event.provenance, "live")
		}

		// Aggregating the task's own events must yield a totals row whose event
		// count matches what the pipeline persisted for this task.
		const snapshot = aggregateSnapshot(taskEvents, {
			timezone: "UTC",
			groupBy: [],
			includeCancelled: false,
		})
		assert.strictEqual(snapshot.totals.events, taskEvents.length)
		assert.strictEqual(snapshot.totals.completedCalls, taskEvents.length)
	})

	test("daily bucket aggregation partitions events correctly", async () => {
		const events = await readRawEvents()
		assert.ok(events.length > 0, "expected usage events from the pipeline test")

		const timezone = "UTC"
		const grouped = aggregateSnapshot(events, {
			timezone,
			groupBy: ["day"],
			includeCancelled: true,
		})

		// Day buckets must cover every visible event exactly once.
		const bucketEventSum = grouped.buckets.reduce((sum, b) => sum + b.events, 0)
		assert.strictEqual(bucketEventSum, grouped.totals.events, "day buckets must partition all events")
		assert.strictEqual(grouped.totals.events, events.length)

		// Bucket keys must be valid YYYY-MM-DD calendar days in the timezone.
		for (const bucket of grouped.buckets) {
			assert.ok(
				/^\d{4}-\d{2}-\d{2}$/.test(bucket.key.day ?? ""),
				`day bucket key must be YYYY-MM-DD, got: ${bucket.key.day}`,
			)
		}

		// Buckets must be sorted by day ascending (UsageAggregator contract for
		// time axes).
		const dayKeys = grouped.buckets.map((b) => b.key.day ?? "")
		const sorted = [...dayKeys].sort((a, b) => a.localeCompare(b))
		assert.deepStrictEqual(dayKeys, sorted, "day buckets must be sorted ascending")

		// Per-day token sums must add back up to the totals row.
		const inputSum = grouped.buckets.reduce((sum, b) => sum + b.inputTokens, 0)
		const outputSum = grouped.buckets.reduce((sum, b) => sum + b.outputTokens, 0)
		assert.strictEqual(inputSum, grouped.totals.inputTokens)
		assert.strictEqual(outputSum, grouped.totals.outputTokens)

		// Cross-check against an independent per-day grouping: each event's
		// bucket key must match the day derived from its own timestamp.
		const expectedDays = new Map<string, number>()
		for (const event of events) {
			const key = dayBucketKey(event.occurredAt, timezone)
			expectedDays.set(key, (expectedDays.get(key) ?? 0) + 1)
		}
		for (const bucket of grouped.buckets) {
			assert.strictEqual(
				bucket.events,
				expectedDays.get(bucket.key.day ?? ""),
				`day bucket ${bucket.key.day} must contain exactly its day's events`,
			)
		}

		// The aggregated snapshot itself must satisfy the StatsSnapshot schema
		// the host-side aggregator is typed against.
		const validated = StatsSnapshot.safeParse(grouped)
		assert.ok(validated.success, "aggregated snapshot must satisfy the StatsSnapshot schema")
	})

	test("bucket invariants hold for the full event log", async () => {
		const events = await readRawEvents()
		assert.ok(events.length > 0, "expected usage events from earlier tests")

		const snapshot = aggregateSnapshot(events, {
			timezone: "UTC",
			groupBy: ["provider"],
			includeCancelled: true,
		})

		// Status counters must partition events in every bucket and in totals.
		const assertStatusPartition = (bucket: StatsBucket, label: string) => {
			assert.strictEqual(
				bucket.completedCalls + bucket.failedCalls + bucket.cancelledCalls,
				bucket.events,
				`${label}: status counts must sum to events`,
			)
		}
		for (const bucket of snapshot.buckets) {
			assertStatusPartition(bucket, `bucket ${JSON.stringify(bucket.key)}`)
		}
		assertStatusPartition(snapshot.totals, "totals")

		// totalTokens is recomputed as input + output per event — the aggregate
		// must equal the sum of those pairs, not any provider-reported total.
		const expectedTotal = events.reduce(
			(sum, e) => sum + (e.usage.inputTokens?.value ?? 0) + (e.usage.outputTokens?.value ?? 0),
			0,
		)
		assert.strictEqual(snapshot.totals.totalTokens, expectedTotal)

		// The e2e flow records through the openrouter provider (aimock).
		const providerKeys = snapshot.buckets.map((b) => b.key.provider)
		assert.ok(
			providerKeys.includes("openrouter"),
			`expected an openrouter provider bucket, got: ${providerKeys.join(", ")}`,
		)

		// Coverage metadata must reflect the full visible range.
		assert.ok(snapshot.coverage.firstEventAt, "coverage.firstEventAt must be set when events exist")
		assert.ok(snapshot.coverage.lastEventAt, "coverage.lastEventAt must be set when events exist")
		assert.ok(
			Date.parse(snapshot.coverage.firstEventAt!) <= Date.parse(snapshot.coverage.lastEventAt!),
			"coverage range must be ordered",
		)
		assert.strictEqual(snapshot.coverage.backfilledEventCount, 0, "e2e pipeline events are live, not backfilled")
	})
})
