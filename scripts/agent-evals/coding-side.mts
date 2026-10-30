// One comparison side. Runs every coding fixture for N repetitions on this
// commit through the substrate, grades each final workspace, and writes one
// side-results file with the pinned inputs. Trusted repo code only: the
// provider credential stays with this process and the extension host; the
// grader never receives it.
//
// The extension under test is never a caller-prepared tree. The side resolves
// the evaluated root's HEAD commit, requires its approval, and then
// constructs a fresh detached worktree of that exact commit in private
// scratch space. The frozen install, the build, and every host launch run
// inside that worktree, so the executed content is only this side's own
// product of the approved commit. Dirty files, untracked files, ignored
// dependencies, stale build output, and symlinks in the caller's tree can
// never reach it.
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createHostRuntime } from "./launcher.ts"
import { createContainerGradingRuntime } from "./container-runtime.ts"
import { runCodingFixtureOnce } from "./coding-run.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { CODING_SUITE_ID, codingSuiteDigest, ensureCodingSuiteRegistered } from "./coding-suite.ts"
import { GRADER_VERSION } from "./coding-grader.ts"
import { digestValue } from "./coding-digest.ts"
import type { SidePins } from "./coding-pins.ts"
import { invalidateSideArtifacts, runBoundedPreparation } from "./coding-compare.ts"
import {
	assertCommitsApproved,
	assertCredentialEnvAllowed,
	assertEvaluatedTreeClean,
	loadTrustPolicy,
	resolveCommit,
} from "./coding-trust.ts"
import { executeSideFlow, type SideRepetition } from "./coding-side-flow.ts"
import { createInterruptFlag, createSideProcessGuard } from "./side-process-guard.ts"

const execFileAsync = promisify(execFile)

const thisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// The side owns the worktree construction, the frozen install, and the build
// of the approved commit. All steps consume the side's own wall clock, and a
// step past its bound is killed as a group like an expired run.
const WORKTREE_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
const WORKTREE_REMOVE_TIMEOUT_MS = 30_000
const SIDE_KILL_GRACE_MS = 30_000

const readArgs = (): {
	reps: number
	out: string
	credentialEnv: string
	evaluatedRoot: string
	trustFile: string
} => {
	const args = process.argv.slice(2)
	// The local subprocess runtime has no container isolation: agent-written
	// grading code would execute on the host filesystem. A live side always
	// grades in the container runtime, so the dangerous option is rejected
	// loudly instead of ignored.
	if (args.includes("--allow-unisolated-grading"))
		throw new Error("--allow-unisolated-grading is not accepted here: a live side grades in the container runtime")
	const read = (name: string): string | undefined => {
		const index = args.indexOf(`--${name}`)
		return index >= 0 ? args[index + 1] : undefined
	}
	const out = read("out")
	if (!out) throw new Error("Set --out to a scratch directory")
	const trustFile = read("trust-file")
	if (!trustFile) throw new Error("Set --trust-file to the policy file listing the approved commit for this side")
	const credentialEnv = read("credential-env") ?? "SOLHEIM_API_KEY"
	// The variable name must be one the framework supports. An arbitrary name
	// could forward an unrelated parent secret to the evaluated extension.
	assertCredentialEnvAllowed(credentialEnv)
	return {
		reps: Number(read("reps") ?? "3"),
		out: path.resolve(out),
		credentialEnv,
		// Repository whose HEAD commit this side evaluates. The trusted
		// harness code drives the run; only the extension host loads the
		// fresh worktree this side builds from the approved commit.
		evaluatedRoot: path.resolve(read("evaluated-root") ?? thisRoot),
		trustFile: path.resolve(trustFile),
	}
}

// Side identity. The value must be one of the comparison labels; the default
// applies only when the variable is unset. Validation happens before any run
// spends provider budget or writes results.
const readSideLabel = (): SidePins["side"] => {
	const raw = process.env["CODING_EVALS_SIDE"]
	if (raw === undefined) return "baseline"
	if (raw !== "baseline" && raw !== "candidate") {
		throw new Error(`CODING_EVALS_SIDE must be "baseline" or "candidate", got "${raw}"`)
	}
	return raw
}

