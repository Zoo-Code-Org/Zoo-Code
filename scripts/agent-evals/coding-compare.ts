import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { promisify } from "node:util"
import type { SidePins } from "./coding-pins.ts"
import { buildComparisonReport, renderMarkdownReport, type ComparisonReport, type SideResult } from "./coding-report.ts"
import { DEFAULT_REPETITIONS } from "./coding-stats.ts"
import type { CodingRunRecord } from "./coding-run.ts"
import { buildSideEnvironment, buildWorktreeEnvironment } from "./coding-trust.ts"
import { createSideProcessGuard, type SideProcessGuard } from "./side-process-guard.ts"
import { acquireSideOutputLock, prepareOutputDirectory } from "./output-lock.ts"
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
	const preparationHome = await fs.mkdtemp(path.join(os.tmpdir(), "coding-preparation-home-"))
	try {
		if (isInterrupted()) throw new Error(`interrupted before ${command} started`)
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, [...args], {
				cwd,
				stdio: ["ignore", "ignore", "pipe"],
				detached: true,
				env: buildWorktreeEnvironment(process.env, preparationHome),
			})
			guard.track(child.pid)
			process.send?.({ type: "coding-preparation", pid: child.pid }, () => {})
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
				process.send?.({ type: "coding-preparation", pid: null }, () => {})
				reject(error)
			})
			child.once("exit", (code, signal) => {
				clearTimeout(timer)
				// The group may still contain workers after its leader exits.
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL")
					} catch {
						// The group has already exited.
					}
				}
				guard.track(undefined)
				process.send?.({ type: "coding-preparation", pid: null }, () => {})
				if (code === 0) {
					resolve()
					return
				}
				const reason = timedOut ? "its time bound expired" : code === null ? `signal ${signal}` : `code ${code}`
				reject(new Error([`${command} failed: ${reason}`, stderr].filter(Boolean).join("\n")))
			})
		})
	} finally {
		await fs.rm(preparationHome, { recursive: true, force: true })
	}
}

// Internal side outputs inherit the temporary parent's path policy. Reject
// unsuitable TMPDIR values before creating scratch or preparing any worktree.
export async function createComparisonScratchDirectory(parent: string = os.tmpdir()): Promise<string> {
	let canonicalParent: string
	try {
		canonicalParent = await prepareOutputDirectory(parent, "side")
	} catch (error) {
		throw new Error(
			`cannot prepare comparison scratch in ${parent}; set TMPDIR to a directory outside managed artifacts trees`,
			{ cause: error },
		)
	}
	return fs.mkdtemp(path.join(canonicalParent, "coding-evals-compare-"))
}

// The worktree removals in the flow cleanup are best effort and bounded.
const WORKTREE_REMOVE_TIMEOUT_MS = 30_000

// Everything one side execution needs from the driver process. The guard and
// the interrupt view are shared with the driver's signal handler; the two
// async steps are seams, so tests can place a signal inside the last boundary
// before the spawn without a repository, a toolchain, or a credential.
export interface CompareSideWiring {
	guard: SideProcessGuard
	isInterrupted: () => boolean
	// Trusted checkout root: the spawn cwd of the side process.
	root: string
	// The side entry script of this checkout. Production points at
	// scripts/agent-evals/coding-side.mts; tests substitute a fixture.
	sideScript: string
	reps: number
	trustFile: string
	credentialEnv: string
	sideTimeoutMs: number
	killGraceMs: number
	// Prepares the commit source for one side: the detached worktree add of
	// this exact commit. The side constructs its own fresh worktree of the
	// same commit and installs and builds inside it before any host launch.
	prepareWorktree: (commit: string, worktree: string) => Promise<void>
	// Creates the side output directory. This is the last async boundary
	// before the spawn; tests arm the interrupt inside it.
	createSideOutDir: (dir: string) => Promise<void>
}

