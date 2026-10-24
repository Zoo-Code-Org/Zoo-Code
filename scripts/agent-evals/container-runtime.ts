import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { GraderJob, GraderVerdict, GradingRuntime, DriverResult } from "./coding-grader.ts"
import type { Measured } from "./trace.ts"

// Pinned grader image tag. The digest resolved from the local engine travels
// in the comparison pins, so the recorded identity is immutable even though
// the tag alone is not.
export const GRADER_IMAGE = "node:22-bookworm"

export type ContainerExecutable = "docker" | "podman"

export interface ContainerRuntimeOptions {
	executable?: ContainerExecutable
	// Test seam: detects the container binary instead of searching PATH.
	detectExecutable?: () => Promise<ContainerExecutable | undefined>
	// Test seam: replaces the container CLI process calls.
	cli?: ContainerCli
}

// One container CLI. The default implementation spawns docker or podman. Tests
// replace it, so timeout cleanup is testable without a real engine.
export interface ContainerCli {
	// Pulls the grader image. Runs outside the grading timeout.
	pull(image: string): Promise<"ok" | "failed">
	// Runs one container. Resolves "timeout" when the CLI hit the wall clock.
	run(args: readonly string[], timeoutMs: number): Promise<number | "timeout" | "error">
	// Removes the named container. "absent" means the container is already
	// gone, which counts as verified removal.
	remove(name: string): Promise<"removed" | "absent" | "failed">
	// Resolves the immutable local image identity: the repo digest when one
	// exists, otherwise the image ID. Never a fabricated value.
	imageDigest(image: string): Promise<string | undefined>
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

// Shared bound for one CLI call's captured stdout and stderr. Digest, pull,
// and removal diagnostics are far smaller than this cap; the cap only bounds
// a pathological output stream, so captured output can never grow unbounded.
export const EXEC_OUTPUT_MAX_BYTES = 262_144

const appendBounded = (current: string, chunk: string): string =>
	current.length >= EXEC_OUTPUT_MAX_BYTES ? current : current + chunk.slice(0, EXEC_OUTPUT_MAX_BYTES - current.length)

// Exported as a test seam. Production callers go through ContainerCli.
export const exec = (
	file: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ code: number | "timeout" | "error"; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		try {
			const child = spawn(file, [...args], {
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			})
			let stdout = ""
			let stderr = ""
			child.stdout?.on("data", (chunk) => {
				stdout = appendBounded(stdout, String(chunk))
			})
			child.stderr?.on("data", (chunk) => {
				stderr = appendBounded(stderr, String(chunk))
			})
			child.once("error", () => resolve({ code: "error", stdout, stderr }))
			child.once("close", (code, signal) =>
				resolve({ code: signal === "SIGKILL" ? "timeout" : (code ?? "error"), stdout, stderr }),
			)
		} catch {
			resolve({ code: "error", stdout: "", stderr: "" })
		}
	})

const IMAGE_PULL_TIMEOUT_MS = 10 * 60_000
const CONTAINER_REMOVE_TIMEOUT_MS = 30_000
const IMAGE_INSPECT_TIMEOUT_MS = 30_000

const containerGone = (stderr: string): boolean => /no such container/i.test(stderr)

export function createDefaultContainerCli(executable: ContainerExecutable): ContainerCli {
	return {
		async pull(image) {
			const outcome = await exec(executable, ["pull", "-q", image], IMAGE_PULL_TIMEOUT_MS)
			return outcome.code === 0 ? "ok" : "failed"
		},
		run(args, timeoutMs) {
			return exec(executable, args, timeoutMs).then((outcome) => outcome.code)
		},
		async remove(name) {
			const outcome = await exec(executable, ["rm", "--force", name], CONTAINER_REMOVE_TIMEOUT_MS)
			if (outcome.code === 0) return "removed"
			if (outcome.code !== "timeout" && containerGone(outcome.stderr)) return "absent"
			return "failed"
		},
		async imageDigest(image) {
			const repoDigest = await exec(
				executable,
				["image", "inspect", "--format", "{{index .RepoDigests 0}}", image],
				IMAGE_INSPECT_TIMEOUT_MS,
			)
			if (repoDigest.code === 0) {
				const digest = repoDigest.stdout.trim()
				if (digest.length > 0) return digest
			}
			// A locally built image has no repo digest. The engine image ID is
			// still an immutable local identity.
			const imageId = await exec(
				executable,
				["image", "inspect", "--format", "{{.Id}}", image],
				IMAGE_INSPECT_TIMEOUT_MS,
			)
			return imageId.code === 0 ? imageId.stdout.trim() || undefined : undefined
		},
	}
}

