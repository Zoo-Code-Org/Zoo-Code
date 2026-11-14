import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { executeSideGeneration, executeSideFlow, type SideRepetition } from "./coding-side-flow.ts"
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

for (const boundary of ["later artifact", "result construction", "result write"] as const) {
	it(`removes all publication output when ${boundary} fails`, async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-publication-failure-"))
		const failure = new Error(`${boundary} failed`)
		const rename = fs.rename
		try {
			// Include an existing marker and substrate artifacts in the rollback.
			await fs.writeFile(path.join(dir, "side-results.json"), "stale")
			t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
				const target = String(args[1])
				if (
					(boundary === "later artifact" && target.endsWith("clamp-range-rep1/run-record.json")) ||
					(boundary === "result write" && target === path.join(dir, "side-results.json"))
				) {
					await fs.access(path.join(dir, "artifacts/clamp-range-rep0/run-record.json"))
					throw failure
				}
				await rename(...args)
			})
			await assert.rejects(
				executeSideFlow({
					repetitions: plan(2),
					out: dir,
					isInterrupted: () => false,
					runRepetition: async (repetition) => {
						const artifactDir = path.join(dir, "artifacts", `clamp-range-rep${repetition.repIndex}`)
						await fs.mkdir(artifactDir, { recursive: true })
						await fs.writeFile(path.join(artifactDir, "trace.json"), "{}")
						return record(repetition, true)
					},
					buildResult: async (runs) => {
						await fs.access(path.join(dir, "artifacts/clamp-range-rep1/run-record.json"))
						if (boundary === "result construction") throw failure
						return { pins: pins(), runs }
					},
				}),
				(error: unknown) => error === failure,
			)
			assert.deepEqual(await fs.readdir(dir), [])
		} finally {
			t.mock.restoreAll()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const failedRemoval of ["side-results.json", "artifacts"] as const) {
	it(`reports failed ${failedRemoval} cleanup and still attempts the other removal`, async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-publication-cleanup-"))
		const remove = fs.rm
		const failure = new Error("result construction failed")
		const cleanupFailure = new Error("cleanup denied")
		const lines: string[] = []
		t.mock.method(console, "error", (line: string) => lines.push(line))
		try {
			await fs.writeFile(path.join(dir, "side-results.json"), "stale")
			t.mock.method(fs, "rm", async (target: string, options: Parameters<typeof fs.rm>[1]) => {
				if (target === path.join(dir, failedRemoval)) throw cleanupFailure
				await remove(target, options)
			})
			await assert.rejects(
				executeSideFlow({
					repetitions: plan(1),
					out: dir,
					isInterrupted: () => false,
					runRepetition: async (repetition) => record(repetition, true),
					buildResult: () => {
						throw failure
					},
				}),
				(error: unknown) => {
					assert.ok(error instanceof AggregateError)
					assert.equal(error.errors[0], failure)
					const cleanup = error.errors[1]
					assert.ok(cleanup instanceof AggregateError)
					assert.deepEqual(cleanup.errors, [cleanupFailure])
					return true
				},
			)
			assert.deepEqual(await fs.readdir(dir), [failedRemoval])
			assert.deepEqual(lines, ["coding-evals publication cleanup failed: Error: cleanup denied"])
		} finally {
			t.mock.restoreAll()
			await remove(dir, { recursive: true, force: true })
		}
	})
}

