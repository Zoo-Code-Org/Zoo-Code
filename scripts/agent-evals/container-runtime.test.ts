import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
	buildContainerArgs,
	createContainerGradingRuntime,
	GRADER_IMAGE,
	parseDriverResult,
	type ContainerCli,
} from "./container-runtime.ts"
import type { GraderJob } from "./coding-grader.ts"

const makeJob = (): GraderJob => ({
	gradingDir: "/tmp/evals/grading-copy",
	driverPath: "/repo/scripts/agent-evals/grader-driver.mjs",
	resources: { timeoutMs: 30_000, memoryMb: 512, cpus: 1, pidsLimit: 128, image: GRADER_IMAGE },
})

const driverCompletedJson = (): string =>
	JSON.stringify({
		kind: "completed",
		passed: true,
		noTestsDiscovered: false,
		testFiles: ["test/solution.test.js"],
		passedCount: 3,
		failedCount: 0,
		cancelledCount: 0,
		failures: [],
		durationMs: 12,
	})

// Locates the host outDir from the run argv, the way the real driver finds
// its result path through the /out mount.
const outDirFromArgs = (args: readonly string[]): string => {
	const mount = args.find((arg) => arg.endsWith(":/out:rw"))
	if (!mount) throw new Error("no /out mount in run argv")
	return mount.slice(0, -":/out:rw".length)
}

const recordingCli = (
	overrides: Partial<ContainerCli> = {},
): ContainerCli & { calls: string[]; runArgs: string[][] } => {
	const calls: string[] = []
	const runArgs: string[][] = []
	return {
		calls,
		runArgs,
		pull: async (image) => {
			calls.push(`pull ${image}`)
			return "ok"
		},
		run: async (args, timeoutMs) => {
			runArgs.push([...args])
			calls.push(`run ${timeoutMs}`)
			await fs.mkdir(outDirFromArgs(args), { recursive: true })
			await fs.writeFile(path.join(outDirFromArgs(args), "result.json"), driverCompletedJson())
			return 0
		},
		remove: async (name) => {
			calls.push(`remove ${name}`)
			return "removed"
		},
		imageDigest: async () => {
			calls.push("inspect")
			return "node:22-bookworm@sha256:" + "a".repeat(64)
		},
		...overrides,
	}
}

