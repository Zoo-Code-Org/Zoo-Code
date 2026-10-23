import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildRunMetrics, costPerSuccessfulTask, type CodingRunMetrics } from "./coding-metrics.ts"
import type { PriceTable } from "./coding-pricing.ts"
import type { AgentTrace, TraceAccounting } from "./trace.ts"
import { TRACE_KIND, TRACE_SCHEMA_VERSION, identityUnavailable } from "./trace.ts"
import type { ClassifiedOutcome } from "./coding-outcomes.ts"

const correctOutcome: ClassifiedOutcome = { outcome: "correct", reason: "hiddenTestsPassed" }

const accounting = (overrides: Partial<TraceAccounting> = {}): TraceAccounting => ({
	requests: [],
	requestCount: 0,
	requestsMissingUsage: 0,
	apiReqRetriedMarkers: 0,
	usage: { available: false, snapshotsObserved: 0 },
	toolSnapshot: {},
	toolFailureEvents: 0,
	toolFailuresByTool: {},
	completeness: { status: "complete", reasons: [] },
	...overrides,
})

const trace = (overrides: Partial<AgentTrace> = {}): AgentTrace => ({
	traceSchemaVersion: TRACE_SCHEMA_VERSION,
	kind: TRACE_KIND,
	run: {
		runId: "run-1",
		fixture: { name: "clamp-range", version: "1.0.0" },
		startedAt: "2026-10-22T00:00:00.000Z",
		finishedAt: "2026-10-22T00:01:00.000Z",
		durationMs: 60_000,
		identity: identityUnavailable(),
	},
	settings: { available: true },
	execution: {
		code: "COMPLETED",
		stopReason: "taskCompleted",
		activated: true,
		taskAccepted: true,
		sessionLost: false,
		completionMessageSeen: true,
		timings: { totalMs: 60_000 },
	},
	eventFlow: {
		observed: 0,
		malformed: 0,
		foreignTaskEvents: 0,
		bufferedBeforeAck: 0,
		replayedAfterAck: 0,
		eventBufferLimit: 256,
		bufferOverflow: false,
		droppedByOverflow: 0,
	},
	accounting: accounting(),
	teardown: {
		status: "ok",
		hostExited: true,
		closeTaskSent: true,
		escalatedSignals: [],
		cleanup: "done",
		failures: [],
	},
	notes: [],
	...overrides,
})

const fullUsage = {
	tokensIn: 1_000_000,
	tokensOut: 100_000,
	cacheWrites: { available: true, value: 200_000 } as const,
	cacheReads: { available: true, value: 400_000 } as const,
	cost: 0.42,
	contextTokens: 50_000,
	source: "taskCompleted" as const,
	observedAtMs: 1,
}

const testTable: PriceTable = {
	id: "test-price-table",
	date: "2026-01-01",
	currency: "USD",
	cachePricing: "test rates",
	models: {
		"qwen3.8-27b": {
			inputPerMillion: 0.5,
			outputPerMillion: 1.5,
			cacheReadPerMillion: 0.125,
			cacheWritePerMillion: 0.625,
		},
	},
}

