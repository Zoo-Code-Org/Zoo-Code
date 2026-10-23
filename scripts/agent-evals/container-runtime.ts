import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type { GraderJob, GraderVerdict, GradingRuntime, DriverResult } from "./coding-grader.ts"

// Pinned grader image. The image tag is part of the grader identity and is
// recorded in every pinned comparison through the grader version.
export const GRADER_IMAGE = "node:22-bookworm"

export type ContainerExecutable = "docker" | "podman"

export interface ContainerRuntimeOptions {
	executable?: ContainerExecutable
	// Test seam: detects the container binary instead of searching PATH.
	detectExecutable?: () => Promise<ContainerExecutable | undefined>
}

const defaultDetect = async (): Promise<ContainerExecutable | undefined> => {
	for (const candidate of ["docker", "podman"] as const) {
		const usable = await probeExecutable(candidate)
		if (usable) return candidate
	}
	return undefined
}

const probeExecutable = (candidate: ContainerExecutable): Promise<boolean> =>
	new Promise((resolve) => {
		try {
			const child = spawn(candidate, ["--version"], { stdio: "ignore" })
			const timer = setTimeout(() => {
				child.kill("SIGKILL")
				resolve(false)
			}, 5_000)
			child.once("error", () => {
				clearTimeout(timer)
				resolve(false)
			})
			child.once("exit", (code) => {
				clearTimeout(timer)
				resolve(code === 0)
			})
		} catch {
			resolve(false)
		}
	})

// Builds one `run` invocation. The container has no network, no Linux
// capabilities, no privilege escalation, a read-only root filesystem, fixed
// CPU, memory, and process limits, and a size-capped scratch tmpfs. The
// grading copy mounts read-only, so agent-written code cannot change the
// hidden tests at grading time. The driver mounts read-only from repo code.
// No environment variable passes through, so no credential can leak in.
export function buildContainerArgs(job: GraderJob, outDir: string): string[] {
	return [
		"run",
		"--rm",
		"--network",
		"none",
		"--cpus",
		String(job.resources.cpus),
		"--memory",
		`${job.resources.memoryMb}m`,
		"--memory-swap",
		`${job.resources.memoryMb}m`,
		"--pids-limit",
		String(job.resources.pidsLimit),
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=67108864",
		"-v",
		`${job.gradingDir}:/work:ro`,
		"-v",
		`${outDir}:/out:rw`,
		"-v",
		`${job.driverPath}:/driver/grader-driver.mjs:ro`,
		"-w",
		"/work",
		job.resources.image,
		"node",
		"/driver/grader-driver.mjs",
		"/out/result.json",
		"test",
	]
}

// Default grading runtime. Runs the driver in a disposable container. The
// host enforces the wall-clock limit and kills the container on expiry.
export function createContainerGradingRuntime(options: ContainerRuntimeOptions = {}): GradingRuntime {
	const detect = options.detectExecutable ?? defaultDetect
	return {
		isolation: "container",
		async run(job: GraderJob): Promise<GraderVerdict> {
			const executable = await detect()
			if (!executable) return { kind: "grading-failure", isolation: "container", reason: "noContainerRuntime" }
			const outDir = path.join(path.dirname(job.gradingDir), "grading-out")
			await fs.mkdir(outDir, { recursive: true })
			try {
				const args = buildContainerArgs(job, outDir)
				const exit = await new Promise<number | "timeout" | "error">((resolve) => {
					const child = spawn(executable, args, {
						stdio: "ignore",
						timeout: job.resources.timeoutMs,
						killSignal: "SIGKILL",
					})
					child.once("error", () => resolve("error"))
					child.once("close", (code, signal) => resolve(signal === "SIGKILL" ? "timeout" : (code ?? "error")))
				})
				if (exit === "timeout")
					return { kind: "grading-failure", isolation: "container", reason: "graderTimeout" }
				if (exit === "error" || exit !== 0)
					return { kind: "grading-failure", isolation: "container", reason: "graderCrashed" }
				const result = await readDriverResult(path.join(outDir, "result.json"))
				if (!result) return { kind: "grading-failure", isolation: "container", reason: "graderResultMissing" }
				return verdictFromDriver(result, "container")
			} catch {
				return { kind: "grading-failure", isolation: "container", reason: "graderSetupFailed" }
			} finally {
				await fs.rm(outDir, { recursive: true, force: true })
			}
		},
	}
}

export async function readDriverResult(outPath: string): Promise<DriverResult | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(outPath, "utf8")) as DriverResult
		return parsed.kind === "completed" || parsed.kind === "driver-error" ? parsed : undefined
	} catch {
		return undefined
	}
}

export function verdictFromDriver(result: DriverResult, isolation: GraderVerdict["isolation"]): GraderVerdict {
	if (result.kind !== "completed") return { kind: "grading-failure", isolation, reason: "driverError" }
	if (result.noTestsDiscovered) return { kind: "grading-failure", isolation, reason: "noTestsDiscovered" }
	return result.passed ? { kind: "passed", isolation, result } : { kind: "failed", isolation, result }
}
