import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { prepareIsolatedWorktree } from "./coding-compare.ts"
import { createSideProcessGuard } from "./side-process-guard.ts"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, it } from "node:test"
import {
	assertCommitsApproved,
	assertCredentialEnvAllowed,
	assertEvaluatedTreeClean,
	buildSideEnvironment,
	buildContainerCliEnvironment,
	CONTAINER_ENDPOINT_ALLOWLIST,
	buildWorktreeEnvironment,
	DirtyEvaluatedTreeError,
	loadTrustPolicy,
	UntrustedCommitError,
	type TrustPolicy,
} from "./coding-trust.ts"

const execFileAsync = promisify(execFile)
const isolatedGit = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" }
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
		assert.deepEqual(child, { ...isolatedGit, PATH: "/usr/bin" })
	})

	it("never carries the provider credential into install or build", () => {
		const child = buildWorktreeEnvironment({ PATH: "/usr/bin", SOLHEIM_API_KEY: "sk-test" })
		assert.equal(child["SOLHEIM_API_KEY"], undefined)
	})
})

for (const kind of ["symlink", "filter"] as const) {
	it(`rejects unpinned ${kind} content even when git status is clean`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-trust-bytes-"))
		try {
			const repo = await makeRepo(dir)
			if (kind === "symlink") {
				await fs.writeFile(path.join(dir, "outside"), "unapproved")
				await fs.symlink(path.join(dir, "outside"), path.join(repo, "entry"))
			} else {
				await fs.writeFile(path.join(repo, "entry"), "approved\n")
				await fs.writeFile(path.join(repo, ".gitattributes"), "entry filter=fixture\n")
			}
			await commitAll(repo, "entry")
			let checked = repo
			if (kind === "filter") {
				await execFileAsync("git", ["config", "filter.fixture.smudge", "sed s/approved/unpinned/"], {
					cwd: repo,
				})
				await execFileAsync("git", ["config", "filter.fixture.clean", "sed s/unpinned/approved/"], {
					cwd: repo,
				})
				checked = path.join(dir, "checked")
				await execFileAsync("git", ["worktree", "add", "--detach", checked, "HEAD"], { cwd: repo })
				assert.equal(await fs.readFile(path.join(checked, "entry"), "utf8"), "unpinned\n")
			}
			const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: checked })
			assert.equal(stdout, "")
			await assert.rejects(assertEvaluatedTreeClean(checked), DirtyEvaluatedTreeError)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}

describe("container endpoint environment", () => {
	const endpoints = Object.fromEntries(CONTAINER_ENDPOINT_ALLOWLIST.map((name) => [name, `value-${name}`]))
	it("preserves endpoints through the side and CLI while stripping provider and unrelated secrets", () => {
		const side = buildSideEnvironment(
			{
				...endpoints,
				HOME: "/home/operator",
				PATH: "/usr/bin",
				SOLHEIM_API_KEY: "provider-secret",
				OTHER_SECRET: "unrelated-secret",
			},
			"SOLHEIM_API_KEY",
			"baseline",
		)
		assert.equal(side["SOLHEIM_API_KEY"], "provider-secret")
		const expected = { ...isolatedGit, ...endpoints, HOME: "/home/operator", PATH: "/usr/bin" }
		assert.deepEqual(buildContainerCliEnvironment(side), expected)
		for (const [name, value] of Object.entries(endpoints)) assert.equal(side[name], value)
		assert.equal(side["OTHER_SECRET"], undefined)
	})
	it("does not invent missing endpoint settings or a home", () => {
		assert.deepEqual(buildContainerCliEnvironment({ PATH: "/usr/bin" }), { ...isolatedGit, PATH: "/usr/bin" })
	})
})

it("preserves downloader network configuration across both boundaries without forwarding provider secrets", async () => {
	const { buildDownloaderEnvironment } = await import("./coding-trust.ts")
	const network = {
		npm_config_proxy: "http://user:proxy-password@localhost:8080",
		npm_config_https_proxy: "http://user:proxy-password@localhost:8443",
		NODE_EXTRA_CA_CERTS: "/private/ca.pem",
	}
	const env = { ...network, SOLHEIM_API_KEY: "provider-secret", UNRELATED_SECRET: "unrelated" }
	const side = buildSideEnvironment(env, "SOLHEIM_API_KEY", "candidate")
	const child = buildDownloaderEnvironment(side)
	for (const name of Object.keys(network)) {
		assert.equal(buildWorktreeEnvironment(side)[name], undefined)
		assert.equal(buildContainerCliEnvironment(side)[name], undefined)
	}
	assert.equal(child.SOLHEIM_API_KEY, undefined)
	assert.equal(child.UNRELATED_SECRET, undefined)
	assert.deepEqual(child, { ...isolatedGit, ...network })
})

for (const attack of ["filter", "hook"] as const) {
	it(`does not execute source repository ${attack} configuration during checkout`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-worktree-"))
		try {
			const root = await makeRepo(dir)
			await fs.writeFile(path.join(root, ".gitattributes"), "payload filter=planted\n")
			await fs.writeFile(path.join(root, "payload"), "approved bytes")
			await commitAll(root, "payload")
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
			const marker = path.join(dir, "executed")
			const script = path.join(dir, "attack.sh")
			await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 })
			if (attack === "filter") {
				await execFileAsync("git", ["config", "filter.planted.smudge", script], { cwd: root })
				await execFileAsync("git", ["config", "filter.planted.required", "true"], { cwd: root })
			} else {
				const hooks = path.join(dir, "hooks")
				await fs.mkdir(hooks)
				await fs.copyFile(script, path.join(hooks, "post-checkout"))
				await execFileAsync("git", ["config", "core.hooksPath", hooks], { cwd: root })
			}
			const worktree = path.join(dir, "fresh")
			await prepareIsolatedWorktree(createSideProcessGuard(100), () => false, root, stdout.trim(), worktree, 5000)
			assert.equal(await fs.readFile(path.join(worktree, "payload"), "utf8"), "approved bytes")
			await assert.rejects(fs.access(marker))
			await assertEvaluatedTreeClean(worktree)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
}
