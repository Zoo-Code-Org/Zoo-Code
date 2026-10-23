import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs/promises"
import path from "node:path"
import type { AgentFixtureWorkspaceFile } from "./contract.ts"
import { buildGradingCopy } from "./coding-workspace.ts"
import { loadDriverResult, verdictFromDriver } from "./container-runtime.ts"
import type { Measured } from "./trace.ts"

// The grader version is a pinned comparison input. Any change to the driver,
// the image, or the verdict rules must bump it.
export const GRADER_VERSION = "coding-grader-v2"

export interface GraderResources {
	timeoutMs: number
	memoryMb: number
	cpus: number
	pidsLimit: number
	image: string
}

export interface DriverCompleted {
	kind: "completed"
	passed: boolean
	noTestsDiscovered: boolean
	testFiles: string[]
	passedCount: number
	failedCount: number
	// Tests the runner cancelled. A cancelled test never ran, so a passing
	// verdict requires zero cancellations.
	cancelledCount: number
	failures: { name: string; file: string }[]
	durationMs: number
}

export interface DriverError {
	kind: "driver-error"
	message: string
}

export type DriverResult = DriverCompleted | DriverError

export interface GraderJob {
	// Fresh copy of the final workspace plus the hidden acceptance tests.
	gradingDir: string
	driverPath: string
	resources: GraderResources
}

export type GradingIsolation = "container" | "local-subprocess"

export type GraderVerdict =
	| { kind: "passed"; isolation: GradingIsolation; result: DriverCompleted }
	| { kind: "failed"; isolation: GradingIsolation; result: DriverCompleted }
	| { kind: "grading-failure"; isolation: GradingIsolation; reason: string }

export interface GradingRuntime {
	readonly isolation: GradingIsolation
	run(job: GraderJob): Promise<GraderVerdict>
	// Resolves the immutable grader image identity for the comparison pins.
	// Optional: runtimes without an image report unavailability.
	imageDigest?(): Promise<Measured<string>>
}

export const driverFilePath = (): string => fileURLToPath(new URL("./grader-driver.mjs", import.meta.url))

// Runs one grading job. The grader:
// - works on a fresh copy of the final workspace, never the original,
// - adds hidden acceptance tests only to that copy,
// - executes through the given runtime (disposable container by default),
// - has no credential and no network access in either runtime,
// - reports a hung, crashed, or over-limit grader as a grading failure.
export async function runGrader(inputs: {
	finalFiles: readonly AgentFixtureWorkspaceFile[]
	hiddenTests: readonly AgentFixtureWorkspaceFile[]
	resources: GraderResources
	runtime: GradingRuntime
	scratchDir: string
}): Promise<GraderVerdict> {
	const gradingDir = path.join(inputs.scratchDir, "grading-copy")
	// Cleanup is best effort. A failed removal must never replace the verdict.
	const removeCopy = (): Promise<void> => fs.rm(gradingDir, { recursive: true, force: true }).catch(() => {})
	let verdict: GraderVerdict
	try {
		await buildGradingCopy(inputs.finalFiles, inputs.hiddenTests, gradingDir)
	} catch {
		await removeCopy()
		return { kind: "grading-failure", isolation: inputs.runtime.isolation, reason: "gradingCopyFailed" }
	}
	try {
		verdict = await inputs.runtime.run({
			gradingDir,
			driverPath: driverFilePath(),
			resources: inputs.resources,
		})
	} catch {
		verdict = { kind: "grading-failure", isolation: inputs.runtime.isolation, reason: "graderRuntimeFailed" }
	}
	await removeCopy()
	return verdict
}

const INPROCESS_ENV_ALLOWLIST = ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const

// Local subprocess runtime. It runs the same driver directly on the host with
// a minimal environment and the same wall-clock kill. It has NO container
// isolation: agent-written code runs with the host filesystem. It exists for
// unit tests and explicit local checks only. It does not give isolation equal
// to the container runtime and must never back a recorded comparison.
export function createLocalSubprocessGradingRuntime(nodeExecutable = process.execPath): GradingRuntime {
	return {
		isolation: "local-subprocess",
		async run(job: GraderJob): Promise<GraderVerdict> {
			const outDir = path.join(path.dirname(job.gradingDir), "grading-out")
			const resultPath = path.join(outDir, "result.json")
			await fs.mkdir(outDir, { recursive: true })
			try {
				const exit = await new Promise<number | "timeout" | "error">((resolve) => {
					const env: NodeJS.ProcessEnv = {}
					for (const name of INPROCESS_ENV_ALLOWLIST) {
						const value = process.env[name]
						if (value !== undefined) env[name] = value
					}
					const child = spawn(nodeExecutable, [job.driverPath, resultPath, "test"], {
						cwd: job.gradingDir,
						env,
						stdio: "ignore",
						timeout: job.resources.timeoutMs,
						killSignal: "SIGKILL",
					})
					child.once("error", () => resolve("error"))
					child.once("close", (code, signal) => resolve(signal === "SIGKILL" ? "timeout" : (code ?? "error")))
				})
				if (exit === "timeout")
					return { kind: "grading-failure", isolation: "local-subprocess", reason: "graderTimeout" }
				if (exit === "error" || exit !== 0)
					return { kind: "grading-failure", isolation: "local-subprocess", reason: "graderCrashed" }
				const loaded = await loadDriverResult(resultPath)
				if (loaded === "missing")
					return { kind: "grading-failure", isolation: "local-subprocess", reason: "graderResultMissing" }
				if (loaded === "invalid")
					return { kind: "grading-failure", isolation: "local-subprocess", reason: "graderResultInvalid" }
				return verdictFromDriver(loaded, "local-subprocess")
			} finally {
				await fs.rm(outDir, { recursive: true, force: true })
			}
		},
	}
}