const readVscodeTarget = async (root: string): Promise<string> => {
	try {
		const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/vscode-e2e/package.json"), "utf8")) as {
			devDependencies?: Record<string, string>
		}
		return pkg.devDependencies?.["@types/vscode"] ?? "unavailable"
	} catch {
		return "unavailable"
	}
}

const { reps, out, credentialEnv, evaluatedRoot, trustFile } = readArgs()
if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer")
const sideLabel = readSideLabel()
// Trust gate. The evaluated root names the repository whose HEAD commit this
// side evaluates, so that commit must be approved before any directory is
// prepared, any host is created, or the credential is read. The comparison
// driver checks its resolved commits first; this second check binds the root
// that was actually passed in. The commit of an unapproved root is unreadable
// or foreign, and both fail closed here.
const policy = await loadTrustPolicy(trustFile)
const evaluatedCommit = await resolveCommit("HEAD", evaluatedRoot)
assertCommitsApproved(policy, [evaluatedCommit])
// Fail before any directory, run, or result file exists. An empty credential
// would otherwise produce a plausible file of infrastructure failures.
const credential = process.env[credentialEnv]
if (credential === undefined || credential.length === 0) {
	throw new Error(`provider credential environment variable ${credentialEnv} is unset or empty`)
}
ensureCodingSuiteRegistered()

// Side-level interrupt. A SIGINT or SIGTERM that reaches this process arms
// one flag at most once and starts the preparation guard's escalation, so
// a bounded install or build never outlives the side. The flow checks the
// flag before each repetition and before publication, so an interrupted
// side starts no new repetition and never publishes the completion marker.
// The substrate registers its own host teardown listener per run; the
// listeners stay independent and the flag never consumes their signals.
const interrupt = createInterruptFlag()
const prepGuard = createSideProcessGuard(SIDE_KILL_GRACE_MS)
let prepSettled: Promise<unknown> = Promise.resolve()
const onSideInterrupt = (signal: NodeJS.Signals): void => {
	const first = !interrupt.isInterrupted()
	interrupt.signal(signal)
	if (first) prepSettled = prepGuard.interrupt()
}
process.on("SIGINT", () => onSideInterrupt("SIGINT"))
process.on("SIGTERM", () => onSideInterrupt("SIGTERM"))

// Live sides always grade in the container runtime. The local subprocess
// runtime stays available to unit tests only.
const gradingRuntime = createContainerGradingRuntime()

// Invalidate the previous generation before execution. After this point a
// crash can never leave stale side results or run records behind: consumers
// require side-results.json, and it exists only after this invocation
// completes.
await invalidateSideArtifacts(out)

// Private scratch space for the fresh evaluated tree. The caller's root
// contributes only the approved commit object; nothing from its working
// tree, its ignored dependencies, or its build output is copied, linked, or
// executed.
const sideScratch = await fs.mkdtemp(path.join(os.tmpdir(), "coding-evals-side-"))
const evaluatedWorktree = path.join(sideScratch, "worktree")

// Removal is best effort and bounded, like the comparison flow cleanup. The
// escalation of an in-flight preparation child settles before any tree is
// removed, so no child is still writing while its tree is deleted.
const removePreparedTree = async (): Promise<void> => {
	await prepSettled
	await execFileAsync("git", ["worktree", "remove", "--force", evaluatedWorktree], {
		cwd: evaluatedRoot,
		timeout: WORKTREE_REMOVE_TIMEOUT_MS,
	}).catch(() => {})
	await fs.rm(sideScratch, { recursive: true, force: true }).catch(() => {})
}

const projection = CODING_FIXTURE_BUNDLES[0]?.fixture.settingsProjection ?? {}

const repetitions: SideRepetition[] = CODING_FIXTURE_BUNDLES.flatMap((bundle) =>
	Array.from({ length: reps }, (_, repIndex) => ({
		fixtureName: bundle.fixture.identity.name,
		fixtureVersion: bundle.fixture.identity.version,
		repIndex,
	})),
)

