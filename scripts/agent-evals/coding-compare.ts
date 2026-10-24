import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type { SidePins } from "./coding-pins.ts"
import { buildComparisonReport, renderMarkdownReport, type ComparisonReport, type SideResult } from "./coding-report.ts"
import { DEFAULT_REPETITIONS } from "./coding-stats.ts"
import type { CodingRunRecord } from "./coding-run.ts"
import { buildWorktreeEnvironment } from "./coding-trust.ts"
import type { SideProcessGuard } from "./side-process-guard.ts"
import { writeFileAtomic, writeJsonAtomic } from "./fs-atomic.ts"

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

const STDERR_LIMIT_BYTES = 1024 * 1024

// Runs one bounded preparation child in its own detached process group with
// the allowlisted environment, so the driver's secrets never reach it. The
// guard tracks the group from the synchronous spawn until the child settles,
// so a signal that reaches only the driver still stops install, build, and
// worktree children. An interrupt before the call refuses to spawn. A child
// past its wall clock is SIGKILLed as a group, exactly like an expired side.
export const runBoundedPreparation = async (
	guard: SideProcessGuard,
	isInterrupted: () => boolean,
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<void> => {
	if (isInterrupted()) throw new Error(`interrupted before ${command} started`)
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
			env: buildWorktreeEnvironment(process.env),
		})
		guard.track(child.pid)
		let stderr = ""
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length >= STDERR_LIMIT_BYTES) return
			stderr += chunk.toString()
		})
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL")
			} catch {
				child.kill("SIGKILL")
			}
		}, timeoutMs)
		child.once("error", (error) => {
			clearTimeout(timer)
			guard.track(undefined)
			reject(error)
		})
		child.once("exit", (code, signal) => {
			clearTimeout(timer)
			guard.track(undefined)
			if (code === 0) {
				resolve()
				return
			}
			const reason = timedOut ? "its time bound expired" : code === null ? `signal ${signal}` : `code ${code}`
			reject(new Error([`${command} failed: ${reason}`, stderr].filter(Boolean).join("\n")))
		})
	})
}

// Serializes a side result for artifact storage. Full run records travel so
// each side's traces and grading verdicts stay inspectable.
export interface SideResultFile {
	pins: SidePins
	runs: CodingRunRecord[]
}

// Validates one side result file before the report builder consumes it. The
// file is data, so its shape is checked, and it must record exactly the
// expected side label and the approved commit of that side. The pins must be
// complete, and every run must carry object metrics. Anything else aborts the
// comparison instead of producing a report from partial output.
const PIN_STRING_FIELDS = [
	"side",
	"commit",
	"suiteId",
	"suiteDigest",
	"settingsDigest",
	"modelIdentifier",
	"graderVersion",
	"graderImageDigest",
] as const

export function validateSideResultFile(
	parsed: unknown,
	expectedSide: SidePins["side"],
	expectedCommit: string,
): SideResultFile {
	if (typeof parsed !== "object" || parsed === null) throw new Error("side result is not a JSON object")
	const record = parsed as Record<string, unknown>
	const pins = record["pins"]
	if (typeof pins !== "object" || pins === null) throw new Error("side result has no pins")
	const pinsRecord = pins as Record<string, unknown>
	for (const field of PIN_STRING_FIELDS) {
		if (typeof pinsRecord[field] !== "string" || (pinsRecord[field] as string).length === 0) {
			throw new Error(`side result pins lack ${field}`)
		}
	}
	if (pinsRecord["side"] !== expectedSide) {
		throw new Error(`side result records side ${String(pinsRecord["side"])} instead of ${expectedSide}`)
	}
	if (pinsRecord["commit"] !== expectedCommit) {
		throw new Error(`side result records commit ${String(pinsRecord["commit"])} instead of ${expectedCommit}`)
	}
	const runnerEnvironment = pinsRecord["runnerEnvironment"]
	if (typeof runnerEnvironment !== "object" || runnerEnvironment === null) {
		throw new Error("side result pins lack runnerEnvironment")
	}
	for (const field of ["os", "nodeVersion", "vscodeTarget"] as const) {
		const value = (runnerEnvironment as Record<string, unknown>)[field]
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`side result runnerEnvironment lacks ${field}`)
		}
	}
	const runs = record["runs"]
	if (!Array.isArray(runs)) throw new Error("side result has no runs array")
	for (const run of runs) {
		if (typeof run !== "object" || run === null) throw new Error("side result run is not an object")
		const metrics = (run as Record<string, unknown>)["metrics"]
		if (typeof metrics !== "object" || metrics === null) throw new Error("side result run lacks metrics")
	}
	return parsed as SideResultFile
}

