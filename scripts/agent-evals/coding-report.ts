import type { CodingRunOutcome } from "./coding-outcomes.ts"
import type { CodingRunMetrics, CostPerSuccessfulTask, PARTIAL_DATA_POLICY } from "./coding-metrics.ts"
import { costPerSuccessfulTask } from "./coding-metrics.ts"
import type { SidePins, PinComparison } from "./coding-pins.ts"
import { comparePins } from "./coding-pins.ts"
import {
	STATISTICAL_POLICY,
	successRate,
	pairedOutcomeDiffs,
	pairedNumericDiffs,
	type SuccessRate,
	type PairedOutcomeDiff,
	type PairedNumericDiff,
} from "./coding-stats.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { initialStateDigest } from "./coding-workspace.ts"
import { CODING_SUITE_ID } from "./coding-suite.ts"

export interface SideResult {
	pins: SidePins
	runs: CodingRunMetrics[]
}

export interface FixtureComparisonRow {
	fixtureName: string
	fixtureVersion: string
	initialStateDigest: string
	baseline: SideFixtureStats
	candidate: SideFixtureStats
	pairedOutcomes: PairedOutcomeDiff
	pairedDurations: PairedNumericDiff
	pairedCosts: PairedNumericDiff
}

export interface SideFixtureStats {
	outcomes: CodingRunOutcome[]
	successRate: SuccessRate
}

export interface ComparisonReport {
	reportVersion: 1
	generatedAt: string
	suiteId: string
	repetitions: number
	statisticalPolicy: typeof STATISTICAL_POLICY
	partialDataPolicy: typeof PARTIAL_DATA_POLICY
	pins: { baseline: SidePins; candidate: SidePins }
	compatibility: PinComparison
	fixtures: FixtureComparisonRow[]
	costSummary: { baseline: CostPerSuccessfulTask; candidate: CostPerSuccessfulTask }
	runs: (CodingRunMetrics & { side: "baseline" | "candidate" })[]
}

export interface ComparisonInputs {
	baseline: SideResult
	candidate: SideResult
	repetitions?: number
}

const byRepIndex = (a: CodingRunMetrics, b: CodingRunMetrics) => a.repIndex - b.repIndex

