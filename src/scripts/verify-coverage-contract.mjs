import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { assertMatchingFiles } from "./verify-wasm-files.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const pnpmPrefix = process.platform === "win32" ? [pnpm] : []
const run = (args, options = {}) => {
	const { includeStderr = true, ...spawnOptions } = options
	const command = process.platform === "win32" ? process.execPath : pnpm
	const result = spawnSync(command, [...pnpmPrefix, ...args], { cwd: root, encoding: "utf8", ...spawnOptions })
	if (result.status !== 0) {
		const details = [
			result.error?.message,
			result.signal ? `terminated by ${result.signal}` : undefined,
			result.stderr,
			result.stdout,
		]
			.filter(Boolean)
			.join("\n")
		throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
	}
	return `${result.stdout || ""}${includeStderr ? result.stderr || "" : ""}`
}

const graph = JSON.parse(
	run(["turbo", "run", "test:coverage:unit", "--filter=zoo-code", "--dry=json"], { includeStderr: false }),
)
const coverageTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:coverage:unit")
const preparationTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#prepare:tree-sitter-wasms")
if (!coverageTask?.dependencies.includes("zoo-code#prepare:tree-sitter-wasms"))
	throw new Error("WASM prerequisite missing")
if (coverageTask.dependencies.includes("zoo-code#bundle")) throw new Error("Unit coverage must not depend on bundle")
if (JSON.stringify(preparationTask?.outputs) !== JSON.stringify(["dist/tree-sitter-*.wasm"]))
	throw new Error("WASM prerequisite outputs changed")

const dist = path.join(root, "src", "dist")
const cacheDir = path.join(root, ".turbo", "coverage-contract")
fs.mkdirSync(dist, { recursive: true })
fs.rmSync(cacheDir, { recursive: true, force: true })
for (const filename of fs.readdirSync(dist)) {
	if (/^tree-sitter-.*\.wasm(?:\.\d+\.tmp)?$/.test(filename)) fs.rmSync(path.join(dist, filename), { force: true })
}

try {
	run(["turbo", "run", "prepare:tree-sitter-wasms", "--filter=zoo-code", "--cache-dir=.turbo/coverage-contract"])
	run(["--dir", "src", "exec", "vitest", "run", "services/tree-sitter/__tests__"], { stdio: "inherit" })

	const source = fs
		.readdirSync(path.join(root, "src", "node_modules", "tree-sitter-wasms", "out"))
		.filter((filename) => /^tree-sitter-.*\.wasm$/.test(filename))
		.sort()
	const published = fs
		.readdirSync(dist)
		.filter((filename) => /^tree-sitter-.*\.wasm$/.test(filename))
		.sort()
	if (source.length === 0) throw new Error("Dependency contains no tree-sitter WASMs")
	if (JSON.stringify(source) !== JSON.stringify(published))
		throw new Error("Published WASM set does not match dependency")
	assertMatchingFiles(
		path.join(root, "src", "node_modules", "tree-sitter-wasms", "out"),
		dist,
		source,
		"Published WASM content does not match dependency",
	)
	if (fs.readdirSync(dist).some((filename) => filename.endsWith(".tmp")))
		throw new Error("Temporary WASM files remain")

	for (const filename of published) fs.rmSync(path.join(dist, filename), { force: true })
	const warmGraph = JSON.parse(
		run(
			[
				"turbo",
				"run",
				"prepare:tree-sitter-wasms",
				"--filter=zoo-code",
				"--cache-dir=.turbo/coverage-contract",
				"--dry=json",
			],
			{ includeStderr: false },
		),
	)
	const warmTask = warmGraph.tasks.find(({ taskId }) => taskId === "zoo-code#prepare:tree-sitter-wasms")
	if (warmTask?.cache.status !== "HIT") throw new Error("WASM prerequisite is not available in the isolated cache")
	run(["turbo", "run", "prepare:tree-sitter-wasms", "--filter=zoo-code", "--cache-dir=.turbo/coverage-contract"])
	const restored = fs
		.readdirSync(dist)
		.filter((filename) => /^tree-sitter-.*\.wasm$/.test(filename))
		.sort()
	if (JSON.stringify(source) !== JSON.stringify(restored)) throw new Error("WASM cache did not restore exact outputs")
	assertMatchingFiles(
		path.join(root, "src", "node_modules", "tree-sitter-wasms", "out"),
		dist,
		source,
		"WASM cache restored corrupted output",
	)
} finally {
	fs.rmSync(cacheDir, { recursive: true, force: true })
}