// Runs one trusted side against the evaluated worktree. The side script comes
// from this checkout, receives only the allowlisted environment plus the named
// credential variable, re-checks the worktree commit against the trust
// policy, and must finish inside its own wall clock.
export const runCompareSide = async (
	side: "baseline" | "candidate",
	commit: string,
	scratchDir: string,
	wiring: CompareSideWiring,
): Promise<SideResultFile> => {
	if (wiring.isInterrupted()) throw new Error(`interrupted before the ${side} side started`)
	const worktree = path.join(scratchDir, side)
	await wiring.prepareWorktree(commit, worktree)
	if (wiring.isInterrupted()) throw new Error(`interrupted before the ${side} side started`)
	const sideOut = path.join(scratchDir, `${side}-out`)
	// The directory creation is the last await before the spawn. A signal
	// during it arms the guard while nothing is tracked, and the guard never
	// revisits a finished escalation, so the side must be refused here rather
	// than started into an already-interrupted driver.
	await wiring.createSideOutDir(sideOut)
	if (wiring.isInterrupted()) throw new Error(`interrupted before the ${side} side started`)
	// From this refusal check to the guard track there is no await, so a
	// signal cannot slip between them and miss the new child.
	const exit = await new Promise<number>((resolve) => {
		const preparationGuard = createSideProcessGuard(Math.min(wiring.killGraceMs / 3, 5000))
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				wiring.sideScript,
				"--reps",
				String(wiring.reps),
				"--out",
				sideOut,
				"--trust-file",
				wiring.trustFile,
				"--credential-env",
				wiring.credentialEnv,
				"--evaluated-root",
				worktree,
				"--scratch-parent",
				scratchDir,
			],
			{
				cwd: wiring.root,
				env: buildSideEnvironment(process.env, wiring.credentialEnv, side),
				stdio: ["inherit", "inherit", "inherit", "ipc"],
				detached: true,
			},
		)
		child.on("message", (message: unknown) => {
			if (
				typeof message !== "object" ||
				message === null ||
				!("type" in message) ||
				message.type !== "coding-preparation" ||
				!("pid" in message)
			)
				return
			if (message.pid === null) preparationGuard.track(undefined)
			else if (typeof message.pid === "number" && Number.isSafeInteger(message.pid) && message.pid > 0)
				preparationGuard.track(message.pid)
		})
		wiring.guard.track(child.pid)
		let timedOut = false
		const timeoutGuard = createSideProcessGuard(wiring.killGraceMs)
		timeoutGuard.track(child.pid)
		let termination: Promise<unknown> = Promise.resolve()
		const timer = setTimeout(() => {
			timedOut = true
			termination = timeoutGuard.interrupt()
		}, wiring.sideTimeoutMs)
		const finish = (code: number): void => {
			clearTimeout(timer)
			void termination
				.then(() => preparationGuard.interrupt())
				.then(() => {
					wiring.guard.track(undefined)
					resolve(timedOut ? 1 : code)
				})
		}
		child.once("error", () => finish(1))
		child.once("exit", (code) => finish(code ?? 1))
	})
	if (exit !== 0) throw new Error(`${side} side failed with exit code ${exit}`)
	const parsed: unknown = JSON.parse(await fs.readFile(path.join(sideOut, sideResultFileName()), "utf8"))
	// The side output must describe exactly this side and its approved commit,
	// or the pair is invalid.
	return validateSideResultFile(parsed, side, commit)
}

// The comparison body after the trust gates: both sides, one report
// publication, and the cleanup that must finish before the driver exits.
export interface ComparisonFlowWiring {
	out: string
	scratchDir: string
	root: string
	reps: number
	// Runs one side to its validated result. The driver wires its own side
	// runner; tests substitute synthetic sides.
	runSide: (side: "baseline" | "candidate") => Promise<SideResultFile>
	// The observed terminal signal, or undefined. The interrupt outcome and
	// the final exit code read this one view.
	interruptedSignal: () => NodeJS.Signals | undefined
	// The guard's kill escalation, created when the signal arrived. Cleanup
	// awaits it so no tracked child outlives the removed worktrees.
	cleanupLockWaitMs?: number
	interruptKill: () => Promise<unknown>
}

export type ComparisonFlowOutcome =
	{ status: "completed"; report: ComparisonReport } | { status: "interrupted"; signal: "SIGINT" | "SIGTERM" }

// Runs the comparison and resolves to its outcome after the cleanup. An
// interrupt resolves to its signal no matter how the body ended, so the
// caller exits with the conventional code on the normal and the throwing
// path alike; any other failure stays a thrown failure.
export const executeComparisonFlow = async (wiring: ComparisonFlowWiring): Promise<ComparisonFlowOutcome> => {
	try {
		return await executeOwnedComparisonFlow(wiring)
	} finally {
		// Preparation or lock acquisition can fail before the locked flow owns
		// cleanup. Only remove an empty scratch directory on this path.
		await fs.rmdir(wiring.scratchDir).catch(() => {})
	}
}

