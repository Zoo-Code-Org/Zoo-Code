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
// against the policy before any worktree or process exists.
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { sideResultFileName, toSideResult, validateSideResultFile, type SideResultFile } from "./coding-compare.ts"
import { buildComparisonReport, renderMarkdownReport } from "./coding-report.ts"
import { assertCommitsApproved, buildSideEnvironment, loadTrustPolicy, resolveCommit } from "./coding-trust.ts"
import { writeJsonAtomic, writeFileAtomic } from "./fs-atomic.ts"

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const WORKTREE_TIMEOUT_MS = 120_000
const SIDE_KILL_GRACE_MS = 30_000
const DEFAULT_SIDE_TIMEOUT_MINUTES = 120

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
	return {
		baseline,
		candidate,
		reps,
		out: path.resolve(out),
		credentialEnv: read("credential-env") ?? "SOLHEIM_API_KEY",
		allowUnisolatedGrading: args.includes("--allow-unisolated-grading"),
		trustFile: path.resolve(trustFile),
		sideTimeoutMs: sideTimeoutMinutes * 60_000,
	}
}

const runBounded = async (command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<void> => {
	await execFileAsync(command, [...args], { cwd, timeout: timeoutMs, killSignal: "SIGKILL" })
}

// Prepares the worktree of one evaluated commit. Dependencies install from
// the worktree's own frozen lockfile, and that exact commit's extension and
// webview build from its own sources. No artifact crosses sides.
const prepareWorktree = async (worktree: string): Promise<void> => {
	await runBounded("pnpm", ["install", "--frozen-lockfile"], worktree, INSTALL_TIMEOUT_MS)
	await runBounded("pnpm", ["build"], worktree, BUILD_TIMEOUT_MS)
}

// Runs one trusted side against the evaluated worktree. The side script comes
// from this checkout, receives only the allowlisted environment plus the
// named credential variable, and must finish inside its own wall clock.
const runSide = async (
	side: "baseline" | "candidate",
	commit: string,
	inputs: ReturnType<typeof readArgs>,
	scratchDir: string,
): Promise<SideResultFile> => {
	const worktree = path.join(scratchDir, side)
	await runBounded("git", ["worktree", "add", "--detach", worktree, commit], root, WORKTREE_TIMEOUT_MS)
	await prepareWorktree(worktree)
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
			resolve(1)
		})
		child.once("exit", (code) => {
			clearTimeout(timer)
			resolve(timedOut ? 1 : (code ?? 1))
		})
	})
	if (exit !== 0) throw new Error(`${side} side failed with exit code ${exit}`)
	const parsed: unknown = JSON.parse(await fs.readFile(path.join(sideOut, sideResultFileName(side)), "utf8"))
	// The side output must describe exactly the approved commit, or the pair
	// is invalid.
	return validateSideResultFile(parsed, commit)
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
	// The reports are the comparison's publication point. They appear
	// atomically and only after both sides published complete results; any
	// failure above leaves no report files behind.
	await writeJsonAtomic(path.join(inputs.out, "comparison-report.json"), report)
	await writeFileAtomic(path.join(inputs.out, "comparison-report.md"), renderMarkdownReport(report))
	console.log(
		report.compatibility.compatible
			? `comparison complete: compatible pair, report in ${inputs.out}`
			: `comparison complete: INCOMPATIBLE pair (${report.compatibility.differences.join(", ")}), report in ${inputs.out}`,
	)
} finally {
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
