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
const runDriver = async (args: readonly string[], cwd: string): Promise<number> => {
	// This test file itself runs under the node:test runner, whose
	// NODE_TEST_CONTEXT would leak into the driver and then into its inner
	// `node --test` children, switching them into runner-child mode with no
	// TAP summary. The driver gets an environment without that variable.
	const { NODE_TEST_CONTEXT: _runnerContext, ...driverEnv } = process.env
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [driverFilePath(), ...args], { cwd, env: driverEnv, stdio: "ignore" })
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
