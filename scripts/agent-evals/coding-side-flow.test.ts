import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { executeSideFlow, type SideRepetition } from "./coding-side-flow.ts"
import type { CodingRunRecord } from "./coding-run.ts"
import { buildRunMetrics } from "./coding-metrics.ts"
import type { AgentTrace } from "./trace.ts"
import type { SidePins } from "./coding-pins.ts"

const plan = (count: number, fixtureName = "clamp-range"): SideRepetition[] =>
	Array.from({ length: count }, (_, repIndex) => ({ fixtureName, fixtureVersion: "1.0.0", repIndex }))

const record = (repetition: SideRepetition, withTrace = false): CodingRunRecord => ({
	fixtureName: repetition.fixtureName,
	fixtureVersion: repetition.fixtureVersion,
	repIndex: repetition.repIndex,
	outcome: { outcome: "correct", reason: "hiddenTestsPassed" },
	// The flow only checks trace presence before it writes the artifact, so
	// an empty object stands in for the metadata-only trace here.
	trace: withTrace ? ({} as AgentTrace) : undefined,
	metrics: buildRunMetrics({
		fixtureName: repetition.fixtureName,
		repIndex: repetition.repIndex,
		outcome: { outcome: "correct", reason: "hiddenTestsPassed" },
		modelIdentifier: { available: true, value: "test-model" },
	}),
})

const pins = (): SidePins => ({
	side: "candidate",
	commit: "a".repeat(40),
	suiteId: "coding-basic-v1",
	suiteDigest: "d1".repeat(32),
	settingsDigest: "d2".repeat(32),
	modelIdentifier: "test-model",
	graderVersion: "coding-grader-v2",
	graderImageDigest: "unavailable",
	runnerEnvironment: { os: "linux", nodeVersion: process.version, vscodeTarget: "test" },
})

const flow = (inputs: {
	repetitions: readonly SideRepetition[]
	out: string
	isInterrupted: () => boolean
	runRepetition: (repetition: SideRepetition) => Promise<CodingRunRecord>
}) =>
	executeSideFlow({
		...inputs,
		buildResult: (runs) => ({ pins: pins(), runs }),
	})

describe("side execution flow", () => {
	it("runs every repetition and publishes the completion marker last", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		try {
			const executed: string[] = []
			const repetitions = plan(2)
			const outcome = await flow({
				repetitions,
				out: dir,
				isInterrupted: () => false,
				runRepetition: async (repetition) => {
					executed.push(`${repetition.fixtureName}#${repetition.repIndex}`)
					return record(repetition, true)
				},
			})
			assert.equal(outcome.completed, true)
			assert.deepEqual(executed, ["clamp-range#0", "clamp-range#1"])
			// The marker exists and records every run.
			const marker = JSON.parse(await fs.readFile(path.join(dir, "side-results.json"), "utf8")) as {
				runs: { repIndex: number }[]
			}
			assert.deepEqual(
				marker.runs.map((run) => run.repIndex),
				[0, 1],
			)
			// Per-run artifacts exist for the records with a trace.
			const artifact = JSON.parse(
				await fs.readFile(path.join(dir, "artifacts", "clamp-range-rep0", "run-record.json"), "utf8"),
			) as { repIndex: number }
			assert.equal(artifact.repIndex, 0)
			// The atomic publication leaves no temp residue.
			assert.deepEqual((await fs.readdir(path.join(dir, "artifacts", "clamp-range-rep0"))).sort(), [
				"run-record.json",
			])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("stops before the next repetition and publishes nothing when interrupted mid-flow", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		try {
			const repetitions = plan(3)
			let interrupted = false
			const executed: number[] = []
			const outcome = await flow({
				repetitions,
				out: dir,
				isInterrupted: () => interrupted,
				runRepetition: async (repetition) => {
					executed.push(repetition.repIndex)
					// The signal lands during the first repetition.
					interrupted = true
					return record(repetition, true)
				},
			})
			assert.equal(outcome.completed, false)
			// Exactly the in-flight repetition ran; no later repetition started.
			assert.deepEqual(executed, [0])
			assert.equal(outcome.runs.length, 1)
			// The interrupted side publishes neither artifacts nor the marker.
			await assert.rejects(fs.access(path.join(dir, "side-results.json")))
			await assert.rejects(fs.access(path.join(dir, "artifacts")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("does not publish when the interrupt lands after the last repetition", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		try {
			const repetitions = plan(2)
			let completedRepetitions = 0
			const outcome = await flow({
				repetitions,
				out: dir,
				// The flag is read between the loop and the publication, so it
				// goes live once every repetition finished.
				isInterrupted: () => completedRepetitions === repetitions.length,
				runRepetition: async (repetition) => {
					completedRepetitions += 1
					return record(repetition, false)
				},
			})
			assert.equal(outcome.completed, false)
			assert.equal(outcome.runs.length, 2)
			await assert.rejects(fs.access(path.join(dir, "side-results.json")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps running after a wiring error and records it as an infrastructure failure", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		try {
			const repetitions = plan(2)
			const executed: number[] = []
			const outcome = await flow({
				repetitions,
				out: dir,
				isInterrupted: () => false,
				runRepetition: async (repetition) => {
					executed.push(repetition.repIndex)
					if (repetition.repIndex === 0) throw new Error("wiring broke")
					return record(repetition, false)
				},
			})
			assert.equal(outcome.completed, true)
			assert.deepEqual(executed, [0, 1])
			const failed = outcome.runs[0]
			assert.ok(failed)
			assert.deepEqual(failed.outcome, { outcome: "infrastructure-failure", reason: "runTraceMissing" })
			assert.equal(failed.fixtureName, "clamp-range")
			assert.equal(failed.repIndex, 0)
			// A record without a trace writes no artifact; the marker still
			// lists both runs.
			const marker = JSON.parse(await fs.readFile(path.join(dir, "side-results.json"), "utf8")) as {
				runs: unknown[]
			}
			assert.equal(marker.runs.length, 2)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