const executeOwnedComparisonFlow = async (wiring: ComparisonFlowWiring): Promise<ComparisonFlowOutcome> => {
	const canonicalOut = await prepareOutputDirectory(wiring.out, "comparison")
	// A canonical path also excludes aliases through symlinks. Keep the lock
	// beside the canonical output so all processes share it regardless of TMPDIR.
	const key = createHash("sha256").update(canonicalOut).digest("hex")
	const lock = path.join(path.dirname(canonicalOut), `.coding-comparison-${key}.lock`)
	try {
		await fs.mkdir(lock, { mode: 0o700 })
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
		throw new Error(
			`cannot acquire comparison output lock for ${canonicalOut}; another comparison may be running. If none is running, remove the stale lock directory ${lock}`,
			{ cause: error },
		)
	}
	try {
		return await executeLockedComparisonFlow(wiring)
	} finally {
		await fs.rmdir(lock)
	}
}

const executeLockedComparisonFlow = async (wiring: ComparisonFlowWiring): Promise<ComparisonFlowOutcome> => {
	let completed: ComparisonReport | undefined
	let failure: unknown
	const cleanupErrors: unknown[] = []
	try {
		await removeComparisonReport(wiring.out)
		const report = buildComparisonReport({
			baseline: toSideResult(await wiring.runSide("baseline")),
			candidate: toSideResult(await wiring.runSide("candidate")),
			repetitions: wiring.reps,
		})
		// The reports are the comparison's publication point. The pair is
		// published as one generation with a completion marker; any failure
		// above or during publication leaves no complete report generation
		// behind.
		if (!wiring.interruptedSignal()) {
			await publishComparisonReport(wiring.out, report, () => wiring.interruptedSignal() !== undefined)
		}
		completed = report
	} catch (error) {
		// Deferred, not swallowed: the cleanup below runs first, then the
		// failure rethrows unless the run was interrupted.
		failure = error
	} finally {
		// An interrupt escalation must finish before the worktrees go away,
		// so no child is still writing while its tree is deleted.
		await wiring.interruptKill().catch((error) => cleanupErrors.push(error))
		// Acquire both output locks before removing any scratch content. A
		// standalone side may still own one after the comparison child exits.
		const releases: (() => void)[] = []
		try {
			for (const side of ["baseline", "candidate"])
				releases.push(
					await acquireSideOutputLock(
						path.join(wiring.scratchDir, `${side}-out`),
						wiring.cleanupLockWaitMs ?? 35_000,
					),
				)
			await execFileAsync(
				"git",
				[
					"--git-dir",
					path.join(wiring.scratchDir, "baseline.git-source"),
					"worktree",
					"remove",
					"--force",
					path.join(wiring.scratchDir, "baseline"),
				],
				{
					cwd: wiring.root,
					timeout: WORKTREE_REMOVE_TIMEOUT_MS,
					env: buildWorktreeEnvironment(process.env),
				},
			).catch(() => {})
			await execFileAsync(
				"git",
				[
					"--git-dir",
					path.join(wiring.scratchDir, "candidate.git-source"),
					"worktree",
					"remove",
					"--force",
					path.join(wiring.scratchDir, "candidate"),
				],
				{
					cwd: wiring.root,
					timeout: WORKTREE_REMOVE_TIMEOUT_MS,
					env: buildWorktreeEnvironment(process.env),
				},
			).catch(() => {})
			// Keep the lock directories in place until their owners release them.
			// A new writer after release can recreate its output; the final
			// nonrecursive rmdir then leaves that writer's directory intact.
			for (const entry of await fs.readdir(wiring.scratchDir)) {
				if (!entry.startsWith(".coding-side-") && !entry.startsWith(".coding-comparison-"))
					await fs.rm(path.join(wiring.scratchDir, entry), { recursive: true, force: true })
			}
		} catch (error) {
			cleanupErrors.push(error)
			await removeComparisonReport(wiring.out).catch((error) => cleanupErrors.push(error))
		} finally {
			for (const release of releases.reverse()) {
				try {
					release()
				} catch (error) {
					cleanupErrors.push(error)
				}
			}
		}
		await fs.rmdir(wiring.scratchDir).catch(() => {})
	}
	const signal = wiring.interruptedSignal()
	if (signal === "SIGINT" || signal === "SIGTERM") {
		await removeComparisonReport(wiring.out).catch((error) => cleanupErrors.push(error))
		if (cleanupErrors.length)
			console.error("comparison interrupted; cleanup errors:", new AggregateError(cleanupErrors))
		return { status: "interrupted", signal }
	}
	if (cleanupErrors.length) {
		if (failure !== undefined)
			throw new AggregateError([failure, ...cleanupErrors], "comparison failed and cleanup failed")
		throw cleanupErrors.length === 1
			? cleanupErrors[0]
			: new AggregateError(cleanupErrors, "comparison cleanup failed")
	}
	if (failure !== undefined) {
		try {
			await removeComparisonReport(wiring.out)
		} catch (cleanupError) {
			throw new AggregateError([failure, cleanupError], "comparison failed and report cleanup failed")
		}
		throw failure
	}
	if (completed === undefined) throw new Error("comparison ended without a report or a failure")
	return { status: "completed", report: completed }
}

