import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
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
					// The live substrate writes artifacts during the repetition.
					const artifactDir = path.join(dir, "artifacts", "clamp-range-rep0")
					await fs.mkdir(artifactDir, { recursive: true })
					await fs.writeFile(path.join(artifactDir, "trace.json"), "{}")
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

	it("prints one bounded diagnostic with the fixture name and repetition index when a repetition throws", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		const lines: string[] = []
		const originalError = console.error
		console.error = (line: string) => lines.push(String(line))
		try {
			const outcome = await flow({
				repetitions: plan(1),
				out: dir,
				isInterrupted: () => false,
				runRepetition: async () => {
					throw new Error("wiring broke")
				},
			})
			assert.equal(outcome.completed, true)
			const failed = outcome.runs[0]
			assert.ok(failed)
			assert.deepEqual(failed.outcome, { outcome: "infrastructure-failure", reason: "runTraceMissing" })
			assert.equal(lines.length, 1)
			assert.match(
				lines[0] ?? "",
				/^coding-evals repetition failed: fixture clamp-range rep 0: Error: wiring broke$/,
			)
		} finally {
			console.error = originalError
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("prints a safe fallback for a non-Error throw and never prints the thrown value", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-flow-test-"))
		const lines: string[] = []
		const originalError = console.error
		console.error = (line: string) => lines.push(String(line))
		try {
			const outcome = await flow({
				repetitions: plan(1),
				out: dir,
				isInterrupted: () => false,
				runRepetition: async () => {
					throw { credential: "not-a-real-credential" }
				},
			})
			const failed = outcome.runs[0]
			assert.ok(failed)
			assert.deepEqual(failed.outcome, { outcome: "infrastructure-failure", reason: "runTraceMissing" })
			assert.equal(lines.length, 1)
			assert.match(lines[0] ?? "", /non-Error value thrown$/)
			// The thrown value itself never reaches the diagnostic.
			assert.ok(!lines[0]?.includes("not-a-real-credential"))
		} finally {
			console.error = originalError
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

// Inject the interrupt at each publication boundary, including after the
// marker write. The observed filesystem state proves each await has finished.
for (const boundary of ["directory", "record", "pins", "marker"] as const) {
	it(`removes partial publication when interrupted after ${boundary}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-publication-"))
		let interrupted = false
		try {
			const exists = (relative: string): boolean => existsSync(path.join(dir, relative))
			const outcome = await executeSideFlow({
				repetitions: plan(1),
				out: dir,
				isInterrupted: () => {
					if (boundary === "directory" && exists("artifacts/clamp-range-rep0")) interrupted = true
					if (boundary === "record" && exists("artifacts/clamp-range-rep0/run-record.json"))
						interrupted = true
					if (boundary === "marker" && exists("side-results.json")) interrupted = true
					return interrupted
				},
				runRepetition: async (repetition) => record(repetition, true),
				buildResult: async (runs) => {
					if (boundary === "pins") interrupted = true
					return { pins: pins(), runs }
				},
			})
			assert.equal(interrupted, true)
			assert.equal(outcome.completed, false)
			assert.deepEqual(await fs.readdir(dir), [])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("removes a failed repetition's partial artifacts before continuing", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-failed-artifacts-"))
	const partial = path.join(dir, "artifacts/clamp-range-rep0")
	try {
		const outcome = await flow({
			repetitions: plan(2),
			out: dir,
			isInterrupted: () => false,
			runRepetition: async (repetition) => {
				if (repetition.repIndex === 0) {
					await fs.mkdir(partial, { recursive: true })
					await fs.writeFile(path.join(partial, "trace.json"), "partial")
					throw new Error("failed after writing trace")
				}
				await assert.rejects(fs.access(partial))
				return record(repetition, true)
			},
		})
		assert.equal(outcome.completed, true)
		assert.equal(outcome.runs[0]?.outcome.outcome, "infrastructure-failure")
		assert.deepEqual(await fs.readdir(path.join(dir, "artifacts")), ["clamp-range-rep1"])
		await fs.access(path.join(dir, "side-results.json"))
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("aborts publication and removes all artifacts if failed-repetition cleanup fails", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-cleanup-failure-"))
	const partial = path.join(dir, "artifacts/clamp-range-rep0")
	const remove = fs.rm
	const lines: string[] = []
	t.mock.method(console, "error", (line: string) => lines.push(line))
	try {
		const executed: number[] = []
		await assert.rejects(
			flow({
				repetitions: plan(2),
				out: dir,
				isInterrupted: () => false,
				runRepetition: async (repetition) => {
					executed.push(repetition.repIndex)
					await fs.mkdir(partial, { recursive: true })
					await fs.writeFile(path.join(partial, "trace.json"), "partial")
					await fs.writeFile(path.join(dir, "side-results.json"), "stale")
					t.mock.method(fs, "rm", async (target: string, options: Parameters<typeof fs.rm>[1]) => {
						if (target === partial) throw new Error("cleanup denied")
						await remove(target, options)
					})
					throw new Error("repetition failed")
				},
			}),
			/repetition artifact cleanup failed/,
		)
		assert.deepEqual(executed, [0])
		assert.deepEqual(await fs.readdir(dir), [])
		assert.match(lines[0] ?? "", /repetition cleanup failed: Error: cleanup denied/)
	} finally {
		t.mock.restoreAll()
		await remove(dir, { recursive: true, force: true })
	}
})
