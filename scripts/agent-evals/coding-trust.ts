import fs from "node:fs/promises"

// Trust policy for paired comparisons. A comparison executes the extension
// code of two commits with the provider credential. Nothing about a ref name
// proves trust: a policy that resolved arbitrary refs and called them trusted
// would approve anything. The operator therefore lists approved full commit
// SHAs in an explicit policy file, and the driver rejects any other resolved
// commit before it creates a worktree or spawns a process.
export interface TrustPolicy {
	version: 1
	approvedCommits: string[]
}

// Git prints lowercase SHAs, but the policy accepts either case and the
// loader normalizes to lowercase.
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/

export class UntrustedCommitError extends Error {
	constructor(readonly commits: string[]) {
		super(`commits not approved by the trust policy: ${commits.join(", ")}`)
		this.name = "UntrustedCommitError"
	}
}

// Loads and validates one trust policy file. Every approved commit must be a
// full, lowercase-or-uppercase 40-hex SHA; short SHAs, ref names, and ranges
// are rejected.
export async function loadTrustPolicy(filePath: string): Promise<TrustPolicy> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
	} catch {
		throw new Error(`trust policy file is missing or unreadable: ${filePath}`)
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("trust policy must be a JSON object")
	const record = parsed as Record<string, unknown>
	if (record["version"] !== 1) throw new Error("trust policy version must be 1")
	const commits = record["approvedCommits"]
	if (!Array.isArray(commits) || commits.length === 0) {
		throw new Error("trust policy must list at least one approved commit SHA")
	}
	const invalid = commits.filter((entry) => typeof entry !== "string" || !SHA_PATTERN.test(entry))
	if (invalid.length > 0) throw new Error("trust policy accepts only full 40-hex commit SHAs")
	return { version: 1, approvedCommits: (commits as string[]).map((sha) => sha.toLowerCase()) }
}

// Resolves one ref or SHA to a full commit SHA through the local repository.
export const resolveCommit = async (ref: string, root: string): Promise<string> => {
	const { execFile } = await import("node:child_process")
	const { promisify } = await import("node:util")
	const { stdout } = await promisify(execFile)("git", ["rev-parse", `${ref}^{commit}`], {
		cwd: root,
		timeout: 30_000,
	})
	const sha = stdout.trim().toLowerCase()
	if (!SHA_PATTERN.test(sha)) throw new Error(`cannot resolve a full commit SHA from ${ref}`)
	return sha
}

// Gate before any execution. Each resolved commit must appear in the policy.
export function assertCommitsApproved(policy: TrustPolicy, commits: readonly string[]): void {
	const unapproved = commits.filter((sha) => !policy.approvedCommits.includes(sha.toLowerCase()))
	if (unapproved.length > 0) throw new UntrustedCommitError(unapproved)
}

// Provider credential variables this framework supports. The side script and
// the comparison driver accept only these names, so the tooling can never be
// pointed at an unrelated parent secret by naming an arbitrary variable.
export const CREDENTIAL_ENV_ALLOWLIST = ["SOLHEIM_API_KEY"] as const

export function assertCredentialEnvAllowed(name: string): void {
	if (!(CREDENTIAL_ENV_ALLOWLIST as readonly string[]).includes(name)) {
		throw new Error(`credential environment variable must be one of: ${CREDENTIAL_ENV_ALLOWLIST.join(", ")}`)
	}
}

// Environment allowlist shared by every child this framework spawns. The
// comparison driver may hold unrelated secrets in its own environment; the
// children get only what they need to spawn git, node, and the extension
// host. Credentials never travel through this list; the side adds the one
// named credential variable separately.
const PROCESS_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"DISPLAY",
	"XAUTHORITY",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
] as const

// Environment for the side process: the shared allowlist plus the one named
// credential variable and the side label.
export function buildSideEnvironment(
	env: NodeJS.ProcessEnv,
	credentialEnv: string,
	side: "baseline" | "candidate",
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {}
	for (const name of PROCESS_ENV_ALLOWLIST) {
		const value = env[name]
		if (value !== undefined) child[name] = value
	}
	const credential = env[credentialEnv]
	if (credential !== undefined) child[credentialEnv] = credential
	child["CODING_EVALS_SIDE"] = side
	return child
}

// Environment for the worktree install and build processes. These children
// inherit neither the driver's secrets nor the provider credential. They get
// the shared process locations plus the explicitly approved pnpm variables a
// frozen-lockfile install and a build need to locate their store, cache, and
// registry.
const WORKTREE_ENV_ALLOWLIST = [
	...PROCESS_ENV_ALLOWLIST,
	"PNPM_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"npm_config_registry",
] as const

export function buildWorktreeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {}
	for (const name of WORKTREE_ENV_ALLOWLIST) {
		const value = env[name]
		if (value !== undefined) child[name] = value
	}
	return child
}