// Reduces a side result file to the shape the report builder consumes.
export const toSideResult = (file: SideResultFile): SideResult => ({
	pins: file.pins,
	runs: file.runs.map((record) => record.metrics),
})

// The one shared side result file name. The side writer and the comparison
// reader must agree on it. The name carries no side label, because each side
// writes into its own output directory.
export const sideResultFileName = (): string => "side-results.json"

const COMPARISON_REPORT_JSON = "comparison-report.json"
const COMPARISON_REPORT_MD = "comparison-report.md"
const COMPARISON_REPORT_COMPLETE = "comparison-report.complete"

// Publishes the JSON and Markdown report pair as one generation. The
// completion marker of any previous generation is removed first, so a crash
// between the two publications leaves a detectable incomplete generation
// instead of a mixed one. A thrown failure rolls both files back, so a failed
// comparison leaves no report files behind. Consumers must require the
// completion marker and match its generation against the report files.
export async function publishComparisonReport(outDir: string, report: ComparisonReport): Promise<void> {
	const generation = report.generatedAt
	const jsonPath = path.join(outDir, COMPARISON_REPORT_JSON)
	const markdownPath = path.join(outDir, COMPARISON_REPORT_MD)
	const markerPath = path.join(outDir, COMPARISON_REPORT_COMPLETE)
	await fs.rm(markerPath, { force: true })
	try {
		await writeJsonAtomic(jsonPath, { ...report, generation })
		await writeFileAtomic(markdownPath, renderMarkdownReport(report))
		await writeFileAtomic(markerPath, `${generation}\n`)
	} catch (error) {
		await fs.rm(jsonPath, { force: true }).catch(() => {})
		await fs.rm(markdownPath, { force: true }).catch(() => {})
		await fs.rm(markerPath, { force: true }).catch(() => {})
		throw error
	}
}

// Reads the generation a complete publication carries. undefined means the
// publication is absent, partial, or crashed between its files.
export const publishedComparisonGeneration = async (outDir: string): Promise<string | undefined> => {
	try {
		const generation = (await fs.readFile(path.join(outDir, COMPARISON_REPORT_COMPLETE), "utf8")).trim()
		return generation.length > 0 ? generation : undefined
	} catch {
		return undefined
	}
}

// Reads one published comparison report. The completion marker is required
// and its generation stamp must match the JSON report and the Markdown
// render, so a partial or mixed generation is never consumed. undefined means
// no complete publication exists.
export async function readPublishedComparisonReport(outDir: string): Promise<ComparisonReport | undefined> {
	const generation = await publishedComparisonGeneration(outDir)
	if (generation === undefined) return undefined
	const parsed: unknown = JSON.parse(await fs.readFile(path.join(outDir, COMPARISON_REPORT_JSON), "utf8"))
	if (typeof parsed !== "object" || parsed === null) throw new Error("comparison report is not a JSON object")
	if ((parsed as Record<string, unknown>)["generation"] !== generation) {
		throw new Error("comparison report generation does not match the completion marker")
	}
	const markdown = await fs.readFile(path.join(outDir, COMPARISON_REPORT_MD), "utf8")
	if (!markdown.includes(generation)) {
		throw new Error("comparison report Markdown does not match the completion marker")
	}
	return parsed as ComparisonReport
}

// Removes the previous side generation before a side executes. After this
// point a crash can no longer present stale results as fresh output, because
// consumers require side-results.json, and it exists only after the current
// invocation completes. A stale file that cannot be removed fails the side
// before any run spends budget.
export async function invalidateSideArtifacts(outDir: string): Promise<void> {
	await fs.rm(path.join(outDir, "artifacts"), { recursive: true, force: true })
	await fs.rm(path.join(outDir, sideResultFileName()), { force: true })
}