describe("run metrics", () => {
	it("keeps missing token values missing and never writes zero", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace(),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
		})
		assert.equal(metrics.usage.tokensIn, undefined)
		assert.equal(metrics.cost.estimated.available, false)
		if (!metrics.cost.estimated.available) assert.equal(metrics.cost.estimated.reason, "noUsageEventsObserved")
		assert.equal(metrics.cost.accountingComplete, false)
	})

	it("estimates cost from reported usage with an explicitly configured price table", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({ usage: { available: true, snapshotsObserved: 1, lastSnapshot: fullUsage } }),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
			priceTable: testTable,
		})
		assert.equal(metrics.cost.estimated.available, true)
		if (metrics.cost.estimated.available) {
			// 1.0 * 0.5 + 0.1 * 1.5 + 0.4 * 0.125 + 0.2 * 0.625 = 0.825
			assert.ok(Math.abs(metrics.cost.estimated.usd - 0.825) < 1e-9)
			assert.equal(metrics.cost.estimated.priceTableId, "test-price-table")
			assert.ok(metrics.cost.estimated.cachePricing.length > 0)
		}
		assert.deepEqual(metrics.cost.providerReported, { available: true, value: 0.42 })
		assert.equal(metrics.cost.accountingComplete, true)
		assert.equal(metrics.usage.cacheReads, 400_000)
		assert.equal(metrics.usage.contextTokensEstimate, 50_000)
		assert.equal(metrics.usage.labels.context, "extensionContextEstimate")
	})

	it("keeps cost unavailable while the shipped table has no rates", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({ usage: { available: true, snapshotsObserved: 1, lastSnapshot: fullUsage } }),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
		})
		assert.equal(metrics.cost.estimated.available, false)
		if (!metrics.cost.estimated.available) assert.equal(metrics.cost.estimated.reason, "modelMissingFromPriceTable")
		assert.equal(metrics.cost.accountingComplete, false)
	})

	it("marks accounting incomplete when a cache count is missing", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({
					usage: {
						available: true,
						snapshotsObserved: 1,
						lastSnapshot: { ...fullUsage, cacheWrites: { available: false, reason: "notReported" } },
					},
				}),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
			priceTable: testTable,
		})
		assert.equal(metrics.cost.estimated.available, false)
		if (!metrics.cost.estimated.available) assert.equal(metrics.cost.estimated.reason, "cacheWritesNotReported")
		assert.equal(metrics.cost.accountingComplete, false)
	})

	it("marks accounting incomplete when trace completeness is partial even with a configured price table", () => {
		// Usage is fully reported and the table prices the model, but some
		// requests lack usage, so the trace accounting is partial. The cost
		// estimate exists; the accounting is still incomplete.
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({
					requestCount: 2,
					requestsMissingUsage: 1,
					usage: { available: true, snapshotsObserved: 1, lastSnapshot: fullUsage },
					completeness: { status: "partial", reasons: ["usageMissingForSomeRequests"] },
				}),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
			priceTable: testTable,
		})
		assert.equal(metrics.cost.estimated.available, true)
		assert.equal(metrics.accounting.status, "partial")
		assert.equal(metrics.cost.accountingComplete, false)
	})

	it("reports a missing model identifier without an empty-string fallback", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({ usage: { available: true, snapshotsObserved: 1, lastSnapshot: fullUsage } }),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: false, reason: "modelIdMissingInProjection" },
			priceTable: testTable,
		})
		assert.equal(metrics.cost.estimated.available, false)
		if (!metrics.cost.estimated.available) assert.equal(metrics.cost.estimated.reason, "modelIdentifierMissing")
		assert.equal(metrics.cost.accountingComplete, false)
	})

	it("summarizes tool calls and failures from the tool snapshot", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({
					toolSnapshot: {
						snapshot: { read_file: { attempts: 4, failures: 1 }, apply_diff: { attempts: 2, failures: 0 } },
					},
					toolFailureEvents: 1,
					toolFailuresByTool: { read_file: 1 },
				}),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
		})
		assert.deepEqual(metrics.toolCalls.totalAttempts, { available: true, value: 6 })
		assert.equal(metrics.toolCalls.totalFailures, 1)
		assert.equal(metrics.toolCalls.failureEvents, 1)
		assert.equal(metrics.toolCalls.byTool["apply_diff"]?.attempts, 2)
	})

	it("reports unsupported telemetry as unavailable", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace(),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
		})
		assert.deepEqual(metrics.unavailableTelemetry, [
			{ name: "duplicateCallDetection", reason: "notInstrumented" },
			{ name: "httpRetryCount", reason: "apiReqRetriedMarkersCountsMessagesNotHttpRetries" },
		])
	})

	it("labels per-request prompt size rows", () => {
		const metrics = buildRunMetrics({
			fixtureName: "clamp-range",
			repIndex: 0,
			trace: trace({
				accounting: accounting({
					requestCount: 2,
					requests: [
						{
							index: 0,
							ts: 1,
							apiProtocol: { available: false, reason: "notReported" },
							tokensIn: { available: true, value: 1_234 },
							tokensOut: { available: false, reason: "notReported" },
							cacheWrites: { available: false, reason: "notReported" },
							cacheReads: { available: false, reason: "notReported" },
							cost: { available: false, reason: "notReported" },
							streamingFailed: false,
							firstObservedMs: 0,
							lastUpdatedMs: 1,
							messageCount: 1,
						},
					],
				}),
			}),
			outcome: correctOutcome,
			modelIdentifier: { available: true, value: "qwen3.8-27b" },
		})
		assert.deepEqual(metrics.requests.promptSize, [
			{
				index: 0,
				reportedInputTokens: { available: true, value: 1_234 },
				label: "providerReportedInputTokens",
			},
		])
	})
})

