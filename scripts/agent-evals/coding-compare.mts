// Paired comparison driver. Verifies both commits against an explicit trust
// policy, checks out each approved commit into a temporary worktree, prepares
// pinned dependencies and builds that exact commit, runs one trusted coding
// side per commit against its worktree with identical repetition counts, then
// writes the JSON and Markdown comparison reports.
//
// Trust model. The side script, fixtures, grader, and report builder all run
// from this trusted checkout. Only the extension host loads the evaluated
// worktree. The credential never leaves the trusted processes except through
// the one named provider variable. A commit runs only when its full SHA is
// listed in the operator's trust policy; refs are resolved and checked
// against the policy before any worktree or process exists. The side process
// re-checks the root it was handed against the same policy.
//
// Process containment. Install, build, worktree, and side children receive
// only an allowlisted environment, so the driver's secrets never reach them.
// Each runs detached in its own process group under one guard, so SIGINT and
// SIGTERM aimed at the driver alone terminate the tracked group with a bounded
// SIGTERM-then-SIGKILL escalation before the scratch cleanup runs, and an
// interrupt leaves no orphan host behind.
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
	publishComparisonReport,
	runBoundedPreparation,
	sideResultFileName,
	toSideResult,
	validateSideResultFile,
	type SideResultFile,
} from "./coding-compare.ts"
import { buildComparisonReport, renderMarkdownReport } from "./coding-report.ts"
import {
	assertCommitsApproved,
	assertCredentialEnvAllowed,
	buildSideEnvironment,
	loadTrustPolicy,
	resolveCommit,
} from "./coding-trust.ts"
import { createSideProcessGuard, type SideKillOutcome } from "./side-process-guard.ts"

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const WORKTREE_TIMEOUT_MS = 120_000
const SIDE_KILL_GRACE_MS = 30_000
const DEFAULT_SIDE_TIMEOUT_MINUTES = 120

// Interrupt state. The handlers are registered before any child is spawned.
// A signal terminates the tracked child group at once; the main flow observes
// the child exit, the cleanup awaits the escalation before it removes the
// worktrees, and the driver exits with the conventional signal exit code.
const sideGuard = createSideProcessGuard(SIDE_KILL_GRACE_MS)
let interruptSignal: NodeJS.Signals | undefined
let interruptKill: Promise<SideKillOutcome> | undefined
const isInterrupted = (): boolean => interruptSignal !== undefined
const onInterruptSignal = (signal: NodeJS.Signals): void => {
	if (interruptSignal !== undefined) return
	interruptSignal = signal
	interruptKill = sideGuard.interrupt()
}
process.on("SIGINT", () => onInterruptSignal("SIGINT"))
process.on("SIGTERM", () => onInterruptSignal("SIGTERM"))

const readArgs = (): {
	baseline: string
	candidate: string
	reps: number
	out: string
	credentialEnv: string
	allowUnisolatedGrading: boolean
	trustFile: string
	sideTimeoutMs: number
} => {
	const args = process.argv.slice(2)
	const read = (name: string): string | undefined => {
		const index = args.indexOf(`--${name}`)
		return index >= 0 ? args[index + 1] : undefined
	}
	const baseline = read("baseline")
	const candidate = read("candidate")
	const out = read("out")
	const trustFile = read("trust-file")
	if (!baseline || !candidate) throw new Error("Set --baseline and --candidate to commit SHAs")
	if (!out) throw new Error("Set --out to a scratch directory")
	if (!trustFile) throw new Error("Set --trust-file to a policy file listing the approved full commit SHAs")
	const reps = Number(read("reps") ?? "3")
	if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer")
	const sideTimeoutMinutes = Number(read("side-timeout-minutes") ?? String(DEFAULT_SIDE_TIMEOUT_MINUTES))
	if (!Number.isInteger(sideTimeoutMinutes) || sideTimeoutMinutes < 1) {
		throw new Error("--side-timeout-minutes must be a positive integer")
	}
	const credentialEnv = read("credential-env") ?? "SOLHEIM_API_KEY"
	// The variable name must be one the framework supports. An arbitrary name
	// could forward an unrelated parent secret to the side.
	assertCredentialEnvAllowed(credentialEnv)
	return {
		baseline,
		candidate,
		reps,
		out: path.resolve(out),
		credentialEnv,
		allowUnisolatedGrading: args.includes("--allow-unisolated-grading"),
		trustFile: path.resolve(trustFile),
		sideTimeoutMs: sideTimeoutMinutes * 60_000,
	}
}

// Prepares the worktree of one evaluated commit. Dependencies install from
// the worktree's own frozen lockfile, and that exact commit's extension and
// webview build from its own sources. No artifact crosses sides.
const prepareWorktree = async (worktree: string): Promise<void> => {
	await runBoundedPreparation(
		sideGuard,
		isInterrupted,
		"pnpm",
		["install", "--frozen-lockfile"],
		worktree,
		INSTALL_TIMEOUT_MS,
	)
	await runBoundedPreparation(sideGuard, isInterrupted, "pnpm", ["build"], worktree, BUILD_TIMEOUT_MS)
}

