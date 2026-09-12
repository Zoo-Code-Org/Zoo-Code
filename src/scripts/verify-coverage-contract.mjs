import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const run = (args, options = {}) => {
	const { includeStderr = true, ...spawnOptions } = options
	const result = spawnSync(pnpm, args, { cwd: root, encoding: "utf8", ...spawnOptions })
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${pnpm} failed`)
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
fs.mkdirSync(dist, { recursive: true })
for (const filename of fs.readdirSync(dist)) {
	if (/^tree-sitter-.*\.wasm(?:\.\d+\.tmp)?$/.test(filename)) fs.rmSync(path.join(dist, filename), { force: true })
}

run(["turbo", "run", "prepare:tree-sitter-wasms", "--filter=zoo-code", "--force"])
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
if (fs.readdirSync(dist).some((filename) => filename.endsWith(".tmp"))) throw new Error("Temporary WASM files remain")

const warm = run(["turbo", "run", "prepare:tree-sitter-wasms", "--filter=zoo-code"])
if (!warm.includes("zoo-code:prepare:tree-sitter-wasms: cache hit"))
	throw new Error("WASM prerequisite did not restore from cache")
