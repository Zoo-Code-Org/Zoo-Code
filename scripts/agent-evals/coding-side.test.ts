import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
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

// One fixture commit in a throwaway repository. It stands in for an
// evaluated root; no fixture code from it ever runs in these checks. The
// optional files become part of the committed tree.
const makeFixtureCommit = async (
	dir: string,
	files: Record<string, string> = {},
): Promise<{ repo: string; commit: string }> => {
	const repo = path.join(dir, "fixture-repo")
	await fs.mkdir(repo)
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true })
		await fs.writeFile(path.join(repo, name), content)
	}
	await execFileAsync("git", ["init", "-q"], { cwd: repo })
	await execFileAsync("git", ["add", "-A"], { cwd: repo })
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
				// must fail closed at the credential check, before any worktree
				// or container work.
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

// The install behavior of the shimmed toolchain: "succeed" runs the benign
// build, "fail" exits nonzero after the install starts, and "hang" blocks so
// the test can interrupt the side mid-preparation.
type InstallBehavior = "succeed" | "fail" | "hang"

// A pnpm shim that records each invocation, its working directory, and its
// environment, so a test can prove the side prepared and built a fresh tree
// without the credential. The build step writes the benign entry the real
// toolchain would produce, relative to the tree it actually ran in.
const writePnpmShim = async (dir: string, install: InstallBehavior): Promise<string> => {
	const shimDir = path.join(dir, "bin")
	await fs.mkdir(shimDir)
	const log = (name: string): string => JSON.stringify(path.join(dir, name))
	const lines = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> ${log("pnpm-args.log")}`,
		'case "$1" in',
		"  install)",
		`    pwd > ${log("pnpm-install-cwd.log")}`,
		`    env > ${log("pnpm-env.log")}`,
	] as string[]
	if (install === "hang") lines.push("    sleep 30")
	if (install === "fail") lines.push("    exit 1")
	lines.push(
		"    exit 0",
		"    ;;",
		"  build)",
		`    pwd > ${log("pnpm-build-cwd.log")}`,
		`    git rev-parse HEAD > ${log("pnpm-build-head.log")}`,
		"    mkdir -p src/dist",
		"    printf 'benign extension entry\\n' > src/dist/extension.js",
		"    exit 0",
		"    ;;",
		"esac",
		"exit 1",
	)
	await fs.writeFile(path.join(shimDir, "pnpm"), lines.join("\n"), { mode: 0o755 })
	return shimDir
}

const preparedEnv = (dir: string, shimDir: string): NodeJS.ProcessEnv =>
	minimalEnv({ SOLHEIM_API_KEY: "sk-test", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` })

const preparedArgs = (dir: string, repo: string, trustFile: string): string[] => [
	"--reps",
	"1",
	"--out",
	path.join(dir, "out"),
	"--trust-file",
	trustFile,
	"--evaluated-root",
	repo,
]

const runPreparedSide = async (dir: string, repo: string, trustFile: string): Promise<RunOutcome> => {
	const shimDir = await writePnpmShim(dir, "succeed")
	return runSideScript(preparedArgs(dir, repo, trustFile), preparedEnv(dir, shimDir))
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitForFile = async (filePath: string, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (
			await fs.access(filePath).then(
				() => true,
				() => false,
			)
		)
			return
		await delay(20)
	}
	throw new Error(`fixture file never appeared: ${filePath}`)
}

// The repository must hold no linked worktree: its only entry is the main
// tree itself.
const assertSingleWorktree = async (repo: string): Promise<void> => {
	const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo })
	const listed = stdout.split("\n").filter((line) => line.startsWith("worktree "))
	assert.equal(listed.length, 1)
}

