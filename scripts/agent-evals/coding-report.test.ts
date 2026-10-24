import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { buildComparisonReport, renderMarkdownReport, type SideResult } from "./coding-report.ts"
import {
	invalidateSideArtifacts,
	publishComparisonReport,
	publishedComparisonGeneration,
	readPublishedComparisonReport,
	runComparison,
	validateSideResultFile,
	type SideExecutor,
} from "./coding-compare.ts"
import { writeFileAtomic, writeJsonAtomic } from "./fs-atomic.ts"
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
	const validatedFile = (side: "baseline" | "candidate", commit: string, overrides: Record<string, unknown> = {}) =>
		JSON.parse(JSON.stringify({ pins: pins(side, commit), runs: [], ...overrides }))

	it("accepts a result that records exactly the expected side and commit", () => {
		const validated = validateSideResultFile(validatedFile("baseline", "a".repeat(40)), "baseline", "a".repeat(40))
		assert.equal(validated.pins.side, "baseline")
		assert.equal(validated.pins.commit, "a".repeat(40))
	})

	it("accepts a well-formed run with object metrics and keeps it", () => {
		const run = { fixtureName: "clamp-range", repIndex: 0, metrics: metrics("clamp-range", 0, "correct", 0.1) }
		const validated = validateSideResultFile(
			validatedFile("baseline", "a".repeat(40), { runs: [run] }),
			"baseline",
			"a".repeat(40),
		)
		assert.equal(validated.runs.length, 1)
		assert.deepEqual(validated.runs[0], run)
	})

	it("rejects a result that records the wrong side or a different commit", () => {
		assert.throws(
			() => validateSideResultFile(validatedFile("candidate", "a".repeat(40)), "baseline", "a".repeat(40)),
			/records side candidate instead of baseline/,
		)
		assert.throws(
			() => validateSideResultFile(validatedFile("baseline", "b".repeat(40)), "baseline", "a".repeat(40)),
			/records commit .* instead of/,
		)
	})

	it("rejects incomplete pins with the intended error", () => {
		for (const field of [
			"side",
			"commit",
			"suiteId",
			"suiteDigest",
			"settingsDigest",
			"modelIdentifier",
			"graderVersion",
			"graderImageDigest",
		]) {
			const file = validatedFile("baseline", "a".repeat(40))
			delete (file.pins as Record<string, unknown>)[field]
			assert.throws(
				() => validateSideResultFile(file, "baseline", "a".repeat(40)),
				new RegExp(`pins lack ${field}`),
			)
		}
		assert.throws(
			() =>
				validateSideResultFile(
					validatedFile("baseline", "a".repeat(40), { pins: { side: "baseline" } }),
					"baseline",
					"a".repeat(40),
				),
			/pins lack commit/,
		)
	})

	it("rejects incomplete runnerEnvironment pins", () => {
		const file = validatedFile("baseline", "a".repeat(40))
		delete (file.pins as Record<string, unknown>)["runnerEnvironment"]
		assert.throws(() => validateSideResultFile(file, "baseline", "a".repeat(40)), /pins lack runnerEnvironment/)
		const partial = validatedFile("baseline", "a".repeat(40))
		;(partial.pins as Record<string, unknown>)["runnerEnvironment"] = { os: "linux", nodeVersion: "v22" }
		assert.throws(
			() => validateSideResultFile(partial, "baseline", "a".repeat(40)),
			/runnerEnvironment lacks vscodeTarget/,
		)
	})

	it("rejects runs without object metrics", () => {
		assert.throws(
			() =>
				validateSideResultFile(
					validatedFile("baseline", "a".repeat(40), { runs: [{ fixtureName: "clamp-range", repIndex: 0 }] }),
					"baseline",
					"a".repeat(40),
				),
			/run lacks metrics/,
		)
		assert.throws(
			() =>
				validateSideResultFile(
					validatedFile("baseline", "a".repeat(40), { runs: ["nope"] }),
					"baseline",
					"a".repeat(40),
				),
			/run is not an object/,
		)
	})

	it("rejects missing shape with the intended error", () => {
		assert.throws(() => validateSideResultFile({ runs: [] }, "baseline", "a".repeat(40)), /has no pins/)
		assert.throws(() => validateSideResultFile(null, "baseline", "a".repeat(40)), /not a JSON object/)
		assert.throws(
			() => validateSideResultFile({ pins: pins("baseline", "a".repeat(40)) }, "baseline", "a".repeat(40)),
			/has no runs array/,
		)
	})
})

