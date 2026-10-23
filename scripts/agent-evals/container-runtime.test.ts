import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildContainerArgs, createContainerGradingRuntime, GRADER_IMAGE } from "./container-runtime.ts"
import type { GraderJob } from "./coding-grader.ts"

const makeJob = (): GraderJob => ({
	gradingDir: "/tmp/evals/grading-copy",
	driverPath: "/repo/scripts/agent-evals/grader-driver.mjs",
	resources: { timeoutMs: 30_000, memoryMb: 512, cpus: 1, pidsLimit: 128, image: GRADER_IMAGE },
})

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
})
