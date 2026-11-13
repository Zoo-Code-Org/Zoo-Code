import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import process from "node:process"

const root = resolve(import.meta.dirname, "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []

const gitError = (result) => {
	const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
	return new Error(details || `git exited with status ${result.status ?? "unknown"}`)
}

const git = (gitArgs) => {
	const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" })
	if (result.status !== 0) throw gitError(result)
}

const trackedTreeStatus = () =>
	spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: root, encoding: "utf8" })

// Probe the working tree so local runs validate uncommitted task edits. CI
// runs on a clean tree, where stash create exits without a SHA and this
// falls back to HEAD. git stash create can exit 1 with empty output when
// stale index metadata refreshes to a clean tracked tree. Confirm a clean
// tracked tree before trusting that exit.
export const stashCommit = (result, trackedTree = trackedTreeStatus) => {
	if (result.status === 0) return result.stdout.trim() || "HEAD"
	const quietExit = result.status === 1 && !result.error && !result.signal && !result.stdout && !result.stderr
	if (!quietExit) throw gitError(result)
	const status = trackedTree()
	if (status.status !== 0) throw gitError(status)
	if (status.stdout.trim() !== "") {
		const changes = status.stdout.trim()
		throw new Error(`git stash create found no changes, but git status reports tracked changes:\n${changes}`)
	}
	return "HEAD"
}

const worktreeCommit = () => stashCommit(spawnSync("git", ["stash", "create"], { cwd: root, encoding: "utf8" }))

export const turboGraph = (probeRoot, taskArgs, env = process.env) => {
	const result = spawnSync(
		command,
		[...args, "turbo", "--cwd", probeRoot, "run", ...taskArgs, "--dry=json", "--no-daemon"],
		{ cwd: root, encoding: "utf8", env },
	)
	if (result.status !== 0)
		throw new Error(
			[result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n") ||
				`pnpm exited with status ${result.status ?? "unknown"}`,
		)
	const lines = result.stdout.split("\n")
	let jsonStart = -1
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("{")) jsonStart = i
	}
	if (jsonStart < 0) {
		const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || "turbo dry run produced no JSON graph")
	}
	return JSON.parse(lines.slice(jsonStart).join("\n"))
}

export const createProbe = () => {
	const probeRoot = mkdtempSync(resolve(tmpdir(), "zoo-build-cache-probe-"))
	let worktreeAdded = false
	let cleaned = false
	const cleanup = () => {
		if (cleaned) return
		cleaned = true
		try {
			if (worktreeAdded) git(["worktree", "remove", "--force", probeRoot])
		} finally {
			rmSync(probeRoot, { recursive: true, force: true })
		}
	}
	const terminate = (signal) => {
		cleanup()
		process.kill(process.pid, signal)
	}
	const onSigint = () => terminate("SIGINT")
	const onSigterm = () => terminate("SIGTERM")
	process.once("SIGINT", onSigint)
	process.once("SIGTERM", onSigterm)

	try {
		git(["worktree", "add", "--detach", probeRoot, worktreeCommit()])
		worktreeAdded = true

		return {
			probeRoot,
			cleanup: () => {
				process.off("SIGINT", onSigint)
				process.off("SIGTERM", onSigterm)
				cleanup()
			},
		}
	} catch (error) {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		cleanup()
		throw error
	}
}
