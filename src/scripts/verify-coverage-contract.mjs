import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { relative, resolve } from "node:path"
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
		"test:coverage:api",
		"test:coverage:core",
		"test:coverage:services",
		"test:coverage:misc",
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
const ownershipLanes = ["api", "core", "services", "misc"]
const ownershipTasks = ownershipLanes.map((lane) =>
	graph.tasks.find(({ taskId }) => taskId === `zoo-code#test:coverage:${lane}`),
)
const treeSitterTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:coverage:tree-sitter")
const distTask = graph.tasks.find(({ taskId }) => taskId === "zoo-code#test:dist")
if (ownershipTasks.some((task) => !task) || !treeSitterTask) throw new Error("Extension coverage lane missing")
if (graph.tasks.some(({ taskId }) => taskId === "zoo-code#prepare:tree-sitter-wasms"))
	throw new Error("Removed WASM preparation task remains in the graph")
for (const task of [...ownershipTasks, treeSitterTask]) {
	if (task.dependencies.includes("zoo-code#bundle")) throw new Error("Coverage lanes must not depend on bundle")
	if (!Object.hasOwn(task.inputs, "package.json")) throw new Error("Coverage lanes must hash package.json")
	if (!task.hashOfExternalDependencies) throw new Error("Coverage lanes must hash external dependencies")
}
for (const task of ownershipTasks) {
	for (const dependency of [
		"@roo-code/cloud",
		"@roo-code/core",
		"@roo-code/ipc",
		"@roo-code/telemetry",
		"@roo-code/types",
	])
		if (!task.dependencies.includes(`${dependency}#build`))
			throw new Error(`Ownership coverage lanes must depend on ${dependency}#build`)
}
if (!treeSitterTask.dependencies.includes("@roo-code/types#build"))
	throw new Error("Tree-sitter coverage must depend on @roo-code/types#build")
for (const task of ownershipTasks) {
	if (!Object.hasOwn(task.inputs, "services/tree-sitter/index.ts"))
		throw new Error("Ownership coverage lanes must hash shared tree-sitter production sources")
}
const representativeTests = {
	api: "api/providers/__tests__/anthropic.spec.ts",
	core: "core/task/__tests__/Task.spec.ts",
	services: "services/mcp/__tests__/McpHub.spec.ts",
	misc: "utils/__tests__/path.spec.ts",
}
for (const [index, task] of ownershipTasks.entries()) {
	for (const [lane, testPath] of Object.entries(representativeTests)) {
		const ownsInput = Object.hasOwn(task.inputs, testPath)
		if (ownsInput !== (lane === ownershipLanes[index]))
			throw new Error(`${ownershipLanes[index]} coverage has incorrect ownership for ${testPath}`)
	}
	if (Object.hasOwn(task.inputs, "services/tree-sitter/__tests__/wasm.spec.ts"))
		throw new Error("Ownership coverage lanes must not hash tree-sitter-owned tests")
}
if (!Object.hasOwn(treeSitterTask.inputs, "services/tree-sitter/index.ts"))
	throw new Error("Tree-sitter coverage must hash tree-sitter sources")
if (Object.hasOwn(treeSitterTask.inputs, "core/task/Task.ts"))
	throw new Error("Tree-sitter coverage must not hash unrelated core sources")
if (!distTask?.dependencies.includes("zoo-code#bundle")) throw new Error("Dist smoke test must depend on bundle")

const root = resolve(import.meta.dirname, "..")
const testPattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const ignoredDirectories = new Set(["coverage", "dist", "node_modules"])
const testFiles = []
const collectTests = (directory) => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectTests(resolve(directory, entry.name))
		} else if (testPattern.test(entry.name)) {
			testFiles.push(relative(root, resolve(directory, entry.name)).replaceAll("\\", "/"))
		}
	}
}
collectTests(root)

const laneForTest = (file) => {
	if (file === "__tests__/dist_assets.spec.ts") return "dist"
	if (file.startsWith("services/tree-sitter/")) return "tree-sitter"
	for (const lane of ["api", "core", "services"]) if (file.startsWith(`${lane}/`)) return lane
	if (
		["__tests__", "activate", "extension", "i18n", "integrations", "scripts", "shared", "test-utils", "utils"].some(
			(directory) => file.startsWith(`${directory}/`),
		)
	)
		return "misc"
	throw new Error(`Unit test is not assigned to a coverage lane: ${file}`)
}
const laneCounts = Object.groupBy(testFiles, laneForTest)
if (Object.values(laneCounts).flat().length !== testFiles.length)
	throw new Error("Coverage lanes do not form an exact test partition")

const collectionDirectory = mkdtempSync(resolve(tmpdir(), "zoo-code-coverage-contract-"))
try {
	const collect = (config) => {
		const output = resolve(collectionDirectory, `${config}.json`)
		const collection = spawnSync(
			command,
			[...args, "exec", "vitest", "list", "--config", `vitest.${config}.config.ts`, `--json=${output}`],
			{ encoding: "utf8" },
		)
		if (collection.status !== 0) throw new Error(collection.stderr || `Vitest collection failed for ${config}`)
		return new Set(JSON.parse(readFileSync(output, "utf8")).map(({ file, name }) => `${file}\0${name}`))
	}
	const unitTests = collect("unit")
	const laneTests = new Set()
	for (const lane of [...ownershipLanes, "tree-sitter"]) {
		for (const test of collect(lane)) {
			if (laneTests.has(test)) throw new Error(`Test belongs to multiple coverage lanes: ${test}`)
			laneTests.add(test)
		}
	}
	if (unitTests.size !== laneTests.size || [...unitTests].some((test) => !laneTests.has(test)))
		throw new Error("Coverage lane test collection differs from monolithic unit coverage")
} finally {
	rmSync(collectionDirectory, { recursive: true, force: true })
}

const coverageSources = new Map()
for (const lane of [...ownershipLanes, "tree-sitter"]) {
	let source
	for (const line of readFileSync(resolve(root, "coverage", lane, "lcov.info"), "utf8").split(/\r?\n/)) {
		if (line.startsWith("SF:")) source = line.slice(3)
		if (line.startsWith("LF:")) coverageSources.set(source, Number(line.slice(3)))
	}
}
const instrumentedLines = [...coverageSources.values()].reduce((sum, lines) => sum + lines, 0)
if (coverageSources.size !== 469 || instrumentedLines !== 30_229)
	throw new Error(
		`Coverage source population changed: ${coverageSources.size} records and ${instrumentedLines} lines; verify equivalence and update the baseline deliberately`,
	)
