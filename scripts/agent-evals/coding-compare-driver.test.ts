import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
	createComparisonScratchDirectory,
	executeComparisonFlow,
	publishedComparisonGeneration,
	readPublishedComparisonReport,
	runCompareSide,
	type CompareSideWiring,
	type ComparisonFlowWiring,
	type SideResultFile,
} from "./coding-compare.ts"
import { executeSideGeneration } from "./coding-side-flow.ts"
import { acquireSideOutputLock } from "./output-lock.ts"
import { buildRunMetrics } from "./coding-metrics.ts"
import type { SidePins } from "./coding-pins.ts"
import { createInterruptFlag, createSideProcessGuard, type InterruptFlag } from "./side-process-guard.ts"

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
	cleanupLockWaitMs: 20,
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
			// Observed before this helper's finally: a removal here would
			// mask a flow cleanup that left the scratch directory behind.
			const scratchDirExists = await fs.access(dir).then(
				() => true,
				() => false,
			)
			return { outcome, sides, scratchDirExists }
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	}

	it("reports SIGINT and finishes cleanup when a side fails under the interrupt", async () => {
		const { outcome, sides, scratchDirExists } = await interruptedRun("SIGINT")
		assert.deepEqual(outcome, { status: "interrupted", signal: "SIGINT" })
		// The interrupted side stopped the flow before the candidate started.
		assert.deepEqual(sides, ["baseline"])
		// The observation happened before the helper's own teardown, so a
		// false value proves the flow's cleanup removed the directory.
		assert.equal(scratchDirExists, false)
	})

	it("reports SIGTERM and finishes cleanup when a side fails under the interrupt", async () => {
		const { outcome, sides, scratchDirExists } = await interruptedRun("SIGTERM")
		assert.deepEqual(outcome, { status: "interrupted", signal: "SIGTERM" })
		assert.deepEqual(sides, ["baseline"])
		assert.equal(scratchDirExists, false)
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	it(`does not publish a report when ${signal} arrives as the candidate returns`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-final-interrupt-"))
		try {
			const flag = createInterruptFlag()
			const out = path.join(dir, "out")
			await fs.mkdir(out)
			const outcome = await executeComparisonFlow(
				flowWiring({
					flag,
					out,
					scratchDir: path.join(dir, "scratch"),
					runSide: async (side) => {
						if (side === "candidate") flag.signal(signal)
						return record(side, COMMIT)
					},
				}),
			)
			assert.deepEqual(outcome, { status: "interrupted", signal })
			assert.deepEqual(await fs.readdir(out), [])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("removes a published generation when interrupted during final cleanup", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-cleanup-interrupt-"))
	try {
		const flag = createInterruptFlag()
		const out = path.join(dir, "out")
		await fs.mkdir(out)
		const wiring = flowWiring({
			flag,
			out,
			scratchDir: path.join(dir, "scratch"),
			runSide: async (side) => record(side, COMMIT),
		})
		wiring.interruptKill = async () => {
			assert.ok(await publishedComparisonGeneration(out))
			flag.signal("SIGINT")
		}
		assert.deepEqual(await executeComparisonFlow(wiring), { status: "interrupted", signal: "SIGINT" })
		assert.deepEqual(await fs.readdir(out), [])
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it("invalidates previous reports before a side starts and removes reports on failure", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-stale-"))
	const out = path.join(dir, "out")
	const names = ["comparison-report.complete", "comparison-report.json", "comparison-report.md"]
	try {
		await fs.mkdir(out)
		await Promise.all(names.map((name) => fs.writeFile(path.join(out, name), "stale")))
		await assert.rejects(
			executeComparisonFlow(
				flowWiring({
					flag: createInterruptFlag(),
					out,
					scratchDir: path.join(dir, "scratch"),
					runSide: async () => {
						assert.deepEqual(await fs.readdir(out), [])
						await fs.writeFile(path.join(out, names[0]!), "partial")
						throw new Error("side failed")
					},
				}),
			),
			/side failed/,
		)
		assert.deepEqual(await fs.readdir(out), [])
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
})

it(
	"waits for timeout termination without sending a delayed kill after side cleanup",
	{ timeout: 10_000 },
	async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-timeout-"))
		const originalKill = process.kill
		const kills: NodeJS.Signals[] = []
		t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === "SIGKILL") kills.push(signal)
			return originalKill(pid, signal)
		})
		try {
			const fixture = path.join(dir, "side.cjs")
			await fs.writeFile(fixture, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)")
			const tracked: (number | undefined)[] = []
			const wiring = sideWiring({
				flag: createInterruptFlag(),
				tracked,
				sideScript: fixture,
				createSideOutDir: async (out) => {
					await fs.mkdir(out, { recursive: true })
				},
			})
			await assert.rejects(
				runCompareSide("baseline", COMMIT, dir, { ...wiring, sideTimeoutMs: 500, killGraceMs: 200 }),
				/side failed/,
			)
			assert.equal(tracked.at(-1), undefined)
			await new Promise((resolve) => setTimeout(resolve, 300))
			assert.deepEqual(kills, [])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	},
)

it("attempts every report removal and refuses to start sides when invalidation fails", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-cleanup-"))
	const out = path.join(dir, "out")
	const remove = fs.rm
	const removed: string[] = []
	let started = false
	t.mock.method(fs, "rm", async (target: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
		if (String(target).startsWith(out + path.sep)) {
			removed.push(path.basename(String(target)))
			if (String(target).endsWith("comparison-report.complete")) throw new Error("marker removal refused")
		}
		await remove(target, options)
	})
	try {
		await fs.mkdir(out)
		await fs.writeFile(path.join(out, "comparison-report.complete"), "stale")
		await assert.rejects(
			executeComparisonFlow(
				flowWiring({
					flag: createInterruptFlag(),
					out,
					scratchDir: path.join(dir, "scratch"),
					runSide: async (side) => {
						started = true
						return record(side, COMMIT)
					},
				}),
			),
			AggregateError,
		)
		assert.equal(started, false)
		for (const name of ["comparison-report.complete", "comparison-report.json", "comparison-report.md"])
			assert.ok(removed.includes(name))
	} finally {
		await remove(dir, { recursive: true, force: true })
	}
})

for (const fails of [false, true]) {
	it(`excludes overlapping comparisons through ${fails ? "failure" : "successful"} cleanup`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-overlap-"))
		let release: () => void = () => {}
		let entered: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const out = path.join(dir, "out")
		const first = flowWiring({
			flag: createInterruptFlag(),
			out,
			scratchDir: path.join(dir, "first"),
			runSide: async (side) => record(side, COMMIT),
		})
		first.interruptKill = async () => {
			entered()
			await gate
		}
		if (fails)
			first.runSide = async () => {
				throw new Error("first failed")
			}
		const running = executeComparisonFlow(first)
		const settled = running.then(
			() => undefined,
			(error: unknown) => error,
		)
		try {
			await started
			const before = await publishedComparisonGeneration(out)
			let ran = false
			const second = flowWiring({
				flag: createInterruptFlag(),
				out,
				scratchDir: path.join(dir, "second"),
				runSide: async (side) => {
					ran = true
					return record(side, COMMIT)
				},
			})
			await fs.symlink(out, path.join(dir, "alias"))
			await assert.rejects(executeComparisonFlow({ ...second, out: path.join(dir, "alias") }), /output lock/)
			assert.equal(ran, false)
			assert.equal(await publishedComparisonGeneration(out), before)
			if (!fails) assert.equal((await readPublishedComparisonReport(out))?.pins.baseline.commit, COMMIT)
			release()
			const error = await settled
			assert.equal(error instanceof Error, fails)
			assert.equal((await executeComparisonFlow(second)).status, "completed")
			assert.equal((await readPublishedComparisonReport(out))?.pins.baseline.commit, COMMIT)
		} finally {
			release()
			await settled
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const side of ["baseline", "candidate"] as const) {
	it(`preserves scratch output owned by a standalone ${side} side during cleanup`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-owned-scratch-"))
		const scratchDir = path.join(dir, "scratch")
		const sideOut = path.join(scratchDir, `${side}-out`)
		let release: (() => void) | undefined
		try {
			await assert.rejects(
				executeComparisonFlow(
					flowWiring({
						flag: createInterruptFlag(),
						out: path.join(dir, "out"),
						scratchDir,
						runSide: async (current) => {
							if (current === "candidate") {
								release = await acquireSideOutputLock(sideOut)
								await fs.writeFile(path.join(sideOut, "side-results.json"), "owned")
							}
							return record(current, COMMIT)
						},
					}),
				),
				/cannot acquire side output lock/,
			)
			assert.equal(await fs.readFile(path.join(sideOut, "side-results.json"), "utf8"), "owned")
			await assert.rejects(fs.access(path.join(dir, "out", "comparison-report.complete")))
		} finally {
			release?.()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

it("excludes another process with a different TMPDIR during publication cleanup", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-process-lock-"))
	const out = path.join(dir, "out")
	let release = () => {}
	let entered = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const ready = new Promise<void>((resolve) => {
		entered = resolve
	})
	const first = flowWiring({
		flag: createInterruptFlag(),
		out,
		scratchDir: path.join(dir, "first"),
		runSide: async (side) => record(side, COMMIT),
	})
	first.interruptKill = async () => {
		entered()
		await gate
	}
	const running = executeComparisonFlow(first)
	try {
		await ready
		const before = await publishedComparisonGeneration(out)
		const otherTmp = path.join(dir, "other-tmp")
		await fs.mkdir(otherTmp)
		const source = `
import { executeComparisonFlow } from ${JSON.stringify(new URL("./coding-compare.ts", import.meta.url).href)};
try {
 await executeComparisonFlow({
  out: ${JSON.stringify(out)}, scratchDir: ${JSON.stringify(path.join(dir, "second"))}, root: ${JSON.stringify(repoRoot)}, reps: 1,
  runSide: async () => { throw new Error('must not run') },
  interruptedSignal: () => undefined, interruptKill: async () => {}
 });
 process.exitCode = 2;
} catch (error) { process.exitCode = /cannot acquire comparison output lock/.test(error.message) ? 0 : 3 }
`
		const { NODE_TEST_CONTEXT: _context, ...env } = process.env
		const exit = await new Promise<number | null>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
				cwd: repoRoot,
				env: { ...env, TMPDIR: otherTmp },
				stdio: "inherit",
			})
			child.once("error", reject)
			child.once("close", resolve)
		})
		assert.equal(exit, 0)
		assert.equal(await publishedComparisonGeneration(out), before)
	} finally {
		release()
		await running
		await fs.rm(dir, { recursive: true, force: true })
	}
})

for (const alias of [false, true]) {
	it(`rejects comparison output inside a side generation before rollback (alias: ${alias})`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-side-rollback-"))
		const sideOut = path.join(dir, "side")
		const artifacts = path.join(sideOut, "artifacts")
		let interrupted = false
		let started = false
		try {
			await executeSideGeneration({
				out: sideOut,
				isInterrupted: () => interrupted,
				run: async () => {
					await fs.mkdir(artifacts)
					await fs.writeFile(path.join(artifacts, "owned"), "side data")
					const parent = alias ? path.join(dir, "alias") : artifacts
					if (alias) await fs.symlink(artifacts, parent)
					const out = path.join(parent, "nested", "report")
					await assert.rejects(
						executeComparisonFlow(
							flowWiring({
								flag: createInterruptFlag(),
								out,
								scratchDir: path.join(dir, "scratch"),
								runSide: async (side) => {
									started = true
									return record(side, COMMIT)
								},
							}),
						),
						/comparison output cannot be inside a managed artifacts tree/,
					)
					assert.equal(started, false)
					assert.deepEqual(await fs.readdir(artifacts), ["owned"])
					await assert.rejects(fs.access(out))
					await assert.rejects(fs.access(path.join(dir, "scratch")))
				},
				cleanup: async () => {
					interrupted = true
				},
			})
			await assert.rejects(fs.access(artifacts))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const code of ["EACCES", "EROFS", "EEXIST"]) {
	it(`preserves comparison lock acquisition diagnostics for ${code}`, async (t) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-lock-error-"))
		const mkdir = fs.mkdir
		const failure = Object.assign(new Error("lock creation failed"), { code })
		let lockPath = ""
		t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
			if (path.basename(String(args[0])).startsWith(".coding-comparison-")) {
				lockPath = String(args[0])
				throw failure
			}
			return mkdir(...args)
		})
		try {
			await assert.rejects(
				executeComparisonFlow(
					flowWiring({
						flag: createInterruptFlag(),
						out: path.join(dir, "out"),
						scratchDir: path.join(dir, "scratch"),
						runSide: async () => {
							throw new Error("must not run")
						},
					}),
				),
				(error: unknown) => {
					if (code !== "EEXIST") return error === failure
					assert.ok(error instanceof Error)
					assert.ok(error.message.includes(lockPath))
					assert.match(error.message, /another comparison may be running/)
					return true
				},
			)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const location of ["ordinary", "artifacts", "alias"] as const) {
	it(`validates the ${location} comparison scratch parent before creating a generation`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-scratch-policy-"))
		try {
			const protectedParent = path.join(dir, "artifacts")
			await fs.mkdir(protectedParent)
			const alias = path.join(dir, "alias")
			await fs.symlink(protectedParent, alias)
			const parent = location === "ordinary" ? dir : location === "alias" ? alias : protectedParent
			if (location === "ordinary") {
				const scratch = await createComparisonScratchDirectory(parent)
				assert.equal(path.dirname(scratch), await fs.realpath(parent))
				assert.deepEqual(await fs.readdir(scratch), [])
				const release = await acquireSideOutputLock(path.join(scratch, "baseline-out"))
				release()
			} else {
				await assert.rejects(createComparisonScratchDirectory(parent), /set TMPDIR/)
				assert.deepEqual(await fs.readdir(protectedParent), [])
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const boundary of ["output", "lock"] as const) {
	it(`removes empty comparison scratch when ${boundary} preparation fails`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compare-early-cleanup-"))
		try {
			const scratchDir = await createComparisonScratchDirectory(dir)
			const out = boundary === "output" ? path.join(dir, "artifacts", "out") : path.join(dir, "out")
			let lock: string | undefined
			if (boundary === "lock") {
				await fs.mkdir(out)
				const key = createHash("sha256")
					.update(await fs.realpath(out))
					.digest("hex")
				lock = path.join(dir, `.coding-comparison-${key}.lock`)
				await fs.mkdir(lock)
			}
			await assert.rejects(
				executeComparisonFlow(
					flowWiring({
						flag: createInterruptFlag(),
						out,
						scratchDir,
						runSide: async () => {
							assert.fail("side must not start")
						},
					}),
				),
				boundary === "output" ? /managed artifacts tree/ : /comparison output lock/,
			)
			await assert.rejects(fs.access(scratchDir))
			if (lock) await fs.access(lock)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const interrupted of [false, true]) {
	it(`preserves ${interrupted ? "interruption" : "the original error"} when scratch cleanup fails`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-cleanup-errors-"))
		let release: (() => void) | undefined
		try {
			const flag = createInterruptFlag()
			const original = new Error("original side failure")
			const result = executeComparisonFlow(
				flowWiring({
					flag,
					out: path.join(dir, "out"),
					scratchDir: path.join(dir, "scratch"),
					runSide: async () => {
						release = await acquireSideOutputLock(path.join(dir, "scratch", "baseline-out"))
						if (interrupted) flag.signal("SIGTERM")
						throw original
					},
				}),
			)
			if (interrupted) assert.deepEqual(await result, { status: "interrupted", signal: "SIGTERM" })
			else
				await assert.rejects(result, (error: unknown) => {
					assert.ok(error instanceof AggregateError)
					assert.equal(error.errors[0], original)
					assert.match(String(error.errors[1]), /cannot acquire side output lock/)
					return true
				})
		} finally {
			release?.()
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

for (const interruption of ["signal", "timeout"] as const) {
	it(
		`reaps a detached SIGTERM-resistant preparation child after side ${interruption}`,
		{ timeout: 10_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-stubborn-preparation-"))
			const scratchDir = path.join(dir, "scratch")
			const heartbeat = path.join(dir, "heartbeat")
			const flag = createInterruptFlag()
			const guard = createSideProcessGuard(100)
			let termination: Promise<unknown> = Promise.resolve()
			let pending: Promise<unknown> | undefined
			try {
				await fs.mkdir(scratchDir)
				const sideScript = path.join(dir, "side.mts")
				await fs.writeFile(
					sideScript,
					`
import { runBoundedPreparation } from ${JSON.stringify(new URL("./coding-compare.ts", import.meta.url).href)}
import { createSideProcessGuard } from ${JSON.stringify(new URL("./side-process-guard.ts", import.meta.url).href)}
// Simulate a side that cannot run its own shutdown handler.
process.on('SIGTERM', () => {})
await runBoundedPreparation(createSideProcessGuard(50), () => false, process.execPath, ['-e', ${JSON.stringify(`
const fs = require('node:fs')
process.on('SIGTERM', () => {})
fs.writeFileSync(${JSON.stringify(heartbeat)}, 'ready')
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10)
`)}], ${JSON.stringify(dir)}, 60000)
`,
				)
				pending = executeComparisonFlow({
					...flowWiring({
						flag,
						out: path.join(dir, "out"),
						scratchDir,
						runSide: async (side) =>
							runCompareSide(side, COMMIT, scratchDir, {
								...sideWiring({
									flag,
									tracked: [],
									sideScript,
									createSideOutDir: async (out) => {
										await fs.mkdir(out, { recursive: true })
									},
								}),
								guard,
								sideTimeoutMs: interruption === "timeout" ? 1000 : 60000,
								killGraceMs: 100,
							}),
					}),
					interruptKill: () => termination,
				})
				// Handle rejection immediately while waiting for readiness.
				void pending.catch(() => {})
				const deadline = Date.now() + 5000
				while (
					!(await fs.access(heartbeat).then(
						() => true,
						() => false,
					))
				) {
					if (Date.now() > deadline) throw new Error("preparation did not start")
					await new Promise((resolve) => setTimeout(resolve, 20))
				}
				if (interruption === "signal") {
					flag.signal("SIGTERM")
					termination = guard.interrupt()
					assert.deepEqual(await pending, { status: "interrupted", signal: "SIGTERM" })
				} else await assert.rejects(pending, /baseline side failed/)
				const stopped = await fs.readFile(heartbeat, "utf8")
				await new Promise((resolve) => setTimeout(resolve, 100))
				assert.equal(await fs.readFile(heartbeat, "utf8"), stopped)
				await assert.rejects(fs.access(scratchDir))
			} finally {
				await guard.interrupt()
				await pending?.catch(() => {})
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
}
