import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, it } from "node:test"

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

interface RunOutcome {
	code: number
	stdout: string
	stderr: string
}

// Spawns the real comparison driver with a minimal, credential-free
// environment. The argument gate runs before the trust policy loads, so the
// rejection happens before any worktree, child, or report exists.
const runCompareScript = async (args: string[], env: NodeJS.ProcessEnv): Promise<RunOutcome> => {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--import", "tsx", path.join(repoRoot, "scripts/agent-evals/coding-compare.mts"), ...args],
			{
				cwd: repoRoot,
				timeout: 120_000,
				killSignal: "SIGKILL",
				env,
			},
		)
		return { code: 0, stdout, stderr: "" }
	} catch (error) {
		const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
		if (failure.killed) throw new Error("compare script hung and hit the test kill timer")
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		}
	}
}

const minimalEnv = (): NodeJS.ProcessEnv => ({
	PATH: process.env["PATH"] ?? "/usr/bin:/bin",
	HOME: process.env["HOME"] ?? os.homedir(),
})

describe("coding compare isolation gate", () => {
	it("rejects --allow-unisolated-grading before any worktree or report exists", { timeout: 180_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-compare-test-"))
		try {
			const trustFile = path.join(dir, "trust-policy.json")
			await fs.writeFile(trustFile, JSON.stringify({ version: 1, approvedCommits: [] }))
			const out = path.join(dir, "out")
			const outcome = await runCompareScript(
				[
					"--baseline",
					"a".repeat(40),
					"--candidate",
					"b".repeat(40),
					"--reps",
					"1",
					"--out",
					out,
					"--trust-file",
					trustFile,
					"--allow-unisolated-grading",
				],
				minimalEnv(),
			)
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /--allow-unisolated-grading is not accepted here/)
			// The rejection happens before any report generation exists, so
			// the comparison can never publish host-graded artifacts.
			for (const name of ["comparison-report.json", "comparison-report.md", "comparison-report.complete"]) {
				await assert.rejects(fs.access(path.join(out, name)))
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it(
		"runs past the isolation gate without the flag and fails at the approved-commit check",
		{ timeout: 180_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-compare-test-"))
			try {
				const trustFile = path.join(dir, "trust-policy.json")
				// The empty policy approves nothing, so the trust gate must reject
				// the run. The placeholder credential only proves the failure is
				// not the credential check; no real credential enters this test.
				await fs.writeFile(trustFile, JSON.stringify({ version: 1, approvedCommits: [] }))
				const out = path.join(dir, "out")
				const env = { ...minimalEnv(), SOLHEIM_API_KEY: "not-a-real-credential" }
				const outcome = await runCompareScript(
					[
						"--baseline",
						"a".repeat(40),
						"--candidate",
						"b".repeat(40),
						"--reps",
						"1",
						"--out",
						out,
						"--trust-file",
						trustFile,
					],
					env,
				)
				assert.notEqual(outcome.code, 0)
				// The failure is the approved-commit gate, not the argument gate.
				assert.doesNotMatch(outcome.stderr, /--allow-unisolated-grading is not accepted here/)
				assert.match(outcome.stderr, /trust policy must list at least one approved commit SHA/)
				// The rejection happens before any report generation exists, so
				// the comparison never publishes anything.
				for (const name of ["comparison-report.json", "comparison-report.md", "comparison-report.complete"]) {
					await assert.rejects(fs.access(path.join(out, name)))
				}
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
})