// Pins are recorded when the side publishes, so they describe what actually
// executed: the approved evaluated commit and, when the container runtime
// resolved one, the immutable grader image identity.
const buildPins = async (): Promise<SidePins> => {
	const digest = gradingRuntime.imageDigest ? await gradingRuntime.imageDigest() : undefined
	return {
		side: sideLabel,
		commit: evaluatedCommit,
		suiteId: CODING_SUITE_ID,
		suiteDigest: codingSuiteDigest(),
		settingsDigest: digestValue(projection),
		modelIdentifier: typeof projection["openAiModelId"] === "string" ? projection["openAiModelId"] : "unavailable",
		graderVersion: GRADER_VERSION,
		graderImageDigest: digest?.available === true ? digest.value : "unavailable",
		runnerEnvironment: {
			os: process.platform,
			nodeVersion: process.version,
			vscodeTarget: await readVscodeTarget(evaluatedWorktree),
		},
	}
}

// Everything after the gates runs under one cleanup: the prepared tree is
// removed on completion, on failure, and on interruption alike, and an
// interrupted side exits with the conventional signal code after that
// removal. A thrown failure is deferred until the removal finished, so no
// error path leaks the worktree.
let interruptedExitCode: number | undefined
let failure: unknown
try {
	await runBoundedPreparation(
		prepGuard,
		interrupt.isInterrupted,
		"git",
		["worktree", "add", "--detach", evaluatedWorktree, evaluatedCommit],
		evaluatedRoot,
		WORKTREE_TIMEOUT_MS,
	)
	// The approval names one commit, so the constructed tree must resolve to
	// exactly that commit and hold no other content.
	const preparedCommit = await resolveCommit("HEAD", evaluatedWorktree)
	if (preparedCommit !== evaluatedCommit) {
		throw new Error(`prepared evaluated worktree is at ${preparedCommit}, not the approved ${evaluatedCommit}`)
	}
	await assertEvaluatedTreeClean(evaluatedWorktree)
	// The install and the build run inside the fresh worktree, so the entry
	// the host loads is always this side's own product of the approved
	// commit. The preparation children receive only the allowlisted
	// environment, so the credential never reaches them.
	await runBoundedPreparation(
		prepGuard,
		interrupt.isInterrupted,
		"pnpm",
		["install", "--frozen-lockfile"],
		evaluatedWorktree,
		INSTALL_TIMEOUT_MS,
	)
	await runBoundedPreparation(
		prepGuard,
		interrupt.isInterrupted,
		"pnpm",
		["build"],
		evaluatedWorktree,
		BUILD_TIMEOUT_MS,
	)

	const { runs, completed } = await executeSideFlow({
		repetitions,
		out,
		isInterrupted: interrupt.isInterrupted,
		runRepetition: async ({ fixtureName, repIndex }) => {
			const artifactsDir = path.join(out, "artifacts", `${fixtureName}-rep${repIndex}`)
			await fs.mkdir(artifactsDir, { recursive: true })
			return runCodingFixtureOnce({
				fixtureName,
				repIndex,
				credential,
				runtime: createHostRuntime({
					root: evaluatedWorktree,
					artifactsDir,
					vscodeCachePath: path.join(thisRoot, "apps/vscode-e2e/.vscode-test"),
				}),
				gradingRuntime,
				scratchDir: artifactsDir,
			})
		},
		// Publication point and completion marker. side-results.json appears
		// atomically only after every repetition of this invocation finished,
		// so a reader that sees the file sees a complete side of the current
		// run. A missing file means an interrupted side; consumers must treat
		// it as a failed side and never pair partial output.
		buildResult: async (runs) => ({ pins: await buildPins(), runs }),
	})

	if (!completed) {
		console.error(
			`coding-evals side interrupted by ${interrupt.name() ?? "signal"}; side-results.json not published`,
		)
		interruptedExitCode = interrupt.exitCode()
	} else {
		const correct = runs.filter((record) => record.outcome.outcome === "correct").length
		console.log(
			`coding-evals side complete: ${correct}/${runs.length} correct, suite ${codingSuiteDigest().slice(0, 12)}`,
		)
	}
} catch (error) {
	if (interrupt.isInterrupted()) {
		console.error("coding-evals side interrupted during preparation; side-results.json not published")
		interruptedExitCode = interrupt.exitCode()
	} else {
		failure = error
	}
}
await removePreparedTree()
if (failure !== undefined) throw failure
if (interruptedExitCode !== undefined) process.exit(interruptedExitCode)
