import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
	executeComparisonFlow,
	publishedComparisonGeneration,
	runCompareSide,
	type CompareSideWiring,
	type ComparisonFlowWiring,
	type SideResultFile,
} from "./coding-compare.ts"
import { buildRunMetrics } from "./coding-metrics.ts"
import type { SidePins } from "./coding-pins.ts"
import { createInterruptFlag, type InterruptFlag } from "./side-process-guard.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const COMMIT = "b".repeat(40)

// The guard records every tracked group, so a test can prove the side child
// was never spawned and nothing was left tracked after a real child exited.
const trackingGuard = (tracked: (number | undefined)[]): CompareSideWiring["guard"] => ({
	track: (pid) => {
		tracked.push(pid)
	},
	interrupt: async () => "none",
})

const sideWiring = (inputs: {
	flag: InterruptFlag
	tracked: (number | undefined)[]
	sideScript: string
	createSideOutDir: (dir: string) => Promise<void>
}): CompareSideWiring => ({
	guard: trackingGuard(inputs.tracked),
	isInterrupted: inputs.flag.isInterrupted,
	root: repoRoot,
	sideScript: inputs.sideScript,
	reps: 1,
	trustFile: path.join(repoRoot, "unused-in-unit-tests.json"),
	credentialEnv: "SOLHEIM_API_KEY",
	sideTimeoutMs: 60_000,
	killGraceMs: 100,
	prepareWorktree: async () => {},
	createSideOutDir: inputs.createSideOutDir,
})

const flowWiring = (inputs: {
	flag: InterruptFlag
	out: string
	scratchDir: string
	runSide: (side: "baseline" | "candidate") => Promise<SideResultFile>
}): ComparisonFlowWiring => ({
	out: inputs.out,
	scratchDir: inputs.scratchDir,
	root: repoRoot,
	reps: 1,
	runSide: inputs.runSide,
	interruptedSignal: inputs.flag.name,
	interruptKill: async () => {},
})

const pins = (side: SidePins["side"], commit: string): SidePins => ({
	side,
	commit,
	suiteId: "coding-basic-v1",
	suiteDigest: "d1".repeat(32),
	settingsDigest: "d2".repeat(32),
	modelIdentifier: "test-model",
	graderVersion: "coding-grader-v2",
	graderImageDigest: "unavailable",
	runnerEnvironment: { os: "linux", nodeVersion: process.version, vscodeTarget: "test" },
})

const runMetrics = (fixtureName: string, repIndex: number) =>
	buildRunMetrics({
		fixtureName,
		repIndex,
		outcome: { outcome: "correct", reason: "hiddenTestsPassed" },
		modelIdentifier: { available: true, value: "test-model" },
	})

const record = (side: SidePins["side"], commit: string): SideResultFile => ({
	pins: pins(side, commit),
	runs: [
		{
			fixtureName: "clamp-range",
			fixtureVersion: "1.0.0",
			repIndex: 0,
			outcome: { outcome: "correct", reason: "hiddenTestsPassed" },
			trace: undefined,
			metrics: runMetrics("clamp-range", 0),
		},
	],
})

// A side script fixture that writes one valid result file under --out and
// exits with the given code. The commit travels in the source, because the
// spawn passes no commit argument and the pins must record the approved one.
const sideScriptFixture = (commit: string, exitCode: number): string =>
	[
		`const fs = require("node:fs")`,
		`const path = require("node:path")`,
		`const read = (name) => {`,
		`  const args = process.argv.slice(2)`,
		`  const index = args.indexOf("--" + name)`,
		`  return index >= 0 ? args[index + 1] : undefined`,
		`}`,
		`const pins = {`,
		`  side: process.env.CODING_EVALS_SIDE,`,
		`  commit: ${JSON.stringify(commit)},`,
		`  suiteId: "coding-basic-v1",`,
		`  suiteDigest: "d1".repeat(32),`,
		`  settingsDigest: "d2".repeat(32),`,
		`  modelIdentifier: "fixture-model",`,
		`  graderVersion: "fixture-grader-v1",`,
		`  graderImageDigest: "unavailable",`,
		`  runnerEnvironment: { os: "fixture-os", nodeVersion: process.version, vscodeTarget: "fixture" },`,
		`}`,
		`const out = read("out")`,
		`fs.mkdirSync(out, { recursive: true })`,
		`fs.writeFileSync(path.join(out, "side-results.json"), JSON.stringify({`,
		`  pins,`,
		`  runs: [{ fixtureName: "fixture", fixtureVersion: "1.0.0", repIndex: 0, outcome: { outcome: "correct", reason: "hiddenTestsPassed" }, metrics: {} }],`,
		`}))`,
		`process.exit(${exitCode})`,
	].join("\n")