for (const interrupted of [false, true]) {
	it(`locks standalone generations through cleanup (interrupted=${interrupted})`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-generation-lock-"))
		const alias = `${dir}-alias`
		let signal = false
		let competed = false
		const compete = () =>
			executeSideGeneration({
				out: alias,
				isInterrupted: () => false,
				run: async () => {
					competed = true
				},
				cleanup: async () => {},
			})
		try {
			await fs.symlink(dir, alias)
			await fs.writeFile(path.join(dir, "side-results.json"), "stale")
			await executeSideGeneration({
				out: dir,
				isInterrupted: () => signal,
				run: async () => {
					await assert.rejects(fs.access(path.join(dir, "side-results.json")))
					await fs.mkdir(path.join(dir, "artifacts"))
					await fs.writeFile(path.join(dir, "side-results.json"), "complete")
					await assert.rejects(compete(), /cannot acquire side output lock/)
					assert.equal(await fs.readFile(path.join(dir, "side-results.json"), "utf8"), "complete")
				},
				cleanup: async () => {
					await assert.rejects(compete(), /cannot acquire side output lock/)
					signal = interrupted
				},
			})
			assert.equal(competed, false)
			assert.equal(existsSync(path.join(dir, "side-results.json")), !interrupted)
			assert.equal(existsSync(path.join(dir, "artifacts")), !interrupted)
			// The owner released the lock after cleanup and rollback.
			await compete()
			assert.equal(competed, true)
		} finally {
			await fs.rm(alias, { force: true })
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("releases the side output lock when execution or cleanup throws", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-generation-failure-"))
	try {
		for (const boundary of ["run", "cleanup"]) {
			await assert.rejects(
				executeSideGeneration({
					out: dir,
					isInterrupted: () => false,
					run: async () => {
						if (boundary === "run") throw new Error("run failed")
					},
					cleanup: async () => {
						if (boundary === "cleanup") throw new Error("cleanup failed")
					},
				}),
				/failed/,
			)
			await executeSideGeneration({
				out: dir,
				isInterrupted: () => false,
				run: async () => {},
				cleanup: async () => {},
			})
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	it(
		`rolls back a published generation when ${signal} arrives during final cleanup`,
		{ timeout: 10_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-cleanup-signal-"))
			const { NODE_TEST_CONTEXT: _context, ...env } = process.env
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`
import fs from 'node:fs/promises'
import path from 'node:path'
import { executeSideGeneration } from ${JSON.stringify(new URL("./coding-side-flow.ts", import.meta.url).href)}
import { createInterruptFlag } from ${JSON.stringify(new URL("./side-process-guard.ts", import.meta.url).href)}
const out = ${JSON.stringify(dir)}
const interrupt = createInterruptFlag()
let resume
const received = new Promise(resolve => { resume = resolve })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupt.signal(signal); resume() })
await executeSideGeneration({
  out,
  isInterrupted: interrupt.isInterrupted,
  run: async () => {
    await fs.mkdir(path.join(out, 'artifacts'))
    await fs.writeFile(path.join(out, 'side-results.json'), 'complete')
  },
  cleanup: async () => {
    // Keep the process alive until the signal reaches this final cleanup.
    const keepAlive = setInterval(() => {}, 1000)
    process.stdout.write('ready')
    await received
    clearInterval(keepAlive)
  },
})
process.exit(interrupt.exitCode())
`,
				],
				{ env, stdio: ["ignore", "pipe", "inherit"] },
			)
			const closed = new Promise<number | null>((resolve, reject) => {
				child.once("error", reject)
				child.once("close", resolve)
			})
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("side readiness timeout")), 5000)
					child.stdout.once("data", () => {
						clearTimeout(timer)
						resolve()
					})
					void closed.finally(() => clearTimeout(timer)).catch(() => {})
					child.once("error", reject)
					child.once("exit", () => reject(new Error("side exited before cleanup")))
				})
				await fs.access(path.join(dir, "side-results.json"))
				child.kill(signal)
				const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
				try {
					assert.equal(await closed, signal === "SIGINT" ? 130 : 143)
				} finally {
					clearTimeout(timer)
				}
				assert.deepEqual(await fs.readdir(dir), [])
			} finally {
				child.kill("SIGKILL")
				await closed
				const key = createHash("sha256")
					.update(await fs.realpath(dir))
					.digest("hex")
				await fs.rm(path.join(path.dirname(dir), `.coding-side-${key}.lock`), { recursive: true, force: true })
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
}

for (const disconnectAt of ["before", "during"] as const) {
	it(
		`stops side repetitions and cleans up after parent disconnect ${disconnectAt} execution`,
		{ timeout: 10_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "side-parent-disconnect-"))
			const out = path.join(dir, "out")
			const script = path.join(dir, "side.mts")
			let child: ReturnType<typeof spawn> | undefined
			let closed: Promise<number | null> | undefined
			try {
				await fs.writeFile(
					script,
					`
import fs from 'node:fs/promises'
import path from 'node:path'
import { executeSideGeneration, executeSideFlow } from ${JSON.stringify(new URL("./coding-side-flow.ts", import.meta.url).href)}
import { createInterruptFlag, watchParentConnection } from ${JSON.stringify(new URL("./side-process-guard.ts", import.meta.url).href)}
const out = ${JSON.stringify(out)}
const interrupt = createInterruptFlag()
let finish
const stopped = new Promise(resolve => { finish = resolve })
process.on('SIGTERM', () => { interrupt.signal('SIGTERM'); finish() })
${disconnectAt === "before" ? "process.disconnect()" : ""}
const checkParent = watchParentConnection(() => { process.emit('SIGTERM', 'SIGTERM') })
const isInterrupted = () => { checkParent(); return interrupt.isInterrupted() }
let started = 0
await executeSideGeneration({
 out, isInterrupted,
 run: async () => {
  await executeSideFlow({
   out, isInterrupted, repetitions: ${JSON.stringify(plan(2))},
   runRepetition: async () => {
    started++
    const keepAlive = setInterval(() => {}, 1000)
    process.send?.({ ready: true }, () => {})
    try { await stopped } finally { clearInterval(keepAlive) }
    return ${JSON.stringify(record(plan(1)[0]!))}
   },
   buildResult: runs => ({ pins: ${JSON.stringify(pins())}, runs }),
  })
 },
 cleanup: async () => { await fs.writeFile(${JSON.stringify(path.join(dir, "cleanup"))}, String(started)) },
})
process.exit(interrupt.exitCode())
`,
				)
				const { NODE_TEST_CONTEXT: _context, ...env } = process.env
				child = spawn(process.execPath, ["--import", "tsx", script], {
					env,
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				})
				child.on("message", () => {
					if (child?.connected) child.disconnect()
				})
				closed = new Promise((resolve, reject) => {
					child!.once("error", reject)
					child!.once("exit", resolve)
				})
				const timer = setTimeout(() => child?.kill("SIGKILL"), 5000)
				try {
					assert.equal(await closed, 143)
				} finally {
					clearTimeout(timer)
				}
				assert.equal(
					await fs.readFile(path.join(dir, "cleanup"), "utf8"),
					disconnectAt === "before" ? "0" : "1",
				)
				assert.deepEqual(await fs.readdir(out), [])
			} finally {
				child?.kill("SIGKILL")
				await closed?.catch(() => {})
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
}