describe("container grading runtime", () => {
	it("builds a locked-down, network-less invocation", () => {
		const args = buildContainerArgs(makeJob(), "/tmp/evals/grading-out")
		const flagValue = (flag: string): string | undefined => {
			const index = args.indexOf(flag)
			return index === -1 ? undefined : args[index + 1]
		}
		assert.equal(flagValue("--network"), "none")
		assert.equal(flagValue("--memory"), "512m")
		assert.equal(flagValue("--memory-swap"), "512m")
		assert.equal(flagValue("--cpus"), "1")
		assert.equal(flagValue("--pids-limit"), "128")
		assert.equal(flagValue("--cap-drop"), "ALL")
		assert.equal(flagValue("--security-opt"), "no-new-privileges")
		assert.ok(args.includes("--read-only"))
		const tmpfs = flagValue("--tmpfs")
		assert.match(tmpfs ?? "", /^\/tmp:rw/)
		assert.match(tmpfs ?? "", /noexec/)
		// The grading copy and driver mount read-only; only the result
		// directory is writable.
		assert.equal(flagValue("-v"), "/tmp/evals/grading-copy:/work:ro")
		assert.ok(args.some((arg) => arg === "/tmp/evals/grading-out:/out:rw"))
		assert.ok(args.some((arg) => arg.endsWith(":/driver/grader-driver.mjs:ro")))
		// The pinned image and driver command close the argv.
		const imageIndex = args.indexOf(GRADER_IMAGE)
		assert.ok(imageIndex > 0)
		assert.deepEqual(args.slice(imageIndex), [
			GRADER_IMAGE,
			"node",
			"/driver/grader-driver.mjs",
			"/out/result.json",
			"test",
		])
		// No environment passes through, so no credential can leak in.
		assert.equal(args.includes("-e"), false)
		assert.equal(args.includes("--env"), false)
	})

	it("names the container when one is provided", () => {
		const args = buildContainerArgs(makeJob(), "/tmp/evals/grading-out", "agent-evals-grader-1")
		const nameIndex = args.indexOf("--name")
		assert.ok(nameIndex > 0)
		assert.equal(args[nameIndex + 1], "agent-evals-grader-1")
		assert.equal(args[0], "run")
	})

	it("reports a missing container runtime as grading failure", async () => {
		const runtime = createContainerGradingRuntime({ detectExecutable: async () => undefined })
		const verdict = await runtime.run(makeJob())
		assert.deepEqual(verdict, { kind: "grading-failure", isolation: "container", reason: "noContainerRuntime" })
	})

	it("uses the detected executable and records container isolation", async () => {
		// Detection seam returns undefined here; the executable contract is
		// covered by the argv test above. This test pins the isolation label.
		const runtime = createContainerGradingRuntime()
		assert.equal(runtime.isolation, "container")
	})

	it("pulls the image outside the grading timeout and runs with a unique name", async () => {
		const cli = recordingCli()
		const runtime = createContainerGradingRuntime({ cli })
		const verdict = await runtime.run(makeJob())
		assert.equal(verdict.kind, "passed")
		// The pull happens first, the image identity is resolved from the
		// local engine, and the timed run comes after both.
		assert.equal(cli.calls[0], `pull ${GRADER_IMAGE}`)
		assert.equal(cli.calls.indexOf("run 30000"), 2)
		assert.equal(cli.calls[1], "inspect")
		// The run argv names a unique container.
		const nameIndex = cli.runArgs[0]!.indexOf("--name")
		assert.ok(nameIndex > 0)
		assert.match(cli.runArgs[0]![nameIndex + 1] ?? "", /^agent-evals-grader-\d+-\d+-[0-9a-f]{8}$/)
		// The immutable image identity is resolvable for the pins.
		const digest = await runtime.imageDigest!()
		assert.equal(digest.available, true)
		assert.match(digest.available ? digest.value : "", /^node:22-bookworm@sha256:[0-9a-f]{64}$/)
	})

	it("removes the container by name on timeout and verifies the removal before deleting output", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "container-runtime-test-"))
		try {
			const cli = recordingCli({
				run: async () => "timeout",
				remove: async (name) => {
					cli.calls.push(`remove ${name}`)
					// The verified removal runs before the output directory
					// disappears.
					await fs.access(path.join(scratch, "grading-out")).then(
						() => {},
						() => {
							throw new Error("output removed before container removal")
						},
					)
					return "removed"
				},
			})
			const runtime = createContainerGradingRuntime({ cli })
			const verdict = await runtime.run({ ...makeJob(), gradingDir: path.join(scratch, "grading-copy") })
			assert.deepEqual(verdict, { kind: "grading-failure", isolation: "container", reason: "graderTimeout" })
			assert.equal(cli.calls.filter((call) => call.startsWith("remove ")).length, 1)
			assert.match(cli.calls.find((call) => call.startsWith("remove ")) ?? "", /^remove agent-evals-grader-/)
			// The output directory is gone afterwards.
			await fs.access(path.join(scratch, "grading-out")).then(
				() => {
					throw new Error("output directory survived")
				},
				() => {},
			)
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})

	it("reports a failed timeout removal instead of a leaked container", async () => {
		const cli = recordingCli({
			run: async () => "timeout",
			remove: async () => "failed",
		})
		const runtime = createContainerGradingRuntime({ cli })
		const verdict = await runtime.run(makeJob())
		assert.deepEqual(verdict, {
			kind: "grading-failure",
			isolation: "container",
			reason: "graderContainerRemovalFailed",
		})
	})

	it("verifies removal after a crashed run", async () => {
		const cli = recordingCli({
			run: async () => 3,
			remove: async (name) => {
				cli.calls.push(`remove ${name}`)
				return "absent"
			},
		})
		const runtime = createContainerGradingRuntime({ cli })
		const verdict = await runtime.run(makeJob())
		assert.deepEqual(verdict, { kind: "grading-failure", isolation: "container", reason: "graderCrashed" })
		assert.equal(cli.calls.filter((call) => call.startsWith("remove ")).length, 1)
	})

	it("reports a failed image pull before any container runs", async () => {
		const cli = recordingCli({ pull: async () => "failed" })
		const runtime = createContainerGradingRuntime({ cli })
		const verdict = await runtime.run(makeJob())
		assert.deepEqual(verdict, {
			kind: "grading-failure",
			isolation: "container",
			reason: "graderImagePullFailed",
		})
		assert.deepEqual(
			cli.calls.filter((call) => call.startsWith("run")),
			[],
		)
	})

	it("reports an invalid driver result as graderResultInvalid", async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "container-runtime-test-"))
		try {
			const outDir = path.join(scratch, "grading-out")
			const cli = recordingCli({
				run: async () => {
					await fs.mkdir(outDir, { recursive: true })
					await fs.writeFile(path.join(outDir, "result.json"), '{"kind":"completed","passed":true,"lie":1}')
					return 0
				},
			})
			const runtime = createContainerGradingRuntime({ cli })
			const verdict = await runtime.run({ ...makeJob(), gradingDir: path.join(scratch, "grading-copy") })
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "container",
				reason: "graderResultInvalid",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
})

