import type { AgentTrace, Measured } from "./trace.ts"
import type { GraderVerdict } from "./coding-grader.ts"
import type { ClassifiedOutcome } from "./coding-outcomes.ts"
import { estimateRunCost, type EstimatedCost, type PriceTable } from "./coding-pricing.ts"

export const PARTIAL_DATA_POLICY = "excludeIncompleteFromAggregates-v1"

export interface PromptSizeRow {
	index: number
	// Provider-reported input tokens for the request.
	reportedInputTokens: Measured<number>
	label: "providerReportedInputTokens"
}

export interface ToolCallSummary {
	byTool: Record<string, { attempts: number; failures: number }>
	totalAttempts: Measured<number>
	totalFailures: number
	failureEvents: number
}

export interface RunCostMetric {
	estimated: EstimatedCost
	// Provider-reported cumulative cost from extension events. Independent of
	// the estimate and never used as a fallback estimate.
	providerReported: Measured<number>
	accountingComplete: boolean
}

export interface CodingRunMetrics {
	fixtureName: string
	repIndex: number
	outcome: ClassifiedOutcome
	executionCode?: string
	stopReason?: string
	durationMs?: number
	requests: { count: number; promptSize: PromptSizeRow[]; requestsMissingUsage: number }
	usage: {
		tokensIn?: number
		tokensOut?: number
		cacheReads?: number
		cacheWrites?: number
		// Extension context estimate. Not a provider measurement.
		contextTokensEstimate?: number
		labels: { context: "extensionContextEstimate" }
	}
	toolCalls: ToolCallSummary
	cost: RunCostMetric
	accounting: { status: "complete" | "partial"; reasons: string[] }
	grading?: {
		kind: GraderVerdict["kind"]
		isolation?: string
		failedCount?: number
		failures?: { name: string; file: string }[]
	}
	unavailableTelemetry: { name: string; reason: string }[]
}

// Telemetry the substrate does not instrument. Reported as unavailable, never
// inferred from unrelated events.
export const UNSUPPORTED_TELEMETRY = [
	{ name: "duplicateCallDetection", reason: "notInstrumented" },
	{ name: "httpRetryCount", reason: "apiReqRetriedMarkersCountsMessagesNotHttpRetries" },
] as const

const measuredOrUndefined = <T>(value: Measured<T>): T | undefined => (value.available ? value.value : undefined)

