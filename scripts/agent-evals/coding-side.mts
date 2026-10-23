// One comparison side. Runs every coding fixture for N repetitions on this
// commit through the substrate, grades each final workspace, and writes one
// side-results file with the pinned inputs. Trusted repo code only: the
// provider credential stays with this process and the extension host; the
// grader never receives it.
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
import type { SideResultFile } from "./coding-compare.ts"
import { classifyRunOutcome } from "./coding-outcomes.ts"
import { buildRunMetrics } from "./coding-metrics.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const readArgs = (): { reps: number; out: string; credentialEnv: string; allowUnisolatedGrading: boolean } => {
	const args = process.argv.slice(2)
	const read = (name: string): string | undefined => {
		const index = args.indexOf(`--${name}`)
		return index >= 0 ? args[index + 1] : undefined
	}
	const out = read("out")
	if (!out) throw new Error("Set --out to a scratch directory")
	return {
		reps: Number(read("reps") ?? "3"),
		out: path.resolve(out),
		credentialEnv: read("credential-env") ?? "SOLHEIM_API_KEY",
		allowUnisolatedGrading: args.includes("--allow-unisolated-grading"),
	}
}

const readVscodeTarget = async (): Promise<string> => {
	try {
		const pkg = JSON.parse(await fs.readFile(path.join(root, "apps/vscode-e2e/package.json"), "utf8")) as {
			devDependencies?: Record<string, string>
		}
		return pkg.devDependencies?.["@types/vscode"] ?? "unavailable"
	} catch {
		return "unavailable"
	}
}

const readCommit = async (): Promise<string> => {
	const { execFile } = await import("node:child_process")
	const { promisify } = await import("node:util")
	try {
		const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 })
		return stdout.trim()
	} catch {
		return "commit-unavailable"
	}
}

const { reps, out, credentialEnv, allowUnisolatedGrading } = readArgs()
if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps must be a positive integer")
await fs.mkdir(out, { recursive: true })
ensureCodingSuiteRegistered()

const credential = process.env[credentialEnv] ?? ""
const gradingRuntime = allowUnisolatedGrading ? createLocalSubprocessGradingRuntime() : createContainerGradingRuntime()

const projection = CODING_FIXTURE_BUNDLES[0]?.fixture.settingsProjection ?? {}
const pins: SidePins = {
	side: "baseline",
	commit: await readCommit(),
	suiteId: CODING_SUITE_ID,
	suiteDigest: codingSuiteDigest(),
	settingsDigest: digestValue(projection),
	modelIdentifier: typeof projection["openAiModelId"] === "string" ? projection["openAiModelId"] : "unavailable",
	graderVersion: GRADER_VERSION,
	runnerEnvironment: {
		os: process.platform,
		nodeVersion: process.version,
		vscodeTarget: await readVscodeTarget(),
	},
}

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
				runtime: createHostRuntime({ root, artifactsDir }),
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

// Side identity must reflect the actual side label in a comparison context.
const sideLabel = (process.env["CODING_EVALS_SIDE"] as SidePins["side"] | undefined) ?? "baseline"
const result: SideResultFile = { pins: { ...pins, side: sideLabel }, runs }

// Keep the trace of each run with its artifacts for inspection.
for (const record of runs) {
	if (!record.trace) continue
	const artifactDir = path.join(out, "artifacts", `${record.fixtureName}-rep${record.repIndex}`)
	await fs.writeFile(path.join(artifactDir, "run-record.json"), JSON.stringify(record, null, 2))
}

await fs.writeFile(path.join(out, "side-results.json"), JSON.stringify(result, null, 2))
const correct = runs.filter((record) => record.outcome.outcome === "correct").length
console.log(`coding-evals side complete: ${correct}/${runs.length} correct, suite ${pins.suiteDigest.slice(0, 12)}`)