// The install and the build must have run in one fresh worktree of the
// approved commit, never in the caller tree. Returns the worktree path, so
// the caller can prove its removal.
const assertPreparationRanInFreshTree = async (dir: string, repo: string, commit: string): Promise<string> => {
	const args = (await fs.readFile(path.join(dir, "pnpm-args.log"), "utf8")).trim().split("\n")
	assert.deepEqual(args, ["install --frozen-lockfile", "build"])
	const installCwd = (await fs.readFile(path.join(dir, "pnpm-install-cwd.log"), "utf8")).trim()
	const buildCwd = (await fs.readFile(path.join(dir, "pnpm-build-cwd.log"), "utf8")).trim()
	const buildHead = (await fs.readFile(path.join(dir, "pnpm-build-head.log"), "utf8")).trim()
	assert.equal(installCwd, buildCwd)
	assert.notEqual(installCwd, repo)
	assert.ok(path.basename(path.dirname(installCwd)).startsWith("coding-evals-side-"))
	assert.equal(buildHead, commit)
	return installCwd
}

interface SideResultsFile {
	pins: { commit: string }
	runs: { outcome: { outcome: string } }[]
}

// The launch fails deterministically because the fixture has no host entry,
// so every repetition is a non-correct record and the side still publishes.
const assertPublishedFailedRuns = async (dir: string, commit: string): Promise<void> => {
	const results = JSON.parse(await fs.readFile(path.join(dir, "out", "side-results.json"), "utf8")) as SideResultsFile
	assert.equal(results.pins.commit, commit)
	assert.ok(results.runs.length >= 1)
	for (const run of results.runs) assert.notEqual(run.outcome.outcome, "correct")
}

