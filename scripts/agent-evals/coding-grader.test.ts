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
	cancelledCount: 0,
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
			let createdDir = ""
			const runtime: GradingRuntime = {
				isolation: "container",
				run: async (input) => {
					createdDir = input.gradingDir
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
				.access(createdDir)
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
			await fs.mkdir(path.join(scratch, "grading-copy"))
			await fs.writeFile(path.join(scratch, "grading-copy", "owned"), "prior data")
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
			assert.equal(await fs.readFile(path.join(scratch, "grading-copy", "owned"), "utf8"), "prior data")
			assert.deepEqual(await fs.readdir(scratch), ["grading-copy"])
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})

	it("separates a grader runtime crash from a grading copy failure", async () => {
		const scratch = await tmpdir()
		try {
			const runtime: GradingRuntime = {
				isolation: "container",
				run: async () => {
					throw new Error("runtime exploded")
				},
			}
			const verdict = await runGrader({
				finalFiles: [{ path: "marker.txt", content: "x" }],
				hiddenTests: [],
				resources: { timeoutMs: 1_000, memoryMb: 256, cpus: 1, pidsLimit: 64, image: "node:22-bookworm" },
				runtime,
				scratchDir: scratch,
			})
			// A runtime exception must not be reported as a copy failure, and
			// a failed cleanup must not replace the verdict.
			assert.deepEqual(verdict, {
				kind: "grading-failure",
				isolation: "container",
				reason: "graderRuntimeFailed",
			})
			assert.deepEqual(await fs.readdir(scratch), [])
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

it("kills a stubborn descendant before returning a local grader timeout", async () => {
	const scratch = await tmpdir()
	try {
		const base = await job(scratch)
		// Both processes share the driver's group. The test child ignores
		// SIGTERM, so only group escalation can stop its heartbeat.
		const descendant = path.join(scratch, "descendant.cjs")
		await fs.writeFile(
			descendant,
			`
			const fs = require("node:fs")
			process.on("SIGTERM", () => {})
			fs.writeFileSync(process.argv[2], "started")
			setInterval(() => fs.appendFileSync(process.argv[2], "."), 10)
		`,
		)
		const heartbeat = path.join(scratch, "heartbeat")
		const driverPath = await writeDriver(
			scratch,
			`
			import { spawn } from "node:child_process"
			import path from "node:path"
			const scratch = path.dirname(process.argv[2]) + "/.."
			spawn(process.execPath, [path.join(scratch, "descendant.cjs"), path.join(scratch, "heartbeat")], { stdio: "ignore" })
			setInterval(() => {}, 1000)
		`,
		)
		const verdict = await createLocalSubprocessGradingRuntime().run({
			...base,
			driverPath,
			resources: { ...base.resources, timeoutMs: 1000 },
		})
		assert.deepEqual(verdict, { kind: "grading-failure", isolation: "local-subprocess", reason: "graderTimeout" })
		const before = await fs.readFile(heartbeat, "utf8")
		assert.ok(before.startsWith("started"))
		await new Promise((resolve) => setTimeout(resolve, 100))
		assert.equal(await fs.readFile(heartbeat, "utf8"), before)
		await assert.rejects(fs.access(path.join(scratch, "grading-out")))
	} finally {
		await fs.rm(scratch, { recursive: true, force: true })
	}
})
