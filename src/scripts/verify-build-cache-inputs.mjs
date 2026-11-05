import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { test } from "node:test"

// Contract for the build/static Turbo tasks (issue #2290): changes to files
// and environment variables that feeds build outputs must invalidate the
// corresponding tasks, identical inputs must stay reusable, and unrelated
// environment must not disturb hashes.

const root = resolve(import.meta.dirname, "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []

const trackedTasks = [
	"@roo-code/types#build",
	"@roo-code/vscode-webview#build",
	"@roo-code/vscode-webview#check-types",
	"zoo-code#bundle",
	"zoo-code#vsix",
	"zoo-code#check-types",
]

const turboArgs = [
	"turbo",
	"--cwd",
	"__PROBE_ROOT__",
	"run",
	"build",
	"check-types",
	"bundle",
	"vsix",
	"--filter=zoo-code",
	"--filter=@roo-code/vscode-webview",
	"--filter=@roo-code/types",
	"--dry=json",
]

let probeRoot

const gitError = (result) => {
	const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
	return new Error(details || `git exited with status ${result.status ?? "unknown"}`)
}

const git = (gitArgs) => {
	const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" })
	if (result.status !== 0) throw gitError(result)
}

const worktreeCommit = () => {
	const result = spawnSync("git", ["stash", "create"], { cwd: root, encoding: "utf8" })
	if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
	return "HEAD"
}

const hashes = (env = process.env) => {
	const resolvedArgs = turboArgs.map((arg) => (arg === "__PROBE_ROOT__" ? probeRoot : arg))
	const result = spawnSync(command, [...args, ...resolvedArgs], { cwd: root, encoding: "utf8", env })
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
	}
	const lines = result.stdout.split("\n")
	let jsonStart = -1
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("{")) jsonStart = i
	}
	if (jsonStart < 0) {
		const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || "turbo dry run produced no JSON graph")
	}
	const graph = JSON.parse(lines.slice(jsonStart).join("\n"))
	return Object.fromEntries(
		trackedTasks.map((taskName) => {
			const task = graph.tasks.find(({ taskId }) => taskId === taskName)
			if (!task) throw new Error(`Tracked task missing from Turbo graph: ${taskName}`)
			return [taskName, { hash: task.hash, inputs: Object.keys(task.inputs ?? {}) }]
		}),
	)
}

const hashesOnly = (env = process.env) => Object.fromEntries(Object.entries(hashes(env)).map(([id, t]) => [id, t.hash]))

const changedTasks = (before, after) =>
	Object.keys(before)
		.filter((id) => before[id] !== after[id])
		.sort()

const withChangedFile = (path, mutate, run) => {
	const target = resolve(probeRoot, path)
	const original = readFileSync(target)
	try {
		mutate(target)
		return run()
	} finally {
		writeFileSync(target, original)
	}
}

const appendComment = (target) => appendFileSync(target, "\n// cache-input-test\n")

const expectChanged = (changed, expected, label) => {
	assert.deepEqual(
		changed,
		expected.sort(),
		`${label}: expected invalidation [${expected.sort().join(", ")}], got [${changed.join(", ") || "nothing"}]`,
	)
}

