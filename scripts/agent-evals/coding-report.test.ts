import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildComparisonReport, renderMarkdownReport, type SideResult } from "./coding-report.ts"
import { runComparison, validateSideResultFile, type SideExecutor } from "./coding-compare.ts"
import type { CodingRunMetrics } from "./coding-metrics.ts"
import type { SidePins } from "./coding-pins.ts"

const pins = (side: "baseline" | "candidate", commit: string, overrides: Partial<SidePins> = {}): SidePins => ({
	side,
	commit,
	suiteId: "coding-basic-v1",
	suiteDigest: "d1".repeat(32),
	settingsDigest: "d2".repeat(32),
	modelIdentifier: "qwen3.8-27b",
	graderVersion: "coding-grader-v2",
	graderImageDigest: `node:22-bookworm@sha256:${"e".repeat(64)}`,
	runnerEnvironment: { os: "linux", nodeVersion: "v22.23.1", vscodeTarget: "1.104.0" },
	...overrides,
})

const completeCost = (usd: number): CodingRunMetrics["cost"] => ({
	estimated: { available: true, usd, priceTableId: "t", priceTableDate: "d", cachePricing: "c" },
	providerReported: { available: false, reason: "none" },
	accountingComplete: true,
})

const metrics = (
	fixtureName: string,
	repIndex: number,
	outcome: CodingRunMetrics["outcome"]["outcome"],
	usd: number | undefined,
): CodingRunMetrics => ({
	fixtureName,
	repIndex,
	outcome: { outcome, reason: outcome },
	durationMs: 1_000 + repIndex,
	executionCode: "COMPLETED",
	stopReason: "taskCompleted",
	requests: { count: 0, promptSize: [], requestsMissingUsage: 0 },
	usage: { labels: { context: "extensionContextEstimate" } },
	toolCalls: { byTool: {}, totalAttempts: { available: false, reason: "none" }, totalFailures: 0, failureEvents: 0 },
	cost:
		usd === undefined
			? {
					estimated: { available: false, reason: "tokensInNotReported" },
					providerReported: { available: false, reason: "none" },
					accountingComplete: false,
				}
			: completeCost(usd),
	accounting: { status: "complete", reasons: [] },
	unavailableTelemetry: [],
})

const sideResult = (
	side: "baseline" | "candidate",
	commit: string,
	runs: CodingRunMetrics[],
	overrides?: Partial<SidePins>,
): SideResult => ({
	pins: pins(side, commit, overrides),
	runs,
})

