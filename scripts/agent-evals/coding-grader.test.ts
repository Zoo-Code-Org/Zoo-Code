import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
	createLocalSubprocessGradingRuntime,
	runGrader,
	type DriverCompleted,
	type GraderJob,
	type GraderVerdict,
	type GradingRuntime,
} from "./coding-grader.ts"
import { verdictFromDriver } from "./container-runtime.ts"

const tmpdir = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "coding-grader-test-"))

const writeDriver = async (dir: string, script: string): Promise<string> => {
	const file = path.join(dir, "driver.mjs")
	await fs.writeFile(file, script)
	return file
}

const driverCompleted = (overrides: Partial<DriverCompleted> = {}): DriverCompleted => ({
	kind: "completed",
	passed: true,
	noTestsDiscovered: false,
	testFiles: [],
	passedCount: 3,
	failedCount: 0,
	failures: [],
	durationMs: 1,
	...overrides,
})

const staticRuntime = (verdict: GraderVerdict): GradingRuntime => ({
	isolation: "container",
	run: async () => verdict,
})

const job = async (scratch: string): Promise<GraderJob> => {
	const gradingDir = path.join(scratch, "grading-copy")
	await fs.mkdir(gradingDir, { recursive: true })
	await fs.writeFile(path.join(gradingDir, "marker.txt"), "x")
	return {
		gradingDir,
		driverPath: await writeDriver(scratch, "process.exit(0)"),
		resources: { timeoutMs: 5_000, memoryMb: 256, cpus: 1, pidsLimit: 64, image: "node:22-bookworm" },
	}
}

describe("grader verdict rules", () => {
	it("maps driver results to verdicts", () => {
		assert.equal(verdictFromDriver(driverCompleted(), "container").kind, "passed")
		assert.equal(
			verdictFromDriver(
				driverCompleted({ passed: false, failedCount: 2, failures: [{ name: "x", file: "y" }] }),
				"container",
			).kind,
			"failed",
		)
		assert.deepEqual(verdictFromDriver(driverCompleted({ noTestsDiscovered: true }), "container"), {
			kind: "grading-failure",
			isolation: "container",
			reason: "noTestsDiscovered",
		})
		assert.deepEqual(verdictFromDriver({ kind: "driver-error", message: "boom" }, "container"), {
			kind: "grading-failure",
			isolation: "container",
			reason: "driverError",
		})
	})
})

describe("runGrader", () => {
	it("builds a grading copy and removes it afterwards", async () => {
		const scratch = await tmpdir()
		try {
			let sawGradingDir = false
			const runtime: GradingRuntime = {
				isolation: "container",
				run: async (input) => {
					sawGradingDir = await fs
						.access(path.join(input.gradingDir, "marker.txt"))
						.then(() => true)
						.catch(() => false)
					return { kind: "passed", isolation: "container", result: driverCompleted() }
				},
			}
			const verdict = await runGrader({
				finalFiles: [{ path: "marker.txt", content: "x" }],
				hiddenTests: [],
				resources: { timeoutMs: 1_000, memoryMb: 256, cpus: 1, pidsLimit: 64, image: "node:22-bookworm" },
				runtime,
				scratchDir: scratch,
			})
			assert.equal(verdict.kind, "passed")
			assert.equal(sawGradingDir, true)
			const gradingCopyGone = await fs
				.access(path.join(scratch, "grading-copy"))
				.then(() => false)
				.catch(() => true)
			assert.equal(gradingCopyGone, true)
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})

	it("reports a failed grading copy as grading failure", async () => {
		const scratch = await tmpdir()
		try {
			const verdict = await runGrader({
				finalFiles: [{ path: "../escape.txt", content: "x" }],
				hiddenTests: [],
				resources: { timeoutMs: 1_000, memoryMb: 256, cpus: 1, pidsLimit: 64, image: "node:22-bookworm" },
				runtime: staticRuntime({ kind: "passed", isolation: "container", result: driverCompleted() }),
				scratchDir: scratch,
			})
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "container",
				reason: "gradingCopyFailed",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
})

describe("local subprocess runtime failure paths", () => {
	it("reports a hung grader as graderTimeout", async () => {
		const scratch = await tmpdir()
		try {
			const base = await job(scratch)
			const driverPath = await writeDriver(scratch, "setInterval(() => {}, 1000)")
			const verdict = await createLocalSubprocessGradingRuntime().run({
				...base,
				driverPath,
				resources: { ...base.resources, timeoutMs: 300 },
			})
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "local-subprocess",
				reason: "graderTimeout",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})

	it("reports a crashed grader as graderCrashed", async () => {
		const scratch = await tmpdir()
		try {
			const base = await job(scratch)
			const driverPath = await writeDriver(scratch, "process.exit(3)")
			const verdict = await createLocalSubprocessGradingRuntime().run({ ...base, driverPath })
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "local-subprocess",
				reason: "graderCrashed",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})

	it("reports a silent grader as graderResultMissing", async () => {
		const scratch = await tmpdir()
		try {
			const base = await job(scratch)
			const driverPath = await writeDriver(scratch, "process.exit(0)")
			const verdict = await createLocalSubprocessGradingRuntime().run({ ...base, driverPath })
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "local-subprocess",
				reason: "graderResultMissing",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
})