test("build cache input contract", async (context) => {
	probeRoot = mkdtempSync(resolve(tmpdir(), "zoo-build-cache-probe-"))
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

		await context.test("identical inputs keep hashes stable so reuse is permitted", () => {
			const first = hashesOnly()
			const second = hashesOnly()
			assert.deepEqual(first, second)
		})

		await context.test("webview build and typecheck hash the shared extension source", () => {
			const before = hashesOnly()
			const after = withChangedFile("src/shared/package.ts", appendComment, hashesOnly)
			expectChanged(
				changedTasks(before, after),
				[
					"@roo-code/vscode-webview#build",
					"@roo-code/vscode-webview#check-types",
					"zoo-code#bundle",
					"zoo-code#check-types",
					"zoo-code#vsix",
				],
				"shared source edit",
			)
		})

		await context.test("webview build hashes its entry HTML", () => {
			const before = hashesOnly()
			const after = withChangedFile("webview-ui/index.html", appendComment, hashesOnly)
			expectChanged(
				changedTasks(before, after),
				[
					"@roo-code/vscode-webview#build",
					"@roo-code/vscode-webview#check-types",
					"zoo-code#bundle",
					"zoo-code#vsix",
				],
				"index.html edit",
			)
		})

		await context.test("webview build hashes the extension package version", () => {
			const before = hashesOnly()
			const after = withChangedFile(
				"src/package.json",
				(target) => {
					const pkg = JSON.parse(readFileSync(target, "utf8"))
					pkg.version = "0.0.0-cache-input-test"
					writeFileSync(target, JSON.stringify(pkg, null, "\t"))
				},
				hashesOnly,
			)
			expectChanged(
				changedTasks(before, after),
				["@roo-code/vscode-webview#build", "zoo-code#bundle", "zoo-code#check-types", "zoo-code#vsix"],
				"package version bump",
			)
		})

		await context.test("extension bundle hashes repo-root packaging files", () => {
			for (const path of ["README.md", "CHANGELOG.md", "LICENSE"]) {
				const before = hashesOnly()
				const after = withChangedFile(path, appendComment, hashesOnly)
				expectChanged(changedTasks(before, after), ["zoo-code#bundle", "zoo-code#vsix"], `${path} edit`)
			}
		})

		await context.test("extension bundle hashes webview audio assets", () => {
			const before = hashesOnly()
			const after = withChangedFile(
				"webview-ui/audio/celebration.wav",
				(target) => appendFileSync(target, "\0"),
				hashesOnly,
			)
			expectChanged(
				changedTasks(before, after),
				[
					"@roo-code/vscode-webview#build",
					"@roo-code/vscode-webview#check-types",
					"zoo-code#bundle",
					"zoo-code#vsix",
				],
				"audio asset edit",
			)
		})

		await context.test("release and debug env inputs invalidate the builds they feed", () => {
			const before = hashesOnly()
			const channel = hashesOnly({ ...process.env, PKG_RELEASE_CHANNEL: "prerelease" })
			expectChanged(
				changedTasks(before, channel),
				["@roo-code/vscode-webview#build", "zoo-code#bundle", "zoo-code#vsix"],
				"PKG_RELEASE_CHANNEL change",
			)
			const textmate = hashesOnly({ ...process.env, VSCODE_TEXTMATE_DEBUG: "1" })
			expectChanged(
				changedTasks(before, textmate),
				["@roo-code/vscode-webview#build", "zoo-code#bundle", "zoo-code#vsix"],
				"VSCODE_TEXTMATE_DEBUG change",
			)
		})

		await context.test("unrelated env stays out of every task hash", () => {
			const before = hashesOnly()
			const after = hashesOnly({ ...process.env, ZOO_UNRELATED_CACHE_PROBE: "1" })
			assert.deepEqual(changedTasks(before, after), [])
		})

		await context.test("types source changes invalidate every dependent typecheck", () => {
			const before = hashesOnly()
			const after = withChangedFile("packages/types/src/index.ts", appendComment, hashesOnly)
			const changed = changedTasks(before, after)
			for (const task of [
				"@roo-code/types#build",
				"@roo-code/vscode-webview#check-types",
				"zoo-code#check-types",
			]) {
				if (!changed.includes(task)) throw new Error(`types source edit did not invalidate ${task}`)
			}
		})

		await context.test("hashed input sets contain the corrected entries", () => {
			const tasks = hashes()
			const webviewBuildInputs = tasks["@roo-code/vscode-webview#build"].inputs
			for (const entry of ["index.html", "vite.config.ts", "src/shared/package.ts", "src/package.json"]) {
				if (!webviewBuildInputs.some((input) => input === entry || input.endsWith(`/${entry}`)))
					throw new Error(`webview build does not hash ${entry}`)
			}
			const bundleInputs = tasks["zoo-code#bundle"].inputs
			for (const entry of [
				"README.md",
				"CHANGELOG.md",
				"LICENSE",
				"webview-ui/audio/celebration.wav",
				"esbuild.mjs",
			]) {
				if (!bundleInputs.some((input) => input === entry || input.endsWith(`/${entry}`)))
					throw new Error(`extension bundle does not hash ${entry}`)
			}
		})
	} finally {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		cleanup()
	}
})
