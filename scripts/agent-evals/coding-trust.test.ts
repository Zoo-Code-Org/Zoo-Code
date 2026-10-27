import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, it } from "node:test"
import {
	assertCommitsApproved,
	assertCredentialEnvAllowed,
	assertEvaluatedTreeClean,
	buildSideEnvironment,
	buildWorktreeEnvironment,
	DirtyEvaluatedTreeError,
	loadTrustPolicy,
	UntrustedCommitError,
	type TrustPolicy,
} from "./coding-trust.ts"

const execFileAsync = promisify(execFile)
const sha = (c: string): string => c.repeat(40)

// One throwaway repository with one empty commit. It stands in for an
// evaluated root; no code from it ever runs in these checks. The commit
// identity lives in the repository's local config only.
const makeRepo = async (dir: string, name = "repo"): Promise<string> => {
	const repo = path.join(dir, name)
	await fs.mkdir(repo)
	await execFileAsync("git", ["init", "-q"], { cwd: repo })
	// The operator's git config may force signed commits, and the
	// throwaway fixture has no key or tty.
	await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo })
	await execFileAsync("git", ["config", "user.email", "fixture@example.test"], { cwd: repo })
	await execFileAsync("git", ["config", "user.name", "fixture"], { cwd: repo })
	await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "fixture"], { cwd: repo })
	return repo
}

const commitAll = async (repo: string, message: string): Promise<void> => {
	await execFileAsync("git", ["add", "-A"], { cwd: repo })
	// Submodule checkouts are clones without the fixture's local config, so
	// the flags travel with the command instead of any stored config.
	await execFileAsync(
		"git",
		[
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"user.name=fixture",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"-m",
			message,
		],
		{ cwd: repo },
	)
}

const writePolicy = async (dir: string, content: unknown): Promise<string> => {
	const file = path.join(dir, "trust-policy.json")
	await fs.writeFile(file, JSON.stringify(content))
	return file
}

// A superproject with one clean submodule checked out from a throwaway local
// origin. Nothing from it runs in these checks. `name` keeps the on-disk
// repositories of separate cases apart inside one temporary directory.
const makeSuperWithSubmodule = async (dir: string, name: string): Promise<{ superRepo: string; sub: string }> => {
	const origin = await makeRepo(dir, `${name}-origin`)
	await fs.writeFile(path.join(origin, "lib.txt"), "library\n")
	await commitAll(origin, "library")
	const superRepo = await makeRepo(dir, `${name}-super`)
	await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub"], {
		cwd: superRepo,
	})
	await commitAll(superRepo, "submodule")
	return { superRepo, sub: path.join(superRepo, "sub") }
}