describe("comparison report", () => {
	it("builds a self-contained JSON report over all suite fixtures", () => {
		const baseline = sideResult("baseline", "a".repeat(40), [
			metrics("clamp-range", 0, "correct", 0.1),
			metrics("clamp-range", 1, "correct", 0.1),
			metrics("clamp-range", 2, "incorrect", 0.1),
		])
		const candidate = sideResult("candidate", "b".repeat(40), [
			metrics("clamp-range", 0, "correct", 0.05),
			metrics("clamp-range", 1, "timed-out", undefined),
			metrics("clamp-range", 2, "grading-failure", 0.05),
		])
		const report = buildComparisonReport({ baseline, candidate })
		assert.equal(report.reportVersion, 1)
		assert.equal(report.fixtures.length, 5)
		const row = report.fixtures.find((fixture) => fixture.fixtureName === "clamp-range")!
		assert.equal(row.baseline.successRate.successes, 2)
		assert.equal(row.candidate.successRate.successes, 1)
		assert.deepEqual([...row.candidate.outcomes].sort(), ["correct", "grading-failure", "timed-out"].sort())
		assert.equal(row.pairedOutcomes.pairs, 3)
		assert.ok(row.pairedDurations.pairs.length === 3)
		// Missing candidate cost on rep 1 is a missing pair, never zero.
		assert.equal(row.pairedCosts.missingPairs, 1)
		// The report serializes cleanly: a self-contained result.
		const parsed = JSON.parse(JSON.stringify(report)) as typeof report
		assert.equal(parsed.fixtures.length, report.fixtures.length)
	})

	it("flags incompatible pairs when pinned inputs differ", () => {
		const baseline = sideResult("baseline", "a".repeat(40), [])
		const candidate = sideResult("candidate", "b".repeat(40), [], { modelIdentifier: "other-model" })
		const report = buildComparisonReport({ baseline, candidate })
		assert.equal(report.compatibility.compatible, false)
		assert.deepEqual(report.compatibility.differences, ["modelIdentifier"])
	})

	it("keeps grading failures out of the incorrect count and is unavailable with unknown attempt costs", () => {
		const baseline = sideResult("baseline", "a".repeat(40), [
			metrics("clamp-range", 0, "correct", 0.2),
			metrics("clamp-range", 1, "grading-failure", undefined),
			metrics("clamp-range", 2, "infrastructure-failure", undefined),
		])
		const report = buildComparisonReport({ baseline, candidate: sideResult("candidate", "b".repeat(40), []) })
		const summary = report.costSummary.baseline
		assert.equal(summary.correctRuns, 1)
		assert.equal(summary.excludedRuns, 2)
		// The failed attempts have unknown costs, so the total spend per
		// success is unknowable instead of merely smaller.
		assert.equal(summary.available, false)
		assert.equal(summary.reason, "failedAttemptCostIncomplete")
		assert.equal(report.partialDataPolicy, "excludeIncompleteFromAggregates-v1")
	})

	it("renders the Markdown report with required sections and no significance claim", () => {
		const baseline = sideResult("baseline", "a".repeat(40), [metrics("clamp-range", 0, "correct", 0.2)])
		const candidate = sideResult("candidate", "b".repeat(40), [metrics("clamp-range", 0, "incorrect", 0.3)])
		const report = buildComparisonReport({ baseline, candidate })
		const markdown = renderMarkdownReport(report)
		assert.match(markdown, /# Coding eval comparison: coding-basic-v1/)
		assert.match(markdown, /## Pinned inputs and compatibility/)
		assert.match(markdown, /Baseline commit/)
		assert.match(markdown, /## Method/)
		assert.match(markdown, /cannot show small improvements/)
		assert.match(markdown, /## Results per fixture/)
		assert.match(markdown, /## Cost per successful task/)
		// Each deterministic cost line is asserted on its own. An alternation
		// would pass when only one line matched.
		assert.ok(
			markdown.includes("- Baseline: $0.2000 over 1 correct run(s), 0 excluded"),
			`baseline cost line missing:\n${markdown}`,
		)
		assert.ok(
			markdown.includes("- Candidate: unavailable (noCorrectRuns; 0 excluded)"),
			`candidate cost line missing:\n${markdown}`,
		)
		assert.match(markdown, /## Per-run appendix/)
		assert.match(markdown, /baseline \| clamp-range \| 0 \| correct /)
	})

	it("marks an incompatible pair in the Markdown report", () => {
		const baseline = sideResult("baseline", "a".repeat(40), [])
		const candidate = sideResult("candidate", "b".repeat(40), [], { graderVersion: "coding-grader-v9" })
		const markdown = renderMarkdownReport(buildComparisonReport({ baseline, candidate }))
		assert.match(markdown, /Incompatible pair/)
		assert.match(markdown, /graderVersion/)
	})
})

describe("comparison orchestration", () => {
	it("runs both sides with the same repetition count and merges results", async () => {
		const requests: { side: string; repetitions: number }[] = []
		const executor: SideExecutor = {
			runSide: async (request) => {
				requests.push({ side: request.side, repetitions: request.repetitions })
				return request.side === "baseline"
					? sideResult("baseline", "a".repeat(40), [metrics("clamp-range", 0, "correct", 0.1)])
					: sideResult("candidate", "b".repeat(40), [metrics("clamp-range", 0, "correct", 0.2)])
			},
		}
		const report = await runComparison({
			baselineCommit: "a".repeat(40),
			candidateCommit: "b".repeat(40),
			repetitions: 2,
			executor,
		})
		assert.deepEqual(requests, [
			{ side: "baseline", repetitions: 2 },
			{ side: "candidate", repetitions: 2 },
		])
		assert.equal(report.compatibility.compatible, true)
		assert.equal(report.repetitions, 2)
		assert.equal(report.runs.filter((run) => run.side === "baseline").length, 1)
		assert.equal(report.runs.filter((run) => run.side === "candidate").length, 1)
	})

	it("defaults to three repetitions", async () => {
		const executor: SideExecutor = {
			runSide: async (request) => {
				assert.equal(request.repetitions, 3)
				return sideResult(request.side, "c".repeat(40), [])
			},
		}
		const report = await runComparison({
			baselineCommit: "a".repeat(40),
			candidateCommit: "b".repeat(40),
			executor,
		})
		assert.equal(report.repetitions, 3)
	})
})

describe("side result validation", () => {
	it("accepts a result that records exactly the approved commit", () => {
		const file = { pins: pins("baseline", "a".repeat(40)), runs: [] }
		const validated = validateSideResultFile(JSON.parse(JSON.stringify(file)), "a".repeat(40))
		assert.equal(validated.pins.side, "baseline")
	})

	it("rejects a result that records a different commit, or has no shape", () => {
		assert.throws(() =>
			validateSideResultFile({ pins: pins("baseline", "b".repeat(40)), runs: [] }, "a".repeat(40)),
		)
		assert.throws(() => validateSideResultFile({ runs: [] }, "a".repeat(40)))
		assert.throws(() => validateSideResultFile(null, "a".repeat(40)))
		assert.throws(() => validateSideResultFile({ pins: pins("baseline", "a".repeat(40)) }, "a".repeat(40)))
	})
})