export function buildRunMetrics(input: {
	fixtureName: string
	repIndex: number
	trace?: AgentTrace
	grading?: GraderVerdict
	outcome: ClassifiedOutcome
	modelIdentifier: Measured<string>
	priceTable?: PriceTable
}): CodingRunMetrics {
	const trace = input.trace
	const accounting = trace?.accounting
	const last = accounting?.usage.lastSnapshot
	// Usage completeness stays separate from price availability. The reasons
	// name the first missing input: no usage snapshot, then no model
	// identifier, then the price table decision.
	const estimated: EstimatedCost = !last
		? { available: false, reason: "noUsageEventsObserved" }
		: !input.modelIdentifier.available
			? { available: false, reason: "modelIdentifierMissing" }
			: estimateRunCost(
					input.modelIdentifier.value,
					{ available: true, value: last.tokensIn },
					{ available: true, value: last.tokensOut },
					last.cacheReads,
					last.cacheWrites,
					input.priceTable,
				)
	const snapshot = accounting?.toolSnapshot.snapshot
	const byTool: Record<string, { attempts: number; failures: number }> = {}
	let totalAttempts = 0
	let totalFailures = 0
	for (const [tool, counts] of Object.entries(snapshot ?? {})) {
		byTool[tool] = { attempts: counts.attempts, failures: counts.failures }
		totalAttempts += counts.attempts
		totalFailures += counts.failures
	}
	const cost: RunCostMetric = {
		estimated,
		providerReported: last
			? { available: true, value: last.cost }
			: { available: false, reason: "noUsageEventsObserved" },
		// Complete requires both: the trace accounted for every request, and
		// the price table could price the usage. Partial trace accounting with
		// a configured price stays incomplete.
		accountingComplete: estimated.available && accounting?.completeness.status === "complete",
	}
	return {
		fixtureName: input.fixtureName,
		repIndex: input.repIndex,
		outcome: input.outcome,
		executionCode: trace?.execution.code,
		stopReason: trace?.execution.stopReason,
		durationMs: trace?.run.durationMs,
		requests: {
			count: accounting?.requestCount ?? 0,
			promptSize: (accounting?.requests ?? []).map((row) => ({
				index: row.index,
				reportedInputTokens: row.tokensIn,
				label: "providerReportedInputTokens",
			})),
			requestsMissingUsage: accounting?.requestsMissingUsage ?? 0,
		},
		usage: {
			tokensIn: last?.tokensIn,
			tokensOut: last?.tokensOut,
			cacheReads: measuredOrUndefined(last?.cacheReads ?? { available: false, reason: "noUsageEventsObserved" }),
			cacheWrites: measuredOrUndefined(
				last?.cacheWrites ?? { available: false, reason: "noUsageEventsObserved" },
			),
			contextTokensEstimate: last?.contextTokens,
			labels: { context: "extensionContextEstimate" },
		},
		toolCalls: {
			byTool,
			totalAttempts: totalAttempts
				? { available: true, value: totalAttempts }
				: { available: false, reason: "noToolSnapshotObserved" },
			totalFailures,
			failureEvents: accounting?.toolFailureEvents ?? 0,
		},
		cost,
		accounting: {
			status: accounting?.completeness.status ?? "partial",
			reasons: accounting?.completeness.reasons ?? ["runTraceMissing"],
		},
		grading: input.grading
			? {
					kind: input.grading.kind,
					isolation: input.grading.isolation,
					failedCount:
						input.grading.kind === "passed" || input.grading.kind === "failed"
							? input.grading.result.failedCount
							: undefined,
					failures: input.grading.kind === "failed" ? input.grading.result.failures.slice(0, 10) : undefined,
				}
			: undefined,
		unavailableTelemetry: UNSUPPORTED_TELEMETRY.map((entry) => ({ ...entry })),
	}
}

export interface CostPerSuccessfulTask {
	policy: typeof PARTIAL_DATA_POLICY
	includedRuns: number
	excludedRuns: number
	correctRuns: number
	available: boolean
	reason?: string
	usd?: number
}

// Total estimated cost of all attempts, divided by the number of correct
// runs. The value is unavailable when any attempt lacks complete cost
// accounting, including failed attempts: an unknown attempt cost makes the
// total spend per success unknowable, not merely smaller. Usage completeness
// and price availability both feed accountingComplete.
export function costPerSuccessfulTask(runs: readonly CodingRunMetrics[]): CostPerSuccessfulTask {
	const included = runs.filter((run) => run.cost.accountingComplete)
	const excluded = runs.length - included.length
	const correctRuns = runs.filter((run) => run.outcome.outcome === "correct").length
	const base: Pick<CostPerSuccessfulTask, "policy" | "includedRuns" | "excludedRuns" | "correctRuns"> = {
		policy: PARTIAL_DATA_POLICY,
		includedRuns: included.length,
		excludedRuns: excluded,
		correctRuns,
	}
	if (correctRuns === 0) return { ...base, available: false, reason: "noCorrectRuns" }
	const correctIncomplete = runs.some((run) => run.outcome.outcome === "correct" && !run.cost.accountingComplete)
	if (correctIncomplete) return { ...base, available: false, reason: "correctRunCostIncomplete" }
	const failedIncomplete = runs.some((run) => run.outcome.outcome !== "correct" && !run.cost.accountingComplete)
	if (failedIncomplete) return { ...base, available: false, reason: "failedAttemptCostIncomplete" }
	const total = included.reduce((sum, run) => {
		if (run.cost.estimated.available) return sum + run.cost.estimated.usd
		return sum
	}, 0)
	return { ...base, available: true, usd: total / correctRuns }
}
