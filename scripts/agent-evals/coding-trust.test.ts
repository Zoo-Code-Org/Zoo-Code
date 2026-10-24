import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
	assertCommitsApproved,
	assertCredentialEnvAllowed,
	buildSideEnvironment,
	buildWorktreeEnvironment,
	loadTrustPolicy,
	UntrustedCommitError,
	type TrustPolicy,
} from "./coding-trust.ts"

const sha = (c: string): string => c.repeat(40)

const writePolicy = async (dir: string, content: unknown): Promise<string> => {
	const file = path.join(dir, "trust-policy.json")
	await fs.writeFile(file, JSON.stringify(content))
	return file
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