export function buildComparisonReport(inputs: ComparisonInputs): ComparisonReport {
	const repetitions = inputs.repetitions ?? STATISTICAL_POLICY.repetitionsDefault
	const compatibility = comparePins(inputs.baseline.pins, inputs.candidate.pins)
	const rows: FixtureComparisonRow[] = []
	for (const bundle of CODING_FIXTURE_BUNDLES) {
		const name = bundle.fixture.identity.name
		const baselineRuns = inputs.baseline.runs.filter((run) => run.fixtureName === name).sort(byRepIndex)
		const candidateRuns = inputs.candidate.runs.filter((run) => run.fixtureName === name).sort(byRepIndex)
		rows.push({
			fixtureName: name,
			fixtureVersion: bundle.fixture.identity.version,
			initialStateDigest: initialStateDigest(bundle.fixture),
			baseline: {
				outcomes: baselineRuns.map((run) => run.outcome.outcome),
				successRate: successRate(baselineRuns.map((run) => run.outcome.outcome)),
			},
			candidate: {
				outcomes: candidateRuns.map((run) => run.outcome.outcome),
				successRate: successRate(candidateRuns.map((run) => run.outcome.outcome)),
			},
			pairedOutcomes: pairedOutcomeDiffs(
				baselineRuns.map((run) => run.outcome.outcome),
				candidateRuns.map((run) => run.outcome.outcome),
			),
			pairedDurations: pairedNumericDiffs(
				baselineRuns.map((run) => run.durationMs),
				candidateRuns.map((run) => run.durationMs),
			),
			pairedCosts: pairedNumericDiffs(
				baselineRuns.map((run) => (run.cost.estimated.available ? run.cost.estimated.usd : undefined)),
				candidateRuns.map((run) => (run.cost.estimated.available ? run.cost.estimated.usd : undefined)),
			),
		})
	}
	return {
		reportVersion: 1,
		generatedAt: new Date().toISOString(),
		suiteId: CODING_SUITE_ID,
		repetitions,
		statisticalPolicy: STATISTICAL_POLICY,
		partialDataPolicy: costPerSuccessfulTask([]).policy,
		pins: { baseline: inputs.baseline.pins, candidate: inputs.candidate.pins },
		compatibility,
		fixtures: rows,
		costSummary: {
			baseline: costPerSuccessfulTask(inputs.baseline.runs),
			candidate: costPerSuccessfulTask(inputs.candidate.runs),
		},
		runs: [
			...inputs.baseline.runs.map((run) => ({ ...run, side: "baseline" as const })),
			...inputs.candidate.runs.map((run) => ({ ...run, side: "candidate" as const })),
		],
	}
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`

const rateCell = (stats: SideFixtureStats): string => {
	const rate = stats.successRate
	const counts = stats.outcomes.reduce<Record<string, number>>((acc, outcome) => {
		acc[outcome] = (acc[outcome] ?? 0) + 1
		return acc
	}, {})
	const breakdown = [
		`correct ${counts["correct"] ?? 0}`,
		`incorrect ${counts["incorrect"] ?? 0}`,
		`timed-out ${counts["timed-out"] ?? 0}`,
		`grading-failure ${counts["grading-failure"] ?? 0}`,
		`infrastructure-failure ${counts["infrastructure-failure"] ?? 0}`,
	].join(", ")
	const interval = rate.interval ? ` [${percent(rate.interval.lower)}, ${percent(rate.interval.upper)}]` : ""
	return `${rate.successes}/${rate.total}${interval} (${breakdown})`
}

const costCell = (cost: CostPerSuccessfulTask): string =>
	cost.available
		? `$${cost.usd?.toFixed(4)} over ${cost.correctRuns} correct run(s), ${cost.excludedRuns} excluded`
		: `unavailable (${cost.reason ?? "unavailable"}; ${cost.excludedRuns} excluded)`

// Self-contained Markdown rendering of the JSON report.
export function renderMarkdownReport(report: ComparisonReport): string {
	const lines: string[] = []
	lines.push(`# Coding eval comparison: ${report.suiteId}`)
	lines.push("")
	lines.push(`Generated: ${report.generatedAt}`)
	lines.push("")
	lines.push("## Pinned inputs and compatibility")
	lines.push("")
	lines.push(`- Baseline commit: \`${report.pins.baseline.commit}\``)
	lines.push(`- Candidate commit: \`${report.pins.candidate.commit}\``)
	lines.push(`- Suite: ${report.pins.baseline.suiteId} / ${report.pins.candidate.suiteId}`)
	lines.push(`- Suite digest: \`${report.pins.baseline.suiteDigest}\` / \`${report.pins.candidate.suiteDigest}\``)
	lines.push(
		`- Settings digest: \`${report.pins.baseline.settingsDigest}\` / \`${report.pins.candidate.settingsDigest}\``,
	)
	lines.push(`- Model: ${report.pins.baseline.modelIdentifier} / ${report.pins.candidate.modelIdentifier}`)
	lines.push(`- Grader version: ${report.pins.baseline.graderVersion} / ${report.pins.candidate.graderVersion}`)
	lines.push(
		`- Runner environment: ${report.pins.baseline.runnerEnvironment.os}, node ${report.pins.baseline.runnerEnvironment.nodeVersion}, vscode ${report.pins.baseline.runnerEnvironment.vscodeTarget} / ${report.pins.candidate.runnerEnvironment.os}, node ${report.pins.candidate.runnerEnvironment.nodeVersion}, vscode ${report.pins.candidate.runnerEnvironment.vscodeTarget}`,
	)
	lines.push("")
	if (report.compatibility.compatible) lines.push("**Compatible pair.** All pinned inputs match.")
	else
		lines.push(
			`**Incompatible pair.** Differing pinned inputs: ${report.compatibility.differences.join(", ")}. Treat the comparison as invalid.`,
		)
	lines.push("")
	lines.push("## Method")
	lines.push("")
	lines.push(
		`- ${report.repetitions} repetitions per fixture per commit (default ${STATISTICAL_POLICY.repetitionsDefault}).`,
	)
	lines.push(`- ${report.statisticalPolicy.method}.`)
	lines.push(`- ${report.statisticalPolicy.significanceClaim}`)
	lines.push(
		`- Partial-data policy: ${report.partialDataPolicy}. Runs with incomplete cost accounting are flagged and excluded from cost aggregates.`,
	)
	lines.push("")
	lines.push("## Results per fixture")
	lines.push("")
	lines.push("| Fixture | Baseline | Candidate | Paired (improved/regressed/unchanged) |")
	lines.push("| --- | --- | --- | --- |")
	for (const row of report.fixtures)
		lines.push(
			`| ${row.fixtureName} | ${rateCell(row.baseline)} | ${rateCell(row.candidate)} | ${row.pairedOutcomes.improved}/${row.pairedOutcomes.regressed}/${row.pairedOutcomes.unchanged} |`,
		)
	lines.push("")
	lines.push("## Cost per successful task")
	lines.push("")
	lines.push(`- Baseline: ${costCell(report.costSummary.baseline)}`)
	lines.push(`- Candidate: ${costCell(report.costSummary.candidate)}`)
	lines.push(`- Price table: recorded per run with identifier and date; cache reads and writes priced separately.`)
	lines.push("")
	lines.push("## Unavailable telemetry")
	lines.push("")
	lines.push(
		"Duplicate-call detection and HTTP retry counts are unsupported and reported as unavailable. They are never inferred from unrelated events.",
	)
	lines.push("")
	lines.push("## Per-run appendix")
	lines.push("")
	lines.push("| Side | Fixture | Rep | Outcome | Reason | Duration ms |")
	lines.push("| --- | --- | --- | --- | --- | --- |")
	for (const run of report.runs)
		lines.push(
			`| ${run.side} | ${run.fixtureName} | ${run.repIndex} | ${run.outcome.outcome} | ${run.outcome.reason} | ${run.durationMs ?? "unavailable"} |`,
		)
	lines.push("")
	return lines.join("\n")
}