// Builds one `run` invocation. The container has no network, no Linux
// capabilities, no privilege escalation, a read-only root filesystem, fixed
// CPU, memory, and process limits, and a size-capped scratch tmpfs. The
// grading copy mounts read-only, so agent-written code cannot change the
// hidden tests at grading time. The driver mounts read-only from repo code.
// No environment variable passes through, so no credential can leak in.
export function buildContainerArgs(job: GraderJob, outDir: string, containerName?: string): string[] {
	const leading: string[] = ["run"]
	if (containerName !== undefined) leading.push("--name", containerName)
	return [
		...leading,
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

// Unique per grading run, so concurrent or repeated runs never collide and a
// leftover container is always removable by name.
const containerNameFor = (): string => `agent-evals-grader-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`

// Default grading runtime. Runs the driver in a disposable container. The
// host enforces the wall-clock limit; on expiry it removes the container by
// name and verifies the removal before any output is deleted. A `timeout`
// spawn option alone would kill only the CLI client and leave the container
// running. First-run image pulls happen before the timed run, so grading
// time is never consumed by pulling the image.
export function createContainerGradingRuntime(options: ContainerRuntimeOptions = {}): GradingRuntime {
	let cli: ContainerCli | undefined
	const resolveCli = async (): Promise<ContainerCli | undefined> => {
		if (options.cli) return options.cli
		if (!cli) {
			const detect = options.detectExecutable ?? defaultDetect
			const executable = options.executable ?? (await detect())
			if (!executable) return undefined
			cli = createDefaultContainerCli(executable)
		}
		return cli
	}
	let resolvedDigest: string | undefined
	return {
		isolation: "container",
		async run(job: GraderJob): Promise<GraderVerdict> {
			const failure = (reason: string): GraderVerdict => ({
				kind: "grading-failure",
				isolation: "container",
				reason,
			})
			const selected = await resolveCli()
			if (!selected) return failure("noContainerRuntime")
			// The pull stays outside the grading timeout on purpose.
			if ((await selected.pull(job.resources.image)) === "failed") return failure("graderImagePullFailed")
			resolvedDigest = (await selected.imageDigest(job.resources.image)) ?? resolvedDigest
			const outDir = path.join(path.dirname(job.gradingDir), "grading-out")
			await fs.mkdir(outDir, { recursive: true })
			// The container runs as root with all capabilities dropped, so it
			// cannot rely on CAP_DAC_OVERRIDE. The mount target must grant the
			// write to any uid.
			await fs.chmod(outDir, 0o777)
			const name = containerNameFor()
			const args = buildContainerArgs(job, outDir, name)
			let exit: number | "timeout" | "error"
			try {
				exit = await selected.run(args, job.resources.timeoutMs)
			} catch {
				exit = "error"
			}
			if (exit === "timeout") {
				// Verify the container is gone before the output mount is
				// deleted. A failed removal leaves an unbounded process behind,
				// so it must surface as a grading failure.
				const removal = await selected.remove(name)
				await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
				return removal === "failed" ? failure("graderContainerRemovalFailed") : failure("graderTimeout")
			}
			if (exit === "error" || exit !== 0) {
				// A normally exited container removes itself through --rm; the
				// explicit removal verifies it and cleans a killed client's
				// leftover.
				await selected.remove(name)
				await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
				return failure("graderCrashed")
			}
			try {
				const loaded = await loadDriverResult(path.join(outDir, "result.json"))
				if (loaded === "missing") return failure("graderResultMissing")
				if (loaded === "invalid") return failure("graderResultInvalid")
				return verdictFromDriver(loaded, "container")
			} finally {
				await fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
			}
		},
		async imageDigest(): Promise<Measured<string>> {
			if (resolvedDigest !== undefined) return { available: true, value: resolvedDigest }
			const selected = await resolveCli()
			if (!selected) return { available: false, reason: "noContainerRuntime" }
			return { available: false, reason: "digestUnavailable" }
		},
	}
}

export const DRIVER_RESULT_MAX_BYTES = 65_536
const MAX_TEST_FILES = 1_000
const MAX_FAILURE_ENTRIES = 50
const MAX_COUNT = 100_000

const isBoundedInt = (value: unknown, max: number): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max

const isBoundedString = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= max

// Validates one untrusted driver result. The result file is written inside
// the container where agent-written test code executes, so nothing about its
// content is trusted. Enforces shape, bounds, and internal consistency;
// anything else is rejected.
export function parseDriverResult(text: string): DriverResult | undefined {
	if (text.length > DRIVER_RESULT_MAX_BYTES) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (typeof parsed !== "object" || parsed === null) return undefined
	const record = parsed as Record<string, unknown>
	if (record["kind"] === "driver-error") {
		if (!isBoundedString(record["message"], 512)) return undefined
		return { kind: "driver-error", message: record["message"] }
	}
	if (record["kind"] !== "completed") return undefined
	if (typeof record["passed"] !== "boolean") return undefined
	if (typeof record["noTestsDiscovered"] !== "boolean") return undefined
	const passedCount = record["passedCount"]
	const failedCount = record["failedCount"]
	const cancelledCount = record["cancelledCount"]
	if (!isBoundedInt(passedCount, MAX_COUNT)) return undefined
	if (!isBoundedInt(failedCount, MAX_COUNT)) return undefined
	if (!isBoundedInt(cancelledCount, MAX_COUNT)) return undefined
	const testFiles = record["testFiles"]
	if (!Array.isArray(testFiles) || testFiles.length > MAX_TEST_FILES) return undefined
	if (testFiles.some((entry) => !isBoundedString(entry, 4_096))) return undefined
	if (!record["noTestsDiscovered"] && testFiles.length === 0) return undefined
	const failures = record["failures"]
	if (!Array.isArray(failures) || failures.length > MAX_FAILURE_ENTRIES) return undefined
	for (const entry of failures) {
		if (typeof entry !== "object" || entry === null) return undefined
		const item = entry as Record<string, unknown>
		if (!isBoundedString(item["name"], 1_024)) return undefined
		if (!isBoundedString(item["file"], 4_096)) return undefined
	}
	if (failures.length > failedCount) return undefined
	const durationMs = record["durationMs"]
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined
	// Consistency: a passing verdict requires zero failures, zero
	// cancellations, and at least one passing test.
	const expectedPassed = failedCount === 0 && cancelledCount === 0 && passedCount > 0
	if (record["passed"] !== expectedPassed) return undefined
	return {
		kind: "completed",
		passed: record["passed"],
		noTestsDiscovered: record["noTestsDiscovered"],
		testFiles: testFiles as string[],
		passedCount,
		failedCount,
		cancelledCount,
		failures: failures as { name: string; file: string }[],
		durationMs,
	}
}

export type LoadedDriverResult = DriverResult | "missing" | "invalid"

// Reads one driver result file with a hard size bound. "missing" covers an
// absent or unreadable file; "invalid" covers any untrusted content that
// fails validation.
export async function loadDriverResult(outPath: string): Promise<LoadedDriverResult> {
	let text: string
	try {
		const stat = await fs.stat(outPath)
		if (!stat.isFile() || stat.size > DRIVER_RESULT_MAX_BYTES) return "invalid"
		text = await fs.readFile(outPath, "utf8")
	} catch {
		return "missing"
	}
	const parsed = parseDriverResult(text)
	return parsed ?? "invalid"
}

export function verdictFromDriver(result: DriverResult, isolation: GraderVerdict["isolation"]): GraderVerdict {
	if (result.kind !== "completed") return { kind: "grading-failure", isolation, reason: "driverError" }
	if (result.noTestsDiscovered) return { kind: "grading-failure", isolation, reason: "noTestsDiscovered" }
	return result.passed ? { kind: "passed", isolation, result } : { kind: "failed", isolation, result }
}