describe("trust policy", () => {
	it("loads a policy of full commit SHAs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const file = await writePolicy(dir, { version: 1, approvedCommits: [sha("a"), sha("B")] })
			const policy = await loadTrustPolicy(file)
			assert.deepEqual(policy, { version: 1, approvedCommits: [sha("a"), sha("b")] })
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects missing files, wrong versions, empty lists, and non-SHA entries", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			await assert.rejects(loadTrustPolicy(path.join(dir, "absent.json")), /missing or unreadable/)
			const bad: unknown[] = [
				{ version: 2, approvedCommits: [sha("a")] },
				{ version: 1, approvedCommits: [] },
				{ version: 1, approvedCommits: ["main"] },
				{ version: 1, approvedCommits: [sha("a").slice(0, 8)] },
				{ version: 1, approvedCommits: [`${sha("a")}..${sha("b")}`] },
				{ version: 1, approvedCommits: ["not-a-sha"] },
			]
			for (const content of bad) {
				const file = await writePolicy(dir, content)
				await assert.rejects(loadTrustPolicy(file))
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("approves listed commits and rejects unapproved ones", () => {
		const policy: TrustPolicy = { version: 1, approvedCommits: [sha("a")] }
		assertCommitsApproved(policy, [sha("a")])
		// The gate is case insensitive on the approved side.
		assertCommitsApproved(policy, [sha("A").toUpperCase()])
		assert.throws(() => assertCommitsApproved(policy, [sha("b"), sha("c")]), UntrustedCommitError)
		// The single-commit rejection carries the exact rejected SHA. A silent
		// pass here would approve an untrusted commit, so the assertion names
		// the intended error instead of catching anything.
		assert.throws(
			() => assertCommitsApproved(policy, [sha("b")]),
			(error: unknown) => {
				assert.ok(error instanceof UntrustedCommitError)
				assert.match(error.message, /not approved by the trust policy/)
				assert.deepEqual(error.commits, [sha("b")])
				return true
			},
		)
	})
})

describe("side environment allowlist", () => {
	it("passes only the allowlisted variables, the credential, and the side label", () => {
		const child = buildSideEnvironment(
			{
				PATH: "/usr/bin",
				HOME: "/home/dev",
				SOLHEIM_API_KEY: "sk-test",
				DISPLAY: ":0",
				AWS_SECRET_ACCESS_KEY: "leak-me",
				OTHER_SECRET: "leak-me-too",
			},
			"SOLHEIM_API_KEY",
			"candidate",
		)
		assert.deepEqual(child, {
			PATH: "/usr/bin",
			HOME: "/home/dev",
			DISPLAY: ":0",
			SOLHEIM_API_KEY: "sk-test",
			CODING_EVALS_SIDE: "candidate",
		})
	})

	it("never invents a missing credential variable", () => {
		const child = buildSideEnvironment({ PATH: "/usr/bin" }, "SOLHEIM_API_KEY", "baseline")
		assert.equal(child["SOLHEIM_API_KEY"], undefined)
		assert.equal(child["CODING_EVALS_SIDE"], "baseline")
	})
})

describe("credential environment allowlist", () => {
	it("accepts the supported provider variable", () => {
		assert.doesNotThrow(() => assertCredentialEnvAllowed("SOLHEIM_API_KEY"))
	})

	it("rejects unrelated secret variables before any process starts", () => {
		for (const name of ["AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "PATH"]) {
			assert.throws(() => assertCredentialEnvAllowed(name), /credential environment variable must be one of/)
		}
	})
})

describe("evaluated tree cleanliness gate", () => {
	it("accepts a clean tree", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const repo = await makeRepo(dir)
			await assert.doesNotReject(assertEvaluatedTreeClean(repo))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("accepts a tree with only ignored build artifacts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const repo = await makeRepo(dir)
			await fs.writeFile(path.join(repo, ".gitignore"), "dist\n")
			await execFileAsync("git", ["add", ".gitignore"], { cwd: repo })
			await execFileAsync(
				"git",
				[
					"-c",
					"user.email=fixture@example.test",
					"-c",
					"user.name=fixture",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"-q",
					"-m",
					"ignore",
				],
				{ cwd: repo },
			)
			// Ignored files sit outside commit identity: dependency installs
			// and build outputs never make the tree dirty, and the approval
			// never attests them either.
			await fs.mkdir(path.join(repo, "dist"))
			await fs.writeFile(path.join(repo, "dist", "run.sh"), "#!/bin/sh\n")
			await fs.chmod(path.join(repo, "dist", "run.sh"), 0o755)
			await assert.doesNotReject(assertEvaluatedTreeClean(repo))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects a tracked modification after the commit was approved", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const repo = await makeRepo(dir)
			await fs.writeFile(path.join(repo, "tracked.txt"), "approved\n")
			await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo })
			await execFileAsync(
				"git",
				[
					"-c",
					"user.email=fixture@example.test",
					"-c",
					"user.name=fixture",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"-q",
					"-m",
					"tracked",
				],
				{ cwd: repo },
			)
			await fs.writeFile(path.join(repo, "tracked.txt"), "changed\n")
			await assert.rejects(assertEvaluatedTreeClean(repo), (error: unknown) => {
				assert.ok(error instanceof DirtyEvaluatedTreeError)
				assert.match(error.message, /tracked or untracked changes/)
				assert.ok(error.entries.some((entry) => entry.includes("tracked.txt")))
				return true
			})
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects an untracked file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const repo = await makeRepo(dir)
			await fs.writeFile(path.join(repo, "untracked.txt"), "x")
			await assert.rejects(assertEvaluatedTreeClean(repo), DirtyEvaluatedTreeError)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects untracked files when the caller config tells status to hide them", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			// status.showUntrackedFiles=no makes a plain status report an
			// empty result; the gate must not trust that setting.
			const cases = [
				{
					name: "root",
					makeDirty: async (repo: string) => {
						await fs.writeFile(path.join(repo, "untracked.txt"), "x")
					},
				},
				{
					name: "nested",
					makeDirty: async (repo: string) => {
						await fs.mkdir(path.join(repo, "nested"))
						await fs.writeFile(path.join(repo, "nested", "untracked.txt"), "x")
					},
				},
			]
			for (const [index, { name, makeDirty }] of cases.entries()) {
				const repo = await makeRepo(dir, `hide-untracked-${index}`)
				await execFileAsync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: repo })
				await makeDirty(repo)
				await assert.rejects(assertEvaluatedTreeClean(repo), (error: unknown) => {
					assert.ok(error instanceof DirtyEvaluatedTreeError)
					assert.ok(
						error.entries.some((entry) => entry.includes("untracked.txt")),
						name,
					)
					return true
				})
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects staged changes under the same hiding config", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const cases = [
				{
					name: "staged new file",
					stage: async (repo: string) => {
						await fs.writeFile(path.join(repo, "staged.txt"), "x")
						await execFileAsync("git", ["add", "staged.txt"], { cwd: repo })
					},
				},
				{
					name: "staged modification",
					stage: async (repo: string) => {
						await fs.writeFile(path.join(repo, "tracked.txt"), "approved\n")
						await commitAll(repo, "tracked")
						await fs.writeFile(path.join(repo, "tracked.txt"), "changed\n")
						await execFileAsync("git", ["add", "tracked.txt"], { cwd: repo })
					},
				},
			]
			for (const [index, { name, stage }] of cases.entries()) {
				const repo = await makeRepo(dir, `staged-${index}`)
				await execFileAsync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: repo })
				await stage(repo)
				await assert.rejects(assertEvaluatedTreeClean(repo), (error: unknown) => {
					assert.ok(error instanceof DirtyEvaluatedTreeError, name)
					return true
				})
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("accepts a clean superproject whose submodule the caller config ignores", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const { superRepo } = await makeSuperWithSubmodule(dir, "clean")
			// submodule.<name>.ignore=all must not turn the explicit
			// --ignore-submodules=none scan into a false rejection.
			await execFileAsync("git", ["config", "submodule.sub.ignore", "all"], { cwd: superRepo })
			await assert.doesNotReject(assertEvaluatedTreeClean(superRepo))
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects dirty submodules the caller config ignores", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-test-"))
		try {
			const cases = [
				{
					name: "modified submodule content",
					makeDirty: async (sub: string) => {
						await fs.writeFile(path.join(sub, "lib.txt"), "changed\n")
					},
				},
				{
					name: "untracked submodule content",
					makeDirty: async (sub: string) => {
						await fs.writeFile(path.join(sub, "extra.txt"), "x")
					},
				},
				{
					name: "submodule checked out past the approved commit",
					makeDirty: async (sub: string) => {
						await fs.writeFile(path.join(sub, "lib.txt"), "advanced\n")
						await commitAll(sub, "advance")
					},
				},
			]
			for (const [index, { name, makeDirty }] of cases.entries()) {
				const { superRepo, sub } = await makeSuperWithSubmodule(dir, `dirty-${index}`)
				// ignore=all hides every submodule change from a plain
				// status, so only the gate's explicit flag sees the dirt.
				await execFileAsync("git", ["config", "submodule.sub.ignore", "all"], { cwd: superRepo })
				await makeDirty(sub)
				await assert.rejects(assertEvaluatedTreeClean(superRepo), (error: unknown) => {
					assert.ok(error instanceof DirtyEvaluatedTreeError)
					assert.ok(
						error.entries.some((entry) => entry.includes("sub")),
						name,
					)
					return true
				})
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})

describe("worktree process environment", () => {
	it("passes the install and build allowlist and drops secrets", () => {
		const child = buildWorktreeEnvironment({
			PATH: "/usr/bin",
			HOME: "/home/dev",
			PNPM_HOME: "/home/dev/.local/share/pnpm",
			XDG_DATA_HOME: "/home/dev/.local/share",
			npm_config_registry: "https://registry.example",
			SOLHEIM_API_KEY: "sk-test",
			AWS_SECRET_ACCESS_KEY: "leak-me",
			OTHER_SECRET: "leak-me-too",
			NODE_OPTIONS: "--require /tmp/never",
		})
		assert.deepEqual(child, {
			PATH: "/usr/bin",
			HOME: "/home/dev",
			PNPM_HOME: "/home/dev/.local/share/pnpm",
			XDG_DATA_HOME: "/home/dev/.local/share",
			npm_config_registry: "https://registry.example",
		})
	})

	it("never carries the provider credential into install or build", () => {
		const child = buildWorktreeEnvironment({ PATH: "/usr/bin", SOLHEIM_API_KEY: "sk-test" })
		assert.equal(child["SOLHEIM_API_KEY"], undefined)
	})
})
