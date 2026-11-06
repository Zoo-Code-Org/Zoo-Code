import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { driverFilePath } from "./coding-grader.ts"

// Runs the real driver against a real workspace with the real filesystem.
// The driver is the grading publication boundary, so these checks exercise
// the actual temp-write-and-rename behavior, not a stub.
const runDriver = async (args: readonly string[], cwd: string, nodeArgs: readonly string[] = []): Promise<number> => {
	// This test file itself runs under the node:test runner, whose
	// NODE_TEST_CONTEXT would leak into the driver and then into its inner
	// `node --test` children, switching them into runner-child mode with no
	// TAP summary. The driver gets an environment without that variable.
	const { NODE_TEST_CONTEXT: _runnerContext, ...driverEnv } = process.env
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...nodeArgs, driverFilePath(), ...args], {
			cwd,
			env: driverEnv,
			stdio: "ignore",
		})
		child.once("error", reject)
		child.once("close", (code) => resolve(code ?? -1))
	})
}

const passingTest = "import assert from 'node:assert/strict'\nassert.equal(1 + 1, 2)\n"

const writeWorkspace = async (scratch: string): Promise<string> => {
	const workspace = path.join(scratch, "workspace")
	await fs.mkdir(path.join(workspace, "test"), { recursive: true })
	await fs.writeFile(path.join(workspace, "test", "passing.test.mjs"), passingTest)
	return workspace
}

describe("grader driver result publication", () => {
	it(
		"publishes the completed result through a same-directory rename with no temp residue",
		{ timeout: 60_000 },
		async () => {
			const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "grader-driver-test-"))
			try {
				const workspace = await writeWorkspace(scratch)
				const outDir = path.join(scratch, "out")
				const exit = await runDriver([path.join(outDir, "result.json"), "test"], workspace)
				assert.equal(exit, 0)
				const result = JSON.parse(await fs.readFile(path.join(outDir, "result.json"), "utf8")) as {
					kind: string
					passed: boolean
					passedCount: number
				}
				assert.equal(result.kind, "completed")
				assert.equal(result.passed, true)
				assert.equal(result.passedCount, 1)
				// The atomic publication leaves exactly the result file behind.
				assert.deepEqual((await fs.readdir(outDir)).sort(), ["result.json"])
			} finally {
				await fs.rm(scratch, { recursive: true, force: true })
			}
		},
	)

	it("removes the temp file when the rename into place fails", { timeout: 60_000 }, async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "grader-driver-test-"))
		try {
			const workspace = await writeWorkspace(scratch)
			// A directory at the target path makes the rename fail after the
			// temp write succeeded, so the cleanup path is the one under test.
			const blocked = path.join(scratch, "blocked")
			await fs.mkdir(blocked)
			const exit = await runDriver([blocked, "test"], workspace)
			assert.notEqual(exit, 0)
			// Both publication attempts cleaned their temp files.
			const residue = (await fs.readdir(scratch)).filter((name) => name.includes(".tmp"))
			assert.deepEqual(residue, [])
			// The blocked target is untouched.
			assert.equal((await fs.stat(blocked)).isDirectory(), true)
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
})

for (const scenario of [
	"missing",
	"empty",
	"unsupported",
	"passing",
	"failing",
	"cancelled",
	"discovery-error",
	"failure-cap",
] as const) {
	it(`reports every grading field for ${scenario}`, { timeout: 60_000 }, async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "grader-fields-"))
		try {
			const tests = path.join(scratch, "test")
			const out = path.join(scratch, "result.json")
			if (scenario !== "missing") await fs.mkdir(tests)
			if (scenario === "unsupported") await fs.writeFile(path.join(tests, "ignored.test.txt"), "ignored")
			if (scenario === "discovery-error") {
				await fs.rm(tests, { recursive: true })
				await fs.writeFile(tests, "not a directory")
			}
			const source =
				scenario === "passing"
					? passingTest
					: scenario === "failing"
						? "import { test } from 'node:test'; test('wrong', () => { throw new Error('wrong') })"
						: scenario === "cancelled"
							? "import { test } from 'node:test'; test('pending', () => new Promise(() => {}))"
							: scenario === "failure-cap"
								? "import { test } from 'node:test'; for (let i = 0; i < 30; i++) test('wrong-' + i, () => { throw new Error('wrong') })"
								: undefined
			if (source) await fs.writeFile(path.join(tests, "first.test.mjs"), source)
			if (scenario === "failure-cap") await fs.writeFile(path.join(tests, "second.test.mjs"), source!)
			assert.equal(await runDriver([out, "test"], scratch), 0)
			const result = JSON.parse(await fs.readFile(out, "utf8")) as Record<string, unknown>
			if (scenario === "discovery-error") {
				assert.deepEqual(result, {
					kind: "driver-error",
					message: "Error",
				})
				return
			}
			const empty = ["missing", "empty", "unsupported"].includes(scenario)
			const files = empty
				? []
				: [
						path.join("test", "first.test.mjs"),
						...(scenario === "failure-cap" ? [path.join("test", "second.test.mjs")] : []),
					]
			const failures =
				scenario === "failing"
					? [{ name: "wrong", file: files[0] }]
					: scenario === "failure-cap"
						? Array.from({ length: 50 }, (_, i) => ({
								name: `wrong-${i % 30}`,
								file: files[i < 30 ? 0 : 1],
							}))
						: []
			assert.equal(typeof result.durationMs, "number")
			assert.ok(Number(result.durationMs) >= 0)
			assert.deepEqual(
				{ ...result, durationMs: 0 },
				{
					kind: "completed",
					passed: scenario === "passing",
					noTestsDiscovered: empty,
					testFiles: files,
					passedCount: scenario === "passing" ? 1 : 0,
					failedCount: scenario === "failing" ? 1 : scenario === "failure-cap" ? 60 : 0,
					cancelledCount: scenario === "cancelled" ? 1 : 0,
					failures,
					durationMs: 0,
				},
			)
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
}

it("rejects a missing result path", async () => {
	assert.equal(await runDriver([], os.tmpdir()), 2)
})

for (const scenario of ["child-error", "missing-summary"] as const) {
	it(`reports a driver failure for ${scenario}`, async () => {
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "grader-runner-error-"))
		try {
			const workspace = await writeWorkspace(scratch)
			const preload = path.join(scratch, "runner.cjs")
			await fs.writeFile(
				preload,
				`
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
cp.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    ${scenario === "child-error" ? "child.emit('error', new Error('spawn refused'));" : "child.stdout.emit('data', Buffer.from('TAP version 13\\n'));"}
    child.emit('close', 0);
  });
  return child;
};
require('node:module').syncBuiltinESMExports();
`,
			)
			const out = path.join(scratch, "result.json")
			assert.equal(await runDriver([out, "test"], workspace, ["--require", preload]), 0)
			assert.deepEqual(JSON.parse(await fs.readFile(out, "utf8")), {
				kind: "driver-error",
				message: "testRunnerUnavailable",
			})
		} finally {
			await fs.rm(scratch, { recursive: true, force: true })
		}
	})
}