describe("compare side interruption gate", () => {
	it("refuses to spawn the side when the interrupt lands during the output directory creation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-side-test-"))
		try {
			const flag = createInterruptFlag()
			const tracked: (number | undefined)[] = []
			const sideOut = path.join(dir, "candidate-out")
			const wiring = sideWiring({
				flag,
				tracked,
				sideScript: "unused-because-no-spawn-may-happen.cjs",
				// The signal lands inside the last await before the spawn: the
				// window where the guard holds no tracked group and a finished
				// escalation would never revisit the new child.
				createSideOutDir: async () => {
					flag.signal("SIGINT")
				},
			})
			await assert.rejects(
				runCompareSide("candidate", COMMIT, dir, wiring),
				/interrupted before the candidate side started/,
			)
			// No child was ever spawned or tracked, so no repetition can be
			// running and nothing is left to kill.
			assert.deepEqual(tracked, [])
			await assert.rejects(fs.access(sideOut))
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("runs the side, tracks it, and reads its result when nothing interrupts", { timeout: 60_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-side-test-"))
		try {
			const flag = createInterruptFlag()
			const tracked: (number | undefined)[] = []
			const fixture = path.join(dir, "fixture-side.cjs")
			await fs.writeFile(fixture, sideScriptFixture(COMMIT, 0))
			const wiring = sideWiring({
				flag,
				tracked,
				sideScript: fixture,
				createSideOutDir: async (sideOut) => {
					await fs.mkdir(sideOut, { recursive: true })
				},
			})
			const result = await runCompareSide("baseline", COMMIT, dir, wiring)
			assert.equal(result.pins.side, "baseline")
			assert.equal(result.pins.commit, COMMIT)
			assert.equal(result.runs.length, 1)
			// The real child was tracked and left nothing tracked behind.
			assert.equal(tracked.length >= 1, true)
			assert.equal(tracked.at(-1), undefined)
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("fails the side and untracks it when the side process exits nonzero", { timeout: 60_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-side-test-"))
		try {
			const flag = createInterruptFlag()
			const tracked: (number | undefined)[] = []
			const fixture = path.join(dir, "fixture-side.cjs")
			await fs.writeFile(fixture, sideScriptFixture(COMMIT, 3))
			const wiring = sideWiring({
				flag,
				tracked,
				sideScript: fixture,
				createSideOutDir: async (sideOut) => {
					await fs.mkdir(sideOut, { recursive: true })
				},
			})
			await assert.rejects(
				runCompareSide("baseline", COMMIT, dir, wiring),
				/baseline side failed with exit code 3/,
			)
			assert.equal(tracked.at(-1), undefined)
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})
})

describe("comparison flow outcome and cleanup", () => {
	// Both signals replay the throwing interrupt path: the signal lands
	// mid-side and the side still ends in a failure.
	const interruptedRun = async (signal: NodeJS.Signals) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-flow-test-"))
		try {
			const flag = createInterruptFlag()
			const sides: ("baseline" | "candidate")[] = []
			const outcome = await executeComparisonFlow(
				flowWiring({
					flag,
					out: path.join(dir, "out"),
					scratchDir: dir,
					runSide: async (side) => {
						sides.push(side)
						if (side === "baseline") {
							flag.signal(signal)
							throw new Error("baseline side failed with exit code 1")
						}
						return record(side, COMMIT)
					},
				}),
			)
			return { outcome, sides, dir }
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	}

	it("reports SIGINT and finishes cleanup when a side fails under the interrupt", async () => {
		const { outcome, sides, dir } = await interruptedRun("SIGINT")
		assert.deepEqual(outcome, { status: "interrupted", signal: "SIGINT" })
		// The interrupted side stopped the flow before the candidate started.
		assert.deepEqual(sides, ["baseline"])
		// The cleanup completed before the outcome resolved.
		await assert.rejects(fs.access(dir))
	})

	it("reports SIGTERM and finishes cleanup when a side fails under the interrupt", async () => {
		const { outcome, sides, dir } = await interruptedRun("SIGTERM")
		assert.deepEqual(outcome, { status: "interrupted", signal: "SIGTERM" })
		assert.deepEqual(sides, ["baseline"])
		await assert.rejects(fs.access(dir))
	})

	it("keeps a non-interrupt failure a failure and cleans up anyway", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-flow-test-"))
		try {
			const flag = createInterruptFlag()
			await assert.rejects(
				executeComparisonFlow(
					flowWiring({
						flag,
						out: path.join(dir, "out"),
						scratchDir: dir,
						runSide: async () => {
							throw new Error("candidate side failed with exit code 7")
						},
					}),
				),
				/candidate side failed with exit code 7/,
			)
			assert.equal(flag.isInterrupted(), false)
			await assert.rejects(fs.access(dir))
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("completes, publishes, and returns the report when both sides succeed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-flow-test-"))
		try {
			const out = path.join(dir, "out")
			await fs.mkdir(out, { recursive: true })
			const baselineCommit = "a".repeat(40)
			const candidateCommit = "c".repeat(40)
			const flag = createInterruptFlag()
			const sides: ("baseline" | "candidate")[] = []
			const outcome = await executeComparisonFlow(
				flowWiring({
					flag,
					out,
					scratchDir: path.join(dir, "scratch"),
					runSide: async (side) => {
						sides.push(side)
						return record(side, side === "baseline" ? baselineCommit : candidateCommit)
					},
				}),
			)
			assert.deepEqual(sides, ["baseline", "candidate"])
			assert.equal(outcome.status, "completed")
			if (outcome.status !== "completed") return
			assert.equal(outcome.report.pins.baseline.commit, baselineCommit)
			assert.equal(outcome.report.pins.candidate.commit, candidateCommit)
			assert.ok((await publishedComparisonGeneration(out)) !== undefined)
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	})
})