const metricsRun = (overrides: Partial<CodingRunMetrics> & { repIndex?: number }): CodingRunMetrics => ({
	fixtureName: "clamp-range",
	repIndex: overrides.repIndex ?? 0,
	outcome: correctOutcome,
	requests: { count: 0, promptSize: [], requestsMissingUsage: 0 },
	usage: { labels: { context: "extensionContextEstimate" } },
	toolCalls: { byTool: {}, totalAttempts: { available: false, reason: "none" }, totalFailures: 0, failureEvents: 0 },
	cost: {
		estimated: { available: false, reason: "noUsageEventsObserved" },
		providerReported: { available: false, reason: "noUsageEventsObserved" },
		accountingComplete: false,
	},
	accounting: { status: "complete", reasons: [] },
	unavailableTelemetry: [],
	...overrides,
})

describe("cost per successful task", () => {
	const completeCost = (usd: number) => ({
		estimated: { available: true, usd, priceTableId: "t", priceTableDate: "d", cachePricing: "c" } as const,
		providerReported: { available: false, reason: "none" } as const,
		accountingComplete: true,
	})

	it("divides the total attempt cost by the correct run count", () => {
		const runs: CodingRunMetrics[] = [
			metricsRun({ repIndex: 0, cost: completeCost(0.5) }),
			metricsRun({
				repIndex: 1,
				outcome: { outcome: "incorrect", reason: "hiddenTestsFailed" },
				cost: completeCost(0.3),
			}),
			metricsRun({ repIndex: 2, cost: completeCost(0.4) }),
		]
		const result = costPerSuccessfulTask(runs)
		assert.equal(result.available, true)
		assert.ok(Math.abs((result.usd ?? 0) - 0.6) < 1e-9)
		assert.equal(result.correctRuns, 2)
		assert.equal(result.includedRuns, 3)
		assert.equal(result.excludedRuns, 0)
	})

	it("is unavailable with no correct runs", () => {
		const result = costPerSuccessfulTask([
			metricsRun({ outcome: { outcome: "incorrect", reason: "x" }, cost: completeCost(1) }),
		])
		assert.equal(result.available, false)
		assert.equal(result.reason, "noCorrectRuns")
	})

	it("is unavailable when a correct run lacks complete cost and flags the exclusion", () => {
		const result = costPerSuccessfulTask([
			metricsRun({ repIndex: 0, cost: completeCost(1) }),
			metricsRun({ repIndex: 1 }),
		])
		assert.equal(result.available, false)
		assert.equal(result.reason, "correctRunCostIncomplete")
		assert.equal(result.excludedRuns, 1)
		assert.equal(result.policy, "excludeIncompleteFromAggregates-v1")
	})

	it("is unavailable when a failed attempt lacks complete cost accounting", () => {
		// One success, one known-cost failure, one unknown-cost failure. The
		// unknown attempt cost makes the total spend per success unknowable.
		const result = costPerSuccessfulTask([
			metricsRun({ repIndex: 0, cost: completeCost(0.5) }),
			metricsRun({
				repIndex: 1,
				outcome: { outcome: "incorrect", reason: "hiddenTestsFailed" },
				cost: completeCost(0.3),
			}),
			metricsRun({ repIndex: 2, outcome: { outcome: "incorrect", reason: "hiddenTestsFailed" } }),
		])
		assert.equal(result.available, false)
		assert.equal(result.reason, "failedAttemptCostIncomplete")
		assert.equal(result.correctRuns, 1)
		assert.equal(result.excludedRuns, 1)
	})
})
