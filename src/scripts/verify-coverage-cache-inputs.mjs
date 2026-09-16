import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { after, test } from "node:test"

const root = resolve(import.meta.dirname, "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []
const lanes = ["api", "core", "services", "misc", "tree-sitter"]
const probeRoot = mkdtempSync(resolve(tmpdir(), "zoo-code-coverage-cache-inputs-"))

const git = (gitArgs) => {
	const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" })
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `git exited with status ${result.status ?? "unknown"}`)
	}
}

git(["worktree", "add", "--detach", probeRoot, "HEAD"])
after(() => {
	try {
		git(["worktree", "remove", "--force", probeRoot])
	} finally {
		rmSync(probeRoot, { recursive: true, force: true })
	}
})

const coverageTasks = () => {
	const result = spawnSync(
		command,
		[
			...args,
			"turbo",
			"--cwd",
			probeRoot,
			"run",
			...lanes.map((lane) => `test:coverage:${lane}`),
			"--filter=zoo-code",
			"--dry=json",
			"--no-daemon",
		],
		{ cwd: root, encoding: "utf8" },
	)
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
	}
	const graph = JSON.parse(result.stdout)
	return lanes.map((lane) => {
		const task = graph.tasks.find(({ taskId }) => taskId === `zoo-code#test:coverage:${lane}`)
		if (!task) throw new Error(`Coverage lane missing from Turbo graph: ${lane}`)
		return task
	})
}

const hashes = () => Object.fromEntries(coverageTasks().map((task) => [task.task.split(":").at(-1), task.hash]))

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

const changedLanes = (before, after) => lanes.filter((lane) => before[lane] !== after[lane])

test("coverage lane hashes ignore post-coverage verifier implementation", () => {
	const before = hashes()
	const self = "scripts/verify-coverage-cache-inputs.mjs"
	for (const task of coverageTasks()) {
		if (Object.hasOwn(task.inputs, self)) throw new Error(`${self} is an input of ${task.taskId}`)
	}
	for (const path of [
		"src/scripts/coverage-contract.mjs",
		"src/scripts/verify-coverage-contract.mjs",
		"src/scripts/verify-lcov.mjs",
	]) {
		const after = withChangedFiles([path], hashes)
		const changed = changedLanes(before, after)
		if (changed.length !== 0) throw new Error(`${path} invalidated coverage lanes: ${changed.join(", ")}`)
	}
})

test("shared production changes invalidate every coverage lane that can import them", () => {
	const before = hashes()
	const after = withChangedFiles(["src/utils/path.ts"], hashes)
	const changed = changedLanes(before, after)

	if (changed.join(",") !== lanes.join(","))
		throw new Error(`Shared production change invalidated ${changed.join(", ") || "no lanes"}`)
})

test("lane-owned tests invalidate only their general coverage lane", () => {
	const before = hashes()
	const after = withChangedFiles(["src/api/providers/__tests__/anthropic.spec.ts"], hashes)
	const changed = changedLanes(before, after)

	if (changed.join(",") !== "api") throw new Error(`API test change invalidated ${changed.join(", ") || "no lanes"}`)
})
