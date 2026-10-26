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
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { executeComparisonFlow, runBoundedPreparation, runCompareSide } from "./coding-compare.ts"
import { assertCommitsApproved, assertCredentialEnvAllowed, loadTrustPolicy, resolveCommit } from "./coding-trust.ts"
import { createInterruptFlag, createSideProcessGuard, type SideKillOutcome } from "./side-process-guard.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const WORKTREE_TIMEOUT_MS = 120_000
const SIDE_KILL_GRACE_MS = 30_000
const DEFAULT_SIDE_TIMEOUT_MINUTES = 120

// Interrupt state. The handlers are registered before any child is spawned.
// A signal arms the flag and starts the guard escalation at once; the flow
// observes the flag at its async boundaries, the cleanup awaits the
// escalation before it removes the worktrees, and the driver exits with the
// conventional signal exit code after that cleanup.
const sideGuard = createSideProcessGuard(SIDE_KILL_GRACE_MS)
const interruptFlag = createInterruptFlag()
let interruptKill: Promise<SideKillOutcome> | undefined
const onInterruptSignal = (signal: NodeJS.Signals): void => {
	if (interruptFlag.isInterrupted()) return
	interruptFlag.signal(signal)
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
	trustFile: string
	sideTimeoutMs: number
} => {
	const args = process.argv.slice(2)
	// The local subprocess runtime has no container isolation: agent-written
	// grading code would execute on the host filesystem. A comparison always
	// grades in the container runtime, so the dangerous option is rejected
	// loudly here and never forwarded to a side.
	if (args.includes("--allow-unisolated-grading"))
		throw new Error("--allow-unisolated-grading is not accepted here: a comparison grades in the container runtime")
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
		interruptFlag.isInterrupted,
		"pnpm",
		["install", "--frozen-lockfile"],
		worktree,
		INSTALL_TIMEOUT_MS,
	)
	await runBoundedPreparation(sideGuard, interruptFlag.isInterrupted, "pnpm", ["build"], worktree, BUILD_TIMEOUT_MS)
}

// One side's full preparation: the detached worktree add of that exact
// commit, then the install and build inside it.
const prepareSideWorktree = async (commit: string, worktree: string): Promise<void> => {
	await runBoundedPreparation(
		sideGuard,
		interruptFlag.isInterrupted,
		"git",
		["worktree", "add", "--detach", worktree, commit],
		root,
		WORKTREE_TIMEOUT_MS,
	)
	await prepareWorktree(worktree)
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
// Both sides run inside the flow. The flow cleanup finishes the interrupt
// escalation, removes the worktrees, and removes the scratch directory
// before any exit, so no child is still writing while its tree is deleted.
const outcome = await executeComparisonFlow({
	out: inputs.out,
	scratchDir,
	root,
	reps: inputs.reps,
	runSide: (side) =>
		runCompareSide(side, side === "baseline" ? baselineCommit : candidateCommit, scratchDir, {
			guard: sideGuard,
			isInterrupted: interruptFlag.isInterrupted,
			root,
			sideScript: path.join(root, "scripts/agent-evals/coding-side.mts"),
			reps: inputs.reps,
			trustFile: inputs.trustFile,
			credentialEnv: inputs.credentialEnv,
			sideTimeoutMs: inputs.sideTimeoutMs,
			killGraceMs: SIDE_KILL_GRACE_MS,
			prepareWorktree: prepareSideWorktree,
			createSideOutDir: async (dir) => {
				await fs.mkdir(dir, { recursive: true })
			},
		}),
	interruptedSignal: interruptFlag.name,
	interruptKill: () => interruptKill ?? Promise.resolve(),
})
// An interrupt stopped the comparison and the flow cleanup has completed.
// Exit with the conventional signal code on the normal and the throwing
// path alike.
if (outcome.status === "interrupted") process.exit(interruptFlag.exitCode())
console.log(
	outcome.report.compatibility.compatible
		? `comparison complete: compatible pair, report in ${inputs.out}`
		: `comparison complete: INCOMPATIBLE pair (${outcome.report.compatibility.differences.join(", ")}), report in ${inputs.out}`,
)
