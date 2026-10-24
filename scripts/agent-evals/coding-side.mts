// One comparison side. Runs every coding fixture for N repetitions on this
// commit through the substrate, grades each final workspace, and writes one
// side-results file with the pinned inputs. Trusted repo code only: the
// provider credential stays with this process and the extension host; the
// grader never receives it. The extension under test comes from the evaluated
// root, which must be a commit the operator's trust policy approves before
// any host is created or any credential is read.
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHostRuntime } from "./launcher.ts"
import { createContainerGradingRuntime } from "./container-runtime.ts"
import { createLocalSubprocessGradingRuntime } from "./coding-grader.ts"
import { runCodingFixtureOnce, type CodingRunRecord } from "./coding-run.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"
import { CODING_SUITE_ID, codingSuiteDigest, ensureCodingSuiteRegistered } from "./coding-suite.ts"
import { GRADER_VERSION } from "./coding-grader.ts"
import { digestValue } from "./coding-digest.ts"
import type { SidePins } from "./coding-pins.ts"
import { invalidateSideArtifacts } from "./coding-compare.ts"
import type { SideResultFile } from "./coding-compare.ts"
import { assertCommitsApproved, assertCredentialEnvAllowed, loadTrustPolicy, resolveCommit } from "./coding-trust.ts"
import { classifyRunOutcome } from "./coding-outcomes.ts"
import { buildRunMetrics } from "./coding-metrics.ts"
import { writeJsonAtomic } from "./fs-atomic.ts"

const thisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const readArgs = (): {
	reps: number
	out: string
	credentialEnv: string
	allowUnisolatedGrading: boolean
	evaluatedRoot: string
	trustFile: string
} => {
	const args = process.argv.slice(2)
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
		allowUnisolatedGrading: args.includes("--allow-unisolated-grading"),
		// Repository root of the extension under test. The trusted harness
		// code drives the run; only the extension host loads this tree.
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

const { reps, out, credentialEnv, allowUnisolatedGrading, evaluatedRoot, trustFile } = readArgs()
if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer")
const sideLabel = readSideLabel()
// Trust gate. The evaluated root is loaded by the extension host and receives
// the credential, so its resolved full commit must be approved before any
// directory is prepared, any host is created, or the credential is read. The
// comparison driver checks its resolved commits first; this second check binds
// the root that was actually passed in. The commit of an unapproved root is
// unreadable or foreign, and both fail closed here.
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

const gradingRuntime = allowUnisolatedGrading ? createLocalSubprocessGradingRuntime() : createContainerGradingRuntime()

// Invalidate the previous generation before execution. After this point a
// crash can never leave stale side results or run records behind: consumers
// require side-results.json, and it exists only after this invocation
// completes.
await invalidateSideArtifacts(out)

const projection = CODING_FIXTURE_BUNDLES[0]?.fixture.settingsProjection ?? {}

const runs: CodingRunRecord[] = []
for (const bundle of CODING_FIXTURE_BUNDLES) {
	const fixtureName = bundle.fixture.identity.name
	for (let repIndex = 0; repIndex < reps; repIndex++) {
		const artifactsDir = path.join(out, "artifacts", `${fixtureName}-rep${repIndex}`)
		await fs.mkdir(artifactsDir, { recursive: true })
		try {
			const record = await runCodingFixtureOnce({
				fixtureName,
				repIndex,
				credential,
				runtime: createHostRuntime({
					root: evaluatedRoot,
					artifactsDir,
					vscodeCachePath: path.join(thisRoot, "apps/vscode-e2e/.vscode-test"),
				}),
				gradingRuntime,
				scratchDir: artifactsDir,
			})
			runs.push(record)
		} catch {
			// The substrate never throws for task failures. This guards wiring
			// errors only, and records them as infrastructure failures.
			const outcome = classifyRunOutcome({ hasTrace: false, finalWorkspaceAvailable: false })
			runs.push({
				fixtureName,
				fixtureVersion: bundle.fixture.identity.version,
				repIndex,
				outcome,
				metrics: buildRunMetrics({
					fixtureName,
					repIndex,
					outcome,
					modelIdentifier: { available: false, reason: "runFailed" },
				}),
			})
		}
	}
}

// Pins are recorded after the runs so they describe what actually executed:
// the approved evaluated commit and, when the container runtime resolved one,
// the immutable grader image identity.
const digest = gradingRuntime.imageDigest ? await gradingRuntime.imageDigest() : undefined
const pins: SidePins = {
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
		vscodeTarget: await readVscodeTarget(evaluatedRoot),
	},
}
const result: SideResultFile = { pins, runs }

// Per-run artifacts are published atomically as each record exists.
for (const record of runs) {
	if (!record.trace) continue
	const artifactDir = path.join(out, "artifacts", `${record.fixtureName}-rep${record.repIndex}`)
	await writeJsonAtomic(path.join(artifactDir, "run-record.json"), record)
}

// Publication point and completion marker. side-results.json appears
// atomically only after every repetition of this invocation finished, so a
// reader that sees the file sees a complete side of the current run. A
// missing file means an interrupted side; consumers must treat it as a failed
// side and never pair partial output.
await writeJsonAtomic(path.join(out, "side-results.json"), result)
const correct = runs.filter((record) => record.outcome.outcome === "correct").length
console.log(`coding-evals side complete: ${correct}/${runs.length} correct, suite ${pins.suiteDigest.slice(0, 12)}`)