// Runs one trusted side against the evaluated worktree. The side script comes
// from this checkout, receives only the allowlisted environment plus the
// named credential variable, re-checks the worktree commit against the trust
// policy, and must finish inside its own wall clock.
const runSide = async (
	side: "baseline" | "candidate",
	commit: string,
	inputs: ReturnType<typeof readArgs>,
	scratchDir: string,
): Promise<SideResultFile> => {
	if (isInterrupted()) throw new Error(`interrupted before the ${side} side started`)
	const worktree = path.join(scratchDir, side)
	await runBoundedPreparation(
		sideGuard,
		isInterrupted,
		"git",
		["worktree", "add", "--detach", worktree, commit],
		root,
		WORKTREE_TIMEOUT_MS,
	)
	await prepareWorktree(worktree)
	if (isInterrupted()) throw new Error(`interrupted before the ${side} side started`)
	const sideOut = path.join(scratchDir, `${side}-out`)
	await fs.mkdir(sideOut, { recursive: true })
	const exit = await new Promise<number>((resolve) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				path.join(root, "scripts/agent-evals/coding-side.mts"),
				"--reps",
				String(inputs.reps),
				"--out",
				sideOut,
				"--trust-file",
				inputs.trustFile,
				"--credential-env",
				inputs.credentialEnv,
				"--evaluated-root",
				worktree,
				...(inputs.allowUnisolatedGrading ? ["--allow-unisolated-grading"] : []),
			],
			{
				cwd: root,
				env: buildSideEnvironment(process.env, inputs.credentialEnv, side),
				stdio: "inherit",
				detached: true,
			},
		)
		sideGuard.track(child.pid)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM")
			} catch {
				child.kill("SIGTERM")
			}
			setTimeout(() => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL")
				} catch {
					child.kill("SIGKILL")
				}
			}, SIDE_KILL_GRACE_MS).unref()
		}, inputs.sideTimeoutMs)
		child.once("error", () => {
			clearTimeout(timer)
			sideGuard.track(undefined)
			resolve(1)
		})
		child.once("exit", (code) => {
			clearTimeout(timer)
			sideGuard.track(undefined)
			resolve(timedOut ? 1 : (code ?? 1))
		})
	})
	if (exit !== 0) throw new Error(`${side} side failed with exit code ${exit}`)
	const parsed: unknown = JSON.parse(await fs.readFile(path.join(sideOut, sideResultFileName()), "utf8"))
	// The side output must describe exactly this side and its approved commit,
	// or the pair is invalid.
	return validateSideResultFile(parsed, side, commit)
}

const inputs = readArgs()
if (process.env[inputs.credentialEnv] === undefined || process.env[inputs.credentialEnv]?.length === 0) {
	throw new Error(`provider credential environment variable ${inputs.credentialEnv} is unset or empty`)
}
const policy = await loadTrustPolicy(inputs.trustFile)
// Trust gate. Both commits resolve to full SHAs and must be approved before
// any worktree is created or any code runs.
const baselineCommit = await resolveCommit(inputs.baseline, root)
const candidateCommit = await resolveCommit(inputs.candidate, root)
assertCommitsApproved(policy, [baselineCommit, candidateCommit])

const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-evals-compare-"))
await fs.mkdir(inputs.out, { recursive: true })
try {
	const report = buildComparisonReport({
		baseline: toSideResult(await runSide("baseline", baselineCommit, inputs, scratchDir)),
		candidate: toSideResult(await runSide("candidate", candidateCommit, inputs, scratchDir)),
		repetitions: inputs.reps,
	})
	// The reports are the comparison's publication point. The pair is
	// published as one generation with a completion marker; any failure above
	// or during publication leaves no complete report generation behind.
	await publishComparisonReport(inputs.out, report)
	console.log(
		report.compatibility.compatible
			? `comparison complete: compatible pair, report in ${inputs.out}`
			: `comparison complete: INCOMPATIBLE pair (${report.compatibility.differences.join(", ")}), report in ${inputs.out}`,
	)
} finally {
	// An interrupt escalation must finish before the worktrees go away, so
	// no child is still writing while its tree is deleted.
	await interruptKill
	await execFileAsync("git", ["worktree", "remove", "--force", path.join(scratchDir, "baseline")], {
		cwd: root,
		timeout: 30_000,
	}).catch(() => {})
	await execFileAsync("git", ["worktree", "remove", "--force", path.join(scratchDir, "candidate")], {
		cwd: root,
		timeout: 30_000,
	}).catch(() => {})
	await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {})
}
// An interrupt terminated the side group above, and the cleanup in the
// finally block has completed. Exit with the conventional signal code.
if (interruptSignal === "SIGINT") process.exit(130)
if (interruptSignal === "SIGTERM") process.exit(143)
