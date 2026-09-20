import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
let probeRoot

// Probe the working tree so local runs validate uncommitted task edits. CI
// runs on a clean tree, where this falls back to HEAD.
const worktreeCommit = () => {
	const result = spawnSync("git", ["stash", "create"], { cwd: root, encoding: "utf8" })
	if (result.status !== 0) return "HEAD"
	const sha = result.stdout.trim()
	return sha || "HEAD"
}

const git = (gitArgs) => {
	const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" })
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `git exited with status ${result.status ?? "unknown"}`)
	}
}

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
					for (const [owner, file] of Object.entries(laneOwnedSpecFiles)) {
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
	} finally {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
		cleanup()
	}
})