describe("comparison report publication", () => {
	const report = buildComparisonReport({
		baseline: sideResult("baseline", "a".repeat(40), [metrics("clamp-range", 0, "correct", 0.1)]),
		candidate: sideResult("candidate", "b".repeat(40), [metrics("clamp-range", 0, "correct", 0.2)]),
	})

	it("publishes the pair with a matching completion marker", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-publish-test-"))
		try {
			await publishComparisonReport(dir, report)
			const generation = await publishedComparisonGeneration(dir)
			assert.equal(generation, report.generatedAt)
			const json = JSON.parse(await fs.readFile(path.join(dir, "comparison-report.json"), "utf8")) as {
				generation?: string
			}
			assert.equal(json.generation, report.generatedAt)
			const markdown = await fs.readFile(path.join(dir, "comparison-report.md"), "utf8")
			assert.ok(markdown.includes(report.generatedAt))
			// The publication leaves no temp residue.
			assert.deepEqual((await fs.readdir(dir)).sort(), [
				"comparison-report.complete",
				"comparison-report.json",
				"comparison-report.md",
			])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("replaces a prior report set and updates the marker to the new generation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-publish-test-"))
		try {
			// An existing prior report set.
			await writeFileAtomic(path.join(dir, "comparison-report.json"), "old")
			await writeFileAtomic(path.join(dir, "comparison-report.md"), "old md")
			await writeFileAtomic(path.join(dir, "comparison-report.complete"), "2020-01-01T00:00:00.000Z\n")
			assert.equal(await publishedComparisonGeneration(dir), "2020-01-01T00:00:00.000Z")
			await publishComparisonReport(dir, report)
			assert.equal(await publishedComparisonGeneration(dir), report.generatedAt)
			const markdown = await fs.readFile(path.join(dir, "comparison-report.md"), "utf8")
			assert.ok(markdown.includes(report.generatedAt))
			assert.ok(!markdown.includes("old md"))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rolls the pair back when the Markdown publication fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-publish-test-"))
		try {
			// The Markdown target is a non-empty directory, so its atomic write
			// fails after the JSON publication.
			const markdownPath = path.join(dir, "comparison-report.md")
			await fs.mkdir(markdownPath)
			await fs.writeFile(path.join(markdownPath, "occupied"), "x")
			await assert.rejects(publishComparisonReport(dir, report))
			// The JSON and marker are rolled back. No mixed generation and no
			// temp residue remains.
			assert.equal(await publishedComparisonGeneration(dir), undefined)
			assert.equal(
				await fs.access(path.join(dir, "comparison-report.json")).then(
					() => true,
					() => false,
				),
				false,
			)
			assert.deepEqual(await fs.readdir(dir), ["comparison-report.md"])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("treats a crash between publications as an incomplete generation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-publish-test-"))
		try {
			// Both files exist, but the process died before the marker.
			await writeFileAtomic(path.join(dir, "comparison-report.json"), "partial")
			await writeFileAtomic(path.join(dir, "comparison-report.md"), "partial md")
			assert.equal(await publishedComparisonGeneration(dir), undefined)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("comparison report consumption", () => {
	const report = buildComparisonReport({
		baseline: sideResult("baseline", "a".repeat(40), [metrics("clamp-range", 0, "correct", 0.1)]),
		candidate: sideResult("candidate", "b".repeat(40), [metrics("clamp-range", 0, "correct", 0.2)]),
	})

	it("reads back the report only when the marker matches both files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-consume-test-"))
		try {
			await publishComparisonReport(dir, report)
			const read = await readPublishedComparisonReport(dir)
			assert.ok(read !== undefined)
			assert.equal(read.generatedAt, report.generatedAt)
			assert.equal(read.compatibility.compatible, report.compatibility.compatible)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("reports no publication when the marker is absent", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-consume-test-"))
		try {
			// Both report files exist, but the process died before the marker.
			await writeFileAtomic(path.join(dir, "comparison-report.json"), "{}")
			await writeFileAtomic(path.join(dir, "comparison-report.md"), "partial md")
			assert.equal(await readPublishedComparisonReport(dir), undefined)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses a report whose generation differs from the marker", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-consume-test-"))
		try {
			await publishComparisonReport(dir, report)
			await writeFileAtomic(
				path.join(dir, "comparison-report.json"),
				JSON.stringify({ ...report, generation: "2020-01-01T00:00:00.000Z" }),
			)
			await assert.rejects(readPublishedComparisonReport(dir), /does not match the completion marker/)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses a Markdown render that differs from the marker", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-consume-test-"))
		try {
			await publishComparisonReport(dir, report)
			await writeFileAtomic(path.join(dir, "comparison-report.md"), "stale render without the stamp")
			await assert.rejects(readPublishedComparisonReport(dir), /does not match the completion marker/)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses a pair that lost its Markdown file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "report-consume-test-"))
		try {
			await publishComparisonReport(dir, report)
			await fs.rm(path.join(dir, "comparison-report.md"))
			await assert.rejects(readPublishedComparisonReport(dir))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("side artifact invalidation", () => {
	it("removes stale side results and run records before a rerun", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-invalidate-test-"))
		try {
			await writeJsonAtomic(path.join(dir, "side-results.json"), { stale: true })
			const staleRecordDir = path.join(dir, "artifacts", "clamp-range-rep4")
			await fs.mkdir(staleRecordDir, { recursive: true })
			await writeJsonAtomic(path.join(staleRecordDir, "run-record.json"), { stale: true })
			await invalidateSideArtifacts(dir)
			assert.deepEqual(await fs.readdir(dir), [])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("fails closed when the stale side result cannot be removed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-invalidate-test-"))
		try {
			// The stale result path is a non-empty directory, so the removal
			// fails and the side must abort before any run executes.
			const stalePath = path.join(dir, "side-results.json")
			await fs.mkdir(stalePath)
			await fs.writeFile(path.join(stalePath, "occupied"), "x")
			await assert.rejects(invalidateSideArtifacts(dir))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
