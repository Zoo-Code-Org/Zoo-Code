import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { test } from "node:test"

const root = resolve(import.meta.dirname, "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []
const lanes = ["api", "core", "services", "misc", "tree-sitter"]
const taskNames = lanes.flatMap((lane) => [`test:${lane}`, `test:coverage:${lane}`])
// Data files owned by one lane's test area. A change here must invalidate only
// the owner, because no test or source file imports across lane test areas.
const laneOwnedDataFiles = {
	api: "src/api/providers/fetchers/__tests__/fixtures/ollama-model-details.json",
	core: "src/core/prompts/__tests__/__snapshots__/system-prompt/consistent-system-prompt.snap",
	misc: "src/__tests__/helpers/provider-stub.ts",
	"tree-sitter": "src/services/tree-sitter/__tests__/fixtures/sample-json.ts",
}
// Directories where a lane's own test run may create transient files. Litter
// here must not change any other lane's hash.
const laneProbeDirs = {
	api: "src/api/__tests__",
	core: "src/core/task/__tests__",
	services: "src/services/mcp/__tests__",
	misc: "src/integrations/misc/__tests__",
	"tree-sitter": "src/services/tree-sitter/__tests__",
}
const laneOwnedSpecFiles = {
	api: "src/api/providers/__tests__/anthropic.spec.ts",
	core: "src/core/prompts/__tests__/system-prompt.spec.ts",
	services: "src/services/mcp/__tests__/McpHub.spec.ts",
	misc: "src/utils/__tests__/safeWriteJson.test.ts",
	"tree-sitter": "src/services/tree-sitter/__tests__/wasm.spec.ts",
}
// Specs outside __tests__ directories. The lane vitest include globs fix the owner.
const laneOwnedTopLevelSpecFiles = {
	core: "src/core/message-manager/index.spec.ts",
	misc: "src/scripts/verify-lcov.spec.mjs",
}
let probeRoot

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
const stashCommit = (result, trackedTree = trackedTreeStatus) => {
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

const turboTasks = () => {
	const result = spawnSync(
		command,
		[...args, "turbo", "--cwd", probeRoot, "run", ...taskNames, "--filter=zoo-code", "--dry=json", "--no-daemon"],
		{ cwd: root, encoding: "utf8" },
	)
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
	}
	// pnpm may print warnings before the Turbo graph. The graph is the last
	// top-level JSON object in the output.
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
	return taskNames.map((taskName) => {
		const task = graph.tasks.find(({ taskId }) => taskId === `zoo-code#${taskName}`)
		if (!task) throw new Error(`Extension lane missing from Turbo graph: ${taskName}`)
		return task
	})
}

const hashes = () => Object.fromEntries(turboTasks().map((task) => [task.task, task.hash]))

const withChangedFiles = (paths, run) => {
	const originals = paths.map((path) => [path, readFileSync(resolve(probeRoot, path), "utf8")])
	try {
		for (const [path, contents] of originals)
			writeFileSync(resolve(probeRoot, path), `${contents}\n// cache-input-test\n`)
		return run()
	} finally {
		for (const [path, contents] of originals) writeFileSync(resolve(probeRoot, path), contents)
	}
}

const withCreatedFile = (path, run) => {
	const target = resolve(probeRoot, path)
	writeFileSync(target, "// cache-input-test\n")
	try {
		return run()
	} finally {
		rmSync(target, { force: true })
	}
}

const changedTasks = (before, after) => taskNames.filter((task) => before[task] !== after[task])

const expectInvalidatesExactly = (task, changed) => {
	const expected = taskNames.filter((name) => name === task || name === `test:coverage:${task.slice(5)}`)
	const actual = changed.sort()
	if (actual.join(",") !== expected.sort().join(","))
		throw new Error(
			`${task} probe invalidated [${actual.join(", ") || "nothing"}] instead of [${expected.join(", ")}]`,
		)
}

test("stash commit probe rejects git failures and keeps the clean-tree fallback", () => {
	const cleanTree = () => ({ status: 0, stdout: "" })
	const dirtyTree = () => ({ status: 0, stdout: " M src/utils/path.ts\n" })
	const brokenTree = () => ({ status: 128, stdout: "", stderr: "fatal: unable to read the index" })
	const failures = [
		{ status: 128, stdout: "", stderr: "fatal: not a git repository" },
		{ status: null, error: new Error("spawn git ENOENT") },
		{ status: 1, signal: "SIGTERM", stdout: "", stderr: "" },
		{ status: 1, stdout: "unexpected output", stderr: "" },
	]

	assert.equal(stashCommit({ status: 0, stdout: "0f53a1c\n" }, cleanTree), "0f53a1c")
	assert.equal(stashCommit({ status: 0, stdout: "\n" }, cleanTree), "HEAD")
	assert.equal(stashCommit({ status: 1, stdout: "", stderr: "" }, cleanTree), "HEAD")
	for (const result of failures) {
		assert.throws(
			() => stashCommit(result, cleanTree),
			(error) => error.message.length > 0,
		)
	}
	assert.throws(
		() => stashCommit({ status: 1, stdout: "", stderr: "" }, dirtyTree),
		/git status reports tracked changes/,
	)
	assert.throws(
		() => stashCommit({ status: 1, stdout: "", stderr: "" }, brokenTree),
		/fatal: unable to read the index/,
	)
})

test("coverage cache input contract", async (context) => {
	probeRoot = mkdtempSync(resolve(tmpdir(), "zoo-code-coverage-cache-inputs-"))
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

		await context.test("plain and coverage lanes share identical input sets", () => {
			const tasks = turboTasks()
			const inputsByTask = Object.fromEntries(tasks.map((task) => [task.task, task.inputs]))
			for (const lane of lanes) {
				const plain = Object.keys(inputsByTask[`test:${lane}`]).sort()
				const coverage = Object.keys(inputsByTask[`test:coverage:${lane}`]).sort()
				const extraInPlain = plain.filter((path) => !coverage.includes(path))
				const extraInCoverage = coverage.filter((path) => !plain.includes(path))
				if (extraInPlain.length > 0 || extraInCoverage.length > 0)
					throw new Error(
						`test:${lane} and test:coverage:${lane} input sets differ. ` +
							`Only in plain: [${extraInPlain.join(", ")}]. Only in coverage: [${extraInCoverage.join(", ")}]`,
					)
			}
		})

		await context.test("lanes hash required inputs and exclude foreign test areas", () => {
			const tasks = turboTasks()
			for (const lane of lanes) {
				for (const taskName of [`test:${lane}`, `test:coverage:${lane}`]) {
					const task = tasks.find(({ task }) => task === taskName)
					const inputs = task.inputs
					const required = [
						"vitest.config.ts",
						`vitest.${lane}.config.ts`,
						"vitest.setup.ts",
						"utils/vitest-verbosity.ts",
						"__mocks__/vscode.js",
						"package.json",
						"tsconfig.json",
					]
					for (const path of required) {
						if (!Object.hasOwn(inputs, path))
							throw new Error(`${taskName} does not hash required input ${path}`)
					}
					const ownedSpecEntries = [
						...Object.entries(laneOwnedSpecFiles),
						...Object.entries(laneOwnedTopLevelSpecFiles),
					]
					for (const [owner, file] of ownedSpecEntries) {
						const packagePath = file.slice("src/".length)
						if (owner === lane) {
							if (!Object.hasOwn(inputs, packagePath))
								throw new Error(`${taskName} does not hash its own spec ${packagePath}`)
						} else if (Object.hasOwn(inputs, packagePath)) {
							throw new Error(`${taskName} hashes foreign spec ${packagePath}`)
						}
					}
				}
			}
		})

		await context.test("lane hashes ignore post-coverage verifier implementation", () => {
			const before = hashes()
			const self = "scripts/verify-coverage-cache-inputs.mjs"
			for (const task of turboTasks()) {
				if (Object.hasOwn(task.inputs, self)) throw new Error(`${self} is an input of ${task.taskId}`)
			}
			for (const path of [
				"src/scripts/coverage-contract.mjs",
				"src/scripts/verify-coverage-contract.mjs",
				"src/scripts/verify-lcov.mjs",
			]) {
				const after = withChangedFiles([path], hashes)
				const changed = changedTasks(before, after)
				if (changed.length !== 0) throw new Error(`${path} invalidated extension lanes: ${changed.join(", ")}`)
			}
		})

		await context.test("shared production changes invalidate every extension lane", () => {
			const before = hashes()
			const after = withChangedFiles(["src/utils/path.ts"], hashes)
			const changed = changedTasks(before, after)

			if (changed.join(",") !== taskNames.join(","))
				throw new Error(`Shared production change invalidated ${changed.join(", ") || "no lanes"}`)
		})

		await context.test("lane-owned data files invalidate only their owner", () => {
			for (const [lane, file] of Object.entries(laneOwnedDataFiles)) {
				const before = hashes()
				const after = withChangedFiles([file], hashes)
				const changed = changedTasks(before, after)
				expectInvalidatesExactly(`test:${lane}`, changed)
			}
		})

		await context.test("transient files in a lane test area invalidate only that lane", () => {
			for (const [lane, dir] of Object.entries(laneProbeDirs)) {
				const probe = `${dir}/cache-boundary-probe.tmp`
				const before = hashes()
				const after = withCreatedFile(probe, hashes)
				const changed = changedTasks(before, after)
				expectInvalidatesExactly(`test:${lane}`, changed)
			}
		})

		await context.test("stat-only tracked changes fall back to HEAD and content changes emit a SHA", () => {
			const trackedTree = () =>
				spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
					cwd: probeRoot,
					encoding: "utf8",
				})
			const stashResult = () => spawnSync("git", ["stash", "create"], { cwd: probeRoot, encoding: "utf8" })
			utimesSync(resolve(probeRoot, "package.json"), new Date(), new Date())
			assert.equal(stashCommit(stashResult(), trackedTree), "HEAD")
			const sha = withChangedFiles(["package.json"], () => stashCommit(stashResult(), trackedTree))
			assert.match(sha, /^[0-9a-f]+$/)
		})
	} finally {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		cleanup()
	}
})
