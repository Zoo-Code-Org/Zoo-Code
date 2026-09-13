import { spawnSync } from "node:child_process"
import process from "node:process"

const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []
const result = spawnSync(
	command,
	[...args, "turbo", "run", "test:coverage:unit", "test:dist", "--filter=zoo-code", "--dry=json"],
	{ encoding: "utf8" },
)
if (result.status !== 0) {
	const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
	throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
}

const graph = JSON.parse(result.stdout)
const coverageTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:coverage:unit")
const distTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:dist")
if (!coverageTask) throw new Error("Unit coverage task missing")
if (graph.tasks.some(({ taskId }) => taskId === "zoo-code#prepare:tree-sitter-wasms"))
	throw new Error("Removed WASM preparation task remains in the graph")
if (coverageTask.dependencies.includes("zoo-code#bundle")) throw new Error("Unit coverage must not depend on bundle")
if (!Object.hasOwn(coverageTask.inputs, "package.json")) throw new Error("Unit coverage must hash package.json")
if (!coverageTask.hashOfExternalDependencies) throw new Error("Unit coverage must hash external dependencies")
if (!distTask?.dependencies.includes("zoo-code#bundle")) throw new Error("Dist smoke test must depend on bundle")