const execFileAsync = promisify(execFile)

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
export async function removeComparisonReport(outDir: string): Promise<void> {
	const results = await Promise.allSettled(
		[COMPARISON_REPORT_COMPLETE, COMPARISON_REPORT_JSON, COMPARISON_REPORT_MD].map((name) =>
			fs.rm(path.join(outDir, name), { force: true }),
		),
	)
	const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason)
	if (errors.length) throw new AggregateError(errors, "comparison report cleanup failed")
}

export async function publishComparisonReport(
	outDir: string,
	report: ComparisonReport,
	isInterrupted: () => boolean = () => false,
): Promise<void> {
	const generation = report.generatedAt
	const jsonPath = path.join(outDir, COMPARISON_REPORT_JSON)
	const markdownPath = path.join(outDir, COMPARISON_REPORT_MD)
	const markerPath = path.join(outDir, COMPARISON_REPORT_COMPLETE)
	await fs.rm(markerPath, { force: true })
	const checkInterrupted = (): void => {
		if (isInterrupted()) throw new Error("comparison report publication interrupted")
	}
	try {
		checkInterrupted()
		await writeJsonAtomic(jsonPath, { ...report, generation })
		checkInterrupted()
		await writeFileAtomic(markdownPath, renderMarkdownReport(report))
		checkInterrupted()
		await writeFileAtomic(markerPath, `${generation}\n`)
		checkInterrupted()
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

// Removes the previous side generation before a side executes. The
// authoritative result is removed first, so every stop after that point, an
// error or an interruption alike, leaves the generation incomplete: consumers
// require side-results.json, and it exists only after the new atomic
// publication completes. A result that cannot be removed, or an artifacts
// tree that cannot be removed after it, fails the side before any run spends
// budget.
export type SideArtifactRemover = (target: string, options: { force?: boolean; recursive?: boolean }) => Promise<void>

export async function invalidateSideArtifacts(
	outDir: string,
	remove: SideArtifactRemover = (target, options) => fs.rm(target, options),
): Promise<void> {
	await remove(path.join(outDir, sideResultFileName()), { force: true })
	await remove(path.join(outDir, "artifacts"), { recursive: true, force: true })
}

// A private repository borrows approved objects without inheriting the source
// repository's filters, hooks, attributes configuration or worktree config.
export async function prepareIsolatedWorktree(
	guard: SideProcessGuard,
	isInterrupted: () => boolean,
	root: string,
	commit: string,
	worktree: string,
	timeoutMs: number,
): Promise<void> {
	const repository = `${worktree}.git-source`
	const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-path", "objects"], {
		cwd: root,
		env: buildWorktreeEnvironment(process.env),
		timeout: timeoutMs,
	})
	await runBoundedPreparation(
		guard,
		isInterrupted,
		"git",
		["init", "--bare", "--template=", repository],
		root,
		timeoutMs,
	)
	await fs.writeFile(path.join(repository, "objects", "info", "alternates"), `${stdout.trim()}\n`)
	await runBoundedPreparation(
		guard,
		isInterrupted,
		"git",
		["--git-dir", repository, "worktree", "add", "--detach", worktree, commit],
		root,
		timeoutMs,
	)
}
