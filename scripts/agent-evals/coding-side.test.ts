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

// Spawns the real side script with a minimal, credential-free environment.
// tsx resolves from the repository the same way the package scripts resolve
// it. The trust gate runs before any host creation, so these checks never
// download VS Code and never touch a provider.
const runSideScript = async (args: string[], env: NodeJS.ProcessEnv): Promise<RunOutcome> => {
	try {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--import", "tsx", path.join(repoRoot, "scripts/agent-evals/coding-side.mts"), ...args],
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
		if (failure.killed) throw new Error("side script hung and hit the test kill timer")
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		}
	}
}

const minimalEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
	PATH: process.env["PATH"] ?? "/usr/bin:/bin",
	HOME: process.env["HOME"] ?? os.homedir(),
	...extra,
})

const writePolicy = async (dir: string, approvedCommits: string[]): Promise<string> => {
	const file = path.join(dir, "trust-policy.json")
	await fs.writeFile(file, JSON.stringify({ version: 1, approvedCommits }))
	return file
}

// One empty fixture commit in a throwaway repository. It stands in for an
// evaluated root; no fixture code from it ever runs in these checks.
const makeFixtureCommit = async (dir: string): Promise<{ repo: string; commit: string }> => {
	const repo = path.join(dir, "fixture-repo")
	await fs.mkdir(repo)
	await execFileAsync("git", ["init", "-q"], { cwd: repo })
	await execFileAsync(
		"git",
		[
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"user.name=fixture",
			// The operator's git config may force signed commits, and the
			// throwaway fixture has no key or tty.
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"fixture",
		],
		{ cwd: repo },
	)
	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })
	return { repo, commit: stdout.trim() }
}

describe("coding side trust gate", () => {
	it(
		"rejects a dirty approved evaluated root before any host launch or publication",
		{ timeout: 180_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
			try {
				const { repo, commit } = await makeFixtureCommit(dir)
				const trustFile = await writePolicy(dir, [commit])
				// The approved checkout is modified after approval: one staged
				// tracked change and one untracked file. The commit identity is
				// still approved, but it no longer describes the tree.
				await fs.writeFile(path.join(repo, "tracked.txt"), "changed")
				await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo })
				await fs.writeFile(path.join(repo, "untracked.txt"), "untracked")
				// The fake credential only proves the failure is not the
				// credential check: the cleanliness gate must stop the side first.
				const outcome = await runSideScript(
					[
						"--reps",
						"1",
						"--out",
						path.join(dir, "out"),
						"--trust-file",
						trustFile,
						"--evaluated-root",
						repo,
					],
					minimalEnv({ SOLHEIM_API_KEY: "sk-test" }),
				)
				assert.notEqual(outcome.code, 0)
				assert.match(outcome.stderr, /tracked or untracked changes/)
				assert.ok(!outcome.stdout.includes("coding-evals side complete"))
				// The rejection happens before the publication point: no side
				// results and no artifacts exist.
				await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
				await assert.rejects(fs.access(path.join(dir, "out", "artifacts")))
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)

	it("rejects an unapproved evaluated root before any host launch", { timeout: 180_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
		try {
			const { repo, commit } = await makeFixtureCommit(dir)
			// The policy approves a different commit, so the fixture root is
			// untrusted.
			const trustFile = await writePolicy(dir, ["b".repeat(40)])
			const outcome = await runSideScript(
				["--reps", "1", "--out", path.join(dir, "out"), "--trust-file", trustFile, "--evaluated-root", repo],
				minimalEnv({ SOLHEIM_API_KEY: "sk-test" }),
			)
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /commits not approved by the trust policy/)
			assert.ok(outcome.stderr.includes(commit.slice(0, 8)))
			// The rejection happens before the run loop: nothing completed and
			// no results file exists.
			assert.ok(!outcome.stdout.includes("coding-evals side complete"))
			await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unrelated secret variable before any process starts", { timeout: 180_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
		try {
			const { repo, commit } = await makeFixtureCommit(dir)
			// The root is approved; the credential variable name is not.
			const trustFile = await writePolicy(dir, [commit])
			const outcome = await runSideScript(
				[
					"--reps",
					"1",
					"--out",
					path.join(dir, "out"),
					"--trust-file",
					trustFile,
					"--evaluated-root",
					repo,
					"--credential-env",
					"AWS_SECRET_ACCESS_KEY",
				],
				minimalEnv({ AWS_SECRET_ACCESS_KEY: "leak-me" }),
			)
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /credential environment variable must be one of/)
			assert.ok(!outcome.stdout.includes("coding-evals side complete"))
			await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it(
		"accepts an approved root and stops at the credential check without launching a host",
		{ timeout: 180_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
			try {
				const { repo, commit } = await makeFixtureCommit(dir)
				const trustFile = await writePolicy(dir, [commit])
				// No credential variable is set. The gate must pass and the run
				// must fail closed at the credential check, before any host or
				// container work.
				const outcome = await runSideScript(
					[
						"--reps",
						"1",
						"--out",
						path.join(dir, "out"),
						"--trust-file",
						trustFile,
						"--evaluated-root",
						repo,
					],
					minimalEnv(),
				)
				assert.notEqual(outcome.code, 0)
				assert.match(
					outcome.stderr,
					/provider credential environment variable SOLHEIM_API_KEY is unset or empty/,
				)
				assert.ok(!outcome.stdout.includes("coding-evals side complete"))
				await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
})

describe("coding side isolation gate", () => {
	it("rejects --allow-unisolated-grading before any run or artifact exists", { timeout: 180_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
		try {
			// The argument gate runs before the trust policy loads, so no
			// fixture commit is needed and no credential is read.
			const trustFile = await writePolicy(dir, [])
			const outcome = await runSideScript(
				[
					"--reps",
					"1",
					"--out",
					path.join(dir, "out"),
					"--trust-file",
					trustFile,
					"--allow-unisolated-grading",
				],
				minimalEnv({ SOLHEIM_API_KEY: "sk-test" }),
			)
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /--allow-unisolated-grading is not accepted here/)
			assert.ok(!outcome.stdout.includes("coding-evals side complete"))
			// The rejection happens before any directory or result file
			// exists, so the side can never publish host-graded artifacts.
			await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