describe("coding side evaluated tree preparation", () => {
	it(
		"builds a fresh detached worktree of the approved commit and never loads the caller tree",
		{ timeout: 240_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
			try {
				const { repo, commit } = await makeFixtureCommit(dir, {
					".gitignore": "src/dist\nnode_modules\n",
					"tracked.txt": "committed",
				})
				const trustFile = await writePolicy(dir, [commit])
				// Everything planted below stays outside the approval. The
				// tracked change and the untracked file make the caller tree
				// dirty. The ignored entry and the ignored dependency bin are
				// executable artifacts a real build may never overwrite. If
				// any of them ran, its marker file would exist.
				await fs.writeFile(path.join(repo, "tracked.txt"), "tampered")
				await fs.writeFile(path.join(repo, "untracked.txt"), "untracked")
				const plantedEntry = `require("node:fs").writeFileSync(${JSON.stringify(path.join(repo, "planted-entry-marker"))}, "executed")\n`
				await fs.mkdir(path.join(repo, "src/dist"), { recursive: true })
				await fs.writeFile(path.join(repo, "src/dist/extension.js"), plantedEntry)
				await fs.mkdir(path.join(repo, "node_modules/.bin"), { recursive: true })
				await fs.writeFile(
					path.join(repo, "node_modules/.bin/evil"),
					`#!/bin/sh\nprintf executed > ${JSON.stringify(path.join(repo, "planted-bin-marker"))}\n`,
					{ mode: 0o755 },
				)
				const outcome = await runPreparedSide(dir, repo, trustFile)
				assert.equal(outcome.code, 0)
				assert.ok(outcome.stdout.includes("coding-evals side complete"))
				// No planted artifact executed, and the side never wrote into
				// the caller tree.
				await assert.rejects(fs.access(path.join(repo, "planted-entry-marker")))
				await assert.rejects(fs.access(path.join(repo, "planted-bin-marker")))
				assert.equal(await fs.readFile(path.join(repo, "src/dist/extension.js"), "utf8"), plantedEntry)
				await fs.access(path.join(repo, "node_modules/.bin/evil"))
				// The install and the build ran in one fresh worktree of the
				// approved commit, never in the caller tree.
				const worktree = await assertPreparationRanInFreshTree(dir, repo, commit)
				// Cleanup on the normal path: the worktree and its scratch are
				// gone, and the caller repository holds no linked worktree.
				await assert.rejects(fs.access(worktree))
				await assert.rejects(fs.access(path.dirname(worktree)))
				await assertSingleWorktree(repo)
				// The pins record the approved commit, and the preparation
				// children never saw the credential.
				await assertPublishedFailedRuns(dir, commit)
				const envLog = await fs.readFile(path.join(dir, "pnpm-env.log"), "utf8")
				assert.ok(!envLog.includes("SOLHEIM_API_KEY="))
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)

	it(
		"accepts a clean approved checkout and builds it in a fresh worktree before the first run",
		{ timeout: 240_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
			try {
				const { repo, commit } = await makeFixtureCommit(dir, { ".gitignore": "src/dist\n" })
				const trustFile = await writePolicy(dir, [commit])
				const outcome = await runPreparedSide(dir, repo, trustFile)
				assert.equal(outcome.code, 0)
				assert.ok(outcome.stdout.includes("coding-evals side complete"))
				const worktree = await assertPreparationRanInFreshTree(dir, repo, commit)
				await assert.rejects(fs.access(worktree))
				await assertSingleWorktree(repo)
				await assertPublishedFailedRuns(dir, commit)
				const envLog = await fs.readFile(path.join(dir, "pnpm-env.log"), "utf8")
				assert.ok(!envLog.includes("SOLHEIM_API_KEY="))
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)

	it("removes its worktree when preparation fails", { timeout: 240_000 }, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
		try {
			const { repo, commit } = await makeFixtureCommit(dir, { ".gitignore": "src/dist\nnode_modules\n" })
			const trustFile = await writePolicy(dir, [commit])
			const shimDir = await writePnpmShim(dir, "fail")
			const outcome = await runSideScript(preparedArgs(dir, repo, trustFile), preparedEnv(dir, shimDir))
			assert.notEqual(outcome.code, 0)
			assert.match(outcome.stderr, /pnpm failed: code 1/)
			// The failing install names the worktree it ran in; that tree and
			// its scratch must be gone, and the repository must hold no linked
			// worktree.
			const worktree = (await fs.readFile(path.join(dir, "pnpm-install-cwd.log"), "utf8")).trim()
			await assert.rejects(fs.access(worktree))
			await assert.rejects(fs.access(path.dirname(worktree)))
			await assertSingleWorktree(repo)
			// The build never ran and no results exist.
			await assert.rejects(fs.access(path.join(repo, "src/dist")))
			await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it(
		"removes its worktree when interrupted during preparation and exits with the signal code",
		{ timeout: 240_000 },
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-side-test-"))
			try {
				const { repo, commit } = await makeFixtureCommit(dir, { ".gitignore": "src/dist\nnode_modules\n" })
				const trustFile = await writePolicy(dir, [commit])
				const shimDir = await writePnpmShim(dir, "hang")
				let stderr = ""
				const child = spawn(
					process.execPath,
					[
						"--import",
						"tsx",
						path.join(repoRoot, "scripts/agent-evals/coding-side.mts"),
						...preparedArgs(dir, repo, trustFile),
					],
					{
						cwd: repoRoot,
						env: preparedEnv(dir, shimDir),
						stdio: ["ignore", "ignore", "pipe"],
					},
				)
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString()
				})
				const exitCode = new Promise<number>((resolve, reject) => {
					child.once("error", reject)
					child.once("exit", (code) => resolve(code ?? 1))
				})
				// The install is in flight when the signal arrives. A SIGINT that
				// reaches only the side must stop the preparation group, remove
				// the worktree, and exit with the conventional code.
				await waitForFile(path.join(dir, "pnpm-install-cwd.log"), 60_000)
				child.kill("SIGINT")
				assert.equal(await exitCode, 130)
				assert.match(stderr, /interrupted during preparation/)
				const worktree = (await fs.readFile(path.join(dir, "pnpm-install-cwd.log"), "utf8")).trim()
				await assert.rejects(fs.access(worktree))
				await assert.rejects(fs.access(path.dirname(worktree)))
				await assertSingleWorktree(repo)
				// An interrupted side never publishes the completion marker.
				await assert.rejects(fs.access(path.join(dir, "out", "side-results.json")))
			} finally {
				await fs.rm(dir, { recursive: true, force: true })
			}
		},
	)
})
