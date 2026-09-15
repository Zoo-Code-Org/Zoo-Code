import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { test } from "node:test"

const root = resolve(import.meta.dirname, "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []
const lanes = ["api", "core", "services", "misc", "tree-sitter"]

const hashes = () => {
	const result = spawnSync(
		command,
		[...args, "turbo", "run", ...lanes.map((lane) => `test:coverage:${lane}`), "--filter=zoo-code", "--dry=json"],
		{ cwd: root, encoding: "utf8" },
	)
	if (result.status !== 0) {
		const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
		throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
	}
	const graph = JSON.parse(result.stdout)
	return Object.fromEntries(
		lanes.map((lane) => {
			const task = graph.tasks.find(({ taskId }) => taskId === `zoo-code#test:coverage:${lane}`)
			if (!task) throw new Error(`Coverage lane missing from Turbo graph: ${lane}`)
			return [lane, task.hash]
		}),
	)
}

const withChangedFiles = (paths, run) => {
	const originals = paths.map((path) => [path, readFileSync(resolve(root, path), "utf8")])
	try {
		for (const [path, contents] of originals)
			writeFileSync(resolve(root, path), `${contents}\n// cache-input-test\n`)
		return run()
	} finally {
		for (const [path, contents] of originals) writeFileSync(resolve(root, path), contents)
	}
}

const changedLanes = (before, after) => lanes.filter((lane) => before[lane] !== after[lane])

test("coverage lane hashes ignore post-coverage verifier implementation", () => {
	const before = hashes()
	for (const path of [
		"src/scripts/coverage-contract.mjs",
		"src/scripts/verify-coverage-cache-inputs.mjs",
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
