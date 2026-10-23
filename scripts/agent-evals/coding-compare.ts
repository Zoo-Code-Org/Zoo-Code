import type { SidePins } from "./coding-pins.ts"
import { buildComparisonReport, renderMarkdownReport, type ComparisonReport, type SideResult } from "./coding-report.ts"
import { DEFAULT_REPETITIONS } from "./coding-stats.ts"
import type { CodingRunRecord } from "./coding-run.ts"

export { buildComparisonReport, renderMarkdownReport }
export type { ComparisonReport, SideResult }

export interface SideExecutionRequest {
	side: "baseline" | "candidate"
	commit: string
	repetitions: number
}

// Executes one side of the comparison. The live executor runs the side's own
// in-repo suite inside a worktree of that commit. Tests replace it with a
// synthetic executor.
export interface SideExecutor {
	runSide(request: SideExecutionRequest): Promise<SideResult>
}

export interface ComparisonRequest {
	baselineCommit: string
	candidateCommit: string
	repetitions?: number
	executor: SideExecutor
}

// Paired comparison. Each side runs the same repetition count over its own
// frozen suite copy with pinned inputs. Pinned value differences surface in
// the report as an incompatible pair; they never abort the run, because the
// recorded values are the evidence a reviewer needs.
export async function runComparison(request: ComparisonRequest): Promise<ComparisonReport> {
	const repetitions = request.repetitions ?? DEFAULT_REPETITIONS
	const baseline = await request.executor.runSide({
		side: "baseline",
		commit: request.baselineCommit,
		repetitions,
	})
	const candidate = await request.executor.runSide({
		side: "candidate",
		commit: request.candidateCommit,
		repetitions,
	})
	return buildComparisonReport({ baseline, candidate, repetitions })
}

// Serializes a side result for artifact storage. Full run records travel so
// each side's traces and grading verdicts stay inspectable.
export interface SideResultFile {
	pins: SidePins
	runs: CodingRunRecord[]
}

// Validates one side result file before the report builder consumes it. The
// file is data, so its shape is checked, and it must record exactly the
// approved commit of its side. Anything else aborts the comparison instead of
// producing a report from partial output.
export function validateSideResultFile(parsed: unknown, expectedCommit: string): SideResultFile {
	if (typeof parsed !== "object" || parsed === null) throw new Error("side result is not a JSON object")
	const record = parsed as Record<string, unknown>
	const pins = record["pins"]
	if (typeof pins !== "object" || pins === null) throw new Error("side result has no pins")
	const pinsRecord = pins as Record<string, unknown>
	for (const field of ["side", "commit", "suiteId", "suiteDigest", "graderVersion"] as const) {
		if (typeof pinsRecord[field] !== "string" || (pinsRecord[field] as string).length === 0) {
			throw new Error(`side result pins lack ${field}`)
		}
	}
	if (pinsRecord["commit"] !== expectedCommit) {
		throw new Error(`side result records commit ${String(pinsRecord["commit"])} instead of ${expectedCommit}`)
	}
	if (!Array.isArray(record["runs"])) throw new Error("side result has no runs array")
	return parsed as SideResultFile
}

// Reduces a side result file to the shape the report builder consumes.
export const toSideResult = (file: SideResultFile): SideResult => ({
	pins: file.pins,
	runs: file.runs.map((record) => record.metrics),
})

export const sideResultFileName = (side: "baseline" | "candidate"): string => `${side}-results.json`