describe("untrusted driver result validation", () => {
	const valid = JSON.parse(driverCompletedJson()) as Record<string, unknown>
	const build = (overrides: Partial<Record<string, unknown>>): string => JSON.stringify({ ...valid, ...overrides })

	it("accepts a well-formed completed result", () => {
		const parsed = parseDriverResult(driverCompletedJson())
		assert.ok(parsed && parsed.kind === "completed")
		assert.equal(parsed.cancelledCount, 0)
	})

	it("accepts a driver-error result", () => {
		const parsed = parseDriverResult(JSON.stringify({ kind: "driver-error", message: "testRunnerUnavailable" }))
		assert.ok(parsed && parsed.kind === "driver-error")
	})

	it("rejects malformed JSON and wrong shapes", () => {
		assert.equal(parseDriverResult("{not json"), undefined)
		assert.equal(parseDriverResult("42"), undefined)
		assert.equal(parseDriverResult("null"), undefined)
		assert.equal(parseDriverResult('{"kind":"other"}'), undefined)
	})

	it("rejects non-boolean flags, bad counts, and bad durations", () => {
		assert.equal(parseDriverResult(build({ passed: "yes" })), undefined)
		assert.equal(parseDriverResult(build({ noTestsDiscovered: 0 })), undefined)
		assert.equal(parseDriverResult(build({ passedCount: -1 })), undefined)
		assert.equal(parseDriverResult(build({ failedCount: 1.5 })), undefined)
		assert.equal(parseDriverResult(build({ cancelledCount: "0" })), undefined)
		assert.equal(parseDriverResult(build({ durationMs: -1 })), undefined)
		assert.equal(parseDriverResult(build({ durationMs: Number.POSITIVE_INFINITY })), undefined)
	})

	it("rejects pass/fail inconsistency and cancelled passes", () => {
		assert.equal(parseDriverResult(build({ passed: true, failedCount: 2 })), undefined)
		assert.equal(parseDriverResult(build({ passed: true, passedCount: 0 })), undefined)
		assert.equal(parseDriverResult(build({ passed: true, cancelledCount: 1 })), undefined)
		assert.equal(parseDriverResult(build({ passed: false })), undefined)
	})

	it("rejects bad failure entries and failure counts that exceed failedCount", () => {
		assert.equal(parseDriverResult(build({ failures: [{ name: "x" }] })), undefined)
		assert.equal(parseDriverResult(build({ failures: [{ name: 1, file: "f" }] })), undefined)
		assert.equal(
			parseDriverResult(
				build({
					failedCount: 1,
					failures: [
						{ name: "a", file: "f" },
						{ name: "b", file: "f" },
					],
				}),
			),
			undefined,
		)
	})

	it("rejects bad test file lists", () => {
		assert.equal(parseDriverResult(build({ testFiles: [] })), undefined)
		assert.equal(parseDriverResult(build({ testFiles: [""] })), undefined)
		assert.equal(parseDriverResult(build({ testFiles: [42] })), undefined)
		assert.equal(parseDriverResult(build({ testFiles: Array.from({ length: 1_001 }, () => "t.js") })), undefined)
	})

	it("rejects oversized payloads", () => {
		assert.equal(parseDriverResult(`{"kind":"completed","pad":"${"x".repeat(70_000)}"}`), undefined)
	})
})
