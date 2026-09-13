import { spawnSync } from "node:child_process"
import process from "node:process"

const pnpm = process.platform === "win32" ? process.env.npm_execpath : "pnpm"
if (!pnpm) throw new Error("pnpm executable path is unavailable")
const command = process.platform === "win32" ? process.execPath : pnpm
const args = process.platform === "win32" ? [pnpm] : []
const result = spawnSync(
	command,
	[
		...args,
		"turbo",
		"run",
		"test:coverage:general",
		"test:coverage:tree-sitter",
		"test:dist",
		"--filter=zoo-code",
		"--dry=json",
	],
	{ encoding: "utf8" },
)
if (result.status !== 0) {
	const details = [result.error?.message, result.signal, result.stderr, result.stdout].filter(Boolean).join("\n")
	throw new Error(details || `pnpm exited with status ${result.status ?? "unknown"}`)
}

const graph = JSON.parse(result.stdout)
const generalTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:coverage:general")
const treeSitterTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:coverage:tree-sitter")
const distTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:dist")
if (!generalTask || !treeSitterTask) throw new Error("Extension coverage lane missing")
if (graph.tasks.some(({ taskId }) => taskId === "zoo-code#prepare:tree-sitter-wasms"))
	throw new Error("Removed WASM preparation task remains in the graph")
for (const task of [generalTask, treeSitterTask]) {
	if (task.dependencies.includes("zoo-code#bundle")) throw new Error("Coverage lanes must not depend on bundle")
	if (!task.dependencies.includes("@roo-code/types#build"))
		throw new Error("Coverage lanes must depend on the types build")
	if (!Object.hasOwn(task.inputs, "package.json")) throw new Error("Coverage lanes must hash package.json")
	if (!task.hashOfExternalDependencies) throw new Error("Coverage lanes must hash external dependencies")
}
if (!Object.hasOwn(generalTask.inputs, "services/tree-sitter/index.ts"))
	throw new Error("General coverage must hash tree-sitter sources used by external consumers")
if (Object.hasOwn(generalTask.inputs, "services/tree-sitter/__tests__/wasm.spec.ts"))
	throw new Error("General coverage must not hash tree-sitter-owned tests")
if (!Object.hasOwn(treeSitterTask.inputs, "services/tree-sitter/index.ts"))
	throw new Error("Tree-sitter coverage must hash tree-sitter sources")
if (Object.hasOwn(treeSitterTask.inputs, "core/task/Task.ts"))
	throw new Error("Tree-sitter coverage must not hash unrelated core sources")
if (!distTask?.dependencies.includes("zoo-code#bundle")) throw new Error("Dist smoke test must depend on bundle")
